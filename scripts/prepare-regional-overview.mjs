import sharp from'sharp';import{readFile,writeFile,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';import{landscapeAt}from'../src/shared/landscape.js';import{OVERVIEW_TERRAIN as c}from'../src/shared/terrain-overview.js';
const mask=JSON.parse(await readFile('data/world-mask.json')),size=512,colors={grass:[88,123,64],forest:[42,86,68],rock:[120,128,103],mountain:[159,168,150],sand:[184,162,98],water:[30,91,117]},assets=[];
await mkdir('src/client/assets/terrain/overview',{recursive:true});
for(let south=c.south;south<c.north;south+=c.step)for(let west=c.west;west<c.east;west+=c.step){
 const pixels=Buffer.alloc(size*size*3);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const lat=south+c.step-(y+.5)/size*c.step,lng=west+(x+.5)/size*c.step,land=!!mask.land[Math.min(179,Math.max(0,Math.floor(90-lat)))*360+Math.min(359,Math.max(0,Math.floor(lng+180)))],d=landscapeAt(lat,lng,land),color=colors[d.type],shade=.88+d.elevation*.045;
  for(let ch=0;ch<3;ch++)pixels[(y*size+x)*3+ch]=Math.round(color[ch]*shade);
 }
 const file=`overview/r-${west}-${south}.webp`,bytes=await sharp(pixels,{raw:{width:size,height:size,channels:3}}).resize(c.pixels,c.pixels).webp({quality:74}).toBuffer();await writeFile('src/client/assets/terrain/'+file,bytes);assets.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const path='src/client/assets/terrain/manifest.json',manifest=JSON.parse(await readFile(path));manifest.regionalOverview={...c,assets};await writeFile(path,JSON.stringify(manifest,null,2));console.log(JSON.stringify({tiles:assets.length,bytes:assets.reduce((s,a)=>s+a.bytes,0),maxTileBytes:Math.max(...assets.map(a=>a.bytes))}));
