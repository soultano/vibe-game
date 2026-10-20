import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridRing, getPentagons, cellToChildren, cellToChildrenSize } from 'h3-js';
import { CONFIG } from '../src/shared/config.js';
import {
  sectorCells, sectorCellIterator, sectorAllows, tileForCell, encodeTile, decodeTile,
  cellIsLand, validatePlayableCell, terrainForCell, setTerrainProvider,
} from '../src/shared/geography.js';

const base = latLngToCell(41.3111, 69.2797, 8);

test('playable region accepts inland Tashkent and excludes water, Antarctica and distant land', () => {
  assert.equal(cellIsLand(base), true);
  assert.equal(validatePlayableCell(base), true);
  assert.equal(cellIsLand(latLngToCell(0, -140, 8)), false);
  assert.equal(cellIsLand(latLngToCell(-80, 0, 8)), true, 'Antarctica is visible land in the geographic world');
  assert.equal(validatePlayableCell(latLngToCell(-80, 0, 8)), false, 'the playable war region remains limited');
  assert.equal(validatePlayableCell(latLngToCell(51.5, -0.1, 8)), false);
  assert.equal(CONFIG.REGION.radiusKm, 1000);
  assert.equal(terrainForCell(base).approximate, true);
});

test('sector materialization is deterministic, prefix stable and constrained to its angle', () => {
  const options = { limit: 70, maxRings: 40, isLand: () => true };
  const a = sectorCells(base, 1, 90, 1234, options);
  assert.equal(a.length, 70);
  assert.equal(new Set(a).size, 70);
  assert.deepEqual(a, sectorCells(base, 1, 90, 1234, options));
  assert.deepEqual(a.slice(0, 23), sectorCells(base, 1, 90, 1234, { ...options, limit: 23 }));
  assert.ok(a.every((cell) => sectorAllows(base, cell, 1, 90)));
  assert.ok(gridDisk(base, 3).every((cell) => sectorAllows(base, cell, 30, 90)));
});

test('water and occupied cells redirect capture to further available rings without randomness', () => {
  const blocked = new Set(gridDisk(base, 3));
  const cells = sectorCells(base, 1, 45, 73, { limit: 25, maxRings: 30,
    isLand: (cell) => cell === base || !blocked.has(cell), isAvailable: (cell) => cell !== base });
  assert.equal(cells.length, 25);
  assert.ok(cells.every((cell) => !blocked.has(cell)));
});

test('resumable iterator preserves exact order across a ring boundary', () => {
  const options = { maxRings: 30, isLand: () => true };
  const iterator = sectorCellIterator(base, 1, 90, 123, options);
  const batch = [];
  for (let i = 0; i < 31; i += 1) batch.push(iterator.next().value);
  const last = batch.at(-1);
  const resumed = sectorCellIterator(base, 1, 90, 123, { ...options, startRing: last.nextRing, startOffset: last.nextOffset });
  const tail = [];
  for (let i = 0; i < 31; i += 1) tail.push(resumed.next().value.cell);
  assert.deepEqual([...batch.map((item) => item.cell), ...tail], sectorCells(base, 1, 90, 123, { ...options, limit: 62 }));
});

test('real H3 pentagon materialization has five neighbors and tile packing uses its real child count', () => {
  const pentagon = getPentagons(8)[0];
  assert.equal(gridRing(pentagon, 1).length, 5);
  assert.equal(sectorCells(pentagon, 30, 0, 1, { limit: 6, maxRings: 1, isLand: () => true }).length, 6);
  const pentagonTile = getPentagons(5)[0];
  const children = cellToChildren(pentagonTile, 8);
  assert.equal(children.length, 286);
  const picked = [children[0], children[42], children.at(-1)];
  const encoded = encodeTile(pentagonTile, picked);
  assert.equal(encoded.childCount, cellToChildrenSize(pentagonTile, 8));
  assert.equal(Buffer.from(encoded.bitmask, 'base64').length, 36);
  assert.deepEqual(decodeTile(encoded), picked);
});

test('ordinary res5 tile masks round trip and reject foreign cells and corrupt lengths', () => {
  const tile = tileForCell(base);
  const children = cellToChildren(tile, 8);
  const picked = children.filter((_, i) => i % 11 === 0);
  const packed = encodeTile(tile, picked);
  assert.equal(packed.childCount, 343);
  assert.equal(Buffer.from(packed.bitmask, 'base64').length, 43);
  assert.deepEqual(decodeTile(tile, packed.bitmask), picked);
  assert.throws(() => encodeTile(tile, [latLngToCell(0, 0, 8)]), /outside tile/);
  assert.throws(() => decodeTile(tile, 'AA=='), /mask length/);
});

test('explicit terrain adapter replaces approximations without pretending data was ingested', () => {
  setTerrainProvider((cell) => cell === base ? { isLand: true, type: 'urban', multiplier: 1.6, source: 'test fixture' } : null);
  try {
    const terrain = terrainForCell(base);
    assert.equal(terrain.multiplier, 1.6);
    assert.equal(terrain.approximate, false);
  } finally { setTerrainProvider(null); }
  assert.equal(terrainForCell(base).approximate, true);
});
