import { gridDistance, cellToLatLng, greatCircleDistance } from 'h3-js';
import { CONFIG, ENERGY_DAILY_CAP_HOURS, getFaction } from './config.js';

const HOUR = 3_600_000;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const levelNumber = (value) => Math.min(CONFIG.MAX_LEVEL, Math.max(1, Math.floor(finite(Number(value), 1))));

export { ENERGY_DAILY_CAP_HOURS };

export function deriveLevel(value, factionId) {
  const level = levelNumber(value);
  const phi = 0.1 + 0.9 * ((level - 1) / (CONFIG.MAX_LEVEL - 1)) ** CONFIG.SECTOR_EXPONENT;
  const capDisk = CONFIG.P_CAP_DISK_BASE * CONFIG.CAPTURE_GROWTH ** (level - 1);
  const cap = capDisk * phi;
  const faction = factionId ? getFaction(factionId) : null;
  // captureCost is work per cell, not an extra energy fee. Swarm needs 15%
  // less work, so the same capture budget processes 1/0.85 as many cells.
  const captureModifier = faction ? faction.capture / faction.captureCost : 1;
  const capturePerHour = CONFIG.R_BASE * CONFIG.CAPTURE_GROWTH ** (level - 1) * captureModifier;
  return {
    level, phi, angle: 360 * phi, sectorAngle: 360 * phi, capDisk, cap, capturePerHour,
    tauHours: cap / capturePerHour,
    radiusRings: Math.sqrt(cap / (3 * phi)),
    projectionRings: CONFIG.PROJECTION_MULTIPLIER * Math.sqrt(cap / 3),
    levelMultiplier: 1 + CONFIG.LEVEL_INCOME_GROWTH * (level - 1),
  };
}

function grow(pixels, elapsedMs, level, faction) {
  const { cap, tauHours } = deriveLevel(level, faction);
  const start = Math.max(0, finite(pixels));
  // Over-cap land incurs upkeep, but cannot vanish merely because a clock advanced.
  if (start >= cap || elapsedMs <= 0) return start;
  return start + (cap - start) * -Math.expm1(-elapsedMs / HOUR / tauHours);
}

function completionTime(player) {
  if (!player.upgradeTargetLevel || !Number.isFinite(player.upgradeStartedAt)) return Infinity;
  return finite(player.upgradeCompletesAt, player.upgradeStartedAt + upgradeDurationMs(player.level));
}

export function projectTerritory(player, nowMs) {
  const start = finite(player.tLast, nowMs);
  const end = Math.max(start, finite(nowMs, start));
  const completion = completionTime(player);
  if (completion > start && completion <= end) {
    const atCompletion = grow(player.pixels, completion - start, player.level, player.faction);
    return grow(atCompletion, end - completion, player.upgradeTargetLevel, player.faction);
  }
  const level = completion <= start ? player.upgradeTargetLevel : player.level;
  return grow(player.pixels, end - start, level, player.faction);
}

/** Inverse growth, split at a pending upgrade, for authoritative claim arrivals. */
export function captureArrivalTime(player, targetPixels) {
  const start = finite(player.tLast);
  const initial = Math.max(0, finite(player.pixels));
  const target = Math.max(0, finite(targetPixels));
  if (target <= initial) return start;
  const inverse = (pixels, level) => {
    const { cap, tauHours } = deriveLevel(level, player.faction);
    if (target <= pixels) return 0;
    if (pixels >= cap || target >= cap) return Infinity;
    return -tauHours * HOUR * Math.log1p(-(target - pixels) / (cap - pixels));
  };
  const completion = completionTime(player);
  if (completion <= start) return start + inverse(initial, player.upgradeTargetLevel);
  if (!Number.isFinite(completion)) return start + inverse(initial, player.level);
  const oldArrival = start + inverse(initial, player.level);
  if (oldArrival <= completion) return oldArrival;
  const atCompletion = grow(initial, completion - start, player.level, player.faction);
  return completion + inverse(atCompletion, player.upgradeTargetLevel);
}

function modifiersFor(terrainAverage, factionId, modifiers = {}) {
  const faction = factionId === null ? { income: 1, upkeep: 1 } : getFaction(factionId);
  return {
    gross: Math.max(0, finite(terrainAverage, 1)) * faction.income
      * finite(modifiers.frontierBonus, CONFIG.FRONTIER_BONUS)
      * finite(modifiers.allianceBonus, CONFIG.ALLIANCE_BONUS)
      * finite(modifiers.isolationMod, CONFIG.ISOLATION_MOD),
    upkeep: faction.upkeep * finite(modifiers.upkeep, 1),
  };
}

export function netIncome(pixels, level, terrainAverage = 1, factionId = 'protocol', modifiers = {}) {
  const data = deriveLevel(level);
  const x = Math.max(0, finite(pixels)) / data.cap;
  const m = modifiersFor(terrainAverage, factionId, modifiers);
  return CONFIG.ENERGY_PER_PIXEL_HOUR * data.levelMultiplier * data.cap
    * (x * m.gross - x ** CONFIG.UPKEEP_BETA * m.upkeep);
}

export function optimumRatio(terrainAverage = 1, factionId = 'protocol', modifiers = {}) {
  const m = modifiersFor(terrainAverage, factionId, modifiers);
  return (m.gross / (CONFIG.UPKEEP_BETA * m.upkeep)) ** (1 / (CONFIG.UPKEEP_BETA - 1));
}

export function optimumNetIncome(level, terrainAverage = 1, factionId = 'protocol', modifiers = {}) {
  return netIncome(deriveLevel(level).cap * optimumRatio(terrainAverage, factionId, modifiers), level, terrainAverage, factionId, modifiers);
}

export function storageCapacity(level, terrainAverage = 1, factionId = 'protocol', modifiers = {}) {
  return CONFIG.STORAGE_HOURS * optimumNetIncome(level, terrainAverage, factionId, modifiers);
}

export function upgradeCost(level) {
  return levelNumber(level) >= CONFIG.MAX_LEVEL ? null : CONFIG.UPGRADE_COST_BASE * CONFIG.UPGRADE_COST_GROWTH ** (levelNumber(level) - 1);
}

export function upgradeDurationMs(level) {
  return Math.min(CONFIG.UPGRADE_TIME_BASE_MINUTES * CONFIG.UPGRADE_TIME_GROWTH ** (levelNumber(level) - 1), CONFIG.UPGRADE_TIME_MAX_MINUTES) * 60_000;
}

export function skipCost(hours) {
  return Math.max(1, Math.ceil(CONFIG.SKIP_COST_BASE * Math.max(0, finite(hours)) ** CONFIG.SKIP_COST_EXPONENT));
}

export function energyPerCrystal(level, terrainAverage = 1, factionId = 'protocol', modifiers = {}) {
  return CONFIG.ENERGY_PER_CRYSTAL_HOURS * optimumNetIncome(level, terrainAverage, factionId, modifiers);
}

// G(x) table requested by the brief. Cubic Hermite interpolation retains its
// endpoints/derivatives, including the exact break-even at x=1 and tiny intervals.
export const G_TABLE = Float64Array.from({ length: CONFIG.INTEGRATION_LUT_SIZE }, (_, i) => {
  const x = i * CONFIG.INTEGRATION_LUT_MAX_X / (CONFIG.INTEGRATION_LUT_SIZE - 1);
  return x - x ** CONFIG.UPKEEP_BETA;
});

function lookupG(x) {
  if (x <= 0 || x >= CONFIG.INTEGRATION_LUT_MAX_X) return x - x ** CONFIG.UPKEEP_BETA;
  const dx = CONFIG.INTEGRATION_LUT_MAX_X / (G_TABLE.length - 1);
  const index = Math.min(G_TABLE.length - 2, Math.floor(x / dx));
  const t = x / dx - index;
  const x0 = index * dx;
  const x1 = x0 + dx;
  const d0 = 1 - CONFIG.UPKEEP_BETA * x0 ** (CONFIG.UPKEEP_BETA - 1);
  const d1 = 1 - CONFIG.UPKEEP_BETA * x1 ** (CONFIG.UPKEEP_BETA - 1);
  return (2 * t ** 3 - 3 * t ** 2 + 1) * G_TABLE[index]
    + (t ** 3 - 2 * t ** 2 + t) * dx * d0
    + (-2 * t ** 3 + 3 * t ** 2) * G_TABLE[index + 1]
    + (t ** 3 - t ** 2) * dx * d1;
}

function integrateSegment(player, start, end) {
  const data = deriveLevel(player.level, player.faction);
  const modifiers = modifiersFor(player.terrainAverage ?? 1, player.faction, player.modifiers);
  const coefficient = CONFIG.ENERGY_PER_PIXEL_HOUR * data.levelMultiplier * data.cap;
  const middle = (start + end) / 2;
  const half = (end - start) / 2;
  const node = Math.sqrt(3 / 5);
  function value(time) {
    const x = grow(player.pixels, time - player.tLast, player.level, player.faction) / data.cap;
    const g = lookupG(x);
    return coefficient * (modifiers.upkeep * g + (modifiers.gross - modifiers.upkeep) * x);
  }
  return half / HOUR * (5 / 9 * value(middle - half * node) + 8 / 9 * value(middle) + 5 / 9 * value(middle + half * node));
}

function storeDelta(energy, delta, storage) {
  if (delta <= 0) return Math.max(0, energy + delta);
  const room = Math.max(0, storage - energy);
  return Math.min(storage * CONFIG.HARD_CEILING_MULTIPLIER,
    energy + Math.min(room, delta) + Math.max(0, delta - room) * CONFIG.OVERFLOW_RATE);
}

function advanceSegment(player, end) {
  const start = finite(player.energyTLast, player.tLast);
  let cursor = Math.max(start, player.tLast);
  let energy = Math.max(0, finite(player.energy));
  const storage = storageCapacity(player.level, player.terrainAverage ?? 1, player.faction, player.modifiers);
  const { cap, tauHours } = deriveLevel(player.level, player.faction);
  const m = modifiersFor(player.terrainAverage ?? 1, player.faction, player.modifiers);
  const breakEven = m.upkeep > 0 ? (m.gross / m.upkeep) ** (1 / (CONFIG.UPKEEP_BETA - 1)) : Infinity;
  const initialX = player.pixels / cap;
  const zeroTime = initialX < breakEven && breakEven < 1 && initialX < 1
    ? player.tLast - tauHours * HOUR * Math.log((1 - breakEven) / (1 - initialX)) : Infinity;
  while (cursor < end) {
    let next = Math.min(end, cursor + CONFIG.INTEGRATION_STEP_MS);
    // Split where NET changes sign: overflow discounts income, never upkeep.
    if (zeroTime > cursor + 0.001 && zeroTime < next) next = zeroTime;
    energy = storeDelta(energy, integrateSegment(player, cursor, next), storage);
    cursor = next;
    const futureX = grow(player.pixels, cursor - player.tLast, player.level, player.faction) / cap;
    if ((energy >= storage * CONFIG.HARD_CEILING_MULTIPLIER && futureX <= breakEven && breakEven >= 1)
      || (energy <= 0 && futureX >= breakEven)) break;
    // Once the growth's remaining contribution is negligible, integrate the
    // asymptotic constant rate in one operation even after years offline.
    if (end - cursor > CONFIG.INTEGRATION_STEP_MS && Math.abs(futureX - Math.max(1, initialX)) < 1e-12) {
      energy = storeDelta(energy, netIncome(cap * futureX, player.level, player.terrainAverage ?? 1, player.faction, player.modifiers) * (end - cursor) / HOUR, storage);
      break;
    }
  }
  return { ...player, energy, energyTLast: end, pixels: grow(player.pixels, end - player.tLast, player.level, player.faction), tLast: end };
}

/** Pure checkpoint. Call only with server time, before any player mutation. */
export function advanceEconomy(player, nowMs) {
  const start = finite(player.tLast, nowMs);
  const end = Math.max(start, finite(nowMs, start));
  const completion = completionTime(player);
  let state = { ...player, level: levelNumber(player.level), tLast: start };
  if (completion <= end) {
    if (completion > start) state = advanceSegment(state, completion);
    state = { ...state, level: levelNumber(player.upgradeTargetLevel), upgradeTargetLevel: null,
      upgradeStartedAt: null, upgradeCompletesAt: null, upgradeInvestment: 0 };
  }
  return advanceSegment(state, end);
}

export function powerAt(player, cell, options = {}) {
  let distance = finite(options.distance, 0);
  if (cell && player.baseCell) {
    try { distance = gridDistance(player.baseCell, cell); }
    catch { distance = greatCircleDistance(cellToLatLng(player.baseCell), cellToLatLng(cell), 'km') / 0.8; }
  }
  const faction = getFaction(player.faction);
  const { projectionRings } = deriveLevel(player.level);
  const territory = Math.max(0, finite(options.pixels, player.pixels));
  const basePower = CONFIG.POWER_LEVEL_GROWTH ** (levelNumber(player.level) - 1)
    * territory ** CONFIG.POWER_TERRITORY_EXPONENT
    * (1 + finite(player.techBonus)) * finite(player.alliancePowerMod, CONFIG.ALLIANCE_POWER_MOD);
  let result = basePower * 2 ** (-distance / (projectionRings * faction.projection));
  if (options.defending) result *= faction.defense * CONFIG.COMBAT_DEFENDER_BONUS;
  if (options.melee) result *= faction.melee;
  if (options.electronicWarfare) result *= faction.electronicDefense;
  if (options.enemyAura) result *= 1 - Math.min(0.15, Math.max(0, options.enemyAura));
  return result;
}
