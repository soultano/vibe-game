import { Matrix4, Vector3, Quaternion, Euler } from 'three';

export function addTrack(doc, animation, node, path, times, values) {
  const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer);
  const output = doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values)).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
  animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
}
const rotation = (x,y,z) => new Quaternion().setFromEuler(new Euler(x,y,z)).toArray();

// Custom skeletons for creatures, wings, vehicle guns and floating mechanisms.
// Bind positions and skin weights are stored in GLB, so clips work in any glTF
// engine; movement is not a client-only bob of a rigid model.
export function rigCreature(doc, id) {
  const meshNodes = doc.getRoot().listNodes().filter(node => node.getMesh());
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (const node of meshNodes) {
    const matrix = new Matrix4().fromArray(node.getWorldMatrix());
    for (const primitive of node.getMesh().listPrimitives()) {
      const attribute = primitive.getAttribute('POSITION'), array = attribute.getArray();
      for (let i=0;i<array.length;i+=3) {
        const v = new Vector3(array[i],array[i+1],array[i+2]).applyMatrix4(matrix);
        for (let j=0;j<3;j++) { array[i+j]=v.getComponent(j); lo[j]=Math.min(lo[j],array[i+j]); hi[j]=Math.max(hi[j],array[i+j]); }
      }
    }
  }
  const scale = 2 / Math.max(...hi.map((value,i)=>value-lo[i]));
  if (!Number.isFinite(scale)) throw new Error('Empty troop mesh: '+id);
  const center = [(lo[0]+hi[0])/2,lo[1],(lo[2]+hi[2])/2];
  for (const node of meshNodes) {
    node.setMatrix(new Matrix4().toArray());
    for (const primitive of node.getMesh().listPrimitives()) {
      const array = primitive.getAttribute('POSITION').getArray();
      for (let i=0;i<array.length;i++) array[i]=(array[i]-center[i%3])*scale;
    }
  }
  const w=(hi[0]-lo[0])*scale,h=(hi[1]-lo[1])*scale,d=(hi[2]-lo[2])*scale;
  const root = doc.createNode('TroopRoot');
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const node of [...scene.listChildren()]) scene.removeChild(node);
  scene.addChild(root);
  const bones=[];
  function bone(name,position,parent=0,extra={}) {
    const index=bones.length,node=doc.createNode(name),parentBone=bones[parent];
    node.setTranslation(position.map((value,i)=>value-(parentBone?.position[i]||0)));
    (parentBone?.node||root).addChild(node);
    bones.push({name,node,position,parent,...extra});return index;
  }
  bone('Body',[0,h*.52,0],null,{kind:'body'});
  const head=bone('Head',[0,h*.62,d*.28],0,{kind:'head'});
  const tank=id==='vanguard-armor',omega=id==='protocol-ultimate',air=id.endsWith('-air');
  const plane=air&&['protocol-air','vanguard-air'].includes(id);
  const legPairs = id==='swarm-ultimate'?6:id==='swarm-armor'||id==='bloom-ultimate'||id==='pack-ultimate'?3:2;
  const legs=[]; let turret,barrel;
  if (tank) {
    turret=bone('Turret',[0,h*.63,0],0,{kind:'turret'});
    barrel=bone('Barrel',[0,h*.69,d*.16],turret,{kind:'barrel'});
    bone('Track_L',[-w*.38,h*.2,0],0,{kind:'track',side:-1});
    bone('Track_R',[w*.38,h*.2,0],0,{kind:'track',side:1});
  } else if (omega) {
    for (const side of [-1,1]) bone('Ring_'+(side<0?'L':'R'),[side*w*.32,h*.52,0],0,{kind:'ring',side});
    bone('Ring_Top',[0,h*.78,0],0,{kind:'ring',side:0});
  } else if (air) {
    for (const side of [-1,1]) {
      const wing=bone('Wing_'+(side<0?'L':'R'),[side*w*.12,h*.58,0],0,{kind:'wing',side});
      bone('WingTip_'+(side<0?'L':'R'),[side*w*.38,h*.6,0],wing,{kind:'wingtip',side});
      if (id==='swarm-air') bone('HindWing_'+(side<0?'L':'R'),[side*w*.12,h*.48,-d*.2],0,{kind:'hindwing',side});
      if (id==='vanguard-air') for (const end of [-1,1]) bone(`Rotor_${side}_${end}`,[side*w*.35,h*.86,end*d*.25],0,{kind:'rotor',side,end});
    }
  } else {
    for (let row=0;row<legPairs;row++) for (const side of [-1,1]) {
      const z=legPairs===1?0:(row/(legPairs-1)-.5)*d*.6;
      const upper=bone(`Leg_${row}_${side}`,[side*w*.25,h*.44,z],0,{kind:'leg',row,side});
      const lower=bone(`Knee_${row}_${side}`,[side*w*.3,h*.2,z],upper,{kind:'knee',row,side});
      legs.push({upper,lower,side,z});
    }
    if (id==='swarm-infantry') for (const side of [-1,1]) bone('Scythe_'+side,[side*w*.2,h*.63,d*.22],0,{kind:'claw',side});
    if (id==='swarm-ultimate') for (let row=0;row<5;row++) bone('Carapace_'+row,[0,h*.65,(row/4-.5)*d*.75],0,{kind:'carapace',row});
  }
  function weights(x,y,z) {
    const side=x<0?-1:1;
    if (tank) {
      if (y>h*.55) return [[z>d*.2?barrel:turret,1]];
      if (y<h*.35 && Math.abs(x)>w*.24) return [[bones.findIndex(b=>b.kind==='track'&&b.side===side),1]];
    } else if (omega) {
      if(Math.abs(x)>w*.2) return [[bones.findIndex(b=>b.kind==='ring'&&b.side===side),1]];
      if(y>h*.73) return [[bones.findIndex(b=>b.name==='Ring_Top'),.85],[0,.15]];
    } else if (air) {
      if(id==='vanguard-air'&&y>h*.79&&Math.abs(x)>w*.2){const end=z<0?-1:1;return [[bones.findIndex(b=>b.kind==='rotor'&&b.side===side&&b.end===end),1]];}
      if(Math.abs(x)>w*.15 && y>h*.2){
        const kind=id==='swarm-air'&&z< -d*.12?'hindwing':Math.abs(x)>w*.34?'wingtip':'wing';
        const index=bones.findIndex(b=>b.kind===kind&&b.side===side);
        return [[index,.96],[0,.04]];
      }
    } else {
      if(id==='swarm-infantry'&&y>h*.47&&z>d*.12&&Math.abs(x)>w*.16) return [[bones.findIndex(b=>b.kind==='claw'&&b.side===side),.95],[0,.05]];
      if(y<h*.48&&Math.abs(x)>w*.09){
        const leg=legs.filter(leg=>leg.side===side).sort((a,b)=>Math.abs(a.z-z)-Math.abs(b.z-z))[0];
        const lower=Math.max(0,Math.min(1,(h*.29-y)/(h*.18)));
        return [[leg.upper,1-lower],[leg.lower,lower]];
      }
      if(id==='swarm-ultimate'&&y>h*.5){const parts=bones.filter(b=>b.kind==='carapace'),p=parts.sort((a,b)=>Math.abs(a.position[2]-z)-Math.abs(b.position[2]-z))[0];return [[bones.indexOf(p),.8],[0,.2]];}
    }
    if(z>d*.25&&y>h*.4&&!omega)return [[head,.8],[0,.2]];
    return [[0,1]];
  }
  const buffer=doc.getRoot().listBuffers()[0],skin=doc.createSkin('FactionSkeleton');
  const inverse=[];
  for(const b of bones){skin.addJoint(b.node);inverse.push(...new Matrix4().makeTranslation(-b.position[0],-b.position[1],-b.position[2]).toArray());}
  skin.setSkeleton(bones[0].node).setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(new Float32Array(inverse)).setBuffer(buffer));
  for(const node of meshNodes){
    scene.addChild(node);node.setSkin(skin);
    for(const primitive of node.getMesh().listPrimitives()){
      const position=primitive.getAttribute('POSITION').getArray(),indices=new Uint16Array(position.length/3*4),values=new Float32Array(indices.length);
      for(let i=0;i<position.length/3;i++)weights(...position.subarray(i*3,i*3+3)).forEach(([joint,value],j)=>{if(joint<0)throw new Error('Invalid joint '+id);if(value>0){indices[i*4+j]=joint;values[i*4+j]=value;}});
      primitive.setAttribute('JOINTS_0',doc.createAccessor().setType('VEC4').setArray(indices).setBuffer(buffer));
      primitive.setAttribute('WEIGHTS_0',doc.createAccessor().setType('VEC4').setArray(values).setBuffer(buffer));
    }
  }
  for(const [name,duration] of [['idle',2.4],['walk',1.2],['run',.65],['attack',1.4],['capture',2],['death',1.5]]){
    const animation=doc.createAnimation(name),times=Array.from({length:25},(_,i)=>i*duration/24);
    for(const b of bones){
      const values=[],translations=[];
      for(let i=0;i<times.length;i++){
        const t=i/24,cycle=t*Math.PI*2,swing=Math.sin(cycle),strike=Math.sin(Math.PI*Math.max(0,Math.min(1,(t-.15)/.65)));
        let x=0,y=0,z=0,dx=0,dy=0,dz=0;
        const moving=name==='walk'||name==='run',flying=air&&(name!=='death');
        if(b.kind==='body'){
          if(name==='death'){z=t*Math.PI*.48;dy=-h*.35*t;}
          else if(moving){dy=Math.abs(swing)*h*.018;z=swing*.018;}
          else if(name==='attack'){x=-strike*(tank?.04:.12);dz=strike*d*.07;}
          else dy=Math.sin(cycle)*h*.009;
        }
        if(b.kind==='leg'&&moving)x=Math.sin(cycle+(b.row+b.side)*Math.PI/2)*.42;
        if(b.kind==='knee'&&moving)x=Math.max(0,-Math.sin(cycle+(b.row+b.side)*Math.PI/2))*.6;
        if(b.kind==='leg'&&name==='attack')x=strike*(b.row===legPairs-1?-.38:.15);
        if(['wing','wingtip','hindwing'].includes(b.kind)&&flying)z=Math.sin(cycle+(b.kind==='hindwing'?Math.PI:.0))*b.side*(plane?.025:b.kind==='wingtip'?.3:.55);
        if(b.kind==='rotor'&&flying)y=t*Math.PI*8;
        if(b.kind==='head'&&name==='attack')x=-strike*.24;
        if(b.kind==='head'&&name==='capture')x=Math.sin(Math.PI*t)*.23;
        if(b.kind==='claw'&&name==='attack'){x=-strike*.8;z=b.side*strike*.25;}
        if(b.kind==='turret'&&name==='attack')x=-strike*.04;
        if(b.kind==='barrel'&&name==='attack')dz=-Math.max(0,Math.sin(Math.PI*Math.min(1,Math.max(0,(t-.3)/.25))))*d*.12;
        if(b.kind==='track'&&moving)x=swing*.014;
        if(b.kind==='carapace'){y=Math.sin(cycle+b.row*.65)*.055;if(name==='attack')x=strike*.2;}
        if(b.kind==='ring'){x=swing*.15*b.side;z=(name==='attack'||name==='capture'?strike:.15*swing)*.22*b.side;dx=b.side*(name==='attack'?strike*w*.08:0);}
        values.push(...rotation(x,y,z));
        const parent=bones[b.parent];translations.push(...b.position.map((v,j)=>v-(parent?.position[j]||0)+[dx,dy,dz][j]));
      }
      addTrack(doc,animation,b.node,'rotation',times,values);
      if(b.kind==='body'||b.kind==='barrel'||b.kind==='ring')addTrack(doc,animation,b.node,'translation',times,translations);
    }
  }
  return {joints:bones.length,rig:'authored-creature-skeleton',height:h};
}

export function copyMotion(doc, source, name) {
  const nodes=new Map(doc.getRoot().listNodes().map(node=>[node.getName(),node]));
  const original=source.getRoot().listAnimations()[0];if(!original)throw new Error('Missing source animation '+name);
  const animation=doc.createAnimation(name);
  for(const channel of original.listChannels()){
    const node=nodes.get(channel.getTargetNode()?.getName());if(!node)continue;
    const sampler=channel.getSampler(),times=Array.from(sampler.getInput().getArray()),values=Array.from(sampler.getOutput().getArray()),path=channel.getTargetPath();
    // Play motion in place. World movement follows server cells independently.
    if(path==='translation'&& /hips|pelvis|root/i.test(node.getName()))for(let i=0;i<values.length;i+=3){values[i]=values[0];values[i+2]=values[2];}
    addTrack(doc,animation,node,path,times,values);
  }
  if(!animation.listChannels().length)throw new Error('No compatible rig channels for '+name);
}

export function addHumanoidUtilityClips(doc) {
  const nodes=doc.getRoot().listNodes(),joint=nodes.find(n=>/spine/i.test(n.getName()))||nodes.find(n=>/hips/i.test(n.getName()));
  if(!joint)throw new Error('Humanoid rig has no torso');
  const base=joint.getRotation(),q0=new Quaternion().fromArray(base);
  for(const name of ['idle','capture','death']){
    const a=doc.createAnimation(name),duration=name==='death'?1.5:2,times=[0,duration*.25,duration*.5,duration*.75,duration],values=[];
    times.forEach((time,i)=>{const angle=name==='death'?i/4*1.15:Math.sin(i/4*Math.PI*2)*(name==='capture'?.16:.025);values.push(...q0.clone().multiply(new Quaternion().setFromEuler(new Euler(angle,0,name==='death'?angle*.5:0))).toArray());});
    addTrack(doc,a,joint,'rotation',times,values);
  }
}

export async function groundAnimations(doc) {
  const { animatedGeometry } = await import('./gltf-pose.mjs');
  const scene=doc.getRoot().getDefaultScene()||doc.getRoot().listScenes()[0],ground=doc.createNode('GroundContact');
  for(const node of [...scene.listChildren()])if(!node.getSkin()){scene.removeChild(node);ground.addChild(node);}
  scene.addChild(ground);
  for(const clip of doc.getRoot().listAnimations()){
    const duration=Math.max(...clip.listSamplers().map(s=>s.getInput().getMax([])[0])),times=[],values=[];
    for(let frame=0;frame<=24;frame++){
      const time=frame/24*duration;let bottom=Infinity;
      for(const p of animatedGeometry(doc,clip.getName(),time))for(let i=1;i<p.positions.length;i+=3)bottom=Math.min(bottom,p.positions[i]);
      times.push(time);values.push(0,-bottom,0);
    }
    addTrack(doc,clip,ground,'translation',times,values);
  }
}
