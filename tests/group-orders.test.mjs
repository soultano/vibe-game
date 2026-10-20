import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,gridDisk,gridRing} from 'h3-js';
import {GameService} from '../src/server/game-service.js';
import {MemoryStore} from '../src/server/store.js';
import {traversable} from '../src/shared/landscape.js';
import {tileForCell,decodeTile} from '../src/shared/geography.js';
const base=latLngToCell(41.3111,69.2797,8),start=1900000000000,near=gridDisk(base,1).filter(c=>c!==base&&traversable(c));
async function fixture(){let now=start;const store=new MemoryStore(),game=new GameService({store,clock:()=>now});await store.atomic({puts:[{key:'account:a',value:{id:'a',createdAt:now}}]});await game.placeBase('a',{cell:base,faction:'pack'});return{store,game,now:()=>now,advance:ms=>now+=ms,edit:async(fn,id='a')=>{const r=await store.get('player:'+id);fn(r.value);await store.atomic({puts:[{key:'player:'+id,value:r.value}]});}};}
const ids=['a:infantry:0','a:infantry:1'];
test('one group request persists independent paths and leaves unselected squads unchanged across restart and retarget',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:'a:infantry:2',mode:'hold'});
 let next=await h.game.commandUnits('a',{unitIds:ids,mode:'move',cell:near[0],hp:99999,path:['invented']});
 for(const id of ids){const u=next.player.army.units.find(u=>u.id===id);assert.equal(u.order.cell,near[0]);assert.equal(u.order.mode,'move');assert.equal(u.hp,100);assert.ok(u.waypoints.every(c=>c!=='invented'));}
 assert.equal(next.player.army.units[2].order.mode,'hold');h.advance(500);next=await h.game.state('a');const moves=next.player.army.units.slice(0,2).map(u=>u.move);assert.ok(moves.every(Boolean));
 next=await h.game.commandUnits('a',{unitIds:ids,mode:'move',cell:near[1]});assert.deepEqual(next.player.army.units.slice(0,2).map(u=>u.move),moves,'a replacement keeps the in-flight steps');
 const restored=await new GameService({store:h.store,clock:h.now}).state('a');assert.ok(restored.player.army.units.slice(0,2).every(u=>u.order.cell===near[1]));
 await h.game.commandUnits('a',{unitIds:ids,mode:'hold'});next=await h.game.commandUnits('a',{unitIds:ids,mode:'auto'});assert.ok(next.player.army.units.slice(0,2).every(u=>!u.order));assert.equal(next.player.army.units[2].order.mode,'hold');
});
test('foreign, missing, duplicate, dead and oversized selections reject atomically without replacing an earlier member order',async()=>{
 const h=await fixture();await h.game.commandUnits('a',{unitIds:ids,mode:'hold'});
 for(const list of[[],[ids[0],ids[0]],[ids[0],'foreign:infantry:0'],[ids[0],'a:infantry:99'],Array.from({length:37},(_,i)=>'a:infantry:'+i),null,'invalid']){
  const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:list,mode:'move',cell:near[0]}));assert.deepEqual(await h.store.get('player:a'),before);
 }
 await h.edit(p=>{p.army.units[1].hp=0;});const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:ids,mode:'move',cell:near[0]}),/погиб/);assert.deepEqual(await h.store.get('player:a'),before);
 await h.edit(p=>{p.army.units[1].hp=100;p.army.units[1].neutral=true;p.army.units[1].id='neutral:guard';});await assert.rejects(()=>h.game.commandUnits('a',{unitIds:[ids[0],'neutral:guard'],mode:'hold'}),/своим/);
});
test('a late range or path validation failure rolls back the whole group command',async()=>{
 const h=await fixture();await h.game.commandUnits('a',{unitIds:ids,mode:'hold'});const far=gridRing(base,75).find(c=>traversable(c));await h.edit(p=>{p.army.units[1].cell=far;p.army.units[1].order.cell=far;});
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:ids,mode:'move',cell:near[0]}),/далеко/);assert.deepEqual(await h.store.get('player:a'),before);
});
test('group capture obeys locks and shields and a mixed group uses air escort without double claiming land',async()=>{
 const h=await fixture();await h.game.useAbility('a',{abilityId:'heavy',requestId:'group_orders_air_cast'});
 const selection=[ids[0],ids[1],'a:air:0'];await h.edit(p=>{p.army.credit=2;p.army.units[2].order={mode:'hold',cell:base,status:'complete'};});
 await assert.rejects(()=>h.game.commandUnits('a',{unitIds:['a:air:0'],mode:'capture',cell:near[0]}),/Авиация/);
 await h.game.transaction(async(tx,now)=>{const tile=await h.game.tile(tx,tileForCell(near[0]));tile.locks[near[0]]=now+1000;await tx.put('tile:'+tile.parent,tile);});
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:selection,mode:'capture',cell:near[0]}),/заблокирован/);assert.deepEqual(await h.store.get('player:a'),before);
 h.advance(1001);let next=await h.game.commandUnits('a',{unitIds:selection,mode:'capture',cell:near[0]});assert.equal(next.player.army.units.find(u=>u.id==='a:air:0').order.mode,'attack');assert.ok(next.player.army.units.filter(u=>ids.includes(u.id)).every(u=>u.order.mode==='capture'));
 h.advance(12000);next=await h.game.state('a');const tile=(await h.store.get('tile:'+tileForCell(near[0]))).value;assert.ok(decodeTile(tileForCell(near[0]),tile.owners.a).includes(near[0]));assert.equal(next.player.army.events.filter(e=>e.kind==='capture'&&e.cell===near[0]).length,1);assert.ok(next.player.army.units.filter(u=>selection.includes(u.id)).every(u=>u.order.status==='complete'));
});
test('group attack is shielded atomically, then marches and applies real server damage after shields end',async()=>{
 const h=await fixture(),enemy=gridRing(base,4).find(c=>traversable(c));await h.store.atomic({puts:[{key:'account:b',value:{id:'b',createdAt:h.now()}}]});await h.game.placeBase('b',{cell:enemy,faction:'swarm'});
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:ids,mode:'attack',cell:enemy}),/щит/);assert.deepEqual(await h.store.get('player:a'),before);
 for(const id of['a','b'])await h.edit(p=>{p.shieldUntil=0;for(const u of p.army.units)u.order={mode:'hold',cell:u.cell,status:'complete'};},id);
 await h.game.commandUnits('a',{unitIds:ids,mode:'attack',cell:enemy});h.advance(24000);const state=await h.game.state('a'),defender=await h.store.get('player:b');assert.ok(defender.value.army.units.some(u=>u.hp<u.maxHp));assert.ok(state.player.army.events.some(e=>e.kind==='hit'));assert.ok(state.player.army.units.filter(u=>ids.includes(u.id)).every(u=>u.order.mode==='attack'&&u.order.cell===enemy));assert.equal(state.player.army.units[2].order.mode,'hold');
});
