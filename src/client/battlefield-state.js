import { troopDeployment, troopFor } from '../shared/troops.js';

const validCell = cell => typeof cell === 'string' && /^[0-9a-f]{15}$/.test(cell);
export function unitSeed(key) {
  let value = 2166136261;
  for (const letter of key) value = Math.imul(value ^ letter.charCodeAt(0), 16777619);
  return (value >>> 0) / 4294967296;
}

// Visual squads are projections of server territory/combat, never a second
// combat simulation. Only confirmed ownership deltas can create a capture.
export function createBattlefieldState({ maxUnits = 36 } = {}) {
  let players = new Map(), conflicts = [], syncedAt = 0, ownId = null;
  const captures = new Map(), seen = new Set();
  return {
    sync(snapshot, now) {
      ownId = snapshot.player?.id || null;
      players = new Map((snapshot.players || []).filter(player => player?.id && validCell(player.baseCell)).map(player => [player.id, player]));
      if (snapshot.player && validCell(snapshot.player.baseCell)) players.set(snapshot.player.id, snapshot.player);
      conflicts = (snapshot.conflicts || []).filter(conflict => conflict.status === 'active'
        && (!Number.isFinite(conflict.lastResolvedAt) || now - conflict.lastResolvedAt < 15000));
      syncedAt = now;
    },
    capture(change, now) {
      if (!validCell(change.cell) || !change.owner || !Number.isFinite(change.at) || change.at > now + 1000 || now - change.at > 15000) return false;
      if (!validCell(change.fromCell) || change.fromCell === change.cell) return false;
      const key = `${change.cell}:${change.owner}:${change.version ?? change.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > 512) seen.delete(seen.values().next().value);
      captures.set(key, { ...change, key, startedAt: now });
      if (captures.size > 16) captures.delete(captures.keys().next().value);
      return true;
    },
    units(now) {
      const result = [], fresh = now - syncedAt < 15000;
      const ordered = [...players.values()].sort((a, b) => (b.id === ownId) - (a.id === ownId) || a.id.localeCompare(b.id));
      for (const player of ordered) {
        const front = fresh ? conflicts.flatMap(conflict => conflict.fronts || []).find(edge => edge.aId === player.id || edge.bId === player.id) : null;
        const cell = front ? front.aId === player.id ? front.aCell : front.bCell : null;
        const target = front ? front.aId === player.id ? front.bCell : front.aCell : null;
        const frontier = (player.frontier || []).filter(validCell);
        const deployment = player.troops || troopDeployment(player, now);
        for (const group of deployment) {
          if (group.type !== 'infantry' && (!Number.isFinite(group.activeUntil) || group.activeUntil <= now)) continue;
          const count = Math.max(0, Math.min(group.type === 'infantry' ? 5 : 1, Number(group.count) || 0));
          for (let i = 0; i < count; i++) {
            const spec = troopFor(player.faction, group.type), key = `${player.id}:${spec.type}:${i}`;
            const anchor = validCell(cell) ? cell : frontier[i % Math.max(1, frontier.length)] || player.baseCell;
            const atBase = anchor === player.baseCell && !front;
            result.push({ ...spec, key, owner: player.id,
              cell: anchor,
              target: validCell(target) ? target : null,
              animation: fresh ? front ? 'attack' : 'walk' : 'idle', phase: unitSeed(key),
              offsetX: (i - (count - 1) / 2) * 13 + (spec.type === 'armor' ? -23 : 0),
              offsetY: spec.type === 'air' ? -27 : spec.type === 'ultimate' ? atBase ? 42 : 27 : spec.type === 'armor' ? atBase ? 32 : 20 : atBase ? 23 : 3,
              azimuth: player.azimuth || 0, ultimate: spec.type === 'ultimate' });
          }
        }
      }
      for (const [key, event] of captures) {
        const age = now - event.startedAt;
        if (age >= 4200) { captures.delete(key); continue; }
        const player = players.get(event.owner);
        if (!player) continue;
        const defender = event.previous && players.get(event.previous);
        if (defender && age >= 2300) result.unshift({ ...troopFor(defender.faction, 'infantry'), key: `defeat:${key}`, owner: defender.id,
          cell: event.cell, progress: 1, animation: 'death', phase: 0, offsetX: 8, offsetY: 0, azimuth: defender.azimuth || 0 });
        result.unshift({ ...troopFor(player.faction, 'infantry'), key: `capture:${key}`, owner: event.owner,
          cell: event.cell, fromCell: event.fromCell, progress: Math.min(1, age / 2300),
          animation: age < 2300 ? 'walk' : 'capture', phase: unitSeed(key), offsetX: 0, offsetY: 0,
          capture: age >= 2300, combat: !!event.previous, azimuth: player.azimuth || 0 });
      }
      return result.slice(0, maxUnits);
    },
    clear() { players.clear(); conflicts = []; captures.clear(); seen.clear(); syncedAt = 0; },
  };
}
