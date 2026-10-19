import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeonStore } from '../src/server/neon-store.js';

// Transaction transport adapter: exercises overlapping callers, ordered locks,
// batched writes and rollback without connecting to the production database.
class PoolAdapter {
  records = new Map(); locks = new Map(); queries = []; released = 0; failCode = null;
  async query(sql, values) {
    this.queries.push(sql.trim());
    if (sql.includes('CREATE TABLE')) return { rows: [] };
    if (sql.includes('WHERE key = $1')) return { rows: this.records.has(values[0]) ? [this.records.get(values[0])] : [] };
    if (sql.includes('starts_with')) return { rows: [...this.records.values()].filter(row => row.key.startsWith(values[0])).sort((a, b) => a.key.localeCompare(b.key)).slice(0, values[3]) };
    throw new Error('Unexpected pool query: ' + sql);
  }
  async connect() {
    const owner = this, pending = new Map(), unlock = [];
    return {
      async query(sql, values) {
        owner.queries.push(sql.trim());
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          assert.deepEqual(values[0], [...new Set(values[0])].sort(), 'all keys must be locked in canonical order');
          for (const key of values[0]) {
            const prior = owner.locks.get(key) || Promise.resolve();
            let release; const current = new Promise(resolve => { release = resolve; });
            const tail = prior.then(() => current);
            owner.locks.set(key, tail);
            await prior;
            unlock.push(release);
          }
          return { rows: [] };
        }
        if (sql.includes('FOR UPDATE')) return { rows: values[0].filter(key => owner.records.has(key)).map(key => owner.records.get(key)) };
        if (sql.includes('jsonb_array_elements')) {
          if (owner.failCode) { const code = owner.failCode; owner.failCode = null; throw Object.assign(new Error('synthetic database error'), { code }); }
          for (const { key, value } of JSON.parse(values[0])) pending.set(key, { key, json: value, revision: String(Number(owner.records.get(key)?.revision || 0) + 1) });
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM records')) { values[0].forEach(key => pending.set(key, null)); return { rows: [] }; }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql === 'COMMIT') for (const [key, row] of pending) row ? owner.records.set(key, row) : owner.records.delete(key);
          pending.clear(); unlock.splice(0).forEach(release => release());
          return { rows: [] };
        }
        throw new Error('Unexpected client query: ' + sql);
      },
      release() { owner.released++; },
    };
  }
  async end() {}
}

test('Neon absent-row CAS has exactly one winner across overlapping transactions', async () => {
  const pool = new PoolAdapter(), store = await createNeonStore('', { pool });
  const mutation = { checks: [{ key: 'identity:telegram:1', version: null }], puts: [{ key: 'identity:telegram:1', value: { accountId: 'winner' } }] };
  const result = await Promise.all(Array.from({ length: 8 }, () => store.atomic(mutation)));
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal((await store.get('identity:telegram:1')).version, 1);
  assert.equal(pool.released, 8);
});

test('Neon checks, creates and deletes a whole document batch in a fixed number of round trips', async () => {
  const pool = new PoolAdapter(), store = await createNeonStore('', { pool });
  const puts = Array.from({ length: 100 }, (_, i) => ({ key: 'tile:' + i, value: { id: i } }));
  const before = pool.queries.length;
  assert.equal(await store.atomic({ checks: puts.map(({ key }) => ({ key, version: null })), puts }), true);
  assert.equal(pool.queries.length - before, 5, '100 documents take five round trips, not 200+');
  assert.equal((await store.list('tile:', { limit: 4 })).length, 4);
  assert.equal(await store.atomic({ checks: [{ key: 'tile:1', version: 9 }], deletes: ['tile:1'] }), false);
  assert.equal(await store.atomic({ checks: [{ key: 'tile:1', version: 1 }], deletes: ['tile:1'] }), true);
  assert.equal(await store.get('tile:1'), null);
  assert.equal((await store.get('tile:2')).value.id, 2);
});

test('Neon rolls back retryable database errors and returns clients to the pool', async () => {
  const pool = new PoolAdapter(), store = await createNeonStore('', { pool });
  for (const code of ['40001', '40P01']) {
    pool.failCode = code;
    assert.equal(await store.atomic({ puts: [{ key: 'proof', value: { used: true } }] }), false);
    assert.equal(await store.get('proof'), null);
  }
  pool.failCode = '08006';
  await assert.rejects(() => store.atomic({ puts: [{ key: 'proof', value: { used: true } }] }), error => error.code === '08006');
  assert.equal(pool.released, 3);
  assert.equal(await store.atomic({ checks: [{ key: 'proof', version: null }], puts: [{ key: 'proof', value: { used: true } }] }), true);
});

test('Neon preserves JSON scalar values and validates input before opening a transaction', async () => {
  const pool = new PoolAdapter(), store = await createNeonStore('', { pool });
  await store.atomic({ puts: [{ key: 'scalar', value: 'a JSON string, not serialized JSON' }] });
  assert.equal((await store.get('scalar')).value, 'a JSON string, not serialized JSON');
  const count = pool.queries.length;
  await assert.rejects(() => store.atomic({ checks: [{ key: 'scalar', version: 0 }] }), TypeError);
  assert.equal(await store.atomic({}), true);
  assert.equal(pool.queries.length, count);
});
