// Explicit, resumable preparation of dish English names, never page-load work.
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DatabaseSync, backup } from "node:sqlite";
import { createStore } from "../app/server/store.mjs";
import { collectionName } from "../app/server/data/repository.mjs";
import { createAiClient } from "../app/server/ai.mjs";
import { englishNameSummary, prepareCatalogEnglish } from "../app/server/catalog-english.mjs";
import { cancellationError } from "../app/server/generation-tasks.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || new Set(args).size !== args.length || args.length > 1)
  throw new Error("Usage: node tools/Prepare-CatalogEnglish.mjs [--dry-run | --apply]");
if (existsSync(resolve(root, "app/.env"))) loadEnvFile(resolve(root, "app/.env"));
const filename = resolve(root, "app", process.env.DINING_DB || "data/dining.sqlite");
const within = relative(root, filename);
if (isAbsolute(within) || within.startsWith("..")) throw new Error("Database must be inside this project.");
const controller = new AbortController();
const cancel = () => controller.abort(cancellationError());
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let db;
let store;
try {
  if (!existsSync(filename)) throw new Error("Local database is missing; no database was created.");
  db = new DatabaseSync(filename, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name));
  const readStore = {
    all: table => { collectionName(table); return tables.has(table) ? db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.data)) : []; },
    get: (table, id) => { collectionName(table); const row = tables.has(table) ? db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) : null; return row ? JSON.parse(row.data) : null; },
  };
  const before = englishNameSummary(readStore);
  if (!args.includes("--apply")) console.log(JSON.stringify({ mode: "dry-run", ...before }));
  else if (!before.missing) console.log(JSON.stringify({ mode: "unchanged", ...before }));
  else {
    if (readStore.all("menuRuns").some(item => item.status === "running") ||
        readStore.all("aiUsage").some(item => item.status === "running" && item.role !== "dish_names"))
      throw new Error("AI work is running; finish or cancel it before starting offline name preparation.");
    // A killed dish-name process can leave its usage row running. The durable
    // expiring lease, not that historical row, determines whether it is live.
    const lease = readStore.get("meta", "catalog-english-lease");
    if (lease?.owner && lease.expiresAt > Date.now()) throw new Error("Dish-name preparation is already active.");
    const backupDir = resolve(root, "app/data/backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = resolve(backupDir, "before-catalog-english-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
    await backup(db, backupPath);
    store = createStore(filename);
    const ai = createAiClient(store);
    console.log(JSON.stringify({ mode: "preparing", ...before, backup: backupPath }));
    const result = await prepareCatalogEnglish(store, ai, { signal: controller.signal,
      onProgress: progress => console.log(JSON.stringify({ mode: "progress", ...progress })),
    });
    console.log(JSON.stringify({ mode: "complete", ...result, backup: backupPath }));
  }
} catch (error) {
  // No model output, input names, connection details or credentials in logs.
  console.error(JSON.stringify({ mode: error?.code === "GENERATION_CANCELLED" ? "cancelled" : "failed",
    code: error?.code === "GENERATION_CANCELLED" ? error.code : "CATALOG_ENGLISH_PREPARATION_FAILED",
    message: error?.code === "GENERATION_CANCELLED" ? "Stopped; completed batches remain in the database." : "Preparation did not finish. Completed batches are retained; inspect service configuration and retry explicitly." }));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  store?.close(); db?.close();
}
