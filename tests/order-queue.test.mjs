import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,gridDisk,gridRing,gridDistance} from 'h3-js';
import {GameService} from '../src/server/game-service.js';
import {MemoryStore} from '../src/server/store.js';
import {traversable} from '../src/shared/landscape.js';
import {tileForCell,decodeTile} from '../src/shared/geography.js';

const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).filter(c=>c!==base&&traversable(c)),start=1900000000000,ids=['a:infantry:0','a:infantry:1'];
async function fixture(){
 let at=start;const store=new MemoryStore(),game=new GameService({store,clock:()=>at});
 await store.atomic({puts:[{key:'account:a',value:{id:'a',createdAt:at}}]});await game.placeBase('a',{cell:base,faction:'pack'});await game.commandArmy('a',{mode:'defend'});
 await game.commandUnits('a',{unitIds:[...ids,'a:infantry:2'],mode:'hold'});
 const h={game,store,now:()=>at,advance:ms=>at+=ms,edit:async(fn,id='a')=>{const r=await store.get('player:'+id);fn(r.value);await store.atomic({puts:[{key:'player:'+id,value:r.value}]});}};
 await h.edit(p=>p.army.credit=2);return h;
}
const troop=(state,id=ids[0])=>state.player.army.units.find(u=>u.id===id);
const steps=[{mode:'move',cell:near[0]},{mode:'move',cell:base},{mode:'capture',cell:near[1]}];
test('durable single and group queues walk each waypoint, then capture once, survive restart and leave other units alone',async t=>{
 for(const group of [false,true])await t.test(group?'group':'single',async()=>{
  const h=await fixture(),send=input=>group?h.game.commandUnits('a',{unitIds:ids,...input}):h.game.commandUnit('a',{unitId:ids[0],...input});
  let state=await send({orders:steps}),unit=troop(state);assert.equal(unit.order.cell,near[0]);assert.deepEqual(unit.orderQueue,steps.slice(1));assert.ok(unit.waypoints.length<=8);
  h.advance(500);state=await h.game.state('a');assert.ok(troop(state).move);h.game=new GameService({store:h.store,clock:h.now});
  const seen=[];let deploying=false;
  for(let i=0;i<60;i++){
   h.advance(500);state=await h.game.state('a');unit=troop(state);const stage=unit.order.mode+':'+unit.order.cell;if(seen.at(-1)!==stage)seen.push(stage);
   if(unit.move)assert.equal(gridDistance(unit.move.from,unit.move.to),1);if(unit.state==='capture')deploying=true;
  }
  assert.deepEqual(seen,steps.map(o=>o.mode+':'+o.cell));assert.equal(unit.order.status,'complete');assert.equal(unit.cell,near[1]);assert.equal(unit.orderQueue,undefined);assert.ok(deploying);
  assert.equal(state.player.army.units.find(u=>u.id==='a:infantry:2').order.mode,'hold');
  const tile=(await h.store.get('tile:'+tileForCell(near[1]))).value;assert.ok(decodeTile(tileForCell(near[1]),tile.owners.a).includes(near[1]));assert.equal(tile.history.filter(e=>e.cell===near[1]&&e.owner==='a').length,1);
  if(group)assert.ok(state.player.army.units.filter(u=>ids.includes(u.id)).every(u=>u.order.status==='complete'));
 });
});
test('appending preserves the active step and route; replacement, stop, auto and army-wide orders clear all future commands',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:ids[0],mode:'move',cell:near[0]});h.advance(500);const before=troop(await h.game.state('a'));
 const after=troop(await h.game.commandUnit('a',{unitId:ids[0],orders:steps.slice(1),append:true}));assert.deepEqual(after.move,before.move);assert.deepEqual(after.order,before.order);assert.deepEqual(after.waypoints,before.waypoints);assert.deepEqual(after.orderQueue,steps.slice(1));
 for(const mode of ['move','hold','auto']){
  await h.game.commandUnit('a',{unitId:ids[0],orders:steps});const result=troop(await h.game.commandUnit('a',{unitId:ids[0],mode,cell:base}));assert.equal(result.orderQueue,undefined);assert.deepEqual(result.move,before.move);
 }
 await h.game.commandUnits('a',{unitIds:ids,orders:steps});await h.game.commandArmy('a',{mode:'defend'});assert.ok((await h.game.state('a')).player.army.units.every(u=>!u.order&&!u.orderQueue));
});
test('an invalid late stage or member rejects the entire queue transaction; bounded metadata cannot inject state or paths',async()=>{
 const h=await fixture();await h.game.commandUnits('a',{unitIds:ids,orders:steps});
 for(const input of [
  {orders:[steps[0],{mode:'move',cell:'invalid'}]}, {orders:[steps[0],{mode:'capture',cell:base}]},
  {orders:[]},{orders:Array(13).fill(steps[0])},{orders:[{mode:'auto'}]},{orders:[{mode:'hold'}]},
  {orders:[null]},{orders:steps,mode:'move'},{orders:steps,append:'true'},
 ]){const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:ids,...input}));assert.deepEqual(await h.store.get('player:a'),before);}
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:[ids[0],'foreign:infantry:0'],orders:steps}));assert.deepEqual(await h.store.get('player:a'),before);
 const unit=troop(await h.game.commandUnit('a',{unitId:ids[0],orders:steps.map(o=>({...o,hp:99999,path:['fake'],status:'complete'})),orderQueue:[{mode:'capture',cell:base}]}));
 assert.equal(unit.hp,100);assert.deepEqual(unit.orderQueue,steps.slice(1));assert.ok(unit.waypoints.every(c=>c!=='fake'));assert.ok(unit.orderQueue.every(o=>Object.keys(o).sort().join(',')==='cell,mode'));
});
test('twelve total orders is the append limit and a full group rejection preserves every existing queue',async()=>{
 const h=await fixture(),orders=Array.from({length:12},(_,i)=>({mode:'move',cell:i%2?base:near[0]}));await h.game.commandUnit('a',{unitId:ids[1],orders});
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnits('a',{unitIds:ids,mode:'move',cell:near[1],append:true}),/12/);assert.deepEqual(await h.store.get('player:a'),before);
 await h.game.commandUnit('a',{unitId:ids[1],mode:'hold'});assert.equal(troop(await h.game.state('a'),ids[1]).orderQueue,undefined);
});
test('a lock added to a later destination blocks the queue without skipping it or capturing the following goal',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:ids[0],orders:[steps[0],{mode:'move',cell:near[1]},{mode:'capture',cell:near[2]}]});
 await h.game.transaction(async(tx,now)=>{const tile=await h.game.tile(tx,tileForCell(near[1]));tile.locks[near[1]]=now+60000;await tx.put('tile:'+tile.parent,tile);});
 h.advance(16000);const state=await h.game.state('a'),u=troop(state);assert.equal(u.order.cell,near[1]);assert.equal(u.order.status,'blocked');assert.deepEqual(u.orderQueue,[{mode:'capture',cell:near[2]}]);assert.equal(state.player.pixels,1);
 const before=await h.store.get('player:a');await assert.rejects(()=>h.game.commandUnit('a',{unitId:ids[0],mode:'move',cell:base,append:true}),/заблокирована/);assert.deepEqual(await h.store.get('player:a'),before);
});
test('queued captures can extend the border in sequence and spend real credit once per new cell',async()=>{
 const h=await fixture(),next=gridDisk(near[0],1).find(c=>gridDistance(c,base)===2&&traversable(c));
 await assert.rejects(()=>h.game.commandUnit('a',{unitId:ids[0],orders:[{mode:'capture',cell:next}]}),/рядом/);
 await h.game.commandUnit('a',{unitId:ids[0],orders:[{mode:'capture',cell:near[0]},{mode:'capture',cell:next}]});h.advance(20000);const state=await h.game.state('a');assert.equal(troop(state).order.status,'complete');assert.equal(state.player.pixels,3);assert.equal(troop(state).cell,next);
 const tile=(await h.store.get('tile:'+tileForCell(next))).value;assert.ok(decodeTile(tileForCell(next),tile.owners.a).includes(next));
});
test('mixed groups walk first, then ground troops capture and aircraft escort; all-air sequences reject capture',async()=>{
 const h=await fixture();await h.game.useAbility('a',{abilityId:'heavy',requestId:'queue_air_escort_cast'});const air='a:air:0';
 await assert.rejects(()=>h.game.commandUnit('a',{unitId:air,orders:steps}),/Авиация/);
 const state=await h.game.commandUnits('a',{unitIds:[ids[0],air],orders:steps});assert.deepEqual(troop(state).orderQueue,steps.slice(1));assert.equal(troop(state,air).orderQueue.at(-1).mode,'attack');
});
test('queued attack waits for movement, deals real damage, and rechecks a shield activated after acceptance',async()=>{
 for(const shield of [false,true]){
  const h=await fixture(),enemy=gridRing(base,4).find(c=>traversable(c));await h.store.atomic({puts:[{key:'account:b',value:{id:'b',createdAt:start}}]});await h.game.placeBase('b',{cell:enemy,faction:'swarm'});
  for(const id of ['a','b'])await h.edit(p=>{p.shieldUntil=0;for(const u of p.army.units)u.order={mode:'hold',cell:u.cell,status:'complete'};},id);
  await h.game.commandUnits('a',{unitIds:ids,orders:[steps[0],steps[1],{mode:'attack',cell:enemy},{mode:'move',cell:base}]});
  if(shield)await h.edit(p=>p.shieldUntil=start+60000,'b');h.advance(24000);const state=await h.game.state('a'),defender=(await h.store.get('player:b')).value;
  if(shield){assert.equal(troop(state).order.status,'blocked');assert.equal(troop(state).order.reason,'shield');assert.equal(troop(state).orderQueue.at(-1).cell,base);assert.ok(defender.army.units.every(u=>u.hp===u.maxHp));}
  else assert.ok(defender.army.units.some(u=>u.hp<u.maxHp));
 }
});
test('death stops a queue and respawn clears it without replaying stored commands',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:ids[0],orders:steps});await h.edit(p=>{const u=p.army.units[0];u.hp=0;u.state='death';u.stateAt=start;});h.advance(18500);const u=troop(await h.game.state('a'));assert.equal(u.order,undefined);assert.equal(u.orderQueue,undefined);assert.equal(u.life,1);
});
test('defending against a nearby enemy never releases a blocked queue or discards its remaining stages',async()=>{
 const h=await fixture();await h.game.commandUnit('a',{unitId:ids[0],orders:steps});
 await h.edit(p=>{const u=p.army.units[0];u.hp=u.maxHp=10000;u.order.cell=base;u.order.status='blocked';u.order.reason='locked';});
 const enemy=gridRing(base,4).find(c=>traversable(c));await h.store.atomic({puts:[{key:'account:b',value:{id:'b',createdAt:start}}]});await h.game.placeBase('b',{cell:enemy,faction:'swarm'});
 for(const id of ['a','b'])await h.edit(p=>{p.shieldUntil=0;if(id==='b'){const u=p.army.units[0];u.cell=base;u.hp=u.maxHp=10000;u.order={mode:'hold',cell:base,status:'complete'};}},id);
 h.advance(1500);const state=await h.game.state('a'),u=troop(state);assert.equal(u.state,'attack');assert.equal(u.order.status,'blocked');assert.equal(u.order.reason,'locked');assert.deepEqual(u.orderQueue,steps.slice(1));
});
