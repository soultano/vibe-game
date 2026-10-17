import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk } from 'h3-js';
import { CONFIG, FACTIONS, ENERGY_DAILY_CAP_HOURS } from '../src/shared/config.js';
import {
  deriveLevel, projectTerritory, captureArrivalTime, advanceEconomy, netIncome, optimumRatio,
  optimumNetIncome, storageCapacity, upgradeCost, upgradeDurationMs, powerAt,
} from '../src/shared/economy.js';

const HOUR = 3_600_000;
const epoch = 1_700_000_000_000;
const player = (overrides = {}) => ({ level: 1, pixels: 7, tLast: epoch, energy: 75,
  energyTLast: epoch, faction: 'protocol', terrainAverage: 1, ...overrides });
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance,
  `Expected ${actual} close to ${expected} (tolerance ${tolerance})`);

test('sector endpoints, derived time constant and level-independent disk scaling', () => {
  close(deriveLevel(1).angle, 36);
  close(deriveLevel(30).angle, 360);
  for (let level = 1; level <= 30; level += 1) {
    const d = deriveLevel(level);
    close(d.cap / d.capturePerHour, 30 * d.phi);
    close(d.radiusRings, Math.sqrt(d.capDisk / 3));
  }
  assert.equal(CONFIG.SERVER_AUTHORITATIVE_TIME_ONLY, true);
  assert.equal(ENERGY_DAILY_CAP_HOURS, 16);
});

test('closed form is checkpoint invariant, monotonic and does not remove over-cap territory', () => {
  const p = player();
  const expected = deriveLevel(1).cap - (deriveLevel(1).cap - 7) * Math.exp(-2 / 3);
  close(projectTerritory(p, epoch + 2 * HOUR), expected);
  const checkpoint = { ...p, pixels: projectTerritory(p, epoch + HOUR), tLast: epoch + HOUR };
  close(projectTerritory(checkpoint, epoch + 2 * HOUR), expected);
  close(projectTerritory(player({ pixels: 1700 }), epoch + 100 * HOUR), 1700);
  close(projectTerritory(p, epoch - HOUR), 7);
});

test('Swarm cheaper capture consumes less work and grows faster without an energy fee', () => {
  const swarm = deriveLevel(1, 'swarm'), protocol = deriveLevel(1, 'protocol');
  close(swarm.capturePerHour, protocol.capturePerHour / 0.85);
  close(swarm.tauHours, protocol.tauHours * 0.85);
  assert.ok(projectTerritory(player({ faction: 'swarm' }), epoch + HOUR)
    > projectTerritory(player({ faction: 'protocol' }), epoch + HOUR));
});

test('true optimal ratio changes with terrain and faction upkeep', () => {
  const baseline = optimumRatio(1, null);
  close(baseline, (1 / 2.5) ** (2 / 3));
  assert.ok(optimumRatio(1.6, 'protocol') > baseline);
  assert.ok(optimumRatio(1, 'vanguard') < baseline);
  for (const terrain of [0.4, 1, 1.6]) {
    for (const faction of FACTIONS) {
      const opt = optimumRatio(terrain, faction.id) * deriveLevel(8).cap;
      const delta = 0.01;
      assert.ok(netIncome(opt, 8, terrain, faction.id) >= netIncome(opt + delta, 8, terrain, faction.id));
      assert.ok(netIncome(opt, 8, terrain, faction.id) >= netIncome(opt - delta, 8, terrain, faction.id));
    }
  }
});

test('lazy energy integrates both gross and upkeep against a fine independent reference', () => {
  const p = player({ pixels: 37, level: 6, faction: 'vanguard', terrainAverage: 0.75, energy: 300 });
  const duration = 23.7 * HOUR;
  // Reference midpoint integration at 10 seconds, including sign changes and storage.
  const storage = storageCapacity(p.level, p.terrainAverage, p.faction);
  let reference = p.energy;
  const count = Math.ceil(duration / 10_000);
  const dt = duration / count;
  for (let i = 0; i < count; i += 1) {
    const delta = netIncome(projectTerritory(p, epoch + (i + 0.5) * dt), p.level, p.terrainAverage, p.faction) * dt / HOUR;
    const below = Math.min(Math.max(0, storage - reference), Math.max(0, delta));
    reference = delta <= 0 ? Math.max(0, reference + delta)
      : Math.min(storage * 3, reference + below + (delta - below) * CONFIG.OVERFLOW_RATE);
  }
  const actual = advanceEconomy(p, epoch + duration);
  close(actual.energy, reference, Math.max(0.004 * Math.abs(reference), 0.001));
  assert.equal(p.energy, 300, 'advanceEconomy is pure');
});

test('small elapsed times earn energy; repeated checkpoints agree with a single one', () => {
  const p = player({ pixels: 200 });
  const tiny = advanceEconomy(p, epoch + 1000);
  assert.ok(tiny.energy > p.energy);
  close(tiny.energy - p.energy, netIncome(200, 1, 1, 'protocol') / 3600, 0.00001);
  const whole = advanceEconomy(p, epoch + 8 * HOUR);
  let split = p;
  for (let minute = 1; minute <= 480; minute += 1) split = advanceEconomy(split, epoch + minute * 60_000);
  close(split.energy, whole.energy, 0.0001);
  close(split.pixels, whole.pixels, 1e-8);
});

test('upkeep drains energy continuously even over cap and never receives overflow discount', () => {
  const p = player({ pixels: 1500, energy: 10_000, terrainAverage: 0.4 });
  const hourly = netIncome(p.pixels, p.level, p.terrainAverage, p.faction);
  assert.ok(hourly < 0);
  close(advanceEconomy(p, epoch + HOUR).energy, p.energy + hourly, 0.00001);
  close(advanceEconomy(p, epoch + 1000 * HOUR).energy, 0);
});

test('storage overflow and hard ceiling do not depend on checkpoint cadence', () => {
  const storage = storageCapacity(1, 1.6, 'protocol');
  const p = player({ pixels: 1000, terrainAverage: 1.6, energy: storage - 1 });
  const delta = netIncome(1000, 1, 1.6, 'protocol');
  close(advanceEconomy(p, epoch + HOUR).energy, storage + (delta - 1) * 0.25, 0.00001);
  close(advanceEconomy(p, epoch + 1000 * HOUR).energy, storage * 3, 0.00001);
});

test('pending upgrade splits the growth and income trajectory exactly at completion', () => {
  const duration = upgradeDurationMs(1);
  const p = player({ upgradeTargetLevel: 2, upgradeStartedAt: epoch, upgradeCompletesAt: epoch + duration });
  const atEvent = advanceEconomy({ ...p, upgradeTargetLevel: null }, epoch + duration);
  const manual = advanceEconomy({ ...atEvent, level: 2 }, epoch + 2 * HOUR);
  const actual = advanceEconomy(p, epoch + 2 * HOUR);
  assert.equal(actual.level, 2);
  assert.equal(actual.upgradeTargetLevel, null);
  close(actual.pixels, manual.pixels, 1e-8);
  close(actual.energy, manual.energy, 1e-5);
  close(projectTerritory(p, epoch + 2 * HOUR), manual.pixels, 1e-8);
  assert.equal(upgradeCost(1), 50);
  assert.equal(upgradeCost(30), null);
});

test('capture arrival inversion preserves fractional checkpoints and pending upgrade timing', () => {
  const p = player({ pixels: 7.6, upgradeTargetLevel: 2, upgradeStartedAt: epoch,
    upgradeCompletesAt: epoch + upgradeDurationMs(1) });
  for (const hours of [0.01, 0.1, 0.3, 1, 3, 10]) {
    const time = epoch + hours * HOUR;
    close(captureArrivalTime(p, projectTerritory(p, time)), time, 0.001);
  }
  assert.equal(captureArrivalTime(player({ pixels: 1100 }), 1101), Infinity);
  assert.equal(captureArrivalTime(player(), 1000), Infinity);
});

test('faction modifiers are bounded and combat projection responds to location and faction', () => {
  assert.deepEqual(FACTIONS.map((f) => f.id), ['protocol', 'vanguard', 'bloom', 'swarm', 'pack']);
  for (const f of FACTIONS) for (const key of ['income', 'upkeep', 'capture', 'captureCost', 'defense', 'electronicDefense', 'projection', 'melee']) {
    assert.ok(f[key] >= 0.85 && f[key] <= 1.15, `${f.id}.${key}`);
  }
  const baseCell = latLngToCell(41.31, 69.28, 8);
  const p = player({ baseCell, pixels: 500, faction: 'pack' });
  assert.ok(powerAt(p, gridDisk(baseCell, 5).at(-1)) < powerAt(p, baseCell));
  assert.ok(powerAt(p, baseCell, { melee: true }) > powerAt(p, baseCell));
  assert.ok(optimumNetIncome(2) > optimumNetIncome(1));
});
