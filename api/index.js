import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/router.js';
import { createLocalStore } from '../src/server/local-store.js';

let appInstance = null;

async function getApp() {
  if (!appInstance) {
    const dbPath = process.env.DATABASE_PATH || join(tmpdir(), 'vibe-game-world.sqlite');
    const store = await createLocalStore(dbPath);
    appInstance = createApp({
      store,
      env: {
        ...process.env,
        LOCAL_DEV: false,
        APP_ORIGIN: process.env.APP_ORIGIN || '',
      },
      serveAsset: async () => new Response('Not found', { status: 404 }),
    });
  }
  return appInstance;
}

export default async function handler(req, res) {
  if (typeof req.arrayBuffer === 'function' || (typeof Request !== 'undefined' && req instanceof Request)) {
    const app = await getApp();
    return app.fetch(req);
  }

  try {
    const app = await getApp();
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
    console.error('Serverless error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: 'Server error' }));
  }
}
