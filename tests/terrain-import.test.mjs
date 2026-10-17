import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latLngToCell, getPentagons, cellToChildren } from 'h3-js';
import { classifyTerrain, validateWeights, packTerrainRecords, readPackedTerrainCell, importTerrain } from '../scripts/import-terrain.mjs';

const cell = latLngToCell(41.3111, 69.2797, 8);

test('prepared WorldCover/GHSL samples classify and pack without claiming global data', () => {
  const data = packTerrainRecords([{ cell, classes: [{ worldCoverClass: 10, weight: 0.3 }, { worldCoverClass: 40, weight: 0.7 }],
    ghslBuiltup: 0.01, slope: 3, coastal: true }], { source: 'unit test fixture, not a real satellite observation' });
  assert.equal(data.manifest.globalDatasetAggregated, false);
  assert.equal(data.manifest.coverage, 'prepared-samples-only');
  assert.equal(data.tiles[0].nibbles.length, 172);
  assert.equal(data.tiles[0].presence.length, 43);
  assert.deepEqual(readPackedTerrainCell(data.tiles[0], cell), { type: 'cropland', multiplier: 1.2 + 0.15,
    isLand: true, coastal: true, approximate: false, source: 'prepared terrain pack; see manifest provenance' });
  const missing = cellToChildren(data.tiles[0].parent, 8).find((value) => value !== cell);
  assert.equal(readPackedTerrainCell(data.tiles[0], missing), null);
  assert.equal(classifyTerrain({ cell, worldCoverClass: 10, ghslBuiltup: 0.3 }).type, 'urban');
  assert.equal(classifyTerrain({ cell, worldCoverClass: 10, slope: 26 }).type, 'mountain');
  assert.equal(classifyTerrain({ cell, worldCoverClass: 80, slope: 26, coastal: true }).code, 0);
});

test('ingest rejects invalid cells, classes, fractions and non-normalized area weights', () => {
  assert.throws(() => packTerrainRecords([{ cell: 'invalid', worldCoverClass: 10 }]), /resolution 8/);
  assert.throws(() => packTerrainRecords([{ cell: latLngToCell(0, 0, 7), worldCoverClass: 10 }]), /resolution 8/);
  assert.throws(() => classifyTerrain({ cell, worldCoverClass: 17 }), /WorldCover class/);
  assert.throws(() => classifyTerrain({ cell, worldCoverClass: 10, ghslBuiltup: 200 }), /normalized fraction/);
  assert.throws(() => validateWeights([{ worldCoverClass: 10, weight: 0.9 }]), /sum to 1/);
  assert.throws(() => validateWeights([{ worldCoverClass: 10, weight: -1 }, { worldCoverClass: 20, weight: 2 }]), /positive area fractions/);
  assert.throws(() => packTerrainRecords([{ cell, worldCoverClass: 10 }, { cell, worldCoverClass: 40 }]), /Duplicate/);
});

test('pentagon last child uses H3 child positions and correctly sized nibble/presence arrays', () => {
  const parent = getPentagons(5)[0];
  const children = cellToChildren(parent, 8);
  const last = children.at(-1);
  const { tiles } = packTerrainRecords([{ cell: children[0], worldCoverClass: 10 }, { cell: last, worldCoverClass: 50 }]);
  assert.equal(tiles[0].childCount, 286);
  assert.equal(tiles[0].nibbles.length, 143);
  assert.equal(tiles[0].presence.length, 36);
  assert.equal(readPackedTerrainCell(tiles[0], last).type, 'urban');
  assert.equal(readPackedTerrainCell(tiles[0], children[0]).type, 'forest');
  assert.equal(readPackedTerrainCell(tiles[0], children[1]), null);
});

test('real JSONL file ingestion produces binary tiles and refuses existing output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pixel-terrain-test-'));
  try {
    const input = join(folder, 'samples.jsonl'), output = join(folder, 'pack');
    await writeFile(input, `${JSON.stringify({ cell, worldCoverClass: 50, ghslBuiltup: 0.5, slope: 0, coastal: false })}\n`);
    const manifest = await importTerrain(input, output, { source: 'test fixture only' });
    const saved = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(saved, manifest);
    assert.equal((await readFile(join(output, manifest.tiles[0].file))).length, 172);
    await assert.rejects(importTerrain(input, output), /EEXIST/);
    const invalid = join(folder, 'invalid.json'), invalidOutput = join(folder, 'invalid-pack');
    await writeFile(invalid, JSON.stringify([{ cell: 'bad', worldCoverClass: 10 }]));
    await assert.rejects(importTerrain(invalid, invalidOutput), /resolution 8/);
    await assert.rejects(access(invalidOutput), /ENOENT/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
