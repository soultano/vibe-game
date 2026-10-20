import { CLAN_HALL_CENTER_COORDS, CLAN_HALL_CELLS, isClanHallCell } from '../shared/clan-hall.js';

/**
 * Draws the 40 fortress hexes of the European Grand Clan Hall.
 */
export function drawClanHallHexes(ctx, { cellPath, cellVisible }) {
  ctx.save();
  for (const cell of CLAN_HALL_CELLS) {
    if (cellVisible && !cellVisible(cell)) continue;
    cellPath(cell);

    // Deep obsidian/slate fortified stone fill with royal gold glow
    ctx.fillStyle = 'rgba(24, 20, 38, 0.78)';
    ctx.fill();

    ctx.strokeStyle = '#f59e0bcc';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws the Grand Castle building and landmark banner in Central Europe.
 */
export { drawClanHallCastle } from './clan-hall-castle.js';

/**
 * Checks if a pixel point hits the Clan Hall on the overview map.
 */
export function hitClanHall(project, x, y, cw, ch) {
  const p = project(CLAN_HALL_CENTER_COORDS.lat, CLAN_HALL_CENTER_COORDS.lng);
  if (p.x < 0 || p.x > cw || p.y < 0 || p.y > ch) return false;
  return Math.hypot(x - p.x, y - p.y) <= 45;
}
