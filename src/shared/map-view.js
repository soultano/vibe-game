// One distance policy for rendering, downloads and polling.
export const DETAIL_ZOOM = 768;
export const MAP_LIMITS = Object.freeze({ tiles:48,cachedTiles:64,profiles:128,overviewMarkers:192,terrainCells:2200,mapPixels:4000000,troopPixels:1600000 });
export function mapDetail(zoom) {
 return { detailed:zoom>=DETAIL_ZOOM,textures:zoom>=128,props:zoom>=DETAIL_ZOOM,
  terrainResolution:zoom>=768?8:zoom>=384?7:zoom>=128?6:zoom>=48?5:zoom>=16?4:3,
  overviewResolution:zoom>=256?5:zoom>=64?4:zoom>=16?3:zoom>=4?2:1,
  pollMs:zoom>=DETAIL_ZOOM?2000:10000 };
}
export function validBounds(value) {
 const b=Object.fromEntries(['west','east','south','north'].map(k=>[k,Number(value?.[k])]));
 if(Object.values(b).some(v=>!Number.isFinite(v))||b.west< -180||b.east>180||b.south< -85||b.north>85||b.west>=b.east||b.south>=b.north)throw new RangeError('Invalid viewport bounds');
 return b;
}
export function insideBounds(lat,lng,b){return lat>=b.south&&lat<=b.north&&lng>=b.west&&lng<=b.east;}
