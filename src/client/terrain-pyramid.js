export const TERRAIN_PYRAMID = Object.freeze({pixels:384,maxVisible:24,maxCached:40,concurrency:2,minLevel:2,maxLevel:12});
function ranges(windows,level){
 const n=2**level,step=360/n;
 return windows.map(b=>({x0:Math.max(0,Math.floor((b.west+180)/step)),x1:Math.min(n-1,Math.floor((b.east+180-1e-9)/step)),y0:Math.max(0,Math.floor((90-b.north)/step)),y1:Math.min(n/2-1,Math.floor((90-b.south-1e-9)/step))}));
}
export function terrainPyramidTiles({size,windows}){
 const c=TERRAIN_PYRAMID;
 let level=Math.max(c.minLevel,Math.min(c.maxLevel,Math.floor(Math.log2(360*size/c.pixels))));
 let spans;
 do{spans=ranges(windows,level);if(spans.reduce((n,r)=>n+(r.x1-r.x0+1)*(r.y1-r.y0+1),0)<=c.maxVisible||level===c.minLevel)break;level--;}while(true);
 const step=360/2**level,tiles=new Map();
 for(const r of spans)for(let y=r.y0;y<=r.y1;y++)for(let x=r.x0;x<=r.x1;x++){
  const key=`p${level}-${x}-${y}`;tiles.set(key,{key,level,x,y,west:-180+x*step,east:-180+(x+1)*step,north:90-y*step,south:90-(y+1)*step,pixels:c.pixels});
 }
 return [...tiles.values()].slice(0,c.maxVisible);
}

export function createTerrainPyramid({onReady=()=>{},canvasFactory=()=>document.createElement('canvas'),workerFactory,fallbackLoader=()=>import('./terrain-raster.js')}={}){
 const entries=new Map(),workers=[];let wanted=new Set(),queue=[],enabled=false,active=0,nextId=0,disposed=false;
 function worker(){
  if(workerFactory)return workerFactory();
  if(typeof Worker==='undefined')return null;
  try{return new Worker(new URL('./terrain-worker.js'+new URL(import.meta.url).search,import.meta.url),{type:'module'});}catch{return null;}
 }
 function trim(){for(const[key,e]of entries)if(entries.size>TERRAIN_PYRAMID.maxCached&&!wanted.has(key)&&!e.loading){if(e.surface)e.surface.width=e.surface.height=1;entries.delete(key);}}
 function finish(entry,result){
  if(disposed)return;
  entry.loading=false;active--;
  if(result){const surface=canvasFactory();surface.width=result.width;surface.height=result.height;const ctx=surface.getContext('2d'),image=ctx.createImageData(result.width,result.height);image.data.set(result.data);ctx.putImageData(image,0,0);entry.surface=surface;}
  else entry.failedAt=Date.now();
  trim();onReady();pump();
 }
 async function fallback(entry){
  try{
   const module=await fallbackLoader(),iterator=module.terrainRasterRows(entry.tile);let result;
   const step=()=>{if(disposed)return;try{const deadline=performance.now()+4;do{result=iterator.next();if(result.done){finish(entry,result.value);return;}}while(performance.now()<deadline);setTimeout(step,0);}catch{finish(entry,null);}};
   step();
  }catch{finish(entry,null);}
 }
 function pump(){
  if(disposed||!enabled||globalThis.document?.hidden)return;
  while(active<TERRAIN_PYRAMID.concurrency&&queue.length){
   const key=queue.shift(),entry=entries.get(key);if(!wanted.has(key)||!entry||entry.loading||entry.surface)continue;
   entry.loading=true;active++;
   let slot=workers.find(w=>!w.busy);
   if(!slot&&workers.length<TERRAIN_PYRAMID.concurrency){const instance=worker();if(instance){slot={instance,busy:false};workers.push(slot);}}
   if(!slot){fallback(entry);continue;}
   slot.busy=true;const id=++nextId;
   slot.instance.onmessage=event=>{if(event.data.id!==id)return;slot.busy=false;finish(entry,event.data.error?null:event.data);};
   slot.instance.onerror=()=>{slot.instance.terminate();workers.splice(workers.indexOf(slot),1);fallback(entry);};
   slot.instance.postMessage({id,tile:entry.tile});
  }
 }
 function stop(){enabled=false;wanted.clear();queue=[];}
 function draw(ctx,{camera,project,drawImagePatches}){
  if(disposed)return {active:0,cached:0,queued:0};
  const windows=camera.requestView().windows,tiles=terrainPyramidTiles({size:camera.size,windows});
  wanted=new Set(tiles.map(t=>t.key));enabled=true;queue=[];
  for(const tile of tiles){let entry=entries.get(tile.key);if(!entry){entry={tile,surface:null,loading:false,failedAt:0};entries.set(tile.key,entry);}else{entries.delete(tile.key);entries.set(tile.key,entry);}if(!entry.surface&&!entry.loading&&Date.now()-entry.failedAt>10000)queue.push(tile.key);}
  const level=tiles[0]?.level??0;
  for(const entry of [...entries.values()].filter(e=>e.surface&&e.tile.level<=level).sort((a,b)=>a.tile.level-b.tile.level))drawImagePatches(ctx,entry.surface,entry.tile,project);
  trim();pump();
  return {level,visible:tiles.length,active,cached:entries.size,queued:queue.length};
 }
 return {draw,stop,stats:()=>({active,cached:entries.size,queued:queue.length}),dispose(){disposed=true;stop();active=0;for(const w of workers)w.instance.terminate();for(const e of entries.values())if(e.surface)e.surface.width=e.surface.height=1;entries.clear();}};
}
