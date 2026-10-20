import { renderTerrainRaster } from './terrain-raster.js';
self.onmessage=({data:{id,tile}})=>{
 try{const result=renderTerrainRaster(tile);self.postMessage({id,...result},[result.data.buffer]);}
 catch{self.postMessage({id,error:true});}
};
