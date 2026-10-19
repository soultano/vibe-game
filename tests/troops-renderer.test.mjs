import test from'node:test';import assert from'node:assert/strict';import vm from'node:vm';import{resolve}from'node:path';import{build}from'esbuild';import{Group,Mesh,BoxGeometry,MeshStandardMaterial,AnimationClip,NumberKeyframeTrack}from'three';
const root=resolve(import.meta.dirname,'..');
const bundle=await build({entryPoints:[resolve(root,'src/client/troops-3d.js')],bundle:true,write:false,format:'iife',globalName:'troopsModule',platform:'browser',target:'es2022',plugins:[{name:'gpu-adapter',setup(b){
 b.onResolve({filter:/^three$/},()=>({path:'three',namespace:'adapter'}));
 b.onResolve({filter:/^three\/addons\/loaders\/GLTFLoader\.js$/},()=>({path:'loader',namespace:'adapter'}));
 b.onLoad({filter:/.*/,namespace:'adapter'},({path})=>({resolveDir:root,contents:path==='loader'?'export class GLTFLoader {loadAsync(url){return globalThis.loadModel(url)}}':`export * from ${JSON.stringify(resolve(root,'node_modules/three/build/three.module.js'))}; export class WebGLRenderer{constructor({canvas}){globalThis.gpuCanvas=canvas;}setPixelRatio(){}setClearColor(){}setSize(w,h){globalThis.sizes.push([w,h]);}render(scene){globalThis.paints.push(scene.children.filter(n=>n.isGroup&&n.visible).map(n=>n.rotation.y));}dispose(){}forceContextLoss(){}}`}));
}}]});
function setup(options={}){
 const events=new Map(),requests=new Map(),counts=new Map(),paints=[],sizes=[];
 const canvas=()=>({width:0,height:0,addEventListener(n,f){events.set(n,f);},getContext(){return{clearRect(){},drawImage(){}};}});
 const document={hidden:false,createElement:canvas};
 const context=vm.createContext({document,console,paints,sizes,devicePixelRatio:1,loadModel(url){counts.set(url,(counts.get(url)||0)+1);return new Promise((resolve,reject)=>requests.set(url,{resolve,reject}));}});
 vm.runInContext(bundle.outputFiles[0].text,context);
 const target=canvas(),engine=context.troopsModule.createTroops3D({canvas:target,...options});
 const load=id=>{const scene=new Group(),body=new Mesh(new BoxGeometry(),new MeshStandardMaterial());body.name='Body';scene.add(body);requests.get('/assets/troops/'+id+'.glb').resolve({scene,animations:['idle','walk','run','attack','capture','death'].map(name=>new AnimationClip(name,1,[new NumberKeyframeTrack('Body.rotation[x]',[0,.5,1],[0,.3,0])]))});};
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const unit=(key,id='protocol-infantry')=>({key,id,type:'infantry',color:'#50e7ff',cell:'base',size:22,phase:.2,offsetX:0,offsetY:0,animation:'walk',azimuth:0});
 const view=units=>({width:800,height:600,zoom:1024,units,projectCell:()=>({x:400,y:300})});
 return{engine,context,document,requests,counts,paints,sizes,canvas,load,tick,unit,view,events};
}
test('many soldiers share one downloaded model; hidden and offscreen armies stop animating',async()=>{
 const h=setup(),units=[h.unit('a'),h.unit('b'),h.unit('c')];
 h.engine.render(0,h.view(units));await h.tick();assert.equal(h.requests.size,1);h.load('protocol-infantry');await h.tick();
 h.engine.render(40,h.view(units));assert.equal(h.engine.needsFrame(),true);assert.equal(h.counts.get('/assets/troops/protocol-infantry.glb'),1);
 const before=h.paints.length;h.document.hidden=true;h.engine.render(100,h.view(units));assert.equal(h.paints.length,before);assert.equal(h.engine.needsFrame(),false);
 h.document.hidden=false;h.engine.render(200,{...h.view(units),projectCell:()=>({x:-1000,y:-1000})});assert.equal(h.engine.needsFrame(),false);h.engine.dispose();
});
test('load concurrency is bounded; clearing during a download cannot resurrect ghost models',async()=>{
 const h=setup(),ids=['protocol-infantry','vanguard-infantry','bloom-infantry','swarm-infantry'];
 h.engine.render(0,h.view(ids.map(id=>h.unit(id,id))));await h.tick();assert.equal(h.requests.size,3);
 h.engine.clear();h.load(ids[0]);await h.tick();assert.equal(h.requests.size,4);
 h.engine.render(100,h.view([]));assert.equal(h.paints.at(-1).length,0);h.engine.dispose();
 for(const id of ids.slice(1))h.load(id);await h.tick();
});
test('arsenal renders and switches real clips; context loss calls its fallback',async()=>{
 const h=setup(),target=h.canvas();let ready=0,fallback=0;
 h.engine.inspect(target,'protocol','infantry',{ready(){ready++;},fallback(){fallback++;}});await h.tick();h.load('protocol-infantry');await h.tick();
 h.engine.render(0,h.view([]));assert.equal(ready,1);assert.equal(target.width,512);assert.equal(h.engine.needsFrame(),true);
 h.engine.animate('attack');h.engine.rotate(.5);h.engine.render(100,h.view([]));assert.ok(h.paints.at(-1).some(angle=>Math.abs(angle-.25)<1e-6));
 h.events.get('webglcontextlost')({preventDefault(){}});assert.equal(fallback,1);assert.equal(h.engine.needsFrame(),false);h.engine.dispose();
});
test('reduced motion draws a static pose and never schedules continuous animation',async()=>{
 const h=setup({reducedMotion:true});h.engine.render(0,h.view([h.unit('a')]));await h.tick();h.load('protocol-infantry');await h.tick();h.engine.render(100,h.view([h.unit('a')]));assert.equal(h.engine.needsFrame(),false);h.engine.dispose();
});
