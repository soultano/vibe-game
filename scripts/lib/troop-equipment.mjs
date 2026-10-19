import { BoxGeometry, CylinderGeometry } from 'three';

// The A-pose generator removes hand-held equipment for rigging. Restore the
// faction's weapon as rigid geometry parented to the animated hand, rather than
// baking a rifle into the deforming body or letting it float in world space.
export function equipHumanoid(doc, id) {
  if(id==='bloom-infantry')return;
  const hand=doc.getRoot().listNodes().find(node=>node.getName()==='RightHand');
  if(!hand)throw new Error('Weapon hand missing: '+id);
  const atlas=id==='vanguard-ultimate',height=atlas?500:180;
  const buffer=doc.getRoot().listBuffers()[0],steel=doc.createMaterial('WeaponSteel').setBaseColorFactor(id.startsWith('protocol')?[.11,.2,.26,1]:[.16,.18,.13,1]).setMetallicFactor(.8).setRoughnessFactor(.4);
  const light=doc.createMaterial('WeaponAccent').setBaseColorFactor(id.startsWith('protocol')?[.1,.8,1,1]:[1,.45,.08,1]).setEmissiveFactor(id.startsWith('protocol')?[.04,.5,.8]:[.6,.15,.01]).setRoughnessFactor(.35);
  const root=doc.createNode('AnimatedWeapon');hand.addChild(root);
  function piece(name,geometry,position,material=steel,parent=root){
    const primitive=doc.createPrimitive().setMaterial(material);
    for(const[semantic,name]of [['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv']]){
      const a=geometry.getAttribute(name);primitive.setAttribute(semantic,doc.createAccessor().setType(a.itemSize===2?'VEC2':'VEC3').setArray(new Float32Array(a.array)).setBuffer(buffer));
    }
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(geometry.index.array)).setBuffer(buffer));
    const node=doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive)).setTranslation(position);parent.addChild(node);geometry.dispose();return node;
  }
  const length=height*(atlas?.3:.34),width=height*(atlas?.09:.045);
  piece('Receiver',new BoxGeometry(width,length*.48,width*.7),[0,length*.18,0]);
  piece('Grip',new BoxGeometry(width*.6,width*1.2,width*1.7),[0,0,-width*.5]);
  piece('EnergySpine',new BoxGeometry(width*.8,length*.35,width*.15),[0,length*.2,width*.42],light);
  if(atlas){
    for(let i=0;i<6;i++){
      const angle=i/6*Math.PI*2;piece('RotaryBarrel_'+i,new CylinderGeometry(width*.12,width*.14,length*.65,8),[Math.cos(angle)*width*.36,length*.66,Math.sin(angle)*width*.36]);
    }
    const shieldHand=doc.getRoot().listNodes().find(node=>node.getName()==='LeftForeArm');
    const shield=doc.createNode('AnimatedShield');shieldHand.addChild(shield);
    piece('BallisticShield',new BoxGeometry(height*.24,height*.38,height*.035),[0,height*.12,0],steel,shield);
    piece('ShieldSignal',new BoxGeometry(height*.2,height*.015,height*.04),[0,height*.23,height*.01],light,shield);
  }else{
    piece('Barrel',new CylinderGeometry(width*.19,width*.22,length*.55,10),[0,length*.67,0]);
    piece('Magazine',new BoxGeometry(width*.65,length*.17,width*.6),[0,length*.12,-width*.7]);
    piece('Optic',new BoxGeometry(width*.5,length*.13,width*.4),[0,length*.22,width*.6]);
  }
}
