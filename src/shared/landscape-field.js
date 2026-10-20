// Pure terrain field: shared with the terrain worker without shipping H3 there.
import {climateAt,desertBiomeAt} from './biomes.js';
const fract = n => n - Math.floor(n);
function random(x, y) { return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123); }
function noise(x, y) {
  const a = Math.floor(x), b = Math.floor(y), u = fract(x), v = fract(y);
  const sx = u * u * (3 - 2 * u), sy = v * v * (3 - 2 * v);
  return (random(a,b)*(1-sx)+random(a+1,b)*sx)*(1-sy)
    +(random(a,b+1)*(1-sx)+random(a+1,b+1)*sx)*sy;
}
export function landscapeAt(lat,lng,isLand=true,detail=.5) {
  const x=lng*15,y=lat*20;
  const height=noise(x,y)*.67+noise(x*2.07+17,y*2.07)*.33;
  const climate=climateAt(lat,lng),moisture=noise(x*.72+83,y*.72-31),ocean=!isLand;
  const lake=!ocean&&!['polar','desert','alpine'].includes(climate)&&moisture>.74&&height<.42;
  const water=ocean||lake;
  let type=water?'water':height>.72?'mountain':height>.59?'rock':moisture>.54?'forest':moisture<.24?'sand':'grass';
  if(!water){
   if(climate==='polar')type=height>.62?'ice':'snow';
   else if(climate==='desert')type=height>.82?'rock':desertBiomeAt(lat,lng);
   else if(climate==='rainforest')type=height>.8?'mountain':'jungle';
   else if(climate==='savanna')type=height>.8?'rock':moisture>.68?'forest':'savanna';
   else if(climate==='tundra')type=height>.72?'snow':'tundra';
   else if(climate==='alpine')type=height>.54?'snow':'mountain';
  }
  const elevation=water?0:Math.round(Math.max(0,height-.27)*6);
  const speed=type==='jungle'?.6:type==='ice'?.48:type==='snow'?.58:type==='tundra'?.78:climate==='desert'?.85:type==='forest'?.73:type==='rock'?.67:type==='mountain'?.45:1;
  const cover=type==='jungle'?.28:type==='forest'?.2:type==='rock'||type==='mountain'?.3:0;
  return {type,elevation,water,ocean,detail,climate,temperature:Math.round(33-Math.abs(lat)*.72-elevation*2),speed,cover};
}
