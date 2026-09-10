// Explicit, offline source ingestion. This service performs no file or AI I/O.
// Existing operational records and source-rule/candidate snapshots are retained.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { audit } from "./settings.mjs";

export const MATERIALS_IMPORT_KEY = "source-materials-import";
const VERSION = "materials-import-v1";
const hash = value => createHash("sha256").update(value).digest("hex");
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nameKey = value => value.replace(/\s/g, "");
const identity = dish => JSON.stringify([dish.stall, nameKey(dish.name), dish.price, dish.unit]);
const stableJson = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = message => { throw new Error(message); };
function pathKey(value) {
  if (typeof value !== "string" || !value || [...value].some(character => character.charCodeAt(0) < 32)) fail("资料来源路径无效，未导入");
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some(part => !part || part === "." || part === ".."))
    fail("资料来源必须是项目内相对路径，未导入");
  return path;
}
function sheetName(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("资料工作表名称无效，未导入");
  return value;
}
const sheetKey = (file, sheet) => JSON.stringify([pathKey(file), sheetName(sheet)]);
function uniqueRecords(records, key, label) {
  const found = new Map();
  for (const record of records) {
    const id = key(record);
    if (found.has(id) && !isDeepStrictEqual(found.get(id), record)) fail(label + " ID 冲突，未导入");
    found.set(id, record);
  }
  return [...found.values()];
}
function validateBundle({ data, files, sheets } = {}) {
  if (!object(data) || ![data.dishes, data.recipes, data.inventory, files, sheets].every(Array.isArray) || !files.length || !sheets.length)
    fail("资料导入结果不完整，未导入");
  const incomingFiles = uniqueRecords(files.map(file => {
    if (!object(file) || !sha256(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) fail("资料文件摘要无效，未导入");
    return { file: pathKey(file.file), sha256: file.sha256, bytes: file.bytes };
  }), file => file.file, "资料文件");
  const filesByPath = new Map(incomingFiles.map(file => [file.file, file]));
  const incomingSheets = uniqueRecords(sheets.map(sheet => {
    if (!object(sheet) || !sha256(sheet.fileSha256) || !sha256(sheet.sha256) || !object(sheet.data)) fail("资料工作表快照无效，未导入");
    const file = pathKey(sheet.file);
    const name = sheetName(sheet.sheet);
    const id = "source-sheet:" + hash(file + "\0" + name + "\0" + sheet.fileSha256);
    if (sheet.id !== id) fail("资料工作表 ID 与来源不符，未导入");
    if (filesByPath.get(file)?.sha256 !== sheet.fileSha256 || pathKey(sheet.data.Source) !== file || sheet.data.Sheet !== name || !Array.isArray(sheet.data.Rows))
      fail("资料工作表与源文件摘要不一致，未导入");
    return { id, file, fileSha256: sheet.fileSha256, sheet: name, sha256: sheet.sha256, data: structuredClone(sheet.data) };
  }), sheet => sheet.id, "资料工作表");
  const incomingDishes = uniqueRecords(data.dishes.map(dish => {
    if (!object(dish) || typeof dish.id !== "string" || !dish.id || typeof dish.stall !== "string" || !dish.stall.trim() ||
        typeof dish.name !== "string" || !nameKey(dish.name) || !Number.isFinite(dish.price) || dish.price < 0 ||
        typeof dish.unit !== "string" || !dish.unit || dish.english != null && typeof dish.english !== "string")
      fail("源菜品记录格式无效，未导入");
    return structuredClone(dish);
  }), dish => dish.id, "源菜品");
  for (const recipe of data.recipes)
    if (!object(recipe) || typeof recipe.name !== "string" || !recipe.name.trim() || !Array.isArray(recipe.ingredients)) fail("配方记录格式无效，未导入");
  const incomingInventory = uniqueRecords(data.inventory.map(item => {
    if (!object(item) || !Number.isSafeInteger(item.rows) || item.rows < 0 || !Number.isSafeInteger(item.cells) || item.cells < 0 || !Array.isArray(item.errors))
      fail("资料清单摘要无效，未导入");
    return { ...structuredClone(item), source: pathKey(item.source), sheet: sheetName(item.sheet) };
  }), item => sheetKey(item.source, item.sheet), "资料清单");
  const providedSheets = new Set(incomingSheets.map(sheet => sheetKey(sheet.file, sheet.sheet)));
  if (incomingInventory.some(item => !providedSheets.has(sheetKey(item.source, item.sheet))))
    fail("资料清单缺少对应工作表快照，未导入");
  return { data, incomingFiles, incomingSheets, incomingDishes, incomingInventory };
}
function prepareImport(store, bundle) {
  const { data, incomingFiles, incomingSheets, incomingDishes, incomingInventory } = validateBundle(bundle);
  const writes = [];
  const summary = { inserted: 0, reused: 0, englishFilled: 0, recipesAdded: 0, sheetsStored: 0, inventoryAdded: 0, inventoryUpdated: 0, filesRecorded: 0, changed: false };
  const dishes = store.all("dishes");
  const byId = new Map();
  const byIdentity = new Map();
  for (const dish of dishes) {
    if (byId.has(dish.id)) fail("数据库菜品 ID 冲突，未导入");
    byId.set(dish.id, dish);
    if (!byIdentity.has(identity(dish))) byIdentity.set(identity(dish), dish);
  }
  const dishWrites = new Map();
  for (const dish of incomingDishes) {
    // The source ID deliberately wins even when an operator changed name,
    // price or unit. Never reseed that record or its corrected provenance.
    const existing = byId.get(dish.id) || byIdentity.get(identity(dish));
    if (existing) {
      summary.reused++;
      const current = dishWrites.get(existing.id) || existing;
      if (!String(current.english || "").trim() && dish.english?.trim() && nameKey(current.name) === nameKey(dish.name)) {
        dishWrites.set(current.id, { ...current, english: dish.english });
        summary.englishFilled++;
      }
    } else {
      dishWrites.set(dish.id, dish);
      byId.set(dish.id, dish);
      byIdentity.set(identity(dish), dish);
      summary.inserted++;
    }
  }
  for (const [id, value] of dishWrites) writes.push({ collection: "dishes", id, value });
  const currentRecipes = store.get("meta", "recipes") || [];
  if (!Array.isArray(currentRecipes)) fail("数据库配方集合格式无效，未导入");
  const recipes = [...currentRecipes];
  const recipeKeys = new Set(recipes.map(stableJson));
  for (const recipe of data.recipes) {
    const key = stableJson(recipe);
    if (recipeKeys.has(key)) continue;
    recipes.push(structuredClone(recipe)); recipeKeys.add(key); summary.recipesAdded++;
  }
  if (summary.recipesAdded) writes.push({ collection: "meta", id: "recipes", value: recipes });

  const currentInventory = store.get("meta", "inventory") || [];
  if (!Array.isArray(currentInventory)) fail("数据库资料清单格式无效，未导入");
  const inventory = structuredClone(currentInventory);
  const inventoryByKey = new Map(inventory.map((item, index) => [sheetKey(item.source, item.sheet), index]));
  for (const item of incomingInventory) {
    const key = sheetKey(item.source, item.sheet);
    if (inventoryByKey.has(key)) {
      const index = inventoryByKey.get(key);
      const prior = inventory[index];
      // book-XX IDs are incidental; source path + sheet is the stable identity.
      const next = { ...prior, source: item.source, sheet: item.sheet, rows: item.rows, cells: item.cells, errors: structuredClone(item.errors) };
      if (!isDeepStrictEqual(prior, next)) { inventory[index] = next; summary.inventoryUpdated++; }
    } else {
      const next = { ...item, id: "source-inventory:" + hash(key) };
      if (inventory.some(prior => prior.id === next.id)) fail("资料清单 ID 冲突，未导入");
      inventoryByKey.set(key, inventory.length); inventory.push(next); summary.inventoryAdded++;
    }
  }
  if (summary.inventoryAdded || summary.inventoryUpdated) writes.push({ collection: "meta", id: "inventory", value: inventory });
  const priorReport = store.get("meta", "report") || {};
  if (!object(priorReport)) fail("数据库资料报告格式无效，未导入");
  const report = { ...priorReport, workbooks: new Set(inventory.map(item => pathKey(item.source))).size, sheets: inventory.length,
    rows: inventory.reduce((total, item) => total + (Number.isSafeInteger(item.rows) ? item.rows : 0), 0),
    formulaErrors: inventory.reduce((total, item) => total + (Array.isArray(item.errors) ? item.errors.length : 0), 0) };
  if (!isDeepStrictEqual(report, priorReport)) writes.push({ collection: "meta", id: "report", value: report });

  const priorManifest = store.get("meta", MATERIALS_IMPORT_KEY);
  if (priorManifest && (priorManifest.version !== VERSION || !Array.isArray(priorManifest.files) || !Array.isArray(priorManifest.sheets)))
    fail("数据库资料导入清单格式或版本无效，未导入");
  const fileKey = file => JSON.stringify([file.file, file.sha256]);
  const files = new Map((priorManifest?.files || []).map(file => [fileKey(file), file]));
  for (const file of incomingFiles) {
    const key = fileKey(file);
    if (files.has(key) && !isDeepStrictEqual(files.get(key), file)) fail("资料文件摘要 ID 冲突，未导入");
    if (!files.has(key)) { files.set(key, file); summary.filesRecorded++; }
  }
  const sheetRefs = new Map((priorManifest?.sheets || []).map(sheet => [sheet.id, sheet]));
  for (const sheet of incomingSheets) {
    const existing = store.get("meta", sheet.id);
    if (existing && !isDeepStrictEqual(existing, sheet)) fail("数据库资料工作表 ID 冲突，未覆盖原快照");
    if (!existing) { writes.push({ collection: "meta", id: sheet.id, value: sheet }); summary.sheetsStored++; }
    const { data: _data, ...reference } = sheet;
    if (sheetRefs.has(sheet.id) && !isDeepStrictEqual(sheetRefs.get(sheet.id), reference)) fail("资料工作表清单 ID 冲突，未导入");
    sheetRefs.set(sheet.id, reference);
  }
  const manifest = { version: VERSION, files: [...files.values()].sort((a, b) => fileKey(a).localeCompare(fileKey(b))),
    sheets: [...sheetRefs.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  if (!isDeepStrictEqual(manifest, priorManifest)) writes.push({ collection: "meta", id: MATERIALS_IMPORT_KEY, value: manifest });
  summary.changed = writes.length > 0;
  return { summary, writes };
}

export function planMaterialsImport(store, bundle) {
  return prepareImport(store, bundle).summary;
}

export function importMaterials(store, bundle) {
  return store.atomic(() => {
    if (store.all("menuRuns").some(run => run.status === "running") || store.all("aiUsage").some(usage => usage.status === "running"))
      fail("菜单或 AI 任务正在运行，请完成后再导入资料");
    const { summary, writes } = prepareImport(store, bundle);
    if (!summary.changed) return summary;
    for (const write of writes) store.put(write.collection, write.id, write.value);
    audit(store, "materials.imported", MATERIALS_IMPORT_KEY, { importVersion: VERSION, ...summary });
    return summary;
  });
}
