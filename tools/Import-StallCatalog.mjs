// Explicit offline ingestion: preview by default, backup + atomic write only
// with --apply. Runtime services never invoke this script or open this XLSX.
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { createStore } from "../app/server/store.mjs";
import { loadStallCatalog, CATALOG_FILE } from "../app/server/stall-catalog.mjs";
import { planStallCatalogImport, importStallCatalog } from "../app/server/stall-catalog-import.mjs";
import { readStallCatalog } from "../app/server/stored-stall-catalog.mjs";
import { COLLECTIONS } from "../app/server/data/repository.mjs";

const args = process.argv.slice(2);
if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || args.includes("--apply") && args.includes("--dry-run"))
  throw new Error("用法：node tools/Import-StallCatalog.mjs [--dry-run | --apply]");
const apply = args.includes("--apply");
const root = resolve(import.meta.dirname, "..");
const filename = resolve(root, "app/data/dining.sqlite");
let db;
let store;
const digest = value => createHash("sha256").update(value).digest("hex");
try {
  if (!existsSync(filename)) throw new Error("本地数据库不存在，请先初始化项目数据库；本工具不会静默新建或覆盖已有库");
  const loaded = await loadStallCatalog(root);
  db = new DatabaseSync(filename, { readOnly: true });
  const readStore = {
    all(name) { if (!COLLECTIONS.includes(name)) throw new Error("无效集合"); return db.prepare("SELECT data FROM " + name + " ORDER BY rowid").all().map(row => JSON.parse(row.data)); },
    get(name, id) { if (!COLLECTIONS.includes(name)) throw new Error("无效集合"); const row = db.prepare("SELECT data FROM " + name + " WHERE id=?").get(id); return row ? JSON.parse(row.data) : null; },
  };
  let report = planStallCatalogImport(readStore, loaded);
  let backupFile = null;
  if (apply && report.changed) {
    if (readStore.all("menuRuns").some(run => run.status === "running")) throw new Error("有菜单正在生成，请完成后再导入");
    backupFile = resolve(root, "app/data/backups/dining-before-stall-import-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
    await mkdir(resolve(root, "app/data/backups"), { recursive: true });
    await backup(db, backupFile);
    db.close(); db = null;
    if (digest(await readFile(resolve(root, CATALOG_FILE))) !== loaded.source.sha256) throw new Error("原Excel在备份期间变更，未写入数据库");
    store = createStore(filename);
    report = importStallCatalog(store, loaded);
  }
  const catalog = apply ? readStallCatalog(store || readStore) : report.catalog;
  console.log(JSON.stringify({ mode: apply ? report.changed ? "applied" : "unchanged" : "dry-run", sourceFile: CATALOG_FILE,
    sha256: loaded.source.sha256, inserted: report.inserted, reused: report.reused, sourcesUpdated: report.sourcesUpdated,
    stats: report.stats, backup: backupFile, storageMode: catalog.storageMode,
    groups: catalog.groups.map(group => ({ stall: group.stall, origin: group.origin, candidates: group.candidateIds.length, unresolved: group.unresolved.length })) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); store?.close(); }
