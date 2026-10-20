// Portable fallback frames from the shipped GLB skins/clips; no external API.
import {NodeIO} from '@gltf-transform/core';
import {createCanvas} from '@napi-rs/canvas';
import sharp from 'sharp';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Vector3} from 'three';
import {animatedGeometry} from './lib/gltf-pose.mjs';
const root='src/client/assets/troops',destination=root+'/sprites',manifest=JSON.parse(await readFile(root+'/manifest.json')),io=new NodeIO(),frames=8,tile=160,clips=['idle','walk','run','attack','capture','death'],result={version:'living-v2',frames,tile,clips,models:{}};
await mkdir(destination,{recursive:true});
const light=new Vector3(-.4,.8,.6).normalize(),yaw=-.25,sin=Math.sin(yaw),cos=Math.cos(yaw);
for(const[id,record]of Object.entries(manifest.models)){
 const doc=await io.read('src/client'+record.file),textures=new Map();
 for(const material of doc.getRoot().listMaterials()){const texture=material.getBaseColorTexture();if(texture){const{data,info}=await sharp(texture.getImage()).removeAlpha().raw().toBuffer({resolveWithObject:true});textures.set(material,{data,...info});}}
 const poses=clips.map(name=>Array.from({length:frames},(_,i)=>animatedGeometry(doc,name,record.animations.find(a=>a.name===name).duration*i/(name==='death'?frames-1:frames))));
 const base=poses[0][0],lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
 for(const p of base)for(let i=0;i<p.positions.length;i++){lo[i%3]=Math.min(lo[i%3],p.positions[i]);hi[i%3]=Math.max(hi[i%3],p.positions[i]);}
 const center=[(lo[0]+hi[0])/2,lo[1],(lo[2]+hi[2])/2],scale=2/Math.max(...hi.map((v,i)=>v-lo[i]));
 let left=Infinity,right=-Infinity,top=-Infinity,bottom=Infinity;
 for(const row of poses)for(const pose of row)for(const primitive of pose){const a=primitive.positions;for(let i=0;i<a.length;i+=3){const x=(a[i]-center[0])*scale,y=(a[i+1]-center[1])*scale,z=(a[i+2]-center[2])*scale,px=x*cos+z*sin,py=y*.8-(-x*sin+z*cos)*.6;left=Math.min(left,px);right=Math.max(right,px);top=Math.max(top,py);bottom=Math.min(bottom,py);}}
 const pixelScale=Math.min(tile*.82/(right-left),tile*.79/(top-bottom)),anchorX=tile/2-(left+right)/2*pixelScale,anchorY=tile*.87+bottom*pixelScale;
 const canvas=createCanvas(tile*frames,tile*clips.length),ctx=canvas.getContext('2d');
 for(let row=0;row<clips.length;row++)for(let frame=0;frame<frames;frame++){
  const triangles=[];for(const primitive of poses[row][frame]){
   const {positions,indices,uv,material}=primitive,texture=textures.get(material),factor=material?.getBaseColorFactor()||[.7,.7,.7,1],points=[];
   for(let i=0;i<positions.length;i+=3){const x=(positions[i]-center[0])*scale,y=(positions[i+1]-center[1])*scale,z=(positions[i+2]-center[2])*scale;points.push(new Vector3(x*cos+z*sin,y,-x*sin+z*cos));}
   for(let i=0;i<(indices?.length||points.length);i+=3){const a=indices?indices[i]:i,b=indices?indices[i+1]:i+1,c=indices?indices[i+2]:i+2,v=[points[a],points[b],points[c]],normal=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize(),brightness=.62+Math.max(0,normal.dot(light))*.5;let rgb=factor.slice(0,3).map(v=>v*255);
    if(texture&&uv){const u=(uv[a*2]+uv[b*2]+uv[c*2])/3,w=(uv[a*2+1]+uv[b*2+1]+uv[c*2+1])/3,x=Math.max(0,Math.min(texture.width-1,Math.floor(u*texture.width))),y=Math.max(0,Math.min(texture.height-1,Math.floor(w*texture.height))),at=(y*texture.width+x)*texture.channels;rgb=[0,1,2].map(i=>texture.data[at+i]*factor[i]);}
    triangles.push({depth:v.reduce((s,p)=>s+p.y*.6+p.z*.8,0)/3,v,color:'#'+rgb.map(v=>Math.max(0,Math.min(255,Math.round(v*brightness))).toString(16).padStart(2,'0')).join('')});
   }
  }
  triangles.sort((a,b)=>a.depth-b.depth);for(const t of triangles){ctx.fillStyle=t.color;ctx.beginPath();t.v.forEach((p,i)=>{const x=frame*tile+anchorX+p.x*pixelScale,y=row*tile+anchorY-(p.y*.8-p.z*.6)*pixelScale;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.fill();}
 }
 const bytes=await sharp(canvas.toBuffer('image/png')).webp({quality:80,alphaQuality:90,effort:5}).toBuffer();await writeFile(destination+'/'+id+'.webp',bytes);
 result.models[id]={file:'/assets/troops/sprites/'+id+'.webp',durations:clips.map(name=>record.animations.find(a=>a.name===name).duration),anchorX:anchorX/tile,anchorY:anchorY/tile,head:top*pixelScale/tile,span:Math.max(right-left,top-bottom)*pixelScale/tile,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 console.log(JSON.stringify({id,bytes:bytes.length}));
}
await writeFile(destination+'/manifest.json',JSON.stringify(result,null,2));console.log(JSON.stringify({atlases:20,bytes:Object.values(result.models).reduce((n,m)=>n+m.bytes,0),meshyCreditsUsed:0}));
