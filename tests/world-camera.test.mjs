import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { latLngToCell, cellToParent, cellToLatLng } from 'h3-js';
import { createWorldCamera, geographicPosition, wrapLongitude, panWorld, anchorWorld } from '../src/client/world-camera.js';
import { createGlobeRenderer } from '../src/client/globe-renderer.js';
import { mapRequest } from '../src/client/map-requests.js';
import { aggregateOverview } from '../src/server/map-overview.js';
import { insideBounds, MAP_LIMITS } from '../src/shared/map-view.js';
import { hitMapOverview } from '../src/client/map-overview.js';
import { createClientHarness } from './helpers/client-harness.mjs';
import { drawWorldGrid } from '../src/client/world-grid.js';

const options = { width: 1280, height: 800, zoom: 1, lat: 41.31, lng: 69.28 };
const same = (a,b,epsilon=1e-7) => { assert.ok(Math.abs(a.lat-b.lat)<epsilon,`${a.lat} ≠ ${b.lat}`);if(Math.abs(a.lat)<89.9999)assert.ok(Math.abs(wrapLongitude(a.lng-b.lng))<epsilon,`${a.lng} ≠ ${b.lng}`); };

test('coordinates wrap across the dateline and reflect through both poles on the same planet',()=>{
 same(geographicPosition(95,40),{lat:85,lng:-140});same(geographicPosition(-95,40),{lat:-85,lng:-140});
 for(let lat=-1080;lat<=1080;lat+=17)for(let lng=-720;lng<=720;lng+=73){const p=geographicPosition(lat,lng);assert.ok(p.lat>=-90&&p.lat<=90&&p.lng>=-180&&p.lng<180);
  const xyz=(a,b)=>[Math.cos(a*Math.PI/180)*Math.cos(b*Math.PI/180),Math.cos(a*Math.PI/180)*Math.sin(b*Math.PI/180),Math.sin(a*Math.PI/180)];
  xyz(lat,lng).forEach((v,i)=>assert.ok(Math.abs(v-xyz(p.lat,p.lng)[i])<1e-12));
 }
});
test('globe projection and inverse agree after full rotations and hide the back hemisphere',()=>{
 for(const lat of[-170,-91,-30,0,60,89,100,175]){const c=createWorldCamera({...options,lat});same(c.atPoint(640,400),c.center);
  for(let a=-80;a<=80;a+=10)for(let b=-180;b<180;b+=19){const p=c.project(a,b);if(p.visible)same(c.atPoint(p.x,p.y),{lat:a,lng:b},1e-5);}
  const back=c.project(-c.center.lat,c.center.lng+180);assert.equal(back.visible,false);assert.equal(c.atPoint(0,0).valid,false);
 }
});
test('flat camera repeats geography without empty edges at dateline and pole crossings',()=>{
 for(const lat of[-179,-95,-89,0,89,95,179])for(const lng of[-179.99,0,179.99])for(const zoom of[1,16,2048]){
  const c=createWorldCamera({...options,lat,lng,zoom,mode:'flat'}),patches=c.rasterPatches();assert.ok(patches.length<=12);
  for(let y=1;y<800;y+=83)for(let x=1;x<1280;x+=113){
   const q=c.atPoint(x,y),hits=patches.filter(p=>x>=p.x&&x<=p.x+p.width&&y>=p.y&&y<=p.y+p.height);assert.equal(hits.length,1);
   const p=hits[0],u=(x-p.x)/p.width,v=(y-p.y)/p.height;
   same(q,{lat:p.flipY?-90+v*180:90-v*180,lng:-180+u*360});
   const positions=c.project.points(q.lat,q.lng);assert.ok(positions.some(p=>Math.hypot(p.x-x,p.y-y)<1e-6));
  }
 }
});
test('bounded request windows cover every visible location including reflected sheets and poles',()=>{
 for(const lat of[-179,-95,-89.9999,0,41,89.9999,95,179])for(const lng of[-179.999,40,179.999])for(const zoom of[1,32,2048]){
  const c=createWorldCamera({...options,lat,lng,zoom,mode:'flat'}),view=c.requestView();assert.ok(view.windows.length<=12);
  for(let y=1;y<800;y+=97)for(let x=1;x<1280;x+=127){const q=c.atPoint(x,y);assert.ok(insideBounds(q.lat,q.lng,view.bounds));assert.ok(view.windows.some(b=>insideBounds(q.lat,q.lng,b)));}
 }
});
test('nearby seam and pole views request only canonical visible tiles and respect the existing tile budget',()=>{
 for(const lat of[-95,-89.999,0,89.999,95])for(const lng of[-179.999,179.999]){
  const c=createWorldCamera({...options,lat,lng,zoom:2048,mode:'flat'}),request=mapRequest({zoom:c.zoom,view:c.requestView()});assert.equal(request.kind,'tiles');assert.ok(request.parents.length<=MAP_LIMITS.tiles);assert.equal(new Set(request.parents).size,request.parents.length);
  for(let y=1;y<800;y+=137)for(let x=1;x<1280;x+=211){const q=c.atPoint(x,y);assert.ok(request.parents.includes(cellToParent(latLngToCell(q.lat,q.lng,8),5)),JSON.stringify(q));}
 }
});
test('zoom anchoring preserves the selected location across globe to flat and at the dateline',()=>{
 for(const [lat,lng,from,to]of[[41,69,3.5,4.5],[0,179.99,2048,4096],[95,40,32,64],[41,69,1,1.3]]){
  const before=createWorldCamera({...options,lat,lng,zoom:from}),world=before.atPoint(700,440),next={...options,lat,lng,zoom:to};
  const center=anchorWorld(next,world,700,440),after=createWorldCamera({...next,...center});same(after.atPoint(700,440),world,1e-4);
 }
});
test('panning may traverse multiple full worlds in any direction with no boundary clamp',()=>{
 for(const mode of['auto','flat']){const c=createWorldCamera({...options,mode}),scale=c.globe?c.radius*Math.PI/180:c.size;
  const next=panWorld(c,-1080*scale,720*scale);same(geographicPosition(next.lat,next.lng),c.center);
  const cross=panWorld(createWorldCamera({...options,lat:89,mode}),0,5*scale);same(geographicPosition(cross.lat,cross.lng),{lat:86,lng:wrapLongitude(options.lng+180)});
 }
});
test('wrapped overview includes both dateline shores and polar bases, with a circular longitude mean',()=>{
 const entry=(id,lat,lng)=>({id,baseCell:latLngToCell(lat,lng,8),pixels:1,units:0,faction:'pack'});
 const rows=[entry('east',0,179.99),entry('west',0,-179.99),entry('remote',0,0),entry('pole',89.9,0)];
 const result=aggregateOverview(rows,{west:179,east:-179,south:-5,north:5,resolution:0});assert.equal(result.regions.reduce((n,g)=>n+g.players,0),2);assert.ok(result.regions.every(g=>Math.abs(g.lng)>179));
 const polar=aggregateOverview(rows,{west:-180,east:180,south:89,north:90,resolution:3});assert.equal(polar.regions.reduce((n,g)=>n+g.players,0),1);
});
test('overview markers cannot be hit through the globe and remain clickable in repeated map copies',()=>{
 const c=createWorldCamera({...options,lat:0,lng:0}),group={lat:0,lng:180,players:1,pixels:1,units:0,battles:0,factions:{pack:1}},overview={regions:[group],armies:[]};
 assert.equal(hitMapOverview(overview,c.project,1280,800,640,400),null);
 const flat=createWorldCamera({...options,lat:0,lng:179.99,mode:'flat'});group.lng=-179.99;
 const p=flat.project(group.lat,group.lng);assert.ok(hitMapOverview(overview,flat.project,1280,800,p.x,p.y));
});
test('globe uses the same terrain texture with bounded pixel work and no WebGL',async()=>{
 const image=await loadImage(new URL('../src/client/assets/terrain/world-overview.webp',import.meta.url).pathname);Object.defineProperty(image,'complete',{value:true});Object.defineProperty(image,'naturalWidth',{value:image.width});
 const c=createWorldCamera({...options,width:5120,height:2880}),canvas=createCanvas(c.width,c.height),renderer=createGlobeRenderer({canvasFactory:()=>createCanvas(1,1)});
 const idle=renderer.draw(canvas.getContext('2d'),c,{image}),moving=renderer.draw(canvas.getContext('2d'),c,{image,moving:true});
 assert.ok(idle.pixels<242000);assert.ok(moving.pixels<92000);assert.ok(moving.pixels<idle.pixels);const pixel=canvas.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;assert.equal(pixel[3],255);assert.ok(pixel[1]>0);
});
test('actual controls rotate without extra map requests, preserve focus, and switch to detailed flat play',async()=>{
 const h=await createClientHarness(),canvas=h.$('worldCanvas');h.client.focusAt(89,179,1);h.$('mapGlobe').onclick();await h.client.refreshTiles(true);h.requests.length=0;
 canvas.listeners.get('pointerdown')({pointerId:1,clientX:640,clientY:400});canvas.listeners.get('pointermove')({pointerId:1,clientX:1000,clientY:500});assert.equal(h.requests.length,0);await canvas.listeners.get('pointerup')({pointerId:1,clientX:1000,clientY:500});
 const center=h.client.mapSnapshot().center;assert.ok(center.lat<89);assert.ok(center.lng!==179);assert.equal(h.client.mapSnapshot().projection,'globe');
 h.$('mapFlat').onclick();same(h.client.mapSnapshot().center,center);assert.equal(h.client.mapSnapshot().projection,'flat');h.client.draw(100);
 h.client.focusAt(0,179.99,2048);await h.client.refreshTiles(true);assert.equal(h.client.mapSnapshot().mapKind,'tiles');assert.ok(!h.requests.some(p=>/\.glb/.test(p)));
 h.$('mapGlobe').onclick();assert.equal(h.client.mapSnapshot().projection,'globe');assert.equal(h.client.mapSnapshot().zoom,1);await h.client.refreshTiles(true);assert.equal(h.client.mapSnapshot().mapKind,'overview');
});
test('clicking empty space beside the globe cannot place a base or jump to a hidden location',async()=>{
 const h=await createClientHarness();h.$('mapGlobe').onclick();const before=h.client.mapSnapshot(),canvas=h.$('worldCanvas');h.requests.length=0;
 canvas.listeners.get('pointerdown')({pointerId:1,clientX:0,clientY:0});await canvas.listeners.get('pointerup')({pointerId:1,clientX:0,clientY:0});
 same(h.client.mapSnapshot().center,before.center);assert.equal(h.client.mapSnapshot().zoom,1);assert.equal(h.requests.length,0);
});
test('graticule segments never connect unrelated repeated world copies',()=>{
 const c=createWorldCamera({...options,mode:'flat',lng:179.99});let point,segments=0;
 const ctx={save(){},restore(){},beginPath(){},stroke(){},moveTo(x,y){point={x,y};},lineTo(x,y){assert.ok(point);assert.ok(Math.hypot(x-point.x,y-point.y)<50,'no stripe between two world copies');segments++;point={x,y};}};
 drawWorldGrid(ctx,c);assert.ok(segments>100);
});
