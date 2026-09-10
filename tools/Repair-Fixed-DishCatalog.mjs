// Non-destructive one-time repair. Dry-run is the default; --apply only inserts
// sourced missing records after a SQLite backup. No API, .env or reseeding.
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { loadMenuSourceRules } from "../app/server/menu-source-rules.mjs";
import { planFixedDishCatalogRepair } from "../app/server/fixed-dish-catalog-repair.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--apply", "--dry-run"].includes(arg)) || args.includes("--apply") && args.includes("--dry-run"))
  throw new Error("用法：node tools/Repair-Fixed-DishCatalog.mjs [--dry-run | --apply]");
const apply = args.includes("--apply");
const root = resolve(import.meta.dirname, "..");
const dbFile = resolve(root, "app/data/dining.sqlite");
const sourceFile = resolve(root, "餐厅排菜规则+示例.xlsx");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readDishes = (db) => db.prepare("SELECT data FROM dishes ORDER BY rowid").all().map((row) => JSON.parse(row.data));
let db;
try {
  const loaded = await loadMenuSourceRules(root);
  db = new DatabaseSync(dbFile, { readOnly: true });
  let proposal = planFixedDishCatalogRepair(readDishes(db), loaded.fixedDishes);
  if (!apply || !proposal.additions.length) {
    console.log(JSON.stringify({ mode: apply ? "unchanged" : "dry-run", added: 0, proposed: proposal.additions.length,
      names: proposal.additions.map((dish) => dish.name), existingMatches: proposal.existing.length,
      inactiveMatches: proposal.existing.filter((dish) => !dish.active).length, backup: null }));
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = resolve(root, `app/data/backups/dining-before-fixed-catalog-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
    await mkdir(resolve(root, "app/data/backups"), { recursive: true });
    await backup(db, backupPath);
    db.close();
    db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 5000");
    if (digest(await readFile(sourceFile)) !== proposal.sourceSha256) throw new Error("备份期间源规则文件已变化，未写入菜库");
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read under the transaction, so a concurrent operator insertion is
      // preserved and cannot be overwritten. Deliberately use INSERT, not UPSERT.
      proposal = planFixedDishCatalogRepair(readDishes(db), loaded.fixedDishes);
      const insertDish = db.prepare("INSERT INTO dishes (id, data) VALUES (?, ?)");
      for (const dish of proposal.additions) insertDish.run(dish.id, JSON.stringify(dish));
      if (proposal.additions.length) {
        const id = randomUUID();
        const audit = { id, at: new Date().toISOString(), kind: "menu.fixed_catalog_repaired", targetId: "宽窄巷子",
          sourceFile: loaded.source.file, sourceSha256: proposal.sourceSha256, backupPath,
          addedDishIds: proposal.additions.map((dish) => dish.id), addedNames: proposal.additions.map((dish) => dish.name),
          existingRecordsChanged: false, note: "仅补充源规则固定菜品；历史错配记录保留，食品标签仍待核验。" };
        db.prepare("INSERT INTO audit (id, data) VALUES (?, ?)").run(id, JSON.stringify(audit));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    console.log(JSON.stringify({ mode: "applied", added: proposal.additions.length, names: proposal.additions.map((dish) => dish.name),
      existingMatches: proposal.existing.length, backup: backupPath }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
