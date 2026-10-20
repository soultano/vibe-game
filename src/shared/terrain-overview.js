// Offline low-pass views of the same deterministic field as the tactical map.
export const OVERVIEW_TERRAIN = Object.freeze({step:4,pixels:256,west:52,east:84,south:32,north:52,maxVisible:12,maxCached:24,concurrency:2});
export function terrainOverviewTiles(bounds){
 const c=OVERVIEW_TERRAIN,result=[];
 for(let south=c.south;south<c.north;south+=c.step)for(let west=c.west;west<c.east;west+=c.step){
  if(west>bounds.east||west+c.step<bounds.west||south>bounds.north||south+c.step<bounds.south)continue;
  result.push({key:`r-${west}-${south}`,west,east:west+c.step,south,north:south+c.step});
 }
 const lat=(bounds.south+bounds.north)/2,lng=(bounds.west+bounds.east)/2;
 return result.sort((a,b)=>Math.hypot((a.west+a.east)/2-lng,(a.south+a.north)/2-lat)-Math.hypot((b.west+b.east)/2-lng,(b.south+b.north)/2-lat)).slice(0,c.maxVisible);
}
