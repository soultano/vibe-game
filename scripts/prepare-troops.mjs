// Consumes downloaded Meshy outputs only. No network calls or credentials.
import { NodeIO } from '@gltf-transform/core';
import { readFile,writeFile,mkdir,stat } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareGeometry,optimizeTextures } from './lib/prepare-gltf.mjs';
import { rigCreature,copyMotion,addHumanoidUtilityClips,groundAnimations } from './lib/troop-rig.mjs';
import { Matrix4 } from 'three';
import { equipHumanoid } from './lib/troop-equipment.mjs';
import { troopFor,TROOP_CLASSES } from '../src/shared/troops.js';
const input=resolve(process.argv[2]||'../troops/meshy'),out=resolve('src/client/assets/troops');await mkdir(out,{recursive:true});
const jobs=JSON.parse(await readFile(join(input,'jobs.json'))),rigs=JSON.parse(await readFile(join(input,'rig-jobs.json'))),attacks=JSON.parse(await readFile(join(input,'attack-jobs.json')));
const io=new NodeIO(),models={};
for(const faction of ['protocol','vanguard','bloom','swarm','pack'])for(const role of TROOP_CLASSES){
 const spec=troopFor(faction,role.id),id=spec.id,humanoid=!!rigs[id]?.taskId;
 if(process.argv.length>3&&!process.argv.slice(3).includes(id))continue;
 const doc=await io.read(join(input,id+(humanoid?'-rig':'')+'.glb'));
 let rig;
 if(humanoid){
  for(const animation of doc.getRoot().listAnimations())animation.dispose();
  copyMotion(doc,await io.read(join(input,id+'-walk.glb')),'walk');
  copyMotion(doc,await io.read(join(input,id+'-run.glb')),'run');
  copyMotion(doc,await io.read(join(input,id+'-attack.glb')),'attack');
  addHumanoidUtilityClips(doc);equipHumanoid(doc,id);
  const scene=doc.getRoot().getDefaultScene()||doc.getRoot().listScenes()[0];
  for(const node of doc.getRoot().listNodes())if(node.getSkin()){for(const parent of [...node.listParents()])if(parent.propertyType==='Node')parent.removeChild(node);scene.addChild(node);node.setMatrix(new Matrix4().toArray());}
  rig={rig:'Meshy-auto-rig',joints:doc.getRoot().listSkins().reduce((s,skin)=>s+skin.listJoints().length,0)};
 }else rig=rigCreature(doc,id);
 const repairedNormals=await prepareGeometry(doc);await optimizeTextures(doc,512);
 if(role.id!=='air'&&id!=='protocol-ultimate')await groundAnimations(doc);
 for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives()){const w=p.getAttribute('WEIGHTS_0'),j=p.getAttribute('JOINTS_0');if(!w)continue;const weights=new Float32Array(w.getArray()),joints=new Uint16Array(j.getArray());for(let i=0;i<weights.length;i+=4){let sum=0;for(let k=0;k<4;k++){weights[i+k]=Math.max(0,weights[i+k]);if(weights[i+k]<1e-8){weights[i+k]=0;joints[i+k]=0;}sum+=weights[i+k];}if(sum<=0)throw new Error('Empty skin weights');for(let k=0;k<4;k++)weights[i+k]/=sum;}w.setArray(weights).setNormalized(false);j.setArray(joints).setNormalized(false);}
 // Removed source clips and replaced attributes must not retain dead buffers.
 for(const a of doc.getRoot().listAccessors())if(a.listParents().every(p=>p.propertyType==='Root'))a.dispose();
 const path=join(out,id+'.glb');await io.write(path,doc);const bytes=await readFile(path);
 await sharp(join(input,id+'-preview.png')).resize(320,320,{fit:'inside'}).webp({quality:85}).toFile(join(out,id+'.webp'));
 let triangles=0;for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives())triangles+=(p.getIndices()?.getCount()||p.getAttribute('POSITION').getCount())/3;
 let credits=JSON.parse(await readFile(join(input,id+'-finished.json'))).result.task.consumed_credits;
 if(humanoid)credits+=JSON.parse(await readFile(join(input,id+'-rig-finished.json'))).result.task.consumed_credits+JSON.parse(await readFile(join(input,id+'-attack-finished.json'))).result.task.consumed_credits;
 models[id]={file:spec.model,poster:spec.poster,taskId:jobs[id].taskId,rigTaskId:rigs[id]?.taskId||null,attackTaskId:attacks[id]?.taskId||null,actionId:attacks[id]?.actionId||null,consumedCredits:credits,...rig,triangles,repairedNormals,animations:doc.getRoot().listAnimations().map(a=>({name:a.getName(),channels:a.listChannels().length,duration:Math.max(...a.listSamplers().map(s=>s.getInput().getMax([])[0]))})),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 console.log(JSON.stringify({id,bytes:bytes.length,triangles,joints:rig.joints,animations:models[id].animations.map(a=>a.name)}));
}
let manifest={generator:'Meshy',models:{}};try{manifest=JSON.parse(await readFile(join(out,'manifest.json')));}catch{}
Object.assign(manifest.models,models);manifest.models=Object.fromEntries(['protocol','vanguard','bloom','swarm','pack'].flatMap(faction=>TROOP_CLASSES.map(role=>faction+'-'+role.id)).filter(id=>manifest.models[id]).map(id=>[id,manifest.models[id]]));await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
