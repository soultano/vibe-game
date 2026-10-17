const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Bonuses add to capture work only; they do not multiply energy or combat power. */
export const ABILITIES = Object.freeze([
  { id: 'infantry', name: 'Лёгкая пехота', bonus: 0.25, durationMs: 30 * SECOND, cooldownMs: MINUTE, resetCrystalCost: 2 },
  { id: 'field', name: 'Энергетическое поле', bonus: 0.5, durationMs: MINUTE, cooldownMs: 3 * MINUTE, resetCrystalCost: 8 },
  { id: 'heavy', name: 'Тяжёлая техника', bonus: 1, durationMs: 10 * MINUTE, cooldownMs: HOUR, resetCrystalCost: 80 },
  { id: 'ultimate', name: 'Спецоперация', bonus: 2, durationMs: 30 * MINUTE, cooldownMs: 24 * HOUR, resetCrystalCost: 240 },
].map(Object.freeze));

const FACTION_NAMES = Object.freeze({
  protocol: Object.freeze({ infantry: 'Патруль дронов', field: 'Импульс перегрузки', heavy: 'Тяжёлая мехаплатформа', ultimate: 'Протокол «Омега»' }),
  vanguard: Object.freeze({ infantry: 'Разведгруппа', field: 'Форсаж экзокостюмов', heavy: 'Осадный батальон', ultimate: 'Операция «Авангард»' }),
  bloom: Object.freeze({ infantry: 'Споровый десант', field: 'Мицелиальный резонанс', heavy: 'Грибной колосс', ultimate: 'Великое цветение' }),
  swarm: Object.freeze({ infantry: 'Выводок разведчиков', field: 'Феромонный всплеск', heavy: 'Матка осады', ultimate: 'Пробуждение улья' }),
  pack: Object.freeze({ infantry: 'Стая разведчиков', field: 'Охотничий азарт', heavy: 'Альфа-хищник', ultimate: 'Зов первозверя' }),
});

export function abilityDefinition(id) {
  return ABILITIES.find((ability) => ability.id === id) ?? null;
}

export function factionAbilityName(faction, id) {
  const ability = abilityDefinition(id);
  if (!ability) return '';
  const factionId = typeof faction === 'object' && faction ? faction.id : faction;
  const names = Object.hasOwn(FACTION_NAMES, factionId) ? FACTION_NAMES[factionId] : null;
  return names?.[ability.id] ?? ability.name;
}

function requireTime(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite server timestamp`);
}

function activeWindows(player) {
  const windows = [];
  for (const ability of ABILITIES) {
    const state = player?.abilities?.[ability.id];
    if (!state || !Number.isFinite(state.activeFrom) || !Number.isFinite(state.activeUntil)) continue;
    // Persisted intervals never grant a longer cast or a different bonus than
    // the canonical catalog, even if an imported record has extra fields.
    const until = Math.min(state.activeUntil, state.activeFrom + ability.durationMs);
    if (until > state.activeFrom) windows.push({ from: state.activeFrom, until, bonus: ability.bonus });
  }
  return windows;
}

/** Active intervals include their beginning and exclude their expiry. */
export function captureMultiplierAt(player, time) {
  requireTime(time, 'time');
  return 1 + activeWindows(player).reduce((sum, window) =>
    sum + (window.from <= time && time < window.until ? window.bonus : 0), 0);
}

/** All effect transitions strictly inside the requested interval. */
export function abilityBoundaryTimes(player, start, end) {
  requireTime(start, 'start');
  if (end !== Infinity) requireTime(end, 'end');
  if (end <= start) return [];
  return [...new Set(activeWindows(player).flatMap((window) => [window.from, window.until])
    .filter((time) => start < time && time < end))].sort((a, b) => a - b);
}

/** Capture time in milliseconds: the exact integral of the speed multiplier. */
export function abilityWorkMs(player, start, end) {
  requireTime(start, 'start');
  requireTime(end, 'end');
  if (end <= start) return 0;
  return activeWindows(player).reduce((work, window) => work
    + window.bonus * Math.max(0, Math.min(end, window.until) - Math.max(start, window.from)), end - start);
}

/** Earliest real timestamp at which the requested capture work has elapsed. */
export function captureWorkArrival(player, start, workMs) {
  requireTime(start, 'start');
  if (workMs === Infinity) return Infinity;
  if (!Number.isFinite(workMs)) throw new TypeError('workMs must be a finite duration or Infinity');
  if (workMs <= 0) return start;
  let remaining = workMs;
  let cursor = start;
  for (const boundary of abilityBoundaryTimes(player, start, Infinity)) {
    const multiplier = captureMultiplierAt(player, cursor);
    const segmentWork = (boundary - cursor) * multiplier;
    if (remaining <= segmentWork) return cursor + remaining / multiplier;
    remaining -= segmentWork;
    cursor = boundary;
  }
  return cursor + remaining / captureMultiplierAt(player, cursor);
}
