import {
  latLngToCell, cellToLatLng, cellToBoundary, isValidCell, getResolution,
  gridDisk, gridRing, gridDiskDistances, cellToParent, cellToChildrenSize,
  cellToChildPos, childPosToCell, greatCircleDistance,
} from 'h3-js';
import worldMask from '../../data/world-mask.json' with { type: 'json' };
import { CONFIG } from './config.js';
import { deriveLevel } from './economy.js';
import { worldLandAt } from './world-land.js';

export { latLngToCell, cellToLatLng, cellToBoundary, isValidCell, gridDisk };
export const coordinates = cellToLatLng;
export const TERRAIN_DATA = Object.freeze({ approximate: true, source: CONFIG.TERRAIN_SOURCE, resolutionDegrees: 1 });

let terrainProvider = null;
/** Optional synchronous adapter for an offline ESA/GHSL H3 terrain pack. */
export function setTerrainProvider(provider) {
  if (provider !== null && typeof provider !== 'function') throw new TypeError('Terrain provider must be a function or null');
  terrainProvider = provider;
}

export function normalizeAzimuth(value) {
  return ((Number(value) || 0) % 360 + 360) % 360;
}

function maskLand(lat, lng) {
  return worldLandAt(lat,lng,worldMask.land);
}

export function cellIsLand(cell) {
  if (!isValidCell(cell)) return false;
  const supplied = terrainProvider?.(cell);
  if (supplied && typeof supplied.isLand === 'boolean') return supplied.isLand;
  const [lat, lng] = cellToLatLng(cell);
  return maskLand(lat, lng);
}

export function validatePlayableCell(cell) {
  if (!isValidCell(cell) || getResolution(cell) !== CONFIG.H3_RESOLUTION || !cellIsLand(cell)) return false;
  const { center, radiusKm } = CONFIG.REGION;
  return greatCircleDistance(cellToLatLng(cell), [center.lat, center.lng], 'km') <= radiusKm;
}

export function terrainForCell(cell) {
  const supplied = terrainProvider?.(cell);
  if (supplied) return { approximate: false, ...supplied };
  if (!cellIsLand(cell)) return { type: 'water', multiplier: 0, isLand: false, coastal: false, approximate: true };
  const [lat, lng] = cellToLatLng(cell);
  // This coarse mask supports a playable prototype, not a fabricated ESA dataset.
  const urban = worldMask.cities.some((city) => greatCircleDistance([lat, lng], [90 - city.y, city.x - 180], 'km') < 12);
  const coastal = gridDisk(cell, 1).some((neighbor) => !cellIsLand(neighbor));
  const type = urban ? 'urban' : 'grassland';
  return { type, multiplier: CONFIG.TERRAIN[type] + (coastal ? CONFIG.TERRAIN.coastalBonus : 0), isLand: true, coastal, approximate: true };
}

export function bearingBetween(baseCell, cell) {
  if (baseCell === cell) return 0;
  const [lat1, lon1] = cellToLatLng(baseCell).map((degrees) => degrees * Math.PI / 180);
  const [lat2, lon2] = cellToLatLng(cell).map((degrees) => degrees * Math.PI / 180);
  return normalizeAzimuth(Math.atan2(Math.sin(lon2 - lon1) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)) * 180 / Math.PI);
}

export function sectorAllows(baseCell, cell, level, azimuth) {
  if (baseCell === cell) return true;
  const angle = deriveLevel(level).angle;
  if (angle >= 360 - 1e-10) return true;
  const delta = Math.abs(((bearingBetween(baseCell, cell) - normalizeAzimuth(azimuth) + 540) % 360) - 180);
  return delta <= angle / 2 + 1e-9;
}

export function captureHash(cell, seed = 0) {
  let n = BigInt(`0x${cell}`) ^ BigInt(Math.trunc(Number(seed) || 0));
  n = BigInt.asUintN(64, (n ^ (n >> 30n)) * 0xbf58476d1ce4e5b9n);
  n = BigInt.asUintN(64, (n ^ (n >> 27n)) * 0x94d049bb133111ebn);
  return Number(BigInt.asUintN(32, n ^ (n >> 31n)));
}

/** Resumable geometric scan. Cursor offsets belong to a fixed level/azimuth. */
export function* sectorCellIterator(baseCell, level, azimuth, seed = 0, options = {}) {
  if (!isValidCell(baseCell) || getResolution(baseCell) !== CONFIG.H3_RESOLUTION) throw new TypeError('Expected an H3 resolution 8 base');
  const data = deriveLevel(level);
  const maxRings = Math.max(0, Math.floor(options.maxRings ?? Math.min(2048, Math.ceil(data.radiusRings * 4))));
  const startRing = Math.max(0, Math.floor(options.startRing ?? 0));
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  const isLand = options.isLand ?? validatePlayableCell;
  const allowed = options.isAvailable ?? (() => true);
  for (let ring = startRing; ring <= maxRings; ring += 1) {
    let cells;
    try { cells = gridRing(baseCell, ring); }
    catch { cells = gridDiskDistances(baseCell, ring)[ring] || []; }
    // H3 pentagons have five directions; ring size is obtained from H3 itself.
    const candidates = cells.filter((cell) => sectorAllows(baseCell, cell, level, azimuth) && isLand(cell) && allowed(cell));
    candidates.sort((a, b) => captureHash(a, seed) - captureHash(b, seed) || a.localeCompare(b));
    for (let offset = ring === startRing ? startOffset : 0; offset < candidates.length; offset += 1) {
      yield { cell: candidates[offset], ring, offset,
        nextRing: offset + 1 === candidates.length ? ring + 1 : ring,
        nextOffset: offset + 1 === candidates.length ? 0 : offset + 1 };
    }
  }
}

/** Materialization only: never call this to advance a player's clock. */
export function sectorCells(baseCell, level, azimuth, seed = 0, options = {}) {
  const limit = Math.max(0, Math.floor(options.limit ?? deriveLevel(level).cap));
  const result = [];
  if (!limit) return result;
  for (const { cell } of sectorCellIterator(baseCell, level, azimuth, seed, options)) {
    result.push(cell);
    if (result.length >= limit) break;
  }
  return result;
}

export function tileForCell(cell) {
  if (!isValidCell(cell) || getResolution(cell) < CONFIG.TILE_RESOLUTION) throw new TypeError('Invalid H3 cell');
  return cellToParent(cell, CONFIG.TILE_RESOLUTION);
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function encodeTile(tile, cells) {
  if (!isValidCell(tile) || getResolution(tile) !== CONFIG.TILE_RESOLUTION) throw new TypeError('Expected an H3 resolution 5 tile');
  const childCount = cellToChildrenSize(tile, CONFIG.H3_RESOLUTION);
  const bytes = new Uint8Array(Math.ceil(childCount / 8));
  for (const cell of cells) {
    if (getResolution(cell) !== CONFIG.H3_RESOLUTION || tileForCell(cell) !== tile) throw new TypeError('Cell is outside tile');
    const position = cellToChildPos(cell, CONFIG.TILE_RESOLUTION);
    bytes[Math.floor(position / 8)] |= 1 << (position % 8);
  }
  return { tile, childCount, bitmask: toBase64(bytes) };
}

export function decodeTile(tileOrObject, bitmask) {
  const tile = typeof tileOrObject === 'object' ? tileOrObject.tile : tileOrObject;
  const encoded = typeof tileOrObject === 'object' ? tileOrObject.bitmask : bitmask;
  if (!isValidCell(tile) || getResolution(tile) !== CONFIG.TILE_RESOLUTION) throw new TypeError('Expected an H3 resolution 5 tile');
  const childCount = cellToChildrenSize(tile, CONFIG.H3_RESOLUTION);
  const bytes = fromBase64(encoded);
  if (bytes.length !== Math.ceil(childCount / 8)) throw new RangeError('Invalid tile mask length');
  const cells = [];
  for (let position = 0; position < childCount; position += 1) {
    if (bytes[Math.floor(position / 8)] & (1 << (position % 8))) cells.push(childPosToCell(position, tile, CONFIG.H3_RESOLUTION));
  }
  return cells;
}
