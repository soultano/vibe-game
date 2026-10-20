// Pan/zoom the last complete bitmap during a gesture. Terrain generation is
// bounded to occasional refreshes; pointer events never rebuild every tile.
export function createMapPreview({refreshMs=180}={}){
 let camera=null,paintedAt=-Infinity;
 return{
  commit(next,now){camera=next;paintedAt=now;},
  shouldPaint(next,now,moving){return !camera||!moving||camera.globe||next.globe||now-paintedAt>=refreshMs;},
  draw(ctx,image,next,width,height){
   if(!camera||camera.globe||next.globe){ctx.drawImage(image,0,0,width,height);return;}
   const scale=next.size/camera.size,p=next.project(camera.center.lat,camera.center.lng);
   ctx.drawImage(image,p.x-width*scale/2,p.y-height*scale/2,width*scale,height*scale);
  },
 };
}
