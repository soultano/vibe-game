import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { createApp } from '../src/server/router.js';
import { MemoryStore } from '../src/server/store.js';
import { tileForCell, decodeTile } from '../src/shared/geography.js';
import { upgradeDurationMs } from '../src/shared/economy.js';

const origin = 'http://127.0.0.1:9999';
const base = latLngToCell(41.3111, 69.2797, 8);

function harness(extraEnv = {}) {
  const store = new MemoryStore();
  let now = Date.now();
  const app = createApp({ store, env: { LOCAL_DEV: 'true', ...extraEnv }, clock: () => now,
    serveAsset: async () => new Response('static fixture') });
  const cookieJar = new Map();
  let csrf;
  async function call(path, { method = 'GET', body, authenticated = true, token = csrf, requestOrigin = origin, headers = {} } = {}) {
    const response = await app.fetch(new Request(`${requestOrigin}${path}`, { method, headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { origin: requestOrigin } : {}),
      ...(authenticated ? { cookie: [...cookieJar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...(token ? { 'x-csrf-token': token } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const split = pair.indexOf('=');
      const key = pair.slice(0, split), value = pair.slice(split + 1);
      if (value) cookieJar.set(key, value); else cookieJar.delete(key);
    }
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, response, data };
  }
  async function login() {
    const anonymous = await call('/api/auth/me');
    assert.equal(anonymous.status, 200); assert.equal(anonymous.data.account, null);
    assert.ok(anonymous.data.csrfToken); assert.ok(cookieJar.has('pd_login'));
    const signed = await call('/api/auth/dev', { method: 'POST', body: { name: 'HTTP Operator', fingerprint: 'http-integration-device-123' } });
    assert.equal(signed.status, 200, JSON.stringify(signed.data));
    assert.equal(signed.data.account.provider, 'development'); assert.ok(cookieJar.has('pd_session'));
    return signed.data.account;
  }
  return { app, store, call, login, advance: milliseconds => { now += milliseconds; }, now: () => now, cookieJar };
}

test('HTTP: session challenge, single base, installments, offline growth, compact tiles and logout', async () => {
  const h = harness();
  assert.equal((await h.call('/api/state', { authenticated: false })).status, 401);
  const account = await h.login();
  assert.equal((await h.call('/api/state')).data.player, null);
  const body = { cell: base, faction: 'protocol', azimuth: 0, level: 30, energy: 1e20, crystals: 1e20, pixels: 1e9,
    tLast: 0, energyTLast: 0, serverTime: 9999999999999, createdAt: 0 };
  assert.equal((await h.call('/api/base', { method: 'POST', body, token: 'forged-csrf' })).status, 403);
  assert.equal((await h.call('/api/base', { method: 'POST', body, headers: { origin: 'https://attacker.example' } })).status, 403);
  const placed = await h.call('/api/base', { method: 'POST', body });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(placed.data.player.id, account.id); assert.equal(placed.data.player.level, 1);
  assert.equal(placed.data.player.energy, 75); assert.equal(placed.data.player.crystals, 0); assert.equal(placed.data.player.pixels, 1);
  assert.equal(placed.data.serverTime, h.now()); assert.equal(placed.data.player.createdAt, h.now());
  assert.equal(placed.data.player.fingerprintHash, undefined); assert.equal(placed.data.player.seed, undefined);
  assert.equal((await h.call('/api/base', { method: 'POST', body })).status, 409);
  assert.equal((await h.store.list('player:')).length, 1);

  const partial = await h.call('/api/upgrades/fund', { method: 'POST', body: { amount: 20, level: 30, energy: 1e20, now: 9999999999999 } });
  assert.equal(partial.status, 200); assert.equal(partial.data.player.project.invested, 20);
  assert.equal(partial.data.player.project.completesAt, null); assert.equal(partial.data.player.energy, 55);
  const funded = await h.call('/api/upgrades/fund', { method: 'POST', body: { amount: 30, elapsedMs: 1e15 } });
  assert.equal(funded.status, 200); assert.equal(funded.data.player.project.status, 'building');
  assert.equal(funded.data.player.energy, 25); assert.equal(funded.data.player.level, 1);
  h.advance(upgradeDurationMs(1) + 1);
  const grown = await h.call('/api/state?serverTime=9999999999999&elapsed=100000000000');
  assert.equal(grown.status, 200); assert.equal(grown.data.serverTime, h.now());
  assert.equal(grown.data.player.level, 2); assert.ok(grown.data.player.pixels > 1);
  assert.equal(grown.data.player.crystals, 0); assert.equal(grown.data.player.project.invested, 0);

  const parent = tileForCell(base);
  const tile = await h.call('/api/tiles', { method: 'POST', body: { parents: [parent] } });
  assert.equal(tile.status, 200, JSON.stringify(tile.data));
  assert.equal(tile.data.tiles[0].full, true);
  const cells = decodeTile(parent, tile.data.tiles[0].owners[account.id]);
  assert.ok(cells.includes(base)); assert.ok(cells.length > 1);
  assert.equal((await h.store.list('cell:')).length, 0, 'ownership is not stored as individual cell records');
  const unchanged = await h.call('/api/tiles', { method: 'POST', body: { parents: [parent], versions: { [parent]: tile.data.tiles[0].version } } });
  assert.equal(unchanged.data.tiles[0].unchanged, true);
  h.advance(60_000);
  const changed = await h.call('/api/tiles', { method: 'POST', body: { parents: [parent], versions: { [parent]: tile.data.tiles[0].version }, serverTime: 9999999999999, energy: 1e20 } });
  assert.equal(changed.status, 200); assert.ok(changed.data.tiles[0].changes.length > 0); assert.ok(changed.data.tiles[0].diffBitmask);
  assert.equal(changed.data.serverTime, h.now());
  const logout = await h.call('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200); assert.equal(h.cookieJar.has('pd_session'), false);
  assert.equal((await h.call('/api/state')).status, 401);
  assert.equal((await h.call('/api/base', { method: 'POST', body })).status, 401);
});

test('HTTP: production disables local login and does not accept a local development session', async () => {
  const h = harness({ APP_ORIGIN: 'https://world.example' });
  const providers = await h.call('/api/auth/providers', { requestOrigin: 'https://world.example' });
  assert.equal(providers.data.development, false); assert.equal(providers.data.google.enabled, false);
  const denied = await h.call('/api/auth/dev', { method: 'POST', body: { name: 'Attacker', fingerprint: 'spoofed-device-123' }, requestOrigin: 'https://world.example' });
  assert.equal(denied.status, 404);
  assert.equal((await h.store.list('account:')).length, 0);
});

test('HTTP: unconfigured checkout and billing fail closed without any Stripe fetch', async () => {
  let calls = 0;
  const h = harness({ STRIPE_FETCH: async () => { calls++; throw new Error('Real payment requests are forbidden in this test'); } });
  await h.login();
  await h.call('/api/base', { method: 'POST', body: { cell: base, faction: 'pack', azimuth: 90 } });
  const shop = await h.call('/api/shop');
  assert.equal(shop.status, 200); assert.equal(shop.data.payments.enabled, false); assert.equal(shop.data.items.length, 8);
  assert.equal((await h.call('/api/checkout', { method: 'POST', body: { sku: 'crystals_80', price: 0 } })).status, 503);
  assert.equal((await h.call('/api/billing/portal', { method: 'POST', body: { customerId: 'cus_attacker' } })).status, 503);
  assert.equal((await h.call('/api/billing/cancel', { method: 'POST', body: { subscriptionId: 'sub_attacker' } })).status, 503);
  assert.equal((await h.call('/api/webhooks/stripe', { method: 'POST', body: {} })).status, 503);
  assert.equal(calls, 0); assert.equal((await h.store.list('payment:')).length, 0);
});

test('HTTP: billing portal and cancel require CSRF and use only saved private provider IDs', async () => {
  let calls = 0;
  const h = harness({ APP_ORIGIN: origin, STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_mock', STRIPE_FETCH: async (url, options) => {
    calls++;
    const params = new URLSearchParams(options.body);
    if (url.endsWith('/billing_portal/sessions')) {
      assert.equal(params.get('customer'), 'cus_saved');
      return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/unit_test' }));
    }
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_saved');
    assert.equal(params.get('cancel_at_period_end'), 'true');
    return new Response(JSON.stringify({ id: 'sub_saved', object: 'subscription', customer: 'cus_saved', livemode: false, cancel_at_period_end: true }));
  } });
  const account = await h.login();
  await h.call('/api/base', { method: 'POST', body: { cell: base } });
  const row = await h.store.get(`player:${account.id}`);
  await h.store.atomic({ checks: [{ key: `player:${account.id}`, version: row.version }], puts: [{ key: `player:${account.id}`, value: { ...row.value, stripeCustomerId: 'cus_saved', stripeSubscriptionId: 'sub_saved', vipUntil: h.now() + 86400000 } }] });
  const visible = await h.call('/api/state');
  assert.equal(visible.data.player.stripeCustomerId, undefined); assert.equal(visible.data.player.stripeSubscriptionId, undefined);
  assert.equal((await h.call('/api/billing/portal', { method: 'POST', token: 'forged', body: {} })).status, 403);
  const portal = await h.call('/api/billing/portal', { method: 'POST', body: { customerId: 'cus_attacker' } });
  assert.equal(portal.status, 200, JSON.stringify(portal.data)); assert.match(portal.data.url, /^https:\/\/billing\.stripe\.com\//);
  const cancel = await h.call('/api/billing/cancel', { method: 'POST', body: { subscriptionId: 'sub_attacker' } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data)); assert.equal(cancel.data.cancelAtPeriodEnd, true);
  assert.equal((await h.store.get(`player:${account.id}`)).value.vipUntil, h.now() + 86400000); assert.equal(calls, 2);
});

test('HTTP: abilities require a base, session and CSRF; canonical boosts and paid replay stay server-authoritative', async () => {
  const h=harness(),payload={abilityId:'infantry',requestId:'http-ability-free-0001'};
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:payload,authenticated:false})).status,401);
  assert.equal((await h.call('/api/abilities/use')).status,405);
  const account=await h.login();
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:payload})).status,409);
  await h.call('/api/base',{method:'POST',body:{cell:base,faction:'protocol'}});
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:payload,token:'forged'})).status,403);
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:payload,headers:{origin:'https://attacker.example'}})).status,403);
  const cast=await h.call('/api/abilities/use',{method:'POST',body:{...payload,bonus:999,cooldownMs:0,durationMs:1e30,crystals:1e20,now:1e20}});
  assert.equal(cast.status,200,JSON.stringify(cast.data));
  const infantry=cast.data.player.abilities.find(a=>a.id==='infantry');
  assert.equal(infantry.activeUntil-h.now(),30_000);assert.equal(infantry.readyAt-h.now(),60_000);
  assert.equal(cast.data.player.captureMultiplier,1.25);assert.equal(cast.data.player.crystals,0);
  assert.equal(cast.data.player.abilityReceipts,undefined);
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:{...payload,requestId:'http-ability-free-0002'}})).status,429);
  const paid={...payload,requestId:'http-ability-paid-0001',resetCooldown:true};
  assert.equal((await h.call('/api/abilities/use',{method:'POST',body:paid})).status,409);
  const row=await h.store.get('player:'+account.id);
  await h.store.atomic({checks:[{key:'player:'+account.id,version:row.version}],puts:[{key:'player:'+account.id,value:{...row.value,crystals:3}}]});
  const repeat=await h.call('/api/abilities/use',{method:'POST',body:paid});assert.equal(repeat.status,200);assert.equal(repeat.data.player.crystals,1);
  const duplicate=await h.call('/api/abilities/use',{method:'POST',body:paid});assert.equal(duplicate.status,200);assert.equal(duplicate.data.player.crystals,1);
});
