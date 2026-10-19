// Offline software render of the actual GLB skinning and animation channels.
// Used for review when browser/GPU automation is intentionally disabled.
import {NodeIO}from'@gltf-transform/core';import{readFile,mkdir,writeFile}from'node:fs/promises';import{resolve,join}from'node:path';import sharp from'sharp';import{Vector3}from'three';import{animatedGeometry}from'./lib/gltf-pose.mjs';
const out=resolve(process.argv[2]||'../troops/frames');await mkdir(out,{recursive:true});
const manifest=JSON.parse(await readFile('src/client/assets/troops/manifest.json')),io=new NodeIO(),assets=[];
for(const[id,record]of Object.entries(manifest.models)){
 const doc=await io.read('src/client'+record.file),textures=new Map();
 for(const material of doc.getRoot().listMaterials()){const texture=material.getBaseColorTexture();if(texture){const{data,info}=await sharp(texture.getImage()).removeAlpha().raw().toBuffer({resolveWithObject:true});textures.set(material,{data,...info});}}
 const pose=animatedGeometry(doc,'idle',0),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
 for(const p of pose)for(let i=0;i<p.positions.length;i++){lo[i%3]=Math.min(lo[i%3],p.positions[i]);hi[i%3]=Math.max(hi[i%3],p.positions[i]);}
 assets.push({id,record,doc,textures,center:[(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2],scale:2/Math.max(...hi.map((v,i)=>v-lo[i]))});
}
assets.sort((a,b)=>{const f=['protocol','vanguard','bloom','swarm','pack'],r=['infantry','armor','air','ultimate'];return f.indexOf(a.id.split('-')[0])*4+r.indexOf(a.id.split('-')[1])-f.indexOf(b.id.split('-')[0])*4-r.indexOf(b.id.split('-')[1]);});
const side=new Vector3(.8,0,-.6),up=new Vector3(-.27,.89,-.36),depth=new Vector3(.534,.454,.712),light=new Vector3(-.4,.8,.6).normalize();
function render(asset,clip,time,ox,oy){
 const triangles=[];
 for(const p of animatedGeometry(asset.doc,clip,time)){
  const {positions,indices,uv,material}=p,texture=asset.textures.get(material),factor=material?.getBaseColorFactor()||[.6,.6,.6,1];
  const points=[];for(let i=0;i<positions.length;i+=3){const v=new Vector3(positions[i]-asset.center[0],positions[i+1]-asset.center[1],positions[i+2]-asset.center[2]).multiplyScalar(asset.scale);points.push(v);}
  for(let i=0;i<(indices?.length||points.length);i+=3){
   const a=indices?indices[i]:i,b=indices?indices[i+1]:i+1,c=indices?indices[i+2]:i+2,v=[points[a],points[b],points[c]];
   const normal=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize(),brightness=.48+Math.max(0,normal.dot(light))*.6;
   let rgb=factor.slice(0,3).map(v=>v*255);
   if(texture&&uv){const u=(uv[a*2]+uv[b*2]+uv[c*2])/3,w=(uv[a*2+1]+uv[b*2+1]+uv[c*2+1])/3,x=Math.max(0,Math.min(texture.width-1,Math.floor(u*texture.width))),y=Math.max(0,Math.min(texture.height-1,Math.floor(w*texture.height))),at=(y*texture.width+x)*texture.channels;rgb=[0,1,2].map(i=>texture.data[at+i]*factor[i]);}
   const fill='#'+rgb.map(v=>Math.max(0,Math.min(255,Math.round(v*brightness))).toString(16).padStart(2,'0')).join('');
   triangles.push({depth:v.reduce((sum,p)=>sum+p.dot(depth),0)/3,svg:`<path d="M${v.map(p=>(ox+100+p.dot(side)*68).toFixed(1)+','+(oy+98-p.dot(up)*68).toFixed(1)).join('L')}Z" fill="${fill}"/>`});
  }
 }
 triangles.sort((a,b)=>a.depth-b.depth);
 return `<g>${triangles.map(t=>t.svg).join('')}</g><text x="${ox+100}" y="${oy+190}" font-size="10" fill="#a6c4d7" text-anchor="middle">${asset.id}</text>`;
}
const frames=36;
for(let frame=0;frame<frames;frame++){
 const clip=frame<18?'walk':'attack',phase=(frame%18)/18;
 let svg=`<svg width="800" height="1040" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="1040" fill="#0c1724"/><text x="400" y="27" text-anchor="middle" fill="#e5f4fc" font-family="Arial" font-size="19">${clip==='walk'?'ДВИЖЕНИЕ':'АТАКА'} · 20 GLB-моделей</text>`;
 let index=0;for(const asset of assets){const duration=asset.record.animations.find(a=>a.name===clip).duration;svg+=render(asset,clip,phase*duration,(index%4)*200,40+Math.floor(index/4)*200);index++;}
 svg+='</svg>';await sharp(Buffer.from(svg)).png().toFile(join(out,String(frame).padStart(3,'0')+'.png'));if(frame%9===0)console.log(JSON.stringify({frame,clip}));
}
await writeFile(join(out,'render-info.json'),JSON.stringify({source:'actual GLB joint matrices, skin weights and animation channels',frames,width:800,height:1040,materials:'base-color texture sampled per triangle',browser:false},null,2));
