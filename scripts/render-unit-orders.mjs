// Real service orders + real map/route/sprite modules, rendered by Skia only.
import{createCanvas,loadImage,Image}from'@napi-rs/canvas';
import{readFileSync}from'node:fs';import{readdir,writeFile,mkdir}from'node:fs/promises';import{resolve}from'node:path';import sharp from'sharp';
import{latLngToCell,cellToLatLng,cellToBoundary,gridRing,gridDisk}from'h3-js';
import{GameService}from'../src/server/game-service.js';import{MemoryStore}from'../src/server/store.js';import{traversable}from'../src/shared/landscape.js';
import{createWorldCamera}from'../src/client/world-camera.js';import{createLandscapeRenderer}from'../src/client/landscape-renderer.js';import{createBattlefieldState}from'../src/client/battlefield-state.js';
import{createTroopSprites}from'../src/client/troops-sprites.js';import{footprintBounds,headquartersLayout,spriteBounds,layoutTroops}from'../src/client/actor-layout.js';import{drawUnitOrder}from'../src/client/unit-controls.js';
const output=resolve(process.argv[2]||'../../outputs/unit-orders');await mkdir(output,{recursive:true});
let now=1900000000000;const start=now,store=new MemoryStore(),game=new GameService({store,clock:()=>now}),base=latLngToCell(41.3111,69.2797,8),a=cellToLatLng(base);
const goal=gridRing(base,3).filter(c=>traversable(c)&&cellToLatLng(c)[1]>a[1]).sort((x,y)=>Math.abs(cellToLatLng(x)[0]-a[0])-Math.abs(cellToLatLng(y)[0]-a[0]))[0],capture=gridDisk(base,1).find(c=>c!==base&&traversable(c));
await store.atomic({puts:[{key:'account:commander',value:{id:'commander',createdAt:now}}]});await game.placeBase('commander',{cell:base,faction:'pack'});
const row=await store.get('player:commander');row.value.army.credit=2;await store.atomic({puts:[{key:'player:commander',value:row.value}]});
await game.commandUnit('commander',{unitId:'commander:infantry:0',mode:'move',cell:goal});await game.commandUnit('commander',{unitId:'commander:infantry:1',mode:'capture',cell:capture});await game.commandUnit('commander',{unitId:'commander:infantry:2',mode:'hold'});
const width=1280,height=800,b=cellToLatLng(goal),camera=createWorldCamera({width,height,zoom:4096,lat:(a[0]+b[0])/2,lng:(a[1]+b[1])/2,mode:'flat'}),canvas=createCanvas(width,height),ctx=canvas.getContext('2d'),background=createCanvas(width,height),ground=background.getContext('2d'),assets=new Map();
for(const file of await readdir('src/client/assets/terrain'))if(file.endsWith('.webp')){const image=await loadImage('src/client/assets/terrain/'+file);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});assets.set(file.replace('.webp',''),image);}
const terrain=createLandscapeRenderer({assets,canvasFactory:()=>createCanvas(1,1)});terrain.draw(ground,{width,height,zoom:4096,camera,project:camera.project,atPoint:camera.atPoint,baseCells:[base]});
const hq=await loadImage('src/client/assets/headquarters/pack.png'),crop=spriteBounds(hq,()=>createCanvas(1,1)),hqLayout=headquartersLayout(camera.project(...a),footprintBounds(camera.project.shape(cellToBoundary(base))),crop);ground.drawImage(hq,crop.x,crop.y,crop.width,crop.height,hqLayout.left,hqLayout.top,hqLayout.width,hqLayout.height);
let prototype=new Image,src;while(prototype&&!src){src=Object.getOwnPropertyDescriptor(prototype,'src');prototype=Object.getPrototypeOf(prototype);}
const imageFactory=()=>{const image=new Image();Object.defineProperty(image,'src',{set(value){if(value)src.set.call(image,readFileSync('src/client'+value.split('?')[0]));}});return image;};
const sprites=createTroopSprites({imageFactory}),battlefield=createBattlefieldState(),armyCanvas=createCanvas(width,height),frames=[],positions=new Set(),events=new Set();battlefield.select('commander:infantry:0');let player;
for(let frame=0;frame<60;frame++){
 const elapsed=frame*1000/6;if(frame%3===0){now=start+elapsed;player=(await game.state('commander')).player;battlefield.sync({player},now);for(const e of player.army.events)events.add(e.kind);}
 const units=battlefield.units(start+elapsed),unit=units.find(u=>u.key==='commander:infantry:0');positions.add(unit.cell);
 const view={canvas:armyCanvas,width,height,zoom:4096,units,serverNow:start+elapsed,projectCell:c=>camera.project(...cellToLatLng(c)),footprintCell:c=>footprintBounds(camera.project.shape(cellToBoundary(c))),shapeCell:c=>camera.project.shape(cellToBoundary(c))};
 sprites.render(elapsed,view);if(frame===0)for(let i=0;i<80&&(sprites.stats().loads||sprites.stats().queued);i++){await new Promise(r=>setImmediate(r));sprites.render(elapsed,view);}
 ctx.drawImage(background,0,0);const pose=layoutTroops(units,view).find(p=>p.unit.key===unit.key);drawUnitOrder(ctx,unit,{...view,routeStart:pose});if(pose){ctx.strokeStyle='#beff9c';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(pose.x,pose.y,pose.span*.48,pose.span*.19,0,0,Math.PI*2);ctx.stroke();}ctx.drawImage(armyCanvas,0,0);
 ctx.fillStyle='#091b20ec';ctx.fillRect(20,20,760,72);ctx.fillStyle='#d9e5bc';ctx.font='600 23px sans-serif';ctx.fillText('ВЫБРАН ОТРЯД · ПРИКАЗ: ИДТИ',36,51);ctx.font='14px sans-serif';ctx.fillStyle='#a6c3b6';ctx.fillText('Зелёная линия — реальные шаги · Прицел — целевой гекс · '+(elapsed/1000).toFixed(1)+' с',36,77);
 // Illustrative command card; this is not a browser screenshot of the HTML.
 const x=22,y=height-248;ctx.fillStyle='#16271eF5';ctx.fillRect(x,y,340,195);ctx.strokeStyle='#b1be80';ctx.strokeRect(x,y,340,195);ctx.fillStyle='#e0e5c4';ctx.font='600 20px sans-serif';ctx.fillText('Клык · 1',x+15,y+29);ctx.font='12px sans-serif';ctx.fillStyle='#b7cba8';ctx.fillText(`${unit.hp} / ${unit.maxHp} HP · Лёгкая пехота`,x+15,y+51);
 ['↗ Идти  [M]','⚔ Атака  [A]','⚑ Захват  [C]','■ Стоп  [S]','↻ Авто  [U]','⊙ К отряду  [F]'].forEach((label,i)=>{const l=x+12+i%3*106,t=y+65+Math.floor(i/3)*43;ctx.fillStyle=i===0?'#735c34':'#344b31';ctx.fillRect(l,t,100,36);ctx.fillStyle='#e3e6c9';ctx.font='12px sans-serif';ctx.fillText(label,l+7,t+23);});
 ctx.fillStyle='#d7e8c1';ctx.fillText(unit.order?.status==='complete'?'Цель достигнута · удерживает позицию':'Выполняет приказ · маршрут сервера',x+14,y+177);
 ctx.fillStyle='#081723ed';ctx.fillRect(20,height-42,width-40,27);ctx.fillStyle='#a5c0b3';ctx.font='12px sans-serif';ctx.fillText('Офлайн-рендер настоящих модулей игры; карточка команд — иллюстрация. Браузер не запускался.',32,height-24);
 if(frame===12||frame===54)await writeFile(resolve(output,'frame-'+frame+'.png'),canvas.toBuffer('image/png'));frames.push(Buffer.from(ctx.getImageData(0,0,width,height).data));
}
await sharp(Buffer.concat(frames),{raw:{width,height:height*frames.length,channels:4,pageHeight:height}}).webp({quality:74,effort:3,loop:0,delay:167}).toFile(resolve(output,'orders-demo.webp'));
const proof={browserLaunched:false,source:'real GameService individual orders + game route renderer + GLB sprite frames; illustrative command card',frames:frames.length,fps:6,goal,selectedStatus:player.army.units[0].order.status,selectedCell:player.army.units[0].cell,visitedCells:positions.size,events:[...events],pixels:player.pixels};await writeFile(resolve(output,'render-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));sprites.dispose();terrain.dispose();
