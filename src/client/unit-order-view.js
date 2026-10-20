export const MODES={move:'Идти',attack:'Атаковать',capture:'Захватить',hold:'Удерживать'};
const COLORS={move:'#8cf3c2',attack:'#ff9b88',capture:'#f0d17b',hold:'#a8cdf2'};
export function orderRoute(unit,projectCell,routeStart){
 const goal=unit.order?.cell;if(!goal)return{points:[],goal:null};
 const from=projectCell(unit.fromCell||unit.cell),to=projectCell(unit.cell),p=unit.progress??1;
 const start=routeStart||(from&&to?{x:from.x+(to.x-from.x)*p,y:from.y+(to.y-from.y)*p}:to);
 const cells=[unit.cell,...(unit.waypoints||[])],points=[start,...cells.map(projectCell)].filter(Boolean);
 return{points,goal:projectCell(goal),partial:unit.routePartial};
}
export function drawUnitOrder(ctx,unit,view){
 const {points,goal}=orderRoute(unit,view.projectCell,view.routeStart),color=COLORS[unit.order?.mode]||COLORS.hold;
 ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#041710cf';ctx.lineWidth=7;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
 ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.setLineDash([8,6]);ctx.stroke();ctx.setLineDash([]);
 if(goal&&view.goalMarker!==false){
  const polygon=view.shapeCell?.(unit.order.cell);
  if(polygon){ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=color+'24';ctx.fill();ctx.lineWidth=2;ctx.stroke();}
  ctx.beginPath();ctx.arc(goal.x,goal.y,12,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(goal.x-19,goal.y);ctx.lineTo(goal.x+19,goal.y);ctx.moveTo(goal.x,goal.y-19);ctx.lineTo(goal.x,goal.y+19);ctx.stroke();
  ctx.font='600 12px sans-serif';const label=view.orderLabel||MODES[unit.order.mode]||'Цель',w=ctx.measureText(label).width+20;ctx.fillStyle='#091b20ed';ctx.fillRect(goal.x-w/2,goal.y+23,w,25);ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(label,goal.x,goal.y+40);
 }
 ctx.restore();
 if(unit.orderQueue?.length)drawQueuedGoals(ctx,[unit.order,...unit.orderQueue],view);
}

// Dotted links express the sequence, not uncomputed traversable path segments.
// The current route above contains only authoritative H3 waypoints.
export function drawQueuedGoals(ctx,orders,view,{offset=0,draft=false}={}){
 if(view.queueMarkers&&orders.every((o,i)=>view.queueMarkers.has(`${offset+i}:${o.mode}:${o.cell}`)))return;
 ctx.save();ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.lineWidth=1.5;
 const points=orders.map(o=>view.projectCell(o.cell));
 ctx.strokeStyle=draft?'#f4edbcaa':'#c5e8bd77';ctx.setLineDash([2,7]);ctx.beginPath();
 points.forEach((p,i)=>{if(p&&points[i-1]){ctx.moveTo(points[i-1].x,points[i-1].y);ctx.lineTo(p.x,p.y);}});ctx.stroke();ctx.setLineDash([]);
 orders.forEach((o,i)=>{
  const p=points[i],key=`${offset+i}:${o.mode}:${o.cell}`;if(!p||view.queueMarkers?.has(key))return;view.queueMarkers?.add(key);
  ctx.fillStyle=draft?'#354124ee':'#091b20ed';ctx.strokeStyle=COLORS[o.mode];ctx.beginPath();ctx.arc(p.x,p.y-17,12,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=COLORS[o.mode];ctx.fillText(String(offset+i+1),p.x,p.y-13);
 });ctx.restore();
}
