// Actual map projection + landscape modules, rendered with Skia, no browser.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWorldCamera } from '../src/client/world-camera.js';
import { createLandscapeRenderer } from '../src/client/landscape-renderer.js';
import { drawWorldGrid } from '../src/client/world-grid.js';
const out=resolve(process.argv[2]||'../../outputs/world-views/preview.png');
await mkdir(resolve(out,'..'),{recursive:true});
const image=await loadImage('src/client/assets/terrain/world-overview.webp');
Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});
const assets=new Map([['world-overview',image]]),canvas=createCanvas(1600,1120),ctx=canvas.getContext('2d');
ctx.fillStyle='#080f19';ctx.fillRect(0,0,1600,1120);
function panel(x,y,width,height,lat,lng,mode,title){
 const camera=createWorldCamera({width,height,lat,lng,zoom:1,mode}),renderer=createLandscapeRenderer({assets,canvasFactory:()=>createCanvas(1,1)});
 ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.fillStyle='#0b1724';ctx.fillRect(0,0,width,height);
 renderer.draw(ctx,{width,height,zoom:1,project:camera.project,atPoint:camera.atPoint,camera});
 drawWorldGrid(ctx,camera);
 ctx.fillStyle='#0b1724e8';ctx.fillRect(15,15,Math.min(width-30,650),57);ctx.fillStyle='#8de9cb';ctx.font='600 19px sans-serif';ctx.fillText(title,30,42);ctx.fillStyle='#a2b7c6';ctx.font='12px sans-serif';ctx.fillText(`Центр: ${camera.center.lat.toFixed(2)}°, ${camera.center.lng.toFixed(2)}° · один и тот же мир`,30,61);
 ctx.restore();
}
panel(0,0,800,680,41.31,69.28,'auto','ГЛОБУС · Центральная Азия');
panel(800,0,800,680,-41.31,-110.72,'auto','ГЛОБУС · Обратная сторона планеты');
panel(0,682,1600,390,0,179.99,'flat','ПЛОСКАЯ КАРТА · Непрерывный переход через 180°');
ctx.fillStyle='#92aabc';ctx.font='13px sans-serif';ctx.fillText('Реальные модули камеры и ландшафта · программный рендер Skia · браузер не запускался',24,1102);
await writeFile(out,canvas.toBuffer('image/png'));
console.log(JSON.stringify({out,width:1600,height:1120,browserLaunched:false}));
