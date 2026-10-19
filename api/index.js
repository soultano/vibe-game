import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/router.js';
import { createLocalStore } from '../src/server/local-store.js';
import { createNeonStore } from '../src/server/neon-store.js';

let appPromise = null;

async function getApp() {
  if (!appPromise) appPromise = (async () => {
    const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!dbUrl && process.env.VERCEL) throw Object.assign(new Error('Persistent database required'), { code: 'STORAGE_UNAVAILABLE', status: 503 });
    const store = dbUrl
      ? await createNeonStore(dbUrl)
      : await createLocalStore(process.env.DATABASE_PATH || join(tmpdir(), 'vibe-game-world.sqlite'));

    return createApp({
      store,
      env: {
        ...process.env,
        LOCAL_DEV: false,
        APP_ORIGIN: process.env.APP_ORIGIN || '',
      },
      serveAsset: async () => new Response('Not found', { status: 404 }),
    });
  })().catch(error => { appPromise = null; throw error; });
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    if (typeof req.arrayBuffer === 'function' || req instanceof Request) return app.fetch(req);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 140000) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) && chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await app.fetch(request);
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie'));
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(body);
  } catch (err) {
    // Database/provider errors may contain connection strings. Log codes only.
    console.error('serverless_error', err.code || err.name || 'Error');
    const status = err.status === 503 ? 503 : 500;
    const body = { error: status === 503 ? 'Хранилище мира не подключено. Попробуйте позже.' : 'Сервер временно недоступен. Попробуйте ещё раз.', code: err.code === 'STORAGE_UNAVAILABLE' ? err.code : 'SERVER_UNAVAILABLE' };
    if (!res) return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
}
