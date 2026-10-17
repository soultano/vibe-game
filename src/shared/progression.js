import { advanceEconomy, captureArrivalTime, projectTerritory, upgradeCost, upgradeDurationMs } from './economy.js';

function completionOf(player) {
  if (!player.upgradeTargetLevel || !Number.isFinite(player.upgradeStartedAt)) return Infinity;
  return player.upgradeCompletesAt ?? player.upgradeStartedAt + upgradeDurationMs(player.level);
}

function queuedOf(player) {
  return player.queuedProject ?? player.upgradeQueue ?? null;
}

function clearQueue(player) {
  player.queuedProject = null;
  if (Object.hasOwn(player, 'upgradeQueue')) player.upgradeQueue = null;
}

function promoteQueue(player, at) {
  const queued = queuedOf(player);
  if (!queued) return player;
  if (queued.targetLevel !== player.level + 1 || player.level >= 30) throw new RangeError('Queued upgrade target must follow the current level');
  const cost = upgradeCost(player.level);
  const invested = Math.min(cost, Math.max(0, queued.invested ?? 0));
  player.upgradeInvestment = invested;
  clearQueue(player);
  if (queued.status === 'funded' && invested >= cost - 1e-8) {
    player.upgradeStartedAt = at;
    player.upgradeCompletesAt = at + upgradeDurationMs(player.level);
    player.upgradeTargetLevel = player.level + 1;
  }
  return player;
}

/** Pure server-time projection for the active build plus one funded VIP project. */
export function advanceProgression(player, nowMs) {
  const now = Math.max(player.tLast ?? nowMs, nowMs);
  let state = structuredClone(player);
  state.levelTimeline = [...(state.levelTimeline ?? [])];
  // Two slots imply at most two completions; guard also catches malformed state.
  for (let count = 0; count < 2; count += 1) {
    const completion = completionOf(state);
    if (!Number.isFinite(completion) || completion > now) break;
    const fromLevel = state.level;
    state = advanceEconomy(state, Math.max(state.tLast, completion));
    state.levelTimeline.push({ at: completion, fromLevel, level: state.level });
    state = promoteQueue(state, completion);
  }
  return advanceEconomy(state, now);
}

/** Inverse analytical growth across active and funded queued build completions. */
export function progressionArrivalTime(player, targetPixels) {
  let state = structuredClone(player);
  for (let count = 0; count < 2; count += 1) {
    const arrival = captureArrivalTime(state, targetPixels);
    const completion = completionOf(state);
    const queued = queuedOf(state);
    if (!Number.isFinite(completion) || !queued || queued.status !== 'funded') return arrival;
    const queuedCompletion = completion + upgradeDurationMs(state.upgradeTargetLevel);
    if (arrival <= queuedCompletion) return arrival;
    // Finish the active build, then move the funded queued build into its slot.
    state.pixels = projectTerritory(state, completion);
    state = advanceEconomy({ ...state, tLast: completion, energyTLast: completion }, completion);
    state = promoteQueue(state, completion);
  }
  return captureArrivalTime(state, targetPixels);
}
