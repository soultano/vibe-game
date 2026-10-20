import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import sharp from'sharp';
import {createTroopSprites,spriteFrame}from'../src/client/troops-sprites.js';
const manifest=JSON.parse(await readFile(new URL('../src/client/assets/troops/sprites/manifest.json',import.meta.url)));
test('all twenty portable atlases contain distinct real idle/walk/attack poses, alpha and the correct checksums',async()=>{
 let total=0;for(const[id,record]of Object.entries(manifest.models)){
  const bytes=await readFile(new URL('../src/client'+record.file,import.meta.url));total+=bytes.length;assert.equal(bytes.length,record.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256);
  const meta=await sharp(bytes).metadata();assert.equal(meta.width,manifest.tile*manifest.frames);assert.equal(meta.height,manifest.tile*manifest.clips.length);assert.ok(meta.hasAlpha);
  for(const mode of['idle','walk','attack']){const row=manifest.clips.indexOf(mode),crop=i=>sharp(bytes).extract({left:i*manifest.tile,top:row*manifest.tile,width:manifest.tile,height:manifest.tile}).raw().toBuffer();assert.notDeepEqual(await crop(0),await crop(2),id+' '+mode+' must change pixels');}
 }
 assert.equal(Object.keys(manifest.models).length,20);assert.ok(total<3200000);
});
test('fallback animation uses the live action and stops a death clip on its last frame',()=>{
 const unit={id:'pack-infantry',animation:'walk',phase:0,stateAt:10000};assert.notEqual(spriteFrame(unit,10000).column,spriteFrame(unit,10300).column);
 assert.equal(spriteFrame({...unit,animation:'idle'},10300).row,0);assert.equal(spriteFrame({...unit,animation:'death'},100000).column,7);
});
test('animated fallback advances while idle, stops offscreen, and starts at most two image downloads',()=>{
 const images=[],draws=[],imageFactory=()=>{const image={complete:false,naturalWidth:0};Object.defineProperty(image,'src',{set(src){images.push({image,src});}});return image;};
 const ctx=new Proxy({drawImage(...args){draws.push(args);}}, {get:(o,k)=>o[k]||(()=>{})}),canvas={width:0,height:0,getContext:()=>ctx};
 const renderer=createTroopSprites({imageFactory}),unit={id:'pack-infantry',key:'u',cell:'base',baseCell:'base',type:'infantry',animation:'idle',phase:0,stateAt:10000,hp:100,maxHp:100,color:'#fff',poster:'/poster.webp'};
 const view={canvas,width:800,height:600,units:[unit],serverNow:10000,projectCell:()=>({x:400,y:300}),footprintCell:()=>({width:300,height:250})};
 renderer.render(0,view);const atlas=images.find(i=>i.src.includes('/sprites/'));assert.ok(atlas);atlas.image.onload();renderer.render(40,view);const first=draws.at(-1)[1];renderer.render(600,{...view,serverNow:10600});assert.notEqual(draws.at(-1)[1],first);assert.equal(renderer.needsFrame(),true);assert.ok(renderer.stats().loads<=2);
 renderer.suspend();assert.equal(renderer.needsFrame(),false);renderer.dispose();
});
