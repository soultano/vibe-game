const CAPTURE_DISK_BASE = 10_000;

/** Balance values are explicit calibration inputs, not production load claims. */
export const CONFIG = Object.freeze({
  WORLD_VERSION: 2,
  H3_RESOLUTION: 8,
  TILE_RESOLUTION: 5,
  SHARD_RESOLUTION: 3,
  MAX_LEVEL: 30,
  SERVER_AUTHORITATIVE_TIME_ONLY: true,
  SECTOR_EXPONENT: 0.4,
  CAPTURE_GROWTH: 1.165,
  P_CAP_DISK_BASE: CAPTURE_DISK_BASE,
  // Derived from the brief's 30 hour disk time; not independently tuned.
  R_BASE: CAPTURE_DISK_BASE / 30,
  ENERGY_PER_PIXEL_HOUR: 0.5,
  LEVEL_INCOME_GROWTH: 0.1,
  UPKEEP_BETA: 2.5,
  FRONTIER_BONUS: 1,
  ALLIANCE_BONUS: 1,
  ISOLATION_MOD: 1,
  UPGRADE_COST_BASE: 50,
  UPGRADE_COST_GROWTH: 1.5,
  UPGRADE_TIME_BASE_MINUTES: 10,
  UPGRADE_TIME_GROWTH: 1.27,
  UPGRADE_TIME_MAX_MINUTES: 7200,
  UPGRADE_QUEUE_SLOTS_F2P: 1,
  UPGRADE_QUEUE_SLOTS_VIP: 2,
  STORAGE_HOURS: 14,
  OVERFLOW_RATE: 0.25,
  HARD_CEILING_MULTIPLIER: 3,
  POWER_LEVEL_GROWTH: 1.2,
  POWER_TERRITORY_EXPONENT: 0.75,
  ALLIANCE_POWER_MOD: 1,
  PROJECTION_MULTIPLIER: 1.5,
  COMBAT_RATIO_THRESHOLD: 1.15,
  COMBAT_RATIO_EXCESS_CAP: 2,
  COMBAT_CAPTURE_SHARE_MAX: 0.15,
  COMBAT_CONTACT_CELLS_PER_HOUR: 0.5,
  COMBAT_DEFENDER_BONUS: 1.1,
  ABANDON_COOLDOWN_HOURS: 6,
  ABANDON_NEUTRAL_LOCK_HOURS: 12,
  ABANDON_DAILY_FRACTION: 0.15,
  ROTATE_CRYSTAL_COST: 20,
  ROTATE_COOLDOWN_HOURS: 24,
  SKIP_COST_BASE: 14,
  SKIP_COST_EXPONENT: 0.9,
  ENERGY_PER_CRYSTAL_HOURS: 0.1,
  F2P_CRYSTALS_PER_DAY: 40,
  NEW_ACCOUNT_CRYSTAL_DELAY_HOURS: 72,
  NEW_PLAYER_SHIELD_HOURS: 48,
  SAME_FINGERPRINT_MIN_DISTANCE_KM: 5,
  BASE_PLACEMENT_COOLDOWN_PER_FINGERPRINT_MS: 24 * 3_600_000,
  TILE_POLL_INTERVAL_MS: 5000,
  CHECKPOINT_INTERVAL_MS: 600_000,
  INTEGRATION_STEP_MS: 15 * 60_000,
  INTEGRATION_LUT_SIZE: 512,
  INTEGRATION_LUT_MAX_X: 1.6,
  REGION: Object.freeze({ center: Object.freeze({ lat: 41.3111, lng: 69.2797 }), radiusKm: 1000 }),
  TERRAIN_SOURCE: 'Approximate Natural Earth 1 degree land mask; not ESA WorldCover/GHSL',
  TERRAIN: Object.freeze({ urban: 1.6, cropland: 1.2, grassland: 1.05, forest: 1, shrub: 0.75, mountain: 0.7, desert: 0.4, coastalBonus: 0.15 }),
});

// This invariant intentionally cannot be disabled by configuration or environment.
export const ENERGY_DAILY_CAP_HOURS = 16;

const faction = (id, name, englishName, color, description, territory, bonus, values) => Object.freeze({
  id, name, englishName, color, description, territory, bonus,
  logo: `/assets/factions/${id}.png`,
  income: 1, upkeep: 1, capture: 1, captureCost: 1,
  defense: 1, electronicDefense: 1, projection: 1, melee: 1, adjacentAura: 0,
  ...values,
});

export const FACTIONS = Object.freeze([
  faction('protocol', 'ПРОТОКОЛ', 'The Protocol', '#50e7ff', 'Дроны, ИИ и автоматизированные геодезические платформы.', 'Техно-анкер: гео-бур, неоновые ретрансляторы, сенсоры и кабели.', '+10% добычи; −10% устойчивости к РЭБ.', { income: 1.1, electronicDefense: 0.9 }),
  faction('vanguard', 'ДЕЗАНТ', 'Vanguard', '#ff9f53', 'Штурмовики, экзоскелеты и полевые инженеры.', 'Мобильный фортпост с бронеконтейнерами, генераторами и часовыми.', '+15% защиты; +10% содержания.', { defense: 1.15, upkeep: 1.1 }),
  faction('bloom', 'МИЦЕЛИЙ', 'The Bloom', '#d18bff', 'Мутировавшие грибы, споры и бактериальная биомасса.', 'Светящаяся сеть гиф, грибные наросты и споровый туман.', '10% ослабления смежного врага; −10% скорости захвата.', { adjacentAura: 0.1, capture: 0.9 }),
  faction('swarm', 'ИНСЕКТА', 'The Swarm', '#c7f86b', 'Колонии насекомых и хитиновый рой.', 'Ребристые коконы, кислотные железы и тысячи крыльев.', '−15% стоимости экспансии; −10% защиты.', { captureCost: 0.85, defense: 0.9 }),
  faction('pack', 'СТАЯ', 'The Pack', '#a8dfff', 'Модифицированные звери, кибер-хищники и симбиоты.', 'Логово, когти, трофеи техники и круговой периметр гончих.', '+15% дальности проекции; +10% силы в ближнем бою.', { projection: 1.15, melee: 1.1 }),
]);

export function getFaction(value = 'protocol') {
  const id = typeof value === 'object' && value ? value.id : value;
  return FACTIONS.find((entry) => entry.id === id) || FACTIONS[0];
}
