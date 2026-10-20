// Small DOM/canvas adapter. Executes the actual bundled client and actual API;
// it deliberately does not launch a browser or claim to verify visual layout.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { MemoryStore } from '../../src/server/store.js';
import { createApp } from '../../src/server/router.js';

const root = resolve(import.meta.dirname, '../..');
let bundledSource;
async function clientSource() {
  if (!bundledSource) bundledSource = (async () => {
    const source = await readFile(resolve(root, 'src/client/main.js'), 'utf8');
    const augmented = source.replace(/\ninit\(\);\s*$/, '') + `
      globalThis.clientCheck = {
        ready: init(), refreshState, refreshAuth, draw, frame, openPanel, ownerCells, changeZoom, focusAt, refreshTiles,
        mapSnapshot: () => ({zoom,mapKind,overview:mapOverview,tiles:tileCache.size,profiles:profiles.size,revision:viewRevision,projection:geometry().globe?'globe':'flat',center:geometry().center}),
        autoMiniAppLogin, pollWorld, setupTelegram, ensureUnitControls, unitCommandView,
        state: () => ({ account, model, placing, selecting, activePanel, authBusy, connectionErrors })
      };
    `;
    const output = await build({ stdin: { contents: augmented, resolveDir: resolve(root, 'src/client'), sourcefile: 'client-check.js' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' });
    return output.outputFiles[0].text;
  })();
  return bundledSource;
}

export async function createClientHarness({ env = {}, origin = 'http://127.0.0.1:4173', cookieBlocked = false, storageBlocked = false, launchData = '', session = new Map(), store = new MemoryStore(), network = { offline: false, failures: new Map() } } = {}) {
  const nodes = new Set(), byId = new Map(), contexts = [];
  function context2d() {
    const calls = new Map();
    const context = new Proxy({ calls, measureText: text => ({ width: text.length * 6 }), createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, {
      get(target, key) { return key in target ? target[key] : (...args) => calls.set(key, (calls.get(key) || 0) + 1); },
      set(target, key, value) { target[key] = value; return true; },
    });
    contexts.push(context);
    return context;
  }
  function matches(node, selector) {
    if (selector === 'dialog[open]') return node.tagName === 'dialog' && node.open;
    if (selector.includes(',')) return selector.split(',').some(value => matches(node, value));
    const attribute = selector.match(/^\[([^\]]+)\]$/);
    return attribute ? node.attrs.has(attribute[1]) : node.tagName === selector;
  }
  class Element {
    constructor(tagName, attrs = {}, parent = null) {
      Object.assign(this, { tagName, attrs: new Map(Object.entries(attrs)), parent, children: [], dataset: {}, listeners: new Map(), textContent: '', _html: '', open: false });
      this.hidden = this.attrs.has('hidden'); this.disabled = this.attrs.has('disabled'); this.value = attrs.value || '';
      const properties = new Map(), classes = new Set((attrs.class || '').split(' '));
      this.style = { setProperty: (name, value) => properties.set(name, value), getPropertyValue: name => properties.get(name) || '' };
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); return force; } };
      for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      if (attrs.id) { assert.ok(!byId.has(attrs.id), 'duplicate id ' + attrs.id); this.id = attrs.id; byId.set(this.id, this); }
      if (parent) parent.children.push(this);
      nodes.add(this);
    }
    set innerHTML(value) {
      const remove = node => { for (const child of node.children) remove(child); nodes.delete(node); if (node.id) byId.delete(node.id); };
      for (const child of this.children) remove(child);
      this.children = []; this._html = value; parse(value, this);
    }
    get innerHTML() { return this._html; }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    getContext() { return this.context ||= context2d(); }
    getBoundingClientRect() { return { width: 1280, height: 800, left: 0, top: 0, right: 1280, bottom: 800 }; }
    setPointerCapture() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    closest(selector) { return matches(this, selector) ? this : this.parent?.closest(selector) || null; }
    matches(selector) { return matches(this, selector); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    appendChild(node) { this.children.push(node); node.parent = this; }
  }
  function parse(source, parent = null) {
    const stack = parent ? [parent] : [];
    for (const tag of source.matchAll(/<\/?([A-Za-z][\w-]*)\b([^>]*)>/g)) {
      const closing = tag[0].startsWith('</'), name = tag[1].toLowerCase();
      if (closing) { while (stack.length && stack.at(-1).tagName !== name) stack.pop(); if (stack.at(-1)?.tagName === name) stack.pop(); continue; }
      const attrs = {};
      for (const attr of tag[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const node = new Element(name, attrs, stack.at(-1));
      if (!['meta', 'link', 'input', 'img', 'br', 'hr', 'use'].includes(name) && !tag[0].endsWith('/>')) stack.push(node);
    }
  }
  parse(await readFile(resolve(root, 'src/client/index.html'), 'utf8'));
  const documentEvents = new Map(), windowEvents = new Map();
  const document = { hidden: false, getElementById: id => byId.get(id) || null, createElement: tag => new Element(tag), querySelectorAll: selector => [...nodes].filter(node => matches(node, selector)), querySelector: selector => [...nodes].find(node => matches(node, selector)) || null, addEventListener: (name, handler) => documentEvents.set(name, handler), documentElement: [...nodes].find(node => node.tagName === 'html') };
  const app = createApp({ store, env: { LOCAL_DEV: true, APP_ORIGIN: origin, GOOGLE_AUTH_ENABLED: 'false', ...env } });
  const cookies = new Map(), storage = new Map(), requests = [], details = [];
  async function fetchApi(path, options = {}) {
    if (network.offline) throw new TypeError('offline');
    const failures = network.failures?.get(path) || 0;
    if (failures) { network.failures.set(path, failures - 1); throw new TypeError('network failure'); }
    requests.push(path);
    if(network.beforeRequest)await network.beforeRequest(path,options);
    const headers = new Headers(options.headers || {});
    if (!cookieBlocked) headers.set('cookie', [...cookies].map(([key, value]) => key + '=' + value).join('; '));
    if (options.method === 'POST') headers.set('origin', origin);
    details.push({ path, headers });
    const response = await app.fetch(new Request(origin + path, { ...options, headers }));
    if (!cookieBlocked) for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0], split = pair.indexOf('='), key = pair.slice(0, split), data = pair.slice(split + 1);
      data ? cookies.set(key, data) : cookies.delete(key);
    }
    return response;
  }
  const frames = new Map(), timers = new Map(); let nextHandle = 1;
  const sessionStorage = {
    getItem(key) { if (storageBlocked) throw new Error('storage blocked'); return session.get(key) || null; },
    setItem(key, value) { if (storageBlocked) throw new Error('storage blocked'); session.set(key, value); },
    removeItem(key) { if (storageBlocked) throw new Error('storage blocked'); session.delete(key); },
  };
  const globals = { document, fetch: fetchApi, Image: class { complete = false; naturalWidth = 0; }, ResizeObserver: class { observe() {} }, devicePixelRatio: 1,
    requestAnimationFrame(callback) { const id = nextHandle++; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setInterval() {}, setTimeout(callback, ms) { const id = nextHandle++; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    console, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa, performance, AbortSignal, AbortController,
    navigator: { userAgent: 'client-check', language: 'ru' }, screen: { width: 1280, height: 800, colorDepth: 24 },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, sessionStorage,
    location: { hash: launchData ? '#tgWebAppData=' + encodeURIComponent(launchData) + '&tgWebAppPlatform=web' : '', pathname: '/', search: '', assign(url) { this.assigned = url; }, reload() {} },
    history: { replaceState() {} }, addEventListener: (name, handler) => windowEvents.set(name, handler),
  };
  const sandbox = vm.createContext(globals); sandbox.window = sandbox;
  vm.runInContext(await clientSource(), sandbox, { timeout: 5000 });
  const $ = id => { const node = byId.get(id); assert.ok(node, 'missing element ' + id); return node; };
  await sandbox.clientCheck.ready;
  return { client: sandbox.clientCheck, $, document, app, store, sandbox, network, requests, details, session, frames, timers, contexts, documentEvents, windowEvents };
}
