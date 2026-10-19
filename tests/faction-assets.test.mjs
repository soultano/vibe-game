import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { validateBytes } from 'gltf-validator';
import sharp from 'sharp';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from 'three';
import { createAssetLibrary } from '../src/client/asset-library.js';
import { normalizeHeadquarters, disposeHeadquarters } from '../src/client/model-geometry.js';
import { headquartersFor } from '../src/shared/headquarters.js';
import { createClientHarness } from './helpers/client-harness.mjs';

const assetRoot = resolve(import.meta.dirname, '../src/client/assets');
const ids = ['protocol', 'vanguard', 'bloom', 'swarm', 'pack'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('map and multiple viewers share one fetch, decoded model and stamp', async () => {
  const request = deferred(), model = {}, stamp = {}, loads = [], painted = [], ready = [];
  const library = createAssetLibrary({ load: id => { loads.push(id); return request.promise; }, makeStamp: asset => { painted.push(asset); return stamp; }, onReady: id => ready.push(id) });
  assert.equal(library.getStamp('pack'), null);
  const one = library.ensure('pack'), two = library.ensure('pack');
  assert.strictEqual(one, two);
  request.resolve(model);
  assert.strictEqual(await one, model);
  assert.strictEqual(library.getStamp('pack'), stamp);
  assert.deepEqual(loads, ['pack']); assert.deepEqual(painted, [model]); assert.deepEqual(ready, ['pack']);
  library.dispose();
});

test('failed model stays cached on map redraws and retries only on explicit inspection', async () => {
  let count = 0;
  const library = createAssetLibrary({ load: async () => { if (++count === 1) throw new Error('offline'); return 'model'; }, makeStamp: () => 'stamp' });
  await assert.rejects(library.ensure('bloom'), /offline/);
  for (let i = 0; i < 20; i++) assert.equal(library.getStamp('bloom'), null);
  assert.equal(count, 1);
  assert.equal(await library.retry('bloom'), 'model');
  assert.equal(library.getStamp('bloom'), 'stamp'); assert.equal(count, 2);
  library.dispose();
});

test('disposal releases a late model once and prevents further downloads', async () => {
  const request = deferred(), released = [], model = {};
  const library = createAssetLibrary({ load: () => request.promise, makeStamp: () => assert.fail('must not render a disposed model'), disposeAsset: asset => released.push(asset) });
  const pending = library.ensure('protocol'); await Promise.resolve();
  library.dispose(); request.resolve(model);
  await assert.rejects(pending, /closed/);
  library.dispose();
  assert.deepEqual(released, [model]); assert.equal(library.getStamp('protocol'), null);
  await assert.rejects(library.ensure('pack'), /closed/);
});

test('failed stamp generation releases GPU data before an explicit retry', async () => {
  const released = [], model = {};
  const library = createAssetLibrary({ load: () => model, makeStamp: () => { throw new Error('context lost'); }, disposeAsset: asset => released.push(asset) });
  await assert.rejects(library.ensure('protocol'), /context lost/);
  library.dispose(); assert.deepEqual(released, [model]);
});

test('model normalization centers the footprint, puts the floor at zero and preserves mesh data', () => {
  const geometry = new BoxGeometry(4, 10, 6), material = new MeshStandardMaterial();
  const scene = new Group(), mesh = new Mesh(geometry, material); mesh.position.set(9, 13, -4); scene.add(mesh);
  const pivot = normalizeHeadquarters(scene), box = new Box3().setFromObject(pivot), center = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  assert.ok(Math.abs(box.min.y) < 1e-6); assert.ok(Math.abs(center.x) < 1e-6); assert.ok(Math.abs(center.z) < 1e-6);
  assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - 2) < 1e-6);
  assert.strictEqual(mesh.geometry, geometry); assert.strictEqual(mesh.material, material);
  assert.throws(() => normalizeHeadquarters(new Group()), /Empty/);
  disposeHeadquarters(pivot);
});

test('shared meshes, materials and textures are disposed only once', () => {
  const geometry = new BoxGeometry(), material = new MeshStandardMaterial(), texture = new Texture(), root = new Group();
  material.map = texture; material.normalMap = texture;
  root.add(new Mesh(geometry, material), new Mesh(geometry, material));
  const counts = { geometry: 0, material: 0, texture: 0 };
  for (const [name, object] of Object.entries({ geometry, material, texture })) object.addEventListener('dispose', () => counts[name]++);
  disposeHeadquarters(root); assert.deepEqual(counts, { geometry: 1, material: 1, texture: 1 });
});

test('all five GLBs validate, are self-contained, have PBR textures and fit the game budget', async t => {
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'models/manifest.json'), 'utf8'));
  const io = new NodeIO(); let totalBytes = 0, credits = 0;
  for (const id of ids) await t.test(id, async () => {
    const spec = headquartersFor(id), record = manifest.models[id];
    assert.equal(spec.model, record.file); assert.equal(spec.poster, record.poster);
    const bytes = await readFile(resolve(assetRoot, 'models', id + '.glb'));
    const report = await validateBytes(new Uint8Array(bytes));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.filter(message => message.severity === 0).slice(0, 5)));
    assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues.messages.slice(0, 5)));
    const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    assert.ok(gltf.buffers.every(buffer => !buffer.uri)); assert.ok(gltf.images.every(image => image.bufferView !== undefined));
    assert.ok(!gltf.extensionsRequired?.length, 'runtime must not require a network decoder');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    const doc = await io.readBinary(bytes);
    let triangles = 0;
    for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) triangles += primitive.getIndices().getCount() / 3;
    assert.equal(triangles, record.triangles); assert.ok(triangles < 5000);
    for (const material of doc.getRoot().listMaterials()) {
      assert.ok(material.getBaseColorTexture()); assert.ok(material.getNormalTexture()); assert.ok(material.getMetallicRoughnessTexture());
    }
    for (const texture of doc.getRoot().listTextures()) {
      const info = await sharp(texture.getImage()).metadata(); assert.ok(info.width <= 1024 && info.height <= 1024);
    }
    const poster = await sharp(resolve(assetRoot, 'models', id + '-poster.webp')).stats();
    assert.equal(poster.channels[3].min, 0, 'poster has genuine transparency'); assert.equal(poster.channels[3].max, 255);
    assert.equal(bytes.length, record.bytes); totalBytes += bytes.length; credits += record.consumedCredits;
  });
  assert.ok(totalBytes < 3800000, `model budget exceeded: ${totalBytes}`); assert.equal(credits, 75);
});

test('headquarters inspection works for all factions without WebGL and does not change the chosen faction', async () => {
  const h = await createClientHarness();
  const first = h.document.querySelectorAll('[data-model]').find(node => node.dataset.model === 'bloom');
  await h.$('factionAtlas').onclick({ target: first });
  assert.equal(h.$('headquartersDialog').open, true); assert.equal(h.$('factionsDialog').open, false);
  for (const id of ids) {
    const button = h.document.querySelectorAll('[data-model-faction]').find(node => node.dataset.modelFaction === id);
    await h.$('modelFactionPicker').onclick({ target: button });
    assert.equal(h.$('modelTitle').textContent, headquartersFor(id).name);
    assert.equal(h.$('modelPoster').src, headquartersFor(id).poster);
    assert.equal(h.$('modelPoster').hidden, false); assert.equal(h.$('modelCanvas').hidden, true);
    assert.equal(h.$('modelControls').hidden, true); assert.equal(h.$('modelHelp').hidden, true);
    assert.match(h.$('modelStatus').textContent, /изображение/);
  }
  await h.$('spawnModelBtn').onclick(); assert.equal(h.$('modelTitle').textContent, headquartersFor('protocol').name);
  assert.equal(h.client.state().account, null);
});
