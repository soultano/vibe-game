const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 20 * 60 * 1000;
const OAUTH_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
let googleKeyCache = { keys: [], expiresAt: 0 };

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(401, 'Некорректная подпись входа');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { fail(401, 'Некорректная подпись входа'); }
}
async function digest(value) { return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function oauthEncryptionKey(env) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`pixel-dominion:oauth-state:${env.GOOGLE_CLIENT_SECRET}`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealVerifier(verifier, env, stateKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(stateKey) }, await oauthEncryptionKey(env), encoder.encode(verifier));
  return { iv: base64url(iv), ciphertext: base64url(ciphertext) };
}
async function openVerifier(envelope, env, stateKey) {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(envelope.iv), additionalData: encoder.encode(stateKey) }, await oauthEncryptionKey(env), decode64(envelope.ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch { fail(401, 'Состояние Google-входа повреждено'); }
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function cookies(req) {
  const parsed = Object.create(null);
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) parsed[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return parsed;
}
export function isLocalDevelopment(req, env) {
  return (env.LOCAL_DEV === true || env.LOCAL_DEV === 'true') && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname);
}
function appOrigin(req, env) {
  if (isLocalDevelopment(req, env) && !env.APP_ORIGIN) return new URL(req.url).origin;
  try {
    const configured = new URL(env.APP_ORIGIN);
    if (configured.protocol !== 'https:' && !isLocalDevelopment(req, env)) fail(503, 'Для авторизации нужен HTTPS');
    if (configured.origin !== new URL(req.url).origin) fail(403, 'Неверный адрес приложения');
    return configured.origin;
  } catch (error) {
    if (error.status) throw error;
    fail(503, 'Авторизация ещё не настроена: нужен APP_ORIGIN');
  }
}
function cookie(req, env, name, value, seconds) {
  const secure = !isLocalDevelopment(req, env) || new URL(req.url).protocol === 'https:';
  return `${cookieName(req, env, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
function cookieName(req, env, name) { return isLocalDevelopment(req, env) && new URL(req.url).protocol === 'http:' ? name : `__Host-${name}`; }
function checkOrigin(req, env) {
  const origin = req.headers.get('origin');
  if (!origin || origin !== appOrigin(req, env)) fail(403, 'Запрос отклонён: неверный Origin');
  if (req.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Межсайтовый запрос отклонён');
}
async function readBody(req) {
  const type = req.headers.get('content-type') || '';
  if (!type.startsWith('application/json')) fail(415, 'Ожидается JSON');
  if (Number(req.headers.get('content-length')) > 16384) fail(413, 'Слишком большой запрос');
  const reader = req.body?.getReader();
  if (!reader) fail(400, 'Пустой запрос');
  const parts = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16384) { await reader.cancel(); fail(413, 'Слишком большой запрос'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'Ожидается объект');
    return value;
  } catch (error) { if (error.status) throw error; fail(400, 'Некорректный JSON'); }
}
function publicAccount(account) {
  return { id: account.id, name: account.name, provider: account.provider, createdAt: account.createdAt };
}
function displayName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || fallback;
}
async function fingerprintHash(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) fail(400, 'Нужен идентификатор устройства (8–256 символов)');
  return digest(value);
}
async function sessionRecord(req, env, store) {
  const token = cookies(req)[cookieName(req, env, 'pd_session')];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const key = `session:${await digest(token)}`;
  const record = await store.get(key);
  if (!record || record.value.expiresAt <= Date.now()) return null;
  return { key, ...record };
}

export async function getAuthContext(req, env, store) {
  const session = await sessionRecord(req, env, store);
  if (!session) return null;
  const account = await store.get(`account:${session.value.accountId}`);
  if (!account) return null;
  if (account.value.provider === 'development' && !isLocalDevelopment(req, env)) return null;
  return { account: account.value, csrfToken: session.value.csrfToken };
}

export async function requireAuth(req, env, store, { write = false } = {}) {
  const context = await getAuthContext(req, env, store);
  if (!context) fail(401, 'Сначала войдите через Google или Telegram');
  if (write) {
    checkOrigin(req, env);
    if (!equal(req.headers.get('x-csrf-token'), context.csrfToken)) fail(403, 'Неверный CSRF-токен');
  }
  return context;
}

async function preloginCsrf(req, env, store) {
  checkOrigin(req, env);
  const current = await getAuthContext(req, env, store);
  if (current && equal(req.headers.get('x-csrf-token'), current.csrfToken)) return;
  const token = cookies(req)[cookieName(req, env, 'pd_login')];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(403, 'Откройте страницу входа заново');
  const challenge = await store.get(`login:${await digest(token)}`);
  if (!challenge || challenge.value.expiresAt <= Date.now() || !equal(req.headers.get('x-csrf-token'), challenge.value.csrfToken)) fail(403, 'Неверный CSRF-токен входа');
}

async function throttle(req, env, store) {
  // CF supplies this header on Workers; a direct local request shares the loopback bucket.
  const ip = isLocalDevelopment(req, env) ? 'loopback' : (req.headers.get('cf-connecting-ip') || 'unknown');
  const bucket = Math.floor(Date.now() / 60000);
  const key = `auth-rate:${bucket}:${await digest(ip)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.get(key);
    if ((previous?.value.count || 0) >= 20) fail(429, 'Слишком много попыток входа. Подождите минуту');
    if (await store.atomic({ checks: [{ key, version: previous?.version ?? null }], puts: [{ key, value: { count: (previous?.value.count || 0) + 1, expiresAt: (bucket + 2) * 60000 } }] })) return;
  }
  fail(429, 'Повторите вход через минуту');
}

async function accountFor(store, provider, subject, name, fingerprint, additional = {}) {
  const identityKey = `identity:${provider}:${subject}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const identity = await store.get(identityKey);
    if (identity) {
      const accountKey = `account:${identity.value.accountId}`;
      const existing = await store.get(accountKey);
      if (!existing) fail(500, 'Аккаунт недоступен');
      const account = { ...existing.value, name: displayName(name, existing.value.name), fingerprintHash: fingerprint };
      if (await store.atomic({ checks: [{ key: accountKey, version: existing.version }], puts: [{ key: accountKey, value: account }] })) return account;
      continue;
    }
    const id = randomToken(18);
    const account = { id, name: displayName(name, 'Игрок'), provider, createdAt: Date.now(), fingerprintHash: fingerprint, ...additional };
    if (await store.atomic({ checks: [{ key: identityKey, version: null }, { key: `account:${id}`, version: null }], puts: [{ key: identityKey, value: { accountId: id } }, { key: `account:${id}`, value: account }] })) return account;
  }
  fail(409, 'Повторите вход');
}

async function signIn(req, env, store, account, redirect = false) {
  const token = randomToken();
  const csrfToken = randomToken();
  const key = `session:${await digest(token)}`;
  const now = Date.now();
  if (!await store.atomic({ checks: [{ key, version: null }], puts: [{ key, value: { accountId: account.id, csrfToken, createdAt: now, expiresAt: now + SESSION_MS } }] })) fail(503, 'Повторите вход');
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(req, env, 'pd_session', token, SESSION_MS / 1000));
  headers.append('set-cookie', cookie(req, env, 'pd_login', '', 0));
  headers.append('set-cookie', cookie(req, env, 'pd_oauth', '', 0));
  if (redirect) { headers.set('location', '/'); return new Response(null, { status: 303, headers }); }
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ account: publicAccount(account), csrfToken }), { headers });
}

function googleEnabled(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.APP_ORIGIN); }
function telegramEnabled(env) { return !!(env.TELEGRAM_BOT_TOKEN && /^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME || '') && env.APP_ORIGIN); }

async function googleStart(req, env, store) {
  if (!googleEnabled(env)) fail(503, 'Вход через Google пока не настроен');
  const origin = appOrigin(req, env);
  const redirect = new URL(env.GOOGLE_REDIRECT_URI);
  if (redirect.origin !== origin || redirect.pathname !== '/api/auth/google/callback') fail(503, 'Неверный Google redirect URI');
  await throttle(req, env, store);
  const state = randomToken();
  const browser = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  const fingerprint = await fingerprintHash(new URL(req.url).searchParams.get('fingerprint'));
  const key = `oauth:${await digest(state)}`;
  await store.atomic({ checks: [{ key, version: null }], puts: [{ key, value: { browserHash: await digest(browser), verifier: await sealVerifier(verifier, env, key), nonce, fingerprintHash: fingerprint, expiresAt: Date.now() + OAUTH_MS } }] });
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: 'code', scope: 'openid profile', state, nonce, code_challenge: await digest(verifier), code_challenge_method: 'S256', prompt: 'select_account' });
  return new Response(null, { status: 303, headers: { location: target.href, 'cache-control': 'no-store', 'set-cookie': cookie(req, env, 'pd_oauth', browser, OAUTH_MS / 1000) } });
}

async function googleJwk(kid, env) {
  if (googleKeyCache.expiresAt > Date.now()) {
    const found = googleKeyCache.keys.find(key => key.kid === kid);
    if (found) return found;
  }
  const fetcher = typeof env.AUTH_FETCH === 'function' ? env.AUTH_FETCH : fetch;
  const response = await fetcher(GOOGLE_KEYS, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail(503, 'Сервис проверки Google временно недоступен');
  const document = await response.json();
  if (!Array.isArray(document.keys)) fail(503, 'Google вернул некорректные ключи');
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 3600);
  googleKeyCache = { keys: document.keys, expiresAt: Date.now() + Math.min(maxAge, 21600) * 1000 };
  const key = document.keys.find(item => item.kid === kid && item.kty === 'RSA' && (!item.alg || item.alg === 'RS256') && (!item.use || item.use === 'sig'));
  if (!key) fail(401, 'Неизвестный ключ Google');
  return key;
}

async function verifyGoogleJwt(token, env, nonce) {
  if (typeof token !== 'string' || token.length > 16384) fail(401, 'Google не вернул токен входа');
  const parts = token.split('.');
  if (parts.length !== 3) fail(401, 'Некорректный токен Google');
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
  } catch { fail(401, 'Некорректный токен Google'); }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims) || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || header.crit) fail(401, 'Неверный алгоритм подписи Google');
  const jwk = await googleJwk(header.kid, env);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  const now = Date.now() / 1000;
  const audience = claims.aud === env.GOOGLE_CLIENT_ID || (Array.isArray(claims.aud) && claims.aud.includes(env.GOOGLE_CLIENT_ID) && claims.azp === env.GOOGLE_CLIENT_ID);
  if (!verified || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !audience || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60 || !equal(claims.nonce, nonce) || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) fail(401, 'Токен Google не прошёл проверку');
  return claims;
}

async function googleCallback(req, env, store) {
  if (!googleEnabled(env)) fail(503, 'Вход через Google пока не настроен');
  appOrigin(req, env);
  const url = new URL(req.url);
  const state = url.searchParams.get('state');
  const browser = cookies(req)[cookieName(req, env, 'pd_oauth')];
  if (!state || !browser || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) fail(401, 'Состояние Google-входа потеряно');
  const key = `oauth:${await digest(state)}`;
  const stored = await store.get(key);
  if (!stored || stored.value.expiresAt <= Date.now() || !equal(stored.value.browserHash, await digest(browser))) fail(401, 'Вход устарел или был изменён');
  // Consume before any network request. A replay cannot exchange the same code.
  if (!await store.atomic({ checks: [{ key, version: stored.version }], deletes: [key] })) fail(401, 'Этот вход уже использован');
  if (url.searchParams.has('error')) fail(401, 'Вход через Google отменён');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) fail(401, 'Нет кода Google-входа');
  const fetcher = typeof env.AUTH_FETCH === 'function' ? env.AUTH_FETCH : fetch;
  const verifier = await openVerifier(stored.value.verifier, env, key);
  const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code', code_verifier: verifier }), signal: AbortSignal.timeout(10000) });
  if (!tokenResponse.ok) fail(401, 'Google отклонил код входа');
  const token = await tokenResponse.json();
  const claims = await verifyGoogleJwt(token.id_token, env, stored.value.nonce);
  const account = await accountFor(store, 'google', claims.sub, claims.name, stored.value.fingerprintHash);
  return signIn(req, env, store, account, true);
}

async function telegramLogin(req, env, store, body) {
  if (!telegramEnabled(env)) fail(503, 'Вход через Telegram пока не настроен');
  const raw = body.telegram ?? body.auth ?? body;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Нет данных Telegram');
  const fields = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];
  const data = Object.create(null);
  for (const field of fields) if (raw[field] !== undefined) {
    if (!['string', 'number'].includes(typeof raw[field]) || String(raw[field]).length > 1024) fail(400, 'Некорректные данные Telegram');
    data[field] = String(raw[field]);
  }
  if (!/^[1-9]\d{0,15}$/.test(data.id || '') || !Number.isSafeInteger(Number(data.id)) || !/^\d{10}$/.test(data.auth_date || '') || typeof raw.hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.hash)) fail(401, 'Некорректные данные Telegram');
  const age = Date.now() / 1000 - Number(data.auth_date);
  if (age < 0 || age > 300) fail(401, 'Telegram-вход устарел');
  const check = Object.keys(data).sort().map(key => `${key}=${data[key]}`).join('\n');
  const secret = await crypto.subtle.digest('SHA-256', encoder.encode(env.TELEGRAM_BOT_TOKEN));
  const hmac = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(check)));
  const expected = [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (!equal(expected, raw.hash.toLowerCase())) fail(401, 'Подпись Telegram не прошла проверку');
  const replayKey = `telegram-used:${await digest(raw.hash.toLowerCase())}`;
  const fingerprint = await fingerprintHash(body.fingerprint);
  if (!await store.atomic({ checks: [{ key: replayKey, version: null }], puts: [{ key: replayKey, value: { expiresAt: Date.now() + 360000 } }] })) fail(401, 'Этот Telegram-вход уже использован');
  const account = await accountFor(store, 'telegram', data.id, [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username, fingerprint);
  return signIn(req, env, store, account);
}

export async function handleAuth(req, env, store) {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    if (req.method === 'GET' && path === '/api/auth/providers') return json({ google: { enabled: googleEnabled(env), url: '/api/auth/google/start' }, telegram: { enabled: telegramEnabled(env), botUsername: telegramEnabled(env) ? env.TELEGRAM_BOT_USERNAME : null }, development: isLocalDevelopment(req, env) });
    if (req.method === 'GET' && path === '/api/auth/me') {
      const current = await getAuthContext(req, env, store);
      if (current) return json({ account: publicAccount(current.account), csrfToken: current.csrfToken });
      const token = randomToken();
      const csrfToken = randomToken();
      await store.atomic({ puts: [{ key: `login:${await digest(token)}`, value: { csrfToken, expiresAt: Date.now() + CHALLENGE_MS } }] });
      return json({ account: null, csrfToken }, 200, { 'set-cookie': cookie(req, env, 'pd_login', token, CHALLENGE_MS / 1000) });
    }
    if (req.method === 'GET' && path === '/api/auth/google/start') return await googleStart(req, env, store);
    if (req.method === 'GET' && path === '/api/auth/google/callback') return await googleCallback(req, env, store);
    if (req.method !== 'POST') return json({ error: 'Маршрут авторизации не найден' }, 404);
    if (path === '/api/auth/logout') {
      await requireAuth(req, env, store, { write: true });
      const session = await sessionRecord(req, env, store);
      if (session) await store.atomic({ checks: [{ key: session.key, version: session.version }], deletes: [session.key] });
      return json({ ok: true }, 200, { 'set-cookie': cookie(req, env, 'pd_session', '', 0) });
    }
    if (!['/api/auth/dev', '/api/auth/telegram'].includes(path)) return json({ error: 'Маршрут авторизации не найден' }, 404);
    if (path === '/api/auth/dev' && !isLocalDevelopment(req, env)) return json({ error: 'Локальный тестовый вход отключён' }, 404);
    await preloginCsrf(req, env, store);
    await throttle(req, env, store);
    const body = await readBody(req);
    if (path === '/api/auth/telegram') return await telegramLogin(req, env, store, body);
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 64) fail(400, 'Имя: от 2 до 64 символов');
    const fingerprint = await fingerprintHash(body.fingerprint);
    const account = await accountFor(store, 'development', fingerprint, `${body.name.trim()} [DEV]`, fingerprint);
    return await signIn(req, env, store, account);
  } catch (error) {
    return json({ error: error.status ? error.message : 'Ошибка авторизации. Повторите вход' }, error.status || 500);
  }
}
