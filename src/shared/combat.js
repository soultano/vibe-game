import { CONFIG, getFaction } from './config.js';
import { deriveLevel, powerAt, projectTerritory, captureArrivalTime } from './economy.js';
import { terrainForCell } from './geography.js';
import { abilityBoundaryTimes, captureMultiplierAt } from './abilities.js';

const HOUR = 3_600_000;
const EPS_TIME = 0.0001;
const pairId = (a, b) => [a, b].sort().join(':');
const edgeId = (a, b) => [a, b].sort().join(':');
const entries = (value) => value instanceof Map ? value : new Map(Object.entries(value ?? {}));

function addArea(player, delta, multiplier) {
  const old = player.pixels;
  const next = Math.max(1, old + delta);
  player.terrainAverage = Math.max(0, ((player.terrainAverage ?? 1) * old + multiplier * delta) / next);
  player.pixels = next;
}

/**
 * Lazy event simulation, with constant powers between ownership/level events.
 * All normal claims through `now` may already be in the tile store: cell birth
 * timestamps gate future edges. No global tick or fixed battle time step exists.
 *
 * transfer writes ownership only. This helper updates mutable player counters
 * and appends both combat deltas to captures for the caller's energy integral.
 */
export async function resolveCombat({ players, now, initialPlayers, captures, readOwner,
  readClaimedAt, transfer, contacts, prior = new Map(), config = {}, terrainAt = terrainForCell, growth = null }) {
  if (!Number.isFinite(now)) throw new TypeError('Server time is required');
  const actual = new Map(players.map((player) => [player.id, player]));
  const initial = entries(initialPlayers);
  const ledgers = entries(captures);
  const previous = entries(prior);
  const threshold = config.battleThreshold ?? CONFIG.COMBAT_RATIO_THRESHOLD;
  const ratePerHour = config.battleCellsPerContactHour ?? CONFIG.COMBAT_CONTACT_CELLS_PER_HOUR;
  const captureShare = config.battleCaptureShareMax ?? CONFIG.COMBAT_CAPTURE_SHARE_MAX;
  const excessCap = config.battleRatioExcessCap ?? CONFIG.COMBAT_RATIO_EXCESS_CAP;
  if (!(threshold > 1) || !(ratePerHour >= 0) || !(captureShare > 0 && captureShare <= 1) || !(excessCap > 0)) throw new RangeError('Invalid combat calibration');
  const frames = new Map();
  const external = [];
  for (const player of players) {
    const start = initial.get(player.id) ?? player;
    const at = start.energyTLast ?? start.tLast ?? start.createdAt ?? now;
    const timeline = player.levelTimeline ?? start.levelTimeline ?? [];
    const level = [...timeline].reverse().find((event) => event.at <= at)?.level ?? start.level;
    frames.set(player.id, { ...start, level, pixels: start.energyPixels ?? start.pixels,
      terrainAverage: start.energyTerrainAverage ?? start.terrainAverage ?? 1, availableAt: at,
      growthPixels: (start.energyPixels ?? start.pixels) + (start.growthRemainder ?? 0), growthBlocked: false });
    for (const event of timeline) if (event.at > at && event.at <= now) external.push({ ...event, id: player.id, kind: 'level' });
    for (const boundary of abilityBoundaryTimes(start, at, now)) external.push({ at: boundary, id: player.id, kind: 'ability' });
    // Snapshot this ledger: combat appends to it below but applies those deltas
    // immediately, so they must not be processed as external events a second time.
    for (const event of [...(ledgers.get(player.id) ?? [])]) {
      if (!event.combat && event.at >= at && event.at <= now) external.push({ ...event, id: player.id, kind: 'claim' });
    }
  }
  if (!frames.size) return { conflicts: [], events: [], resolvedUntil: now };
  let cursor = Math.min(now, ...[...frames.values()].map((p) => p.availableAt));
  external.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  let externalIndex = 0;
  const pressures = new Map();
  const initialized = new Set();
  const transfers = [];
  const pairStats = new Map();
  const birthCache = new Map();

  async function birth(cell, owner) {
    const key = `${cell}:${owner}`;
    if (!birthCache.has(key)) {
      const value = await readClaimedAt(cell, owner);
      birthCache.set(key, Number.isFinite(value) ? value : frames.get(owner)?.createdAt ?? cursor);
    }
    return birthCache.get(key);
  }

  function applyExternal() {
    while (externalIndex < external.length && external[externalIndex].at <= cursor + EPS_TIME) {
      const event = external[externalIndex++], player = frames.get(event.id);
      if (event.kind === 'level') player.level = event.level;
      else if (event.delta) addArea(player, event.delta, event.terrain ?? player.terrainAverage);
    }
  }

  function score(player, other, cell, defending) {
    return powerAt(player, cell, { defending, melee: true,
      enemyAura: getFaction(other.faction).adjacentAura,
      electronicWarfare: other.faction === 'vanguard' });
  }

  async function activeEdges() {
    const available = await contacts();
    const result = [], seen = new Set();
    let nextActivation = Infinity;
    for (const edge of available) {
      const a = frames.get(edge.aId), b = frames.get(edge.bId);
      if (!a || !b || a.id === b.id) continue;
      if (await readOwner(edge.aCell) !== a.id || await readOwner(edge.bCell) !== b.id) continue;
      const pair = pairId(a.id, b.id), id = edgeId(edge.aCell, edge.bCell), key = `${pair}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const old = previous.get(pair);
      const aBirth = await birth(edge.aCell, a.id), bBirth = await birth(edge.bCell, b.id);
      const contactAt = Math.max(aBirth, bBirth, a.createdAt ?? 0, b.createdAt ?? 0);
      const begins = Math.max(contactAt, a.availableAt, b.availableAt, a.shieldUntil ?? 0, b.shieldUntil ?? 0,
        old?.lastResolvedAt ?? -Infinity);
      if (begins > cursor + EPS_TIME) nextActivation = Math.min(nextActivation, begins);
      const aRatio = score(a, b, edge.bCell, false) / Math.max(1e-12, score(b, a, edge.bCell, true));
      const bRatio = score(b, a, edge.aCell, false) / Math.max(1e-12, score(a, b, edge.aCell, true));
      const aWins = aRatio > bRatio || aRatio === bRatio && a.id.localeCompare(b.id) < 0;
      const attacker = aWins ? a : b, defender = aWins ? b : a;
      const target = aWins ? edge.bCell : edge.aCell, ratio = aWins ? aRatio : bRatio;
      let pressure = pressures.get(key);
      if (!pressure) {
        let saved = initialized.has(key) ? null : old?.pressureByEdge?.[id];
        if (saved && typeof saved === 'object' && Math.abs((saved.contactAt ?? contactAt) - contactAt) > EPS_TIME) saved = null;
        pressure = { value: typeof saved === 'number' ? saved : saved?.pressure ?? 0,
          attacker: typeof saved === 'object' ? saved.attacker : old?.attacker,
          contactAt };
        pressures.set(key, pressure);
        initialized.add(key);
      }
      if (pressure.attacker !== attacker.id) { pressure.value = 0; pressure.attacker = attacker.id; }
      const shielded = (a.shieldUntil ?? 0) > cursor || (b.shieldUntil ?? 0) > cursor;
      const eligible = begins <= cursor + EPS_TIME && !shielded && ratio >= threshold
        && target !== defender.baseCell && defender.pixels > 1;
      result.push({ ...edge, pair, id, key, attacker, defender, target, ratio, pressure, contactAt, shielded,
        rate: eligible ? ratePerHour * Math.min(excessCap, Math.max(0, ratio - 1)) : 0 });
      if (!pairStats.has(pair)) pairStats.set(pair, { transferred: 0, firstContactAt: contactAt });
      pairStats.get(pair).firstContactAt = Math.min(pairStats.get(pair).firstContactAt, contactAt);
    }
    // One attacker cannot multiply its entire capture throughput by opening many
    // fronts. A contact-length bound still applies independently to each edge.
    const totals = new Map();
    for (const edge of result) totals.set(edge.attacker.id, (totals.get(edge.attacker.id) ?? 0) + edge.rate);
    for (const edge of result) {
      const maximum = deriveLevel(edge.attacker.level, edge.attacker.faction).capturePerHour
        * captureMultiplierAt(edge.attacker, cursor) * captureShare;
      const total = totals.get(edge.attacker.id);
      if (total > maximum) edge.rate *= maximum / total;
    }
    for (const key of pressures.keys()) if (!seen.has(key)) pressures.delete(key);
    result.sort((a, b) => a.key.localeCompare(b.key));
    return { edges: result, nextActivation };
  }

  let lastEdges = [];
  for (;;) {
    applyExternal();
    const { edges, nextActivation } = await activeEdges();
    lastEdges = edges;
    const nextPlayerAnchor = Math.min(Infinity, ...[...frames.values()]
      .filter((player) => player.availableAt > cursor + EPS_TIME).map((player) => player.availableAt));
    let next = Math.min(now, external[externalIndex]?.at ?? Infinity, nextActivation, nextPlayerAnchor);
    let crossing = null;
    let expansion = null;
    if (growth?.claim) for (const player of frames.values()) {
      if (player.growthBlocked || player.availableAt > cursor + EPS_TIME) continue;
      const at = captureArrivalTime({ pixels: player.growthPixels, tLast: cursor,
        level: player.level, faction: player.faction, abilities: player.abilities }, Math.floor(player.pixels) + 1);
      if (at <= now + EPS_TIME && (at < next - EPS_TIME || Math.abs(at - next) <= EPS_TIME
        && (!expansion || player.id.localeCompare(expansion.player.id) < 0))) {
        next = Math.min(now, at); expansion = { player, at };
      }
    }
    for (const edge of edges) if (edge.rate > 0) {
      const at = cursor + Math.max(0, 1 - edge.pressure.value) / edge.rate * HOUR;
      if (at <= now + EPS_TIME && (at < next - EPS_TIME || Math.abs(at - next) <= EPS_TIME && (!crossing || edge.key < crossing.key))) {
        next = Math.min(now, at); crossing = edge;
        if (expansion && expansion.at > next + EPS_TIME) expansion = null;
      }
    }
    if (next < cursor - EPS_TIME || !Number.isFinite(next)) throw new Error('Combat event clock moved backwards');
    const elapsed = Math.max(0, next - cursor) / HOUR;
    for (const edge of edges) edge.pressure.value = Math.min(1, edge.pressure.value + edge.rate * elapsed);
    if (growth?.claim) for (const player of frames.values()) {
      if (player.availableAt > next || player.growthBlocked) continue;
      player.growthPixels = projectTerritory({ pixels: player.growthPixels,
        tLast: Math.max(cursor, player.availableAt), level: player.level, faction: player.faction,
        abilities: player.abilities }, next);
    }
    cursor = next;
    // External mutations win exact-time ties. Recompute the crossing using the
    // changed level/area before allowing a cell to change ownership.
    if (external[externalIndex]?.at <= cursor + EPS_TIME) continue;
    // A normal claim wins an exact-time tie with a combat crossing. The next
    // iteration recomputes both clocks using the new actual area and frontier.
    if (expansion && expansion.at <= cursor + EPS_TIME) {
      const player = expansion.player;
      const claimed = await growth.claim({ playerId: player.id, at: cursor, level: player.level,
        azimuth: player.azimuth, pixels: player.pixels });
      if (claimed) {
        if (await readOwner(claimed.cell) !== player.id) throw new Error('Growth callback must commit cell ownership');
        const supplied = claimed.terrain ?? await terrainAt(claimed.cell);
        const multiplier = typeof supplied === 'number' ? supplied : supplied?.multiplier ?? 1;
        addArea(player, 1, multiplier); addArea(actual.get(player.id), 1, multiplier);
        if (!ledgers.has(player.id)) ledgers.set(player.id, []);
        ledgers.get(player.id).push({ cell: claimed.cell, at: cursor, terrain: multiplier, delta: 1 });
        birthCache.set(`${claimed.cell}:${player.id}`, cursor);
      } else {
        player.growthBlocked = true;
        // All available cells in this sector are exhausted. Do not bank an
        // unbounded theoretical area behind an impassable geometric boundary.
        player.growthPixels = player.pixels + Math.min(1 - 1e-12, Math.max(0, player.growthPixels - player.pixels));
      }
      continue;
    }
    // The inverse rate selected this crossing at `cursor`. Unix timestamps
    // cannot represent every sub-millisecond remainder, so checking the
    // re-integrated pressure against 1 again can stall at the same timestamp.
    if (crossing) {
      if (await readOwner(crossing.target) === crossing.defender.id) {
        const terrain = await terrainAt(crossing.target);
        const multiplier = typeof terrain === 'number' ? terrain : terrain?.multiplier ?? 1;
        const moved = await transfer(crossing.target, crossing.defender.id, crossing.attacker.id, cursor);
        if (moved !== false) {
          addArea(crossing.defender, -1, multiplier); addArea(crossing.attacker, 1, multiplier);
          if (growth?.claim) {
            crossing.defender.growthPixels = Math.max(0, crossing.defender.growthPixels - 1);
            crossing.attacker.growthPixels += 1;
          }
          addArea(actual.get(crossing.defender.id), -1, multiplier); addArea(actual.get(crossing.attacker.id), 1, multiplier);
          const attackerPlayer = actual.get(crossing.attacker.id);
          if (attackerPlayer) {
            attackerPlayer.battlesWon = (attackerPlayer.battlesWon ?? 0) + 1;
            attackerPlayer.energy = (attackerPlayer.energy ?? 0) + 25;
          }
          const event = { cell: crossing.target, from: crossing.defender.id, to: crossing.attacker.id, at: cursor, terrain: multiplier };
          transfers.push(event);
          for (const [id, delta] of [[event.from, -1], [event.to, 1]]) {
            if (!ledgers.has(id)) ledgers.set(id, []);
            ledgers.get(id).push({ cell: event.cell, at: cursor, terrain: multiplier, delta, combat: true });
          }
          birthCache.set(`${crossing.target}:${crossing.attacker.id}`, cursor);
          birthCache.delete(`${crossing.target}:${crossing.defender.id}`);
          pairStats.get(crossing.pair).transferred++;
        }
      }
      crossing.pressure.value = 0;
      // Ownership changed: discover newly exposed contact and continue at this
      // event's timestamp, rather than waiting for another client request.
      continue;
    }
    if (cursor >= now - EPS_TIME) break;
  }

  // Rebuild at the final timestamp to remove vanished edges and publish current
  // ratios after the last transfer, including transitions exactly at `now`.
  lastEdges = (await activeEdges()).edges;
  const grouped = new Map();
  for (const edge of lastEdges) {
    if (!grouped.has(edge.pair)) grouped.set(edge.pair, []);
    grouped.get(edge.pair).push(edge);
  }
  const conflicts = [];
  for (const [id, edges] of grouped) {
    const summary = [...edges].sort((a, b) => b.ratio - a.ratio || a.key.localeCompare(b.key))[0];
    const shielded = edges.every((edge) => edge.shielded);
    const pressureByEdge = Object.fromEntries(edges.map((edge) => [edge.id,
      { pressure: edge.pressure.value, attacker: edge.pressure.attacker, contactAt: edge.contactAt }]));
    conflicts.push({ id, players: [summary.aId, summary.bId].sort(), firstContactAt: pairStats.get(id)?.firstContactAt,
      contactLength: edges.length, ratio: summary.ratio, attacker: summary.attacker.id, defender: summary.defender.id,
      status: shielded ? 'shielded' : edges.some((edge) => edge.rate > 0) ? 'active' : 'stalemate',
      transferred: pairStats.get(id)?.transferred ?? 0, pressureByEdge,
      pressure: edges.reduce((sum, edge) => sum + edge.pressure.value, 0), lastResolvedAt: now,
      shieldUntil: shielded ? Math.max(...edges.flatMap((edge) => [frames.get(edge.aId).shieldUntil ?? 0, frames.get(edge.bId).shieldUntil ?? 0])) : null });
  }
  // Write back arrays for callers using a plain object rather than a Map.
  if (captures && !(captures instanceof Map)) for (const [id, ledger] of ledgers) captures[id] = ledger;
  if (growth?.claim) for (const [id, player] of frames) {
    const target = actual.get(id);
    target.growthRemainder = Math.max(0, Math.min(1 - 1e-12, player.growthPixels - player.pixels));
    target.tLast = now;
  }
  return { conflicts, events: transfers, resolvedUntil: now };
}
