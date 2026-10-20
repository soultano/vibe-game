import test from'node:test';import assert from'node:assert/strict';
import{latLngToCell,cellToLatLng,gridDisk,gridRing}from'h3-js';
import{createClientHarness}from'./helpers/client-harness.mjs';
import{layoutTroops}from'../src/client/actor-layout.js';import{hitUnit,orderRoute,drawUnitOrder}from'../src/client/unit-controls.js';
import{traversable}from'../src/shared/landscape.js';
const base=latLngToCell(41.3111,69.2797,8),near=gridDisk(base,1).filter(c=>c!==base&&traversable(c));
async function fixture(){const h=await createClientHarness();await h.$('devLogin').onclick();await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'pack'});await h.client.refreshState(true);h.client.focusAt(...cellToLatLng(base),2048);await h.client.refreshTiles(true);const control=await h.client.ensureUnitControls();return{...h,control,id:h.client.state().model.player.army.units[0].id};}
const event=(point,id=1)=>({pointerId:id,clientX:point.x,clientY:point.y,button:0});
async function clickCell(h,cell,id=1){const canvas=h.$('worldCanvas'),point=h.client.unitCommandView().projectCell(cell);canvas.listeners.get('pointerdown')(event(point,id));await canvas.listeners.get('pointerup')(event(point,id));}
async function settleBusy(h){for(let i=0;i<50&&h.control.state().busy;i++)await new Promise(r=>setImmediate(r));assert.equal(h.control.state().busy,false);}
test('clicking a rendered own squad selects its actual id; roster persists selection through fresh snapshots',async()=>{
 const h=await fixture(),view=h.client.unitCommandView(),pose=layoutTroops(view.units,view)[0],point={x:pose.x,y:pose.y-pose.span*.36-pose.elevation*.8},canvas=h.$('worldCanvas');
 canvas.listeners.get('pointerdown')(event(point));await canvas.listeners.get('pointerup')(event(point));assert.equal(h.control.state().selected,pose.unit.key);assert.equal(h.$('unitPanel').hidden,false);assert.equal(h.$('armyControls').hidden,true);assert.match(h.$('unitHp').textContent,/HP/);
 await h.client.refreshState(true);assert.equal(h.control.state().selected,pose.unit.key);assert.ok(h.document.querySelectorAll('[data-unit-id]').find(b=>b.dataset.unitId===pose.unit.key).getAttribute('aria-pressed')==='true');
});
test('roster → Move → map hex sends a real authenticated squad order and renders its server route',async()=>{
 const h=await fixture();await h.$('armySquads').onclick();const button=h.document.querySelectorAll('[data-unit-id]').find(b=>b.dataset.unitId===h.id);h.$('unitRoster').onclick({target:button});h.$('unit-move').onclick();assert.equal(h.control.state().targetMode,'move');
 await clickCell(h,near[0]);const unit=h.client.state().model.player.army.units.find(u=>u.id===h.id);assert.equal(unit.order.mode,'move');assert.equal(unit.order.cell,near[0]);assert.equal(h.control.state().targetMode,null);assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,1);
 assert.match(h.$('unitRouteInfo').textContent,/Идти/);h.client.draw(500);assert.ok(h.contexts.some(c=>c.calls.get('setLineDash')>0));assert.ok(h.client.state().model.player.army.units.filter(u=>u.id!==h.id).every(u=>!u.order));
});
test('right click, physical hotkeys, cancel, stop and auto act on only the selected squad',async()=>{
 const h=await fixture();h.control.select(h.id);const canvas=h.$('worldCanvas'),point=h.client.unitCommandView().projectCell(near[0]);let prevented=false;
 await canvas.listeners.get('contextmenu')({clientX:point.x,clientY:point.y,preventDefault(){prevented=true;}});assert.ok(prevented);assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order.mode,'move');
 const key=e=>h.windowEvents.get('keydown')({repeat:false,target:h.$('worldCanvas'),preventDefault(){},...e});key({key:'ф',code:'KeyA'});assert.equal(h.control.state().targetMode,'attack');key({key:'Escape'});assert.equal(h.control.state().targetMode,null);assert.equal(h.control.state().selected,h.id);
 await h.$('unit-hold').onclick();assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order.mode,'hold');await h.$('unit-auto').onclick();assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order,undefined);
});
test('drag and pinch never issue an armed command; rejected capture preserves the target cursor',async()=>{
 const h=await fixture();h.control.select(h.id);h.$('unit-move').onclick();const c=h.$('worldCanvas'),down=c.listeners.get('pointerdown'),move=c.listeners.get('pointermove'),up=c.listeners.get('pointerup');
 down(event({x:500,y:400}));move(event({x:560,y:400}));await up(event({x:560,y:400}));assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);assert.equal(h.control.state().targetMode,'move');
 down(event({x:500,y:400},2));down(event({x:650,y:400},3));move(event({x:720,y:400},3));await up(event({x:500,y:400},2));await up(event({x:720,y:400},3));assert.equal(h.requests.filter(p=>p==='/api/army/unit-order').length,0);
 h.$('unit-capture').onclick();const far=gridRing(base,4).find(c=>traversable(c));await h.control.click({x:0,y:0,cell:far});assert.equal(h.control.state().targetMode,'capture');assert.match(h.$('toast').textContent,/рядом/);assert.equal(h.client.state().model.player.army.units.find(u=>u.id===h.id).order,undefined);
});
test('air capture is disabled including keyboard; logout clears selection and targeted mode',async()=>{
 const h=await fixture(),id=h.client.state().account.id;await h.app.service.useAbility(id,{abilityId:'heavy',requestId:'unit_controls_air_cast'});await h.client.refreshState(true);h.control.select(id+':air:0');assert.equal(h.$('unit-capture').disabled,true);h.control.key({key:'c',code:'KeyC'});assert.equal(h.control.state().targetMode,null);assert.match(h.$('toast').textContent,/Авиация/);
 await h.$('logoutBtn').onclick();assert.equal(h.control.state().selected,null);assert.equal(h.$('unitPanel').hidden,true);
});
test('squad roster works in global overview while models remain unloaded',async()=>{
 const h=await fixture();h.client.changeZoom(1);await h.client.refreshTiles(true);await h.$('armySquads').onclick();assert.ok(h.document.querySelectorAll('[data-unit-id]').length>=3);assert.equal(h.client.mapSnapshot().mapKind,'overview');assert.ok(!h.requests.some(p=>/\.glb/.test(p)));h.control.select(h.id);h.$('unit-focus').onclick();assert.ok(h.client.mapSnapshot().zoom>=2048);
});
test('hit tests do not select enemy or neutral squads; route contains actual waypoints and an independent goal',()=>{
 const poses=[{x:100,y:200,span:70,elevation:0,unit:{key:'mine',owner:'a'}},{x:300,y:200,span:70,elevation:0,unit:{key:'enemy',owner:'b'}},{x:500,y:200,span:70,elevation:0,unit:{key:'wild',owner:'a',neutral:true}}];
 assert.equal(hitUnit(poses,100,175,'a').key,'mine');assert.equal(hitUnit(poses,300,175,'a'),null);assert.equal(hitUnit(poses,500,175,'a'),null);assert.equal(hitUnit(poses,300,175).key,'enemy');
 const unit={cell:'to',fromCell:'from',progress:.5,waypoints:['step'],order:{mode:'move',cell:'goal'},routePartial:true},project=c=>({x:{from:0,to:100,step:180,goal:500}[c],y:100}),route=orderRoute(unit,project);assert.deepEqual(route.points.map(p=>p.x),[50,100,180]);assert.equal(route.goal.x,500);assert.equal(route.partial,true);
 const lines=[],ctx=new Proxy({measureText:()=>({width:30}),moveTo:(x,y)=>lines.push([x,y]),lineTo:(x,y)=>lines.push([x,y])},{get:(o,k)=>o[k]||(()=>{}),set:(o,k,v)=>(o[k]=v,true)});drawUnitOrder(ctx,unit,{projectCell:project});assert.ok(lines.some(p=>p[0]===180));assert.ok(!lines.some(p=>p[0]===500&&p[1]===100),'uncomputed continuation is never drawn as a straight traversable route');
});
test('unit order HTTP endpoint requires an authenticated write context',async()=>{
 const h=await createClientHarness(),r=await h.app.fetch(new Request('http://127.0.0.1:4173/api/army/unit-order',{method:'POST',headers:{origin:'http://127.0.0.1:4173','content-type':'application/json'},body:JSON.stringify({unitId:'a:infantry:0',mode:'hold'})}));assert.ok([401,403].includes(r.status));
});
