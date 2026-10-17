#!/usr/bin/env node
/** Offline packer for PREPARED H3 samples. Does not download or rasterize ESA/GHSL. */
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { isValidCell, getResolution, cellToParent, cellToChildrenSize, cellToChildPos } from 'h3-js';

export const TERRAIN_CODES = Object.freeze({ water: 0, urban: 1, cropland: 2, grassland: 3, forest: 4, shrub: 5, mountain: 6, desert: 7 });
const TERRAIN_NAMES = Object.freeze(Object.keys(TERRAIN_CODES));
const MULTIPLIERS = Object.freeze([0, 1.6, 1.2, 1.05, 1, 0.75, 0.7, 0.4]);
const WORLD_COVER = Object.freeze({ 10: 'forest', 20: 'shrub', 30: 'grassland', 40: 'cropland', 50: 'urban', 60: 'desert', 70: 'desert', 80: 'water', 90: 'grassland', 95: 'forest', 100: 'shrub' });
const HASH = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validWorldCover(value) {
  if (!Number.isInteger(value) || !Object.hasOwn(WORLD_COVER, value)) throw new TypeError(`Unsupported WorldCover class: ${String(value)}`);
  return value;
}

/** Weighted input represents area fractions in ONE H3 cell, not population. */
export function validateWeights(classes) {
  if (!Array.isArray(classes) || !classes.length) throw new TypeError('classes must be a non-empty array');
  let sum = 0;
  for (const entry of classes) {
    if (!entry || typeof entry !== 'object') throw new TypeError('Invalid weighted class');
    validWorldCover(entry.worldCoverClass);
    if (!Number.isFinite(entry.weight) || entry.weight <= 0 || entry.weight > 1) throw new RangeError('Class weights must be finite positive area fractions in (0,1]');
    sum += entry.weight;
  }
  if (Math.abs(sum - 1) > 1e-6) throw new RangeError(`Class weights must sum to 1, received ${sum}`);
  return classes;
}

export function classifyTerrain(record, { builtupThreshold = 0.2, mountainSlopeDegrees = 25 } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Terrain record must be an object');
  if (typeof record.cell !== 'string' || !isValidCell(record.cell) || getResolution(record.cell) !== 8) throw new TypeError(`Expected H3 resolution 8 cell, received ${String(record.cell)}`);
  if (!Number.isFinite(builtupThreshold) || builtupThreshold < 0 || builtupThreshold > 1) throw new RangeError('Invalid built-up threshold');
  if (!Number.isFinite(mountainSlopeDegrees) || mountainSlopeDegrees < 0 || mountainSlopeDegrees > 90) throw new RangeError('Invalid mountain slope threshold');
  const ghslBuiltup = record.ghslBuiltup ?? 0;
  const slope = record.slope ?? 0;
  const coastal = record.coastal ?? false;
  if (!Number.isFinite(ghslBuiltup) || ghslBuiltup < 0 || ghslBuiltup > 1) throw new RangeError('ghslBuiltup must be a normalized fraction in [0,1], not raw square meters');
  if (!Number.isFinite(slope) || slope < 0 || slope > 90) throw new RangeError('slope must be degrees in [0,90]');
  if (typeof coastal !== 'boolean') throw new TypeError('coastal must be boolean');
  if (record.classes && record.worldCoverClass !== undefined) throw new TypeError('Specify either worldCoverClass or weighted classes');
  const entries = record.classes ? validateWeights(record.classes)
    : [{ worldCoverClass: validWorldCover(record.worldCoverClass), weight: 1 }];
  const weights = new Map();
  for (const { worldCoverClass, weight } of entries) weights.set(worldCoverClass, (weights.get(worldCoverClass) ?? 0) + weight);
  // Majority WorldCover class, then fixed numeric tie-break. A 4-bit code cannot
  // preserve a continuous weighted terrain yield; this quantization is explicit.
  const worldCoverClass = [...weights].sort(([a, aw], [b, bw]) => bw - aw || a - b)[0][0];
  let type = WORLD_COVER[worldCoverClass];
  if (type !== 'water') {
    if (slope > mountainSlopeDegrees) type = 'mountain';
    else if (ghslBuiltup >= builtupThreshold) type = 'urban';
  }
  const isCoastal = type !== 'water' && coastal;
  return { cell: record.cell, type, worldCoverClass, coastal: isCoastal,
    code: TERRAIN_CODES[type] | (isCoastal ? 8 : 0),
    multiplier: MULTIPLIERS[TERRAIN_CODES[type]] + (isCoastal ? 0.15 : 0), isLand: type !== 'water' };
}

class TerrainPacker {
  constructor(options = {}) { this.options = options; this.tiles = new Map(); this.cells = 0; }
  add(record) {
    const terrain = classifyTerrain(record, this.options);
    const parent = cellToParent(terrain.cell, 5);
    let tile = this.tiles.get(parent);
    if (!tile) {
      const childCount = cellToChildrenSize(parent, 8);
      tile = { parent, childCount, count: 0, nibbles: new Uint8Array(Math.ceil(childCount / 2)), presence: new Uint8Array(Math.ceil(childCount / 8)) };
      this.tiles.set(parent, tile);
    }
    const position = cellToChildPos(terrain.cell, 5);
    const bit = 1 << (position % 8);
    if (tile.presence[Math.floor(position / 8)] & bit) throw new TypeError(`Duplicate H3 cell: ${terrain.cell}`);
    tile.presence[Math.floor(position / 8)] |= bit;
    const shift = position % 2 * 4;
    tile.nibbles[Math.floor(position / 2)] |= terrain.code << shift;
    tile.count++;
    this.cells++;
  }
  result() {
    if (!this.cells) throw new RangeError('No prepared terrain cells supplied');
    const tiles = [...this.tiles.values()].sort((a, b) => a.parent.localeCompare(b.parent));
    const manifest = {
      format: 'pixel-dominion-terrain-v1', h3Resolution: 8, tileResolution: 5,
      coverage: 'prepared-samples-only', globalDatasetAggregated: false,
      source: this.options.source || 'User-prepared H3 samples; provenance not independently verified',
      classification: { builtupThreshold: this.options.builtupThreshold ?? 0.2, mountainSlopeDegrees: this.options.mountainSlopeDegrees ?? 25,
        worldCoverRule: 'dominant area-weighted class; numeric class tie-break',
        precedence: ['water', 'slope > mountainSlopeDegrees', 'ghslBuiltup >= builtupThreshold', 'WorldCover class'],
        coastal: 'Supplied boolean; must be computed from complete one-ring water neighbors upstream' },
      terrainCodes: TERRAIN_CODES, coastalBit: 8, cells: this.cells,
      tiles: tiles.map((tile) => ({ parent: tile.parent, childCount: tile.childCount, suppliedCells: tile.count,
        file: `${tile.parent}.terrain.bin`, presenceFile: `${tile.parent}.presence.bin`,
        bytes: tile.nibbles.length, presenceBytes: tile.presence.length,
        sha256: HASH(tile.nibbles), presenceSha256: HASH(tile.presence) })),
    };
    return { manifest, tiles };
  }
}

export function packTerrainRecords(records, options = {}) {
  const packer = new TerrainPacker(options);
  for (const record of records) packer.add(record);
  return packer.result();
}

/** Missing samples return null; unknown data is never silently treated as water. */
export function readPackedTerrainCell(tile, cell) {
  if (!isValidCell(cell) || getResolution(cell) !== 8 || cellToParent(cell, 5) !== tile.parent) return null;
  const position = cellToChildPos(cell, 5);
  if (!(tile.presence[Math.floor(position / 8)] & (1 << (position % 8)))) return null;
  const code = tile.nibbles[Math.floor(position / 2)] >> (position % 2 * 4) & 15;
  const baseCode = code & 7;
  const coastal = Boolean(code & 8);
  return { type: TERRAIN_NAMES[baseCode], multiplier: MULTIPLIERS[baseCode] + (coastal ? 0.15 : 0),
    isLand: baseCode !== 0, coastal, approximate: false, source: 'prepared terrain pack; see manifest provenance' };
}

async function* preparedRecords(inputPath) {
  if (/\.(?:jsonl|ndjson)$/i.test(inputPath)) {
    const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
    let number = 0;
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      try { yield JSON.parse(line); }
      catch (error) { throw new SyntaxError(`Invalid JSONL at line ${number}: ${error.message}`); }
    }
  } else {
    const content = JSON.parse(await readFile(inputPath, 'utf8'));
    const records = Array.isArray(content) ? content : content.cells;
    if (!Array.isArray(records)) throw new TypeError('JSON must be an array, or an object containing cells[]');
    yield* records;
  }
}

export async function importTerrain(inputPath, outputDirectory, options = {}) {
  const packer = new TerrainPacker(options);
  for await (const record of preparedRecords(inputPath)) packer.add(record);
  const result = packer.result();
  // Validate the entire input before creating output. Never overwrite a pack.
  await mkdir(outputDirectory, { recursive: false });
  for (const tile of result.tiles) {
    await writeFile(join(outputDirectory, `${tile.parent}.terrain.bin`), tile.nibbles, { flag: 'wx' });
    await writeFile(join(outputDirectory, `${tile.parent}.presence.bin`), tile.presence, { flag: 'wx' });
  }
  // Manifest is written last and acts as the completion marker.
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: 'wx' });
  return result.manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, outputDirectory, ...rest] = process.argv.slice(2);
  if (!inputPath || !outputDirectory || rest.length && rest[0] !== '--source') {
    process.stderr.write('Usage: node scripts/import-terrain.mjs prepared.json[l] NEW_OUTPUT_DIRECTORY [--source "provenance"]\n');
    process.exitCode = 1;
  } else {
    try {
      const manifest = await importTerrain(resolve(inputPath), resolve(outputDirectory), { source: rest[1] });
      process.stdout.write(`Packed ${manifest.cells} prepared cells in ${manifest.tiles.length} tiles. Full-world ESA/GHSL aggregation has NOT been performed.\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
