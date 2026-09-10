import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "../server/store.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";
import { MATERIALS_IMPORT_KEY, importMaterials, planMaterialsImport } from "../server/materials-import.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const file = "materials/extracted/menu/menu.xlsx";
const digest = "a".repeat(64);
const dish = (id, name = "菜名", extra = {}) => ({ id, name, stall: "档口甲", price: 10, unit: "份", priceText: "10/份",
  english: "", active: true, sources: [{ file, sheet: "菜单", row: 3 }], ...extra });
const recipe = (extra = {}) => ({ name: "菜名", ingredients: [{ name: "原料", rawGrams: 10 }],
  source: { file, sheet: "预估", row: 4 }, cost: 2, issues: [], ...extra });
function bundle({ dishes = [dish("D-new")], recipes = [recipe()], sourceHash = digest, rows = 1 } = {}) {
  const sheet = "菜单";
  const data = { Source: file.replaceAll("/", "\\"), Sheet: sheet, State: "", Merges: [],
    Rows: [{ Row: 3, Cells: [{ Ref: "A3", Text: "保留原始单元格", Type: "s", Formula: null }] }] };
  return { data: { dishes, recipes, inventory: [{ id: "book-01-sheet-001", source: file, sheet, rows, cells: 1, errors: [] }],
    report: { workbooks: 1, sheets: 1, rows: 1, formulaErrors: 0, blankRows: 100, feedbackSource: "do not replace" },
    feedback: [{ id: "F-new", content: "not imported" }], rules: [{ text: "not imported" }] },
  files: [{ file, sha256: sourceHash, bytes: 100 }, { file: "菜单.zip", sha256: "b".repeat(64), bytes: 200 }],
  sheets: [{ id: "source-sheet:" + hash(file + "\0" + sheet + "\0" + sourceHash), file, fileSha256: sourceHash,
    sheet, sha256: hash(JSON.stringify(data)), data }] };
}
function setup(t, dishes = [], extras = {}) {
  const store = createStore(":memory:", () => ({ dishes, recipes: [], inventory: [], report: {}, feedback: [], rules: [], ...extras }));
  t.after(() => store.close());
  return store;
}
const state = store => Object.fromEntries(COLLECTIONS.map(collection => [collection, store.all(collection)]));
function preservedRecords(store) {
  for (const collection of ["feedback", "actions", "plans", "settings", "imports", "transactions", "aiUsage", "menuRuns"])
    store.put(collection, collection + "-record", { id: collection + "-record", text: "existing " + collection, status: "completed" });
  for (const id of ["rules", "menu-fixed-dishes", "menu-fixed-staples", "menu-rule-source", "preprocessed-stall-catalog", "prompt-config:current", "prompt-config:version-1"])
    store.put("meta", id, { preserved: id });
}

test("materials import plans read-only, archives source sheets and writes only permitted collections", t => {
  const store = setup(t);
  preservedRecords(store);
  const input = bundle();
  const original = structuredClone(input);
  const before = state(store);
  const preview = planMaterialsImport(store, input);
  assert.deepEqual(preview, { inserted: 1, reused: 0, englishFilled: 0, recipesAdded: 1, sheetsStored: 1, inventoryAdded: 1, inventoryUpdated: 0, filesRecorded: 2, changed: true });
  assert.deepEqual(state(store), before);
  const writes = [];
  const tracked = { ...store, put(collection, id, value) { writes.push([collection, id]); return store.put(collection, id, value); } };
  assert.deepEqual(importMaterials(tracked, input), preview);
  assert.deepEqual(input, original);
  assert.ok(writes.every(([collection]) => ["dishes", "meta", "audit"].includes(collection)));
  assert.deepEqual(store.get("meta", input.sheets[0].id), input.sheets[0]);
  assert.equal(store.get("meta", MATERIALS_IMPORT_KEY).files.length, 2);
  assert.equal(store.get("meta", MATERIALS_IMPORT_KEY).sheets.length, 1);
  assert.ok(!Object.hasOwn(store.get("meta", MATERIALS_IMPORT_KEY).sheets[0], "data"));
  for (const collection of COLLECTIONS.filter(name => !["dishes", "meta", "audit"].includes(name)))
    assert.deepEqual(store.all(collection), before[collection]);
  for (const id of ["rules", "menu-fixed-dishes", "menu-fixed-staples", "menu-rule-source", "preprocessed-stall-catalog", "prompt-config:current", "prompt-config:version-1"])
    assert.deepEqual(store.get("meta", id), { preserved: id });
  const audit = store.all("audit").at(-1);
  assert.equal(audit.kind, "materials.imported");
  assert.equal(audit.sheetsStored, 1);
  assert.ok(!JSON.stringify(audit).includes("保留原始单元格"));
  assert.ok(!JSON.stringify(preview).includes("菜名"));
});

test("reimport is a true no-op including audit and keeps source inputs untouched", t => {
  const store = setup(t);
  const input = bundle();
  importMaterials(store, input);
  const before = state(store);
  const reimport = importMaterials({ ...store, put() { throw new Error("no writes expected"); } }, structuredClone(input));
  assert.equal(reimport.changed, false);
  assert.equal(reimport.reused, 1);
  assert.equal(reimport.inserted, 0);
  assert.equal(reimport.recipesAdded, 0);
  assert.equal(reimport.sheetsStored, 0);
  assert.deepEqual(state(store), before);
});

test("existing source IDs preserve every operator field and corrected provenance, with safe blank-English enrichment only", t => {
  const manual = dish("D-existing", "菜名", { price: 13, active: false, category: "运营类别", spicy: "不辣", verifiedAt: "2026-09-01",
    sources: [{ file: "rules.xlsx", sheet: "固定菜", row: 14 }, { file: "rules.xlsx", sheet: "固定菜", row: 49 }], operatorNote: "keep" });
  const named = dish("D-renamed", "人工改名", { english: "" });
  const translated = dish("D-translated", "已有译文", { english: "Operator translation" });
  const store = setup(t, [manual, named, translated]);
  const input = bundle({ dishes: [dish(manual.id, "菜名", { english: "Source translation" }),
    dish(named.id, "原名称", { english: "Wrong for renamed dish" }), dish(translated.id, translated.name, { english: "Source replacement" })] });
  const result = importMaterials(store, input);
  assert.equal(result.inserted, 0);
  assert.equal(result.reused, 3);
  assert.equal(result.englishFilled, 1);
  assert.deepEqual(store.get("dishes", manual.id), { ...manual, english: "Source translation" });
  assert.deepEqual(store.get("dishes", named.id), named);
  assert.deepEqual(store.get("dishes", translated.id), translated);
});

test("missing source IDs reuse normalized dish identities without changing IDs, units or source evidence", t => {
  const matched = dish("D-manual", "同 名 菜", { active: false });
  const distinct = dish("D-person", "同名菜", { unit: "位" });
  const store = setup(t, [matched, distinct]);
  const result = importMaterials(store, bundle({ dishes: [dish("D-source", "同名菜", { english: "Matching dish" }),
    dish("D-by-weight", "同名菜", { unit: "100g" })] }));
  assert.equal(result.inserted, 1);
  assert.equal(result.reused, 1);
  assert.equal(store.get("dishes", "D-source"), null);
  assert.deepEqual(store.get("dishes", matched.id), { ...matched, english: "Matching dish" });
  assert.deepEqual(store.get("dishes", distinct.id), distinct);
  assert.equal(store.get("dishes", "D-by-weight").unit, "100g");
});

test("recipe versions deduplicate by full content independent of object-property ordering", t => {
  const old = recipe();
  const ordered = { issues: [], cost: 2, source: { row: 4, sheet: "预估", file }, ingredients: [{ rawGrams: 10, name: "原料" }], name: "菜名" };
  const revised = recipe({ cost: 3 });
  const store = setup(t, [], { recipes: [old] });
  const result = importMaterials(store, bundle({ recipes: [ordered, revised, structuredClone(revised)] }));
  assert.equal(result.recipesAdded, 1);
  assert.deepEqual(store.get("meta", "recipes"), [old, revised]);
});

test("inventory uses source plus sheet, retains other sources and updates only material report totals", t => {
  const existing = { id: "book-99-sheet-007", source: file.replaceAll("/", "\\"), sheet: "菜单", rows: 7, cells: 8, errors: ["A1=#REF!"], operatorNote: "keep" };
  const other = { id: "book-01-sheet-001", source: "older.xlsx", sheet: "历史", rows: 2, cells: 3, errors: ["C3=#REF!"] };
  const report = { workbooks: 99, sheets: 99, rows: 999, formulaErrors: 999, blankRows: 8, merged: 3, correctedCategories: 2, feedbackSource: "existing", historyFile: "history.xlsx", files: 22 };
  const store = setup(t, [], { inventory: [existing, other], report });
  const result = importMaterials(store, bundle());
  assert.equal(result.inventoryAdded, 0);
  assert.equal(result.inventoryUpdated, 1);
  assert.deepEqual(store.get("meta", "inventory"), [{ ...existing, source: file, rows: 1, cells: 1, errors: [] }, other]);
  assert.deepEqual(store.get("meta", "report"), { ...report, workbooks: 2, sheets: 2, rows: 3, formulaErrors: 1 });
  const next = bundle();
  next.data.inventory[0].id = "book-42-sheet-009";
  assert.equal(importMaterials(store, next).changed, false, "inspection numbering does not cause changes");
});

test("new source versions append immutable sheet history and update inventory without removing prior versions", t => {
  const store = setup(t);
  const first = bundle();
  importMaterials(store, first);
  const revised = bundle({ sourceHash: "c".repeat(64), rows: 2 });
  const result = importMaterials(store, revised);
  assert.equal(result.sheetsStored, 1);
  assert.equal(result.filesRecorded, 1);
  assert.equal(store.get("meta", MATERIALS_IMPORT_KEY).files.length, 3);
  assert.equal(store.get("meta", MATERIALS_IMPORT_KEY).sheets.length, 2);
  assert.deepEqual(store.get("meta", first.sheets[0].id), first.sheets[0]);
  assert.deepEqual(store.get("meta", revised.sheets[0].id), revised.sheets[0]);
  assert.equal(store.get("meta", "inventory").length, 1);
  assert.equal(store.get("meta", "report").rows, 2);
});

test("conflicting source dish IDs, malformed provenance and source-sheet collisions fail without writes", t => {
  const mutations = [
    input => input.data.dishes.push(dish("D-new", "different")),
    input => { input.sheets[0].id = "source-sheet:" + "f".repeat(64); },
    input => { input.sheets[0].data.Source = "different.xlsx"; },
    input => { input.sheets[0].fileSha256 = "f".repeat(64); },
    input => { input.files[0].file = "../outside.xlsx"; },
    input => { input.files[0].sha256 = "invalid"; },
    input => { input.files[0].bytes = -1; },
    input => { input.data.inventory[0].sheet = "missing"; },
    input => input.files.push({ ...input.files[0], bytes: 999 }),
  ];
  for (const mutate of mutations) {
    const store = setup(t);
    const input = bundle();
    mutate(input);
    const before = state(store);
    assert.throws(() => importMaterials(store, input), /未导入/);
    assert.deepEqual(state(store), before);
  }
  const store = setup(t);
  const input = bundle();
  store.put("meta", input.sheets[0].id, { ...input.sheets[0], sha256: "f".repeat(64) });
  const before = state(store);
  assert.throws(() => importMaterials(store, input), /ID 冲突/);
  assert.deepEqual(state(store), before);
});

test("running menu or AI tasks block imports inside the write transaction", t => {
  for (const collection of ["menuRuns", "aiUsage"]) {
    const store = setup(t);
    store.put(collection, "running", { id: "running", status: "running" });
    const before = state(store);
    assert.equal(planMaterialsImport(store, bundle()).inserted, 1, "read-only preview remains available");
    assert.throws(() => importMaterials(store, bundle()), /正在运行/);
    assert.deepEqual(state(store), before);
  }
});

test("transaction recomputation preserves edits made after preview and rolls back every write on failure", t => {
  const source = dish("D-existing", "菜名", { english: "Source name" });
  const existing = dish(source.id);
  const store = setup(t, [existing]);
  const input = bundle({ dishes: [source] });
  assert.equal(planMaterialsImport(store, input).englishFilled, 1);
  const concurrent = { ...store, atomic(action) { return store.atomic(() => {
    store.put("dishes", existing.id, { ...existing, english: "Concurrent operator name", active: false });
    return action();
  }); } };
  assert.equal(importMaterials(concurrent, input).englishFilled, 0);
  assert.equal(store.get("dishes", existing.id).english, "Concurrent operator name");
  assert.equal(store.get("dishes", existing.id).active, false);
  const fresh = setup(t);
  const before = state(fresh);
  for (const failAt of [1, 3, 7]) {
    let writes = 0;
    const failing = { ...fresh, put(...args) {
      const result = fresh.put(...args);
      if (++writes === failAt) throw new Error("injected failure");
      return result;
    } };
    assert.throws(() => importMaterials(failing, bundle()), /injected failure/);
    assert.equal(writes, failAt);
    assert.deepEqual(state(fresh), before);
  }
});
