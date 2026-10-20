import mask from '../../data/world-mask.json' with {type:'json'};
import { landscapeAt } from '../shared/landscape-field.js';
import {BIOMES,CLIMATES,desertBiomeAt} from '../shared/biomes.js';
import {worldLandAt} from '../shared/world-land.js';
const wrap=value=>((value+180)%360+360)%360-180;
function coastLand(lat,lng){
 const x=lng+179.5,y=89.5-lat,ix=Math.floor(x),iy=Math.floor(y),u=x-ix,v=y-iy;
 const at=(a,b)=>worldLandAt(89.5-Math.max(0,Math.min(179,b)),-179.5+a,mask.land)?1:0;
 return (at(ix,iy)*(1-u)+at(ix+1,iy)*u)*(1-v)+(at(ix,iy+1)*(1-u)+at(ix+1,iy+1)*u)*v>=.5;
}
function sample(lat,lng,footprint,level){
 const rgb=[0,0,0];
 const contrast=level<=4?.04:level<=6?.08:level<=8?.3:level===9?.65:1;
 for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
  const a=Math.max(-89.99999,Math.min(89.99999,lat+y*footprint*.4)),b=wrap(lng+x*footprint*.4);
  const land=level<=8?coastLand(a,b):worldLandAt(a,b,mask.land),d=landscapeAt(a,b,land),base=d.climate==='desert'?BIOMES[desertBiomeAt(a,b)].rgb:CLIMATES[d.climate].base;
  // Small lakes, pebbles and isolated trees become unreadable color noise at
  // continent/region scale. Generalize them; reveal real biome shapes nearby.
  const color=land&&d.water&&level<=8?base:BIOMES[d.type].rgb,shade=level<=8?.98+d.elevation*.003:.94+d.elevation*.025;
  for(let c=0;c<3;c++)rgb[c]+=(land?base[c]+(color[c]-base[c])*contrast:color[c])*shade/9;
 }
 return rgb;
}
// Shared global sample coordinates and averaging footprints prevent seams.
// The worker handles full tiles; the no-Worker fallback yields small chunks.
export function* terrainRasterRows(tile){
 const level=tile.level??4,width=tile.pixels||384,height=tile.height||width,columns=tile.columns||(level<=6?64:level<=8?192:256),rows=Math.max(1,Math.round(columns*height/width));
 const stepX=(tile.east-tile.west)/columns,stepY=(tile.north-tile.south)/rows,grid=new Float32Array((columns+1)*(rows+1)*3);
 for(let y=0;y<=rows;y++){
  for(let x=0;x<=columns;x++){const rgb=sample(tile.north-y*stepY,tile.west+x*stepX,Math.max(stepX,stepY),level);grid.set(rgb,(y*(columns+1)+x)*3);}
  if(y%2===1)yield;
 }
 const data=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++){
  const fy=(y+.5)/height*rows,gy=Math.min(rows-1,Math.floor(fy)),v=fy-gy;
  for(let x=0;x<width;x++){
   const fx=(x+.5)/width*columns,gx=Math.min(columns-1,Math.floor(fx)),u=fx-gx,i=(gy*(columns+1)+gx)*3,j=i+(columns+1)*3,at=(y*width+x)*4;
   for(let c=0;c<3;c++)data[at+c]=(grid[i+c]*(1-u)+grid[i+3+c]*u)*(1-v)+(grid[j+c]*(1-u)+grid[j+3+c]*u)*v;
   data[at+3]=255;
  }
  if(y%8===7)yield;
 }
 return {width,height,data};
}
export function renderTerrainRaster(tile){const iterator=terrainRasterRows(tile);let result;do{result=iterator.next();}while(!result.done);return result.value;}
