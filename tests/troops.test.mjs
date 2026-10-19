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
 const ids=new Set();for(const faction of ['protocol','vanguard','bloom','swarm','pack'])for(const role of TROOP_CLASSES){const unit=troopFor(faction,role.id);ids.add(unit.id);assert.equal(troopForAbility(faction,role.abilityId).id,unit.id);assert.match(unit.model,new RegExp(unit.id+'.glb$'));}
 assert.equal(ids.size,20);assert.equal(troopFor('unknown','invalid').id,'protocol-infantry');assert.deepEqual(TROOP_ANIMATIONS,['idle','walk','run','attack','capture','death']);
});
test('deployment derives from server effect intervals; no future or expired heavy/air/ultimate spawns',()=>{
 assert.deepEqual(troopDeployment(player,now),[{type:'infantry',count:3,activeUntil:null}]);
 const p={...player,abilities:{field:{activeFrom:now-1,activeUntil:now+1},heavy:{activeFrom:now+1,activeUntil:now+1000},ultimate:{activeFrom:now-1000,activeUntil:now}}};
 assert.deepEqual(troopDeployment(p,now).map(x=>x.type),['infantry','armor']);assert.deepEqual(troopDeployment(null,now),[]);
});
test('visual troops fire only at active confirmed server contacts and freeze after connection staleness',()=>{
 const state=createBattlefieldState(),other={...player,id:'enemy',faction:'pack',baseCell:neighbors[0]};
 const front={aId:'owner',bId:'enemy',aCell:base,bCell:neighbors[0]};
 state.sync({player,players:[other],conflicts:[{status:'shielded',fronts:[front]}]},now);
 assert.ok(state.units(now).every(x=>x.animation!=='attack'));
 state.sync({player,players:[other],conflicts:[{status:'active',fronts:[front]}]},now);
 assert.ok(state.units(now).every(x=>x.animation==='attack'&&x.target));
 assert.ok(state.units(now+15001).every(x=>x.animation==='idle'&&!x.target));
});
test('captures require fresh confirmed ownership deltas, deduplicate and travel from an owned neighbor',()=>{
 const state=createBattlefieldState();state.sync({player,players:[],conflicts:[]},now);
 const change={cell:neighbors[0],fromCell:base,owner:'owner',at:now,version:1};
 assert.equal(state.capture({...change,at:now-16000},now),false);
 assert.equal(state.capture({...change,fromCell:change.cell},now),false);
 assert.equal(state.capture(change,now),true);assert.equal(state.capture(change,now),false);
 const moving=state.units(now+1000).find(x=>x.key.startsWith('capture:'));
 assert.equal(moving.animation,'walk');assert.equal(moving.fromCell,base);assert.ok(moving.progress>0&&moving.progress<1);
 assert.equal(state.units(now+2600).find(x=>x.key.startsWith('capture:')).animation,'capture');
 assert.equal(state.units(now+5000).some(x=>x.key.startsWith('capture:')),false);
 state.clear();assert.equal(state.units(now).length,0);
});
test('the visible unit budget remains bounded and own squads have priority',()=>{
 const state=createBattlefieldState({maxUnits:12}),players=Array.from({length:40},(_,i)=>({...player,id:'enemy-'+i}));
 state.sync({player,players},now);const units=state.units(now);assert.equal(units.length,12);assert.equal(units[0].owner,player.id);
 assert.deepEqual(state.units(now).map(u=>u.key),units.map(u=>u.key));
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
  for(const name of ['walk','attack','capture']){
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
