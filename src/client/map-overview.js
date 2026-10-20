import {getFaction} from '../shared/config.js';
function mergeVisible(groups,project,width,height){
 const bins=new Map();for(const g of groups||[])for(const p of(project.points?project.points(g.lat,g.lng):[project(g.lat,g.lng)])){if(p.visible===false||p.x< -60||p.y< -60||p.x>width+60||p.y>height+60)continue;const key=Math.floor(p.x/52)+':'+Math.floor(p.y/52);let a=bins.get(key);
  if(!a){a={x:0,y:0,lat:0,lng:0,weight:0,players:0,pixels:0,units:0,battles:0,factions:{},sample:g.sample};bins.set(key,a);}else a.sample=null;
  a.x+=p.x*g.players;a.y+=p.y*g.players;a.lat+=g.lat*g.players;const reference=a.weight?a.lng/a.weight:g.lng,delta=((g.lng-reference+540)%360)-180;a.lng+=(reference+delta)*g.players;a.weight+=g.players;a.players+=g.players;a.pixels+=g.pixels;a.units+=g.units;a.battles+=g.battles;
  for(const[id,count]of Object.entries(g.factions))a.factions[id]=(a.factions[id]||0)+count;
 }return [...bins.values()].map(g=>({...g,x:g.x/g.weight,y:g.y/g.weight,lat:g.lat/g.weight,lng:g.lng/g.weight}));
}
export function drawMapOverview(ctx,{overview,project,width,height,zoom,showArmies=true}){
 if(!overview)return;
 const regions=mergeVisible(overview.regions,project,width,height),armies=showArmies?mergeVisible(overview.armies,project,width,height):[];
 ctx.save();ctx.textAlign='center';ctx.lineWidth=2;
 for(const g of regions){
  const factions=Object.entries(g.factions).sort((a,b)=>b[1]-a[1]),color=g.sample?.color|| (factions[0]?.[0]==='unknown'?'#9bb7ae':getFaction(factions[0]?.[0]).color),r=Math.min(24,9+Math.log2(Math.max(1,g.players))*3);
  // An overview footprint is intentionally approximate; no invented cell border.
  ctx.fillStyle=color+'19';ctx.beginPath();ctx.arc(g.x,g.y,r*2.5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#0c1e21ef';ctx.beginPath();ctx.arc(g.x,g.y,r,0,Math.PI*2);ctx.fill();let angle=-Math.PI/2;
  for(const[id,count]of factions){const end=angle+count/g.players*Math.PI*2;ctx.strokeStyle=id==='unknown'?'#9bb7ae':getFaction(id).color;ctx.beginPath();ctx.arc(g.x,g.y,r,angle,end);ctx.stroke();angle=end;}
  ctx.fillStyle='#e5eee0';ctx.font='600 10px sans-serif';ctx.fillText(g.players>1?String(g.players):'⌂',g.x,g.y+4);
  if(zoom>=32){ctx.font='10px sans-serif';const label=g.sample?.name||`${g.players} баз`;ctx.fillStyle='#0a171ce8';const w=ctx.measureText(label).width+12;ctx.fillRect(g.x-w/2,g.y+r+4,w,16);ctx.fillStyle='#dbebce';ctx.fillText(label,g.x,g.y+r+16);}
 }
 for(const g of armies){
  const id=Object.entries(g.factions).sort((a,b)=>b[1]-a[1])[0]?.[0],color=id==='unknown'?'#9bb7ae':getFaction(id).color,x=g.x+20,y=g.y-20;
  ctx.fillStyle='#091c20ed';ctx.fillRect(x-12,y-10,32,19);ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x-8,y+4);ctx.lineTo(x-4,y-4);ctx.lineTo(x,y+4);ctx.closePath();ctx.stroke();ctx.fillStyle='#ecf3e1';ctx.font='600 10px sans-serif';ctx.fillText(String(g.units),x+10,y+3);
  if(g.battles){ctx.strokeStyle='#ffb267';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x+23,y-7);ctx.lineTo(x+33,y+4);ctx.moveTo(x+33,y-7);ctx.lineTo(x+23,y+4);ctx.stroke();}
 }
 ctx.restore();
}

export function hitMapOverview(overview,project,width,height,x,y){
 if(!overview)return null;
 const candidates=[...mergeVisible(overview.regions,project,width,height).map(g=>({...g,hitX:g.x,hitY:g.y})),...mergeVisible(overview.armies,project,width,height).map(g=>({...g,hitX:g.x+20,hitY:g.y-20}))];
 return candidates.map(g=>({...g,distance:Math.hypot(g.hitX-x,g.hitY-y)})).filter(g=>g.distance<26).sort((a,b)=>a.distance-b.distance)[0]||null;
}
