import { latLngToCell, cellToLatLng, cellToBoundary, gridDisk } from 'h3-js';
import { landscape } from '../shared/landscape.js';
const colors={grass:'#52713b',forest:'#2d5141',rock:'#7b8169',mountain:'#737b71',sand:'#ad9658',water:'#1c6579'};
const textures={mountain:'rock',grass:'grass',forest:'forest',rock:'rock',sand:'sand',water:'water'};
export function terrainLift(cell,zoom){return Math.min(20,Math.max(0,zoom/100)*landscape(cell).elevation*.34);}
export function createLandscapeRenderer({onReady=()=>{},imageFactory=()=>new Image(),assets=null}={}){
 const images=new Map(),patterns=new WeakMap();let key='',cells=[];
 for(const name of ['grass','forest','rock','dirt','sand','water','pine','oak','peak','crag','boulders','mushrooms']){
  if(assets?.has(name)){images.set(name,assets.get(name));continue;}
  const image=imageFactory();image.onload=onReady;image.src='/assets/terrain/'+name+'.webp';images.set(name,image);
 }
 function pattern(ctx,name){let values=patterns.get(ctx);if(!values){values=new Map();patterns.set(ctx,values);}const image=images.get(name);if(!image?.complete||!image.naturalWidth)return null;if(!values.has(name))values.set(name,ctx.createPattern(image,'repeat'));return values.get(name);}
 function draw(ctx,{width,height,zoom,project,atPoint,baseCells=[],roads=[]}){
  if(zoom<128)return;
  const res=zoom>=768?8:zoom>=256?7:6,center=atPoint(width/2,height/2),cell=latLngToCell(center.lat,center.lng,res);
  const edgePixels=zoom*(res===8?.017:res===7?.045:.12),radius=Math.min(34,Math.ceil(Math.hypot(width,height)/Math.max(8,edgePixels)));
  const nextKey=`${cell}:${res}:${radius}`;
  if(key!==nextKey){key=nextKey;cells=gridDisk(cell,radius).map(index=>{const [lat,lng]=cellToLatLng(index),sample=res===8?index:latLngToCell(lat,lng,8);return{index,sample,lat,lng,shape:cellToBoundary(index),data:landscape(sample)};}).sort((a,b)=>b.lat-a.lat||a.lng-b.lng);}
  const bases=new Set([...baseCells,...roads]),props=[];
  ctx.save();ctx.imageSmoothingEnabled=true;
  for(const tile of cells){
   const p=project(tile.lat,tile.lng),points=tile.shape.map(([lat,lng])=>project(lat,lng)),span=Math.max(...points.map(v=>v.x))-Math.min(...points.map(v=>v.x)),data=tile.data;
   if(p.x< -span||p.y< -span*3||p.x>width+span||p.y>height+span*3)continue;
   const lift=0;
   function path(dy=0){ctx.beginPath();points.forEach((v,i)=>i?ctx.lineTo(v.x,v.y+dy):ctx.moveTo(v.x,v.y+dy));ctx.closePath();}
   if(lift>0){path();ctx.fillStyle='#263a31';ctx.fill();}
   path(-lift);ctx.fillStyle=colors[data.type];ctx.fill();
   const fill=pattern(ctx,textures[data.type]);
   if(fill){ctx.save();path(-lift);ctx.clip();ctx.globalAlpha=.68;ctx.fillStyle=fill;ctx.fillRect(p.x-span,p.y-span-lift,span*2,span*2);ctx.restore();}
   // A soft edge ties different materials together without an opaque hex grid.
   // Shade slopes while keeping contiguous ground surfaces free of hex cracks.
   if(!data.water&&data.elevation>1){ctx.save();path();ctx.clip();const shade=ctx.createLinearGradient(p.x-span/2,p.y-span/2,p.x+span/2,p.y+span/2);shade.addColorStop(0,'#e4d79d18');shade.addColorStop(1,'#10291c24');ctx.fillStyle=shade;ctx.fillRect(p.x-span,p.y-span,span*2,span*2);ctx.restore();}
   if(bases.has(tile.sample)&&!data.water){ctx.save();path();ctx.clip();ctx.globalAlpha=.35;ctx.fillStyle=pattern(ctx,'dirt')||'#9c8551';ctx.beginPath();ctx.ellipse(p.x,p.y,span*.38,span*.28,0,0,Math.PI*2);ctx.fill();ctx.restore();}
   if(data.water){
    const shore=tile.shape.map(([lat,lng])=>landscape(latLngToCell(lat,lng,8))).some(d=>!d.water);
    if(shore){path(-lift);ctx.strokeStyle='#b5d09c82';ctx.lineWidth=Math.min(4,span*.12);ctx.stroke();}
    if(span>15){ctx.strokeStyle='#b3e2dc35';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(p.x,p.y,span*.23,span*.06,0,0,Math.PI*1.5);ctx.stroke();}
   }
   if(span>10&&!data.water&&!bases.has(tile.sample)){
    const kind=data.type==='forest'?(data.detail>.45?'pine':'oak'):data.type==='mountain'?'peak':data.type==='rock'?(data.detail>.5?'crag':'boulders'):data.type==='grass'&&data.detail>.96?'mushrooms':null;
    if(kind&&(data.type!=='forest'||data.detail>.24)&&(data.type!=='mountain'||data.detail>.3))props.push({kind,x:p.x+(data.detail-.5)*span*.2,y:p.y-lift,span,detail:data.detail});
    if(data.type==='forest'&&span>25&&data.detail>.55)props.push({kind:'pine',x:p.x+span*.25,y:p.y+span*.16-lift,span:span*.8,detail:data.detail});
   }
  }
  props.sort((a,b)=>a.y-b.y);
  for(const prop of props){
   const image=images.get(prop.kind),size=prop.span*(prop.kind==='peak'?1.9:prop.kind==='crag'?1.35:prop.kind==='boulders'?.72:prop.kind==='mushrooms'?.8:1.15);
   if(image?.complete&&image.naturalWidth){ctx.fillStyle='#071e2254';ctx.beginPath();ctx.ellipse(prop.x+size*.13,prop.y+3,size*.3,size*.09,-.2,0,Math.PI*2);ctx.fill();ctx.drawImage(image,prop.x-size/2,prop.y-size*.82,size,size);}
  }
  ctx.restore();
 }
 return{draw};
}
