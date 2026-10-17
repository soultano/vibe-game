import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceProgression, progressionArrivalTime } from '../src/shared/progression.js';
import { advanceEconomy, projectTerritory, upgradeCost, upgradeDurationMs } from '../src/shared/economy.js';

const epoch = 1_700_000_000_000, HOUR = 3_600_000;
function player(overrides = {}) {
  return { level: 1, pixels: 7, tLast: epoch, energyTLast: epoch, energy: 75,
    terrainAverage: 1, faction: 'protocol', upgradeInvestment: upgradeCost(1),
    upgradeStartedAt: epoch, upgradeCompletesAt: epoch + upgradeDurationMs(1), upgradeTargetLevel: 2,
    queuedProject: { targetLevel: 3, invested: upgradeCost(2), cost: upgradeCost(2), status: 'funded' }, ...overrides };
}
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('funded second slot starts at first completion and both builds finish offline', () => {
  const p = player(), first = p.upgradeCompletesAt, second = first + upgradeDurationMs(2);
  const between = advanceProgression(p, first + 1000);
  assert.equal(between.level, 2);
  assert.equal(between.upgradeStartedAt, first);
  assert.equal(between.upgradeCompletesAt, second);
  assert.equal(between.upgradeTargetLevel, 3);
  assert.equal(between.queuedProject, null);
  const result = advanceProgression(p, epoch + 3 * HOUR);
  assert.equal(result.level, 3);
  assert.equal(result.upgradeTargetLevel, null);
  assert.deepEqual(result.levelTimeline.map(({ at, level }) => ({ at, level })), [{ at: first, level: 2 }, { at: second, level: 3 }]);
  const checkpoint = advanceProgression(between, epoch + 3 * HOUR);
  close(result.pixels, checkpoint.pixels);
  close(result.energy, checkpoint.energy);
  assert.equal(p.level, 1, 'input was not mutated');
});

test('partially funded second slot becomes the primary funding project without starting timer', () => {
  const p = player({ queuedProject: { targetLevel: 3, invested: 12, cost: upgradeCost(2), status: 'funding' } });
  const result = advanceProgression(p, epoch + HOUR);
  assert.equal(result.level, 2);
  assert.equal(result.upgradeInvestment, 12);
  assert.equal(result.upgradeTargetLevel, null);
  assert.equal(result.queuedProject, null);
});

test('single funded project agrees with the economy helper and no upgrade completes twice', () => {
  const p = player({ queuedProject: null });
  const result = advanceProgression(p, epoch + HOUR);
  const manual = advanceEconomy(p, epoch + HOUR);
  close(result.pixels, manual.pixels);
  close(result.energy, manual.energy);
  assert.equal(advanceProgression(result, epoch + 2 * HOUR).levelTimeline.length, 1);
});

test('arrival inversion covers growth before, between and after both funded upgrades', () => {
  const p = player();
  for (const hours of [0.02, 0.2, 0.3, 0.5, 1, 6]) {
    const time = epoch + hours * HOUR;
    const target = advanceProgression(p, time).pixels;
    close(progressionArrivalTime(p, target), time, 0.001);
  }
  const partial = player({ queuedProject: { targetLevel: 3, invested: 12, cost: upgradeCost(2), status: 'funding' } });
  const time = epoch + 2 * HOUR;
  close(progressionArrivalTime(partial, projectTerritory(partial, time)), time, 0.001);
});
