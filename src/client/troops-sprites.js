import manifest from './assets/troops/sprites/manifest.json' with {type:'json'};
import {layoutTroops} from './actor-layout.js';
export function spriteFrame(unit,serverNow){
 const record=manifest.models[unit.id],row=Math.max(0,manifest.clips.indexOf(unit.animation)),duration=record?.durations[row]||1,elapsed=Math.max(0,(serverNow-(unit.stateAt||serverNow))/1000);
 const phase=unit.animation==='death'?Math.min(1,elapsed/duration):(elapsed/duration+(unit.phase||0))%1;
 return{row,column:Math.min(manifest.frames-1,Math.floor(phase*manifest.frames)),record};
}
export function createTroopSprites({onReady=()=>{},imageFactory=()=>new Image(),reducedMotion=false}={}){
 const cache=new Map(),posters=new Map();let wanted=new Set(),pending=[],loads=0,visible=0,disposed=false;
 function pump(){while(loads<2&&pending.length&&!disposed&&!globalThis.document?.hidden){const id=pending.shift(),entry=cache.get(id);if(!wanted.has(id)||!entry||entry.started)continue;entry.started=true;loads++;entry.image.onload=()=>{entry.ready=true;loads--;if(!disposed){onReady();pump();}};entry.image.onerror=()=>{entry.error=true;entry.started=false;entry.failedAt=Date.now();loads--;if(!disposed){onReady();pump();}};entry.image.src=manifest.models[id].file+'?v='+manifest.version;}}
 function render(now,{serverNow,...view}){
  if(disposed||globalThis.document?.hidden)return;const {canvas,width,height}=view,ctx=canvas.getContext('2d'),ratio=Math.min(1.25,globalThis.devicePixelRatio||1,Math.sqrt(1600000/Math.max(1,width*height))),w=Math.round(width*ratio),h=Math.round(height*ratio);
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}ctx.clearRect(0,0,w,h);ctx.save();ctx.scale(ratio,ratio);
  const poses=layoutTroops(view.units,view);visible=poses.filter(({unit})=>unit.animation!=='death'||serverNow-unit.stateAt<(manifest.models[unit.id]?.durations[5]||1.5)*1000).length;const ids=[...new Set(poses.map(p=>p.unit.id))].slice(0,8);wanted=new Set(ids);pending=[];
  for(const id of ids){let entry=cache.get(id);if(!entry){entry={image:imageFactory(),started:false};cache.set(id,entry);}else{cache.delete(id);cache.set(id,entry);}if(!entry.started&&(!entry.failedAt||Date.now()-entry.failedAt>=10000))pending.push(id);}
  for(const[id,e]of cache)if(cache.size>8&&!wanted.has(id)&&(!e.started||e.ready||e.error)){e.image.onload=e.image.onerror=null;e.image.src='';cache.delete(id);}
  for(const {unit,x,y,span,elevation}of poses){
   const entry=cache.get(unit.id),{row,column,record}=spriteFrame(unit,reducedMotion?unit.stateAt||serverNow:serverNow),ground=y-elevation*.8;
   ctx.fillStyle='#07141865';ctx.beginPath();ctx.ellipse(x,y,span*.31,span*.10,0,0,Math.PI*2);ctx.fill();
   if(unit.hp>0){ctx.strokeStyle=unit.color;ctx.lineWidth=1.6;ctx.beginPath();ctx.ellipse(x,y,span*.34,span*.13,0,0,Math.PI*2);ctx.stroke();}
   if(entry?.ready){const size=span/(record.span||.8);ctx.drawImage(entry.image,column*manifest.tile,row*manifest.tile,manifest.tile,manifest.tile,x-size*record.anchorX,ground-size*record.anchorY,size,size);}
   else{let poster=posters.get(unit.id);if(!poster){poster=imageFactory();poster.onload=onReady;poster.src=unit.poster;posters.set(unit.id,poster);}if(poster.complete&&poster.naturalWidth){const breath=reducedMotion?0:Math.sin(now*.002+unit.phase*6.28)*span*.008;ctx.drawImage(poster,x-span*.7,ground-span*1.18-breath,span*1.4,span*1.4);}}
   if(unit.hp>0){const bar=Math.max(32,Math.min(70,span*.6)),top=ground-span*(record?.head||.65)/(record?.span||.8)-7;ctx.fillStyle='#07120ee6';ctx.fillRect(x-bar/2,top,bar,6);ctx.fillStyle=unit.neutral?'#e58554':unit.color;ctx.fillRect(x-bar/2+1,top+1,(bar-2)*Math.max(0,Math.min(1,unit.hp/unit.maxHp)),4);}
  }
  ctx.restore();pump();
 }
 return{render,needsFrame:()=>!disposed&&!reducedMotion&&!globalThis.document?.hidden&&visible>0,suspend(){visible=0;wanted.clear();pending=[];},stats:()=>({cached:cache.size,loads,queued:pending.length}),dispose(){disposed=true;visible=0;pending=[];for(const e of cache.values()){e.image.onload=e.image.onerror=null;e.image.src='';}cache.clear();posters.clear();}};
}
