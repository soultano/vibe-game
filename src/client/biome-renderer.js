import {BIOMES} from '../shared/biomes.js';
export function biomePattern(ctx,type,canvasFactory=()=>document.createElement('canvas')){
 const surface=canvasFactory();surface.width=surface.height=96;const c=surface.getContext('2d');
 c.fillStyle=BIOMES[type].color;c.fillRect(0,0,96,96);c.lineWidth=type==='ice'?1.2:.7;
 for(let i=0;i<26;i++){
  const x=(i*37)%96,y=(i*53)%96;c.strokeStyle=type==='ice'?(i%2?'#f0ffff85':'#568da653'):type==='snow'?'#85afc345':['desert','redDesert','coldDesert'].includes(type)?'#79512a38':'#ece2a02e';
  c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+5,y-4,x+12,y+(type==='ice'?9:0));c.stroke();
 }
 return ctx.createPattern(surface,'repeat');
}
// Small vector props share the existing distance/prop budgets. No new GLB or
// bitmap downloads are required for ice, dunes, palms and savanna trees.
export function drawBiomeProp(ctx,prop){
 if(!['iceberg','dune','palm','acacia','frost-rock','desert-rock'].includes(prop.kind))return false;
 const {x,y,span,kind}=prop,s=Math.min(150,span*.95);
 ctx.save();ctx.translate(x,y);ctx.fillStyle='#06212636';ctx.beginPath();ctx.ellipse(s*.13,2,s*.35,s*.10,0,0,Math.PI*2);ctx.fill();
 if(kind==='iceberg'||kind==='frost-rock'||kind==='desert-rock'){
  if(kind==='desert-rock')ctx.scale(1,.5);
  ctx.fillStyle=kind==='iceberg'?'#b5dfec':kind==='desert-rock'?'#a88252':'#b2bcc0';ctx.beginPath();ctx.moveTo(-s*.38,0);ctx.lineTo(-s*.23,-s*.45);ctx.lineTo(s*.06,-s*.85);ctx.lineTo(s*.38,-s*.12);ctx.closePath();ctx.fill();
  ctx.fillStyle=kind==='iceberg'?'#edfaff':kind==='desert-rock'?'#d8b37c':'#e2e9e7';ctx.beginPath();ctx.moveTo(-s*.23,-s*.45);ctx.lineTo(s*.06,-s*.85);ctx.lineTo(s*.01,-s*.1);ctx.closePath();ctx.fill();
  ctx.strokeStyle='#6caec366';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(s*.06,-s*.67);ctx.lineTo(s*.15,-s*.30);ctx.lineTo(s*.09,-s*.14);ctx.stroke();
 }else if(kind==='dune'){
  ctx.fillStyle=prop.biome==='redDesert'?'#9f5e38':'#c39c56';ctx.beginPath();ctx.moveTo(-s*.65,0);ctx.quadraticCurveTo(-s*.05,-s*.44,s*.6,0);ctx.closePath();ctx.fill();
  ctx.fillStyle=prop.biome==='redDesert'?'#d3915e':'#efd29a';ctx.beginPath();ctx.moveTo(-s*.65,0);ctx.quadraticCurveTo(-s*.05,-s*.44,s*.6,0);ctx.quadraticCurveTo(-s*.02,-s*.23,-s*.65,0);ctx.fill();
 }else{
  ctx.strokeStyle='#584d2d';ctx.lineWidth=Math.max(2,s*.055);ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(s*.11,-s*.38,0,-s*.67);ctx.stroke();
  if(kind==='palm')for(let i=0;i<6;i++){const angle=i*Math.PI/3,ex=Math.cos(angle)*s*.43,ey=-s*.65+Math.sin(angle)*s*.18;ctx.fillStyle=i%2?'#35724a':'#568e4a';ctx.beginPath();ctx.moveTo(0,-s*.67);ctx.quadraticCurveTo(ex*.7,ey-s*.22,ex,ey);ctx.quadraticCurveTo(ex*.48,ey-s*.02,0,-s*.67);ctx.fill();}
  else{ctx.fillStyle='#657c3f';ctx.beginPath();ctx.ellipse(0,-s*.66,s*.46,s*.16,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#88974a';ctx.beginPath();ctx.ellipse(-s*.08,-s*.73,s*.34,s*.09,-.03,0,Math.PI*2);ctx.fill();}
 }
 ctx.restore();return true;
}
