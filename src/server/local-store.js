// Node-only adapter. The Worker entry imports store.js, never this module.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateOperations, listLimit } from './store.js';

export async function createLocalStore(filePath) {
  if (filePath !== ':memory:') await mkdir(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    const migration = await readFile(new URL('../../drizzle/0000_world.sql', import.meta.url), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration);
      db.exec('PRAGMA user_version = 1; COMMIT;');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const read = db.prepare('SELECT json, revision FROM records WHERE key = ?');
  const write = db.prepare('INSERT INTO records(key, json, revision, updated) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, revision = records.revision + 1, updated = excluded.updated');
  return {
    async get(key) {
      const row = read.get(key);
      return row ? { value: JSON.parse(row.json), version: row.revision } : null;
    },
    async list(prefix, { limit = 10000 } = {}) {
      listLimit(limit);
      return db.prepare('SELECT key, json, revision FROM records WHERE key >= ? AND key < ? AND substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?')
        .all(prefix, `${prefix}\u{10ffff}`, prefix, prefix, limit)
        .map(row => ({ key: row.key, value: JSON.parse(row.json), version: row.revision }));
    },
    async atomic(input) {
      const { checks, puts, deletes } = validateOperations(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { key, version: expected } of checks) {
          if ((read.get(key)?.revision ?? null) !== expected) { db.exec('ROLLBACK'); return false; }
        }
        for (const { key, value } of puts) write.run(key, JSON.stringify(value), Date.now());
        for (const key of deletes) db.prepare('DELETE FROM records WHERE key = ?').run(key);
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); }
  };
}
