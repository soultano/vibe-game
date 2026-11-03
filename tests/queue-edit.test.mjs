import test from 'node:test';import assert from 'node:assert/strict';
import {latLngToCell,gridDisk} from 'h3-js';
import {GameService} from '../src/server/game-service.js';import {MemoryStore} from '../src/server/store.js';import {queueEntries} from '../src/shared/unit-orders.js';import {traversable} from '../src/shared/landscape.js';
const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).filter(c=>c!==base&&traversable(c)),ids=['a:infantry:0','a:infantry:1'];
const sequence=[{mode:'move',cell:near[0]},{mode:'move',cell:base},{mode:'move',cell:near[1]},{mode:'attack',cell:near[2]}];
async function fixture(){let at=1900000000000;const store=new MemoryStore(),game=new GameService({store,clock:()=>at});await store.atomic({puts:[{key:'account:a',value:{id:'a',createdAt:at}}]});await game.placeBase('a',{cell:base,faction:'pack'});await game.commandUnits('a',{unitIds:ids,orders:sequence});return{game,store,advance:ms=>at+=ms};}
const own=state=>state.player.army.units.filter(u=>ids.includes(u.id));
const edits=(units,indices)=>units.map(u=>({unitId:u.id,expectedKeys:queueEntries(u).map(o=>o.key),keys:indices.map(i=>queueEntries(u)[i].key)}));
test('deleting and reordering future steps keeps active movement, route and identity; edits persist across restart',async()=>{
 const h=await fixture();h.advance(500);const before=own(await h.game.state('a')),input=edits(before,[0,3,1]);
 const next=own(await h.game.editUnitQueues('a',{edits:input}));for(let i=0;i<next.length;i++){assert.deepEqual(next[i].move,before[i].move);assert.deepEqual(next[i].order,before[i].order);assert.deepEqual(next[i].waypoints,before[i].waypoints);assert.deepEqual(next[i].orderQueue,[sequence[3],sequence[1]]);assert.deepEqual(next[i].orderKeys,input[i].keys);}
 const fresh=new GameService({store:h.store,clock:()=>1900000000500});assert.deepEqual(own(await fresh.state('a')).map(u=>u.orderKeys),input.map(i=>i.keys));
});
test('removing or moving the active target finishes its current adjacent step; empty edits stop only selected units',async()=>{
 for(const indices of [[2,3,0],[]]){const h=await fixture();h.advance(500);const before=own(await h.game.state('a')),next=own(await h.game.editUnitQueues('a',{edits:edits([before[0]],indices)}));assert.deepEqual(next[0].move,before[0].move);assert.equal(next[0].cell,before[0].cell);assert.deepEqual(next[1].orderQueue,before[1].orderQueue);assert.equal(next[0].order.mode,indices.length?'move':'hold');if(indices.length)assert.equal(next[0].order.cell,sequence[2].cell);else assert.equal(next[0].orderQueue,undefined);}
});
test('completed prefixes rebase by stable keys without reviving a completed point; concurrent appends and rewrites reject atomically',async()=>{
 const h=await fixture(),before=own(await h.game.state('a')),input=edits([before[0]],[0,2,1,3]);let advanced;for(let i=0;i<30;i++){h.advance(500);advanced=own(await h.game.state('a'))[0];if(queueEntries(advanced).length<4)break;}assert.ok(queueEntries(advanced).length<4);
 const next=own(await h.game.editUnitQueues('a',{edits:input}))[0];assert.ok(!next.orderKeys.includes(input[0].expectedKeys[0]));assert.equal(next.order.cell,sequence[2].cell);
 const snapshot=own(await h.game.state('a'));await h.game.commandUnit('a',{unitId:ids[1],mode:'move',cell:base,append:true});const row=await h.store.get('player:a');await assert.rejects(()=>h.game.editUnitQueues('a',{edits:edits(snapshot,[0])}),e=>e.code==='QUEUE_CHANGED');assert.deepEqual(await h.store.get('player:a'),row);
});
test('unknown, duplicate, foreign and late-invalid edits reject the whole group without changing earlier units',async()=>{
 const h=await fixture(),units=own(await h.game.state('a')),valid=edits(units,[0,2]);
 for(const input of [[],[{...valid[0],keys:['invented']}],[{...valid[0],keys:[valid[0].keys[0],valid[0].keys[0]]}],[valid[0],{...valid[1],unitId:'foreign:infantry:0'}],[valid[0],{...valid[1],expectedKeys:[]}],[valid[0],valid[0]]]){const row=await h.store.get('player:a');await assert.rejects(()=>h.game.editUnitQueues('a',{edits:input}));assert.deepEqual(await h.store.get('player:a'),row);}
});
test('removing a required earlier capture fails instead of creating disconnected territory',async()=>{
 const h=await fixture(),far=gridDisk(near[0],1).find(c=>!gridDisk(base,1).includes(c)&&traversable(c));await h.game.commandUnit('a',{unitId:ids[0],orders:[{mode:'capture',cell:near[0]},{mode:'capture',cell:far}]});const u=own(await h.game.state('a'))[0],row=await h.store.get('player:a');await assert.rejects(()=>h.game.editUnitQueues('a',{edits:edits([u],[1])}),/рядом/);assert.deepEqual(await h.store.get('player:a'),row);
});
