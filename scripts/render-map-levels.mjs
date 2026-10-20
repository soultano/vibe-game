import {createCanvas,loadImage} from '@napi-rs/canvas';
import {readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createWorldCamera} from '../src/client/world-camera.js';
import {createLandscapeRenderer} from '../src/client/landscape-renderer.js';
import {renderTerrainRaster} from '../src/client/terrain-raster.js';
const out=resolve(process.argv[2]||'../../outputs/world-views/detail-levels.png');await mkdir(resolve(out,'..'),{recursive:true});
const assets=new Map();for(const name of await readdir('src/client/assets/terrain'))if(name.endsWith('.webp')){const image=await loadImage('src/client/assets/terrain/'+name);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});assets.set(name.replace('.webp',''),image);}
const canvas=createCanvas(1600,1120),ctx=canvas.getContext('2d'),width=800,height=530;
ctx.fillStyle='#080f19';ctx.fillRect(0,0,1600,1120);
for(const[index,zoom]of[8,32,128,2048].entries()){
 const x=index%2*800,y=Math.floor(index/2)*540,camera=createWorldCamera({width,height,zoom,lat:41.31,lng:69.28,mode:'flat'}),jobs=[];
 const renderer=createLandscapeRenderer({assets,canvasFactory:()=>createCanvas(1,1),workerFactory:()=>({postMessage(job){jobs.push({worker:this,job});},terminate(){}})});
 const view={width,height,zoom,camera,project:camera.project,atPoint:camera.atPoint};
 ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.fillStyle='#0b1724';ctx.fillRect(0,0,width,height);renderer.draw(ctx,view);
 while(jobs.length){const{worker,job}=jobs.shift();worker.onmessage({data:{id:job.id,...renderTerrainRaster(job.tile)}});}
 renderer.draw(ctx,view);ctx.fillStyle='#0b1724ed';ctx.fillRect(12,12,460,58);ctx.fillStyle='#8de9cb';ctx.font='600 18px sans-serif';ctx.fillText(['КОНТИНЕНТ','РЕГИОН','ОКРЕСТНОСТИ','ТАКТИЧЕСКАЯ КАРТА'][index]+` · ×${zoom}`,27,38);ctx.fillStyle='#a2b7c6';ctx.font='12px sans-serif';ctx.fillText(zoom<768?'Отдельный уровень пирамиды · только видимые участки':'Детальный ландшафт · текстуры и объекты вблизи',27,58);ctx.restore();renderer.dispose();
}
ctx.fillStyle='#92aabc';ctx.font='13px sans-serif';ctx.fillText('Один центр: Ташкент · реальные модули карты и те же данные проходимости · рендер Skia без браузера',24,1104);
await writeFile(out,canvas.toBuffer('image/png'));console.log(JSON.stringify({out,browserLaunched:false}));
