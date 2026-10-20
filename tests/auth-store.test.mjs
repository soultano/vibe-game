import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, D1Store } from '../src/server/store.js';
import { createLocalStore } from '../src/server/local-store.js';
import { handleAuth, getAuthContext, requireAuth } from '../src/server/auth.js';

const local = { LOCAL_DEV: 'true' };
const fingerprint = 'unit-test-device-unique';
const localOrigin = 'http://127.0.0.1:9999';
const productionOrigin = 'https://world.example';

function request(path, { method = 'GET', body, cookie, csrf, origin = localOrigin, headers = {} } = {}) {
  return new Request(`${origin}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function cookieValue(response, name) {
  const header = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`) || value.startsWith(`__Host-${name}=`));
  return header?.split(';')[0];
}
async function challenge(store, env = local, origin = localOrigin) {
  const response = await handleAuth(request('/api/auth/me', { origin }), env, store);
  const value = await response.json();
  return { cookie: cookieValue(response, 'pd_login'), csrf: value.csrfToken };
}
async function devSignIn(store) {
  const token = await challenge(store);
  const response = await handleAuth(request('/api/auth/dev', { method: 'POST', body: { name: 'Тестер', fingerprint }, ...token }), local, store);
  assert.equal(response.status, 200);
  return { response, data: await response.json(), cookie: cookieValue(response, 'pd_session') };
}

function d1Adapter(db) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return db.prepare(sql).get(...bindings) || null; },
        async all() { return { results: db.prepare(sql).all(...bindings) }; },
        execute() { return db.prepare(sql).run(...bindings); }
      };
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const output = statements.map(statement => statement.execute()); db.exec('COMMIT'); return output; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}

for (const kind of ['memory', 'sqlite', 'd1']) {
  test(`${kind}: compare-and-swap is atomic, versioned, and prefix-scoped`, async () => {
    let store, db;
    if (kind === 'memory') store = new MemoryStore();
    if (kind === 'sqlite') store = await createLocalStore(':memory:');
    if (kind === 'd1') {
      db = new DatabaseSync(':memory:');
      db.exec(await readFile(new URL('../drizzle/0000_world.sql', import.meta.url), 'utf8'));
      store = new D1Store(d1Adapter(db));
    }
    try {
      assert.equal(await store.atomic({ checks: [{ key: 'player:a', version: null }], puts: [{ key: 'player:a', value: { energy: 10 } }, { key: 'player:b', value: { energy: 20 } }] }), true);
      assert.equal(await store.atomic({ checks: [{ key: 'player:a', version: 2 }], puts: [{ key: 'player:a', value: { energy: 999 } }], deletes: ['player:b'] }), false);
      assert.deepEqual(await store.get('player:a'), { value: { energy: 10 }, version: 1 });
      assert.equal((await store.get('player:b')).value.energy, 20);
      assert.equal(await store.atomic({ checks: [{ key: 'player:a', version: 1 }], puts: [{ key: 'player:a', value: { energy: 7 } }, { key: 'players-extra', value: {} }] }), true);
      assert.deepEqual((await store.list('player:', { limit: 1 })).map(entry => entry.key), ['player:a']);
      assert.equal((await store.get('player:a')).version, 2);
      const raced = await Promise.all([store.atomic({ checks: [{ key: 'player:a', version: 2 }], puts: [{ key: 'player:a', value: { energy: 5 } }] }), store.atomic({ checks: [{ key: 'player:a', version: 2 }], puts: [{ key: 'player:a', value: { energy: 3 } }] })]);
      assert.equal(raced.filter(Boolean).length, 1);
      const isolated = await store.get('player:a');
      isolated.value.energy = 0;
      assert.notEqual((await store.get('player:a')).value.energy, 0);
      if (db) assert.equal(db.prepare('SELECT count(*) AS count FROM _atomic_guard').get().count, 0);
    } finally { store.close?.(); db?.close(); }
  });
}

test('SQLite survives close and reopen with exactly one applied migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dominion-store-'));
  const path = join(directory, 'world.sqlite');
  try {
    const first = await createLocalStore(path);
    await first.atomic({ puts: [{ key: 'account:alice', value: { name: 'Alice' } }] });
    first.close();
    const second = await createLocalStore(path);
    assert.deepEqual(await second.get('account:alice'), { value: { name: 'Alice' }, version: 1 });
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production never accepts the local development login or cookie', async () => {
  const store = new MemoryStore();
  const disabled = await handleAuth(request('/api/auth/dev', { method: 'POST', body: { name: 'Owner', fingerprint }, origin: productionOrigin }), { LOCAL_DEV: 'true', APP_ORIGIN: productionOrigin }, store);
  assert.equal(disabled.status, 404);
  const signed = await devSignIn(store);
  assert.equal(await getAuthContext(request('/api/auth/me', { cookie: signed.cookie, origin: productionOrigin }), { LOCAL_DEV: 'true' }, store), null);
  const providers = await handleAuth(request('/api/auth/providers', { origin: productionOrigin }), { LOCAL_DEV: 'true' }, store);
  assert.equal((await providers.json()).development, false);
});

test('local account has a hashed device, opaque session and CSRF+origin guarded writes', async () => {
  const store = new MemoryStore();
  const signed = await devSignIn(store);
  assert.match(signed.data.account.name, /\[DEV\]$/);
  assert.equal(signed.data.account.provider, 'development');
  assert.equal(signed.data.account.fingerprintHash, undefined);
  const stored = await store.get(`account:${signed.data.account.id}`);
  assert.notEqual(stored.value.fingerprintHash, fingerprint);
  assert.ok(stored.value.createdAt <= Date.now());
  assert.match(signed.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signed.response.headers.get('set-cookie'), /SameSite=Lax/);
  const sessions = await store.list('session:');
  assert.equal(sessions.length, 1);
  assert.ok(!JSON.stringify(sessions).includes(signed.cookie.split('=')[1]));
  await assert.rejects(() => requireAuth(request('/api/test', { method: 'POST', cookie: signed.cookie }), local, store, { write: true }), error => error.status === 403);
  await assert.rejects(() => requireAuth(request('/api/test', { method: 'POST', cookie: signed.cookie, csrf: signed.data.csrfToken, headers: { origin: 'https://attacker.example' } }), local, store, { write: true }), error => error.status === 403);
  const context = await requireAuth(request('/api/test', { method: 'POST', cookie: signed.cookie, csrf: signed.data.csrfToken }), local, store, { write: true });
  assert.equal(context.account.id, signed.data.account.id);
  const logout = await handleAuth(request('/api/auth/logout', { method: 'POST', cookie: signed.cookie, csrf: signed.data.csrfToken }), local, store);
  assert.equal(logout.status, 200);
  assert.equal(await getAuthContext(request('/api/test', { cookie: signed.cookie }), local, store), null);
});

test('anonymous login requires CSRF challenge and rejects expired sessions', async () => {
  const store = new MemoryStore();
  const missing = await handleAuth(request('/api/auth/dev', { method: 'POST', body: { name: 'Owner', fingerprint } }), local, store);
  assert.equal(missing.status, 403);
  const signed = await devSignIn(store);
  const [session] = await store.list('session:');
  await store.atomic({ puts: [{ key: session.key, value: { ...session.value, expiresAt: Date.now() - 1 } }] });
  assert.equal(await getAuthContext(request('/api/test', { cookie: signed.cookie }), local, store), null);
});

const telegramEnv = { APP_ORIGIN: productionOrigin, TELEGRAM_BOT_TOKEN: '1234:test-secret-token', TELEGRAM_BOT_USERNAME: 'DominionTestBot' };
async function telegramPayload(overrides = {}) {
  const payload = { id: 99887766, first_name: 'Игрок', username: 'testuser', auth_date: Math.floor(Date.now() / 1000), ...overrides };
  const check = Object.keys(payload).sort().map(key => `${key}=${payload[key]}`).join('\n');
  const secret = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(telegramEnv.TELEGRAM_BOT_TOKEN));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  payload.hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(check)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return payload;
}
async function telegramAttempt(store, payload, options = {}) {
  const token = await challenge(store, telegramEnv, productionOrigin);
  return handleAuth(request('/api/auth/telegram', { method: 'POST', body: { telegram: payload, fingerprint }, origin: productionOrigin, ...token, ...options }), telegramEnv, store);
}
test('Telegram verifies HMAC, time, integer identity, replay and CSRF', async () => {
  const store = new MemoryStore();
  const payload = await telegramPayload();
  assert.equal((await telegramAttempt(store, { ...payload, first_name: 'Forged' })).status, 401);
  assert.equal((await telegramAttempt(store, await telegramPayload({ auth_date: Math.floor(Date.now() / 1000) - 301 }))).status, 401);
  assert.equal((await telegramAttempt(store, await telegramPayload({ auth_date: Math.floor(Date.now() / 1000) + 100 }))).status, 401);
  assert.equal((await telegramAttempt(store, await telegramPayload({ id: 1.5 }))).status, 401);
  assert.equal((await telegramAttempt(store, payload, { csrf: 'invalid' })).status, 403);
  const success = await telegramAttempt(store, payload);
  assert.equal(success.status, 200);
  assert.equal((await success.json()).account.provider, 'telegram');
  assert.match(success.headers.get('set-cookie'), /Secure/);
  assert.match(cookieValue(success, 'pd_session'), /^__Host-pd_session=/);
  const siblingCookie = cookieValue(success, 'pd_session').replace('__Host-', '');
  assert.equal(await getAuthContext(request('/api/auth/me', { origin: productionOrigin, cookie: siblingCookie }), telegramEnv, store), null, 'a sibling domain cannot inject an unprefixed production session cookie');
  assert.equal((await telegramAttempt(store, payload)).status, 401);
  assert.equal((await store.list('account:')).length, 1);
});

function b64(value) { return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url'); }
async function googleHarness(store) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const kid = crypto.randomUUID();
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  const env = { APP_ORIGIN: productionOrigin, GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'private-google-secret', GOOGLE_REDIRECT_URI: `${productionOrigin}/api/auth/google/callback` };
  let tokenRequests = 0, overrideClaims = {};
  env.AUTH_FETCH = async (url, options) => {
    if (url.includes('/certs')) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=10' } });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    tokenRequests++;
    const submitted = new URLSearchParams(options.body);
    assert.equal(submitted.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
    assert.ok(submitted.get('code_verifier').length >= 43);
    const claims = { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: 'google-subject-123', name: 'Google Player', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce: (await store.list('test-nonce:'))[0]?.value.nonce, ...overrideClaims };
    const prefix = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(prefix));
    return new Response(JSON.stringify({ id_token: `${prefix}.${Buffer.from(signature).toString('base64url')}` }));
  };
  return { env, get tokenRequests() { return tokenRequests; }, claims(value) { overrideClaims = value; } };
}
async function googleBegin(store, env) {
  const response = await handleAuth(request(`/api/auth/google/start?fingerprint=${fingerprint}`, { origin: productionOrigin }), env, store);
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location'));
  const state = target.searchParams.get('state');
  const [stored] = await store.list('oauth:');
  assert.equal(typeof stored.value.verifier, 'object', 'PKCE verifier is encrypted at rest');
  await store.atomic({ puts: [{ key: 'test-nonce:current', value: { nonce: target.searchParams.get('nonce') } }] });
  return { response, state, cookie: cookieValue(response, 'pd_oauth'), record: stored };
}
test('Google OAuth binds browser state, uses PKCE and signed nonce token, consumes state once', async () => {
  const store = new MemoryStore();
  const harness = await googleHarness(store);
  const start = await googleBegin(store, harness.env);
  const callback = `/api/auth/google/callback?state=${start.state}&code=server-code`;
  assert.equal((await handleAuth(request(callback, { origin: productionOrigin, cookie: 'pd_oauth=wrong' }), harness.env, store)).status, 401);
  assert.equal(harness.tokenRequests, 0);
  const success = await handleAuth(request(callback, { origin: productionOrigin, cookie: start.cookie }), harness.env, store);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get('location'), '/');
  assert.equal(harness.tokenRequests, 1);
  const account = await getAuthContext(request('/api/auth/me', { origin: productionOrigin, cookie: cookieValue(success, 'pd_session') }), harness.env, store);
  assert.equal(account.account.provider, 'google');
  assert.equal((await handleAuth(request(callback, { origin: productionOrigin, cookie: start.cookie }), harness.env, store)).status, 401);
  assert.equal(harness.tokenRequests, 1);
});

test('Google rejects expired OAuth state and signed tokens with wrong audience or nonce', async () => {
  const store = new MemoryStore();
  const harness = await googleHarness(store);
  const expired = await googleBegin(store, harness.env);
  await store.atomic({ puts: [{ key: expired.record.key, value: { ...expired.record.value, expiresAt: Date.now() - 1 } }] });
  assert.equal((await handleAuth(request(`/api/auth/google/callback?state=${expired.state}&code=test`, { origin: productionOrigin, cookie: expired.cookie }), harness.env, store)).status, 401);
  assert.equal(harness.tokenRequests, 0);
  for (const invalidClaims of [{ aud: 'attacker-client' }, { nonce: 'forged-nonce' }, { exp: Math.floor(Date.now() / 1000) - 1 }]) {
    // Remove the deliberately expired state so the helper can inspect the new record.
    await store.atomic({ deletes: (await store.list('oauth:')).map(value => value.key) });
    const start = await googleBegin(store, harness.env);
    harness.claims(invalidClaims);
    const response = await handleAuth(request(`/api/auth/google/callback?state=${start.state}&code=test`, { origin: productionOrigin, cookie: start.cookie }), harness.env, store);
    assert.equal(response.status, 401);
  }
  assert.equal((await store.list('account:')).length, 0);
});

test('production web guest uses CSRF and a random session; a fingerprint cannot recover another guest',async()=>{
 const store=new MemoryStore(),env={APP_ORIGIN:productionOrigin};
 const denied=await handleAuth(request('/api/auth/guest',{method:'POST',origin:productionOrigin,body:{name:'Guest',fingerprint}}),env,store);assert.equal(denied.status,403);
 const firstChallenge=await challenge(store,env,productionOrigin);
 const response=await handleAuth(request('/api/auth/guest',{method:'POST',origin:productionOrigin,body:{name:'Guest',fingerprint},...firstChallenge}),env,store);assert.equal(response.status,200);
 const first=await response.json(),sessionCookie=cookieValue(response,'pd_session');assert.equal(first.account.provider,'guest');assert.ok(sessionCookie);assert.match(response.headers.get('set-cookie'),/HttpOnly/);
 const current=await getAuthContext(request('/api/auth/me',{origin:productionOrigin,cookie:sessionCookie}),env,store);assert.equal(current.account.id,first.account.id);
 const secondChallenge=await challenge(store,env,productionOrigin),other=await handleAuth(request('/api/auth/guest',{method:'POST',origin:productionOrigin,body:{name:'Guest',fingerprint},...secondChallenge}),env,store);
 assert.notEqual((await other.json()).account.id,first.account.id,'device signals never authenticate a guest');
 const forged=await handleAuth(request('/api/auth/guest',{method:'POST',origin:'https://attacker.example',body:{fingerprint},...firstChallenge}),env,store);assert.equal(forged.status,403);
});
