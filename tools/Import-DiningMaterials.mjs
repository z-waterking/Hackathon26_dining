// Explicit local import. Source workbooks are read-only; an existing database
// is backed up before adding missing catalog data and full sheet snapshots.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { DatabaseSync, backup } from "node:sqlite";
import { readMaterials } from "../app/server/importer.mjs";
import { createStore } from "../app/server/store.mjs";
import { COLLECTIONS } from "../app/server/data/repository.mjs";
import { importMaterials, planMaterialsImport } from "../app/server/materials-import.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.some(arg => !["--apply", "--dry-run", "--prepared"].includes(arg)) || args.includes("--apply") && args.includes("--dry-run"))
  throw new Error("Usage: node tools/Import-DiningMaterials.mjs [--dry-run | --apply] [--prepared]");
const apply = args.includes("--apply");
const env = resolve(root, "app/.env");
if (existsSync(env)) loadEnvFile(env);
const filename = resolve(root, "app", process.env.DINING_DB || "data/dining.sqlite");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const normal = value => String(value).replaceAll("\\", "/");
function withinRoot(file) {
  const path = resolve(root, file);
  const within = relative(root, path);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Source path must stay inside this project");
  return path;
}
const readJson = bytes => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
function readPort(db) {
  const check = name => { if (!COLLECTIONS.includes(name)) throw new Error("Unknown collection"); return name; };
  return { all: name => db.prepare("SELECT data FROM " + check(name) + " ORDER BY rowid").all().map(row => JSON.parse(row.data)),
    get: (name, id) => { const row = db.prepare("SELECT data FROM " + check(name) + " WHERE id=?").get(id); return row ? JSON.parse(row.data) : null; } };
}
const assertIdle = store => {
  if (["menuRuns", "aiUsage"].some(name => store.all(name).some(record => record.status === "running")))
    throw new Error("AI work is running. Complete it before importing source materials.");
};
let db;
let store;
try {
  if (!existsSync(filename)) throw new Error("Local database not found; run Start-Dining.ps1 first. No database was created.");
  if (!args.includes("--prepared")) {
    const result = spawnSync("pwsh", ["-NoProfile", "-File", resolve(root, "tools/Prepare-Materials.ps1"), "-Root", root], { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("Material preparation failed. Run tools/Prepare-Materials.ps1 to inspect the source files.");
  }
  const inspection = resolve(root, "materials/inspection");
  const inventoryBytes = await readFile(resolve(inspection, "inventory.json"));
  const inventory = readJson(inventoryBytes);
  if (!Array.isArray(inventory) || !inventory.length) throw new Error("No inspected worksheets found.");
  const files = [];
  const fileMap = new Map();
  const fileFingerprints = [];
  for (const file of [...new Set([...inventory.map(item => normal(item.Source)), "六周菜单.zip", "新六周菜单.zip"])].sort()) {
    const path = withinRoot(file);
    const bytes = await readFile(path);
    const item = { file, sha256: sha256(bytes), bytes: bytes.length };
    files.push(item); fileMap.set(file, item); fileFingerprints.push({ path, sha256: item.sha256 });
  }
  const snapshots = [];
  const snapshotFingerprints = [{ path: resolve(inspection, "inventory.json"), sha256: sha256(inventoryBytes) }];
  for (const item of inventory) {
    if (!/^book-\d+-sheet-\d+$/.test(item.Id)) throw new Error("Invalid inspection sheet ID");
    const file = normal(item.Source);
    const source = fileMap.get(file);
    if (item.SourceSha256 !== source.sha256 || item.SourceBytes !== source.bytes)
      throw new Error("Inspection is outdated; rerun the command without --prepared.");
    const path = resolve(inspection, item.Id + ".json");
    const bytes = await readFile(path);
    const data = readJson(bytes);
    if (normal(data.Source) !== file || data.Sheet !== item.Sheet || data.SourceSha256 !== source.sha256)
      throw new Error("Worksheet snapshot does not match its verified source");
    const fingerprint = sha256(bytes);
    snapshots.push({ id: "source-sheet:" + sha256(file + "\0" + item.Sheet + "\0" + source.sha256), file, fileSha256: source.sha256, sheet: item.Sheet, sha256: fingerprint, data });
    snapshotFingerprints.push({ path, sha256: fingerprint });
  }
  const bundle = { data: readMaterials(inspection), files, sheets: snapshots };
  db = new DatabaseSync(filename, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  const readStore = readPort(db);
  let report = planMaterialsImport(readStore, bundle);
  let backupFile = null;
  if (apply && report.changed) {
    assertIdle(readStore);
    const backupDir = resolve(root, "app/data/backups");
    await mkdir(backupDir, { recursive: true });
    backupFile = resolve(backupDir, "dining-before-materials-import-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite");
    await backup(db, backupFile);
    for (const item of [...fileFingerprints, ...snapshotFingerprints])
      if (sha256(await readFile(item.path)) !== item.sha256) throw new Error("Source data changed during import; database was not modified.");
    db.close(); db = null;
    store = createStore(filename);
    report = importMaterials(store, bundle);
  }
  console.log(JSON.stringify({ mode: apply ? report.changed ? "applied" : "unchanged" : "dry-run", database: filename,
    files: files.length, workbooks: files.filter(item => item.file.endsWith(".xlsx")).length, worksheets: snapshots.length,
    sourceDishes: bundle.data.dishes.length, sourceRecipes: bundle.data.recipes.length, formulaErrors: bundle.data.report.formulaErrors, ...report, backup: backupFile }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); store?.close(); }
