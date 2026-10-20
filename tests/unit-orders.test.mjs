import test from 'node:test';import assert from 'node:assert/strict';
import{latLngToCell,gridDisk,gridRing,gridDistance}from'h3-js';
import{GameService}from'../src/server/game-service.js';import{MemoryStore}from'../src/server/store.js';
import{advanceArmies,createArmy,reconcileArmy,publicArmy,NPC_RULES}from'../src/server/npc-simulation.js';
import{traversable}from'../src/shared/landscape.js';import{tileForCell,decodeTile}from'../src/shared/geography.js';
const base=latLngToCell(41.3111,69.2797,8),start=1900000000000,near=gridDisk(base,1).filter(c=>c!==base&&traversable(c));
async function fixture(){let now=start;const store=new MemoryStore(),game=new GameService({store,clock:()=>now});await store.atomic({puts:[{key:'account:a',value:{id:'a',createdAt:now}}]});await game.placeBase('a',{cell:base,faction:'pack'});return{store,game,advance:t=>now+=t,now:()=>now,edit:async fn=>{const r=await store.get('player:a');await fn(r.value);await store.atomic({puts:[{key:'player:a',value:r.value}]});}};}
function simulation(mode,goal=near[0]){
 const p={id:'a',faction:'pack',level:1,pixels:1,baseCell:base,shieldUntil:0,borderCells:[base],azimuth:0},army=createArmy(p,start);reconcileArmy(army,p,start);for(const u of army.units)u.order={mode:'hold',cell:base,status:'complete'};const unit=army.units[0];unit.order={mode,cell:goal,status:'queued',issuedAt:start};
 const owners=new Map([[base,'a']]),armies=new Map([['a',army]]),players=[p],claims=[];let at=start,lockedCells=new Set();
 return{p,army,unit,owners,armies,players,claims,lockedCells,advance:async ms=>{at+=ms;await advanceArmies({players,armies,now:at,owner:async c=>owners.get(c)||null,locked:async c=>lockedCells.has(c),canTraverse:()=>true,terrain:()=>({speed:1,cover:0}),neutral:false,claim:async(c,previous,id)=>{owners.set(c,id);p.pixels++;claims.push(c);return true;}});}};
}
test('one squad receives a durable order while other squads retain independent behaviour',async()=>{
 const h=await fixture(),before=(await h.game.state('a')).player.army.units;const id=before[0].id;
 const next=await h.game.commandUnit('a',{unitId:id,mode:'move',cell:near[0],hp:999999,waypoints:['fake'],state:'capture'});
 assert.equal(next.player.army.units[0].order.cell,near[0]);assert.equal(next.player.army.units[0].hp,before[0].hp);assert.ok(next.player.army.units.slice(1).every(u=>!u.order));
 assert.ok(next.player.army.units[0].waypoints.every(c=>c!== 'fake'));
 const restart=new GameService({store:h.store,clock:h.now});assert.deepEqual((await restart.state('a')).player.army.units[0].order,next.player.army.units[0].order);
});
test('a move walks adjacent server waypoints, never captures, and holds at its exact destination',async()=>{
 const s=simulation('move',gridRing(base,3)[0]);let moved=false;for(let i=0;i<60;i++){await s.advance(500);if(s.unit.move){moved=true;assert.equal(gridDistance(s.unit.move.from,s.unit.move.to),1);}}
 assert.ok(moved);assert.equal(s.unit.cell,s.unit.order.cell);assert.equal(s.unit.order.status,'complete');assert.equal(s.unit.activity,'hold');assert.equal(s.claims.length,0);assert.equal(s.unit.move,undefined);
});
test('capture waits for server credit, plays the occupation timer and commits exactly once',async()=>{
 const s=simulation('capture');await s.advance(6000);assert.equal(s.unit.order.status,'waiting-credit');assert.equal(s.claims.length,0);s.army.credit=2;
 await s.advance(500);assert.equal(s.unit.order.status,'capturing');assert.equal(s.claims.length,0);await s.advance(NPC_RULES.captureMs);assert.deepEqual(s.claims,[s.unit.order.cell]);assert.equal(s.unit.order.status,'complete');await s.advance(12000);assert.equal(s.claims.length,1);
});
test('attack engages a real enemy, applies server damage, and retains the commanded destination',async()=>{
 const s=simulation('attack'),enemy={...s.p,id:'b',baseCell:near[0],faction:'swarm'},army=createArmy(enemy,start);reconcileArmy(army,enemy,start);army.units=army.units.slice(0,1);army.units[0].order={mode:'hold',cell:near[0],status:'complete'};s.players.push(enemy);s.armies.set('b',army);s.owners.set(near[0],'b');
 await s.advance(1000);assert.ok(army.units[0].hp<army.units[0].maxHp);assert.equal(s.unit.order.mode,'attack');assert.equal(s.unit.order.cell,near[0]);assert.ok(s.army.events.some(e=>e.kind==='hit'));assert.equal(s.claims.length,0);
});
test('a replacement command finishes the current step without teleporting; auto releases only that squad',async()=>{
 const h=await fixture(),id='a:infantry:0';await h.game.commandUnit('a',{unitId:id,mode:'move',cell:near[0]});h.advance(500);let u=(await h.game.state('a')).player.army.units[0];const step=u.move;assert.ok(step);
 const target=near.find(c=>c!==step.to);u=(await h.game.commandUnit('a',{unitId:id,mode:'move',cell:target})).player.army.units[0];assert.deepEqual(u.move,step);assert.equal(u.cell,step.from);
 await h.game.commandUnit('a',{unitId:'a:infantry:1',mode:'hold'});const released=await h.game.commandUnit('a',{unitId:id,mode:'auto'});assert.equal(released.player.army.units[0].order,undefined);assert.equal(released.player.army.units[1].order.mode,'hold');
});
test('foreign, neutral, dead and unknown squad ids cannot be commanded; malformed and distant targets fail',async()=>{
 const h=await fixture();for(const unitId of['enemy:infantry:0','wild:camp','unknown'])await assert.rejects(()=>h.game.commandUnit('a',{unitId,mode:'hold'}),/своим отрядом/);
 await assert.rejects(()=>h.game.commandUnit('a',{unitId:'a:infantry:0',mode:'teleport'}),/приказ/);
 for(const cell of['garbage',latLngToCell(41.3,69.2,5),gridRing(base,80)[0]])await assert.rejects(()=>h.game.commandUnit('a',{unitId:'a:infantry:0',mode:'move',cell}),/гекс|далеко|радиуса/);
 await h.edit(p=>{p.army.units[0].hp=0;p.army.units[0].state='death';p.army.units[0].stateAt=h.now();});await assert.rejects(()=>h.game.commandUnit('a',{unitId:'a:infantry:0',mode:'hold'}),/погиб/);
});
test('capture validates adjacency, shields, HQ protection, air capability and temporary locks',async()=>{
 const h=await fixture(),id='a:infantry:0';await assert.rejects(()=>h.game.commandUnit('a',{unitId:id,mode:'capture',cell:base}),/штаба|принадлежит/);
 const far=gridRing(base,4).find(c=>traversable(c));await assert.rejects(()=>h.game.commandUnit('a',{unitId:id,mode:'capture',cell:far}),/рядом/);
 await h.edit(p=>{p.energy=100000;p.crystals=1000;});await h.game.useAbility('a',{abilityId:'heavy',requestId:'unit_order_air_cast'});
 await assert.rejects(()=>h.game.commandUnit('a',{unitId:'a:air:0',mode:'capture',cell:near[0]}),/Авиация/);
 await h.game.transaction(async(tx,now)=>{const t=await h.game.tile(tx,tileForCell(near[0]));t.locks[near[0]]=now+100000;await tx.put('tile:'+t.parent,t);});await assert.rejects(()=>h.game.commandUnit('a',{unitId:id,mode:'move',cell:near[0]}),/заблокирован/);
 const enemyBase=gridRing(base,4).find(c=>traversable(c)&&c!==far);await h.store.atomic({puts:[{key:'account:b',value:{id:'b',createdAt:h.now()}}]});await h.game.placeBase('b',{cell:enemyBase,faction:'protocol'});
 await assert.rejects(()=>h.game.commandUnit('a',{unitId:id,mode:'attack',cell:enemyBase}),/щит/);
});
test('a changing lock blocks an active order without leaving its waypoint or falling back to auto',async()=>{
 const s=simulation('move');s.lockedCells.add(s.unit.order.cell);await s.advance(500);assert.equal(s.unit.order.status,'blocked');assert.equal(s.unit.cell,base);assert.equal(s.unit.move,undefined);await s.advance(5000);assert.equal(s.unit.cell,base);
});
test('army-wide orders replace individual orders and death clears an order only on respawn',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:'a:infantry:0',mode:'hold'});await h.game.commandArmy('a',{mode:'defend'});assert.ok((await h.game.state('a')).player.army.units.every(u=>!u.order));
 const s=simulation('hold',base);s.unit.hp=0;s.unit.state='death';s.unit.stateAt=start;await s.advance(500);assert.ok(s.unit.order);await s.advance(NPC_RULES.respawnMs);assert.equal(s.unit.order,undefined);
});
test('manual capture changes actual service ownership and public routes stay bounded',async()=>{
 const h=await fixture();await h.edit(p=>{p.army.credit=2;});await h.game.commandUnit('a',{unitId:'a:infantry:0',mode:'capture',cell:near[0]});h.advance(12000);const state=await h.game.state('a');assert.equal(state.player.army.units[0].order.status,'complete');const t=(await h.store.get('tile:'+tileForCell(near[0]))).value;assert.ok(decodeTile(tileForCell(near[0]),t.owners.a).includes(near[0]));
 const s=simulation('move');s.unit.path=gridRing(base,10);const dto=publicArmy(s.army,start).units[0];assert.equal(dto.waypoints.length,8);assert.equal(dto.routePartial,true);assert.equal(dto.path,undefined);
});
