// Administrative helper: secrets arrive through non-echoing stdin, never argv.
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readInput() {
  process.stdin.setEncoding('utf8');
  const tty = process.stdin.isTTY;
  if (tty) process.stdin.setRawMode(true);
  process.stdout.write('Ready for private configuration input\n');
  return new Promise((resolveInput, reject) => {
    let input = '';
    const cleanup = () => { process.stdin.off('data', onData); if (tty) process.stdin.setRawMode(false); process.stdin.pause(); };
    function onData(chunk) {
      input += chunk;
      if (input.length > 12000) { cleanup(); reject(new Error('Input too large')); return; }
      if (input.includes('\n') || input.includes('\r')) {
        cleanup();
        try { resolveInput(JSON.parse(input.trim())); } catch { reject(new Error('Invalid input')); }
      }
    }
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

try {
  const input = await readInput();
  if (typeof input.token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(input.token)) throw new Error('Invalid token format');
  async function api(method, body) {
    let response;
    try { response = await fetch(`https://api.telegram.org/bot${input.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`Telegram ${method}: network failure`); }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: rejected (${response.status})`);
    return data.result;
  }
  const bot = await api('getMe');
  if (!bot.is_bot || !bot.username) throw new Error('Not a bot account');
  if (input.saveLocal) {
    const path = resolve(import.meta.dirname, '../.env.local');
    let existing = '';
    try { existing = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const updates = { TELEGRAM_BOT_TOKEN: input.token, TELEGRAM_BOT_USERNAME: bot.username, GOOGLE_AUTH_ENABLED: 'false' };
    let lines = existing.split(/\r?\n/).filter(line => !Object.keys(updates).some(key => line.startsWith(`${key}=`)));
    while (lines.length && !lines.at(-1)) lines.pop();
    lines.push(...Object.entries(updates).map(([key, value]) => `${key}=${JSON.stringify(value)}`));
    await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  let menuConfigured = false;
  if (input.menuUrl) {
    const url = new URL(input.menuUrl);
    if (url.protocol !== 'https:') throw new Error('Menu URL must use HTTPS');
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: url.href } } });
    const menu = await api('getChatMenuButton');
    menuConfigured = menu.type === 'web_app' && menu.web_app?.url === url.href;
    if (!menuConfigured) throw new Error('Menu verification failed');
  }
  console.log(JSON.stringify({ id: bot.id, username: bot.username, name: bot.first_name, localSaved: !!input.saveLocal, menuConfigured }));
} catch (error) {
  // Never print fetch exceptions or request URLs: they can contain credentials.
  console.error(error.message.startsWith('Telegram ') || ['Invalid token format', 'Not a bot account', 'Menu URL must use HTTPS', 'Menu verification failed', 'Invalid input', 'Input too large'].includes(error.message) ? error.message : 'Telegram configuration failed');
  process.exitCode = 1;
}
