import test from 'node:test';import assert from 'node:assert/strict';
import {latLngToCell,cellToBoundary,cellToLatLng} from 'h3-js';
import {footprintBounds,headquartersLayout,troopSpan,layoutTroops} from '../src/client/actor-layout.js';
import {createWorldCamera} from '../src/client/world-camera.js';
import {createBattlefieldState} from '../src/client/battlefield-state.js';
const cell=latLngToCell(41.31,69.28,8),at=1900000000000;
test('the opaque HQ silhouette fills one actual hex at every tactical zoom, excluding transparent margins',()=>{
 for(const zoom of[768,1536,3072,8192]){const camera=createWorldCamera({width:1280,height:800,zoom,lat:41.31,lng:69.28,mode:'flat'}),footprint=footprintBounds(camera.project.shape(cellToBoundary(cell))),center=camera.project(...cellToLatLng(cell));
  for(const crop of[{x:80,y:60,width:320,height:390},{x:10,y:80,width:490,height:270}]){const result=headquartersLayout(center,footprint,crop);assert.equal(result.width,footprint.width);assert.ok(Math.abs(result.height/result.width-crop.height/crop.width)<1e-12);assert.ok(Math.abs(result.left+result.width/2-center.x)<1e-9);}
 }
});
test('infantry, heavy, air and ultimate silhouettes are readable and scale with real cells',()=>{
 const viewport={width:1536,height:930},types=['infantry','armor','air','ultimate'];for(const type of types){const small=troopSpan(type,{width:40},viewport),large=troopSpan(type,{width:600},viewport);assert.ok(small>=48);assert.ok(large>small);assert.ok(large<=930*.46);}
 assert.ok(troopSpan('ultimate',{width:300},viewport)>troopSpan('infantry',{width:300},viewport));
});
test('HQ guards occupy distinct fixed formation slots, and moving units interpolate between real cells',()=>{
 const units=Array.from({length:3},(_,i)=>({key:'u'+i,cell:'base',baseCell:'base',type:'infantry',progress:1})),view={width:1280,height:800,projectCell:c=>({x:c==='next'?800:640,y:400}),footprintCell:()=>({width:300,height:260})};
 const first=layoutTroops(units,view),second=layoutTroops(units,view);assert.deepEqual(first,second);assert.equal(new Set(first.map(p=>p.x+':'+p.y)).size,3);assert.ok(first.every(p=>p.span>=90));
 const u={...units[0],cell:'next',fromCell:'base',progress:.25},pose=layoutTroops([u],view)[0];assert.ok(pose.x>640&&pose.x<800);assert.equal(pose.progress,.25);
});
test('newer tile army snapshots cannot be overwritten by an older own-state response',()=>{
 const unit={id:'u',owner:'p',faction:'pack',type:'infantry',cell,hp:100,maxHp:100,state:'idle'},old={id:'p',baseCell:cell,army:{at,units:[unit]}},latest={...old,army:{at:at+2000,units:[{...unit,state:'capture'}]}};
 const state=createBattlefieldState();state.sync({player:old,players:[latest]},at+2000);assert.equal(state.units(at+2500)[0].state,'capture');assert.equal(state.units(at+2500)[0].animation,'idle');
});
test('finished waypoints stop foot skating but retain the authoritative destination',()=>{
 const state=createBattlefieldState(),move={from:cell,to:cell,startedAt:at,endsAt:at+1000};state.sync({player:{id:'p',baseCell:cell,army:{at,units:[{id:'u',owner:'p',faction:'pack',type:'infantry',cell,hp:100,maxHp:100,state:'move',move}]}}},at);
 assert.equal(state.units(at+500)[0].animation,'walk');const ended=state.units(at+1500)[0];assert.equal(ended.animation,'idle');assert.equal(ended.progress,1);assert.equal(ended.cell,cell);
});
test('a partial own tile snapshot preserves offscreen squad selection and the full roster',()=>{
 const unit=id=>({id,owner:'p',faction:'pack',type:'infantry',cell,hp:100,maxHp:100,state:'idle'}),full={id:'p',baseCell:cell,army:{at,units:[unit('one'),unit('two')]}},partial={id:'p',baseCell:cell,army:{at:at+500,units:[{...unit('one'),state:'capture'}]}},state=createBattlefieldState();
 state.select('two');state.sync({player:full,players:[partial]},at+500);assert.equal(state.units(at+600).length,2);assert.equal(state.units(at+600)[0].key,'two');assert.equal(state.units(at+600).find(u=>u.key==='one').state,'capture');assert.equal(state.units(at+600).find(u=>u.key==='one').animation,'idle');
 const removed={...full,army:{at:at+1000,units:[unit('one')]}};state.sync({player:removed,players:[partial]},at+1000);assert.equal(state.units(at+1100).length,1);
});
test('a unit leaving the viewport remains visible while its actual starting cell is still on screen',()=>{
 const next=latLngToCell(41.32,69.28,8),state=createBattlefieldState();state.sync({player:{id:'p',baseCell:cell,army:{at,units:[{id:'u',owner:'p',faction:'pack',type:'infantry',cell,hp:100,maxHp:100,state:'move',move:{from:cell,to:next,startedAt:at,endsAt:at+2000}}]}}},at);
 assert.equal(state.units(at+500,c=>c===cell).length,1);
});
