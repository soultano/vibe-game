// Real server NPC snapshots + the game layout and GLB-derived animation renderer.
// Uses Skia only, without opening a browser, making accounts or changing a live world.
import {createCanvas,loadImage,Image}from'@napi-rs/canvas';
import {readFile,readdir,writeFile,mkdir}from'node:fs/promises';import{readFileSync}from'node:fs';import{resolve}from'node:path';import sharp from'sharp';
import{latLngToCell,cellToLatLng,cellToBoundary,gridRing}from'h3-js';
import{GameService}from'../src/server/game-service.js';import{MemoryStore}from'../src/server/store.js';
import{traversable}from'../src/shared/landscape.js';import{createBattlefieldState}from'../src/client/battlefield-state.js';
import{createWorldCamera}from'../src/client/world-camera.js';import{createLandscapeRenderer}from'../src/client/landscape-renderer.js';
import{footprintBounds,headquartersLayout,spriteBounds}from'../src/client/actor-layout.js';import{createTroopSprites}from'../src/client/troops-sprites.js';
const output=resolve(process.argv[2]||'../../outputs/living-armies');await mkdir(output,{recursive:true});
let now=1900000000000;const start=now,store=new MemoryStore(),game=new GameService({store,clock:()=>now});
const base=latLngToCell(41.3111,69.2797,8),enemy=gridRing(base,4).filter(c=>traversable(c)).sort((a,b)=>Math.abs(cellToLatLng(a)[0]-41.3111)-Math.abs(cellToLatLng(b)[0]-41.3111))[0];
for(const[id,cell,faction]of[['p',base,'pack'],['q',enemy,'swarm']]){
 await store.atomic({puts:[{key:'account:'+id,value:{id,name:id,createdAt:now}}]});await game.placeBase(id,{cell,faction});
 const row=await store.get('player:'+id);Object.assign(row.value,{shieldUntil:0,energy:100000,crystals:1000});row.value.army.credit=2;await store.atomic({puts:[{key:'player:'+id,value:row.value}]});
 for(const abilityId of['field','heavy','ultimate'])await game.useAbility(id,{abilityId,requestId:'offline_render_'+id+'_'+abilityId});
}
const width=1280,height=800,a=cellToLatLng(base),b=cellToLatLng(enemy),camera=createWorldCamera({width,height,zoom:5120,lat:(a[0]+b[0])/2,lng:(a[1]+b[1])/2,mode:'flat'});
const canvas=createCanvas(width,height),ctx=canvas.getContext('2d'),background=createCanvas(width,height),ground=background.getContext('2d'),assets=new Map();
for(const name of await readdir('src/client/assets/terrain'))if(name.endsWith('.webp')){const image=await loadImage('src/client/assets/terrain/'+name);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});assets.set(name.replace('.webp',''),image);}
const terrain=createLandscapeRenderer({assets,canvasFactory:()=>createCanvas(1,1)});
terrain.draw(ground,{width,height,zoom:5120,camera,project:camera.project,atPoint:camera.atPoint,baseCells:[base,enemy]});
for(const[cell,faction,color]of[[base,'pack','#bfa9fa'],[enemy,'swarm','#f28b78']]){
 const points=camera.project.shape(cellToBoundary(cell)),center=camera.project(...cellToLatLng(cell)),image=await loadImage('src/client/assets/headquarters/'+faction+'.png'),crop=spriteBounds(image,()=>createCanvas(1,1)),layout=headquartersLayout(center,footprintBounds(points),crop);
 ground.beginPath();points.forEach((p,i)=>i?ground.lineTo(p.x,p.y):ground.moveTo(p.x,p.y));ground.closePath();ground.fillStyle=color+'24';ground.fill();ground.strokeStyle=color;ground.lineWidth=2;ground.stroke();ground.drawImage(image,crop.x,crop.y,crop.width,crop.height,layout.left,layout.top,layout.width,layout.height);
}
let prototype=new Image,src;while(prototype&&!src){src=Object.getOwnPropertyDescriptor(prototype,'src');prototype=Object.getPrototypeOf(prototype);}
const imageFactory=()=>{const image=new Image();Object.defineProperty(image,'src',{set(value){if(value)src.set.call(image,readFileSync('src/client'+value.split('?')[0]));}});return image;};
const sprites=createTroopSprites({imageFactory}),battlefield=createBattlefieldState(),armyCanvas=createCanvas(width,height),frames=[],events=new Set(),states=new Set();let player,other;
async function sync(){player=(await game.state('p')).player;other=(await game.state('q')).player;battlefield.sync({player,players:[other]},now);for(const p of[player,other])for(const e of p.army.events)events.add(JSON.stringify([e.kind,e.at,e.unitId,e.targetId,e.cell]));}
await sync();
for(let frame=0;frame<72;frame++){
 const elapsed=frame*125;if(frame%4===0){now=start+elapsed;await sync();}
 const units=battlefield.units(start+elapsed);for(const u of units)states.add(u.animation);
 const view={canvas:armyCanvas,width,height,units,serverNow:start+elapsed,projectCell:c=>camera.project(...cellToLatLng(c)),footprintCell:c=>footprintBounds(camera.project.shape(cellToBoundary(c)))};
 sprites.render(elapsed,view);if(frame===0){for(let i=0;i<80&&(sprites.stats().loads||sprites.stats().queued);i++){await new Promise(r=>setImmediate(r));sprites.render(elapsed,view);}}
 ctx.drawImage(background,0,0);ctx.drawImage(armyCanvas,0,0);ctx.fillStyle='#081723eb';ctx.fillRect(16,16,780,75);ctx.fillStyle='#b6f0d8';ctx.font='600 22px sans-serif';ctx.fillText('БАЗА = 1 ГЕКСАГОН · КРУПНЫЕ ЖИВЫЕ ВОЙСКА',32,46);ctx.fillStyle='#afc8d5';ctx.font='14px sans-serif';ctx.fillText('Позиции, цели, HP и бой: настоящая серверная симуляция · '+(elapsed/1000).toFixed(1)+' с',32,72);
 ctx.fillStyle='#081723eb';ctx.fillRect(16,height-46,width-32,32);ctx.fillStyle='#a7c0cf';ctx.fillText('Офлайн-рендер кадров настоящих GLB и модулей игры через Skia. Браузер не запускался.',32,height-25);
 if(frame===8||frame===32||frame===64)await writeFile(resolve(output,`frame-${frame}.png`),canvas.toBuffer('image/png'));
 frames.push(Buffer.from(ctx.getImageData(0,0,width,height).data));
}
await sharp(Buffer.concat(frames),{raw:{width,height:height*frames.length,channels:4,pageHeight:height}}).webp({quality:74,effort:3,loop:0,delay:125}).toFile(resolve(output,'npc-motion.webp'));
const proof={browserLaunched:false,source:'real GameService + actual GLB clip frames + game actor layout/sprite fallback',frames:frames.length,fps:8,seconds:frames.length/8,states:[...states],eventCount:events.size,events:[...new Set([...events].map(e=>JSON.parse(e)[0]))],pixels:[player.pixels,other.pixels]};
await writeFile(resolve(output,'render-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));sprites.dispose();terrain.dispose();
