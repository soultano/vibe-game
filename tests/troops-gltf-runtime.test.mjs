// Actual Three.js GLTFLoader, SkeletonUtils and AnimationMixer in Node.
// Only image bitmap creation is adapted; no browser or WebGL is started.
import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import sharp from'sharp';import{GLTFLoader}from'three/addons/loaders/GLTFLoader.js';import{clone}from'three/addons/utils/SkeletonUtils.js';import{AnimationMixer,Vector3}from'three';import{normalizeHeadquarters,disposeHeadquarters}from'../src/client/model-geometry.js';
globalThis.self=globalThis;
globalThis.createImageBitmap=async blob=>{const info=await sharp(Buffer.from(await blob.arrayBuffer())).metadata();return{width:info.width,height:info.height,close(){}};};
test('every shipped GLB loads and animates with the same Three.js classes used by the game',async t=>{
 const manifest=JSON.parse(await readFile(new URL('../src/client/assets/troops/manifest.json',import.meta.url)));
 for(const[id,record]of Object.entries(manifest.models))await t.test(id,async()=>{
  const bytes=await readFile(new URL('../src/client'+record.file,import.meta.url)),gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  const one=normalizeHeadquarters(clone(gltf.scene)),two=normalizeHeadquarters(clone(gltf.scene));let mesh,other;
  one.traverse(n=>{if(n.isSkinnedMesh&&!mesh)mesh=n;});two.traverse(n=>{if(n.isSkinnedMesh&&!other)other=n;});
  assert.ok(mesh&&other);assert.notStrictEqual(mesh.skeleton.bones[0],other.skeleton.bones[0]);assert.strictEqual(mesh.geometry,other.geometry);
  const mixer=new AnimationMixer(one),clip=gltf.animations.find(c=>c.name==='walk');mixer.clipAction(clip).play();mixer.update(0);one.updateMatrixWorld(true);
  const indices=Array.from({length:20},(_,i)=>Math.floor(i/20*mesh.geometry.attributes.position.count));
  const first=indices.map(index=>mesh.getVertexPosition(index,new Vector3()).applyMatrix4(mesh.matrixWorld));
  mixer.update(clip.duration*.25);one.updateMatrixWorld(true);
  const movement=indices.reduce((max,index,i)=>Math.max(max,first[i].distanceTo(mesh.getVertexPosition(index,new Vector3()).applyMatrix4(mesh.matrixWorld))),0);
  assert.ok(movement>.001,`${id} must animate after real loader parsing and skeleton cloning`);
  mixer.stopAllAction();mixer.uncacheRoot(one);one.traverse(n=>n.skeleton?.dispose());two.traverse(n=>n.skeleton?.dispose());disposeHeadquarters(gltf.scene);
 });
});
