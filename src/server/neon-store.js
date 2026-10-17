import { Pool } from '@neondatabase/serverless';
import { validateOperations, listLimit } from './store.js';

function keyOf(key) {
  if (typeof key !== 'string' || !key.length || key.length > 512) throw new TypeError('Invalid document key');
  return key;
}

export async function createNeonStore(connectionString) {
  const pool = new Pool({ connectionString });

  // Initialize table and index
  const initClient = await pool.connect();
  try {
    await initClient.query(`
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY NOT NULL,
        json JSONB NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_updated_idx ON records (updated);
    `);
  } finally {
    initClient.release();
  }

  return {
    async get(key) {
      const res = await pool.query('SELECT json, revision FROM records WHERE key = $1', [keyOf(key)]);
      if (!res.rows.length) return null;
      const row = res.rows[0];
      return {
        value: typeof row.json === 'string' ? JSON.parse(row.json) : row.json,
        version: Number(row.revision),
      };
    },

    async list(prefix, { limit = 10000 } = {}) {
      if (typeof prefix !== 'string') throw new TypeError('Invalid prefix');
      listLimit(limit);
      const res = await pool.query(
        `SELECT key, json, revision FROM records 
         WHERE key >= $1 AND key < $2 AND substr(key, 1, length($3)) = $3 
         ORDER BY key LIMIT $4`,
        [prefix, `${prefix}\u{10ffff}`, prefix, limit]
      );
      return res.rows.map(row => ({
        key: row.key,
        value: typeof row.json === 'string' ? JSON.parse(row.json) : row.json,
        version: Number(row.revision),
      }));
    },

    async atomic(input) {
      const { checks, puts, deletes } = validateOperations(input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { key, version: expected } of checks) {
          const res = await client.query('SELECT revision FROM records WHERE key = $1 FOR UPDATE', [key]);
          const actual = res.rows.length ? Number(res.rows[0].revision) : null;
          if (actual !== expected) {
            await client.query('ROLLBACK');
            return false;
          }
        }
        const now = Date.now();
        for (const { key, value } of puts) {
          await client.query(
            `INSERT INTO records (key, json, revision, updated)
             VALUES ($1, $2, 1, $3)
             ON CONFLICT (key) DO UPDATE
             SET json = EXCLUDED.json, revision = records.revision + 1, updated = EXCLUDED.updated`,
            [key, JSON.stringify(value), now]
          );
        }
        for (const key of deletes) {
          await client.query('DELETE FROM records WHERE key = $1', [key]);
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
