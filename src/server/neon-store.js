import { Pool } from '@neondatabase/serverless';
import { validateOperations, listLimit } from './store.js';

function keyOf(key) {
  if (typeof key !== 'string' || !key.length || key.length > 512) throw new TypeError('Invalid document key');
  return key;
}

export async function createNeonStore(connectionString, { pool = new Pool({ connectionString }) } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      key TEXT PRIMARY KEY NOT NULL,
      json JSONB NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_updated_idx ON records (updated);
  `);

  return {
    async get(key) {
      const { rows } = await pool.query('SELECT json, revision FROM records WHERE key = $1', [keyOf(key)]);
      if (!rows.length) return null;
      return { value: rows[0].json, version: Number(rows[0].revision) };
    },

    async list(prefix, { limit = 10000 } = {}) {
      if (typeof prefix !== 'string') throw new TypeError('Invalid prefix');
      listLimit(limit);
      const { rows } = await pool.query(
        `SELECT key, json, revision FROM records
         WHERE key >= $1 AND key < $2 AND starts_with(key, $3)
         ORDER BY key LIMIT $4`,
        [prefix, `${prefix}\u{10ffff}`, prefix, limit],
      );
      return rows.map(row => ({ key: row.key, value: row.json, version: Number(row.revision) }));
    },

    async atomic(input) {
      const { checks, puts, deletes } = validateOperations(input);
      const keys = [...new Set([...checks.map(check => check.key), ...puts.map(put => put.key), ...deletes])].sort();
      if (!keys.length) return true;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Row locks do not protect a missing row. Lock the complete, ordered
        // key set first so two cold instances cannot both create an identity,
        // consume one Telegram proof, or claim the same previously empty tile.
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended(key, 0))
          FROM (SELECT unnest($1::text[]) AS key ORDER BY key) AS ordered_keys
        `, [keys]);
        if (checks.length) {
          const { rows } = await client.query('SELECT key, revision FROM records WHERE key = ANY($1::text[]) FOR UPDATE', [checks.map(check => check.key)]);
          const revisions = new Map(rows.map(row => [row.key, Number(row.revision)]));
          if (checks.some(({ key, version }) => (revisions.get(key) ?? null) !== version)) {
            await client.query('ROLLBACK');
            return false;
          }
        }
        // One round trip for all writes rather than one per world document.
        if (puts.length) await client.query(`
          INSERT INTO records (key, json, revision, updated)
          SELECT entry->>'key', entry->'value', 1, $2
          FROM jsonb_array_elements($1::jsonb) AS entries(entry)
          ON CONFLICT (key) DO UPDATE
          SET json = EXCLUDED.json, revision = records.revision + 1, updated = EXCLUDED.updated
        `, [JSON.stringify(puts), Date.now()]);
        if (deletes.length) await client.query('DELETE FROM records WHERE key = ANY($1::text[])', [deletes]);
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        if (['40001', '40P01'].includes(error.code)) return false;
        throw error;
      } finally {
        client.release();
      }
    },

    async close() { await pool.end(); },
  };
}
