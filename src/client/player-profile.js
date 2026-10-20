import { promotionUrl } from '../shared/player-profile.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('ru-RU');

export function profileStats(player) {
  return `<dl class="public-player-stats"><div><dt>Уровень штаба</dt><dd>${count(player.level)}</dd></div><div><dt>Захвачено ячеек</dt><dd>${count(player.pixels)}</dd></div><div><dt>Боевых столкновений</dt><dd>${count(player.battlesFought)}</dd></div><div><dt>Отрядов побеждено</dt><dd>${count(player.unitsDefeated)}</dd></div><div><dt>Вражеских гексов занято</dt><dd>${count(player.battlesWon)}</dd></div></dl>`;
}

export function promotionLink(player) {
  const url = promotionUrl(player.customLink);
  return url ? `<a class="tooltip-social-link promotion-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer ugc"><small>Ресурс игрока</small><span>${escape(player.customLinkTitle || new URL(url).hostname)} ↗</span></a>` : '';
}

export function profileTooltip(player) {
  return `<b>${escape(player.name)}</b>${profileStats(player)}${promotionLink(player)}`;
}
