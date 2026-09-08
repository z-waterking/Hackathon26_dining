import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createStore(filename, seed) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  const tables = [
    "feedback", "dishes", "plans", "transactions", "meta",
    "actions", "settings", "menuRuns", "imports", "aiUsage", "audit",
  ];
  for (const table of tables)
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    );
  function tableName(table) {
    if (!tables.includes(table)) throw new Error("Unknown table");
    return table;
  }
  const store = {
    all: (table) =>
      database
        .prepare(`SELECT data FROM ${tableName(table)} ORDER BY rowid`)
        .all()
        .map((row) => JSON.parse(row.data)),
    get: (table, id) => {
      const row = database
        .prepare(`SELECT data FROM ${tableName(table)} WHERE id = ?`)
        .get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put: (table, id, value) =>
      database
        .prepare(
          `INSERT INTO ${tableName(table)} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        )
        .run(id, JSON.stringify(value)),
    atomic: (action) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
  if (!store.get("meta", "initialized")) {
    const data = seed();
    store.atomic(() => {
      for (const table of ["feedback", "dishes"])
        for (const item of data[table]) store.put(table, item.id, item);
      for (const field of ["recipes", "rules", "inventory", "report"])
        store.put("meta", field, data[field]);
      store.put("meta", "initialized", {
        at: new Date().toISOString(),
        version: 1,
      });
    });
  }
  return store;
}
