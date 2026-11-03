import test from 'node:test';import assert from 'node:assert/strict';import {latLngToCell,cellToLatLng,gridDisk} from 'h3-js';import {createClientHarness} from './helpers/client-harness.mjs';import {traversable} from '../src/shared/landscape.js';
const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).filter(c=>c!==base&&traversable(c)),orders=[{mode:'move',cell:near[0]},{mode:'move',cell:base},{mode:'move',cell:near[1]},{mode:'attack',cell:near[2]}];
const plain=v=>JSON.parse(JSON.stringify(v));
async function fixture(webApp){const h=await createClientHarness({webApp,clock:()=>1900000000000});await h.click('openAuthModalBtn');await h.click('guestLogin');h.id=h.client.state().account.id;await h.app.service.placeBase(h.id,{cell:base,faction:'pack'});await h.client.refreshState(true);h.ids=h.client.state().model.player.army.units.filter(u=>!u.neutral).map(u=>u.id);await h.app.service.commandUnits(h.id,{unitIds:h.ids.slice(0,2),orders});await h.client.refreshState(true);h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);h.control=await h.client.ensureUnitControls();h.control.selectMany(h.ids.slice(0,2));h.$('unitQueueEditor').open=true;return h;}
const rows=h=>h.$('unitQueueList').querySelectorAll('[data-queue-point]');
const choose=(h,i)=>h.$('unitQueueList').onclick({target:rows(h)[i]});
const units=h=>h.client.state().model.player.army.units.filter(u=>h.ids.slice(0,2).includes(u.id));
test('website and Mini App edit a common group queue inline without changing the active route or rebuilding terrain',async t=>{
 for(const platform of ['website','miniapp'])await t.test(platform,async()=>{
  const h=await fixture(platform==='miniapp'?{initData:'launch'}:undefined),before=plain(units(h));h.client.draw(1000);const paints=h.client.mapSnapshot().mapPaints;assert.equal(rows(h).length,4);choose(h,2);assert.equal(h.$('unitQueuePointActions').hidden,false);
  h.$('unitQueuePosition').value='1';await h.$('unitQueuePosition').onchange();for(const u of units(h)){assert.deepEqual(plain(u.order),before.find(p=>p.id===u.id).order);assert.deepEqual(plain(u.orderQueue),[orders[2],orders[1],orders[3]]);}
  choose(h,2);await h.click('unitQueueDelete');assert.ok(units(h).every(u=>u.orderQueue.length===2));h.client.draw(1050);assert.equal(h.client.mapSnapshot().mapPaints,paints);assert.equal(h.requests.filter(p=>p==='/api/army/queue-edit').length,2);assert.equal(h.$('gameNav').children.length,3);
 });
});
test('draft points can be reordered and individually removed locally, preserving earlier accepted commands',async()=>{
 const h=await fixture();h.$('unit-move').listeners.get('pointerdown')({pointerId:7,button:0,clientX:10,clientY:10});const pending=[...h.timers].find(([,t])=>t.ms===480);h.timers.delete(pending[0]);pending[1].callback();h.$('unit-move').listeners.get('pointerup')({pointerId:7});
 for(const cell of [near[3],base,near[4]])await h.control.click({x:0,y:0,cell});assert.equal(rows(h).length,3);const requests=h.requests.length;choose(h,2);h.$('unitQueuePosition').value='0';await h.$('unitQueuePosition').onchange();choose(h,1);await h.click('unitQueueDelete');assert.deepEqual(plain(h.control.queue.state().draft),[{mode:'move',cell:near[4]},{mode:'move',cell:base}]);assert.equal(h.requests.length,requests);assert.deepEqual(plain(units(h)[0].orderQueue),orders.slice(1));
});
test('asynchronously progressing squads edit their shared tail while retaining their different active targets',async()=>{
 const h=await fixture(),row=await h.store.get('player:'+h.id),u=row.value.army.units.find(u=>u.id===h.ids[0]);u.cell=u.order.cell;u.order={...u.orderQueue.shift(),issuedAt:1900000000000,status:'queued'};u.orderKeys.shift();await h.store.atomic({puts:[{key:'player:'+h.id,value:row.value}]});await h.client.refreshState(true);assert.equal(rows(h).length,3);const before=plain(units(h));choose(h,1);await h.click('unitQueueDelete');for(const unit of units(h)){assert.deepEqual(plain(unit.order),before.find(u=>u.id===unit.id).order);assert.ok(!unit.orderQueue.some(o=>o.cell===orders[2].cell));}
});
test('network failure keeps the proposed edit and retries; a concurrent append is never silently discarded',async()=>{
 const h=await fixture();choose(h,2);h.network.failures.set('/api/army/queue-edit',1);await h.click('unitQueueDelete');assert.equal(h.$('unitQueueEditRetry').hidden,false);assert.equal(units(h)[0].orderQueue.length,3);await h.click('unitQueueEditRetry');assert.equal(units(h)[0].orderQueue.length,2);
 choose(h,1);await h.app.service.commandUnits(h.id,{unitIds:h.ids.slice(0,2),mode:'move',cell:near[5],append:true});await h.click('unitQueueDelete');assert.equal(h.$('unitQueueEditRetry').hidden,false);const server=await h.app.service.state(h.id);assert.ok(server.player.army.units.filter(u=>h.ids.slice(0,2).includes(u.id)).every(u=>u.orderQueue.at(-1).cell===near[5]));
});
test('queue edits use the authenticated CSRF/Origin path',async()=>{
 const h=await fixture(),response=await h.app.fetch(new Request('http://127.0.0.1:4173/api/army/queue-edit',{method:'POST',headers:{origin:'http://127.0.0.1:4173','content-type':'application/json'},body:JSON.stringify({edits:[]})}));assert.ok([401,403].includes(response.status));
});
