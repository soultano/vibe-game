import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameEngine } from '../src/client/practice-engine.js';

const map = JSON.parse(readFileSync(new URL('../data/world-mask.json', import.meta.url), 'utf8'));
const create = seed => new GameEngine({ ...map, seed });
const city = name => map.cities.find(c => c.name === name);

function verifyWorld(engine) {
  const counts = new Map();
  for (let index = 0; index < map.land.length; index++) {
    const owner = engine.state.owners[index];
    if (map.land[index]) {
      assert.ok(owner >= 0, `Land became water at ${index}`);
      if (owner > 0) counts.set(owner, (counts.get(owner) || 0) + 1);
    } else assert.equal(owner, -1, `Water became occupied at ${index}`);
  }
  assert.equal(engine.state.totalLand, 15496);
  assert.equal(engine.state.players.filter(p => p.isHuman).length, 1);
  for (const player of engine.state.players) {
    assert.equal(player.territory, counts.get(player.id) || 0, `Territory count drifted for ${player.id}`);
    assert.equal(player.alive, player.territory > 0);
    assert.ok(Number.isFinite(player.energy) && player.energy >= 0);
    assert.ok(Number.isFinite(player.credits) && player.credits >= 0);
    if (player.alive) assert.equal(engine.getCell(player.base.x, player.base.y).owner, player.id);
  }
}

function advance(engine, seconds) {
  for (let second = 0; second < seconds; second++) {
    const human = engine.getPlayer(1);
    if (human.alive && human.level < 5 && human.energy >= engine.getUpgradeCost(human)) engine.upgrade();
    engine.tick(1);
    if (second % 120 === 0) verifyWorld(engine);
  }
  verifyWorld(engine);
}

test('Every real city offers a valid single-base start and growing finite economy', () => {
  assert.equal(map.width, 360);
  assert.equal(map.height, 180);
  assert.equal(map.cities.length, 16);
  for (const [index, location] of map.cities.entries()) {
    const engine = create(index + 42);
    assert.equal(engine.getCell(location.x, location.y).land, true, location.name);
    assert.equal(engine.buildBase(location.x, location.y, location.name, 'tech').ok, true, location.name);
    const startTerritory = engine.getPlayer(1).territory;
    assert.ok(startTerritory >= 1 && startTerritory <= 9, location.name);
    assert.equal(engine.buildBase(location.x + 1, location.y, 'Second base').ok, false);
    advance(engine, 120);
    assert.ok(engine.getPlayer(1).territory > startTerritory, `${location.name}: territory did not expand`);
    assert.ok(engine.getPlayer(1).level >= 2, `${location.name}: economy did not fund an upgrade`);
  }
});

test('Map water and coordinates beyond the map cannot host a base', () => {
  const engine = create(42);
  const sea = map.land.findIndex(value => value === 0);
  assert.equal(engine.buildBase(sea % map.width, Math.floor(sea / map.width)).ok, false);
  for (const [x, y] of [[-1, 20], [360, 20], [20, -1], [20, 180], [NaN, 0], [Infinity, 0]]) {
    assert.equal(engine.buildBase(x, y).ok, false);
  }
  assert.equal(engine.state.started, false);
  assert.equal(engine.getPlayer(1).territory, 0);
});

test('Thirty simulated minutes preserve geography and territory ownership from distant starts', () => {
  for (const [index, name] of ['Ташкент', 'Нью-Йорк', 'Сидней'].entries()) {
    const engine = create(index + 51), location = city(name);
    engine.buildBase(location.x, location.y, name);
    advance(engine, 1800);
    assert.equal(engine.state.elapsed, 1800);
    assert.ok(engine.state.players.length > 2);
    assert.ok(engine.state.stats.captured > 0);
  }
});

test('Maritime expansion lets upgraded island bases progress beyond their home island', () => {
  for (const [name, homeIslandSize] of [['Лондон', 32], ['Токио', 33]]) {
    const engine = create(42), location = city(name);
    engine.buildBase(location.x, location.y, name);
    advance(engine, 600);
    assert.ok(engine.getPlayer(1).alive, `${name}: base was eliminated before expansion`);
    assert.ok(engine.getPlayer(1).territory > homeIslandSize, `${name}: trapped on ${homeIslandSize}-cell island`);
  }
});
