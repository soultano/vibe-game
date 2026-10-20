import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{NodeIO}from'@gltf-transform/core';
import{validateBytes}from'gltf-validator';
import{latLngToCell,gridDisk}from'h3-js';
import{TROOP_CLASSES,TROOP_ANIMATIONS,troopFor,troopForAbility,troopDeployment}from'../src/shared/troops.js';
import{createBattlefieldState}from'../src/client/battlefield-state.js';
import{animatedGeometry}from'../scripts/lib/gltf-pose.mjs';
import{createClientHarness}from'./helpers/client-harness.mjs';
const now=1900000000000,base=latLngToCell(41.31,69.28,8),neighbors=gridDisk(base,1).filter(c=>c!==base);
const player={id:'owner',faction:'protocol',baseCell:base,frontier:[base],abilities:{},azimuth:90};

test('twenty distinct faction units use the stable ability IDs and canonical animation set',()=>{
 const ids=new Set();for(const faction of ['protocol','vanguard','bloom','swarm','pack'])for(const role of TROOP_CLASSES){const unit=troopFor(faction,role.id);ids.add(unit.id);assert.equal(troopForAbility(faction,role.abilityId).id,unit.id);assert.match(unit.model,new RegExp(unit.id+'.glb\\?v=living-v2$'));}
 assert.equal(ids.size,20);assert.equal(troopFor('unknown','invalid').id,'protocol-infantry');assert.deepEqual(TROOP_ANIMATIONS,['idle','walk','run','attack','capture','death']);
});
test('deployment derives from server effect intervals; no future or expired heavy/air/ultimate spawns',()=>{
 assert.deepEqual(troopDeployment(player,now),[{type:'infantry',count:3,activeUntil:null}]);
 const p={...player,abilities:{field:{activeFrom:now-1,activeUntil:now+1},heavy:{activeFrom:now+1,activeUntil:now+1000},ultimate:{activeFrom:now-1000,activeUntil:now}}};
 assert.deepEqual(troopDeployment(p,now).map(x=>x.type),['infantry','armor']);assert.deepEqual(troopDeployment(null,now),[]);
});
test('server NPC adapter follows timed waypoints, keeps idle soldiers still and freezes stale snapshots',()=>{
 const state=createBattlefieldState();const units=[{id:'a:0',owner:'owner',faction:'pack',type:'infantry',cell:base,hp:100,maxHp:100,state:'move',move:{from:base,to:neighbors[0],startedAt:now,endsAt:now+4000}}];
 state.sync({player:{...player,army:{at:now,units}}},now);
 const moving=state.units(now+2000)[0];assert.equal(moving.animation,'walk');assert.equal(moving.fromCell,base);assert.equal(moving.cell,neighbors[0]);assert.equal(moving.progress,.5);
 assert.equal(state.units(now+10001)[0].animation,'idle');
 units[0]={...units[0],state:'idle',move:undefined};state.sync({player:{...player,army:{at:now,units}}},now);
 assert.deepEqual(state.units(now+1000),state.units(now+2000),'stationary soldiers cannot orbit the anchor');
 assert.equal(state.capture({cell:neighbors[0],fromCell:base,owner:'owner',at:now},now),false,'ownership deltas cannot fabricate a second unit');
 state.clear();assert.equal(state.units(now).length,0);
});
test('server NPC adapter renders without an account, bounds the budget and prioritizes owned armies',()=>{
 const make=(id,n)=>({...player,id,army:{at:now,units:Array.from({length:n},(_,i)=>({id:id+':'+i,owner:id,faction:'pack',type:'infantry',cell:base,hp:100,maxHp:100,state:'idle'}))}});
 const state=createBattlefieldState({maxUnits:12}),own=make('owner',3),other=make('other',15);
 state.sync({player:own,players:[other]},now);assert.equal(state.units(now).length,12);assert.equal(state.units(now)[0].owner,'owner');
 state.sync({players:[other]},now);assert.equal(state.units(now).length,12);
});
test('arsenal exposes every approved class and faction without WebGL and does not alter account or army',async()=>{
 const h=await createClientHarness();await h.$('troopsBtn').onclick();assert.equal(h.$('troopsDialog').open,true);
 for(const faction of ['protocol','vanguard','bloom','swarm','pack']){
  const side=h.document.querySelectorAll('[data-troop-faction]').find(n=>n.dataset.troopFaction===faction);await h.$('troopFactionPicker').onclick({target:side});
  for(const role of TROOP_CLASSES){const button=h.document.querySelectorAll('[data-troop-role]').find(n=>n.dataset.troopRole===role.id);await h.$('troopRolePicker').onclick({target:button});assert.equal(h.$('troopTitle').textContent,troopFor(faction,role.id).name);assert.equal(h.$('troopPoster').hidden,false);assert.equal(h.$('troopModelCanvas').hidden,true);assert.equal(h.$('troopAnimations').hidden,true);}
 }
 assert.equal(h.client.state().account,null);h.$('troopsToggle').onclick();assert.equal(h.$('troopsToggle').getAttribute('aria-pressed'),'false');
});

test('all twenty GLBs have real skeletons, moving weighted vertices, portable clips and valid topology',async t=>{
 const manifest=JSON.parse(await readFile(new URL('../src/client/assets/troops/manifest.json',import.meta.url))),io=new NodeIO();let bytes=0,credits=0;
 assert.equal(Object.keys(manifest.models).length,20);
 for(const[id,record]of Object.entries(manifest.models))await t.test(id,async()=>{
  const data=await readFile(new URL('../src/client'+record.file,import.meta.url)),report=await validateBytes(new Uint8Array(data));
  assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages.filter(m=>m.severity===0).slice(0,3)));
  assert.equal(report.issues.numWarnings,0,JSON.stringify(report.issues.messages.filter(m=>m.severity===1).slice(0,3)));
  assert.equal(createHash('sha256').update(data).digest('hex'),record.sha256);assert.equal(data.length,record.bytes);
  const doc=await io.readBinary(data),animations=doc.getRoot().listAnimations();
  assert.deepEqual(animations.map(a=>a.getName()).sort(),[...TROOP_ANIMATIONS].sort());
  assert.ok(doc.getRoot().listSkins().length);assert.ok(record.joints>=5);assert.ok(record.triangles<6500);
  for(const mesh of doc.getRoot().listMeshes())for(const primitive of mesh.listPrimitives()){
   const weights=primitive.getAttribute('WEIGHTS_0');if(!weights)continue;
   const values=weights.getArray();for(let i=0;i<values.length;i+=4)assert.ok(Math.abs(values[i]+values[i+1]+values[i+2]+values[i+3]-1)<1e-5,'normalized skin weights');
  }
  for(const name of ['idle','walk','attack','capture']){
   const duration=record.animations.find(a=>a.name===name).duration,a=animatedGeometry(doc,name,0)[0].positions,b=animatedGeometry(doc,name,duration*.25)[0].positions;
   let displacement=0;for(let i=0;i<a.length;i++)displacement=Math.max(displacement,Math.abs(a[i]-b[i]));
   assert.ok(displacement>.001,`${id} ${name} must move actual weighted vertices`);
  }
  if(!id.endsWith('-air')&&id!=='protocol-ultimate'){
   const duration=record.animations.find(a=>a.name==='walk').duration;
   for(const time of [0,duration*.25,duration*.5]){let min=Infinity;for(const p of animatedGeometry(doc,'walk',time))for(let i=1;i<p.positions.length;i+=3)min=Math.min(min,p.positions[i]);assert.ok(Math.abs(min)<.002,`${id} feet stay on ground (${min})`);}
  }
  bytes+=data.length;credits+=record.consumedCredits;
 });
 assert.equal(credits,332);assert.ok(bytes<16000000,`twenty-model download budget: ${bytes}`);
});
