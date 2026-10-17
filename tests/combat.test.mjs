import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridRing, gridDistance } from 'h3-js';
import { resolveCombat } from '../src/shared/combat.js';
import { netIncome, storageCapacity } from '../src/shared/economy.js';

const START = 1_700_000_000_000, HOUR = 3_600_000;
const origin = latLngToCell(41.3111, 69.2797, 8);

function fixture(count = 2) {
  const ring = gridRing(origin, 4);
  const bases = [origin, ring[0], ring[Math.floor(ring.length / 2)]];
  const ids = ['alpha', 'bravo', 'charlie'].slice(0, count);
  const owner = new Map(), born = new Map();
  for (const cell of gridDisk(origin, 7)) {
    const id = ids.map((id, i) => ({ id, distance: gridDistance(bases[i], cell) }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0].id;
    owner.set(cell, id); born.set(cell, START);
  }
  const players = ids.map((id, i) => ({ id, baseCell: bases[i], pixels: [...owner.values()].filter((v) => v === id).length,
    faction: ['protocol', 'bloom', 'swarm'][i], level: [9, 2, 5][i], energy: 100,
    terrainAverage: 1.05, createdAt: START, tLast: START, energyTLast: START,
    levelTimeline: [{ at: START, level: [9, 2, 5][i] }], shieldUntil: 0 }));
  const log = [];
  const ledger = new Map(players.map((p) => [p.id, []]));
  const neighbors = new Map();
  const adjacent = (cell) => { if (!neighbors.has(cell)) neighbors.set(cell, gridDisk(cell, 1)); return neighbors.get(cell); };
  const candidateLists = new Map(players.map((p) => [p.id, gridDisk(p.baseCell, 35)
    .sort((a, b) => gridDistance(p.baseCell, a) - gridDistance(p.baseCell, b) || a.localeCompare(b))]));
  const candidateCursors = new Map(players.map((p) => [p.id, 0]));
  const prior = new Map();
  async function run(end, claims = new Map(), options = {}) {
    const initial = new Map(players.map((p) => [p.id, structuredClone(p)]));
    // Prepared future neutral claims are written before battle resolution, just
    // like the authoritative service. Their birth time gates visibility.
    for (const [id, events] of claims) for (const event of events) {
      const p = players.find((p) => p.id === id);
      owner.set(event.cell, id); born.set(event.cell, event.at);
      p.terrainAverage = (p.terrainAverage * p.pixels + event.terrain) / (p.pixels + 1);
      p.pixels++;
    }
    const result = await resolveCombat({ players, now: end, initialPlayers: initial, captures: claims, prior,
      readOwner: async (cell) => owner.get(cell) ?? null,
      readClaimedAt: async (cell) => born.get(cell),
      transfer: async (cell, from, to, at) => {
        assert.equal(owner.get(cell), from);
        owner.set(cell, to); born.set(cell, at); log.push({ cell, from, to, at });
      },
      contacts: async () => {
        const contacts = [], seen = new Set();
        for (const [cell, aId] of owner) for (const neighbor of adjacent(cell)) {
          const bId = owner.get(neighbor);
          if (!bId || aId === bId) continue;
          const key = [cell, neighbor].sort().join(':');
          if (!seen.has(key)) { seen.add(key); contacts.push({ aId, bId, aCell: cell, bCell: neighbor }); }
        }
        return contacts;
      },
      terrainAt: () => ({ multiplier: 1.05 }),
      growth: options.growth ? { claim: async ({ playerId, at }) => {
        const candidates = candidateLists.get(playerId);
        let index = candidateCursors.get(playerId);
        while (index < candidates.length && owner.has(candidates[index])) index++;
        candidateCursors.set(playerId, index + 1);
        if (index >= candidates.length) return null;
        const cell = candidates[index]; owner.set(cell, playerId); born.set(cell, at);
        return { cell, terrain: 1.05 };
      } } : null,
    });
    prior.clear();
    for (const conflict of result.conflicts) prior.set(conflict.id, conflict);
    for (const [id, events] of claims) ledger.get(id).push(...structuredClone(events));
    for (const p of players) { p.tLast = end; p.energyTLast = end; p.energyPixels = p.pixels; p.energyTerrainAverage = p.terrainAverage; }
    return result;
  }
  return { players, owner, born, log, prior, ledger, run };
}

function compareWorlds(a, b) {
  assert.deepEqual([...a.owner].sort(), [...b.owner].sort());
  assert.deepEqual(a.players.map((p) => [p.id, p.pixels]), b.players.map((p) => [p.id, p.pixels]));
  assert.equal(a.log.length, b.log.length);
  for (let i = 0; i < a.log.length; i++) {
    assert.equal(a.log[i].cell, b.log[i].cell);
    assert.equal(a.log[i].from, b.log[i].from);
    assert.equal(a.log[i].to, b.log[i].to);
    assert.ok(Math.abs(a.log[i].at - b.log[i].at) < 0.1, `Event ${i} timestamps differ: ${a.log[i].at} vs ${b.log[i].at}`);
  }
  for (const [pair, conflict] of a.prior) {
    const other = b.prior.get(pair);
    assert.ok(other);
    assert.deepEqual(Object.keys(conflict.pressureByEdge).sort(), Object.keys(other.pressureByEdge).sort());
    for (const key of Object.keys(conflict.pressureByEdge)) {
      assert.ok(Math.abs(conflict.pressureByEdge[key].pressure - other.pressureByEdge[key].pressure) < 1e-6);
    }
  }
}

test('two fronts: one offline 12h query equals 144 five-minute queries', async () => {
  const offline = fixture(2), frequent = fixture(2), end = START + 12 * HOUR;
  await offline.run(end);
  for (let i = 1; i <= 144; i++) await frequent.run(START + i * 5 * 60_000);
  assert.ok(offline.log.length > 10, 'The test must exercise repeated frontier transfers');
  compareWorlds(offline, frequent);
});

test('three neighboring bases resolve globally earliest events independent of query cadence', async () => {
  const offline = fixture(3), frequent = fixture(3), end = START + 12 * HOUR;
  await offline.run(end);
  for (let i = 1; i <= 144; i++) await frequent.run(START + i * 5 * 60_000);
  assert.ok(offline.log.some((e) => e.from === 'charlie' || e.to === 'charlie'));
  compareWorlds(offline, frequent);
});

test('level completion and shield expiry split combat rates at their actual timestamps', async () => {
  const offline = fixture(2), frequent = fixture(2), end = START + 12 * HOUR;
  for (const world of [offline, frequent]) {
    world.players[0].shieldUntil = START + HOUR;
    world.players[0].levelTimeline.push({ at: START + 3.25 * HOUR, fromLevel: 9, level: 10 });
    world.players[0].level = 10; // Current projected level must not apply retroactively.
  }
  await offline.run(end);
  for (let i = 1; i <= 144; i++) await frequent.run(START + i * 5 * 60_000);
  assert.ok(offline.log.every((e) => e.at >= START + HOUR));
  compareWorlds(offline, frequent);
});

test('combat deltas conserve actual ownership and provide signed energy ledger events', async () => {
  const world = fixture(3), captures = new Map(world.players.map((p) => [p.id, []]));
  const total = world.players.reduce((sum, p) => sum + p.pixels, 0);
  const result = await world.run(START + 6 * HOUR, captures);
  assert.equal(world.players.reduce((sum, p) => sum + p.pixels, 0), total);
  assert.equal([...captures.values()].flat().reduce((sum, e) => sum + e.delta, 0), 0);
  assert.equal([...captures.values()].flat().length, result.events.length * 2);
  for (const p of world.players) {
    assert.equal(p.pixels, [...world.owner.values()].filter((id) => id === p.id).length);
    assert.ok(p.pixels >= 1);
    assert.equal(world.owner.get(p.baseCell), p.id, 'Base cell cannot be captured');
  }
});

function ledgerEnergy(initial, events, end) {
  const p = structuredClone(initial);
  let cursor = START;
  for (const event of [...events, { at: end }].sort((a, b) => a.at - b.at)) {
    const delta = netIncome(p.pixels, p.level, p.terrainAverage, p.faction) * (event.at - cursor) / HOUR;
    const storage = storageCapacity(p.level, p.terrainAverage, p.faction);
    const below = Math.min(Math.max(0, storage - p.energy), Math.max(0, delta));
    p.energy = delta <= 0 ? Math.max(0, p.energy + delta)
      : Math.min(storage * 3, p.energy + below + (delta - below) * 0.25);
    if (event.delta) {
      p.terrainAverage = (p.terrainAverage * p.pixels + event.delta * event.terrain) / (p.pixels + event.delta);
      p.pixels += event.delta;
    }
    cursor = event.at;
  }
  return p.energy;
}

test('normal growth birth events plus combat and continuous energy are cadence invariant', async () => {
  const offline = fixture(3), frequent = fixture(3), initial = structuredClone(offline.players);
  const cells = gridRing(origin, 8);
  const scheduled = Array.from({ length: 30 }, (_, i) => ({ id: initial[i % 3].id,
    cell: cells[i], at: START + (i + 1) * 0.31 * HOUR, delta: 1, terrain: 1.05 }));
  function between(from, to) {
    const result = new Map(initial.map((p) => [p.id, []]));
    for (const event of scheduled) if (event.at > from && event.at <= to) {
      const { id, ...claim } = event; result.get(id).push({ ...claim });
    }
    return result;
  }
  const end = START + 12 * HOUR;
  await offline.run(end, between(START, end));
  for (let i = 1; i <= 144; i++) await frequent.run(START + i * 5 * 60_000,
    between(START + (i - 1) * 5 * 60_000, START + i * 5 * 60_000));
  compareWorlds(offline, frequent);
  for (const p of initial) {
    const a = ledgerEnergy(p, offline.ledger.get(p.id), end), b = ledgerEnergy(p, frequent.ledger.get(p.id), end);
    assert.ok(Math.abs(a - b) < 0.0001, `${p.id} energy differs: ${a} vs ${b}`);
  }
});

test('coupled exponential capture clock reschedules after every battle transfer for two and three bases', async () => {
  for (const count of [2, 3]) {
    const offline = fixture(count), frequent = fixture(count), end = START + 12 * HOUR;
    for (const world of [offline, frequent]) for (const [i, p] of world.players.entries()) {
      p.level = 1; p.levelTimeline = [{ at: START, level: 1 }]; p.techBonus = [4, 0, 1][i];
    }
    const initial = structuredClone(offline.players);
    await offline.run(end, new Map(), { growth: true });
    for (let i = 1; i <= 144; i++) await frequent.run(START + i * 5 * 60_000, new Map(), { growth: true });
    assert.ok(offline.log.length > 3, 'Coupled path must actually transfer territory');
    compareWorlds(offline, frequent);
    for (const p of initial) {
      const a = ledgerEnergy(p, offline.ledger.get(p.id), end), b = ledgerEnergy(p, frequent.ledger.get(p.id), end);
      assert.ok(Math.abs(a - b) < 0.001, `${count} bases, ${p.id} energy differs: ${a} vs ${b}`);
      const pa = offline.players.find((v) => v.id === p.id), pb = frequent.players.find((v) => v.id === p.id);
      assert.ok(Math.abs(pa.growthRemainder - pb.growthRemainder) < 1e-6);
    }
  }
});
