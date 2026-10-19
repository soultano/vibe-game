// Exercise actual loading/interaction code with a renderer and network adapter.
// No browser or GPU is started; GLB validity is checked in faction-assets.test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

const root = resolve(import.meta.dirname, '..');
const result = await build({ entryPoints: [resolve(root, 'src/client/headquarters-3d.js')], bundle: true, write: false, format: 'iife', globalName: 'viewerModule', platform: 'browser', target: 'es2022', plugins: [{ name: 'renderer-adapter', setup(builder) {
  builder.onResolve({ filter: /^three$/ }, () => ({ path: 'three-adapter', namespace: 'test' }));
  builder.onResolve({ filter: /^three\/addons\/loaders\/GLTFLoader\.js$/ }, () => ({ path: 'loader-adapter', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ resolveDir: root, contents: path === 'loader-adapter' ? 'export class GLTFLoader { loadAsync(url) { return globalThis.loadModel(url); } }' : `
    export * from ${JSON.stringify(resolve(root, 'node_modules/three/build/three.module.js'))};
    export class WebGLRenderer {
      constructor({canvas}) { globalThis.rendererCanvas = canvas; }
      setPixelRatio() {} setSize() {} setClearColor() {} dispose() {} forceContextLoss() {}
      render(scene) { const model = scene.children.find(child => child.isGroup); globalThis.paints.push({ model, angle: model.rotation.y }); }
    }
  ` }));
} }] });

function setup() {
  const frames = new Map(), events = new Map(), requests = new Map(), paints = []; let next = 0;
  const canvas = () => ({ width: 0, height: 0, hidden: true, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, setPointerCapture() {}, getContext() { return { clearRect() {}, drawImage() {} }; } });
  const document = { hidden: false, createElement: canvas, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const sandbox = vm.createContext({ document, console, paints,
    loadModel(url) { let complete; const promise = new Promise(resolve => { complete = resolve; }); requests.set(url, complete); return promise; },
    requestAnimationFrame(fn) { const id = ++next; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(result.outputFiles[0].text, sandbox);
  const loaded = id => {
    const scene = new Group(); scene.name = id; scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    requests.get('/assets/models/' + id + '.glb')({ scene });
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  return { canvas, document, sandbox, frames, events, requests, paints, loaded, tick, flush };
}

test('3D viewer shares models with the map and paints only after input', async () => {
  const h = setup(), engine = h.sandbox.viewerModule.createHeadquarters3D(), canvas = h.canvas(); let ready = 0;
  assert.equal(engine.getStamp('protocol'), null);
  engine.show(canvas, 'protocol', { ready() { ready++; canvas.hidden = false; } });
  await h.tick(); assert.equal(h.requests.size, 1);
  h.loaded('protocol'); await h.tick();
  assert.equal(ready, 1); assert.ok(engine.getStamp('protocol').hq3dReady); assert.equal(h.frames.size, 0);
  const before = h.paints.length;
  canvas.listeners.get('pointerdown')({ pointerId: 2, button: 0, clientX: 20 });
  canvas.listeners.get('pointermove')({ pointerId: 2, clientX: 40 });
  canvas.listeners.get('pointermove')({ pointerId: 2, clientX: 60 });
  assert.equal(h.frames.size, 1, 'multiple pointer moves coalesce into one paint');
  h.flush(); assert.equal(h.paints.length, before + 1); assert.equal(h.frames.size, 0);
  assert.ok(Math.abs(h.paints.at(-1).angle - (-.35 + 40 * .012)) < 1e-6);
  canvas.listeners.get('pointerup')();
  canvas.listeners.get('keydown')({ key: 'Home', preventDefault() {} }); h.flush(); assert.equal(h.paints.at(-1).angle, -.35);
  engine.dispose(); assert.equal(h.events.has('visibilitychange'), false);
});

test('first model reply arriving in background paints successfully after resume', async () => {
  const h = setup(), engine = h.sandbox.viewerModule.createHeadquarters3D(), canvas = h.canvas(); let ready = 0;
  engine.show(canvas, 'bloom', { ready() { ready++; canvas.hidden = false; } }); await h.tick();
  h.document.hidden = true; h.loaded('bloom'); await h.tick();
  assert.equal(h.paints.length, 0); assert.equal(ready, 0); assert.equal(h.frames.size, 0);
  h.document.hidden = false; h.events.get('visibilitychange')();
  assert.equal(ready, 1); assert.equal(canvas.hidden, false); assert.ok(engine.getStamp('bloom') === null);
  await h.tick(); assert.ok(engine.getStamp('bloom').hq3dReady);
  engine.dispose();
});

test('fast faction switching ignores stale replies and context loss uses the fallback', async () => {
  const h = setup(); let unavailable = 0, oldReady = 0, latestReady = 0, fallback = 0;
  const engine = h.sandbox.viewerModule.createHeadquarters3D({ onUnavailable() { unavailable++; } }), canvas = h.canvas();
  engine.show(canvas, 'pack', { ready() { oldReady++; } });
  engine.show(canvas, 'swarm', { ready() { latestReady++; canvas.hidden = false; }, fallback() { fallback++; } }); await h.tick();
  h.loaded('swarm'); await h.tick(); h.loaded('pack'); await h.tick();
  assert.equal(oldReady, 0); assert.equal(latestReady, 1);
  engine.rotate(canvas, .2);
  assert.equal(h.paints.at(-1).model.children[0].children[0].name, 'swarm');
  h.sandbox.rendererCanvas.listeners.get('webglcontextlost')({ preventDefault() {} });
  assert.equal(fallback, 1); assert.equal(unavailable, 1); assert.equal(engine.getStamp('swarm'), null);
  engine.dispose();
});
