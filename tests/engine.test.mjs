import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/client/practice-engine.js', import.meta.url), 'utf8');
const { GameEngine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const make = () => new GameEngine({ width: 40, height: 24, land: Array(960).fill(1), seed: 42 });
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };

function consistent(engine) {
  const { owners, players } = engine.state;
  for (const player of players) {
    assert.equal(player.territory, owners.filter(x => x === player.id).length);
    assert.ok(Number.isFinite(player.energy) && player.energy >= 0);
    if (player.alive) assert.equal(owners[player.base.y * engine.width + player.base.x], player.id);
  }
}

test('one active base, deterministic connected expansion and exact ownership counts', () => {
  const a = make(), b = make();
  assert.equal(a.getPlayer(1).alive, false);
  assert.equal(a.buildBase(20, 12, 'Тест').ok, true);
  b.buildBase(20, 12, 'Тест');
  assert.equal(a.getPlayer(1).territory, 9);
  assert.equal(a.buildBase(3, 3).ok, false);
  assert.equal(a.canBuild(1, 1), false);
  for (let i = 0; i < 240; i++) { a.tick(.25); b.tick(.25); }
  assert.deepEqual(a.state.owners, b.state.owners);
  assert.ok(a.getPlayer(1).territory > 9);
  consistent(a);
});

test('upgrades, tasks, credits and boosts consume the correct resources', () => {
  const engine = make(); engine.buildBase(20, 12);
  const player = engine.getPlayer(1), cost = engine.getUpgradeCost();
  assert.equal(engine.upgrade().ok, false);
  player.energy = cost;
  assert.equal(engine.upgrade().ok, true);
  assert.equal(player.energy, 0);
  assert.equal(player.level, 2);
  const credits = player.credits;
  assert.equal(engine.claimQuest('level2').ok, true);
  assert.equal(player.credits, credits + 30);
  assert.equal(engine.claimQuest('level2').ok, false);
  const baseRate = engine.getExpansionRate();
  assert.equal(engine.activateBoost().ok, true);
  assert.ok(engine.getExpansionRate() > baseRate);
  assert.equal(engine.activateBoost().ok, false);
  assert.equal(player.credits, credits + 10);
});

test('pause, speed, capped tab suspension and reset preserve lifecycle', () => {
  const engine = make(); engine.buildBase(20, 12);
  engine.togglePause(); engine.tick(20); assert.equal(engine.state.elapsed, 0);
  engine.togglePause(); engine.setSpeed(8); engine.tick(100);
  assert.ok(Math.abs(engine.state.elapsed - 16) < 1e-6);
  engine.setSpeed(123); assert.equal(engine.state.speed, 1);
  engine.reset();
  assert.equal(engine.state.started, false);
  assert.equal(engine.getPlayer(1).territory, 0);
  assert.equal(engine.state.owners.filter(x => x > 0).length, 0);
});

test('saved games roundtrip and invalid ownership cannot replace live state', () => {
  const engine = make(); engine.buildBase(20, 12, 'Империя');
  for (let i = 0; i < 80; i++) engine.tick(.5);
  engine.save();
  const restored = make(); assert.equal(restored.load(), true);
  assert.deepEqual(restored.state.owners, engine.state.owners);
  assert.equal(restored.getPlayer(1).name, 'Империя');
  consistent(restored);
  const [key, value] = [...memory][0], bad = JSON.parse(value);
  bad.state.owners[0] = 99999;
  memory.set(key, JSON.stringify(bad));
  const untouched = make(); assert.equal(untouched.load(), false);
  assert.equal(untouched.state.started, false);
  memory.clear();
});

test('sea expeditions unlock islands after level 2 without stealing nonadjacent territory', () => {
  const land = Array(20 * 10).fill(0);
  for (const [x, y] of [[2, 2], [2, 3], [3, 2], [3, 3], [14, 2], [14, 3], [15, 2], [15, 3]]) land[y * 20 + x] = 1;
  const engine = new GameEngine({ width: 20, height: 10, land });
  engine.buildBase(2, 2); assert.equal(engine.getPlayer(1).territory, 4);
  for (let i = 0; i < 10; i++) engine.tick(1);
  assert.equal(engine.getPlayer(1).territory, 4);
  assert.equal(engine.upgrade().ok, true);
  for (let i = 0; i < 30; i++) engine.tick(1);
  assert.equal(engine.getPlayer(1).territory, 8);
  consistent(engine);
});

test('frontier contact produces real battles while neutral land remains', async () => {
  const map = JSON.parse(await readFile(new URL('../data/world-mask.json', import.meta.url), 'utf8'));
  const city = map.cities.find(city => city.name === 'Ташкент');
  const engine = new GameEngine(map); engine.buildBase(city.x, city.y);
  for (let i = 0; i < 600; i++) {
    engine.tick(.5);
    if (engine.getPlayer(1).energy >= engine.getUpgradeCost()) engine.upgrade();
  }
  assert.ok(engine.state.owners.includes(0), 'Neutral territory still exists');
  assert.ok(engine.state.contactedRivals.length > 0, 'Nearby rivals have met');
  assert.ok(engine.state.stats.battlesWon > 0, 'Expansion cannot suppress all frontier wars');
  consistent(engine);
});
