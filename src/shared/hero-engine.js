import HERO_CONFIG from './hero_progression_config.js';
import { cellToLatLng, gridDisk, gridDistance } from 'h3-js';
import { landscape } from './landscape.js';

export { HERO_CONFIG };

export const HERO_STATES = Object.freeze({
  IDLE: 'IDLE',
  MOVING_WALK: 'MOVING_WALK',
  MOVING_MOUNTED: 'MOVING_MOUNTED',
  COMBAT: 'COMBAT',
  TAMING: 'TAMING'
});

export const HERO_EVENTS = Object.freeze({
  EVENT_HERO_MOVE: 'EVENT_HERO_MOVE',
  EVENT_FOG_REVEAL: 'EVENT_FOG_REVEAL',
  EVENT_BATTLE_END: 'EVENT_BATTLE_END',
  EVENT_TAMING_SUCCESS: 'EVENT_TAMING_SUCCESS',
  EVENT_LEVEL_UP: 'EVENT_LEVEL_UP',
  EVENT_POI_DISCOVERED: 'EVENT_POI_DISCOVERED',
  EVENT_BIOME_DISCOVERED: 'EVENT_BIOME_DISCOVERED'
});

/**
 * Lightweight synchronous event bus for hero actions and reactions.
 */
export class HeroEventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  subscribe(event, callback) {
    return this.on(event, callback);
  }

  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  emit(event, data) {
    const set = this._listeners.get(event);
    if (set) {
      for (const cb of set) {
        try {
          cb(data);
        } catch (err) {
          console.error(`HeroEventBus error on ${event}:`, err);
        }
      }
    }
  }
}

export const globalHeroEvents = new HeroEventBus();

/**
 * Finite State Machine for Hero actions.
 */
export class HeroStateMachine {
  constructor(initialState = HERO_STATES.IDLE) {
    this.state = initialState;
  }

  getState() {
    return this.state;
  }

  canTransition(toState) {
    if (this.state === toState) return true;
    if (this.state === HERO_STATES.IDLE) return true;
    if (toState === HERO_STATES.IDLE) return true;
    return false;
  }

  transition(actionOrState, context = {}) {
    const prev = this.state;
    if (typeof actionOrState === 'string' && HERO_STATES[actionOrState]) {
      if (!this.canTransition(actionOrState)) return false;
      this.state = actionOrState;
      return true;
    }
    switch (actionOrState) {
      case 'MOVE':
        this.state = context.hasMount ? HERO_STATES.MOVING_MOUNTED : HERO_STATES.MOVING_WALK;
        break;
      case 'STOP':
      case 'RESTORE':
        this.state = HERO_STATES.IDLE;
        break;
      case 'COMBAT':
        this.state = HERO_STATES.COMBAT;
        break;
      case 'TAMING':
        this.state = HERO_STATES.TAMING;
        break;
      default:
        break;
    }
    return { from: prev, to: this.state };
  }
}

/**
 * Mathematical progression curve:
 * XP(N) = 100 * N^2.2 - 100
 */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  const cfg = HERO_CONFIG.progression_curve;
  if (cfg.milestone_levels?.[level]?.totalXp !== undefined) {
    return cfg.milestone_levels[level].totalXp;
  }
  return Math.round(cfg.base_multiplier * Math.pow(level, cfg.exponent) - cfg.offset);
}

/**
 * Calculates leadership slots by level (1, 3, 7, 20).
 */
export function getLeadershipSlots(level) {
  const slotsConfig = HERO_CONFIG.leadership_slots_by_level;
  let maxSlots = 1;
  for (const [lvlStr, slots] of Object.entries(slotsConfig)) {
    if (level >= Number(lvlStr)) {
      maxSlots = Math.max(maxSlots, slots);
    }
  }
  return maxSlots;
}

/**
 * Base taming chance calculation:
 * Base Taming Chance = 40% + (Hero_Level - 10) * 2%
 */
export function calculateTamingChance(heroLevel) {
  if (heroLevel < HERO_CONFIG.taming.gate_level) return 0;
  const base = HERO_CONFIG.taming.base_chance;
  const bonus = (heroLevel - HERO_CONFIG.taming.gate_level) * HERO_CONFIG.taming.chance_per_level_above_10;
  return Math.min(0.95, Math.max(0.05, base + bonus));
}

/**
 * Calculates Combat XP from neutral mob defeat:
 * XP = Base_Mob_Tier_XP * (Mob_Count^0.85)
 */
export function calculateNeutralMobXp(tier = 1, count = 1) {
  const baseTierXp = HERO_CONFIG.xp_sources.neutral_mob_tier_xp[String(tier)] || 20;
  const exponent = HERO_CONFIG.xp_sources.neutral_mob_count_exponent || 0.85;
  return Math.round(baseTierXp * Math.pow(Math.max(1, count), exponent));
}

/**
 * Calculates PvP Unit Kill XP:
 * XP = Total_Defeated_Units_Cost * 0.15
 */
export function calculatePvpUnitXp(unitCostTotal = 100) {
  return Math.round(unitCostTotal * (HERO_CONFIG.xp_sources.pvp_unit_cost_factor || 0.15));
}

/**
 * Calculates PvP Hero Defeat XP:
 * XP = Defeated_Hero_Level * 500
 */
export function calculatePvpHeroXp(defeatedHeroLevel = 1) {
  return defeatedHeroLevel * (HERO_CONFIG.xp_sources.pvp_hero_level_bonus || 500);
}

/**
 * Calculates Exploration XP for uncovered fog tiles, POIs, and biomes.
 */
export function calculateExplorationXp(arg = {}) {
  if (typeof arg === 'string') {
    if (arg === 'fog_tile') return HERO_CONFIG.xp_sources.fog_tile_reveal;
    if (arg.startsWith('poi')) return HERO_CONFIG.xp_sources.poi_discovery;
    if (arg.startsWith('biome')) return HERO_CONFIG.xp_sources.biome_discovery;
  }
  const { fogTilesCount = 0, poiCount = 0, biomeCount = 0 } = arg;
  return (
    fogTilesCount * HERO_CONFIG.xp_sources.fog_tile_reveal +
    poiCount * HERO_CONFIG.xp_sources.poi_discovery +
    biomeCount * HERO_CONFIG.xp_sources.biome_discovery
  );
}

/**
 * Computes maximum Movement Points for a hero considering mount and perks.
 */
export function getMaxMovementPoints(hero) {
  const mount = hero?.currentMount ? HERO_CONFIG.mounts[hero.currentMount] : null;
  let baseMp = mount ? HERO_CONFIG.mounted_movement_points : HERO_CONFIG.base_movement_points;
  const speedPerks = (hero?.perks || []).filter(p => p === 'speed').length;
  baseMp += speedPerks * 150;
  return baseMp;
}

/**
 * Calculates MP cost to traverse a specific destination cell.
 */
export function calculateStepMpCost(cell, hero) {
  const ls = landscape(cell);
  const mount = hero?.currentMount ? HERO_CONFIG.mounts[hero.currentMount] : null;

  // Flying mounts (Tier 3) ignore all terrain penalties
  if (mount?.flying) {
    return 75;
  }

  let cost = HERO_CONFIG.terrain_mp_costs[ls.type] || 100;

  // Tier 1 mount: ignore rough plains/grass/road penalties
  if (mount?.tier >= 1 && mount.terrain_ignore?.includes(ls.type)) {
    cost = 75;
  }

  // Tier 2 mount: ignore mud/swamp/snow penalties
  if (mount?.tier >= 2 && mount.terrain_ignore?.includes(ls.type)) {
    cost = 100;
  }

  // Pathfinder skill (unlocked at lvl 5 or perk): reduces rough terrain penalty
  const hasPathfinder = hero.level >= 5 || (hero.perks || []).includes('pathfinder');
  if (hasPathfinder && cost > 100) {
    const penalty = cost - 100;
    cost = 100 + Math.round(penalty * (1 - HERO_CONFIG.pathfinder_penalty_reduction));
  }

  // If hero is mounted (Tier 1+), overall step cost is halved (yielding 2x effective speed)
  if (mount) {
    cost = Math.max(35, Math.round(cost * 0.5));
  }

  return cost;
}

/**
 * Awards experience to a hero, triggering level-ups and event bus notifications.
 */
export function awardHeroXp(hero, amount, eventBus = globalHeroEvents) {
  if (!amount || amount <= 0) return { hero, leveledUp: false, levelsGained: 0 };

  const intellectPerks = (hero.perks || []).filter(p => p === 'intellect').length;
  const intMultiplier = 1 + (hero.stats?.intellect || 0) * 0.05 + intellectPerks * 0.10;
  const finalXp = Math.round(amount * intMultiplier);

  hero.xp = (hero.xp || 0) + finalXp;

  let leveledUp = false;
  let levelsGained = 0;

  while (hero.level < HERO_CONFIG.max_level) {
    const nextXp = xpForLevel(hero.level + 1);
    if (hero.xp >= nextXp) {
      hero.level += 1;
      leveledUp = true;
      levelsGained += 1;
      hero.pendingPerks = (hero.pendingPerks || 0) + 1;
      hero.leadership = getLeadershipSlots(hero.level);

      // Milestone perks
      if (hero.level === 2) {
        hero.stats.attack = (hero.stats.attack || 0) + 1;
        hero.stats.defense = (hero.stats.defense || 0) + 1;
      }
      if (hero.level >= 10 && !hero.unlockedTaming) {
        hero.unlockedTaming = true;
      }

      eventBus.emit(HERO_EVENTS.EVENT_LEVEL_UP, {
        hero,
        newLevel: hero.level,
        levelsGained
      });
    } else {
      break;
    }
  }

  hero.xpNext = xpForLevel(hero.level + 1);
  return { hero, leveledUp, levelsGained, newLevel: hero.level, gainedPerks: levelsGained, xpAwarded: finalXp };
}

/**
 * Factory for creating a new Hero entity.
 */
export function createDefaultHero(accountId, baseCell, name = 'Командир', faction = 'protocol') {
  return {
    id: `hero:${accountId}`,
    ownerId: accountId,
    name,
    faction,
    level: 1,
    xp: 0,
    xpNext: xpForLevel(2),
    pendingPerks: 0,
    baseMp: HERO_CONFIG.base_movement_points,
    mp: HERO_CONFIG.base_movement_points,
    maxMp: HERO_CONFIG.base_movement_points,
    currentMount: null,
    equippedMount: null,
    mountsOwned: [],
    visionRadius: HERO_CONFIG.vision_radius_base,
    leadership: 1,
    stats: {
      attack: 0,
      defense: 0,
      intellect: 0
    },
    unlockedTaming: false,
    inventory: [HERO_CONFIG.taming.required_item],
    perks: [],
    state: HERO_STATES.IDLE,
    cell: baseCell,
    targetCell: null,
    path: [],
    discoveredPois: [],
    discoveredBiomes: [],
    battlesWon: 0,
    mobsDefeated: 0,
    playersDefeated: 0
  };
}

/**
 * Deterministic generation of Points of Interest (POIs) across H3 cells.
 */
export function getDeterministicPoi(cell) {
  if (!cell) return null;
  const hash = Number(BigInt.asUintN(32, BigInt('0x' + cell) ^ 0xa5a5a5a5n));
  // Approximately 1 in 18 land cells has a POI
  if (hash % 19 !== 7) return null;

  const poiTypes = ['mine', 'shrine', 'obelisk', 'ruins'];
  const type = poiTypes[Math.abs((hash >>> 8) % poiTypes.length)];
  const template = HERO_CONFIG.pois[type];
  if (!template) return null;

  const [lat, lng] = cellToLatLng(cell);
  return {
    cell,
    lat,
    lng,
    type: template.type,
    name: template.name,
    icon: template.icon,
    xp: template.xp,
    reward: template
  };
}

/**
 * Deterministic generation of Wild Mounts on suitable map coordinates.
 */
export function getWildMountAt(cell) {
  if (!cell) return null;
  const hash = Number(BigInt.asUintN(32, BigInt('0x' + cell) ^ 0x5b5b5b5bn));
  // 1 in 28 cells has a wild mount
  if (hash % 29 !== 11) return null;

  const mountKeys = Object.keys(HERO_CONFIG.mounts);
  // Tier distribution based on hash
  const tierIndex = Math.abs((hash >>> 6) % mountKeys.length);
  const mountKey = mountKeys[tierIndex];
  const mount = HERO_CONFIG.mounts[mountKey];
  if (!mount) return null;

  const [lat, lng] = cellToLatLng(cell);
  return {
    cell,
    lat,
    lng,
    mountId: mount.id,
    name: `Дикий ${mount.name}`,
    tier: mount.tier,
    icon: mount.icon,
    sprite: mount.sprite,
    tameChance: calculateTamingChance(10)
  };
}
