import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { COLLECTIONS, collectionName } from "./repository.mjs";

export const SCHEMA_VERSION = 2;
export function createSqliteAdapter(filename) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > SCHEMA_VERSION) throw new Error("数据库版本高于当前应用版本，请升级应用；原数据未修改");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // v2 adds the dedicated catalog-English cache. Existing rows are never
    // rewritten/reseeded; the transactional migration also works from v0.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const collection of COLLECTIONS)
        db.exec(`CREATE TABLE IF NOT EXISTS ${collection} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { db.close(); throw error; }
  return {
    all: (collection) => db.prepare(`SELECT data FROM ${collectionName(collection)} ORDER BY rowid`).all().map((row) => JSON.parse(row.data)),
    get: (collection, id) => {
      const row = db.prepare(`SELECT data FROM ${collectionName(collection)} WHERE id = ?`).get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put: (collection, id, value) => db.prepare(`INSERT INTO ${collectionName(collection)} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(value)),
    atomic: (action) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = action(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close: () => db.close(),
  };
}
