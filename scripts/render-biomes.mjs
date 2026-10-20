import{createCanvas,loadImage}from'@napi-rs/canvas';
import{readdir,mkdir,writeFile}from'node:fs/promises';import{resolve}from'node:path';
import{createWorldCamera}from'../src/client/world-camera.js';import{createLandscapeRenderer}from'../src/client/landscape-renderer.js';
const out=resolve(process.argv[2]||'../../outputs/world-views/biomes.png');await mkdir(resolve(out,'..'),{recursive:true});
const assets=new Map();for(const name of await readdir('src/client/assets/terrain'))if(name.endsWith('.webp')){const image=await loadImage('src/client/assets/terrain/'+name);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});assets.set(name.replace('.webp',''),image);}
const width=600,height=430,canvas=createCanvas(1800,930),ctx=canvas.getContext('2d');ctx.fillStyle='#080f19';ctx.fillRect(0,0,1800,930);
const places=[[-80,30,'АНТАРКТИДА · ЛЁД И СНЕГ'],[24,13,'САХАРА · ПЕСЧАНЫЕ ДЮНЫ'],[-4,-62,'АМАЗОНИЯ · ДЖУНГЛИ'],[-25,134,'АВСТРАЛИЯ · СУХАЯ ПУСТЫНЯ'],[68,100,'СИБИРЬ · ТУНДРА'],[-5,38,'ВОСТОЧНАЯ АФРИКА · САВАННА']];
for(const[i,[lat,lng,label]]of places.entries()){
 const x=i%3*width,y=Math.floor(i/3)*450,camera=createWorldCamera({width,height,zoom:2048,lat,lng,mode:'flat'}),renderer=createLandscapeRenderer({assets,canvasFactory:()=>createCanvas(1,1)});
 ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.fillStyle='#0b1724';ctx.fillRect(0,0,width,height);renderer.draw(ctx,{width,height,zoom:2048,camera,project:camera.project,atPoint:camera.atPoint});ctx.fillStyle='#0b1724e8';ctx.fillRect(10,10,width-20,44);ctx.fillStyle='#b3f1d9';ctx.font='600 16px sans-serif';ctx.fillText(label,23,37);ctx.restore();renderer.dispose();
}
ctx.fillStyle='#a1b9ca';ctx.font='14px sans-serif';ctx.fillText('Настоящий рендер игры · климатические зоны и те же данные местности на всех уровнях · без браузера',24,922);await writeFile(out,canvas.toBuffer('image/png'));console.log(JSON.stringify({out,browserLaunched:false}));
