import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';
import { createWorldCamera } from '../src/client/world-camera.js';
import { createTerrainPyramid, terrainPyramidTiles, TERRAIN_PYRAMID as limits } from '../src/client/terrain-pyramid.js';
import { renderTerrainRaster } from '../src/client/terrain-raster.js';
import { mapDetail } from '../src/shared/map-view.js';
const camera=(zoom,lat=41.31,lng=69.28,width=1280,height=800)=>createWorldCamera({width,height,zoom,lat,lng,mode:'flat'});
const tiles=c=>terrainPyramidTiles({size:c.size,windows:c.requestView().windows});

test('seven distance policies increase detail and keep exact data/materials out of the overview',()=>{
 const values=[1,8,32,128,512,1024,2048].map(mapDetail);assert.equal(new Set(values.map(p=>p.level)).size,7);
 for(const p of values.slice(0,5)){assert.equal(p.detailed,false);assert.equal(p.textures,false);assert.equal(p.props,false);assert.equal(p.pollMs,10000);}
 assert.ok(values[5].detailed&&values[6].props);
 assert.equal(values[4].unitLimit,0);assert.equal(values[5].unitLimit,12);assert.equal(values[6].unitLimit,24);assert.equal(mapDetail(4096).unitLimit,36);
 assert.ok(values.every(p=>p.propLimit<=512));
});
test('the pyramid increases its real sampling resolution instead of stretching the planet image',()=>{
 const levels=[4,8,16,32,64,128,256,512].map(z=>tiles(camera(z))[0].level);
 assert.equal(new Set(levels).size,levels.length);for(let i=1;i<levels.length;i++)assert.ok(levels[i]>levels[i-1]);
});
test('pyramid budgets reduce level rather than cut off screen coverage, including 5K and seams',()=>{
 for(const [w,h]of[[390,844],[1280,800],[5120,2880]])for(const z of[4,16,128,512])for(const [lat,lng]of[[41,69],[0,179.999],[89.99,-179.99]]){
  const c=camera(z,lat,lng,w,h),selected=tiles(c);assert.ok(selected.length<=limits.maxVisible);assert.equal(new Set(selected.map(t=>t.key)).size,selected.length);
  for(let y=1;y<h;y+=h/7)for(let x=1;x<w;x+=w/9){const p=c.atPoint(x,y);assert.ok(selected.some(t=>p.lng>=t.west-1e-9&&p.lng<=t.east+1e-9&&p.lat>=t.south-1e-9&&p.lat<=t.north+1e-9));}
 }
});
test('terrain jobs run two at a time, skip stale work, and retain a bounded LRU of finished pixels',()=>{
 const jobs=[],workers=[];
 const workerFactory=()=>{const worker={postMessage(job){jobs.push({worker,job});},terminate(){}};workers.push(worker);return worker;};
 const pyramid=createTerrainPyramid({workerFactory,canvasFactory:()=>createCanvas(1,1)}),ctx=createCanvas(1280,800).getContext('2d'),draw=c=>pyramid.draw(ctx,{camera:c,project:c.project,drawImagePatches(){}});
 draw(camera(32));assert.equal(jobs.length,2);assert.equal(pyramid.stats().active,2);pyramid.stop();for(const{worker,job}of jobs.splice(0))worker.onmessage({data:{id:job.id,width:1,height:1,data:new Uint8ClampedArray(4)}});assert.equal(jobs.length,0);assert.equal(pyramid.stats().active,0);
 for(let i=0;i<12;i++){draw(camera(128,40,i*12));while(jobs.length){const{worker,job}=jobs.shift();worker.onmessage({data:{id:job.id,width:1,height:1,data:new Uint8ClampedArray(4)}});}assert.ok(pyramid.stats().cached<=limits.maxCached);assert.ok(pyramid.stats().active<=2);}
 assert.equal(workers.length,2);pyramid.dispose();assert.equal(pyramid.stats().cached,0);
});
test('a camera change does not begin generation for the previous viewport after active jobs finish',()=>{
 const jobs=[],pyramid=createTerrainPyramid({workerFactory:()=>({postMessage(job){jobs.push({worker:this,job});},terminate(){}}),canvasFactory:()=>createCanvas(1,1)}),ctx=createCanvas(1280,800).getContext('2d');
 const draw=c=>pyramid.draw(ctx,{camera:c,project:c.project,drawImagePatches(){}});draw(camera(32));const old=jobs.splice(0),latest=camera(128,-40,-80),wanted=new Set(tiles(latest).map(t=>t.key));draw(latest);
 for(const{worker,job}of old)worker.onmessage({data:{id:job.id,width:1,height:1,data:new Uint8ClampedArray(4)}});
 assert.ok(jobs.length<=2);assert.ok(jobs.every(j=>wanted.has(j.job.tile.key)));pyramid.dispose();
});
test('the actual worker transfers the same terrain pixels as the shared pure renderer',async()=>{
 const source=await readFile(new URL('../src/client/terrain-worker.js',import.meta.url),'utf8');
 const wrapper=`import{parentPort}from'node:worker_threads';globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};${source}\nparentPort.on('message',data=>self.onmessage({data}));`;
 const output=await build({stdin:{contents:wrapper,resolveDir:new URL('../src/client',import.meta.url).pathname},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'}),worker=new Worker(output.outputFiles[0].text,{eval:true});
 try{const tile={...tiles(camera(32))[0],pixels:64},response=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.postMessage({id:7,tile});const result=await response;assert.equal(result.id,7);assert.deepEqual(result.data,renderTerrainRaster(tile).data);assert.equal(result.data.length,64*64*4);}finally{await worker.terminate();}
});
test('averaged cartographic colors suppress high frequency terrain noise and remain deterministic',()=>{
 const tile={west:68,east:72,south:39,north:43,pixels:384},a=renderTerrainRaster(tile),b=renderTerrainRaster(tile);assert.deepEqual(a.data,b.data);
 let jump=0,count=0;for(let y=0;y<a.height;y++)for(let x=1;x<a.width;x++){const i=(y*a.width+x)*4;jump+=Math.abs(a.data[i]-a.data[i-4])+Math.abs(a.data[i+1]-a.data[i-3])+Math.abs(a.data[i+2]-a.data[i-2]);count+=3;}
 assert.ok(jump/count<5,`avoid the previous high contrast per-pixel biome noise: ${jump/count}`);
});
test('the no-Worker path completes pixels without starting a model or an image request',async()=>{
 let ready;const done=new Promise(resolve=>ready=resolve),pyramid=createTerrainPyramid({workerFactory:()=>null,canvasFactory:()=>createCanvas(1,1),onReady:()=>ready()}),c=camera(16),ctx=createCanvas(1280,800).getContext('2d');
 pyramid.draw(ctx,{camera:c,project:c.project,drawImagePatches(){}});await done;pyramid.stop();assert.ok(pyramid.stats().cached>0);assert.ok(pyramid.stats().active<=2);pyramid.dispose();
});
