import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridRing, cellToLatLng } from 'h3-js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';
import { decodeTile, tileForCell, validatePlayableCell } from '../src/shared/geography.js';
import { upgradeDurationMs, upgradeCost } from '../src/shared/economy.js';

const HOUR = 3_600_000;
const BASE = latLngToCell(41.3111, 69.2797, 8);

async function setup(config = {}) {
  let now = Date.UTC(2026, 9, 17, 12);
  const store = new MemoryStore();
  const game = new GameService({ store, clock: () => now, config });
  const account = async (id, extra = {}) => store.atomic({ puts: [{ key: `account:${id}`, value: {
    id, name: id, provider: 'google', createdAt: now, fingerprintHash: `device:${id}`, ...extra,
  } }] });
  const edit = async (id, updates) => {
    const row = await store.get(`player:${id}`);
    await store.atomic({ checks: [{ key: `player:${id}`, version: row.version }], puts: [{ key: `player:${id}`, value: { ...row.value, ...updates } }] });
  };
  return { game, store, account, edit, now: () => now, advance: ms => now += ms };
}

async function counts(store) {
  const result = new Map(), occupied = new Set();
  for (const { value: tile } of await store.list('tile:')) {
    assert.equal(tile._cells, undefined, 'runtime map is not persisted');
    for (const [owner, mask] of Object.entries(tile.owners)) {
      for (const cell of decodeTile(tile.parent, mask)) {
        assert.ok(!occupied.has(cell), 'a cell has exactly one owner'); occupied.add(cell);
        result.set(owner, (result.get(owner) ?? 0) + 1);
      }
    }
  }
  return result;
}

test('authenticated single-base placement rejects invalid geography and spoofed resources', async () => {
  const { game, account } = await setup();
  await assert.rejects(() => game.placeBase('missing', { cell: BASE }), /Аккаунт/);
  await account('one');
  await assert.rejects(() => game.placeBase('one', { cell: latLngToCell(0, -140, 8) }), /суше/);
  await assert.rejects(() => game.placeBase('one', { cell: BASE, faction: '0' }), /фракция/);
  const result = await game.placeBase('one', { cell: BASE, faction: 'pack', azimuth: 450,
    crystals: 999999, energy: 999999, level: 30, serverTime: 9999999999999 });
  assert.equal(result.player.level, 1); assert.equal(result.player.energy, 75); assert.equal(result.player.crystals, 0);
  assert.equal(result.player.azimuth, 90); assert.equal(result.player.faction, 'pack');
  assert.equal(result.player.fingerprintHash, undefined); assert.equal(result.player.seed, undefined);
  await assert.rejects(() => game.placeBase('one', { cell: BASE }), /уже есть база/);
});

test('concurrent placements cannot claim the same cell', async () => {
  const { game, account, store } = await setup();
  await account('a'); await account('b');
  const results = await Promise.allSettled(['a', 'b'].map(id => game.placeBase(id, { cell: BASE })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.list('player:')).length, 1);
  assert.equal([...await counts(store)].reduce((n, [, count]) => n + count, 0), 1);
});

test('five-second polling carries fractional growth and every claim is backed by a compact mask', async () => {
  const { game, account, advance, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  for (let step = 0; step < 12; step++) { advance(5000); await game.state('a'); }
  const state = await game.state('a');
  assert.ok(state.player.pixels >= 6); assert.ok(state.player.energy > 75);
  assert.equal((await counts(store)).get('a'), state.player.pixels);
  assert.equal((await store.list('cell:')).length, 0);
});

test('elapsed server time expands multiple owners without overlap and restart preserves the world', async () => {
  const { game, account, advance, store, now } = await setup();
  await account('a'); await account('b');
  await game.placeBase('a', { cell: BASE, azimuth: 0 });
  const other = gridDisk(BASE, 5).filter(validatePlayableCell).find(cell => cell !== BASE && cellToLatLng(cell)[0] > cellToLatLng(BASE)[0]);
  await game.placeBase('b', { cell: other, azimuth: 180, faction: 'bloom' });
  advance(HOUR);
  const a = await game.state('a'), b = await game.state('b');
  const held = await counts(store);
  assert.equal(held.get('a'), a.player.pixels); assert.equal(held.get('b'), b.player.pixels);
  const restarted = new GameService({ store, clock: now });
  assert.equal((await restarted.state('a')).player.pixels, a.player.pixels);
});

test('upgrade funding accepts installments, launches timer only at full funding, completes offline', async () => {
  const { game, account, advance } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  let state = await game.fundUpgrade('a', { amount: 20 });
  assert.equal(state.player.project.invested, 20); assert.equal(state.player.project.completesAt, null);
  state = await game.fundUpgrade('a', { amount: 30 });
  assert.equal(state.player.project.status, 'building'); assert.equal(state.player.energy, 25);
  await assert.rejects(() => game.fundUpgrade('a', { amount: 1 }), /Строительство/);
  advance(upgradeDurationMs(1) + 1);
  state = await game.state('a');
  assert.equal(state.player.level, 2); assert.equal(state.player.project.invested, 0);
  assert.equal(state.player.project.cost, upgradeCost(2));
});

test('daily crystals require 72 hours and fingerprint; UTC reward is atomic', async () => {
  const { game, account, advance, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  await assert.rejects(() => game.claimDaily('a'), /72 часа/);
  advance(72 * HOUR);
  const results = await Promise.allSettled([game.claimDaily('a'), game.claimDaily('a')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.get('player:a')).value.crystals, 40);
  advance(24 * HOUR);
  assert.equal((await game.claimDaily('a')).player.crystals, 80);
});

test('verified payment receipts are idempotent and cannot be reused by another account', async () => {
  const { game, account, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  const purchase = { eventId: 'evt_123', accountId: 'a', sku: 'crystals_500' };
  const results = await Promise.all([game.applyPurchase(purchase), game.applyPurchase(purchase)]);
  assert.equal(results.filter(r => r.credited).length, 1);
  assert.equal((await store.get('player:a')).value.crystals, 500);
  await assert.rejects(() => game.applyPurchase({ ...purchase, accountId: 'other' }), /уже использован/);
  await assert.rejects(() => game.applyPurchase({ ...purchase, eventId: 'fake', sku: 'second_base' }), /Неизвестный товар/);
});

test('paid energy has an immutable 16-hour UTC cap even if configuration tries to disable it', async () => {
  const { game, account, edit, advance, store } = await setup({ energyDailyCapHours: Infinity });
  await account('a'); await game.placeBase('a', { cell: BASE }); await edit('a', { crystals: 1000, energy: 0 });
  let state = await game.spendCrystals('a', { kind: 'energy', crystals: 160 });
  assert.equal(state.player.paidEnergy.hoursUsed, 16); assert.equal(state.player.crystals, 840);
  await assert.rejects(() => game.spendCrystals('a', { kind: 'energy', crystals: 1 }), /16 часов/);
  assert.equal((await store.get('player:a')).value.crystals, 840);
  advance(24 * HOUR); await edit('a', { energy: 0 });
  state = await game.spendCrystals('a', { kind: 'energy', crystals: 1 });
  assert.equal(state.player.paidEnergy.hoursUsed, 0.1);
});

test('abandon settles accumulated upkeep first, enforces daily fraction, and locks cells for 12 hours', async () => {
  const { game, account, advance, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE }); advance(HOUR);
  const before = await game.state('a');
  const cells = [];
  for (const { value: tile } of await store.list('tile:')) if (tile.owners.a)
    cells.push(...decodeTile(tile.parent, tile.owners.a).filter(c => c !== BASE));
  const released = cells.slice(0, 2);
  const after = await game.abandon('a', { cells: released });
  assert.equal(after.player.pixels, before.player.pixels - 2); assert.equal(after.player.energy, before.player.energy);
  await assert.rejects(() => game.abandon('a', { cells: cells.slice(2, 3) }), /6 часов/);
  const tile = (await store.get(`tile:${tileForCell(released[0])}`)).value;
  assert.ok(tile.locks[released[0]] > after.serverTime + 11 * HOUR);
  await account('b');
  await assert.rejects(() => game.placeBase('b', { cell: released[0] }), /закрыта/);
});

test('tile versions return masks, diffs and unchanged responses; spectator request materializes elapsed growth', async () => {
  const { game, account, advance } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  const parent = tileForCell(BASE);
  const full = await game.tiles({ parents: [parent] });
  assert.equal(full.tiles[0].full, true); assert.ok(decodeTile(parent, full.tiles[0].owners.a).includes(BASE));
  const version = full.tiles[0].version;
  assert.equal((await game.tiles({ parents: [parent], versions: { [parent]: version } })).tiles[0].unchanged, true);
  advance(60_000);
  const changes = await game.tiles({ parents: [parent], versions: { [parent]: version } });
  assert.ok(changes.tiles[0].version > version); assert.ok(changes.tiles[0].changes.length > 0);
  assert.ok(changes.tiles[0].diffBitmask);
});

test('fingerprint cooldown prevents linked accounts from placing multiple immediate bases', async () => {
  const { game, account } = await setup();
  await account('a', { fingerprintHash: 'same' }); await account('b', { fingerprintHash: 'same' });
  await game.placeBase('a', { cell: BASE });
  const next = gridDisk(BASE, 2).find(c => c !== BASE && validatePlayableCell(c));
  await assert.rejects(() => game.placeBase('b', { cell: next }), /устройства/);
});

test('rotation is paid in crystals and preserves old territory', async () => {
  const { game, account, edit, advance, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE }); advance(60_000);
  await game.state('a'); await edit('a', { crystals: 40 });
  const before = await counts(store), changed = await game.rotate('a', { azimuth: 180 });
  assert.equal(changed.player.crystals, 20); assert.equal(changed.player.azimuth, 180);
  assert.equal((await counts(store)).get('a'), before.get('a'));
  await assert.rejects(() => game.rotate('a', { azimuth: 90 }), /24 часов/);
});

test('offline territory and energy match frequent polling even across tiny catch-up batches', async () => {
  const offline = await setup({ maxNewCells: 3 }), online = await setup({ maxNewCells: 3 });
  for (const env of [offline, online]) { await env.account('a'); await env.game.placeBase('a', { cell: BASE }); }
  offline.advance(HOUR); const a = await offline.game.state('a');
  for (let step = 0; step < 60; step++) { online.advance(60_000); await online.game.state('a'); }
  const b = await online.game.state('a');
  assert.equal(a.player.pendingCaptures, 0); assert.equal(a.player.pixels, b.player.pixels);
  assert.ok(Math.abs(a.player.energy - b.player.energy) < 1e-7, `${a.player.energy} differs from ${b.player.energy}`);
  assert.deepEqual([...await counts(offline.store)], [...await counts(online.store)]);
});

test('VIP funds a second project and both upgrade timers complete at their original offline times', async () => {
  const { game, account, edit, advance, now } = await setup({ maxNewCells: 7 });
  await account('a'); await game.placeBase('a', { cell: BASE });
  await game.applyPurchase({ eventId: 'invoice-vip', accountId: 'a', sku: 'vip_month', periodEnd: now() + 30 * 24 * HOUR,
    stripeCustomerId: 'cus_private', stripeSubscriptionId: 'sub_private' });
  await edit('a', { energy: 300 });
  const firstAt = (await game.fundUpgrade('a', { amount: 50 })).player.project.completesAt;
  let state = await game.fundUpgrade('a', { amount: 75 });
  assert.equal(state.player.queueSlots, 2); assert.equal(state.player.queuedProject.status, 'funded');
  assert.equal(state.player.stripeCustomerId, undefined); assert.equal(state.player.stripeSubscriptionId, undefined);
  advance(upgradeDurationMs(1) + 1);
  state = await game.state('a');
  assert.equal(state.player.level, 2); assert.equal(state.player.project.completesAt, firstAt + upgradeDurationMs(2));
  assert.equal(state.player.queuedProject, null);
  advance(upgradeDurationMs(2));
  state = await game.state('a');
  assert.equal(state.player.level, 3); assert.equal(state.player.project.status, 'funding');
});

test('different cells cannot bypass the fingerprint placement epoch race', async () => {
  const { game, account, store } = await setup();
  await account('a', { fingerprintHash: 'same-device' }); await account('b', { fingerprintHash: 'same-device' });
  const distant = latLngToCell(42, 70, 8);
  const results = await Promise.allSettled([game.placeBase('a', { cell: BASE }), game.placeBase('b', { cell: distant })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.list('player:')).length, 1);
});

test('unrelated players are excluded from the transactional compare-and-swap read set', async () => {
  const { game, account, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  const far = latLngToCell(45, 75, 8);
  await account('b'); await game.placeBase('b', { cell: far });
  const actualAtomic = store.atomic.bind(store); let lastChecks = [];
  store.atomic = async input => { lastChecks = input.checks; return actualAtomic(input); };
  await game.state('a');
  assert.ok(lastChecks.some(check => check.key === 'player:a'));
  assert.ok(!lastChecks.some(check => check.key === 'player:b'));
  assert.ok(lastChecks.some(check => check.key.startsWith('world-index:')));
});

test('hot world queries use neighbouring spatial buckets instead of scanning all players or metadata', async () => {
  const { game, account, store, advance } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  const originalList = store.list.bind(store);
  store.list = async (prefix, options) => {
    assert.ok(!prefix.startsWith('player:') && (!prefix.startsWith('spatial:') || /^spatial:[^:]+:81[0-9a-f]+:$/.test(prefix)), `hot prefix scan: ${prefix}`);
    return originalList(prefix, options);
  };
  advance(60_000);
  assert.ok((await game.state('a')).player.pixels > 1);
  const tiles = await game.tiles({ parents: [tileForCell(BASE)] });
  assert.ok(tiles.players.some(p => p.id === 'a' && p.faction === 'protocol'));
  assert.equal(tiles.players.find(p => p.id === 'a').fingerprintHash, undefined);
});

test('a delayed old paid subscription invoice does not grant a new free month', async () => {
  const { game, account, now, store } = await setup();
  await account('a'); await game.placeBase('a', { cell: BASE });
  const expired = now() - HOUR;
  await game.applyPurchase({ eventId: 'stripe:invoice:old', accountId: 'a', sku: 'vip_month', periodEnd: expired });
  assert.equal((await store.get('player:a')).value.vipUntil, expired);
  assert.equal((await game.state('a')).player.queueSlots, 1);
});

test('complete world: twelve offline hours equal 144 polls with growth, upgrade and border wars for two and three bases', async () => {
  const ownership = async store => {
    const result = [];
    for (const { value: tile } of await store.list('tile:')) for (const [id, mask] of Object.entries(tile.owners))
      for (const cell of decodeTile(tile.parent, mask)) result.push(`${cell}:${id}`);
    return result.sort();
  };
  for (const count of [2, 3]) {
    const createWorld = async () => {
      const env = await setup({ shieldHours: 0, battleCellsPerContactHour: 0.25 });
      const east = gridRing(BASE, 5).sort((a, b) => cellToLatLng(b)[1] - cellToLatLng(a)[1])[0];
      const north = gridRing(BASE, 6).sort((a, b) => cellToLatLng(b)[0] - cellToLatLng(a)[0])[0];
      const starts = [['a', BASE, 90, 'protocol'], ['b', east, 270, 'vanguard'], ['c', north, 180, 'swarm']];
      for (const [id, cell, azimuth, faction] of starts.slice(0, count)) {
        await env.account(id); await env.game.placeBase(id, { cell, azimuth, faction });
      }
      await env.game.fundUpgrade('a', { amount: 50 });
      return env;
    };
    const offline = await createWorld(), frequent = await createWorld();
    offline.advance(12 * HOUR);
    const offlineState = await offline.game.state('a');
    for (let step = 0; step < 144; step++) { frequent.advance(5 * 60_000); await frequent.game.state('a'); }
    assert.deepEqual(await ownership(offline.store), await ownership(frequent.store), `${count} bases: ownership changes with polling`);
    for (const id of ['a', 'b', 'c'].slice(0, count)) {
      const a = (await offline.store.get(`player:${id}`)).value, b = (await frequent.store.get(`player:${id}`)).value;
      assert.equal(a.pixels, b.pixels);
      assert.ok(Math.abs(a.energy - b.energy) < 0.001, `${id}: ${a.energy} != ${b.energy}`);
      assert.ok(Math.abs(a.growthRemainder - b.growthRemainder) < 1e-6);
    }
    assert.equal(offlineState.player.level, 2);
    assert.ok(offlineState.conflicts.some(conflict => conflict.transferred > 0), 'The trajectory must include real battles');
  }
});
