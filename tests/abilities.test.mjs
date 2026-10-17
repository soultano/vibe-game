import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITIES, abilityDefinition, factionAbilityName, captureMultiplierAt,
  abilityBoundaryTimes, abilityWorkMs, captureWorkArrival,
} from '../src/shared/abilities.js';
import { advanceEconomy, captureArrivalTime, deriveLevel, powerAt, projectTerritory } from '../src/shared/economy.js';
import { resolveCombat } from '../src/shared/combat.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const cast = (id, from = 0) => ({ activeFrom: from, activeUntil: from + abilityDefinition(id).durationMs });
const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) <= epsilon,
  `Expected ${actual} to be within ${epsilon} of ${expected}`);

test('canonical actions preserve the requested minute, three-minute, hourly and daily cadence', () => {
  assert.deepEqual(ABILITIES.map(({ id, bonus, durationMs, cooldownMs, resetCrystalCost }) =>
    [id, bonus, durationMs, cooldownMs, resetCrystalCost]), [
    ['infantry', 0.25, 30 * SECOND, MINUTE, 2],
    ['field', 0.5, MINUTE, 3 * MINUTE, 8],
    ['heavy', 1, 10 * MINUTE, HOUR, 80],
    ['ultimate', 2, 30 * MINUTE, 24 * HOUR, 240],
  ]);
  assert.equal(abilityDefinition('unknown'), null);
  assert.ok(Object.isFrozen(ABILITIES));
  assert.ok(ABILITIES.every(Object.isFrozen));
});

test('every faction has four distinct localized action names and safe generic fallbacks', () => {
  for (const faction of ['protocol', 'vanguard', 'bloom', 'swarm', 'pack']) {
    const names = ABILITIES.map(({ id }) => factionAbilityName(faction, id));
    assert.equal(new Set(names).size, 4);
    assert.ok(names.every((name) => typeof name === 'string' && name.length > 3));
    assert.equal(factionAbilityName({ id: faction }, 'ultimate'), names[3]);
  }
  assert.equal(factionAbilityName('unknown', 'infantry'), 'Лёгкая пехота');
  assert.equal(factionAbilityName('protocol', 'unknown'), '');
  assert.equal(factionAbilityName('protocol', 'constructor'), '');
  assert.equal(factionAbilityName('__proto__', 'infantry'), 'Лёгкая пехота');
});

test('casts take effect exactly at activation and stop exactly at expiry', () => {
  const player = { abilities: { infantry: cast('infantry', 5 * SECOND) } };
  assert.equal(captureMultiplierAt(player, 5 * SECOND - 1), 1);
  assert.equal(captureMultiplierAt(player, 5 * SECOND), 1.25);
  assert.equal(captureMultiplierAt(player, 35 * SECOND - 1), 1.25);
  assert.equal(captureMultiplierAt(player, 35 * SECOND), 1);
  assert.equal(captureMultiplierAt({}, 10 * SECOND), 1);
});

test('different effects add rather than multiply and expire independently', () => {
  const player = { abilities: Object.fromEntries(ABILITIES.map(({ id }) => [id, cast(id)])) };
  assert.equal(captureMultiplierAt(player, 0), 4.75);
  assert.equal(captureMultiplierAt(player, 30 * SECOND), 4.5);
  assert.equal(captureMultiplierAt(player, MINUTE), 4);
  assert.equal(captureMultiplierAt(player, 10 * MINUTE), 3);
  assert.equal(captureMultiplierAt(player, 30 * MINUTE), 1);
});

test('a repeated cast replaces its single slot without accumulating copies', () => {
  const player = { abilities: { infantry: cast('infantry') } };
  player.abilities.infantry = cast('infantry', 10 * SECOND);
  assert.equal(captureMultiplierAt(player, 15 * SECOND), 1.25);
  assert.equal(captureMultiplierAt(player, 39 * SECOND), 1.25);
  assert.equal(captureMultiplierAt(player, 40 * SECOND), 1);
  assert.equal(abilityWorkMs(player, 10 * SECOND, 40 * SECOND), 37_500);
});

test('unknown abilities, client bonus fields and invalid intervals cannot enlarge the effect', () => {
  const player = { abilities: {
    infantry: { ...cast('infantry'), bonus: 1_000, multiplier: 1_000, activeUntil: 24 * HOUR },
    field: { activeFrom: NaN, activeUntil: MINUTE },
    heavy: { activeFrom: 10, activeUntil: 5 },
    ultimate: { activeFrom: 0, activeUntil: Infinity },
    fabricated: { activeFrom: 0, activeUntil: HOUR, bonus: 1_000 },
  } };
  assert.equal(captureMultiplierAt(player, SECOND), 1.25);
  assert.equal(captureMultiplierAt(player, 30 * SECOND), 1);
  assert.equal(abilityWorkMs(player, 0, HOUR), HOUR + 7_500);
});

test('work uses real overlap, including future starts and effects spanning the interval', () => {
  const player = { abilities: {
    infantry: cast('infantry', 10 * SECOND),
    field: cast('field', 20 * SECOND),
  } };
  // Real time 90s, infantry 30s × .25, field 60s × .5.
  assert.equal(abilityWorkMs(player, 0, 90 * SECOND), 127_500);
  assert.equal(abilityWorkMs(player, 15 * SECOND, 50 * SECOND), 56_250);
  assert.equal(abilityWorkMs(player, 50 * SECOND, 40 * SECOND), 0);
  assert.equal(abilityWorkMs(player, 50 * SECOND, 50 * SECOND), 0);
  assert.deepEqual(abilityBoundaryTimes(player, 10 * SECOND, 80 * SECOND), [20 * SECOND, 40 * SECOND]);
});

test('work and its inverse agree through staggered starts, overlaps and expiries', () => {
  const player = { abilities: {
    infantry: cast('infantry', 10 * SECOND),
    field: cast('field', 20 * SECOND),
    heavy: cast('heavy', 70 * SECOND),
    ultimate: cast('ultimate', 100 * SECOND),
  } };
  for (const start of [0, 15_000, 25_000, 90_000, 800_000, 2_000_000]) {
    for (const length of [0, 1, 20_000, 30_000, 60_000, 600_000, 3 * HOUR]) {
      near(captureWorkArrival(player, start, abilityWorkMs(player, start, start + length)), start + length);
    }
  }
  assert.equal(captureWorkArrival(player, 0, Infinity), Infinity);
  assert.equal(captureWorkArrival(player, 100, -5), 100);
});

test('inverse arrivals at transitions stay on the correct side of a boundary', () => {
  const player = { abilities: { infantry: cast('infantry', 10 * SECOND) } };
  assert.equal(captureWorkArrival(player, 0, 10 * SECOND), 10 * SECOND);
  assert.equal(captureWorkArrival(player, 0, 47_500), 40 * SECOND);
  assert.equal(captureWorkArrival(player, 0, 50 * SECOND), 42_500);
  assert.equal(captureWorkArrival(player, 40 * SECOND, 10 * SECOND), 50 * SECOND);
});

test('splitting at arbitrary polls preserves accumulated work and the arrival timestamp', () => {
  const player = { abilities: Object.fromEntries(ABILITIES.map(({ id }) => [id, cast(id, 5 * SECOND)])) };
  const end = HOUR;
  const whole = abilityWorkMs(player, 0, end);
  let parts = 0;
  for (let start = 0; start < end; start += 13_337) parts += abilityWorkMs(player, start, Math.min(end, start + 13_337));
  near(parts, whole);
  const split = 123_456;
  const firstWork = abilityWorkMs(player, 0, split);
  near(captureWorkArrival(player, split, whole - firstWork), end);
});

test('daily free usage averages 1.5 times capture work without extending effect copies', () => {
  const day = 24 * HOUR;
  let extraWork = 0;
  for (const ability of ABILITIES) {
    for (let from = 0; from < day; from += ability.cooldownMs) {
      const player = { abilities: { [ability.id]: cast(ability.id, from) } };
      extraWork += abilityWorkMs(player, from, from + ability.durationMs) - ability.durationMs;
    }
  }
  assert.equal((day + extraWork) / day, 1.5);
});

test('invalid server times fail explicitly instead of propagating NaN into the game clock', () => {
  assert.throws(() => captureMultiplierAt({}, NaN), TypeError);
  assert.throws(() => abilityWorkMs({}, 0, Infinity), TypeError);
  assert.throws(() => abilityBoundaryTimes({}, NaN, HOUR), TypeError);
  assert.throws(() => captureWorkArrival({}, 0, NaN), TypeError);
});

const START = 1_700_000_000_000;
const fullCast = (from = START) => Object.fromEntries(ABILITIES.map(({ id }) => [id, cast(id, from)]));
function economyPlayer(extra = {}) {
  return { pixels: 1, level: 1, energy: 75, faction: 'protocol', terrainAverage: 1,
    tLast: START, energyTLast: START, abilities: fullCast(), ...extra };
}

test('territory and arrival inversion split boosted work at a real upgrade completion', () => {
  const completion = START + 12 * MINUTE;
  const player = economyPlayer({ upgradeTargetLevel: 2, upgradeStartedAt: START, upgradeCompletesAt: completion });
  const first = deriveLevel(1, 'protocol'), second = deriveLevel(2, 'protocol');
  // Before minute 12: 720 real seconds + 7.5 infantry + 30 field
  // + 600 heavy + 1,440 ultimate. After: 1,980 real + 2,160 ultimate.
  const atUpgrade = first.cap - (first.cap - 1) * Math.exp(-2_797.5 * SECOND / (first.tauHours * HOUR));
  const expected = second.cap - (second.cap - atUpgrade) * Math.exp(-4_140 * SECOND / (second.tauHours * HOUR));
  near(projectTerritory(player, START + 45 * MINUTE), expected);
  for (const offset of [10 * SECOND, 30 * SECOND, MINUTE, 8 * MINUTE, 12 * MINUTE, 20 * MINUTE, 30 * MINUTE, HOUR]) {
    const at = START + offset;
    near(captureArrivalTime(player, projectTerritory(player, at)), at, 0.01);
  }
});

test('boost expiry and an upgrade preserve offline versus frequent territory and real-time energy', () => {
  const player = economyPlayer({ upgradeTargetLevel: 2, upgradeStartedAt: START, upgradeCompletesAt: START + 12 * MINUTE });
  const end = START + 6 * HOUR;
  const offline = advanceEconomy(player, end);
  let frequent = structuredClone(player);
  for (let at = START; at < end; at += 17 * SECOND) frequent = advanceEconomy(frequent, Math.min(at + 17 * SECOND, end));
  near(offline.pixels, frequent.pixels);
  near(offline.energy, frequent.energy, 0.001);
  assert.equal(offline.level, 2);
  assert.equal(offline.upgradeCompletesAt, null);
  assert.ok(offline.energy > player.energy);
});

test('boosted break-even crossing drains upkeep identically after negative income begins', () => {
  const player = economyPlayer({ pixels: 700, energy: 1_000, terrainAverage: 0.7 });
  const end = START + 6 * HOUR;
  const offline = advanceEconomy(player, end);
  let frequent = structuredClone(player);
  for (let at = START; at < end; at += 17 * SECOND) frequent = advanceEconomy(frequent, Math.min(at + 17 * SECOND, end));
  near(offline.pixels, frequent.pixels);
  near(offline.energy, frequent.energy, 0.001);
  assert.ok(offline.energy < player.energy);
});

test('an effect does not grant energy or combat power directly when territory stays unchanged', () => {
  const player = economyPlayer({ pixels: deriveLevel(1, 'protocol').cap, energy: 100 });
  const ordinary = { ...player, abilities: {} };
  const end = START + HOUR;
  near(advanceEconomy(player, end).energy, advanceEconomy(ordinary, end).energy);
  assert.equal(projectTerritory(player, end), ordinary.pixels);
  assert.equal(powerAt(player, null), powerAt(ordinary, null));
  const plain = economyPlayer({ abilities: undefined });
  near(projectTerritory(plain, end), 1 + (1_000 - 1) * -Math.expm1(-1 / 3));
});

function battleFixture(coupled) {
  const owner = new Map(), born = new Map(), log = [], ledger = [], prior = new Map();
  for (let i = 0; i < 200; i++) { owner.set(`a${i}`, 'alpha'); born.set(`a${i}`, START); }
  for (let i = 0; i < 800; i++) { owner.set(`b${i}`, 'bravo'); born.set(`b${i}`, START); }
  const players = [
    { id: 'alpha', pixels: 200, faction: 'protocol', techBonus: 100, abilities: fullCast() },
    { id: 'bravo', pixels: 800, faction: 'bloom', techBonus: 0, abilities: { field: cast('field', START + 45 * SECOND) } },
  ].map((player) => ({ ...player, level: 1, terrainAverage: 1, createdAt: START, tLast: START,
    energyTLast: START, shieldUntil: 0 }));
  const nextCell = new Map(players.map((player) => [player.id, 0]));
  async function run(end) {
    const initialPlayers = new Map(players.map((player) => [player.id, structuredClone(player)]));
    const captures = new Map(players.map((player) => [player.id, []]));
    const result = await resolveCombat({ players, initialPlayers, captures, now: end, prior,
      config: { battleCellsPerContactHour: 1_000_000 },
      readOwner: async (cell) => owner.get(cell), readClaimedAt: async (cell) => born.get(cell),
      contacts: async () => {
        const target = [...owner].find(([cell, id]) => cell.startsWith('b') && id === 'bravo')?.[0];
        return target ? [{ aId: 'alpha', aCell: 'a0', bId: 'bravo', bCell: target }] : [];
      },
      transfer: async (cell, from, to, at) => {
        assert.equal(owner.get(cell), from);
        owner.set(cell, to); born.set(cell, at); log.push({ cell, from, to, at });
      },
      terrainAt: () => ({ multiplier: 1 }),
      growth: coupled ? { claim: async ({ playerId, at }) => {
        const cell = `neutral:${playerId}:${nextCell.get(playerId)}`;
        nextCell.set(playerId, nextCell.get(playerId) + 1);
        owner.set(cell, playerId); born.set(cell, at);
        return { cell, terrain: 1 };
      } } : null,
    });
    prior.clear();
    for (const conflict of result.conflicts) prior.set(conflict.id, conflict);
    for (const [id, events] of captures) ledger.push(...events.map((event) => ({ id, ...event })));
    for (const player of players) {
      player.tLast = end; player.energyTLast = end;
      player.energyPixels = player.pixels; player.energyTerrainAverage = player.terrainAverage;
    }
  }
  return { run, owner, players, log, ledger, prior };
}

test('combat throughput changes at ability expiry while power and frontier rules remain intact', async () => {
  const world = battleFixture(false);
  await world.run(START + 2 * HOUR);
  // 50 cells/h baseline × (2 real h + 4,237.5 bonus seconds).
  assert.equal(world.log.length, Math.floor(50 * (2 + 4_237.5 * SECOND / HOUR)));
  assert.ok(world.log.some((event) => event.at > START + 30 * MINUTE));
  assert.equal(world.players.reduce((sum, player) => sum + player.pixels, 0), 1_000);
});

test('coupled boosted growth and combat agree after one offline query versus minute polls', async () => {
  for (const coupled of [false, true]) {
    const offline = battleFixture(coupled), frequent = battleFixture(coupled);
    const end = START + 2 * HOUR;
    await offline.run(end);
    for (let at = START + MINUTE; at <= end; at += MINUTE) await frequent.run(at);
    assert.deepEqual([...offline.owner].sort(), [...frequent.owner].sort());
    assert.deepEqual(offline.players.map(({ id, pixels }) => [id, pixels]), frequent.players.map(({ id, pixels }) => [id, pixels]));
    assert.equal(offline.log.length, frequent.log.length);
    for (let i = 0; i < offline.log.length; i++) {
      assert.equal(offline.log[i].cell, frequent.log[i].cell);
      near(offline.log[i].at, frequent.log[i].at, 0.1);
    }
    for (let i = 0; i < offline.players.length; i++) {
      if (coupled) near(offline.players[i].growthRemainder, frequent.players[i].growthRemainder, 0.000001);
    }
    for (const [id, conflict] of offline.prior) {
      const other = frequent.prior.get(id);
      assert.deepEqual(Object.keys(conflict.pressureByEdge), Object.keys(other.pressureByEdge));
      for (const key of Object.keys(conflict.pressureByEdge)) near(conflict.pressureByEdge[key].pressure,
        other.pressureByEdge[key].pressure, 0.000001);
    }
    assert.ok(offline.log.length > 100);
  }
});
