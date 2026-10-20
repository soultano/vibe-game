import { WebGLRenderer,Scene,OrthographicCamera,HemisphereLight,DirectionalLight,AnimationMixer,LoopOnce,LoopRepeat,Group,BufferGeometry,BufferAttribute,LineSegments,LineBasicMaterial,Color,Mesh,MeshBasicMaterial,RingGeometry,SphereGeometry,DoubleSide,SRGBColorSpace,ACESFilmicToneMapping } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { normalizeHeadquarters,disposeHeadquarters } from './model-geometry.js';
import { createAssetLibrary } from './asset-library.js';
import { troopFor } from '../shared/troops.js';

const factorFor=zoom=>Math.max(.75,Math.min(2.2,zoom/1024));
export function createTroops3D({ canvas,onReady=()=>{},onUnavailable=()=>{},reducedMotion=false,maxUnits=36 }={}) {
  const surface=document.createElement('canvas'),renderer=new WebGLRenderer({canvas:surface,alpha:true,antialias:false,powerPreference:'low-power'});
  renderer.setPixelRatio(1);renderer.setClearColor(0,0);renderer.outputColorSpace=SRGBColorSpace;renderer.toneMapping=ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  const scene=new Scene(),camera=new OrthographicCamera(-500,500,400,-400,.1,10000);
  camera.position.set(0,900,1200);camera.lookAt(0,0,0);
  scene.add(new HemisphereLight(0xdaf2ff,0x283247,3));
  const sun=new DirectionalLight(0xfff0de,3.6);sun.position.set(-300,700,400);scene.add(sun);
  const rim=new DirectionalLight(0xa0dfff,1.8);rim.position.set(400,300,-400);scene.add(rim);
  const actors=new Map(),loader=new GLTFLoader(),pending=[];
  let loads=0,disposed=false,lost=false,visibleCount=0,animated=false,lastTime=null,preview=null,lastSize='';
  function queueLoad(work) { return new Promise((resolve,reject)=>{pending.push({work,resolve,reject});drain();}); }
  function drain(){while(loads<3&&pending.length&&!disposed){const task=pending.shift();loads++;task.work().then(task.resolve,task.reject).finally(()=>{loads--;drain();});}}
  const library=createAssetLibrary({
    load:id=>queueLoad(async()=>{const gltf=await loader.loadAsync('/assets/troops/'+id+'.glb');return{scene:gltf.scene,animations:gltf.animations};}),
    makeStamp:()=>null,disposeAsset:asset=>disposeHeadquarters(asset.scene),onReady,onError:id=>{if(preview?.id===id)preview.fallback();onUnavailable(id);},
  });
  const shotPositions=new Float32Array(maxUnits*6),shotColors=new Float32Array(maxUnits*6);
  const shotGeometry=new BufferGeometry().setAttribute('position',new BufferAttribute(shotPositions,3)).setAttribute('color',new BufferAttribute(shotColors,3));
  const shots=new LineSegments(shotGeometry,new LineBasicMaterial({vertexColors:true,transparent:true,opacity:.9,depthTest:false}));shots.frustumCulled=false;scene.add(shots);
  const ringGeometry=new RingGeometry(.9,1,32),domeGeometry=new SphereGeometry(1,20,10,0,Math.PI*2,0,Math.PI/2);
  function effects(color){
    const ring=new Mesh(ringGeometry,new MeshBasicMaterial({color,transparent:true,opacity:.5,side:DoubleSide,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.visible=false;
    const dome=new Mesh(domeGeometry,new MeshBasicMaterial({color,transparent:true,opacity:.13,side:DoubleSide,depthWrite:false}));dome.visible=false;
    scene.add(ring,dome);return{ring,dome};
  }
  function actorFor(unit){
    if(actors.has(unit.key))return actors.get(unit.key);
    const actor={key:unit.key,id:unit.id,root:null,mixer:null,action:null,mode:null,loading:true,phase:unit.phase||0,...effects(unit.color)};
    actors.set(unit.key,actor);
    library.ensure(unit.id).then(asset=>{
      if(disposed||actors.get(unit.key)!==actor)return;
      const content=clone(asset.scene),normalized=normalizeHeadquarters(content),root=new Group();root.add(normalized);
      const mixer=new AnimationMixer(root);
      root.traverse(node=>{if(node.isMesh)node.frustumCulled=false;});
      actor.root=root;actor.mixer=mixer;actor.clips=asset.animations;actor.loading=false;scene.add(root);onReady();
    }).catch(()=>{actor.loading=false;});
    return actor;
  }
  function play(actor,mode){
    if(!actor.mixer||actor.mode===mode)return;
    const clip=actor.clips.find(value=>value.name===mode)||actor.clips.find(value=>value.name==='idle');if(!clip)return;
    const previous=actor.action,action=actor.mixer.clipAction(clip);action.reset().setLoop(mode==='death'?LoopOnce:LoopRepeat,Infinity);action.clampWhenFinished=mode==='death';action.play();
    if(previous&&previous!==action)previous.crossFadeTo(action,.16,false);
    actor.mode=mode;actor.action=action;
    if(mode==='walk'||mode==='idle')action.time=actor.phase*clip.duration;
  }
  function removeActor(key){const actor=actors.get(key);if(!actor)return;actor.mixer?.stopAllAction();if(actor.root){actor.mixer?.uncacheRoot(actor.root);actor.root.traverse(node=>node.skeleton?.dispose());scene.remove(actor.root);}scene.remove(actor.ring,actor.dome);actor.ring.material.dispose();actor.dome.material.dispose();actors.delete(key);}
  function size(width,height){const key=width+'x'+height;if(key!==lastSize){renderer.setSize(width,height,false);lastSize=key;}}
  function copy(target){const context=target.getContext('2d');context.clearRect(0,0,target.width,target.height);context.drawImage(surface,0,0,target.width,target.height);}
  function renderPreview(delta){
    if(!preview?.actor?.root)return;
    const {actor,target,mode}=preview;
    for(const value of actors.values()){if(value.root)value.root.visible=value===actor;value.ring.visible=value.dome.visible=false;}
    play(actor,mode);actor.mixer.update(reducedMotion?0:delta);
    actor.root.position.set(0,-.75,0);actor.root.scale.setScalar(1);actor.root.rotation.y=preview.angle;
    camera.left=-1.7;camera.right=1.7;camera.top=1.7;camera.bottom=-1.7;camera.position.set(3.2,2.6,4.4);camera.lookAt(0,0,0);camera.updateProjectionMatrix();
    shotGeometry.setDrawRange(0,0);size(512,512);renderer.render(scene,camera);copy(target);preview.ready();
  }
  function render(now,view){
    if(disposed||lost||document.hidden)return;
    const delta=lastTime===null?0:Math.min(.08,Math.max(0,(now-lastTime)/1000));lastTime=now;
    if(preview){renderPreview(delta);return;}
    const {width,height,units,projectCell,zoom}=view;
    animated=false;visibleCount=0;
    camera.left=-width/2;camera.right=width/2;camera.top=height/2;camera.bottom=-height/2;camera.position.set(0,900,1200);camera.lookAt(0,0,0);camera.updateProjectionMatrix();
    const keep=new Set();let shotCount=0;
    for(const unit of units.slice(0,maxUnits)){
      const to=projectCell(unit.cell);if(!to)continue;
      const from=unit.fromCell?projectCell(unit.fromCell):null,progress=unit.progress??1;
      let x=(from?from.x+(to.x-from.x)*progress:to.x)+unit.offsetX,y=(from?from.y+(to.y-from.y)*progress:to.y)+unit.offsetY;
      if(x< -100||x>width+100||y< -130||y>height+100)continue;
      keep.add(unit.key);const actor=actorFor(unit);visibleCount++;
      if(!actor.root)continue;
      const target=unit.target?projectCell(unit.target):null;
      const factor=Math.max(.75,Math.min(2.2,zoom/1024)),scale=unit.size*factor/2;
      const elevation=unit.type==='air'?20*factor:unit.id==='protocol-ultimate'?7*factor:0;
      actor.root.visible=true;actor.root.position.set(x-width/2,elevation,(y-height/2)/.6);actor.root.scale.setScalar(scale);
      const heading=target?{x:target.x-x,y:target.y-y}:from?{x:to.x-from.x,y:to.y-from.y}:null;
      if(heading && Math.hypot(heading.x,heading.y)>.01)actor.heading=Math.atan2(heading.x,heading.y/.6);
      actor.root.rotation.y=actor.heading??Math.PI;
      play(actor,unit.animation);actor.mixer.update(reducedMotion?0:delta);
      if(!reducedMotion&&unit.animation!=='idle'&&(unit.animation!=='death'||actor.action?.isRunning()))animated=true;
      const phase=(now/1250+unit.phase)%1;
      if(target&&unit.animation==='attack'&&phase>.18&&phase<.32&&shotCount<maxUnits){
        const index=shotCount*6,c=new Color(unit.color);
        shotPositions.set([x-width/2,elevation+scale*.8,(y-height/2)/.6,target.x-width/2,3,(target.y-height/2)/.6],index);
        shotColors.set([c.r,c.g,c.b,c.r,c.g,c.b],index);shotCount++;
      }
      actor.ring.visible=!!unit.capture||unit.ultimate;
      actor.ring.position.set(x-width/2,.6,(y-height/2)/.6);actor.ring.scale.setScalar(unit.capture?(8+phase*14)*factor:unit.size*(.65+phase*.2)*factor);
      actor.ring.material.opacity=unit.capture ? .65 : .2;
      actor.dome.visible=unit.id==='protocol-ultimate';actor.dome.position.copy(actor.root.position);actor.dome.position.y=0;actor.dome.scale.setScalar(unit.size*.8*factor);
    }
    for(const key of actors.keys())if(!keep.has(key))removeActor(key);
    shotGeometry.setDrawRange(0,shotCount*2);shotGeometry.getAttribute('position').needsUpdate=true;shotGeometry.getAttribute('color').needsUpdate=true;
    const ratio=Math.min(1.25,globalThis.devicePixelRatio||1),w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    size(w,h);renderer.render(scene,camera);copy(canvas);
    const hud=canvas.getContext('2d'),sx=canvas.width/width,sy=canvas.height/height;
    hud.save();hud.scale(sx,sy);
    for(const unit of units.slice(0,maxUnits)){if(!(unit.hp>0))continue;const to=projectCell(unit.cell);if(!to)continue;const from=unit.fromCell?projectCell(unit.fromCell):null,p=unit.progress??1;const x=(from?from.x+(to.x-from.x)*p:to.x)+unit.offsetX,y=(from?from.y+(to.y-from.y)*p:to.y)+unit.offsetY-unit.size*factorFor(zoom)-8;hud.fillStyle='#07120ee6';hud.fillRect(x-15,y,30,5);hud.fillStyle=unit.neutral?'#e58554':unit.color;hud.fillRect(x-14,y+1,28*Math.max(0,Math.min(1,unit.hp/unit.maxHp)),3);}
    hud.restore();
  }
  surface.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;preview?.fallback();onUnavailable();});
  return {
    render,
    needsFrame(){return !disposed&&!lost&&!document.hidden&&!reducedMotion&&(preview?!!preview.actor?.root&&(preview.mode!=='death'||preview.actor.action?.isRunning()):animated&&visibleCount>0);},
    inspect(target,faction,type,{ready=()=>{},fallback=()=>{}}={}){
      if(lost||disposed){fallback();return;}
      if(preview)removeActor(preview.actor.key);
      const spec=troopFor(faction,type),unit={...spec,key:'preview:'+spec.id,phase:0};
      // Explicit inspection permits a retry after a transient download error.
      library.retry(spec.id).catch(()=>{});
      const actor=actorFor(unit);preview={id:spec.id,actor,target,mode:'walk',angle:-.25,ready,fallback};target.width=target.height=512;
      onReady();
    },
    animate(name){if(!preview)return;preview.mode=name;preview.actor.mode=null;lastTime=null;onReady();},
    rotate(delta){if(!preview)return;preview.angle+=delta;onReady();},
    close(){if(preview){removeActor(preview.actor.key);preview=null;}lastTime=null;onReady();},
    clear(){for(const key of [...actors.keys()])removeActor(key);preview=null;animated=false;lastTime=null;canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);},
    dispose(){this.clear();disposed=true;for(const task of pending.splice(0))task.reject(new Error('Renderer disposed'));library.dispose();shotGeometry.dispose();shots.material.dispose();ringGeometry.dispose();domeGeometry.dispose();renderer.dispose();renderer.forceContextLoss();},
  };
}
