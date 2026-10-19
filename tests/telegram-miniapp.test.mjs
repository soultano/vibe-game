import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { verifyTelegramMiniAppData, handleAuth, getAuthContext } from '../src/server/auth.js';
import { MemoryStore } from '../src/server/store.js';

// Synthetic test credentials only. This fixed HMAC vector was generated with
// Python's hmac/hashlib independently of the implementation's WebCrypto code.
const token = '123456789:unit-test-miniapp-secret';
const fixture = 'auth_date=1700000000&query_id=fixture_nonce_01&signature=fixed_ed25519_placeholder_signed_by_hmac&user=%7B%22id%22%3A88776655%2C%22first_name%22%3A%22Fixture%22%2C%22last_name%22%3A%22Operator%22%2C%22username%22%3A%22fixture_user%22%7D&future_field=signed-extra&hash=c3935fc3a06abf36fe9bf404448b8f0ebb391417623beeed72d259dc6a46e684';
const origin = 'https://world.example';
const env = { APP_ORIGIN: origin, TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: 'DominionTestBot', GOOGLE_AUTH_ENABLED: 'false' };

function sign(fields = {}) {
  const entries = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'test_' + crypto.randomUUID(), user: JSON.stringify({ id: 88776655, first_name: 'Mini', last_name: 'Operator' }), ...fields };
  const check = Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...entries, hash }).toString();
}
function req(path, { method = 'GET', body, csrf, cookie, requestOrigin = origin } = {}) {
  return new Request(`${origin}${path}`, { method, headers: {
    ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin: requestOrigin } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(cookie ? { cookie } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function cookie(response, name) { return response.headers.getSetCookie().find(value => value.startsWith(`__Host-${name}=`))?.split(';')[0]; }
async function challenge(store) {
  const response = await handleAuth(req('/api/auth/me'), env, store);
  const body = await response.json();
  return { csrf: body.csrfToken, cookie: cookie(response, 'pd_login') };
}
async function attempt(store, initData, options = {}) {
  const auth = await challenge(store);
  return handleAuth(req('/api/auth/telegram/miniapp', { method: 'POST', body: { initData, fingerprint: 'miniapp-test-device-123' }, ...auth, ...options }), env, store);
}

test('Mini App accepts an independently computed fixed HMAC vector including signature and extra signed fields', async () => {
  const verified = await verifyTelegramMiniAppData(fixture, token, 1700000001000);
  assert.equal(verified.user.id, 88776655); assert.equal(verified.queryId, 'fixture_nonce_01');
  assert.equal(verified.hash, 'c3935fc3a06abf36fe9bf404448b8f0ebb391417623beeed72d259dc6a46e684');
});

test('Mini App rejects forged signatures, changed nonce, changed signature field and unsigned extra fields', async () => {
  for (const tampered of [fixture.replace('Fixture', 'Attacker'), fixture.replace('fixture_nonce_01', 'fixture_nonce_02'), fixture.replace('fixed_ed25519_placeholder_signed_by_hmac', 'altered_signature'), fixture + '&untrusted_extra=1']) {
    await assert.rejects(() => verifyTelegramMiniAppData(tampered, token, 1700000001000), error => error.status === 401);
  }
  await assert.rejects(() => verifyTelegramMiniAppData(fixture, 'wrong-bot-secret', 1700000001000), error => error.status === 401);
  await assert.rejects(() => verifyTelegramMiniAppData(fixture + '&auth_date=1700000000', token, 1700000001000), error => error.status === 401);
  const validExtra = await verifyTelegramMiniAppData(sign({ future_field: 'new-version-value', signature: 'signed-by-the-bot-hmac' }), token);
  assert.equal(validExtra.user.id, 88776655);
});

test('Mini App enforces five-minute lifetime, future rejection and safe integer user identity', async () => {
  for (const seconds of [-301, 10]) await assert.rejects(() => verifyTelegramMiniAppData(sign({ auth_date: String(Math.floor(Date.now() / 1000) + seconds) }), token), error => error.status === 401);
  for (const user of ['invalid-json', JSON.stringify({ id: 1.5 }), JSON.stringify({ id: '1234' }), JSON.stringify({ id: 0 }), JSON.stringify({ id: 2 ** 53 }), JSON.stringify({ id: 1234, is_bot: true })]) {
    await assert.rejects(() => verifyTelegramMiniAppData(sign({ user }), token), error => error.status === 401);
  }
});

test('Mini App HTTP login requires challenge+CSRF+Origin, creates secure session and consumes initData once', async () => {
  const store = new MemoryStore(), initData = sign();
  assert.equal((await attempt(store, initData, { csrf: 'forged' })).status, 403);
  assert.equal((await attempt(store, initData, { requestOrigin: 'https://attacker.example' })).status, 403);
  const response = await attempt(store, initData);
  assert.equal(response.status, 200, await response.clone().text());
  const signed = await response.json(); assert.equal(signed.account.provider, 'telegram');
  assert.match(cookie(response, 'pd_session'), /^__Host-pd_session=/);
  const context = await getAuthContext(req('/api/auth/me', { cookie: cookie(response, 'pd_session') }), env, store);
  assert.equal(context.account.id, signed.account.id); assert.equal(context.csrfToken, signed.csrfToken);
  assert.equal((await attempt(store, initData)).status, 401);
  assert.equal((await store.list('account:')).length, 1);
  assert.ok(!JSON.stringify(await store.list('telegram-miniapp-used:')).includes(initData));
});

test('Mini App and legacy Telegram widget use the same provider identity and base account', async () => {
  const store = new MemoryStore();
  const first = await attempt(store, sign()); assert.equal(first.status, 200);
  const accountId = (await first.json()).account.id;
  const payload = { id: 88776655, first_name: 'Widget', auth_date: Math.floor(Date.now() / 1000) };
  const check = Object.keys(payload).sort().map(key => `${key}=${payload[key]}`).join('\n');
  payload.hash = createHmac('sha256', createHash('sha256').update(token).digest()).update(check).digest('hex');
  const auth = await challenge(store);
  const widget = await handleAuth(req('/api/auth/telegram', { method: 'POST', body: { telegram: payload, fingerprint: 'miniapp-test-device-123' }, ...auth }), env, store);
  assert.equal(widget.status, 200); assert.equal((await widget.json()).account.id, accountId);
  assert.equal((await store.list('account:')).length, 1);
});

test('Google explicit disabled flag hides the provider and blocks OAuth routes even with credentials', async () => {
  const settings = { ...env, GOOGLE_CLIENT_ID: 'client.google', GOOGLE_CLIENT_SECRET: 'synthetic-test-secret', GOOGLE_REDIRECT_URI: `${origin}/api/auth/google/callback` };
  const store = new MemoryStore();
  const providers = await handleAuth(req('/api/auth/providers'), settings, store);
  assert.equal((await providers.json()).google.enabled, false);
  assert.equal((await handleAuth(req('/api/auth/google/start?fingerprint=google-device-123'), settings, store)).status, 503);
  assert.equal((await handleAuth(req('/api/auth/google/callback?code=x&state=x'), settings, store)).status, 503);
  assert.equal((await store.list('oauth:')).length, 0);
});

test('Mini App accepts an in-memory challenge and bearer session when iframe cookies are blocked', async () => {
  const store = new MemoryStore();
  const anonymous = await handleAuth(req('/api/auth/me'), env, store);
  const challenge = await anonymous.json();
  const response = await handleAuth(new Request(origin + '/api/auth/telegram/miniapp', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken, 'x-login-token': challenge.loginToken },
    body: JSON.stringify({ initData: sign(), fingerprint: 'cookie-blocked-device' }),
  }), env, store);
  assert.equal(response.status, 200, await response.clone().text());
  const signed = await response.json();
  assert.match(signed.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  const authRequest = new Request(origin + '/api/auth/me', { headers: { authorization: 'Bearer ' + signed.sessionToken } });
  const context = await getAuthContext(authRequest, env, store);
  assert.equal(context.account.id, signed.account.id);
  assert.equal(context.csrfToken, signed.csrfToken);
  const logout = await handleAuth(new Request(origin + '/api/auth/logout', { method: 'POST', headers: { origin, authorization: 'Bearer ' + signed.sessionToken, 'x-csrf-token': signed.csrfToken } }), env, store);
  assert.equal(logout.status, 200);
  assert.equal(await getAuthContext(authRequest, env, store), null);
});

test('Telegram Mini App inside Telegram Web iframe with sec-fetch-site: cross-site is accepted', async () => {
  const store = new MemoryStore();
  const anonymous = await handleAuth(req('/api/auth/me'), env, store);
  const challenge = await anonymous.json();
  const response = await handleAuth(new Request(origin + '/api/auth/telegram/miniapp', {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
      'x-csrf-token': challenge.csrfToken,
      'x-login-token': challenge.loginToken,
    },
    body: JSON.stringify({ initData: sign(), fingerprint: 'iframe-web-telegram-device' }),
  }), env, store);
  assert.equal(response.status, 200);
  const signed = await response.json();
  assert.equal(signed.account.provider, 'telegram');
});

test('header login challenge cannot bypass Origin or CSRF checks', async () => {
  const store = new MemoryStore();
  const challenge = await (await handleAuth(req('/api/auth/me'), env, store)).json();
  for (const headers of [
    { origin: 'https://attacker.example', 'x-csrf-token': challenge.csrfToken, 'x-login-token': challenge.loginToken },
    { origin, 'x-login-token': challenge.loginToken },
    { origin, 'x-csrf-token': challenge.csrfToken, 'x-login-token': 'forged' },
  ]) {
    const result = await handleAuth(new Request(origin + '/api/auth/telegram/miniapp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ initData: sign(), fingerprint: 'header-guarded-device' }) }), env, store);
    assert.equal(result.status, 403);
  }
  assert.equal((await store.list('session:')).length, 0);
});

test('Telegram configuration trims copied whitespace and a leading @ in bot username', async () => {
  const configured = { ...env, TELEGRAM_BOT_TOKEN: ' ' + token + '\n', TELEGRAM_BOT_USERNAME: ' @DominionTestBot\n' };
  const providers = await (await handleAuth(req('/api/auth/providers'), configured, new MemoryStore())).json();
  assert.equal(providers.telegram.enabled, true);
  assert.equal(providers.telegram.botUsername, 'DominionTestBot');
});

test('failed session persistence does not consume the Telegram proof before a successful retry', async () => {
  class FaultStore extends MemoryStore {
    failNextSession = true;
    async atomic(input) {
      if (this.failNextSession && input.puts?.some(row => row.key.startsWith('session:'))) {
        this.failNextSession = false;
        throw new Error('synthetic temporary database error');
      }
      return super.atomic(input);
    }
  }
  const store = new FaultStore(), proof = sign();
  assert.equal((await attempt(store, proof)).status, 500);
  assert.equal((await store.list('telegram-miniapp-used:')).length, 0);
  assert.equal((await attempt(store, proof)).status, 200);
  assert.equal((await store.list('telegram-miniapp-used:')).length, 1);
});

test('concurrent use of one Mini App proof creates exactly one session', async () => {
  const store = new MemoryStore(), proof = sign();
  const responses = await Promise.all([attempt(store, proof), attempt(store, proof)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  assert.equal((await store.list('session:')).length, 1);
  assert.equal((await store.list('account:')).length, 1);
});

test('Vercel login throttles separate clients independently and ignores spoofed CF headers', async () => {
  const store = new MemoryStore(), settings = { ...env, VERCEL: '1' };
  const challenge = await (await handleAuth(req('/api/auth/me'), settings, store)).json();
  async function login(ip, spoofed = '203.0.113.8') {
    return handleAuth(new Request(origin + '/api/auth/telegram/miniapp', { method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken,
      'x-login-token': challenge.loginToken, 'x-vercel-forwarded-for': ip, 'cf-connecting-ip': spoofed,
    }, body: JSON.stringify({ initData: 'intentionally-invalid-proof', fingerprint: 'rate-limit-test-device' }) }), settings, store);
  }
  for (let i = 0; i < 20; i++) assert.equal((await login('192.0.2.1')).status, 401);
  assert.equal((await login('192.0.2.1', 'forged-new-address')).status, 429);
  assert.equal((await login('192.0.2.2')).status, 401, 'a different client must not share the exhausted bucket');
});
