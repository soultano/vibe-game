import { latLngToCell, cellToLatLng, cellToBoundary, gridDisk, gridDistance } from 'h3-js';
import { mapDetail, MAP_LIMITS } from '../shared/map-view.js';
import { landscape } from '../shared/landscape.js';
import { createGlobeRenderer } from './globe-renderer.js';
import { createTerrainPyramid } from './terrain-pyramid.js';
import { BIOMES } from '../shared/biomes.js';
import { biomePattern, drawBiomeProp } from './biome-renderer.js';
const textures={mountain:'rock',grass:'grass',forest:'forest',rock:'rock',sand:'sand',water:'water',jungle:'forest',savanna:'grass',tundra:'grass'};
export function terrainLift(cell,zoom){return Math.min(20,Math.max(0,zoom/100)*landscape(cell).elevation*.34);}
export function createLandscapeRenderer({onReady=()=>{},imageFactory=()=>new Image(),assets=null,canvasFactory,workerFactory,fallbackLoader}={}){
 const images=new Map(),patterns=new WeakMap();let key='',cells=[];
 let globeView,pyramid;
 function drawImagePatches(ctx,image,bounds,project){
  if(project.rasterPatches){for(const p of project.rasterPatches(bounds)){const pad=bounds.key?.startsWith('p') ? .5 : 0;ctx.save();ctx.translate(p.x,p.y+(p.flipY?p.height:0));ctx.scale(1,p.flipY?-1:1);ctx.drawImage(image,-pad,-pad,p.width+pad*2,p.height+pad*2);ctx.restore();}}
  else{const a=project(bounds.north,bounds.west),b=project(bounds.south,bounds.east);ctx.drawImage(image,a.x,a.y,b.x-a.x,b.y-a.y);}
 }
 function getImage(name){
  if(images.has(name))return images.get(name);
  if(assets?.has(name)){images.set(name,assets.get(name));return assets.get(name);}
  const image=imageFactory();images.set(name,image);image.onload=onReady;image.src='/assets/terrain/'+name+'.webp'+(name==='world-overview'?'?v=climate3':'');return image;
 }
 function drawRaster(ctx,project,width,height,atPoint,zoom){
  const world=getImage('world-overview');ctx.save();ctx.imageSmoothingEnabled=true;
  if(world?.complete&&world.naturalWidth)drawImagePatches(ctx,world,{north:90,south:-90,west:-180,east:180},project);
  ctx.restore();
 }
 function pattern(ctx,name){let values=patterns.get(ctx);if(!values){values=new Map();patterns.set(ctx,values);}if(['snow','ice','desert','redDesert','coldDesert'].includes(name)){if(!values.has(name))values.set(name,biomePattern(ctx,name,canvasFactory));return values.get(name);}const image=getImage(name);if(!image?.complete||!image.naturalWidth)return null;if(!values.has(name))values.set(name,ctx.createPattern(image,'repeat'));return values.get(name);}
 function draw(ctx,{width,height,zoom,project,atPoint,baseCells=[],roads=[],camera,moving=false,fallback}){
  if(camera?.globe){cells=[];key='';pyramid?.stop();globeView||=createGlobeRenderer({canvasFactory});globeView.draw(ctx,camera,{image:getImage('world-overview'),fallback,moving});return;}
  if(zoom<768){cells=[];key='';drawRaster(ctx,project,width,height,atPoint,zoom);if(camera&&zoom>=4){pyramid||=createTerrainPyramid({onReady,canvasFactory,workerFactory,fallbackLoader});pyramid.draw(ctx,{camera,project,drawImagePatches});}else pyramid?.stop();return;}
  pyramid?.stop();
  const policy=mapDetail(zoom);let res=policy.terrainResolution;
  const center=atPoint(width/2,height/2);let cell,radius;
  // Choose a coarser field instead of truncating coverage on wide viewports.
  do{cell=latLngToCell(center.lat,center.lng,res);radius=2;
    for(const [px,py]of[[0,0],[width,0],[width,height],[0,height]]){const q=atPoint(px,py);try{radius=Math.max(radius,gridDistance(cell,latLngToCell(q.lat,q.lng,res))+2);}catch{radius=40;}}
    if(1+3*radius*(radius+1)<=MAP_LIMITS.terrainCells||res===0)break;res--;
  }while(true);
  const nextKey=`${cell}:${res}:${radius}`;
  if(key!==nextKey){key=nextKey;cells=gridDisk(cell,radius).map(index=>{const [lat,lng]=cellToLatLng(index),sample=res===8?index:latLngToCell(lat,lng,8);return{index,sample,lat,lng,shape:cellToBoundary(index),data:landscape(sample)};}).sort((a,b)=>b.lat-a.lat||a.lng-b.lng);}
  const bases=new Set([...baseCells,...roads]),props=[];
  ctx.save();ctx.imageSmoothingEnabled=true;
  for(const tile of cells){
   const p=project(tile.lat,tile.lng),points=project.shape?project.shape(tile.shape):tile.shape.map(([lat,lng])=>project(lat,lng)),span=Math.max(...points.map(v=>v.x))-Math.min(...points.map(v=>v.x)),data=tile.data;
   if(p.x< -span||p.y< -span*3||p.x>width+span||p.y>height+span*3)continue;
   const lift=0;
   function path(dy=0){ctx.beginPath();points.forEach((v,i)=>i?ctx.lineTo(v.x,v.y+dy):ctx.moveTo(v.x,v.y+dy));ctx.closePath();}
   if(lift>0){path();ctx.fillStyle='#263a31';ctx.fill();}
   path(-lift);ctx.fillStyle=BIOMES[data.type].color;ctx.fill();
   const fill=policy.textures?pattern(ctx,textures[data.type]||data.type):null;
   if(fill){ctx.save();path(-lift);ctx.clip();ctx.globalAlpha=['tundra','savanna','jungle'].includes(data.type)?.26:.68;ctx.fillStyle=fill;ctx.fillRect(p.x-span,p.y-span-lift,span*2,span*2);ctx.restore();}
   // A soft edge ties different materials together without an opaque hex grid.
   // Shade slopes while keeping contiguous ground surfaces free of hex cracks.
   if(zoom>=48&&!data.water&&data.elevation>1){ctx.save();path();ctx.clip();const shade=ctx.createLinearGradient(p.x-span/2,p.y-span/2,p.x+span/2,p.y+span/2);shade.addColorStop(0,'#e4d79d18');shade.addColorStop(1,'#10291c24');ctx.fillStyle=shade;ctx.fillRect(p.x-span,p.y-span,span*2,span*2);ctx.restore();}
   if(bases.has(tile.sample)&&!data.water){ctx.save();path();ctx.clip();ctx.globalAlpha=.35;ctx.fillStyle=pattern(ctx,'dirt')||'#9c8551';ctx.beginPath();ctx.ellipse(p.x,p.y,span*.38,span*.28,0,0,Math.PI*2);ctx.fill();ctx.restore();}
   if(data.water&&zoom>=128){
    const shore=tile.shape.map(([lat,lng])=>landscape(latLngToCell(lat,lng,8))).some(d=>!d.water);
    if(shore){path(-lift);ctx.strokeStyle='#b5d09c82';ctx.lineWidth=Math.min(4,span*.12);ctx.stroke();}
    if(span>15){ctx.strokeStyle='#b3e2dc35';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(p.x,p.y,span*.23,span*.06,0,0,Math.PI*1.5);ctx.stroke();}
   }
   if(policy.props&&span>10&&!data.water&&!bases.has(tile.sample)){
    const kind=data.type==='snow'||data.type==='ice'?(data.detail>.8?'iceberg':null):data.climate==='desert'?(data.type==='rock'?'desert-rock':data.detail>.55?'dune':null):data.type==='jungle'?(data.detail>.4?'palm':'oak'):data.type==='savanna'?(data.detail>.8?'acacia':null):data.type==='tundra'?(data.detail>.85?'frost-rock':null):data.type==='forest'?(data.detail>.45?'pine':'oak'):data.type==='mountain'?'peak':data.type==='rock'?(data.detail>.5?'crag':'boulders'):data.type==='grass'&&data.detail>.96?'mushrooms':null;
    if(kind&&(data.type!=='forest'||data.detail>.24)&&(data.type!=='mountain'||data.detail>.3))props.push({kind,biome:data.type,x:p.x+(data.detail-.5)*span*.2,y:p.y-lift,span,detail:data.detail});
    if(data.type==='forest'&&span>25&&data.detail>.55)props.push({kind:'pine',x:p.x+span*.25,y:p.y+span*.16-lift,span:span*.8,detail:data.detail});
   }
  }
  // Spread a bounded number across the viewport instead of spending the budget
  // on the first rows or drawing every decorative object in the terrain disk.
  if(props.length>policy.propLimit){const stride=props.length/policy.propLimit;props.splice(0,props.length,...Array.from({length:policy.propLimit},(_,i)=>props[Math.floor(i*stride)]));}
  props.sort((a,b)=>a.y-b.y);
  for(const prop of props){
   if(drawBiomeProp(ctx,prop))continue;
   const image=getImage(prop.kind),size=prop.span*(prop.kind==='peak'?1.9:prop.kind==='crag'?1.35:prop.kind==='boulders'?.72:prop.kind==='mushrooms'?.8:1.15);
   if(image?.complete&&image.naturalWidth){ctx.fillStyle='#071e2254';ctx.beginPath();ctx.ellipse(prop.x+size*.13,prop.y+3,size*.3,size*.09,-.2,0,Math.PI*2);ctx.fill();ctx.drawImage(image,prop.x-size/2,prop.y-size*.82,size,size);}
  }
  ctx.restore();
 }
 return{draw,stats:()=>pyramid?.stats()||{active:0,cached:0,queued:0},dispose(){pyramid?.dispose();}};
}
