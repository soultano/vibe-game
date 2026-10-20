import {polygonToCellsExperimental,POLYGON_TO_CELLS_FLAGS,getHexagonAreaAvg} from 'h3-js';
import {mapDetail,MAP_LIMITS} from '../shared/map-view.js';
export function mapRequest({zoom,nw,se}){
 const west=Math.max(-180,Math.min(nw.lng,se.lng)),east=Math.min(180,Math.max(nw.lng,se.lng)),south=Math.max(-85,Math.min(nw.lat,se.lat)),north=Math.min(85,Math.max(nw.lat,se.lat));
 if(west>=east||south>=north)return null;
 const policy=mapDetail(zoom),bounds={west,east,south,north};
 const estimated=(east-west)*(north-south)*111.32**2*Math.cos((north+south)/2*Math.PI/180)/getHexagonAreaAvg(5,'km2');
 if(policy.detailed&&estimated<=MAP_LIMITS.tiles*.75){
  const polygon=[[north,west],[north,east],[south,east],[south,west],[north,west]];
  let parents;try{parents=polygonToCellsExperimental(polygon,5,POLYGON_TO_CELLS_FLAGS.containmentOverlapping).sort();}catch{parents=[];}
  if(parents.length&&parents.length<=MAP_LIMITS.tiles)return{kind:'tiles',parents,key:'tiles:'+parents.join(','),bounds};
 }
 const rounded={west:Math.max(-180,Math.floor(west*20)/20),east:Math.min(180,Math.ceil(east*20)/20),south:Math.max(-85,Math.floor(south*20)/20),north:Math.min(85,Math.ceil(north*20)/20),resolution:policy.overviewResolution};
 const query=new URLSearchParams(Object.entries(rounded).map(([k,v])=>[k,String(v)])).toString();
 return{kind:'overview',url:'/api/map/overview?'+query,key:query,bounds};
}
