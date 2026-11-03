import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridDistance } from 'h3-js';
import {
  HERO_CONFIG,
  HERO_STATES,
  HERO_EVENTS,
  HeroStateMachine,
  HeroEventBus,
  xpForLevel,
  getLeadershipSlots,
  calculateTamingChance,
  calculateNeutralMobXp,
  calculatePvpUnitXp,
  calculatePvpHeroXp,
  calculateExplorationXp,
  getMaxMovementPoints,
  calculateStepMpCost,
  awardHeroXp,
  createDefaultHero,
  getDeterministicPoi,
  getWildMountAt
} from '../src/shared/hero-engine.js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';

const TASHKENT = latLngToCell(41.3111, 69.2797, 8);

async function setupGame() {
  let now = Date.UTC(2026, 9, 21, 12);
  const store = new MemoryStore();
  const game = new GameService({ store, clock: () => now });
  const account = async (id) => store.atomic({
    puts: [{
      key: `account:${id}`,
      value: { id, name: `Commander ${id}`, provider: 'google', createdAt: now, fingerprintHash: `device:${id}` }
    }]
  });
  return { game, store, account, now: () => now, advance: (ms) => { now += ms; } };
}

test('Hero Entity initialization and attributes', () => {
  const hero = createDefaultHero('player-1', TASHKENT, 'Commander', 'protocol');
  assert.equal(hero.level, 1);
  assert.equal(hero.mp, 1000);
  assert.equal(hero.maxMp, 1000);
  assert.equal(hero.currentMount, null);
  assert.equal(hero.equippedMount, null);
  assert.equal(hero.visionRadius, 3);
  assert.equal(hero.leadership, 1);
  assert.equal(hero.state, HERO_STATES.IDLE);
  assert.equal(hero.cell, TASHKENT);
  assert.equal(hero.xp, 0);
  assert.equal(hero.xpNext, 250); // XP needed for Level 2
  assert.equal(hero.pendingPerks, 0);
  assert.deepEqual(hero.stats, { attack: 0, defense: 0, intellect: 0 });
});

test('Experience formula curve: XP(N) = 100 * N^2.2 - 100', () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(2), 250);
  assert.equal(xpForLevel(3), 620);
  assert.equal(xpForLevel(5), 1750);
  assert.equal(xpForLevel(7), 3300);
  assert.equal(xpForLevel(10), 7100);
  assert.equal(xpForLevel(15), 16800);
  assert.equal(xpForLevel(20), 31500);
  assert.equal(xpForLevel(50), 420000);
});

test('Leadership army slots progression', () => {
  assert.equal(getLeadershipSlots(1), 1);
  assert.equal(getLeadershipSlots(2), 1);
  assert.equal(getLeadershipSlots(3), 2);
  assert.equal(getLeadershipSlots(6), 2);
  assert.equal(getLeadershipSlots(7), 3);
  assert.equal(getLeadershipSlots(19), 3);
  assert.equal(getLeadershipSlots(20), 4);
  assert.equal(getLeadershipSlots(50), 4);
});

test('Exploration XP calculations', () => {
  const fogXp = calculateExplorationXp('fog_tile');
  assert.equal(fogXp, 10, '+10 XP per fog tile');

  const poiXp = calculateExplorationXp('poi_mine');
  assert.equal(poiXp, 150, '+150 XP per POI');

  const biomeXp = calculateExplorationXp('biome_first_entry');
  assert.equal(biomeXp, 500, '+500 XP per new biome');
});

test('Combat XP calculations (Neutral mobs, PvP units, Hero duel)', () => {
  // Neutral mobs formula: Base_Mob_Tier_XP * (Mob_Count^0.85)
  // Tier 1 (20 xp base), count = 1 -> 20 * 1 = 20
  const mobT1 = calculateNeutralMobXp(1, 1);
  assert.equal(mobT1, 20);

  // Tier 1, count = 10 -> 20 * (10^0.85) = 20 * 7.079 = 142
  const mobT1x10 = calculateNeutralMobXp(1, 10);
  assert.equal(mobT1x10, 142);

  // Tier 3 (200 xp base), count = 5 -> 200 * (5^0.85) = 200 * 3.9298 = 786
  const mobT3x5 = calculateNeutralMobXp(3, 5);
  assert.equal(mobT3x5, 786);

  // PvP Units formula: Total_Defeated_Units_Cost * 0.15
  const pvpUnitXp = calculatePvpUnitXp(2000);
  assert.equal(pvpUnitXp, 300);

  // PvP Hero defeat formula: Defeated_Hero_Level * 500
  const pvpHeroXp = calculatePvpHeroXp(10);
  assert.equal(pvpHeroXp, 5000);
});

test('Leveling up and pending perk points', () => {
  const hero = createDefaultHero('player-1', TASHKENT, 'Commander', 'protocol');
  assert.equal(hero.level, 1);
  assert.equal(hero.pendingPerks, 0);

  // Award enough XP to reach Level 2 (250 XP)
  const result = awardHeroXp(hero, 250);
  assert.equal(hero.level, 2);
  assert.equal(hero.pendingPerks, 1);
  assert.equal(result.leveledUp, true);
  assert.equal(result.newLevel, 2);
  assert.equal(result.gainedPerks, 1);

  // Award enough XP to jump to Level 4 (accumulated 1140 XP)
  awardHeroXp(hero, 1000);
  assert.ok(hero.level >= 3);
  assert.ok(hero.pendingPerks >= 2);
});

test('Taming chance formula and requirements', () => {
  // Formula: 40% + (Hero_Level - 10) * 2%
  // Level 10: 40%
  const chance10 = calculateTamingChance(10);
  assert.equal(Math.round(chance10 * 100), 40);

  // Level 15: 40% + 10% = 50%
  const chance15 = calculateTamingChance(15);
  assert.equal(Math.round(chance15 * 100), 50);

  // Level 25: 40% + 30% = 70%
  const chance25 = calculateTamingChance(25);
  assert.equal(Math.round(chance25 * 100), 70);

  // Max cap 95%
  const chance50 = calculateTamingChance(50);
  assert.ok(chance50 <= 0.95);
});

test('Movement speed and terrain step costs for Foot vs Mounted', () => {
  const hero = createDefaultHero('player-1', TASHKENT, 'Commander', 'protocol');
  assert.equal(hero.currentMount, null);
  assert.equal(getMaxMovementPoints(hero), 1000);

  // Foot mode MP costs: base step is 100 MP * terrain modifier
  const costFoot = calculateStepMpCost(TASHKENT, hero);
  assert.ok(costFoot >= 75 && costFoot <= 150);

  // Equip Tier 1 mount (Horse) -> speed x2, max MP = 2000, 50% step cost
  hero.currentMount = 'horse';
  hero.mountsOwned = ['horse'];
  assert.equal(getMaxMovementPoints(hero), 2000);

  const costMounted = calculateStepMpCost(TASHKENT, hero);
  assert.equal(costMounted, Math.round(costFoot * 0.5));
});

test('Tier 3 Flying mount ignores terrain restrictions', () => {
  const hero = createDefaultHero('player-1', TASHKENT, 'Commander', 'protocol');
  hero.currentMount = 'phoenix';
  hero.mountsOwned = ['phoenix'];

  const mount = HERO_CONFIG.mounts['phoenix'];
  assert.equal(mount.tier, 3);
  assert.equal(mount.flying, true);
  assert.equal(mount.speed_multiplier, 2.5);

  const stepCost = calculateStepMpCost(TASHKENT, hero);
  assert.equal(stepCost, 75);
});

test('Hero State Machine transitions and constraints', () => {
  const sm = new HeroStateMachine(HERO_STATES.IDLE);
  assert.equal(sm.getState(), HERO_STATES.IDLE);

  // IDLE -> MOVING_WALK -> IDLE
  assert.equal(sm.transition(HERO_STATES.MOVING_WALK), true);
  assert.equal(sm.getState(), HERO_STATES.MOVING_WALK);
  assert.equal(sm.transition(HERO_STATES.IDLE), true);

  // IDLE -> MOVING_MOUNTED -> IDLE
  assert.equal(sm.transition(HERO_STATES.MOVING_MOUNTED), true);
  assert.equal(sm.getState(), HERO_STATES.MOVING_MOUNTED);
  assert.equal(sm.transition(HERO_STATES.IDLE), true);

  // IDLE -> COMBAT -> IDLE
  assert.equal(sm.transition(HERO_STATES.COMBAT), true);
  assert.equal(sm.getState(), HERO_STATES.COMBAT);
  assert.equal(sm.transition(HERO_STATES.IDLE), true);

  // IDLE -> TAMING -> IDLE
  assert.equal(sm.transition(HERO_STATES.TAMING), true);
  assert.equal(sm.getState(), HERO_STATES.TAMING);
  assert.equal(sm.transition(HERO_STATES.IDLE), true);

  // Invalid transition: TAMING directly to MOVING_WALK is rejected
  sm.transition(HERO_STATES.TAMING);
  assert.equal(sm.transition(HERO_STATES.MOVING_WALK), false);
  assert.equal(sm.getState(), HERO_STATES.TAMING);
});

test('Hero Event Bus emits all lifecycle events', () => {
  const bus = new HeroEventBus();
  const received = [];

  bus.subscribe(HERO_EVENTS.EVENT_HERO_MOVE, (data) => received.push({ event: HERO_EVENTS.EVENT_HERO_MOVE, data }));
  bus.subscribe(HERO_EVENTS.EVENT_FOG_REVEAL, (data) => received.push({ event: HERO_EVENTS.EVENT_FOG_REVEAL, data }));
  bus.subscribe(HERO_EVENTS.EVENT_LEVEL_UP, (data) => received.push({ event: HERO_EVENTS.EVENT_LEVEL_UP, data }));
  bus.subscribe(HERO_EVENTS.EVENT_TAMING_SUCCESS, (data) => received.push({ event: HERO_EVENTS.EVENT_TAMING_SUCCESS, data }));

  bus.emit(HERO_EVENTS.EVENT_HERO_MOVE, { cell: TASHKENT, mpCost: 100 });
  bus.emit(HERO_EVENTS.EVENT_FOG_REVEAL, { tilesCount: 7 });
  bus.emit(HERO_EVENTS.EVENT_LEVEL_UP, { newLevel: 2 });
  bus.emit(HERO_EVENTS.EVENT_TAMING_SUCCESS, { mount: 'steppe_horse' });

  assert.equal(received.length, 4);
  assert.equal(received[0].event, HERO_EVENTS.EVENT_HERO_MOVE);
  assert.equal(received[1].event, HERO_EVENTS.EVENT_FOG_REVEAL);
  assert.equal(received[2].event, HERO_EVENTS.EVENT_LEVEL_UP);
  assert.equal(received[3].event, HERO_EVENTS.EVENT_TAMING_SUCCESS);
});

test('GameService Hero API endpoints: moveHero, selectHeroPerk, tameMount, toggleHeroMount', async () => {
  const { game, store, account } = await setupGame();
  await account('player-1');

  // 1. Place Base initializes hero
  const placed = await game.placeBase('player-1', {
    cell: TASHKENT,
    azimuth: 0,
    faction: 'protocol',
    name: 'HeroCommander',
    continent: 'asia'
  });

  const hero = placed.player.hero;
  assert.ok(hero, 'Hero must be initialized on base placement');
  assert.equal(hero.level, 1);
  assert.equal(hero.cell, TASHKENT);
  assert.equal(hero.mp, 1000);

  // 2. Move Hero to adjacent cell
  const disk = gridDisk(TASHKENT, 1);
  const nextCell = disk.find(c => c !== TASHKENT);

  const moveRes = await game.moveHero('player-1', { cell: nextCell });
  assert.equal(moveRes.player.hero.cell, nextCell);
  assert.ok(moveRes.player.hero.mp < 1000, 'MP should be deducted on move');
  assert.ok(moveRes.player.hero.xp > 0, 'Exploration XP should be awarded');

  // 3. Award level up and select perk
  const rawPlayer = await store.get('player:player-1');
  const p1 = rawPlayer.value;
  p1.hero.pendingPerks = (p1.hero.pendingPerks || 0) + 1;
  const beforePerks = p1.hero.pendingPerks;
  const beforeAttack = p1.hero.stats.attack || 0;
  await store.atomic({ puts: [{ key: 'player:player-1', value: p1 }] });

  const perkRes = await game.selectHeroPerk('player-1', { perkId: 'attack' });
  assert.equal(perkRes.player.hero.stats.attack, beforeAttack + 1);
  assert.equal(perkRes.player.hero.pendingPerks, beforePerks - 1);

  // 4. Taming validation: level < 10 or missing lasso rejects taming
  await assert.rejects(
    async () => game.tameMount('player-1', { targetCell: TASHKENT }),
    /Укрощение доступно с 10 уровня героя/
  );

  // Find a cell with a wild mount in the vicinity
  const wildTarget = gridDisk(TASHKENT, 40).find(c => getWildMountAt(c) && getWildMountAt(c).tier === 1);
  assert.ok(wildTarget, 'Must find wild mount for testing');

  // Move hero adjacent to wild mount
  const adjacentToWild = gridDisk(wildTarget, 1).find(c => c !== wildTarget);
  const rawPlayer2 = await store.get('player:player-1');
  const currentPlayer = rawPlayer2.value;
  currentPlayer.hero.cell = adjacentToWild;
  currentPlayer.hero.level = 10;
  currentPlayer.hero.inventory = ['taming_lasso'];
  await store.atomic({ puts: [{ key: 'player:player-1', value: currentPlayer }] });

  // Test taming adjacent wild mount
  const tameRes = await game.tameMount('player-1', { targetCell: wildTarget });
  assert.ok(tameRes.tamingResult, 'Taming result must be returned');
  assert.ok(tameRes.tamingResult.chance >= 40, 'Chance must be at least 40%');

  // 5. Mount toggling
  const rawPlayer3 = await store.get('player:player-1');
  const pAfterTame = rawPlayer3.value;
  pAfterTame.hero.mountsOwned = ['horse'];
  pAfterTame.hero.currentMount = null;
  await store.atomic({ puts: [{ key: 'player:player-1', value: pAfterTame }] });

  const mountedRes = await game.toggleHeroMount('player-1', { mountId: 'horse' });
  assert.equal(mountedRes.player.hero.currentMount, 'horse');
  assert.equal(mountedRes.player.hero.visionRadius, 4, 'Mounted vision is base 3 + 1 = 4');

  const dismountRes = await game.toggleHeroMount('player-1', { mountId: null });
  assert.equal(dismountRes.player.hero.currentMount, null);
  assert.equal(dismountRes.player.hero.visionRadius, 3);
});
