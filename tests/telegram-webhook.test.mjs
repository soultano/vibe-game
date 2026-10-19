import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramWebhook } from '../src/server/telegram-webhook.js';

test('Telegram webhook rejects non-POST requests with 405', async () => {
  const req = new Request('https://vibe-game-ten.vercel.app/api/telegram/webhook', { method: 'GET' });
  const res = await handleTelegramWebhook(req, { TELEGRAM_BOT_TOKEN: '123:abc' });
  assert.equal(res.status, 405);
});

test('Telegram webhook returns 503 if bot token is not configured', async () => {
  const req = new Request('https://vibe-game-ten.vercel.app/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const res = await handleTelegramWebhook(req, {});
  assert.equal(res.status, 503);
});

test('Telegram webhook handles /start and sends welcome with mini app button', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const env = {
    TELEGRAM_BOT_TOKEN: 'test-token-123',
    APP_ORIGIN: 'https://vibe-game-ten.vercel.app',
    AUTH_FETCH: fakeFetch,
  };

  const update = {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 9373716, first_name: 'TestUser' },
      text: '/start',
    },
  };

  const req = new Request('https://vibe-game-ten.vercel.app/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });

  const res = await handleTelegramWebhook(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  assert.equal(calls.length, 2);
  const sendMsg = calls.find(c => c.url.includes('/sendMessage'));
  assert.ok(sendMsg);
  assert.equal(sendMsg.body.chat_id, 9373716);
  assert.ok(sendMsg.body.text.includes('Pixel Dominion'));
  assert.equal(sendMsg.body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://vibe-game-ten.vercel.app/');

  const setBtn = calls.find(c => c.url.includes('/setChatMenuButton'));
  assert.ok(setBtn);
  assert.equal(setBtn.body.chat_id, 9373716);
  assert.equal(setBtn.body.menu_button.web_app.url, 'https://vibe-game-ten.vercel.app/');
});

test('Telegram webhook ignores updates without chat id gracefully', async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: 'test-token-123',
    APP_ORIGIN: 'https://vibe-game-ten.vercel.app',
  };

  const req = new Request('https://vibe-game-ten.vercel.app/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 99 }),
  });

  const res = await handleTelegramWebhook(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});
