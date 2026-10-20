export function footprintBounds(points){
 const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
 return {width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
}
const spriteCrops=new WeakMap();
export function spriteBounds(sprite,canvasFactory=()=>document.createElement('canvas')){
 if(spriteCrops.has(sprite))return spriteCrops.get(sprite);
 const width=sprite.naturalWidth||sprite.width,height=sprite.naturalHeight||sprite.height;let crop={x:0,y:0,width,height};
 try{const surface=canvasFactory();surface.width=width;surface.height=height;const ctx=surface.getContext('2d',{willReadFrequently:true});ctx.drawImage(sprite,0,0);const{data}=ctx.getImageData(0,0,width,height);let l=width,r=-1,t=height,b=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]>8){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  if(r>=l)crop={x:l,y:t,width:r-l+1,height:b-t+1};
 }catch{}
 spriteCrops.set(sprite,crop);return crop;
}
export function headquartersLayout(center,footprint,crop){
 const width=footprint.width,height=width*crop.height/crop.width,bottom=center.y+footprint.height*.4;
 return {crop,width,height,groundHeight:footprint.height,left:center.x-width/2,top:bottom-height,bottom};
}
export function troopSpan(type,footprint,viewport){
 const role={infantry:[48,.30],armor:[70,.46],air:[82,.52],ultimate:[100,.66]}[type]||[48,.30];
 return Math.min(Math.min(viewport.width,viewport.height)*.46,Math.max(role[0],footprint.width*role[1]));
}
export function projectedModelMetrics(bounds,yaw){
 let left=Infinity,right=-Infinity,top=-Infinity,bottom=Infinity;
 const sin=Math.sin(yaw),cos=Math.cos(yaw);
 for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
  const px=x*cos+z*sin,py=y*.8-(-x*sin+z*cos)*.6;left=Math.min(left,px);right=Math.max(right,px);bottom=Math.min(bottom,py);top=Math.max(top,py);
 }
 return {span:Math.max(right-left,top-bottom,.01),top,bottom,width:right-left,height:top-bottom};
}
export const projectedModelSpan=(bounds,yaw)=>projectedModelMetrics(bounds,yaw).span;
function formation(slot,count,footprint,atBase){
 if(atBase){const angle=Math.PI*(.1+.8*(count>1?slot/(count-1):.5));return{x:Math.cos(angle)*footprint.width*.4,y:Math.sin(angle)*footprint.height*.46};}
 if(count<2)return{x:0,y:0};
 const angle=slot*2.3999632297,r=Math.min(.27,.12*Math.sqrt(slot+1));
 return{x:Math.cos(angle)*footprint.width*r,y:Math.sin(angle)*footprint.height*r};
}
// Cosmetic formations stay inside their authoritative cells. They do not orbit,
// choose targets, deal damage or change server positions/ownership.
export function layoutTroops(units,{width,height,projectCell,footprintCell=()=>({width:100,height:85})}){
 const groups=new Map(),points=new Map(),footprints=new Map();
 const point=cell=>{if(!points.has(cell))points.set(cell,projectCell(cell));return points.get(cell);};
 const footprint=cell=>{if(!footprints.has(cell))footprints.set(cell,footprintCell(cell));return footprints.get(cell);};
 for(const u of units)for(const cell of new Set([u.cell,(u.progress??1)<1?u.fromCell:null].filter(Boolean))){if(!groups.has(cell))groups.set(cell,[]);groups.get(cell).push(u.key);}
 for(const keys of groups.values())keys.sort();
 function offset(unit,cell){const group=groups.get(cell)||[unit.key];return formation(group.indexOf(unit.key),group.length,footprint(cell),cell===unit.baseCell);}
 return units.flatMap(unit=>{
  const to=point(unit.cell);if(!to)return[];const from=unit.fromCell?point(unit.fromCell):null,p=unit.progress??1;
  const b=offset(unit,unit.cell),a=from?offset(unit,unit.fromCell):b;
  const x=(from?from.x+(to.x-from.x)*p:to.x)+a.x+(b.x-a.x)*p,y=(from?from.y+(to.y-from.y)*p:to.y)+a.y+(b.y-a.y)*p;
  const span=troopSpan(unit.type,footprint(unit.cell),{width,height});
  if(x< -span||x>width+span||y< -span*2||y>height+span)return[];
  const target=unit.target?point(unit.target):null;
  const heading=target?{x:target.x-x,y:target.y-y}:from?{x:to.x-from.x,y:to.y-from.y}:null;
  return [{unit,x,y,span,from,to,target,heading,progress:p,elevation:unit.type==='air'?span*.3:unit.id==='protocol-ultimate'?span*.1:0}];
 });
}
