import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell,cellToLatLng,gridDisk,gridRing,cellToParent} from 'h3-js';
import {createClientHarness} from './helpers/client-harness.mjs';
import {createTelegramShell} from '../src/client/telegram-shell.js';
import {createWorldCamera} from '../src/client/world-camera.js';
import {createMapPreview} from '../src/client/map-preview.js';
import {unitTarget,createTargetGuide} from '../src/client/unit-targets.js';
import {traversable} from '../src/shared/landscape.js';
const base=latLngToCell(41.3111,69.2797,8);
async function fixture(webApp){
 const h=await createClientHarness({webApp});await h.click('openAuthModalBtn');await h.click('guestLogin');
 await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'pack'});await h.client.refreshState(true);
 h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);h.control=await h.client.ensureUnitControls();h.id=h.client.state().model.player.army.units[0].id;return h;
}
const nav=(h,name)=>h.document.querySelectorAll('[data-open]').find(b=>b.dataset.open===name);
function surfaces(h){return [...h.document.querySelectorAll('[data-panel]'),h.$('unitPanel'),h.$('accountPanel'),h.$('tutorialOverlay')].filter(n=>!n.hidden).map(n=>n.id).concat(h.document.querySelectorAll('dialog').filter(n=>n.open).map(n=>n.id));}
function drain(h,at){for(const[id,frame]of[...h.frames]){h.frames.delete(id);frame(at);}}
test('Telegram shell disables sheet swipes once, ignores unstable resize, supports Back and activity without touching auth',()=>{
 const events=new Map(),calls=[],style=new Map();let app={initData:'launch',viewportHeight:700,viewportStableHeight:680,isVersionAtLeast:v=>v==='7.7',ready:()=>calls.push('ready'),expand:()=>calls.push('expand'),disableVerticalSwipes:()=>calls.push('disable'),BackButton:{onClick(fn){this.click=fn;},show:()=>calls.push('show'),hide:()=>calls.push('hide')},onEvent:(n,f)=>events.set(n,f)};
 const shell=createTelegramShell({getApp:()=>app,launchData:'',style:{setProperty:(k,v)=>style.set(k,v)},onViewport:()=>calls.push('resize'),onBack:()=>calls.push('back'),onActivity:a=>calls.push(a)});
 shell.setup();shell.setup();assert.deepEqual(calls,['ready','expand','disable','resize']);assert.equal(style.get('--viewport-height'),'680px');
 app.viewportStableHeight=400;events.get('viewportChanged')({isStateStable:false});assert.equal(style.get('--viewport-height'),'680px');
 events.get('viewportChanged')({isStateStable:true});assert.equal(style.get('--viewport-height'),'400px');
 shell.backVisible(true);app.BackButton.click();events.get('deactivated')();events.get('activated')();assert.ok(calls.includes('back'));assert.ok(calls.includes(false));assert.ok(calls.includes(true));
 // Old clients and delayed SDK loading keep the common game usable.
 app=undefined;shell.setup();shell.backVisible(true);app={initData:'launch',isVersionAtLeast:()=>false,disableVerticalSwipes(){throw Error('unsupported');}};assert.doesNotThrow(()=>shell.setup());
});
test('website and Telegram use three primary actions and one surface through tasks, shop, tutorial, account and squads',async t=>{
 for(const platform of ['website','telegram'])await t.test(platform,async()=>{
  let back;const h=await fixture(platform==='telegram'?{initData:'launch',BackButton:{onClick(fn){back=fn;},show(){},hide(){}}}:undefined);
  assert.equal(h.$('gameNav').children.length,3);assert.equal(h.visible('abilityBar'),false);assert.equal(h.visible('armyControls'),false);
  h.control.select(h.id);assert.deepEqual(surfaces(h),['unitPanel']);h.client.openPanel('base');assert.deepEqual(surfaces(h),['basePanel']);assert.equal(h.control.state().selected,null);
  await h.click(nav(h,'more'));await h.click(nav(h,'rewards'));assert.deepEqual(surfaces(h),['rewardsPanel']);
  await h.click(nav(h,'more'));await h.click('shopBtn');assert.deepEqual(surfaces(h),['shopDialog']);
  h.client.openPanel('more');await h.click('achievementsBtn');assert.deepEqual(surfaces(h),['achievementsDialog']);
  h.$('profileButton').onclick();assert.deepEqual(surfaces(h),['accountPanel']);
  h.$('helpBtn').onclick();assert.deepEqual(surfaces(h),['tutorialOverlay']);
  h.client.surfaces.showDialog('clanHallDialog');assert.deepEqual(surfaces(h),['clanHallDialog']);
  platform==='telegram'?back():h.client.surfaces.back();assert.deepEqual(surfaces(h),[]);assert.equal(h.client.mapSnapshot().mapPaused,false);
  // Closing the account uses the same path as every other panel.
  h.$('profileButton').onclick();const close=h.$('accountPanel').children[0].children.find(n=>n.dataset.panelClose!==undefined);await h.click(close);assert.deepEqual(surfaces(h),[]);
 });
});
test('UI taps and NPC-only polls reuse terrain; a covered map stops animation and one touch pan has bounded terrain paints',async()=>{
 const h=await fixture();h.client.draw(1000);const initial=h.client.mapSnapshot().mapPaints;
 for(const panel of ['base','more','ranking','rewards']){h.client.openPanel(panel);h.client.draw(1100);}
 assert.equal(h.client.mapSnapshot().mapPaints,initial);drain(h,1200);drain(h,1250);assert.equal(h.frames.size,0,'covered map must not run a background animation loop');
 h.client.surfaces.back();h.control.select(h.id);h.client.draw(1300);h.$('unit-move').onclick();h.client.draw(1350);assert.equal(h.client.mapSnapshot().mapPaints,initial,'selection and target highlights must not rerender textures');
 await h.client.refreshState(true);await h.client.refreshTiles(true);h.client.draw(1400);assert.equal(h.client.mapSnapshot().mapPaints,initial,'an unchanged ownership tile with fresh NPC metadata must reuse terrain');
 const c=h.$('worldCanvas');let prevented=0;const event=x=>({pointerType:'touch',pointerId:1,clientX:x,clientY:400,button:0,preventDefault(){prevented++;}});
 c.listeners.get('pointerdown')(event(500));
 for(let i=1;i<=30;i++){c.listeners.get('pointermove')(event(500+i*3));h.client.draw(1400+i*16);}
 const during=h.client.mapSnapshot().mapPaints-initial;assert.ok(during<=3,`30 touch frames triggered ${during} terrain rebuilds`);
 await c.listeners.get('pointerup')(event(590));h.client.draw(1900);assert.equal(h.client.mapSnapshot().mapPaints,initial+during+1,'release must paint a final accurate map');
 assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);assert.ok(prevented>=31);assert.equal(h.$('mapTooltip').hidden,true);
});
test('flat gesture preview preserves pan and zoom projection; globe always renders its real projection',()=>{
 const preview=createMapPreview(),options={width:800,height:600,zoom:1024,lat:41,lng:69,mode:'flat'},a=createWorldCamera(options),b=createWorldCamera({...options,lat:41.01,lng:69.03,zoom:1100}),calls=[];
 preview.commit(a,1000);assert.equal(preview.shouldPaint(b,1100,true),false);assert.equal(preview.shouldPaint(b,1200,true),true);assert.equal(preview.shouldPaint(b,1100,false),true);
 preview.draw({drawImage:(...args)=>calls.push(args)},'bitmap',b,800,600);const[,x,y,w,height]=calls[0],p=a.project(41.002,69.004),actual=b.project(41.002,69.004);
 assert.ok(Math.abs(x+p.x*w/800-actual.x)<1e-5);assert.ok(Math.abs(y+p.y*height/600-actual.y)<1e-5);
 const globe=createWorldCamera({...options,zoom:1,mode:'globe'});assert.equal(preview.shouldPaint(globe,1100,true),true);
});
test('target guidance matches basic server restrictions: frontier, own land, air, water, locks, shields, cap and base range',()=>{
 const near=gridDisk(base,1).find(c=>c!==base&&traversable(c)),far=gridRing(base,4).find(c=>traversable(c));
 const player={id:'mine',baseCell:base,level:1,faction:'pack',pixels:1,cap:100,shieldUntil:0},unit={key:'mine:infantry:0',cell:base,type:'infantry'},owners=new Map([[base,'mine']]),profiles=new Map(),tiles=new Map([[cellToParent(near,5),{locks:{}}]]),data={player,owners,profiles,tiles,now:1000};
 assert.equal(unitTarget(unit,'capture',near,data).ok,true);assert.match(unitTarget(unit,'capture',far,data).message,/рядом/);assert.equal(unitTarget(unit,'capture',base,data).ok,false);
 assert.match(unitTarget({...unit,type:'air'},'capture',near,data).message,/Авиация/);assert.equal(unitTarget(unit,'move',latLngToCell(0,-140,8),data).ok,false);
 tiles.get(cellToParent(near,5)).locks[near]=2000;assert.match(unitTarget(unit,'move',near,data).message,/заблокирован/);tiles.get(cellToParent(near,5)).locks={};
 owners.set(near,'enemy');profiles.set('enemy',{id:'enemy',baseCell:far,shieldUntil:2000});assert.match(unitTarget(unit,'attack',near,data).message,/щит/);
 profiles.get('enemy').shieldUntil=0;assert.equal(unitTarget(unit,'attack',near,data).kind,'enemy');player.shieldUntil=2000;assert.equal(unitTarget(unit,'attack',near,data).ok,false);player.shieldUntil=0;
 player.pixels=100;assert.match(unitTarget(unit,'capture',near,data).message,/Лимит/);player.pixels=1;
 const beyond=gridRing(base,260).find(c=>traversable(c));assert.match(unitTarget({...unit,cell:beyond},'move',beyond,data).message,/радиуса/);
});
test('target cursor explains invalid captures locally without any HTTP write and keeps a working valid capture path',async()=>{
 const h=await fixture(),far=gridRing(base,4).find(c=>traversable(c));h.control.select(h.id);h.$('unit-capture').onclick();h.control.hover(far);
 assert.match(h.$('unitOrderStatus').textContent,/рядом/);await h.control.click({x:0,y:0,cell:far});assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);assert.equal(h.control.state().targetMode,'capture');assert.equal(h.visible('unitCancelTarget'),true);
 const near=gridDisk(base,1).find(c=>c!==base&&traversable(c));await h.control.click({x:0,y:0,cell:near});assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,1);assert.equal(h.control.state().targetMode,null);assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order.cell,near);
 const result=await h.app.service.tiles({parents:[cellToParent(base,5)]});assert.ok(Number.isFinite(result.players.find(p=>p.id===h.client.state().account.id).shieldUntil),'tile metadata includes the public shield expiry used by the guide');
});

test('target overlay caps visible candidates and reuses polygons between animated frames',()=>{
 const guide=createTargetGuide(),unit={key:'mine:infantry:0',cell:base,type:'infantry'},player={id:'mine',baseCell:base,level:1,faction:'pack',pixels:1,cap:100},owners=new Map([[base,'mine']]);let shapes=0;
 const view={width:1000,height:700,detailed:true,revision:1,centerCell:base,footprintCell:()=>({width:30}),projectCell:()=>({x:500,y:350}),shapeCell(){shapes++;return[{x:0,y:0},{x:1,y:0},{x:0,y:1}];},targetData:{player,owners,profiles:new Map(),tiles:new Map([[cellToParent(base,5),{locks:{}}]]),now:1000}},ctx=new Proxy({},{get:()=>()=>{},set:()=>true});
 guide.draw(ctx,unit,'move',view);assert.ok(shapes>0&&shapes<=192);const first=shapes;guide.draw(ctx,unit,'move',view);assert.equal(shapes,first);view.revision++;guide.draw(ctx,unit,'move',view);assert.ok(shapes>first);
});
test('an enemy shield gives a local rejection and expiry permits a real authenticated attack order',async()=>{
 const h=await fixture(),enemyBase=gridRing(base,4).find(c=>traversable(c));await h.store.atomic({puts:[{key:'account:enemy',value:{id:'enemy',createdAt:Date.now()}}]});await h.app.service.placeBase('enemy',{cell:enemyBase,faction:'swarm'});await h.client.refreshTiles(true);
 h.control.select(h.id);h.$('unit-attack').onclick();await h.control.click({x:0,y:0,cell:enemyBase});assert.match(h.$('unitOrderStatus').textContent,/щит/);assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);
 for(const id of[h.client.state().account.id,'enemy']){const row=await h.store.get('player:'+id);await h.store.atomic({puts:[{key:'player:'+id,value:{...row.value,shieldUntil:0}}]});}
 await h.client.refreshState(true);await h.client.refreshTiles(true);await h.control.click({x:0,y:0,cell:enemyBase});assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,1);assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order.mode,'attack');assert.equal(h.control.state().targetMode,null);
});

test('a delayed shop response cannot reopen a closed window over a newer panel; loading failures remain retryable',async()=>{
 const h=await fixture();let release;h.network.beforeRequest=path=>path==='/api/shop'?new Promise(resolve=>{release=resolve;}):undefined;
 const pending=h.$('shopBtn').onclick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(surfaces(h),['shopDialog']);
 h.client.openPanel('base');release();await pending;assert.deepEqual(surfaces(h),['basePanel']);
 h.network.beforeRequest=undefined;h.network.failures=new Map([['/api/shop',1]]);await h.$('shopBtn').onclick();assert.deepEqual(surfaces(h),['shopDialog']);assert.match(h.$('shopNotice').textContent,/Повтор|повтор/);
 const retry=h.$('shopItems').children[0];assert.ok(retry.dataset.shopRetry!==undefined);await h.click('shopItems',{target:retry});assert.doesNotMatch(h.$('shopNotice').textContent,/Не удалось/);
});
test('deactivating the actual Mini App client cancels its animation and world polling until activation',async()=>{
 const events=new Map(),h=await fixture({initData:'launch',onEvent:(name,fn)=>events.set(name,fn)});h.client.draw(1000);assert.ok(h.frames.size>0);events.get('deactivated')();assert.equal(h.frames.size,0);
 const calls=h.requests.length;await h.client.pollWorld();assert.equal(h.requests.length,calls);events.get('activated')();assert.ok(h.frames.size>0);
});

test('display actions close the menu so the chosen map view and troop visibility take effect immediately',async()=>{
 const h=await fixture();for(const id of['mapGlobe','mapFlat','zoomReset','troopsToggle']){
  h.client.openPanel('more');h.$(id).closest('details').open=true;await h.click(id);assert.deepEqual(surfaces(h),[]);assert.equal(h.client.mapSnapshot().mapPaused,false);h.client.draw(2000);
  if(id==='mapGlobe')assert.equal(h.client.mapSnapshot().projection,'globe');if(id==='mapFlat')assert.equal(h.client.mapSnapshot().projection,'flat');if(id==='troopsToggle')assert.equal(h.$('troopsCanvas').hidden,true);
 }
});
