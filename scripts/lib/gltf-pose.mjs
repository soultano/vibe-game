import { Matrix4,Vector3,Quaternion } from 'three';

export function animatedGeometry(doc, clipName, time) {
  const transforms=new Map(),worlds=new Map(),animation=doc.getRoot().listAnimations().find(clip=>clip.getName()===clipName);
  const nodes=doc.getRoot().listNodes();
  for(const node of nodes)transforms.set(node,{translation:[...node.getTranslation()],rotation:[...node.getRotation()],scale:[...node.getScale()]});
  for(const channel of animation?.listChannels()||[]){
    const sampler=channel.getSampler(),times=sampler.getInput().getArray(),values=sampler.getOutput().getArray(),path=channel.getTargetPath(),size=path==='rotation'?4:3;
    let index=0;while(index<times.length-2&&times[index+1]<=time)index++;
    const next=Math.min(index+1,times.length-1),alpha=sampler.getInterpolation()==='STEP'?0:Math.max(0,Math.min(1,(time-times[index])/(times[next]-times[index]||1)));
    const a=Array.from(values.subarray(index*size,index*size+size)),b=Array.from(values.subarray(next*size,next*size+size));
    transforms.get(channel.getTargetNode())[path]=path==='rotation'?new Quaternion().fromArray(a).slerp(new Quaternion().fromArray(b),alpha).toArray():a.map((value,i)=>value+(b[i]-value)*alpha);
  }
  function world(node){
    if(worlds.has(node))return worlds.get(node);
    const value=transforms.get(node),local=new Matrix4().compose(new Vector3().fromArray(value.translation),new Quaternion().fromArray(value.rotation),new Vector3().fromArray(value.scale));
    const parent=node.listParents().find(value=>value.propertyType==='Node');
    if(parent)local.premultiply(world(parent));worlds.set(node,local);return local;
  }
  const primitives=[];
  for(const node of nodes){
    if(!node.getMesh())continue;
    const skin=node.getSkin(),joints=skin?.listJoints(),inverse=skin?.getInverseBindMatrices().getArray();
    const matrices=joints?.map((joint,i)=>world(joint).clone().multiply(new Matrix4().fromArray(inverse,i*16)));
    for(const primitive of node.getMesh().listPrimitives()){
      const p=primitive.getAttribute('POSITION').getArray(),j=primitive.getAttribute('JOINTS_0')?.getArray(),w=primitive.getAttribute('WEIGHTS_0')?.getArray(),positions=new Float32Array(p.length);
      for(let i=0;i<p.length/3;i++){
        const v=new Vector3().fromArray(p,i*3),result=new Vector3();
        if(matrices&&j&&w){for(let k=0;k<4;k++)if(w[i*4+k]>0)result.addScaledVector(v.clone().applyMatrix4(matrices[j[i*4+k]]),w[i*4+k]);}
        else result.copy(v).applyMatrix4(world(node));
        result.toArray(positions,i*3);
      }
      primitives.push({positions,indices:primitive.getIndices()?.getArray(),uv:primitive.getAttribute('TEXCOORD_0')?.getArray(),material:primitive.getMaterial()});
    }
  }
  return primitives;
}
