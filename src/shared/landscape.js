import { cellToLatLng, gridDisk } from 'h3-js';
import { cellIsLand, captureHash, validatePlayableCell } from './geography.js';
import { landscapeAt } from './landscape-field.js';
export { landscapeAt } from './landscape-field.js';

// Original, deterministic fantasy biomes over the existing Earth/H3 world.
// These are authored game terrain, not measured geographic elevations.
const cache = new Map();
export function landscape(cell) {
  if(cache.has(cell)){const value=cache.get(cell);cache.delete(cell);cache.set(cell,value);return value;}
  const [lat,lng]=cellToLatLng(cell),value=landscapeAt(lat,lng,cellIsLand(cell),captureHash(cell,481)/4294967295);
  cache.set(cell,value);if(cache.size>12000)cache.delete(cache.keys().next().value);return value;
}
export function traversable(cell, type='infantry', baseCell=null) {
  if (!cellIsLand(cell)) return false;
  // Existing headquarters remain reachable even when the new biomes put a lake
  // beneath them. Ground armies need a shore route; air can cross water.
  return type==='air' || cell===baseCell || !landscape(cell).water;
}
export function adjacentCells(cell) { return gridDisk(cell,1).filter(c=>c!==cell).sort(); }
