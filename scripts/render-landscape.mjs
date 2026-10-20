// Render the actual Canvas terrain implementation with Skia. No browser/GPU.
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {latLngToCell,cellToLatLng,gridDisk} from 'h3-js';
import {createLandscapeRenderer} from '../src/client/landscape-renderer.js';
import {landscape} from '../src/shared/landscape.js';
const out=resolve(process.argv[2]||'../../outputs/landscape-preview.png');await mkdir(resolve(out,'..'),{recursive:true});
const assets=new Map();for(const name of await readdir('src/client/assets/terrain'))if(name.endsWith('.webp')){const image=await loadImage('src/client/assets/terrain/'+name);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});assets.set(name.replace('.webp',''),image);}
const width=1600,height=1000,zoom=2048,scale=Math.min(width/360,height/180)*zoom;
// Find a varied local landscape, using only the same deterministic world field.
let lat=41.32,lng=69.32,best=-1;
for(let y=0;y<12;y++)for(let x=0;x<12;x++){
 const a=41.28+y*.025,b=69.1+x*.025,cell=latLngToCell(a,b,8),types=new Set(gridDisk(cell,6).map(c=>landscape(c).type));
 const score=types.size+(types.has('water')?2:0)+(types.has('mountain')?1:0);if(score>best){best=score;lat=a;lng=b;}
}
const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle='#385743';ctx.fillRect(0,0,width,height);
const project=(a,b)=>({x:width/2+(b-lng)*scale,y:height/2-(a-lat)*scale}),atPoint=(x,y)=>({lat:lat-(y-height/2)/scale,lng:lng+(x-width/2)/scale});
createLandscapeRenderer({assets}).draw(ctx,{width,height,zoom,project,atPoint});
await writeFile(out,canvas.toBuffer('image/png'));console.log(JSON.stringify({out,width,height,center:{lat,lng},renderer:'actual Canvas terrain module via Skia; no browser'}));
