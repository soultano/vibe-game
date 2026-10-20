import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClientHarness } from './helpers/client-harness.mjs';
import { readTelegramInitData, removeTelegramInitData, telegramLink } from '../src/client/telegram.js';

const token = '123456:synthetic-client-test-token';
const env = { LOCAL_DEV: false, TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: 'DominionTestBot' };
function launch(overrides = {}) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'client-' + crypto.randomUUID(), user: JSON.stringify({ id: 88776655, first_name: 'Командир' }), ...overrides };
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const options = () => ({ env, origin: 'https://game.example', cookieBlocked: true, launchData: launch() });

test('Telegram launch works without SDK or third-party cookies; session survives reload and logs out', async () => {
  const settings = options();
  const first = await createClientHarness(settings);
  assert.equal(first.client.state().account.provider, 'telegram');
  assert.equal(first.$('authCard').hidden, true);
  assert.equal(first.$('spawnCard').hidden, false);
  assert.ok(first.session.has('pd-session'));
  assert.equal(first.requests.filter(path => path === '/api/auth/telegram/miniapp').length, 1);
  const second = await createClientHarness({ ...settings, session: first.session, store: first.store });
  assert.equal(second.client.state().account.id, first.client.state().account.id);
  assert.ok(!second.requests.includes('/api/auth/telegram/miniapp'), 'restoring a session must not reuse the Telegram proof');
  await second.$('logoutBtn').onclick();
  assert.equal(second.client.state().account, null);
  assert.equal(second.session.has('pd-session'), false);
  const third = await createClientHarness({ ...settings, launchData: '', session: second.session, store: first.store });
  assert.equal(third.client.state().account, null, 'revoked bearer token cannot restore a session');
});

test('Telegram works in memory when both cookies and sessionStorage are unavailable', async () => {
  const h = await createClientHarness({ ...options(), storageBlocked: true });
  assert.ok(h.client.state().account);
  await h.client.refreshAuth();
  assert.equal(h.client.state().account.provider, 'telegram');
  const signedRequests = h.details.filter(request => request.path === '/api/auth/me' && request.headers.has('authorization'));
  assert.ok(signedRequests.length);
  assert.ok(h.details.some(request => request.path === '/api/auth/telegram/miniapp' && request.headers.has('x-login-token')));
  await h.$('logoutBtn').onclick();
  assert.equal(h.client.state().account, null);
});

test('failed Mini App network request has an actionable retry and cannot strand the login button', async () => {
  const network = { offline: false, failures: new Map([['/api/auth/telegram/miniapp', 1]]) };
  const h = await createClientHarness({ ...options(), network });
  assert.equal(h.client.state().account, null);
  assert.equal(h.$('telegramLogin').disabled, false);
  assert.match(h.$('authNotice').textContent, /повторить/);
  await h.$('telegramLogin').onclick();
  assert.equal(h.client.state().account.provider, 'telegram');
  assert.equal(h.$('telegramLogin').getAttribute('aria-busy'), 'false');
});

test('expired launch offers a new Telegram launch instead of endlessly replaying stale initData', async () => {
  const h = await createClientHarness({ ...options(), launchData: launch({ auth_date: String(Math.floor(Date.now() / 1000) - 301) }) });
  assert.equal(h.client.state().account, null);
  assert.match(h.$('authNotice').textContent, /устарел/);
  await h.$('telegramLogin').onclick();
  assert.equal(h.sandbox.location.assigned, 'https://t.me/DominionTestBot?startapp=play');
});

test('ordinary browser can launch the app, open the bot fallback or choose the Telegram login widget', async () => {
  const h = await createClientHarness({ ...options(), launchData: '' });
  assert.equal(h.$('browserTelegramLogin').hidden, false);
  assert.equal(h.$('telegramBotLink').href, 'https://t.me/DominionTestBot');
  await h.$('telegramLogin').onclick();
  assert.equal(h.sandbox.location.assigned, 'https://t.me/DominionTestBot?startapp=play');
  h.$('browserTelegramLogin').onclick();
  assert.equal(h.$('telegramWidget').children.length, 1);
  h.$('browserTelegramLogin').onclick();
  assert.equal(h.$('telegramWidget').children.length, 1);
});

test('launch parsing keeps signed bytes intact and removes only authentication data from URL', () => {
  const raw = launch();
  const location = { hash: '#tgWebAppData=' + encodeURIComponent(raw) + '&tgWebAppPlatform=web', search: '?campaign=fall', pathname: '/' };
  assert.equal(readTelegramInitData(location), raw);
  assert.equal(readTelegramInitData({ search: '?tgWebAppData=' + encodeURIComponent(raw) }), raw);
  assert.equal(readTelegramInitData(location, { initData: 'from-sdk' }), 'from-sdk');
  let target;
  removeTelegramInitData(location, { replaceState: (_, __, value) => { target = value; } });
  assert.equal(target, '/?campaign=fall#tgWebAppPlatform=web');
  assert.equal(telegramLink('bad/name'), null);
});

test('idle canvas stops scheduling frames; ordinary hover reuses the ownership index and cached map', async () => {
  const h = await createClientHarness();
  const flush = now => { const queued = [...h.frames.values()]; h.frames.clear(); queued.forEach(callback => callback(now)); };
  flush(100);
  assert.equal(h.frames.size, 0, 'idle map must not run a permanent animation loop');
  assert.strictEqual(h.client.ownerCells(), h.client.ownerCells(), 'unchanged ownership does not allocate a fresh index');
  const staticPaints = h.contexts[1].calls.get('fillRect');
  h.client.draw(200);
  assert.equal(h.contexts[1].calls.get('fillRect'), staticPaints, 'rendering an effect must reuse the static layer');
  h.$('worldCanvas').listeners.get('pointermove')({ pointerId: 1, clientX: 600, clientY: 400 });
  assert.equal(h.frames.size, 0, 'ordinary hover updates a tooltip without repainting the map');
  h.document.hidden = true;
  await h.documentEvents.get('visibilitychange')();
  assert.equal(h.frames.size, 0);
});

test('registration modal opens from welcome card with single registration button and authenticates via credentials', async () => {
  const h = await createClientHarness({ ...options(), launchData: '' });
  assert.equal(h.$('authCard').hidden, false);
  assert.ok(h.$('openAuthModalBtn'), 'openAuthModalBtn must exist in authCard');
  
  // Open modal
  h.$('openAuthModalBtn').onclick();
  assert.equal(h.$('authModal').open, true);

  // Fill credentials and register
  h.$('credUsername').value = 'Commandant99';
  h.$('credPassword').value = 'strongPassWord123';
  await h.$('credRegisterBtn').onclick();

  // Verify successful authentication
  assert.ok(h.client.state().account);
  assert.equal(h.client.state().account.name, 'Commandant99');
  assert.equal(h.client.state().account.provider, 'credentials');
  assert.equal(h.$('authModal').open, false);
  assert.equal(h.$('authCard').hidden, true);
  assert.equal(h.$('spawnCard').hidden, false);
});
