import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
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
function widgetUser() {
  const payload = { id: 88776655, first_name: 'Командир', auth_date: Math.floor(Date.now() / 1000) };
  const check = Object.keys(payload).sort().map(key => `${key}=${payload[key]}`).join('\n');
  payload.hash = createHmac('sha256', createHash('sha256').update(token).digest()).update(check).digest('hex');
  return payload;
}
async function placeBase(h) {
  const faction = h.document.querySelectorAll('[data-faction]').find(node => node.dataset.faction === 'swarm');
  await h.click('factionPicker', { target: faction });
  await h.click('startBtn');
  const event = { pointerId: 1, clientX: 640, clientY: 400 };
  h.$('worldCanvas').listeners.get('pointerdown')(event);
  await h.$('worldCanvas').listeners.get('pointerup')(event);
  assert.equal(h.client.state().model.player?.faction, 'swarm');
}

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
  assert.equal(h.visible('telegramLogin'), true);
  assert.match(h.$('authNotice').textContent, /повторить/);
  await h.click('telegramLogin');
  assert.equal(h.client.state().account.provider, 'telegram');
  assert.equal(h.$('telegramLogin').getAttribute('aria-busy'), 'false');
});

test('expired launch offers a new Telegram launch instead of endlessly replaying stale initData', async () => {
  const h = await createClientHarness({ ...options(), launchData: launch({ auth_date: String(Math.floor(Date.now() / 1000) - 301) }) });
  assert.equal(h.client.state().account, null);
  assert.match(h.$('authNotice').textContent, /устарел/);
  await h.click('telegramLogin');
  assert.equal(h.sandbox.location.assigned, 'https://t.me/DominionTestBot');
});

test('ordinary browser opens Telegram login in the current game window and shares the Mini App account', async () => {
  const h = await createClientHarness({ ...options(), launchData: '' });
  assert.equal(h.visible('telegramLogin'), false);
  assert.equal(h.visible('guestLogin'), false, 'login choices must be inside the registration modal');
  await h.click('openAuthModalBtn');
  assert.equal(h.visible('guestLogin'), false, 'production login must use Telegram');
  assert.equal(h.visible('modalTelegramBtn'), true);
  assert.equal(h.visible('telegramBotLink'), true);
  assert.equal(h.$('telegramBotLink').href, 'https://t.me/DominionTestBot');
  await h.click('modalTelegramBtn');
  assert.equal(h.sandbox.location.assigned, undefined, 'website login must keep the game on the website');
  assert.equal(h.$('modalTelegramWidget').children.length, 1);
  await h.click('modalTelegramBtn');
  assert.equal(h.$('modalTelegramWidget').children.length, 1);
  await h.sandbox.onTelegramAuth(widgetUser());
  assert.equal(h.client.state().account.provider, 'telegram');
  assert.equal(h.$('authModal').open, false);
  await placeBase(h);
  const mini = await createClientHarness({ ...options(), store: h.store });
  assert.equal(mini.client.state().account.id, h.client.state().account.id);
  assert.equal(mini.client.state().model.player.baseCell, h.client.state().model.player.baseCell);
  assert.equal(mini.client.state().model.player.faction, 'swarm');
  assert.equal(mini.visible('spawnCard'), false, 'the same account must resume its existing base');
});

test('local development can retry a failed guest login without Telegram', async () => {
  const network = { failures: new Map([['/api/auth/guest', 1]]) };
  const h = await createClientHarness({ cookieBlocked: true, network });
  await h.click('openAuthModalBtn');
  assert.equal(h.visible('modalTelegramBtn'), false);
  assert.equal(h.document.getElementById('modalGoogleBtn'), null);
  await h.click('guestLogin');
  assert.equal(h.client.state().account, null);
  assert.equal(h.$('authModal').open, true);
  assert.equal(h.$('guestLogin').disabled, false);
  assert.match(h.$('modalAuthNotice').textContent, /ещё раз/);
  await h.click('guestLogin');
  assert.equal(h.client.state().account.provider, 'guest');
  assert.equal(h.$('authModal').open, false);
  assert.equal(h.visible('spawnCard'), true);
});

test('Telegram widget failure leaves its fallback and login retry accessible', async () => {
  const h = await createClientHarness({ ...options(), launchData: '' });
  await h.click('openAuthModalBtn');
  await h.click('modalTelegramBtn');
  h.$('modalTelegramWidget').children[0].onerror();
  assert.equal(h.$('modalTelegramWidget').children.length, 0);
  assert.match(h.$('modalAuthNotice').textContent, /ещё раз/);
  await h.click('modalTelegramBtn');
  assert.equal(h.$('modalTelegramWidget').children.length, 1);
  assert.equal(h.visible('telegramBotLink'), true);
  assert.equal(h.visible('guestLogin'), false);
  await h.sandbox.onTelegramAuth(widgetUser());
  assert.equal(h.client.state().account.provider, 'telegram');
});

test('website and Mini App expose the same base, panels, abilities and army commands', async t => {
  const summaries = [];
  for (const platform of ['website', 'miniapp-without-sdk', 'miniapp-with-sdk']) {
    await t.test(platform, async () => {
      const proof = launch();
      const sdkCalls = [];
      const webApp = platform === 'miniapp-with-sdk' ? { initData: proof, ready: () => sdkCalls.push('ready'), expand: () => sdkCalls.push('expand') } : undefined;
      const h = await createClientHarness({ ...options(), launchData: platform === 'miniapp-without-sdk' ? proof : '', webApp });
      if (platform === 'website') {
        assert.equal(h.sandbox.Telegram, undefined);
        await h.click('openAuthModalBtn');
        await h.click('modalTelegramBtn');
        await h.sandbox.onTelegramAuth(widgetUser());
      }
      if (webApp) assert.deepEqual(sdkCalls, ['ready', 'expand']);
      await placeBase(h);
      for (const id of ['resourceBar', 'gameNav']) assert.equal(h.visible(id), true, id);
      assert.equal(h.visible('abilityBar'),false);
      const more=h.document.querySelectorAll('[data-open]').find(n=>n.dataset.open==='more');
      for (const panel of ['base', 'sector', 'rewards', 'ranking']) {
        if(panel!=='base')await h.click(more);
        const nav = h.document.querySelectorAll('[data-open]').find(node => node.dataset.open === panel);
        assert.equal(h.visible(nav), true);
        await h.click(nav);
        assert.equal(h.visible(panel + 'Panel'), true);
      }
      await h.click(more);
      h.$('armyControls').parent.open=true;
      await h.click('armyDefend');
      assert.equal(h.client.state().model.player.army.order.mode, 'defend');
      await h.click('armyExpand');
      assert.equal(h.client.state().model.player.army.order.mode, 'expand');
      await h.click(h.document.querySelectorAll('[data-open]').find(n=>n.dataset.open==='abilities'));
      await h.click('abilityBar', { target: h.$('ability-infantry') });
      assert.equal(h.client.state().model.player.captureMultiplier, 1.25);
      await h.client.ensureUnitControls();
      await h.click('armySquads');
      const unit = h.$('unitRoster').children[0];
      assert.ok(unit, 'own units must be available for selection');
      await h.click('unitRoster', { target: unit });
      h.$('unitExtra').open=true;
      for (const mode of ['move', 'attack', 'capture', 'hold', 'auto', 'focus']) assert.equal(h.visible('unit-' + mode), true, mode);
      await h.click('unit-hold');
      assert.ok(h.requests.includes('/api/army/unit-order'));
      await h.click('unitClose');
      h.client.openPanel('base');
      await h.click('fundBtn');
      const player = h.client.state().model.player;
      assert.equal(player.project.status, 'building');
      summaries.push({ faction: player.faction, level: player.level, multiplier: player.captureMultiplier, army: player.army.order.mode, project: player.project.status });
      h.$('profileButton').onclick();
      await h.click('logoutBtn');
      assert.equal(h.visible('authCard'), true);
      assert.equal(h.visible('resourceBar'), false);
    });
  }
  assert.deepEqual(summaries[0], summaries[1]);
  assert.deepEqual(summaries[0], summaries[2]);
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

test('production login offers only Telegram and retries a failed website login', async () => {
  const network = { failures: new Map([['/api/auth/telegram', 1]]) };
  const h = await createClientHarness({ ...options(), launchData: '', network });
  await h.click('openAuthModalBtn');
  for (const id of ['modalGoogleBtn', 'credUsername', 'credPassword', 'credAuthForm']) assert.equal(h.document.getElementById(id), null);
  assert.equal(h.visible('guestLogin'), false);
  await h.click('modalTelegramBtn');
  await h.sandbox.onTelegramAuth(widgetUser());
  assert.equal(h.client.state().account, null);
  assert.equal(h.$('authModal').open, true);
  assert.equal(h.$('modalTelegramBtn').disabled, false);
  await h.sandbox.onTelegramAuth(widgetUser());
  assert.equal(h.client.state().account.provider, 'telegram');
  assert.equal(h.$('authModal').open, false);
  assert.equal(h.visible('spawnCard'), true);
});
