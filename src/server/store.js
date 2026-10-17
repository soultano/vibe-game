// The world is stored as compact documents, never one database row per cell.
const copy = value => structuredClone(value);

function keyOf(key) {
  if (typeof key !== 'string' || !key.length || key.length > 512) throw new TypeError('Invalid document key');
  return key;
}

function operations({ checks = [], puts = [], deletes = [] } = {}) {
  const seen = new Set();
  for (const { key, version } of checks) {
    keyOf(key);
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new TypeError('Invalid revision');
  }
  for (const { key, value } of puts) {
    keyOf(key);
    if (seen.has(key)) throw new TypeError('Duplicate mutation');
    seen.add(key);
    if (JSON.stringify(value) === undefined) throw new TypeError('Value must be JSON');
  }
  for (const key of deletes) {
    keyOf(key);
    if (seen.has(key)) throw new TypeError('Duplicate mutation');
    seen.add(key);
  }
  return { checks, puts, deletes };
}

function listLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new TypeError('Invalid list limit');
  return limit;
}

export class MemoryStore {
  constructor() { this.records = new Map(); }
  async get(key) {
    const entry = this.records.get(keyOf(key));
    return entry ? copy(entry) : null;
  }
  async list(prefix, { limit = 10000 } = {}) {
    if (typeof prefix !== 'string') throw new TypeError('Invalid prefix');
    listLimit(limit);
    return [...this.records].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .slice(0, limit).map(([key, entry]) => ({ key, ...copy(entry) }));
  }
  async atomic(input) {
    const { checks, puts, deletes } = operations(input);
    for (const { key, version } of checks) {
      if ((this.records.get(key)?.version ?? null) !== version) return false;
    }
    // No await between the compare and all mutations: a single atomic JS turn.
    const prepared = puts.map(({ key, value }) => ({ key, value: copy(value), version: (this.records.get(key)?.version ?? 0) + 1 }));
    for (const { key, ...entry } of prepared) this.records.set(key, entry);
    for (const key of deletes) this.records.delete(key);
    return true;
  }
}

export class D1Store {
  constructor(db) {
    if (!db?.prepare || !db?.batch) throw new TypeError('A D1 database binding is required');
    this.db = db;
  }
  async get(key) {
    const row = await this.db.prepare('SELECT json, revision FROM records WHERE key = ?').bind(keyOf(key)).first();
    return row ? { value: JSON.parse(row.json), version: row.revision } : null;
  }
  async list(prefix, { limit = 10000 } = {}) {
    if (typeof prefix !== 'string') throw new TypeError('Invalid prefix');
    listLimit(limit);
    const result = await this.db.prepare('SELECT key, json, revision FROM records WHERE key >= ? AND key < ? AND substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?')
      .bind(prefix, `${prefix}\u{10ffff}`, prefix, prefix, limit).all();
    return (result.results ?? []).map(row => ({ key: row.key, value: JSON.parse(row.json), version: row.revision }));
  }
  async atomic(input) {
    const { checks, puts, deletes } = operations(input);
    const statements = [];
    for (const { key, version } of checks) {
      // A failed CHECK aborts D1.batch's complete transaction, including earlier statements.
      const sql = version === null
        ? 'INSERT INTO _atomic_guard(assertion) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM records WHERE key = ?) THEN 1 ELSE 0 END'
        : 'INSERT INTO _atomic_guard(assertion) SELECT CASE WHEN EXISTS (SELECT 1 FROM records WHERE key = ? AND revision = ?) THEN 1 ELSE 0 END';
      statements.push(this.db.prepare(sql).bind(...(version === null ? [key] : [key, version])));
    }
    const now = Date.now();
    for (const { key, value } of puts) statements.push(this.db.prepare('INSERT INTO records(key, json, revision, updated) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, revision = records.revision + 1, updated = excluded.updated').bind(key, JSON.stringify(value), now));
    for (const key of deletes) statements.push(this.db.prepare('DELETE FROM records WHERE key = ?').bind(key));
    if (!statements.length) return true;
    statements.push(this.db.prepare('DELETE FROM _atomic_guard'));
    try {
      await this.db.batch(statements);
      return true;
    } catch (error) {
      if (/CHECK constraint failed.*assertion|CHECK constraint failed.*_atomic_guard/i.test(String(error?.message))) return false;
      throw error;
    }
  }
}

export { operations as validateOperations, listLimit };
