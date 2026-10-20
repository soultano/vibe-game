import { WebGLRenderer, Scene, OrthographicCamera, HemisphereLight, DirectionalLight, SRGBColorSpace, ACESFilmicToneMapping } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { headquartersFor } from '../shared/headquarters.js';
import { createAssetLibrary } from './asset-library.js';
import { normalizeHeadquarters, disposeHeadquarters } from './model-geometry.js';

const DEFAULT_ANGLE = -.35;

export function createHeadquarters3D({ onReady = () => {}, onUnavailable = () => {} } = {}) {
  const surface = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas: surface, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(512, 512, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new Scene(), camera = new OrthographicCamera(-1.65, 1.65, 1.65, -1.65, .1, 30);
  camera.position.set(3.2, 2.8, 4.5);
  camera.lookAt(0, .75, 0);
  scene.add(new HemisphereLight(0xe5f4ff, 0x283446, 2.8));
  const key = new DirectionalLight(0xfff2df, 3.6); key.position.set(-3, 6, 5); scene.add(key);
  const rim = new DirectionalLight(0xa5e5ff, 1.7); rim.position.set(4, 3, -4); scene.add(rim);
  const loader = new GLTFLoader();
  const views = new Map();
  let current = null, unavailable = false;

  function render(root, target, angle = DEFAULT_ANGLE) {
    if (unavailable || document.hidden) return false;
    if (current !== root) { if (current) scene.remove(current); scene.add(root); current = root; }
    root.rotation.y = angle;
    renderer.render(scene, camera);
    const context = target.getContext('2d');
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(surface, 0, 0, target.width, target.height);
    return true;
  }
  const library = createAssetLibrary({
    load: async id => normalizeHeadquarters((await loader.loadAsync(headquartersFor(id).model)).scene),
    makeStamp(root) {
      const stamp = document.createElement('canvas');
      stamp.width = stamp.height = 512;
      // Offscreen/hidden tabs do not initiate this renderer, but a network reply
      // may arrive after suspension. Paint once on resume instead of caching blank.
      if (!render(root, stamp)) return null;
      stamp.hq3dReady = true;
      return stamp;
    },
    disposeAsset: disposeHeadquarters,
    onReady,
    onError: id => onUnavailable(id),
  });
  const stamps = new Map();
  function stamp(id) {
    if (unavailable || document.hidden) return null;
    const cached = library.getStamp(id);
    if (cached) return cached;
    if (!stamps.has(id)) {
      const entry = { canvas: null }; stamps.set(id, entry);
      library.ensure(id).then(root => {
        if (unavailable || document.hidden) { stamps.delete(id); return; }
        const existing = library.getStamp(id);
        if (existing) { entry.canvas = existing; return; }
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
        render(root, canvas); canvas.hq3dReady = true; entry.canvas = canvas; onReady(id);
      }).catch(() => {});
    }
    return stamps.get(id)?.canvas || null;
  }

  function view(canvas, faction, { ready = () => {}, fallback = () => {} } = {}) {
    let state = views.get(canvas);
    if (!state) {
      canvas.width = canvas.height = 512;
      state = { faction, angle: DEFAULT_ANGLE, root: null, pointer: null, frame: null, ready, fallback, generation: 0 };
      const paint = () => { state.frame = null; if (state.root && !canvas.hidden && render(state.root, canvas, state.angle)) state.ready(); };
      const schedule = () => { if (state.frame === null && !document.hidden) state.frame = requestAnimationFrame(paint); };
      canvas.addEventListener('pointerdown', event => {
        if (event.button && event.button !== 0) return;
        canvas.setPointerCapture(event.pointerId);
        state.pointer = { id: event.pointerId, x: event.clientX, angle: state.angle };
      });
      canvas.addEventListener('pointermove', event => {
        if (!state.pointer || state.pointer.id !== event.pointerId || !state.root) return;
        state.angle = state.pointer.angle + (event.clientX - state.pointer.x) * .012;
        schedule();
      });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { state.pointer = null; });
      canvas.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        state.angle = event.key === 'Home' ? DEFAULT_ANGLE : state.angle + (event.key === 'ArrowLeft' ? -.2 : .2);
        schedule();
      });
      state.paint = paint; views.set(canvas, state);
    }
    state.ready = ready; state.fallback = fallback;
    if (state.faction !== faction) { state.faction = faction; state.angle = DEFAULT_ANGLE; state.root = null; }
    const generation = ++state.generation;
    library.retry(faction).then(root => {
      if (generation !== state.generation || unavailable) return;
      state.root = root;
      if (render(root, canvas, state.angle)) ready();
    }).catch(() => { if (generation === state.generation) fallback(); });
  }
  surface.addEventListener('webglcontextlost', event => {
    event.preventDefault(); unavailable = true;
    for (const state of views.values()) state.fallback();
    onUnavailable();
  });
  function resume() {
    if (document.hidden || unavailable) return;
    // A model may finish while the tab is hidden, before its first ready paint.
    for (const [canvas, state] of views) if (state.root && render(state.root, canvas, state.angle)) state.ready();
    onReady();
  }
  document.addEventListener('visibilitychange', resume);
  return {
    getStamp: stamp,
    getCachedStamp: id => library.peekStamp(id),
    show: view,
    rotate(canvas, delta) { const state = views.get(canvas); if (!state?.root) return; state.angle += delta; state.paint(); },
    reset(canvas) { const state = views.get(canvas); if (!state?.root) return; state.angle = DEFAULT_ANGLE; state.paint(); },
    dispose() {
      document.removeEventListener('visibilitychange', resume);
      for (const state of views.values()) if (state.frame !== null) cancelAnimationFrame(state.frame);
      unavailable = true; library.dispose(); renderer.dispose(); renderer.forceContextLoss(); views.clear(); stamps.clear();
    },
  };
}
