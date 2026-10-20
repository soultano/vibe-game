import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {latLngToCell} from 'h3-js';
import {BIOMES,climateAt} from '../src/shared/biomes.js';
import {landscapeAt} from '../src/shared/landscape-field.js';
import {cellIsLand,validatePlayableCell} from '../src/shared/geography.js';
import {createLandscapeRenderer} from '../src/client/landscape-renderer.js';
import {createWorldCamera} from '../src/client/world-camera.js';
import {renderTerrainRaster} from '../src/client/terrain-raster.js';
const places=[[-80,30,'polar'],[78,-40,'polar'],[24,13,'desert'],[24,47,'desert'],[-25,134,'desert'],[-4,-62,'rainforest'],[0,22,'rainforest'],[4,117,'rainforest'],[68,100,'tundra'],[-5,38,'savanna'],[46.5,10,'alpine'],[41.31,69.28,'temperate']];
test('continents have geographically distinct climates instead of repeating a global green palette',()=>{
 for(const[lat,lng,climate]of places){assert.equal(climateAt(lat,lng),climate,`${lat},${lng}`);assert.equal(climateAt(lat,lng+720),climate);const ground=landscapeAt(lat,lng,true);assert.equal(ground.climate,climate);assert.ok(BIOMES[ground.type]);assert.ok(ground.speed>0&&ground.speed<=1);}
 assert.ok(['snow','ice'].includes(landscapeAt(-80,30,true).type));assert.equal(landscapeAt(24,13,true).type,'desert');assert.ok(landscapeAt(-80,30,true).temperature<0);assert.ok(landscapeAt(24,13,true).temperature>0);
});
test('Antarctica exists in both the shared geography and map, without expanding the playable war region',()=>{
 const pole=latLngToCell(-85,40,8),coast=latLngToCell(-64,100,8);assert.equal(cellIsLand(pole),true);assert.equal(cellIsLand(coast),false);assert.equal(validatePlayableCell(pole),false);
});
test('climate differences survive the lowest map levels and share the detailed terrain field',()=>{
 const pixel=(lat,lng)=>{const r=renderTerrainRaster({west:lng-.1,east:lng+.1,south:lat-.1,north:lat+.1,pixels:32,level:3});return [...r.data.slice((16*32+16)*4,(16*32+16)*4+3)];};
 const ice=pixel(-80,30),desert=pixel(24,13),jungle=pixel(-4,-62);assert.ok(ice.every(c=>c>170));assert.ok(desert[0]>desert[2]+60);assert.ok(jungle[1]>jungle[0]+25);assert.ok(ice[0]>jungle[0]+100);
 const outback=pixel(-25,134);assert.ok(outback[0]>outback[1]+40);assert.ok(outback[1]<desert[1]-30,'Australian red earth differs from Saharan sand even in the overview');
});
test('polar detail draws ice and snow with no green forest or model downloads',()=>{
 const requested=[],c=createWorldCamera({width:800,height:500,zoom:2048,lat:-80,lng:30,mode:'flat'}),renderer=createLandscapeRenderer({canvasFactory:()=>createCanvas(1,1),imageFactory:()=>({complete:false,naturalWidth:0,set src(value){requested.push(value);}})});
 const surface=createCanvas(800,500);renderer.draw(surface.getContext('2d'),{width:800,height:500,zoom:2048,camera:c,project:c.project,atPoint:c.atPoint});assert.deepEqual(requested,[]);const pixel=surface.getContext('2d').getImageData(400,250,1,1).data;assert.ok(pixel[0]>120&&pixel[1]>140&&pixel[2]>140);renderer.dispose();
});
