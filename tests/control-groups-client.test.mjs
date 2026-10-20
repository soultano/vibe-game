import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,cellToLatLng,gridDisk} from 'h3-js';
import {createClientHarness} from './helpers/client-harness.mjs';
import {traversable} from '../src/shared/landscape.js';

const base=latLngToCell(41.3111,69.2797,8),clock=()=>1900000000000;
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(webApp){
 const h=await createClientHarness({webApp,clock});await h.click('openAuthModalBtn');await h.click('guestLogin');
 await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'pack'});await h.client.refreshState(true);
 h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);h.control=await h.client.ensureUnitControls();
 h.ids=h.client.state().model.player.army.units.filter(u=>!u.neutral).map(u=>u.id);return h;
}
const slots=h=>h.$('unitGroups').querySelectorAll('[data-control-group]');
const selected=h=>[...h.control.state().selectedIds].sort();
const group=h=>plain(h.client.state().model.player.unitGroups);
async function press(h,n,options={}){
 let prevented=false;h.windowEvents.get('keydown')({key:String(n),code:'Digit'+n,timeStamp:1000,repeat:false,target:h.$('worldCanvas'),preventDefault(){prevented=true;},...options});await flush();
 for(let i=0;i<100&&h.$('unitGroups').getAttribute('aria-busy')==='true';i++)await new Promise(resolve=>setTimeout(resolve,1));return prevented;
}
const clickSlot=(h,n,options={})=>h.$('unitGroups').onclick({target:slots(h)[n-1],detail:1,timeStamp:1000,...options});
const pointer=(h,name,slot,options={})=>h.$('unitGroups').listeners.get(name)({pointerId:7,pointerType:'touch',button:0,clientX:30,clientY:200,target:slots(h)[slot-1],preventDefault(){},...options});
async function hold(h){const found=[...h.timers].find(([,t])=>t.ms===480);assert.ok(found);h.timers.delete(found[0]);await found[1].callback();}

test('website and Mini App save five slots in the account, recall after close/reload and send one common order with no terrain reload on save',async t=>{
 for(const platform of ['website','miniapp'])await t.test(platform,async()=>{
  const webApp=platform==='miniapp'?{initData:'launch',BackButton:{onClick(){},show(){},hide(){}}}:undefined,h=await fixture(webApp);
  h.control.selectMany(h.ids.slice(0,2));h.client.draw(1000);const paints=h.client.mapSnapshot().mapPaints,requests=h.requests.length;
  assert.equal(await press(h,1,{ctrlKey:true}),true);assert.deepEqual(group(h)[0],h.ids.slice(0,2));
  assert.deepEqual(h.requests.slice(requests),['/api/army/unit-groups'],'saving must only store metadata');h.client.draw(1050);assert.equal(h.client.mapSnapshot().mapPaints,paints);
  h.control.select(h.ids[2]);await press(h,5,{metaKey:true});assert.deepEqual(group(h)[4],[h.ids[2]]);
  await h.click('unitClose');assert.deepEqual(selected(h),[]);await press(h,1);assert.deepEqual(selected(h),h.ids.slice(0,2).sort());
  assert.equal(h.$('unitPanel').hidden,false);assert.equal(slots(h)[0].getAttribute('aria-pressed'),'true');assert.equal(slots(h)[0].getAttribute('data-count'),'2/2');assert.equal(slots(h).length,5);assert.equal(h.$('gameNav').children.length,3);
  const other=await createClientHarness({store:h.store,session:new Map(h.session),clock,webApp:webApp?undefined:{initData:'launch'}});other.control=await other.client.ensureUnitControls();
  assert.equal(other.client.state().account.id,h.client.state().account.id);await press(other,1);assert.deepEqual(selected(other),h.ids.slice(0,2).sort());
  const near=gridDisk(base,1).find(c=>c!==base&&traversable(c));other.$('unit-move').onclick();await other.control.click({x:0,y:0,cell:near});
  assert.equal(other.requests.filter(p=>p==='/api/army/unit-orders').length,1);assert.ok(other.client.state().model.player.army.units.filter(u=>h.ids.slice(0,2).includes(u.id)).every(u=>u.order.cell===near));
  assert.equal(other.client.state().model.player.army.units.find(u=>u.id===h.ids[2]).order,undefined);
 });
});
test('phone empty slot tap saves; occupied slot tap selects; holding replaces once and double tap focuses without orders',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));await clickSlot(h,1);h.control.select(h.ids[2]);
 clickSlot(h,1);assert.deepEqual(selected(h),h.ids.slice(0,2).sort(),'a short tap must not overwrite');
 h.control.selectMany(h.ids.slice(1));pointer(h,'pointerdown',1);await hold(h);pointer(h,'pointerup',1);pointer(h,'lostpointercapture',1);await clickSlot(h,1);
 assert.deepEqual(group(h)[0],h.ids.slice(1));assert.equal(h.requests.filter(p=>p==='/api/army/unit-groups').length,2,'the synthetic click after a hold must be consumed');
 h.client.focusAt(0,0,8);clickSlot(h,1,{timeStamp:2000});assert.equal(h.client.mapSnapshot().zoom,8);clickSlot(h,1,{timeStamp:2200});assert.ok(h.client.mapSnapshot().zoom>=2048);
 const [lat,lng]=cellToLatLng(base);assert.ok(Math.abs(h.client.mapSnapshot().center.lat-lat)<.001);assert.ok(Math.abs(h.client.mapSnapshot().center.lng-lng)<.001);
 assert.equal(h.requests.filter(p=>p.includes('/army/unit-order')).length,0);
 h.$('unitExtra').open=true;await h.click('unitForgetGroup');assert.deepEqual(group(h)[0],[]);assert.deepEqual(selected(h),h.ids.slice(1).sort());
});
test('pending slot hold is cancelled by a swipe, pointer cancellation, capture loss, closing or covering the panel, hiding and Telegram deactivation',async()=>{
 const events=new Map(),h=await fixture({initData:'launch',onEvent:(name,fn)=>events.set(name,fn)});h.control.selectMany(h.ids.slice(0,2));await clickSlot(h,1);
 const cancel=[
  ()=>pointer(h,'pointermove',1,{clientX:70}),()=>pointer(h,'pointercancel',1),()=>pointer(h,'lostpointercapture',1),
  ()=>pointer(h,'pointerdown',2,{pointerId:8,isPrimary:false}),
  ()=>h.$('unitClose').onclick(),()=>h.client.openPanel('more'),
  ()=>{h.document.hidden=true;h.documentEvents.get('visibilitychange')();},()=>events.get('deactivated')(),
 ];
 for(const action of cancel){
  h.client.surfaces.back();h.control.select(h.ids[2]);pointer(h,'pointerdown',1);action();assert.ok(![...h.timers.values()].some(t=>t.ms===480));
  pointer(h,'pointerup',1);await clickSlot(h,1);assert.deepEqual(group(h)[0],h.ids.slice(0,2));
  h.document.hidden=false;h.documentEvents.get('visibilitychange')();events.get('activated')();
 }
 assert.equal(h.requests.filter(p=>p==='/api/army/unit-groups').length,1);
});
test('dead and expired members are skipped on recall but remain saved, and become selectable again after returning',async()=>{
 const h=await fixture(),id=h.client.state().account.id;
 await h.app.service.useAbility(id,{abilityId:'infantry',requestId:'control_group_temporary'});await h.client.refreshState(true);h.ids=[h.ids[0],h.ids[1],id+':infantry:3'];h.control.selectMany(h.ids);await clickSlot(h,2);
 const row=await h.store.get('player:'+id);row.value.army.units[1].hp=0;row.value.abilities.infantry.activeUntil=clock();await h.store.atomic({puts:[{key:'player:'+id,value:row.value}]});await h.client.refreshState(true);
 await press(h,2);assert.deepEqual(selected(h),[h.ids[0]]);assert.deepEqual(group(h)[1],h.ids);assert.equal(slots(h)[1].getAttribute('data-count'),'1/3');
 const dead=await h.store.get('player:'+id);dead.value.army.units[0].hp=0;await h.store.atomic({puts:[{key:'player:'+id,value:dead.value}]});await h.client.refreshState(true);await press(h,2);assert.deepEqual(group(h)[1],h.ids);assert.deepEqual(selected(h),[]);
 const revived=await h.store.get('player:'+id);revived.value.army.units.forEach(u=>u.hp=100);revived.value.abilities.infantry.activeUntil=clock()+30000;await h.store.atomic({puts:[{key:'player:'+id,value:revived.value}]});await h.client.refreshState(true);await press(h,2);assert.deepEqual(selected(h),[...h.ids].sort());
});
test('numeric shortcuts never cast abilities, respect text/dialog input and repeats; Alt+number retains abilities',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));await press(h,1,{ctrlKey:true});
 await press(h,3);assert.equal(h.requests.filter(p=>p==='/api/abilities/use').length,0);assert.deepEqual(selected(h),h.ids.slice(0,2).sort());
 for(const options of [{target:h.$('devName')},{isComposing:true},{target:{isContentEditable:true}}])assert.equal(await press(h,2,{ctrlKey:true,...options}),false);
 h.client.surfaces.showDialog('clanHallDialog');assert.equal(await press(h,1),false);h.client.surfaces.back();
 await press(h,1,{ctrlKey:true,repeat:true});assert.equal(h.requests.filter(p=>p==='/api/army/unit-groups').length,1);
 await press(h,2,{altKey:true});assert.equal(h.requests.filter(p=>p==='/api/abilities/use').length,1);
 assert.equal(h.$('ability-field').getAttribute('aria-keyshortcuts'),'Alt+2');
});
test('network rejection keeps previous membership; duplicate taps are guarded and logout during save cannot write into the next account',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));await clickSlot(h,1);h.control.select(h.ids[2]);h.network.failures.set('/api/army/unit-groups',1);
 await press(h,1,{ctrlKey:true});assert.deepEqual(group(h)[0],h.ids.slice(0,2));assert.equal(h.$('unitGroups').getAttribute('aria-busy'),'false');
 let release;h.network.beforeRequest=async path=>{if(path==='/api/army/unit-groups')await new Promise(resolve=>release=resolve);};
 const saving=clickSlot(h,2);await flush();assert.equal(slots(h)[1].disabled,true);await clickSlot(h,2);assert.equal(h.requests.filter(p=>p==='/api/army/unit-groups').length,2);
 await h.$('logoutBtn').onclick();release();await saving;assert.equal(h.client.state().account,null);assert.equal(h.$('unitPanel').hidden,true);assert.equal(slots(h)[0].getAttribute('data-count'),'+');
 delete h.network.beforeRequest;await h.click('openAuthModalBtn');await h.click('guestLogin');assert.equal(h.client.state().model.player,null);assert.equal(await press(h,1),false);
});
test('saved-group API enforces authentication, Origin and CSRF; group saves cannot be GET requests',async()=>{
 const h=await fixture(),path='http://127.0.0.1:4173/api/army/unit-groups';
 const call=(headers={},method='POST')=>h.app.fetch(new Request(path,{method,headers:{origin:'http://127.0.0.1:4173','content-type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify({slot:1,unitIds:h.ids})}:{})}));
 assert.ok([401,403].includes((await call()).status));const authorization='Bearer '+h.session.get('pd-session');assert.equal((await call({authorization})).status,403);assert.equal((await call({authorization,origin:'https://other.example'})).status,403);assert.equal((await call({},'GET')).status,405);
});
test('an older in-flight world snapshot cannot undo a saved group; identical compositions still recall and clear the intended slot',async()=>{
 const h=await fixture();h.control.selectMany(h.ids.slice(0,2));
 let release,captured;const ready=new Promise(resolve=>captured=resolve),original=h.app.service.state.bind(h.app.service);
 h.app.service.state=async(...args)=>{const state=await original(...args);captured();await new Promise(resolve=>release=resolve);return state;};
 const pending=h.client.refreshState(true);await ready;await clickSlot(h,1);release();await pending;h.app.service.state=original;
 assert.deepEqual(group(h)[0],h.ids.slice(0,2));assert.equal(h.client.state().model.player.unitGroupsVersion,1);
 await clickSlot(h,2);clickSlot(h,2);assert.equal(slots(h)[1].getAttribute('aria-pressed'),'true');assert.equal(slots(h)[0].getAttribute('aria-pressed'),'false');
 h.$('unitExtra').open=true;await h.click('unitForgetGroup');assert.deepEqual(group(h)[0],h.ids.slice(0,2));assert.deepEqual(group(h)[1],[]);
});
