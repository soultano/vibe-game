// One distance policy for rendering, downloads and polling.
export const DETAIL_ZOOM = 768;
export const MAP_LIMITS = Object.freeze({ tiles:48,cachedTiles:64,profiles:128,overviewMarkers:192,terrainCells:2200,mapPixels:4000000,troopPixels:1600000 });
export function mapDetail(zoom) {
 return { level:zoom<4?'planet':zoom<16?'continent':zoom<64?'region':zoom<256?'area':zoom<768?'local':zoom<1536?'tactical':'close',
  detailed:zoom>=DETAIL_ZOOM,textures:zoom>=768,props:zoom>=DETAIL_ZOOM,
  unitLimit:zoom<768?0:zoom<1536?12:zoom<3072?24:36,propLimit:zoom<768?0:zoom<1536?160:zoom<3072?320:512,
  terrainResolution:zoom>=768?8:zoom>=384?7:zoom>=128?6:zoom>=48?5:zoom>=16?4:3,
  overviewResolution:zoom>=256?5:zoom>=64?4:zoom>=16?3:zoom>=4?2:1,
  pollMs:zoom>=DETAIL_ZOOM?2000:10000 };
}
export function validBounds(value) {
 const b=Object.fromEntries(['west','east','south','north'].map(k=>[k,Number(value?.[k])]));
 if(Object.values(b).some(v=>!Number.isFinite(v))||b.west< -180||b.west>180||b.east< -180||b.east>180||b.south< -90||b.north>90||b.west===b.east||b.south>=b.north)throw new RangeError('Invalid viewport bounds');
 return b;
}
export function insideBounds(lat,lng,b){return lat>=b.south&&lat<=b.north&&(b.west>b.east?lng>=b.west||lng<=b.east:lng>=b.west&&lng<=b.east);}
