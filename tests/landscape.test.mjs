import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import sharp from'sharp';import{latLngToCell,gridDisk}from'h3-js';import{landscape,traversable}from'../src/shared/landscape.js';
const base=latLngToCell(41.31,69.28,8);
test('one deterministic landscape field defines ground passability, cover and speed for client and server',()=>{
 const types=new Set();for(const c of gridDisk(base,35)){const a=landscape(c);assert.deepEqual(a,landscape(c));types.add(a.type);assert.ok(a.speed>0&&a.speed<=1);assert.ok(a.cover>=0&&a.cover<1);assert.ok(Number.isInteger(a.elevation));if(a.water){assert.equal(traversable(c),false);assert.equal(traversable(c,'air'),true);}}
 assert.ok(types.has('forest'));assert.ok(types.has('mountain'));assert.ok(types.has('water'));assert.ok(types.has('grass'));
});
test('all twelve fantasy assets match their manifest, remain within 600 KB and preserve prop transparency',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../src/client/assets/terrain/manifest.json',import.meta.url)));assert.equal(manifest.assets.length,12);let bytes=0;
 for(const asset of manifest.assets){const data=await readFile(new URL('../src/client/assets/terrain/'+asset.file,import.meta.url));assert.equal(createHash('sha256').update(data).digest('hex'),asset.sha256);assert.equal(data.length,asset.bytes);bytes+=data.length;const meta=await sharp(data).metadata();assert.equal(meta.format,'webp');if(['pine','oak','peak','crag','boulders','mushrooms'].some(p=>asset.file===p+'.webp')){assert.equal(meta.hasAlpha,true);const stats=await sharp(data).stats();assert.equal(stats.channels[3].min,0);assert.equal(stats.channels[3].max,255);}}
 assert.ok(bytes<600000);
});
