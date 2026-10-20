import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk, gridRing, gridDistance } from 'h3-js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';
import { resolveCombat } from '../src/shared/combat.js';
import { handleAuth } from '../src/server/auth.js';

const BASE_A = latLngToCell(41.3111, 69.2797, 8);
const BASE_B = gridDisk(BASE_A, 5)[10];

async function setup() {
  let now = Date.UTC(2026, 9, 17, 12);
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

test('customization updates color and social links with validation', async () => {
  const { game, account } = await setup();
  await account('user1');
  await game.placeBase('user1', { cell: BASE_A, faction: 'protocol' });

  // Invalid hex color should be rejected
  await assert.rejects(
    () => game.updateCustomization('user1', { color: 'invalid-color' }),
    /Некорректный цвет/
  );

  // Valid customization
  const result = await game.updateCustomization('user1', {
    color: '#00d4ff',
    customLink: 'https://t.me/mychannel',
    customLinkTitle: 'My Telegram Channel'
  });

  assert.equal(result.player.color, '#00d4ff');
  assert.equal(result.player.customLink, 'https://t.me/mychannel');
  assert.equal(result.player.customLinkTitle, 'My Telegram Channel');

  // Verify state
  const state = await game.state('user1');
  assert.equal(state.player.color, '#00d4ff');
  assert.equal(state.player.customLink, 'https://t.me/mychannel');
  assert.equal(state.player.customLinkTitle, 'My Telegram Channel');
});

test('referral accumulates reserve energy in referrer battery and allows claiming', async () => {
  const { game, account } = await setup();
  await account('ref_leader');
  await account('ref_recruit');

  // Referrer places base
  const leaderBase = await game.placeBase('ref_leader', { cell: BASE_A, faction: 'protocol' });
  assert.equal(leaderBase.player.referralsCount, 0);
  assert.equal(leaderBase.player.reserveEnergy, 0);
  const initialEnergy = leaderBase.player.energy;

  // Recruit places base specifying referrer
  await game.placeBase('ref_recruit', {
    cell: BASE_B,
    faction: 'swarm',
    referrer: 'ref_leader'
  });

  // Check referrer got +1 friend and +200 reserve energy
  const leaderState = await game.state('ref_leader');
  assert.equal(leaderState.player.referralsCount, 1);
  assert.equal(leaderState.player.reserveEnergy, 200);
  assert.equal(leaderState.player.claimedReserveEnergy, 0);

  // Leader claims reserve energy
  const claimRes = await game.claimReferralEnergy('ref_leader');
  assert.equal(claimRes.player.reserveEnergy, 0);
  assert.equal(claimRes.player.claimedReserveEnergy, 200);
  assert.equal(claimRes.player.energy, initialEnergy + 200);

  // Claiming again with 0 reserve throws
  await assert.rejects(
    () => game.claimReferralEnergy('ref_leader'),
    /нет накопленной запасной энергии/
  );
});

test('combat cell conquest increments battlesWon and awards +25 plunder energy', async () => {
  const START = 1_700_000_000_000, HOUR = 3_600_000;
  const origin = latLngToCell(41.3111, 69.2797, 8);
  const ring = gridRing(origin, 4);
  const bases = [origin, ring[0]];
  const ids = ['alpha', 'bravo'];
  const owner = new Map(), born = new Map();

  for (const cell of gridDisk(origin, 7)) {
    const id = ids.map((id, i) => ({ id, distance: gridDistance(bases[i], cell) }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0].id;
    owner.set(cell, id);
    born.set(cell, START);
  }

  const players = [
    {
      id: 'alpha',
      baseCell: bases[0],
      pixels: [...owner.values()].filter(v => v === 'alpha').length,
      faction: 'protocol',
      level: 9,
      energy: 100,
      battlesWon: 0,
      terrainAverage: 1.05,
      createdAt: START,
      tLast: START,
      energyTLast: START,
      levelTimeline: [{ at: START, level: 9 }],
      shieldUntil: 0
    },
    {
      id: 'bravo',
      baseCell: bases[1],
      pixels: [...owner.values()].filter(v => v === 'bravo').length,
      faction: 'bloom',
      level: 2,
      energy: 100,
      battlesWon: 0,
      terrainAverage: 1.05,
      createdAt: START,
      tLast: START,
      energyTLast: START,
      levelTimeline: [{ at: START, level: 2 }],
      shieldUntil: 0
    }
  ];

  const initialPlayers = new Map(players.map(p => [p.id, structuredClone(p)]));
  const neighbors = new Map();
  const adjacent = (cell) => {
    if (!neighbors.has(cell)) neighbors.set(cell, gridDisk(cell, 1));
    return neighbors.get(cell);
  };

  // Run 6 hours of simulation
  await resolveCombat({
    players,
    now: START + 6 * HOUR,
    initialPlayers,
    readOwner: async (cell) => owner.get(cell) ?? null,
    readClaimedAt: async (cell) => born.get(cell),
    transfer: async (cell, from, to, at) => {
      owner.set(cell, to);
      born.set(cell, at);
    },
    contacts: async () => {
      const contacts = [], seen = new Set();
      for (const [cell, aId] of owner) for (const neighbor of adjacent(cell)) {
        const bId = owner.get(neighbor);
        if (!bId || aId === bId) continue;
        const key = [cell, neighbor].sort().join(':');
        if (!seen.has(key)) { seen.add(key); contacts.push({ aId, bId, aCell: cell, bCell: neighbor }); }
      }
      return contacts;
    },
    terrainAt: () => ({ multiplier: 1.05 })
  });

  const alpha = players.find(p => p.id === 'alpha');
  assert.ok(alpha.battlesWon > 0, `alpha battlesWon must be > 0 (got ${alpha.battlesWon})`);
  assert.ok(alpha.energy >= 100 + alpha.battlesWon * 25, 'alpha energy must include +25 plunder bounty per win');
});

test('credentials registration and login create isolated accounts and verify passwords securely', async () => {
  const store = new MemoryStore();
  const env = { LOCAL_DEV: 'true' };
  const origin = 'http://127.0.0.1:9999';

  // 1. Get challenge
  const challengeRes = await handleAuth(new Request(`${origin}/api/auth/me`), env, store);
  const challengeData = await challengeRes.json();
  const cookie = challengeRes.headers.getSetCookie().find(c => c.startsWith('pd_login=') || c.startsWith('__Host-pd_login='))?.split(';')[0];
  const csrf = challengeData.csrfToken;

  // 2. Register
  const regRes = await handleAuth(new Request(`${origin}/api/auth/credentials/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify({
      username: 'TestCommander',
      password: 'mypassword123',
      fingerprint: 'device-test-123'
    })
  }), env, store);

  assert.equal(regRes.status, 200);
  const regData = await regRes.json();
  assert.equal(regData.account.name, 'TestCommander');
  assert.equal(regData.account.provider, 'credentials');
  assert.ok(regData.sessionToken);

  // 3. Duplicate registration rejected
  const dupRes = await handleAuth(new Request(`${origin}/api/auth/credentials/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify({
      username: 'testcommander',
      password: 'differentpass',
      fingerprint: 'device-test-456'
    })
  }), env, store);
  assert.equal(dupRes.status, 409);

  // 4. Login with wrong password rejected
  const wrongPassRes = await handleAuth(new Request(`${origin}/api/auth/credentials/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify({
      username: 'TestCommander',
      password: 'wrongpassword',
      fingerprint: 'device-test-123'
    })
  }), env, store);
  assert.equal(wrongPassRes.status, 401);

  // 5. Login with correct password succeeds
  const loginRes = await handleAuth(new Request(`${origin}/api/auth/credentials/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie,
      'x-csrf-token': csrf
    },
    body: JSON.stringify({
      username: 'TestCommander',
      password: 'mypassword123',
      fingerprint: 'device-test-123'
    })
  }), env, store);
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.account.name, 'TestCommander');
  assert.ok(loginData.sessionToken);
});
