// Runs after `npm run build`. Exercises the emitted Worker and real Node HTTP
// transport using SQLite, without a browser or external payment requests.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { latLngToCell, cellToParent } from 'h3-js';

const project = resolve(import.meta.dirname, '..');
const bundlePath = join(project, 'dist/server/index.js');
const factionIds = ['protocol', 'vanguard', 'bloom', 'swarm', 'pack'];
const baseCell = latLngToCell(41.3111, 69.2797, 8);
const parentCell = cellToParent(baseCell, 5);

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else result.push(path);
  }
  return result;
}

async function assertFreshBuild() {
  let built;
  try { built = (await stat(bundlePath)).mtimeMs; }
  catch { throw new Error('Worker bundle missing. Run npm run build first.'); }
  const sources = [...await sourceFiles(join(project, 'src')), join(project, 'data/world-mask.json'), join(project, 'drizzle/0000_world.sql')];
  for (const path of sources) if ((await stat(path)).mtimeMs > built) throw new Error(`Worker bundle is stale after ${path}. Run npm run build first.`);
}

function sqliteD1(db) {
  const counts = { statements: 0, bound: 0, batches: 0 };
  return {
    counts,
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...bindings) { values = bindings; counts.bound++; return statement; },
        async first(column) { counts.statements++; const row = db.prepare(sql).get(...values); return row ? column ? row[column] : row : null; },
        async all() { counts.statements++; return { results: db.prepare(sql).all(...values), success: true }; },
        run() { counts.statements++; return db.prepare(sql).run(...values); },
      };
      return statement;
    },
    async batch(statements) {
      counts.batches++;
      db.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => statement.run()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

async function checkWorker() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(join(project, 'drizzle/0000_world.sql'), 'utf8'));
    const DB = sqliteD1(db);
    const worker = (await import(pathToFileURL(bundlePath).href)).default;
    const origin = 'https://worker-check.example';
    const env = { DB, APP_ORIGIN: origin, LOCAL_DEV: true };
    const call = (path, options) => worker.fetch(new Request(`${origin}${path}`, options), env);
    const home = await call('/');
    assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /^text\/html/);
    assert.equal(await home.text(), await readFile(join(project, 'src/client/index.html'), 'utf8'));
    for (const id of factionIds) {
      const path = `/assets/factions/${id}.png`;
      const response = await call(path);
      assert.equal(response.status, 200, path); assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(project, 'src/client', path)), `embedded ${id}.png must exactly match the source`);
    }
    for (const id of factionIds) { const response=await call(`/assets/headquarters/${id}.png`);assert.equal(response.status,302);assert.equal(response.headers.get('location'),`https://raw.githubusercontent.com/soultano/vibe-game/main/src/client/assets/headquarters/${id}.png`); }
    const config = await (await call('/api/config')).json();
    assert.equal(config.cellResolution, 8); assert.equal(config.tileResolution, 5);
    assert.deepEqual(config.factions.map(faction => faction.id), factionIds);
    const health = await (await call('/api/health')).json();
    assert.equal(health.ok, true); assert.equal(health.storage, 'persistent'); assert.equal(health.timeAuthority, 'server');
    const anonymous = await call('/api/auth/me');
    assert.equal(anonymous.status, 200); const me = await anonymous.json();
    assert.equal(me.account, null); assert.ok(me.csrfToken);
    const loginCookie = anonymous.headers.getSetCookie().find(value => value.startsWith('__Host-pd_login='));
    assert.ok(loginCookie); assert.match(loginCookie, /; Secure/); assert.match(loginCookie, /; HttpOnly/); assert.match(loginCookie, /; Path=\//);
    const providers = await (await call('/api/auth/providers')).json();
    assert.equal(providers.development, false, 'the Worker must override LOCAL_DEV:true');
    assert.equal((await call('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ name: 'Denied', fingerprint: 'worker-check-device' }) })).status, 404);
    const tilesPath = `/api/tiles?parents=${parentCell}`;
    const first = await call(tilesPath);
    assert.equal(first.status, 200); assert.match(first.headers.get('cache-control'), /public/);
    const etag = first.headers.get('etag'); assert.ok(etag);
    const tiles = await first.json(); assert.equal(tiles.tiles.length, 1); assert.equal(tiles.tiles[0].parent, parentCell);
    assert.equal(tiles.tiles[0].version, 0); assert.deepEqual(tiles.tiles[0].owners, {});
    const unchanged = await call(tilesPath, { headers: { 'if-none-match': etag } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), ''); assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal((await call('/api/nonexistent-check')).status, 404);
    assert.equal((await call('/nonexistent-check')).status, 404);
    assert.ok(DB.counts.statements > 0 && DB.counts.bound > 0 && DB.counts.batches > 0, 'the emitted Worker must exercise actual prepared SQL and transaction bindings');
    assert.equal(db.prepare('SELECT count(*) AS count FROM records WHERE key LIKE ?').get('login:%').count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM _atomic_guard').get().count, 0);
    console.log(`Worker OK: HTML, five exact PNGs, H3 config, SQL storage, host cookies, disabled dev auth, tile ETag/304, 404 (${DB.counts.statements} real SQL statements).`);
  } finally { db.close(); }
}

async function assertFreePort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function startServer(directory) {
  const port = 4199, origin = `http://127.0.0.1:${port}`;
  await assertFreePort(port);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: String(port), APP_ORIGIN: origin, LOCAL_DEV: 'true', DATABASE_PATH: join(directory, 'world.sqlite'),
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  } });
  let output = '', spawnError;
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const result = await Promise.race([exited, delay(2500).then(() => null)]);
    if (!result) { child.kill('SIGKILL'); await exited; }
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Owned Node server exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { origin, stop };
      } catch { /* The owned server has not started listening yet. */ }
      await delay(100);
    }
    throw new Error(`Owned Node server did not start: ${output}`);
  } catch (error) { await stop(); throw error; }
}

async function checkNodeTransport() {
  const directory = await mkdtemp(join(tmpdir(), 'dominion-http-check-'));
  let server;
  const cookies = new Map();
  let csrf;
  async function call(path, { method = 'GET', body, csrfToken = csrf, headers = {} } = {}) {
    const response = await fetch(`${server.origin}${path}`, { method, headers: {
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { origin: server.origin } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], separator = pair.indexOf('=');
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (value) cookies.set(name, value); else cookies.delete(name);
    }
    const data = await response.json();
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  }
  try {
    server = await startServer(directory);
    assert.equal((await call('/api/state')).status, 401);
    const anonymous = await call('/api/auth/me'); assert.equal(anonymous.status, 200); assert.equal(anonymous.data.account, null); assert.ok(cookies.has('pd_login'));
    const logged = await call('/api/auth/dev', { method: 'POST', body: { name: 'Transport Operator', fingerprint: 'transport-check-fingerprint' } });
    assert.equal(logged.status, 200, JSON.stringify(logged.data)); assert.ok(cookies.has('pd_session'));
    const id = logged.data.account.id;
    const baseBody = { cell: baseCell, faction: 'protocol', azimuth: 45, level: 30, energy: 1e20, crystals: 1e20, serverTime: 9999999999999 };
    assert.equal((await call('/api/base', { method: 'POST', body: baseBody, csrfToken: 'forged' })).status, 403);
    const placed = await call('/api/base', { method: 'POST', body: baseBody });
    assert.equal(placed.status, 200, JSON.stringify(placed.data)); assert.equal(placed.data.player.level, 1); assert.equal(placed.data.player.energy, 75); assert.equal(placed.data.player.crystals, 0);
    assert.equal((await call('/api/base', { method: 'POST', body: baseBody })).status, 409);
    const funding = await call('/api/upgrades/fund', { method: 'POST', body: { amount: 20 } });
    assert.equal(funding.status, 200); assert.equal(funding.data.player.project.invested, 20);
    await server.stop(); server = undefined;
    // Reopen the same actual SQLite file in another owned process. Session,
    // account, base and funded construction must all survive process exit.
    server = await startServer(directory);
    const restarted = await call('/api/state');
    assert.equal(restarted.status, 200, JSON.stringify(restarted.data)); assert.equal(restarted.data.player.id, id);
    assert.equal(restarted.data.player.baseCell, baseCell); assert.equal(restarted.data.player.project.invested, 20);
    const me = await call('/api/auth/me'); assert.equal(me.data.account.id, id);
    assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await call('/api/state')).status, 401); assert.equal(cookies.has('pd_session'), false);
    console.log('Node HTTP OK: owned loopback :4199, real cookies/CSRF, single base, funding, SQLite/session persistence across process restart, logout.');
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

await assertFreshBuild();
await checkWorker();
await checkNodeTransport();
console.log('All built-worker and Node transport checks passed. No browser or real payment requests were used.');
