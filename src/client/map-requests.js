import {polygonToCellsExperimental,POLYGON_TO_CELLS_FLAGS,getHexagonAreaAvg,latLngToCell,cellToParent} from 'h3-js';
import {mapDetail,MAP_LIMITS} from '../shared/map-view.js';
export function mapRequest({zoom,nw,se,view}){
 const bounds=view?.bounds||{west:Math.max(-180,Math.min(nw.lng,se.lng)),east:Math.min(180,Math.max(nw.lng,se.lng)),south:Math.max(-90,Math.min(nw.lat,se.lat)),north:Math.min(90,Math.max(nw.lat,se.lat))};
 const {west,east,south,north}=bounds;
 if(west===east||south>=north||Object.values(bounds).some(v=>!Number.isFinite(v)))return null;
 const policy=mapDetail(zoom),windows=view?.windows||[bounds];
 const estimated=windows.reduce((sum,b)=>sum+(b.east-b.west)*(b.north-b.south)*111.32**2*Math.cos((b.north+b.south)/2*Math.PI/180)/getHexagonAreaAvg(5,'km2'),0);
 if(policy.detailed&&estimated<=MAP_LIMITS.tiles*.75){
  let parents;try{parents=[...new Set(windows.flatMap(b=>{
   const n=Math.min(89.999999,b.north),s=Math.max(-89.999999,b.south),polygon=[[n,b.west],[n,b.east],[s,b.east],[s,b.west],[n,b.west]];
   const cells=polygonToCellsExperimental(polygon,5,POLYGON_TO_CELLS_FLAGS.containmentOverlapping);
   // H3's hierarchy is not geometrically nested. At a pole in particular, a
   // visible resolution-8 child may belong to a parent beyond its outline.
   // Include canonical parents of actual viewport samples, without ring padding.
   for(let y=0;y<=4;y++)for(let x=0;x<=4;x++)cells.push(cellToParent(latLngToCell(s+(n-s)*y/4,b.west+(b.east-b.west)*x/4,8),5));
   return cells;
  }))].sort();}catch{parents=[];}
  if(parents.length&&parents.length<=MAP_LIMITS.tiles)return{kind:'tiles',parents,key:'tiles:'+parents.join(','),bounds};
 }
 const rounded={west:Math.max(-180,Math.floor(west*20)/20),east:Math.min(180,Math.ceil(east*20)/20),south:Math.max(-90,Math.floor(south*20)/20),north:Math.min(90,Math.ceil(north*20)/20),resolution:policy.overviewResolution};
 if(rounded.west===rounded.east){rounded.west=-180;rounded.east=180;}
 const query=new URLSearchParams(Object.entries(rounded).map(([k,v])=>[k,String(v)])).toString();
 return{kind:'overview',url:'/api/map/overview?'+query,key:query,bounds};
}
