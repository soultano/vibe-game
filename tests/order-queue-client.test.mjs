import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,cellToLatLng,gridDisk} from 'h3-js';
import {createClientHarness} from './helpers/client-harness.mjs';
import {traversable} from '../src/shared/landscape.js';
import {drawUnitOrder,drawQueuedGoals} from '../src/client/unit-order-view.js';
const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).filter(c=>c!==base&&traversable(c)),clock=()=>1900000000000;
const plain=value=>JSON.parse(JSON.stringify(value));
async function fixture(webApp){
 const h=await createClientHarness({webApp,clock});await h.click('openAuthModalBtn');await h.click('guestLogin');const id=h.client.state().account.id;
 await h.app.service.placeBase(id,{cell:base,faction:'pack'});await h.app.service.commandArmy(id,{mode:'defend'});await h.client.refreshState(true);
 h.ids=h.client.state().model.player.army.units.filter(u=>!u.neutral).map(u=>u.id);await h.app.service.commandUnits(id,{unitIds:h.ids,mode:'hold'});await h.client.refreshState(true);
 h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);h.control=await h.client.ensureUnitControls();return h;
}
const pointer=(h,mode,name,options={})=>h.$('unit-'+mode).listeners.get(name)({pointerType:'touch',pointerId:7,button:0,clientX:40,clientY:200,preventDefault(){},...options});
function hold(h){const [id,timer]=[...h.timers].find(([,t])=>t.ms===480)||[];assert.ok(timer);h.timers.delete(id);timer.callback();}
function start(h,mode='move'){pointer(h,mode,'pointerdown');hold(h);pointer(h,mode,'pointerup');pointer(h,mode,'lostpointercapture');h.$('unit-'+mode).onclick({detail:1});assert.equal(h.control.queue.state().active,true);}
async function mapTap(h,cell,options={}){
 const p=h.client.unitCommandView().projectCell(cell),event={pointerType:'touch',pointerId:1,clientX:p.x,clientY:p.y,button:0,preventDefault(){},...options};h.$('worldCanvas').listeners.get('pointerdown')(event);await h.$('worldCanvas').listeners.get('pointerup')(event);
}
const orders=h=>h.requests.filter(p=>p.includes('/api/army/unit-order'));
async function finishBusy(h){for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,1));if(!h.control.state().busy)return;}assert.fail('queue command did not settle');}
test('website and Mini App build a phone route locally and confirm one atomic single/group queue, with no extra navigation or terrain rebuilds',async t=>{
 for(const platform of ['website','miniapp'])for(const group of [false,true])await t.test(platform+(group?' group':' single'),async()=>{
  const h=await fixture(platform==='miniapp'?{initData:'launch',BackButton:{onClick(){},show(){},hide(){}}}:undefined);h.control.selectMany(group?h.ids.slice(0,2):[h.ids[0]]);h.client.draw(1000);const paints=h.client.mapSnapshot().mapPaints;
  start(h);await mapTap(h,near[0]);await mapTap(h,base);h.$('unit-capture').onclick();await mapTap(h,near[1]);
  const steps=[{mode:'move',cell:near[0]},{mode:'move',cell:base},{mode:'capture',cell:near[1]}];assert.deepEqual(plain(h.control.queue.state().draft),steps);assert.equal(orders(h).length,0);h.client.draw(1050);assert.equal(h.client.mapSnapshot().mapPaints,paints);
  assert.equal(h.$('unitPanel').classList.contains('queue-planning'),true);assert.match(h.$('unitCancelTarget').textContent,/3/);assert.equal(h.$('gameNav').children.length,3);
  let payload;h.network.beforeRequest=(path,options)=>{if(path.includes('/api/army/unit-order'))payload=JSON.parse(options.body);};await h.click('unitCancelTarget');
  assert.equal(orders(h).length,1);assert.deepEqual(payload.orders,steps);assert.equal(payload.append,true);assert.equal(h.control.queue.state().active,false);assert.equal(h.control.state().targetMode,null);
  const units=h.client.state().model.player.army.units;for(const id of group?h.ids.slice(0,2):[h.ids[0]]){const u=units.find(u=>u.id===id);assert.equal(u.order.cell,near[0]);assert.deepEqual(plain(u.orderQueue),steps.slice(1));}
  assert.equal(units.find(u=>u.id===h.ids[2]).order.mode,'hold');assert.match(h.$('unitQueueInfo').textContent,/1\. Идти.*2\. Идти.*3\. Захватить/);assert.match(h.$('unitQueueInfo').textContent,/цель:/);
  const restored=await createClientHarness({store:h.store,session:new Map(h.session),clock});const control=await restored.client.ensureUnitControls();control.select(h.ids[0]);assert.match(restored.$('unitQueueInfo').textContent,/Захватить/);
 });
});
test('Shift target taps draft a route without a marquee and releasing Shift commits once; Shift right-click appends to its existing tail',async()=>{
 const h=await fixture();h.control.select(h.ids[0]);h.$('unit-move').onclick();const center=h.client.mapSnapshot().center;
 await mapTap(h,near[0],{pointerType:'mouse',shiftKey:true});await mapTap(h,base,{pointerType:'mouse',shiftKey:true});
 h.windowEvents.get('keydown')({key:'ф',code:'KeyA',shiftKey:true,repeat:false,target:h.$('worldCanvas'),preventDefault(){}});await mapTap(h,near[1],{pointerType:'mouse',shiftKey:true});assert.equal(orders(h).length,0);assert.deepEqual(h.client.mapSnapshot().center,center);
 h.windowEvents.get('keyup')({key:'Shift',target:h.$('worldCanvas')});await finishBusy(h);assert.equal(orders(h).length,1);const before=plain(h.client.state().model.player.army.units[0].order);
 const p=h.client.unitCommandView().projectCell(near[2]);await h.$('worldCanvas').listeners.get('contextmenu')({clientX:p.x,clientY:p.y,shiftKey:true,pointerType:'mouse',preventDefault(){}});assert.equal(orders(h).length,1);
 h.windowEvents.get('keyup')({key:'Shift',target:h.$('worldCanvas')});await finishBusy(h);const u=h.client.state().model.player.army.units.find(u=>u.id===h.ids[0]);assert.deepEqual(plain(u.order),before);assert.equal(u.orderQueue.length,3);assert.equal(u.orderQueue.at(-1).cell,near[2]);
});
test('undo, Esc, close, another surface, recall of a saved group and logout discard only unsubmitted drafts',async()=>{
 const h=await fixture();h.control.select(h.ids[0]);await h.$('unitGroups').onclick({target:h.$('unitGroups').children[0],detail:1});
 for(const cancel of [()=>h.control.key({key:'Escape'}),()=>h.$('unitClose').onclick(),()=>h.client.openPanel('more'),()=>h.windowEvents.get('keydown')({key:'1',code:'Digit1',target:h.$('worldCanvas'),preventDefault(){}})]){
  h.client.surfaces.back();h.control.select(h.ids[0]);start(h);await mapTap(h,near[0]);await mapTap(h,near[1]);await h.click('unitQueueUndo');assert.equal(h.control.queue.state().draft.length,1);cancel();assert.equal(h.control.queue.state().active,false);assert.equal(orders(h).length,0);
 }
 h.control.select(h.ids[0]);start(h);await mapTap(h,near[0]);await h.$('logoutBtn').onclick();assert.equal(h.control.queue.state().active,false);assert.equal(orders(h).length,0);
});
test('network failure retains the complete draft for retry, while Stop clears accepted future orders',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));start(h);await mapTap(h,near[0]);await mapTap(h,near[1]);h.network.failures.set('/api/army/unit-orders',1);await h.click('unitCancelTarget');assert.equal(h.control.queue.state().draft.length,2);assert.equal(h.control.state().busy,false);
 await h.click('unitCancelTarget');assert.equal(h.control.queue.state().active,false);assert.ok(h.client.state().model.player.army.units.slice(0,2).every(u=>u.orderQueue.length===1));h.$('unitExtra').open=true;await h.click('unit-hold');assert.ok(h.client.state().model.player.army.units.slice(0,2).every(u=>!u.orderQueue&&u.order.mode==='hold'));
});
test('invalid targets never join the draft, the twelve-stage limit is local, and an empty planner sends nothing',async()=>{
 const h=await fixture();h.control.select(h.ids[0]);start(h,'capture');await mapTap(h,base);assert.equal(h.control.queue.state().draft.length,0);await h.click('unitCancelTarget');assert.equal(orders(h).length,0);
 start(h);for(let i=0;i<13;i++)await mapTap(h,i%2?base:near[0]);assert.equal(h.control.queue.state().draft.length,12);assert.match(h.$('toast').textContent,/12/);assert.equal(orders(h).length,0);
});
test('button swipes, second pointers, cancellation, capture loss, blur and covering the map cancel pending queue holds',async()=>{
 const h=await fixture();h.control.select(h.ids[0]);
 for(const cancel of [()=>pointer(h,'move','pointermove',{clientX:70}),()=>pointer(h,'move','pointerdown',{pointerId:8,isPrimary:false}),()=>pointer(h,'move','pointercancel'),()=>pointer(h,'move','lostpointercapture'),()=>h.windowEvents.get('blur')(),()=>h.client.openPanel('more')]){
  h.client.surfaces.back();h.control.select(h.ids[0]);pointer(h,'move','pointerdown');cancel();assert.ok(![...h.timers.values()].some(t=>t.ms===480));pointer(h,'move','pointerup');h.$('unit-move').onclick({detail:1});assert.equal(h.control.queue.state().active,false);
 }
 assert.equal(orders(h).length,0);
});
test('pan and pinch keep an existing draft; hiding, blur or Telegram deactivation prevents Shift-release auto submission',async()=>{
 const events=new Map(),h=await fixture({initData:'launch',onEvent:(name,fn)=>events.set(name,fn)});h.control.select(h.ids[0]);h.$('unit-move').onclick();await mapTap(h,near[0],{pointerType:'mouse',shiftKey:true});
 const canvas=h.$('worldCanvas'),event=(id,x)=>({pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:400,preventDefault(){}});canvas.listeners.get('pointerdown')(event(1,500));canvas.listeners.get('pointermove')(event(1,550));await canvas.listeners.get('pointerup')(event(1,550));
 canvas.listeners.get('pointerdown')(event(1,500));canvas.listeners.get('pointerdown')(event(2,600));canvas.listeners.get('pointermove')(event(2,650));await canvas.listeners.get('pointerup')(event(1,500));await canvas.listeners.get('pointerup')(event(2,650));assert.equal(h.control.queue.state().draft.length,1);assert.equal(orders(h).length,0);
 for(const pause of [()=>h.windowEvents.get('blur')(),()=>{h.document.hidden=true;h.documentEvents.get('visibilitychange')();h.document.hidden=false;},()=>{events.get('deactivated')();events.get('activated')();}]){pause();h.windowEvents.get('keyup')({key:'Shift',target:canvas});assert.equal(orders(h).length,0);assert.equal(h.control.queue.state().draft.length,1);}
 await h.click('unitCancelTarget');assert.equal(orders(h).length,1);
});
test('queue drawings number future destinations and deduplicate group markers, while preserving the actual first route',()=>{
 const labels=[],lines=[],ctx=new Proxy({measureText:()=>({width:30}),fillText:(text,x,y)=>labels.push([text,x,y]),lineTo:(x,y)=>lines.push([x,y])},{get:(o,k)=>o[k]||(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
 const positions={start:0,step:50,goal:100,next:200,last:300},view={projectCell:cell=>({x:positions[cell],y:100}),queueMarkers:new Set()},unit={cell:'start',waypoints:['step'],order:{mode:'move',cell:'goal'},orderQueue:[{mode:'move',cell:'next'},{mode:'capture',cell:'last'}]};
 drawUnitOrder(ctx,unit,view);drawUnitOrder(ctx,unit,{...view,goalMarker:false});assert.deepEqual(labels.filter(([t])=>/^\d+$/.test(t)).map(([t,x])=>[t,x]),[['1',100],['2',200],['3',300]]);assert.ok(lines.some(([x])=>x===50));
 drawQueuedGoals(ctx,[{mode:'attack',cell:'last'}],view,{offset:3,draft:true});assert.ok(labels.some(([t,x])=>t==='4'&&x===300));
});
test('Enter keeps native button actions and Shift released over an input never submits a draft',async()=>{
 const h=await fixture();h.control.select(h.ids[0]);h.$('unit-move').onclick();await mapTap(h,near[0],{pointerType:'mouse',shiftKey:true});
 assert.equal(h.control.key({key:'Enter',target:h.$('unitQueueUndo')}),false);h.windowEvents.get('keyup')({key:'Shift',target:h.$('devName')});assert.equal(orders(h).length,0);h.windowEvents.get('keyup')({key:'Shift',target:h.$('worldCanvas')});assert.equal(orders(h).length,0);await h.click('unitQueueUndo');assert.equal(h.control.queue.state().draft.length,0);
});
