import {cellToLatLng,cellToParent} from 'h3-js';
import {FACTIONS} from '../shared/config.js';
import {validBounds,insideBounds,MAP_LIMITS} from '../shared/map-view.js';
const factionIds=new Set(FACTIONS.map(f=>f.id));
export function mapEntry(player,at=player.tLast||player.createdAt||0){
 const units=(player.army?.units||[]).filter(u=>!u.neutral&&u.hp>0),front=units.find(u=>u.state==='attack'||u.state==='capture')||units.find(u=>u.move)||units[0];
 return {id:player.id,baseCell:player.baseCell,name:player.name,faction:player.faction,level:player.level,pixels:Math.floor(player.pixels),color:player.color||null,
  customLink:player.customLink||null,customLinkTitle:player.customLinkTitle||null,
  units:units.length,armyCell:front?.move?.to||front?.cell||player.baseCell,fighting:units.some(u=>u.state==='attack'),summaryAt:at};
}
function group(entries,bounds,res,army){
 const groups=new Map();
 for(const p of entries){
  const cell=army?p.armyCell:p.baseCell;if(!cell||army&&!(p.units>0))continue;
  const[lat,lng]=cellToLatLng(cell);if(!insideBounds(lat,lng,bounds))continue;
  const key=cellToParent(cell,res);let g=groups.get(key);
  if(!g){g={cell:key,lat:0,lng:0,players:0,pixels:0,units:0,battles:0,factions:{},sample:null};groups.set(key,g);}
  g.lat+=lat;g.lng+=lng;g.players++;g.pixels+=p.pixels||0;g.units+=p.units||0;g.battles+=p.fighting?1:0;
  const faction=factionIds.has(p.faction)?p.faction:'unknown';g.factions[faction]=(g.factions[faction]||0)+1;
  if(g.players===1)g.sample={id:p.id,name:p.name||'Штаб',faction:p.faction||null,color:p.color||null};else g.sample=null;
 }
 return [...groups.values()].map(g=>({...g,lat:g.lat/g.players,lng:g.lng/g.players})).sort((a,b)=>a.cell.localeCompare(b.cell));
}
export function aggregateOverview(entries,input){
 const bounds=validBounds(input),requested=Number(input.resolution??3);
 if(!Number.isInteger(requested)||requested<0||requested>5)throw new RangeError('Invalid overview resolution');
 let resolution=requested,regions,armies;
 do{regions=group(entries,bounds,resolution,false);armies=group(entries,bounds,resolution,true);if(Math.max(regions.length,armies.length)<=MAP_LIMITS.overviewMarkers||!resolution)break;resolution--;}while(true);
 return {bounds,resolution,regions,armies,approximate:true};
}
