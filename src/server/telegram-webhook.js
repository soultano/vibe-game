import { json, readJSON } from './http.js';

export async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Метод не поддерживается.' }, 405);
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return json({ ok: false, error: 'Telegram bot token not configured' }, 503);
  }

  let update;
  try {
    update = await readJSON(request);
  } catch {
    return json({ ok: false, error: 'Некорректный JSON' }, 400);
  }

  const message = update?.message;
  const chatId = message?.chat?.id;

  if (chatId) {
    const appUrl = (env.APP_ORIGIN || 'https://vibe-game-ten.vercel.app').replace(/\/+$/, '') + '/';
    const welcomeText =
      '🎮 <b>Pixel Dominion</b> — пиксельная геостратегия на реальной карте мира!\n\n' +
      '🌍 Захватывайте реальные города и территории\n' +
      '🏛 Стройте базы и развивайте инфраструктуру\n' +
      '⚔️ Сражайтесь с другими игроками в реальном времени\n\n' +
      'Нажмите кнопку <b>«Играть»</b> ниже, чтобы запустить игру:';

    const fetcher = typeof env.AUTH_FETCH === 'function' ? env.AUTH_FETCH : fetch;

    try {
      await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎮 Играть в Pixel Dominion',
                  web_app: { url: appUrl },
                },
              ],
            ],
          },
        }),
      });

      await fetcher(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          menu_button: {
            type: 'web_app',
            text: 'Играть',
            web_app: { url: appUrl },
          },
        }),
      });
    } catch (e) {
      console.error('telegram_webhook_dispatch_error', e?.message || e);
    }
  }

  return json({ ok: true });
}
