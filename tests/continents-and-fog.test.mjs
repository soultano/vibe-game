import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridRing, greatCircleDistance } from 'h3-js';
import { CONTINENTS, PRIMARY_CONTINENT, getContinent, validateSettlementPlacement, getContinentLandingRadiusKm } from '../src/shared/continents.js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';
import { FogOfWar } from '../src/client/fog-of-war.js';

const TASHKENT = latLngToCell(41.3111, 69.2797, 8);
const PRAGUE = latLngToCell(50.05, 14.45, 8);
const NEW_YORK = latLngToCell(40.7128, -74.0060, 8);
const SIBERIA_WILD = latLngToCell(64.0, 100.0, 8); // Deep wilderness, far from any landing hub
const PACIFIC_WATER = latLngToCell(0, -140, 8); // Water

async function setup() {
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

test('Continents metadata and dynamic growth expansion calculation', () => {
  assert.equal(CONTINENTS.length, 7, 'Must have 7 continents/landing zones');
  assert.equal(PRIMARY_CONTINENT.id, 'asia');
  
  const europe = getContinent('europe');
  assert.equal(europe.name, 'Европа');
  assert.equal(europe.flag, '🏰');

  // Initial radius for Europe is 90 km
  const r0 = getContinentLandingRadiusKm(europe, 0);
  assert.equal(r0, 90);

  // Grows by +8 km per player
  const r10 = getContinentLandingRadiusKm(europe, 10);
  assert.equal(r10, 170);

  const r100 = getContinentLandingRadiusKm(europe, 100);
  assert.equal(r100, 890);
});

test('Settlement rules allow landing hubs and chain expansion, while blocking isolated wilderness', () => {
  // Tashkent (Primary hub) is allowed
  const checkTashkent = validateSettlementPlacement(TASHKENT);
  assert.equal(checkTashkent.allowed, true);
  assert.equal(checkTashkent.type, 'landing_zone');

  // Europe hub (Prague) is allowed when choosing Europe
  const checkEurope = validateSettlementPlacement(PRAGUE, { continentId: 'europe' });
  assert.equal(checkEurope.allowed, true);

  // New York (North America hub) is allowed when choosing North America
  const checkNY = validateSettlementPlacement(NEW_YORK, { continentId: 'north_america' });
  assert.equal(checkNY.allowed, true);

  // Water is rejected
  const checkWater = validateSettlementPlacement(PACIFIC_WATER);
  assert.equal(checkWater.allowed, false);
  assert.match(checkWater.reason, /в воде/);

  // Deep wilderness without existing bases is rejected
  const checkWild = validateSettlementPlacement(SIBERIA_WILD);
  assert.equal(checkWild.allowed, false);
  assert.match(checkWild.reason, /В диких землях нет связи с экспедицией/);

  // Chain settlement: when an outpost base exists nearby, building next to it is allowed!
  const nearbyOutpost = gridDisk(SIBERIA_WILD, 5)[4];
  const checkChain = validateSettlementPlacement(nearbyOutpost, { existingBases: [SIBERIA_WILD] });
  assert.equal(checkChain.allowed, true);
  assert.equal(checkChain.type, 'cluster');
});

test('Server placeBase respects landing zones and blocks wild placements', async () => {
  const { game, account } = await setup();
  await account('cmd_asia');
  await account('cmd_europe');
  await account('cmd_wild');

  // 1. Placing at primary landing hub succeeds
  const resAsia = await game.placeBase('cmd_asia', { cell: TASHKENT, faction: 'protocol' });
  assert.equal(resAsia.player.baseCell, TASHKENT);

  // 2. Placing at European landing hub succeeds
  const resEur = await game.placeBase('cmd_europe', { cell: PRAGUE, faction: 'vanguard', continent: 'europe' });
  assert.equal(resEur.player.baseCell, PRAGUE);

  // 3. Placing in wild isolated land far from any landing zone fails
  await assert.rejects(
    () => game.placeBase('cmd_wild', { cell: SIBERIA_WILD, faction: 'pack' }),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /диких землях/);
      return true;
    }
  );
});

test('FogOfWar reveals vision around base, living units, and tracks exploration', () => {
  const fog = new FogOfWar({ accountId: 'test_player' });
  
  // Initially no active vision sources
  assert.equal(fog.activeVisionSources.length, 0);

  // Player with base
  const player = {
    baseCell: TASHKENT,
    borderCells: [TASHKENT]
  };
  const units = [
    { id: 'u1', cell: gridDisk(TASHKENT, 2)[3], type: 'infantry', hp: 100 },
    { id: 'u2', cell: gridDisk(TASHKENT, 6)[12], type: 'air', hp: 100 }
  ];

  fog.update(player, units, PRIMARY_CONTINENT);

  // Base vision + territory + 2 units + landing zone = active vision sources
  assert.ok(fog.activeVisionSources.length >= 4);

  // Point at base is in vision
  const [bLat, bLng] = [41.3111, 69.2797];
  assert.equal(fog.isInVision(bLat, bLng), true);

  // Distant point (London or Siberia) is NOT in vision
  assert.equal(fog.isInVision(51.5, -0.1), false);
  assert.equal(fog.isInVision(64.0, 100.0), false);

  // Base cell and unit cells are explored
  assert.equal(fog.isCellExplored(TASHKENT), true);
  assert.equal(fog.isCellExplored(units[0].cell), true);
});
