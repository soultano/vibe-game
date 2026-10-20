import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,gridDisk,gridDistance,gridRing} from 'h3-js';
import {GameService} from '../src/server/game-service.js';
import {MemoryStore} from '../src/server/store.js';
import {createArmy,reconcileArmy,advanceArmies,findRoute,NPC_RULES} from '../src/server/npc-simulation.js';
import {landscape,traversable} from '../src/shared/landscape.js';
import {decodeTile,tileForCell} from '../src/shared/geography.js';
import {createClientHarness} from './helpers/client-harness.mjs';
const base=latLngToCell(41.3111,69.2797,8),neighbors=gridDisk(base,1).filter(c=>c!==base);
async function fixture(){let now=1900000000000;const store=new MemoryStore(),game=new GameService({store,clock:()=>now});await store.atomic({puts:[{key:'account:a',value:{id:'a',name:'Test',createdAt:now}}]});await game.placeBase('a',{cell:base,faction:'pack'});return{store,game,now:()=>now,advance:n=>now+=n,edit:async fn=>{const r=await store.get('player:a');fn(r.value);await store.atomic({checks:[{key:r.key||'player:a',version:r.version}],puts:[{key:'player:a',value:r.value}]});}};}
async function cells(store){const map=new Map();for(const{value:t}of await store.list('tile:'))for(const[o,bits]of Object.entries(t.owners))for(const c of decodeTile(t.parent,bits)){assert.ok(!map.has(c));map.set(c,o);}return map;}

test('production-default NPCs walk before capture, commit real ownership and survive restart',async()=>{
 const h=await fixture();h.advance(2000);const moving=await h.game.state('a');assert.ok(moving.player.army.units.some(u=>u.move));assert.equal(moving.player.pixels,1);
 let hits=0,captures=0;for(let i=0;i<25;i++){h.advance(2000);const r=await h.game.state('a');hits+=r.player.army.events.filter(e=>e.kind==='hit').length;captures+=r.player.army.events.filter(e=>e.kind==='capture').length;}
 const state=await h.game.state('a');assert.ok(captures>0);assert.ok(hits>0,'neutral defenders generate actual HP damage');assert.ok(state.player.pixels>1);assert.equal((await cells(h.store)).size,state.player.pixels);
 const restarted=new GameService({store:h.store,clock:h.now});assert.deepEqual((await restarted.state('a')).player.army,state.player.army);
 const before=await cells(h.store);await Promise.all([h.game.state('a'),restarted.state('a')]);assert.deepEqual(await cells(h.store),before,'same timestamp cannot double-capture or deal extra damage');
});
test('ground routing obeys water obstacles and uses only neighbouring waypoints; air crosses water',async()=>{
 const area=gridDisk(base,20),water=area.find(c=>landscape(c).water&&gridDisk(c,1).some(n=>!landscape(n).water));assert.ok(water,'fixture includes a shoreline');
 const shore=gridDisk(water,1).find(c=>c!==water&&traversable(c));assert.equal(await findRoute(shore,water),null);
 const air=await findRoute(shore,water,{type:'air'});assert.deepEqual(air,[water]);
 const target=gridRing(base,3).find(c=>traversable(c)),route=await findRoute(base,target);assert.ok(route);let prior=base;for(const c of route){assert.equal(gridDistance(prior,c),1);assert.ok(traversable(c));prior=c;}
});
test('damage, death and respawn are server-authoritative; shields prevent PVP damage',async()=>{
 const t=1900000000000,a={id:'a',baseCell:base,faction:'protocol',level:1,pixels:1,azimuth:0,shieldUntil:0,borderCells:[base]},b={...a,id:'b',faction:'pack',baseCell:neighbors[0],borderCells:[neighbors[0]]};
 const armies=new Map([a,b].map(p=>[p.id,createArmy(p,t)]));for(const p of[a,b])reconcileArmy(armies.get(p.id),p,t);
 const run=async now=>advanceArmies({players:[a,b],armies,now,owner:async c=>c===base?'a':c===b.baseCell?'b':null,locked:async()=>false,claim:async()=>false,neutral:false});
 await run(t+1500);assert.ok(armies.get('a').units.some(u=>u.hp<100));assert.ok(armies.get('b').events.some(e=>e.kind==='hit'));
 for(const army of armies.values())for(const u of army.units){u.hp=100;u.nextAttackAt=t+2000;}a.shieldUntil=b.shieldUntil=t+100000;await run(t+4000);assert.ok([...armies.values()].flatMap(a=>a.units).every(u=>u.hp===100));
 const unit=armies.get('a').units[0];unit.hp=0;unit.state='death';unit.stateAt=t+4000;const before=unit.cell;await run(t+4500);assert.equal(unit.hp,0);assert.equal(unit.cell,before);
 await run(t+4000+NPC_RULES.respawnMs);assert.ok(unit.hp>0);assert.equal(unit.cell,base);
});
test('command routes validate ownership, range and mode; defend is persisted and private routing internals are excluded',async()=>{
 const h=await fixture();await assert.rejects(()=>h.game.commandArmy('missing',{mode:'expand'}),/базу/);await assert.rejects(()=>h.game.commandArmy('a',{mode:'teleport'}),/приказ/);
 await assert.rejects(()=>h.game.commandArmy('a',{mode:'attack',cell:latLngToCell(50,60,8)}),/регион|далеко/);
 const result=await h.game.commandArmy('a',{mode:'defend',hp:99999,serverTime:1});assert.equal(result.player.army.order.mode,'defend');assert.equal(result.player.army.units[0].path,undefined);
 h.advance(2000);assert.ok((await h.game.state('a')).player.army.units.every(u=>!u.move));
});
test('special casts spawn their own real classes and expire without changing permanent troop identities',async()=>{
 const h=await fixture();await h.edit(p=>{p.energy=100000;p.crystals=1000;});
 for(const id of['field','heavy','ultimate'])await h.game.useAbility('a',{abilityId:id,requestId:'npc_test_cast_'+id});h.advance(500);const active=await h.game.state('a');
 assert.deepEqual([...new Set(active.player.army.units.filter(u=>!u.neutral).map(u=>u.type))].sort(),['air','armor','infantry','ultimate']);
 const ids=active.player.army.units.filter(u=>u.type==='infantry'&&!u.neutral).map(u=>u.id);h.advance(86400001);const expired=await h.game.state('a');assert.deepEqual(expired.player.army.units.filter(u=>!u.neutral).map(u=>u.type),['infantry','infantry','infantry']);assert.deepEqual(expired.player.army.units.filter(u=>!u.neutral).map(u=>u.id),ids);
});
test('public tile polling publishes moving NPC state even when ownership revisions have not changed',async()=>{
 const h=await fixture(),parent=tileForCell(base);h.advance(2000);const first=await h.game.tiles({parents:[parent]});assert.ok(first.players[0].army.units.some(u=>u.move));const version=first.tiles[0].version;
 h.advance(2000);const next=await h.game.tiles({parents:[parent],versions:{[parent]:version}});assert.equal(next.tiles[0].unchanged,true);assert.ok(next.players[0].army.at>first.players[0].army.at);
});
test('web guest starts a real server session without Telegram, persists its base and can issue orders',async()=>{
 const h=await createClientHarness({env:{TELEGRAM_AUTH_ENABLED:'false'}});assert.equal(h.$('guestLogin').hidden,false);await h.$('guestLogin').onclick();assert.equal(h.client.state().account.provider,'guest');assert.equal(h.$('spawnCard').hidden,false);
 const requests=h.requests.filter(r=>r==='/api/auth/guest');assert.equal(requests.length,1);assert.ok(!h.details.some(d=>d.type==='assign'));
 const id=h.client.state().account.id;await h.app.service.placeBase(id,{cell:base,faction:'protocol'});await h.client.refreshState(true);await h.$('armyDefend').onclick();assert.equal(h.client.state().model.player.army.order.mode,'defend');assert.equal(h.$('armyControls').hidden,false);
 const restored=await createClientHarness({store:h.store,session:h.session});assert.equal(restored.client.state().account.id,id);assert.equal(restored.client.state().model.player.baseCell,base);
});

test('a living NPC occupation transfers enemy territory atomically and respects shields, locks and headquarters',async()=>{
 const h=await fixture(),enemyBase=gridRing(base,5).find(c=>traversable(c)),cell=neighbors.find(c=>traversable(c));
 await h.store.atomic({puts:[{key:'account:b',value:{id:'b',name:'Enemy',createdAt:h.now()}}]});await h.game.placeBase('b',{cell:enemyBase,faction:'vanguard'});
 await h.game.transaction(async(tx,now)=>{const a=await tx.get('player:a'),b=await tx.get('player:b');a.shieldUntil=b.shieldUntil=0;b.pixels=2;b.energyPixels=2;b.borderCells=[enemyBase,cell];
  await h.game.writeOwner(tx,cell,'b',now);a.army.credit=2;const u=a.army.units[0];u.cell=cell;u.state='capture';u.stateAt=now-5000;u.move=null;
  await tx.put('player:a',a);await tx.put('player:b',b);
 });
 h.advance(500);const result=await h.game.state('a'),owners=await cells(h.store);assert.equal(owners.get(cell),'a');assert.equal(result.player.pixels,2);assert.equal((await h.store.get('player:b')).value.pixels,1);assert.equal(owners.get(enemyBase),'b');assert.equal(owners.get(base),'a');assert.equal(result.player.battlesWon,1);
});
test('live NPC stepping is independent of polling cadence within the catch-up window',async()=>{
 const a=await fixture(),b=await fixture();a.advance(40000);await a.game.state('a');for(let i=0;i<20;i++){b.advance(2000);await b.game.state('a');}
 assert.deepEqual(await cells(a.store),await cells(b.store));
 const x=(await a.store.get('player:a')).value,y=(await b.store.get('player:a')).value;assert.deepEqual(x.army,y.army);assert.ok(Math.abs(x.energy-y.energy)<1e-6);
});

test('locked land cannot be captured; wounded NPCs retreat and heal at the headquarters',async()=>{
 const h=await fixture(),cell=neighbors.find(c=>traversable(c));
 await h.game.transaction(async(tx,now)=>{const p=await tx.get('player:a');p.army.credit=2;p.army.order={mode:'attack',cell};const unit=p.army.units[0];unit.cell=cell;unit.state='capture';unit.stateAt=now-5000;
  const tile=await h.game.tile(tx,tileForCell(cell));tile.locks[cell]=now+100000;await tx.put(`tile:${tile.parent}`,tile);await tx.put('player:a',p);
 });
 h.advance(1000);await h.game.state('a');assert.equal((await cells(h.store)).get(cell),undefined);
 await h.edit(p=>{const u=p.army.units[0];u.hp=10;u.move=null;u.cell=cell;u.path=[];});h.advance(500);let state=await h.game.state('a');const wounded=state.player.army.units.find(u=>u.id==='a:infantry:0');assert.equal(wounded.state,'retreat');assert.equal(wounded.move.to,base);
 h.advance(6000);state=await h.game.state('a');const healed=state.player.army.units.find(u=>u.id===wounded.id);assert.equal(healed.cell,base);assert.ok(healed.hp>10);
});
