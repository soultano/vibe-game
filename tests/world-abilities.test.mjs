import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';
import { ABILITIES, abilityDefinition, factionAbilityName } from '../src/shared/abilities.js';
import { decodeTile } from '../src/shared/geography.js';
import { upgradeDurationMs } from '../src/shared/economy.js';

const SECOND = 1_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
const BASE = latLngToCell(41.3111, 69.2797, 8);

async function setup(config = {}, { faction = 'protocol', place = true } = {}) {
  let time = Date.UTC(2026, 9, 17, 12);
  const store = new MemoryStore();
  const now = () => time;
  const game = new GameService({ store, clock: now, config: { npcEnabled:false, ...config } });
  await store.atomic({ puts: [{ key: 'account:a', value: {
    id: 'a', name: 'a', provider: 'telegram', createdAt: time, fingerprintHash: 'device:a',
  } }] });
  if (place) await game.placeBase('a', { cell: BASE, faction });
  const edit = async (updates) => {
    const row = await store.get('player:a');
    assert.equal(await store.atomic({ checks: [{ key: 'player:a', version: row.version }],
      puts: [{ key: 'player:a', value: { ...row.value, ...updates } }] }), true);
  };
  return { game, store, now, edit, advance: (ms) => { time += ms; } };
}

async function heldCells(store) {
  const cells = [];
  for (const { value: tile } of await store.list('tile:')) {
    if (tile.owners.a) cells.push(...decodeTile(tile.parent, tile.owners.a));
  }
  assert.equal(cells.length, new Set(cells).size);
  return cells.sort();
}

async function castAll(game, prefix = 'initial_cast') {
  let model;
  for (const { id } of ABILITIES) model = await game.useAbility('a', { abilityId: id, requestId: `${prefix}_${id}_0001` });
  return model;
}

test('real world masks and energy are cadence invariant with four effects, catch-up batches and an upgrade', async () => {
  const offline = await setup({ maxNewCells: 3 }), frequent = await setup({ maxNewCells: 3 });
  for (const env of [offline, frequent]) {
    await env.game.fundUpgrade('a', { amount: 50 });
    await castAll(env.game);
  }
  offline.advance(90 * MINUTE);
  const a = await offline.game.state('a');
  for (let step = 0; step < 180; step++) { frequent.advance(30 * SECOND); await frequent.game.state('a'); }
  const b = await frequent.game.state('a');
  assert.equal(a.player.pendingCaptures, 0);
  assert.equal(b.player.pendingCaptures, 0);
  assert.equal(a.player.level, 2);
  assert.equal(a.player.pixels, b.player.pixels);
  assert.ok(Math.abs(a.player.energy - b.player.energy) < 0.001, `${a.player.energy} != ${b.player.energy}`);
  const rawA = (await offline.store.get('player:a')).value, rawB = (await frequent.store.get('player:a')).value;
  assert.ok(Math.abs(rawA.growthRemainder - rawB.growthRemainder) < 1e-6);
  assert.deepEqual(await heldCells(offline.store), await heldCells(frequent.store));
  assert.equal((await heldCells(offline.store)).length, a.player.pixels);
  assert.equal(a.player.captureMultiplier, 1);
});

test('abilities accelerate actual packed ownership, rather than only the displayed capture rate', async () => {
  const boosted = await setup(), ordinary = await setup();
  await castAll(boosted.game);
  boosted.advance(3 * MINUTE); ordinary.advance(3 * MINUTE);
  const fast = await boosted.game.state('a'), normal = await ordinary.game.state('a');
  const fastCells = await heldCells(boosted.store), normalCells = await heldCells(ordinary.store);
  assert.equal(fastCells.length, fast.player.pixels);
  assert.equal(normalCells.length, normal.player.pixels);
  assert.ok(fastCells.length > normalCells.length * 1.5);
  assert.ok(normalCells.every((cell) => fastCells.includes(cell)));
  assert.ok(fast.player.energy > normal.player.energy, 'Extra held territory earns its ordinary resource income');
});

test('casts preserve current resources, income formula and construction completion time', async () => {
  const boosted = await setup(), ordinary = await setup();
  const before = await boosted.game.fundUpgrade('a', { amount: 50 });
  await ordinary.game.fundUpgrade('a', { amount: 50 });
  const after = await castAll(boosted.game);
  assert.equal(after.player.captureMultiplier, 4.75);
  assert.equal(after.player.capturePerHour, after.player.baseCapturePerHour * 4.75);
  for (const field of ['pixels', 'energy', 'crystals', 'netPerHour', 'grossPerHour', 'upkeepPerHour', 'storage', 'cap'])
    assert.equal(after.player[field], before.player[field], `${field} changed directly on activation`);
  assert.equal(after.player.project.completesAt, before.player.project.completesAt);
  assert.equal(after.player.project.completesAt, boosted.now() + upgradeDurationMs(1));
  boosted.advance(upgradeDurationMs(1) - 1); ordinary.advance(upgradeDurationMs(1) - 1);
  assert.equal((await boosted.game.state('a')).player.level, 1);
  assert.equal((await ordinary.game.state('a')).player.level, 1);
  boosted.advance(1); ordinary.advance(1);
  assert.equal((await boosted.game.state('a')).player.level, 2);
  assert.equal((await ordinary.game.state('a')).player.level, 2);
  assert.equal((await boosted.game.state('a')).player.paidEnergy.hoursUsed, 0);
});

test('cooldowns are authoritative and reset fees are charged only while cooling', async () => {
  const env = await setup();
  await env.edit({ crystals: 1_000 });
  for (const definition of ABILITIES) {
    const first = await env.game.useAbility('a', { abilityId: definition.id,
      requestId: `cooldown_first_${definition.id}`, resetCooldown: true,
      bonus: 1_000, cooldownMs: 0, activeUntil: Number.MAX_SAFE_INTEGER });
    const beforeCrystals = (await env.store.get('player:a')).value.crystals;
    const publicAbility = first.player.abilities.find(({ id }) => id === definition.id);
    assert.equal(publicAbility.readyAt, env.now() + definition.cooldownMs);
    assert.equal(publicAbility.activeUntil, env.now() + definition.durationMs);
    assert.equal(publicAbility.bonus, definition.bonus);
    const receipt = (await env.store.get('player:a')).value.abilityReceipts.at(-1);
    assert.equal(receipt.price, 0, 'Ready actions stay free even when reset is requested');
    await assert.rejects(() => env.game.useAbility('a', { abilityId: definition.id,
      requestId: `cooldown_blocked_${definition.id}` }), (error) => error.code === 'ABILITY_COOLDOWN' && error.status === 429);
    env.advance(SECOND);
    const paid = await env.game.useAbility('a', { abilityId: definition.id,
      requestId: `cooldown_paid_${definition.id}`, resetCooldown: true });
    assert.equal(paid.player.crystals, beforeCrystals - definition.resetCrystalCost);
    assert.equal(paid.player.abilities.find(({ id }) => id === definition.id).activeUntil, env.now() + definition.durationMs);
  }
  const definition = abilityDefinition('infantry');
  env.advance(definition.cooldownMs);
  const previous = (await env.store.get('player:a')).value.crystals;
  const ready = await env.game.useAbility('a', { abilityId: 'infantry', requestId: 'ready_again_infantry_0001', resetCooldown: true });
  assert.equal(ready.player.crystals, previous);
});

test('duplicate activation request IDs remain idempotent across restarts, elapsed time and concurrent retries', async () => {
  const env = await setup();
  await env.edit({ crystals: 500 });
  await env.game.useAbility('a', { abilityId: 'ultimate', requestId: 'ultimate_first_request_0001' });
  const payload = { abilityId: 'ultimate', requestId: 'ultimate_paid_request_0002', resetCooldown: true };
  const results = await Promise.all([env.game.useAbility('a', payload), env.game.useAbility('a', payload)]);
  assert.ok(results.every(({ player }) => player.crystals === 260));
  const before = (await env.store.get('player:a')).value;
  env.advance(MINUTE);
  const restarted = new GameService({ store: env.store, clock: env.now, config:{npcEnabled:false} });
  const repeated = await restarted.useAbility('a', payload);
  assert.equal(repeated.player.crystals, 260);
  const after = (await env.store.get('player:a')).value;
  assert.deepEqual(after.abilities.ultimate, before.abilities.ultimate);
  assert.equal(after.abilityReceipts.length, 2);
  await assert.rejects(() => restarted.useAbility('a', { ...payload, abilityId: 'field' }), /другой способностью/);
});

test('paid request receipts survive ring eviction, restart and a fully recovered cooldown', async () => {
  const env = await setup();
  await env.edit({ crystals: 1_000 });
  await env.game.useAbility('a', { abilityId: 'infantry', requestId: 'durable_seed_infantry_0001' });
  env.advance(SECOND);
  const paid = { abilityId: 'infantry', requestId: 'durable_paid_infantry_0002', resetCooldown: true };
  await env.game.useAbility('a', paid);
  for (let i = 0; i < 64; i++) {
    env.advance(MINUTE);
    await env.game.useAbility('a', { abilityId: 'infantry', requestId: `eviction_free_infantry_${String(i).padStart(4, '0')}` });
  }
  const before = (await env.store.get('player:a')).value;
  assert.equal(before.crystals, 998);
  assert.equal(before.abilityReceipts.length, 64);
  assert.ok(!before.abilityReceipts.some(({ requestId }) => requestId === paid.requestId));
  assert.ok(await env.store.get(`ability-payment:a:${paid.requestId}`));
  env.advance(MINUTE);
  assert.ok(before.abilities.infantry.readyAt <= env.now());
  const restarted = new GameService({ store: env.store, clock: env.now, config:{npcEnabled:false} });
  const replay = await restarted.useAbility('a', paid);
  assert.equal(replay.player.crystals, 998);
  assert.equal(replay.player.captureMultiplier, 1);
  const after = (await env.store.get('player:a')).value;
  assert.deepEqual(after.abilities, before.abilities, 'A durable replay must not start a new effect after cooldown recovery');
  assert.deepEqual(after.abilityReceipts, before.abilityReceipts);
  await assert.rejects(() => restarted.useAbility('a', { ...paid, abilityId: 'field' }), /другой способностью/);
  assert.equal((await env.store.get('player:a')).value.crystals, 998);
});

test('concurrent free activations with different request IDs have exactly one winner', async () => {
  const env = await setup();
  const results = await Promise.allSettled(['concurrent_free_infantry_0001', 'concurrent_free_infantry_0002']
    .map((requestId) => env.game.useAbility('a', { abilityId: 'infantry', requestId })));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const failure = results.find(({ status }) => status === 'rejected');
  assert.equal(failure.reason.code, 'ABILITY_COOLDOWN');
  const raw = (await env.store.get('player:a')).value;
  assert.equal(raw.abilityReceipts.length, 1);
  assert.equal(raw.crystals, 0);
});

test('public ability definitions use faction names while persistence retains one raw slot per action', async () => {
  const env = await setup({}, { faction: 'bloom' });
  const cast = await env.game.useAbility('a', { abilityId: 'field', requestId: 'persisted_bloom_field_0001' });
  assert.ok(Array.isArray(cast.player.abilities));
  assert.equal(cast.player.abilities.length, 4);
  assert.equal(cast.player.abilityReceipts, undefined);
  for (const definition of ABILITIES) {
    const publicAbility = cast.player.abilities.find(({ id }) => id === definition.id);
    assert.equal(publicAbility.name, factionAbilityName('bloom', definition.id));
  }
  const raw = (await env.store.get('player:a')).value;
  assert.equal(Array.isArray(raw.abilities), false);
  assert.deepEqual(Object.keys(raw.abilities), ['field']);
  env.advance(10 * SECOND);
  const restarted = new GameService({ store: env.store, clock: env.now, config:{npcEnabled:false} });
  const restored = await restarted.state('a');
  assert.deepEqual(restored.player.abilities, cast.player.abilities);
  assert.equal(restored.player.captureMultiplier, 1.5);
});

test('ability validation and insufficient crystals cannot mutate a cast or charge the account', async () => {
  const env = await setup();
  await assert.rejects(() => env.game.useAbility('a', { abilityId: 'invented', requestId: 'valid_request_id_0001' }), /Неизвестная/);
  await assert.rejects(() => env.game.useAbility('a', { abilityId: 'infantry', requestId: 'too-short' }), /Повторите/);
  await assert.rejects(() => env.game.useAbility('a', { abilityId: 'infantry', requestId: 'valid_request_id_0002', resetCooldown: 'true' }), /Некорректный/);
  await env.game.useAbility('a', { abilityId: 'ultimate', requestId: 'insufficient_first_ultimate_0001' });
  const before = (await env.store.get('player:a')).value;
  await assert.rejects(() => env.game.useAbility('a', { abilityId: 'ultimate', requestId: 'insufficient_paid_ultimate_0002', resetCooldown: true }),
    (error) => error.code === 'INSUFFICIENT_CRYSTALS');
  const after = (await env.store.get('player:a')).value;
  assert.deepEqual(after.abilities, before.abilities);
  assert.deepEqual(after.abilityReceipts, before.abilityReceipts);
  assert.equal(after.crystals, 0);
  const unplaced = await setup({}, { place: false });
  await assert.rejects(() => unplaced.game.useAbility('a', { abilityId: 'infantry', requestId: 'unplaced_base_request_0001' }), /Сначала поставьте базу/);
});
