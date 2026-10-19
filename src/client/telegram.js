// Capture launch data before any network work or the optional Telegram SDK.
export function readTelegramInitData(location, webApp) {
  if (typeof webApp?.initData === 'string' && webApp.initData) return webApp.initData;
  for (const value of [location.hash?.slice(1), location.search?.slice(1)]) {
    const data = new URLSearchParams(value || '').get('tgWebAppData');
    if (data) return data;
  }
  return '';
}

export function removeTelegramInitData(location, history) {
  const hash = new URLSearchParams(location.hash?.slice(1) || '');
  const query = new URLSearchParams(location.search?.slice(1) || '');
  if (!hash.has('tgWebAppData') && !query.has('tgWebAppData')) return;
  hash.delete('tgWebAppData');
  query.delete('tgWebAppData');
  history.replaceState(history.state, '', location.pathname + (query.size ? '?' + query : '') + (hash.size ? '#' + hash : ''));
}

export function telegramLink(username, launchApp = true) {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username || '')) return null;
  return `https://t.me/${username}${launchApp ? '?startapp=play' : ''}`;
}
