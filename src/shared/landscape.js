import { cellToLatLng, gridDisk } from 'h3-js';
import { cellIsLand, captureHash, validatePlayableCell } from './geography.js';

// Original, deterministic fantasy biomes over the existing Earth/H3 world.
// These are authored game terrain, not measured geographic elevations.
const cache = new Map();
const fract = n => n - Math.floor(n);
function random(x, y) { return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123); }
function noise(x, y) {
  const a = Math.floor(x), b = Math.floor(y), u = fract(x), v = fract(y);
  const sx = u * u * (3 - 2 * u), sy = v * v * (3 - 2 * v);
  return (random(a,b)*(1-sx)+random(a+1,b)*sx)*(1-sy)
    +(random(a,b+1)*(1-sx)+random(a+1,b+1)*sx)*sy;
}
export function landscape(cell) {
  if (cache.has(cell)) return cache.get(cell);
  const [lat,lng] = cellToLatLng(cell), x = lng * 15, y = lat * 20;
  const height = noise(x,y)*.67 + noise(x*2.07+17,y*2.07)*.33;
  const moisture = noise(x*.72+83,y*.72-31), detail = captureHash(cell,481)/4294967295;
  const ocean = !cellIsLand(cell), lake = !ocean && moisture > .74 && height < .42;
  const water = ocean || lake;
  const type = water ? 'water' : height > .72 ? 'mountain' : height > .59 ? 'rock'
    : moisture > .54 ? 'forest' : moisture < .24 ? 'sand' : 'grass';
  const value = { type, elevation: water ? 0 : Math.round(Math.max(0,height-.27)*6),
    water, ocean, detail, speed: type==='forest' ? .73 : type==='rock' ? .67 : type==='mountain' ? .45 : 1,
    cover: type==='forest' ? .2 : type==='rock' || type==='mountain' ? .3 : 0 };
  if (cache.size > 30000) cache.clear();
  cache.set(cell,value); return value;
}
export function traversable(cell, type='infantry', baseCell=null) {
  if (!validatePlayableCell(cell)) return false;
  // Existing headquarters remain reachable even when the new biomes put a lake
  // beneath them. Ground armies need a shore route; air can cross water.
  return type==='air' || cell===baseCell || !landscape(cell).water;
}
export function adjacentCells(cell) { return gridDisk(cell,1).filter(c=>c!==cell).sort(); }
