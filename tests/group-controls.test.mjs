import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,cellToLatLng,gridDisk,gridRing} from 'h3-js';
import {createClientHarness} from './helpers/client-harness.mjs';
import {layoutTroops} from '../src/client/actor-layout.js';
import {traversable} from '../src/shared/landscape.js';
const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).find(c=>c!==base&&traversable(c));
async function fixture(webApp){const h=await createClientHarness({webApp,clock:()=>1900000000000});await h.click('openAuthModalBtn');await h.click('guestLogin');await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'pack'});await h.client.refreshState(true);h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);h.control=await h.client.ensureUnitControls();h.ids=h.client.state().model.player.army.units.filter(u=>!u.neutral&&u.owner===h.client.state().account.id).map(u=>u.id);return h;}
const pointFor=(h,id)=>{const view=h.client.unitCommandView(),p=layoutTroops(view.units,view).find(p=>p.unit.key===id);return{x:p.x,y:p.y-p.elevation*.8-p.span*.36};};
const evt=(p,options={})=>({pointerId:1,clientX:p.x,clientY:p.y,button:0,preventDefault(){},...options});
const down=(h,p,options)=>h.$('worldCanvas').listeners.get('pointerdown')(evt(p,options));
const move=(h,p,options)=>h.$('worldCanvas').listeners.get('pointermove')(evt(p,options));
const up=(h,p,options)=>h.$('worldCanvas').listeners.get('pointerup')(evt(p,options));
async function tap(h,id,options={}){const p=pointFor(h,id);down(h,p,options);await up(h,p,options);}
async function command(h,mode,cell=near){h.$('unit-'+mode).onclick();const p=h.client.unitCommandView().projectCell(cell);down(h,p);await up(h,p);}
function hold(h){const found=[...h.timers].find(([,t])=>t.ms===480);assert.ok(found,'a hold must have a pending 480 ms timer');h.timers.delete(found[0]);found[1].callback();}
const selected=h=>[...h.control.state().selectedIds].sort();
test('website and Mini App select multiple squads, submit exactly one authenticated group order and retain their selection',async t=>{
 for(const platform of['website','miniapp'])await t.test(platform,async()=>{
  const h=await fixture(platform==='miniapp'?{initData:'launch',BackButton:{onClick(){},show(){},hide(){}}}:undefined);await tap(h,h.ids[0]);await tap(h,h.ids[1],{shiftKey:true});assert.deepEqual(selected(h),h.ids.slice(0,2).sort());assert.match(h.$('unitName').textContent,/Группа/);const hp=h.client.unitCommandView().units.filter(u=>h.ids.slice(0,2).includes(u.key)).reduce((sum,u)=>sum+u.hp,0);assert.equal(h.$('unitHp').textContent,`${Math.ceil(hp)} / 200 HP`);
  h.client.draw(1000);const painted=h.client.mapSnapshot().mapPaints;await command(h,'move');const p=h.client.state().model.player;assert.ok(p.army.units.slice(0,2).every(u=>u.order.mode==='move'&&u.order.cell===near));assert.equal(p.army.units[2].order,undefined);assert.equal(h.requests.filter(p=>p==='/api/army/unit-orders').length,1);assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);assert.deepEqual(selected(h),h.ids.slice(0,2).sort());h.client.draw(1050);assert.equal(h.client.mapSnapshot().mapPaints,painted);assert.match(h.$('unitRouteInfo').textContent,/Общая цель/);
  await h.client.refreshState(true);await h.client.refreshTiles(true);assert.deepEqual(selected(h),h.ids.slice(0,2).sort());
  h.$('unitExtra').open=true;await h.click('unit-hold');assert.ok(h.client.state().model.player.army.units.slice(0,2).every(u=>u.order.mode==='hold'));await h.click('unit-auto');assert.ok(h.client.state().model.player.army.units.every(u=>!u.order));
 });
});
test('Shift-click toggles, Shift-marquee selects only owned live squads and Ctrl/Cmd+A selects the roster without sending orders',async()=>{
 const h=await fixture();await tap(h,h.ids[0]);await tap(h,h.ids[1],{shiftKey:true});await tap(h,h.ids[0],{shiftKey:true});assert.deepEqual(selected(h),[h.ids[1]]);
 const enemy=gridRing(base,4).find(c=>traversable(c));await h.store.atomic({puts:[{key:'account:enemy',value:{id:'enemy',createdAt:Date.now()}}]});await h.app.service.placeBase('enemy',{cell:enemy,faction:'swarm'});await h.client.refreshTiles(true);
 const initial=h.client.mapSnapshot().center;down(h,{x:1,y:1},{shiftKey:true});move(h,{x:1270,y:790},{shiftKey:true});h.client.draw(1100);await up(h,{x:1270,y:790},{shiftKey:true});assert.deepEqual(selected(h),[...h.ids].sort());assert.deepEqual(h.client.mapSnapshot().center,initial,'a marquee must not pan');assert.ok(!selected(h).some(id=>id.startsWith('enemy:')));
 h.control.select(h.ids[0]);const key=(overrides)=>h.windowEvents.get('keydown')({key:'a',code:'KeyA',target:h.$('worldCanvas'),repeat:false,preventDefault(){},...overrides});key({ctrlKey:true});assert.deepEqual(selected(h),[...h.ids].sort());h.control.select(h.ids[0]);key({metaKey:true});assert.deepEqual(selected(h),[...h.ids].sort());assert.equal(h.requests.filter(p=>p.includes('/army/unit-order')).length,0);
});
test('phone hold starts additive selection; later taps toggle members and a target tap gives one group order without extra buttons',async()=>{
 const h=await fixture(),touch={pointerType:'touch'};let p=pointFor(h,h.ids[0]);down(h,p,touch);hold(h);await up(h,p,touch);assert.deepEqual(selected(h),[h.ids[0]]);assert.equal(h.control.state().groupSelecting,true);
 await tap(h,h.ids[1],touch);assert.deepEqual(selected(h),h.ids.slice(0,2).sort());await tap(h,h.ids[0],touch);assert.deepEqual(selected(h),[h.ids[1]]);await tap(h,h.ids[2],touch);assert.equal(selected(h).length,2);
 h.$('unit-move').onclick();assert.equal(h.control.state().groupSelecting,false);p=h.client.unitCommandView().projectCell(near);down(h,p,touch);await up(h,p,touch);assert.equal(h.requests.filter(p=>p==='/api/army/unit-orders').length,1);assert.equal(h.$('gameNav').children.length,3);assert.equal(h.control.state().targetMode,null);
});
test('roster touch hold and short taps add members once; horizontal scrolling and synthetic context menus do not issue orders',async()=>{
 const h=await fixture();h.control.open();const roster=h.$('unitRoster'),button=id=>h.document.querySelectorAll('[data-unit-id]').find(n=>n.dataset.unitId===id),touch={pointerType:'touch',pointerId:7};let b=button(h.ids[0]);
 roster.listeners.get('pointerdown')(evt({x:30,y:300},{...touch,target:b}));hold(h);roster.listeners.get('pointerup')(evt({x:30,y:300},touch));roster.onclick({target:b,detail:1});assert.deepEqual(selected(h),[h.ids[0]]);
 b=button(h.ids[1]);roster.listeners.get('pointerdown')(evt({x:80,y:300},{...touch,target:b}));roster.listeners.get('pointerup')(evt({x:80,y:300},touch));roster.onclick({target:b,detail:1});assert.deepEqual(selected(h),h.ids.slice(0,2).sort());
 b=button(h.ids[2]);roster.listeners.get('pointerdown')(evt({x:120,y:300},{...touch,target:b}));roster.listeners.get('pointermove')(evt({x:180,y:300},touch));roster.listeners.get('pointerup')(evt({x:180,y:300},touch));roster.onclick({target:b,detail:1});assert.equal(selected(h).length,2);
 const p=pointFor(h,h.ids[0]);down(h,p,{pointerType:'touch'});hold(h);let prevented=false;await h.$('worldCanvas').listeners.get('contextmenu')(evt(p,{pointerType:'touch',preventDefault(){prevented=true;}}));await up(h,p,{pointerType:'touch'});assert.equal(prevented,true);assert.equal(h.requests.filter(p=>p.includes('/army/unit-order')).length,0);
});
test('pan, pinch, pointer cancellation, capture loss and opening another panel cancel a pending hold without accidental selection or orders',async()=>{
 const h=await fixture(),touch={pointerType:'touch'},initial=pointFor(h,h.ids[0]);down(h,initial,touch);move(h,{x:initial.x+60,y:initial.y},touch);assert.ok(![...h.timers.values()].some(t=>t.ms===480));await up(h,{x:initial.x+60,y:initial.y},touch);assert.deepEqual(selected(h),[]);
 h.client.focusAt(...cellToLatLng(base),2048);let p=pointFor(h,h.ids[0]);down(h,p,touch);down(h,{x:p.x+100,y:p.y},{...touch,pointerId:2});assert.ok(![...h.timers.values()].some(t=>t.ms===480));await up(h,p,touch);await up(h,{x:p.x+100,y:p.y},{...touch,pointerId:2});assert.deepEqual(selected(h),[]);
 for(const eventName of['pointercancel','lostpointercapture']){p=pointFor(h,h.ids[0]);down(h,p,touch);h.$('worldCanvas').listeners.get(eventName)({pointerId:1});assert.ok(![...h.timers.values()].some(t=>t.ms===480));await up(h,p,touch);assert.deepEqual(selected(h),[]);}
 p=pointFor(h,h.ids[0]);down(h,p,touch);h.client.openPanel('more');assert.ok(![...h.timers.values()].some(t=>t.ms===480));await up(h,p,touch);assert.equal(h.$('morePanel').hidden,false);assert.deepEqual(selected(h),[]);assert.equal(h.requests.filter(p=>p.includes('/army/unit-order')).length,0);
});
test('mixed capture gives ground orders plus air cover; all-air capture stays disabled and invalid group targets stay local',async()=>{
 const h=await fixture();await h.app.service.useAbility(h.client.state().account.id,{abilityId:'heavy',requestId:'group_client_air_cast'});await h.client.refreshState(true);const air=h.client.state().model.player.army.units.find(u=>u.type==='air').id;
 h.control.selectMany([h.ids[0],air]);assert.equal(h.$('unit-capture').disabled,false);assert.match(h.$('unit-capture').title,/прикроет/);h.$('unit-capture').onclick();assert.match(h.$('unitOrderStatus').textContent,/Авиация/);
 const far=gridRing(base,4).find(c=>traversable(c));await h.control.click({x:0,y:0,cell:far});assert.match(h.$('unitOrderStatus').textContent,/рядом/);assert.equal(h.requests.filter(p=>p==='/api/army/unit-orders').length,0);await h.control.click({x:0,y:0,cell:near});const units=h.client.state().model.player.army.units;assert.equal(units.find(u=>u.id===h.ids[0]).order.mode,'capture');assert.equal(units.find(u=>u.id===air).order.mode,'attack');
 h.control.select(air);assert.equal(h.$('unit-capture').disabled,true);h.control.key({key:'c',code:'KeyC'});assert.equal(h.control.state().targetMode,null);
});
test('server or network rejection retains the entire group and target cursor; logout cancels holds and clears selection',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));h.$('unit-move').onclick();h.network.failures.set('/api/army/unit-orders',1);await h.control.click({x:0,y:0,cell:near});assert.equal(h.control.state().busy,false);assert.equal(h.control.state().targetMode,'move');assert.deepEqual(selected(h),h.ids.slice(0,2).sort());assert.ok(h.client.state().model.player.army.units.every(u=>!u.order));
 const p=pointFor(h,h.ids[0]);down(h,p,{pointerType:'touch'});await h.$('logoutBtn').onclick();assert.ok(![...h.timers.values()].some(t=>t.ms===480));assert.deepEqual(selected(h),[]);assert.equal(h.$('unitPanel').hidden,true);
});
test('group endpoint requires authentication, same-origin and CSRF just like a single squad command',async()=>{
 const h=await fixture(),call=(headers={})=>h.app.fetch(new Request('http://127.0.0.1:4173/api/army/unit-orders',{method:'POST',headers:{origin:'http://127.0.0.1:4173','content-type':'application/json',...headers},body:JSON.stringify({unitIds:h.ids,mode:'hold'})}));
 assert.ok([401,403].includes((await call()).status));const session=h.session.get('pd-session');assert.ok(session);assert.equal((await call({authorization:'Bearer '+session})).status,403);assert.equal((await call({authorization:'Bearer '+session,origin:'https://foreign.example'})).status,403);
});

test('switching away from Telegram or hiding the document cancels a pending hold before it can change selection',async()=>{
 const events=new Map(),h=await fixture({initData:'launch',onEvent:(name,fn)=>events.set(name,fn)}),touch={pointerType:'touch'};let p=pointFor(h,h.ids[0]);
 down(h,p,touch);events.get('deactivated')();assert.ok(![...h.timers.values()].some(t=>t.ms===480));events.get('activated')();await up(h,p,touch);assert.deepEqual(selected(h),[]);
 p=pointFor(h,h.ids[0]);down(h,p,touch);h.document.hidden=true;h.documentEvents.get('visibilitychange')();assert.ok(![...h.timers.values()].some(t=>t.ms===480));h.document.hidden=false;h.documentEvents.get('visibilitychange')();await up(h,p,touch);assert.deepEqual(selected(h),[]);
});
