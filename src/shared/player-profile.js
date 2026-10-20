export function promotionUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function playerProfile(player) {
  return {
    id: player.id, name: player.name || 'Командир', faction: player.faction || 'protocol',
    level: player.level || 1, pixels: Math.floor(player.pixels || 0), baseCell: player.baseCell,
    color: player.color || null, battlesFought: player.battlesFought || 0,
    battlesWon: player.battlesWon || 0, unitsDefeated: player.unitsDefeated || 0,
    customLink: promotionUrl(player.customLink), customLinkTitle: player.customLinkTitle || null,
  };
}
