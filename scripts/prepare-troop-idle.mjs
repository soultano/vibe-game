import {NodeIO} from '@gltf-transform/core';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Quaternion,Euler} from 'three';
const path='src/client/assets/troops/manifest.json',manifest=JSON.parse(await readFile(path)),io=new NodeIO();let changed=0;
for(const[id,record]of Object.entries(manifest.models)){
 if(record.rig!=='authored-creature-skeleton')continue;
 const doc=await io.read('src/client'+record.file),idle=doc.getRoot().listAnimations().find(a=>a.getName()==='idle');
 for(const channel of idle.listChannels()){
  if(channel.getTargetPath()!=='rotation')continue;
  const name=channel.getTargetNode().getName(),sampler=channel.getSampler(),times=sampler.getInput().getArray(),duration=times.at(-1),values=[];
  if(!/^(Head|Turret|Barrel|Body|Carapace_\d+|Scythe_)/.test(name))continue;
  for(const time of times){
   const phase=time/duration*Math.PI*2;let x=0,y=0,z=0;
   if(name==='Head'){x=Math.sin(phase)*.055;y=Math.sin(phase)*.16;}
   if(name==='Turret'){y=Math.sin(phase)*.19;x=Math.sin(phase)*.015;}
   if(name==='Barrel')x=Math.sin(phase)*.035;
   if(name==='Body')z=Math.sin(phase)*.014;
   if(name.startsWith('Carapace_'))x=Math.sin(phase+Number(name.split('_')[1])*.45)*.035;
   if(name.startsWith('Scythe_'))x=Math.sin(phase)*.055;
   values.push(...new Quaternion().setFromEuler(new Euler(x,y,z)).toArray());
  }
  sampler.getOutput().setArray(new Float32Array(values));
 }
 const bytes=Buffer.from(await io.writeBinary(doc));await writeFile('src/client'+record.file,bytes);
 record.bytes=bytes.length;record.sha256=createHash('sha256').update(bytes).digest('hex');record.idleBehavior='head scan, breathing/weight shift; turret/weapon readiness; original wing/rotor tracks preserved';changed++;
}
manifest.displayVersion='living-v2';await writeFile(path,JSON.stringify(manifest,null,2));console.log(JSON.stringify({updatedIdleRigs:changed,totalModelBytes:Object.values(manifest.models).reduce((n,m)=>n+m.bytes,0),meshyCreditsUsed:0}));
