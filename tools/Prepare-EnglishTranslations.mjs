// Prepare English display artifacts explicitly; browsing never starts AI work.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DatabaseSync, backup } from "node:sqlite";
import { createStore } from "../app/server/store.mjs";
import { COLLECTIONS, collectionName } from "../app/server/data/repository.mjs";
import { createAiClient } from "../app/server/ai.mjs";
import { collectTranslationSources } from "../app/server/translation-sources.mjs";
import { cachedTranslationView, prewarmUiTranslations } from "../app/server/ui-translations.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || args.includes("--apply") && args.includes("--dry-run"))
  throw new Error("Usage: node tools/Prepare-EnglishTranslations.mjs [--dry-run | --apply]");
const apply = args.includes("--apply");
if (existsSync(resolve(root, "app/.env"))) loadEnvFile(resolve(root, "app/.env"));
const filename = resolve(root, "app", process.env.DINING_DB || "data/dining.sqlite");
const readPort = db => ({
  all: name => db.prepare("SELECT data FROM " + collectionName(name) + " ORDER BY rowid").all().map(row => JSON.parse(row.data)),
  get: (name, id) => { const row = db.prepare("SELECT data FROM " + collectionName(name) + " WHERE id=?").get(id); return row ? JSON.parse(row.data) : null; },
});
const businessFingerprint = db => {
  const hash = createHash("sha256");
  for (const name of COLLECTIONS.filter(name => name !== "aiUsage")) {
    hash.update(name);
    for (const row of db.prepare("SELECT id,data FROM " + collectionName(name) + " ORDER BY id").iterate())
      if (name !== "meta" || !row.id.startsWith("ui-translation:")) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
};
let db;
let store;
try {
  if (!existsSync(filename)) throw new Error("Local database does not exist; no database was created.");
  db = new DatabaseSync(filename, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  const readStore = readPort(db);
  const texts = collectTranslationSources(readStore, { root });
  const view = cachedTranslationView(readStore, texts);
  const report = { database: filename, total: view.total, ready: view.ready, missing: view.missing, characters: texts.reduce((sum, text) => sum + text.length, 0) };
  if (!apply || !view.missing) console.log(JSON.stringify({ mode: apply ? "unchanged" : "dry-run", ...report }));
  else {
    const activeMenuRuns = readStore.all("menuRuns").filter(item => item.status === "running").length;
    if (activeMenuRuns || readStore.all("aiUsage").some(item => item.status === "running"))
      throw new Error("AI work is running; wait for completion before preparing English translations.");
    const before = businessFingerprint(db);
    const backupDir = resolve(root, "app/data/backups");
    await mkdir(backupDir, { recursive: true });
    const backupFile = resolve(backupDir, "dining-before-english-preparation-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
    await backup(db, backupFile);
    store = createStore(filename);
    // Only cache artifacts and their AI usage may be written. If the user starts
    // a business operation later, concurrent changes are reported, never reverted.
    const translationStore = { ...store, put(collection, id, record) {
      if (collection !== "aiUsage" && !(collection === "meta" && id.startsWith("ui-translation:")))
        throw new Error("English preparation may only save translation cache and AI usage.");
      return store.put(collection, id, record);
    } };
    const ai = createAiClient(translationStore);
    if (!ai.status().configured) throw new Error("The configured AI service is unavailable; no translations were generated.");
    console.log(JSON.stringify({ mode: "preparing", ...report, activeMenuRuns, backup: backupFile }));
    const result = await prewarmUiTranslations(translationStore, ai, texts, { onProgress: progress => console.log(JSON.stringify(progress)) });
    console.log(JSON.stringify({ mode: "applied", ...result, businessWritesByPreparation: 0, businessSnapshotUnchanged: before === businessFingerprint(db), backup: backupFile }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store?.close(); db?.close(); }
