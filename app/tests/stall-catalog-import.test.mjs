import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { transactionSchema, fitsPrice } from "../server/domain.mjs";
import { importStallCatalog, planStallCatalogImport } from "../server/stall-catalog-import.mjs";
import { readStallCatalog } from "../server/stored-stall-catalog.mjs";

const file = "第一轮+第二轮纯菜单库.xlsx";
const source = { file, sha256: "a".repeat(64) };
const dish = (id, name, unit = "份", extra = {}) => ({ id, name, stall: "南洋烟火", price: 16, unit, priceText: `16/${unit}`,
  active: true, category: "", english: "", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "",
  calories: null, allergens: "", labelSource: "", sources: [], ...extra });
const reference = (row, nameCell = `I${row}`, priceCell = `J${row}`) => ({ file, sheet: "北京小院+南洋烟火", row, nameCell, priceCell });
function loaded(records = [{ stall: "南洋烟火", name: "五指毛桃老鸡汤", price: 16, unit: "位", priceText: "16/位", category: "", sources: [reference(2)] }]) {
  return { version: "stall-catalog-v1", source: structuredClone(source), coveredStalls: ["南洋烟火"], records: structuredClone(records),
    warnings: [], rejected: [], stats: { sourceRows: records.length, uniqueDishes: records.length, duplicates: 0, rejected: 0 } };
}
function setup(t, dishes = []) {
  const store = createStore(":memory:", () => ({ dishes, feedback: [], recipes: [], rules: [], inventory: [], report: {} }));
  t.after(() => store.close());
  return store;
}
function allState(store) {
  return Object.fromEntries(["dishes", "meta", "audit", "imports", "plans", "transactions"].map(collection => [collection, store.all(collection)]));
}

test("incremental catalog import inserts a distinct per-person dish without overwriting the legacy per-serving ID", t => {
  const old = dish("D-legacy", "五指毛桃老鸡汤", "份", { priceText: "16/位", sources: [{ file, sheet: "北京小院+南洋烟火", row: 2 }] });
  const store = setup(t, [old]);
  const input = loaded();
  const before = allState(store);
  const preview = planStallCatalogImport(store, input);
  assert.equal(preview.inserted, 1);
  assert.equal(preview.reused, 0);
  assert.deepEqual(allState(store), before, "planning the import is read-only");
  const result = importStallCatalog(store, input);
  assert.equal(result.inserted, 1);
  assert.equal(result.changed, true);
  assert.equal(store.all("dishes").length, 2);
  assert.deepEqual(store.get("dishes", old.id), old);
  const added = store.all("dishes").find(item => item.id !== old.id);
  assert.equal(added.unit, "位");
  assert.equal(added.price, 16);
  assert.equal(added.priceText, "16/位");
  assert.equal(added.active, true);
  assert.equal(added.spicy, "未知");
  assert.equal(added.vegetarian, "未知");
  assert.equal(added.calories, null);
  assert.equal(added.labelSource, "");
  assert.ok(added.sources.some(item => item.file === file && item.nameCell === "I2" && item.priceCell === "J2"));
  assert.ok(added.sources.every(item => item.fileSha256 === source.sha256 && item.priceText === "16/位"));
  const catalog = readStallCatalog(store);
  assert.deepEqual(catalog.groups.find(group => group.stall === "南洋烟火").candidateIds, [added.id]);
});

test("reimport is idempotent for IDs, source evidence and persisted business records", t => {
  const store = setup(t);
  const input = loaded();
  const original = structuredClone(input);
  importStallCatalog(store, input);
  const before = allState(store);
  const next = importStallCatalog(store, input);
  assert.equal(next.inserted, 0);
  assert.equal(next.reused, 1);
  assert.equal(next.sourcesUpdated, 0);
  assert.equal(next.changed, false);
  assert.deepEqual(allState(store), before);
  assert.deepEqual(input, original);
});

test("source reuse only enriches provenance and preserves every existing manual field, ID and disabled state", t => {
  const existing = dish("D-existing", "客制菜", "份", { active: false, category: "运营类别", english: "Verified name", spicy: "辣", vegetarian: "非素食",
    mainIngredient: "牛肉", method: "炖", labelSource: "厨房已核验", verifiedAt: "2026-09-01", calories: 123, allergens: "大豆", operatorField: "retain",
    sources: [{ file: "other.xlsx", sheet: "历史", row: 1 }] });
  const other = dish("D-other", "无关菜品");
  const store = setup(t, [existing, other]);
  const input = loaded([{ stall: existing.stall, name: existing.name, price: existing.price, unit: existing.unit, category: "源类别", priceText: "16元/份", sources: [reference(3)] }]);
  const result = importStallCatalog(store, input);
  assert.equal(result.inserted, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.sourcesUpdated, 1);
  const saved = store.get("dishes", existing.id);
  const { sources: _oldSources, ...oldFields } = existing;
  const { sources: _savedSources, ...newFields } = saved;
  assert.deepEqual(newFields, oldFields);
  assert.ok(saved.sources.some(item => item.file === "other.xlsx"));
  assert.ok(saved.sources.some(item => item.file === file && item.nameCell === "I3"));
  assert.deepEqual(store.all("dishes").map(item => item.id), [existing.id, other.id]);
  assert.deepEqual(store.get("dishes", other.id), other);
  assert.ok(!readStallCatalog(store).groups.flatMap(group => group.candidateIds).includes(existing.id));
});

test("the stored catalog follows database activation changes without reopening an Excel file", t => {
  const existing = dish("D-disabled", "候选菜", "份", { active: false });
  const store = setup(t, [existing]);
  importStallCatalog(store, loaded([{ stall: existing.stall, name: existing.name, price: 16, unit: "份", priceText: "16/份", category: "", sources: [reference(4)] }]));
  const first = readStallCatalog(store);
  assert.ok(!first.groups.flatMap(group => group.candidateIds).includes(existing.id));
  store.put("dishes", existing.id, { ...store.get("dishes", existing.id), active: true });
  const active = readStallCatalog(store);
  assert.ok(active.groups.flatMap(group => group.candidateIds).includes(existing.id));
  assert.notEqual(active.fingerprint, first.fingerprint);
  store.put("dishes", existing.id, { ...store.get("dishes", existing.id), active: false });
  assert.ok(!readStallCatalog(store).groups.flatMap(group => group.candidateIds).includes(existing.id));
});

test("catalog import rolls back inserted dishes, merged evidence and metadata when a transaction write fails", t => {
  const existing = dish("D-existing", "保留菜");
  const store = setup(t, [existing]);
  const input = loaded([{ stall: "南洋烟火", name: existing.name, price: 16, unit: "份", priceText: "16/份", category: "", sources: [reference(5)] }, ...loaded().records]);
  const before = allState(store);
  for (const failAt of [2, 3, 4]) {
    let writes = 0;
    const failingStore = { ...store, put(...args) {
      const result = store.put(...args);
      if (++writes === failAt) throw new Error("injected storage failure");
      return result;
    } };
    assert.throws(() => importStallCatalog(failingStore, input), /injected storage failure/);
    assert.equal(writes, failAt);
    assert.deepEqual(allState(store), before, `failure at write ${failAt} must roll back dishes, catalog and audit`);
  }
});

test("stable generated IDs fail closed on collision and active menu runs block import writes", t => {
  const store = setup(t);
  const input = loaded();
  const generatedId = planStallCatalogImport(store, input).catalog.groups[0].candidateIds[0];
  store.put("dishes", generatedId, dish(generatedId, "碰撞的无关菜品"));
  const before = allState(store);
  assert.throws(() => importStallCatalog(store, input), /ID.*冲突/);
  assert.deepEqual(allState(store), before);
  const runningStore = setup(t);
  runningStore.put("menuRuns", "MR-active", { id: "MR-active", status: "running" });
  const beforeRun = allState(runningStore);
  assert.throws(() => importStallCatalog(runningStore, input), /正在生成/);
  assert.deepEqual(allState(runningStore), beforeRun);
});

test("same-identity duplicate IDs are reported and retained, and DB-only supplemental stalls remain visible", t => {
  const first = dish("D-1", "重复身份菜", "位", { active: false });
  const second = dish("D-2", "重复身份菜", "位", { labelSource: "独立核验", spicy: "不辣" });
  const store = setup(t, [first, second]);
  const result = importStallCatalog(store, loaded([{ stall: first.stall, name: first.name, price: 16, unit: "位", priceText: "16/位", category: "", sources: [reference(8)] }]));
  assert.equal(result.inserted, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.ambiguities.length, 1);
  assert.deepEqual(result.ambiguities[0].dishIds, [first.id, second.id]);
  assert.deepEqual(store.all("dishes").map(item => item.id), [first.id, second.id]);
  assert.equal(store.get("dishes", first.id).active, false);
  assert.equal(store.get("dishes", second.id).labelSource, second.labelSource);
  assert.deepEqual(readStallCatalog(store).groups[0].candidateIds, [second.id]);
  const supplement = dish("D-supp", "新增数据库档口菜", "份", { stall: "数据库补充档口" });
  store.put("dishes", supplement.id, supplement);
  const group = readStallCatalog(store).groups.find(item => item.stall === supplement.stall);
  assert.equal(group.origin, "supplement");
  assert.deepEqual(group.candidateIds, [supplement.id]);
});

test("POS accepts per-person units but never aliases them to portions or fixed-price portion slots", async t => {
  const perServing = dish("D-serving", "同名汤", "份");
  const perPerson = dish("D-person", "同名汤", "位");
  const store = setup(t, [perServing, perPerson]);
  const app = createApp(store);
  t.after(() => app.close());
  const headers = { "Content-Type": "application/json" };
  const columns = "transactionId,lineId,time,stall,dishId,dishName,quantity,amount,status,unit";
  const csv = [columns, "TP,1,2026-09-09T12:30,南洋烟火,,同名汤,2,32,sale,位", "TS,1,2026-09-09T12:30,南洋烟火,,同名汤,3,48,sale,份"].join("\n");
  const imported = await app.inject({ method: "POST", url: "/api/pos/import", headers, payload: { csv } });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().inserted, 2);
  const rows = store.all("transactions");
  assert.equal(rows.find(row => row.unit === "位").dishId, perPerson.id);
  assert.equal(rows.find(row => row.unit === "份").dishId, perServing.id);
  const response = await app.inject({ method: "GET", url: "/api/pos" });
  assert.equal(response.statusCode, 200);
  const report = response.json();
  assert.equal(report.revenue, 80);
  assert.equal(report.ranking.length, 2);
  assert.equal(report.ranking.find(row => row.unit === "位").quantity, 2);
  assert.equal(report.ranking.find(row => row.unit === "份").quantity, 3);
  const mismatch = await app.inject({ method: "POST", url: "/api/pos/import", headers, payload: { csv: `${columns}\nTM,1,2026-09-09T12:30,南洋烟火,${perServing.id},同名汤,1,16,sale,位` } });
  assert.equal(mismatch.statusCode, 400);
  assert.match(mismatch.json().error, /单位不匹配/);
  assert.equal(store.all("transactions").length, 2);
  assert.equal(fitsPrice(perPerson, 16), false);
  assert.equal(fitsPrice(perPerson, "*"), true);
  const transaction = { transactionId: "unit-test", lineId: "1", time: "2026-09-09T12:30", stall: "南洋烟火", dishId: perPerson.id, dishName: perPerson.name, quantity: 1, amount: 16, status: "sale", unit: "位" };
  assert.equal(transactionSchema.safeParse(transaction).success, true);
  assert.equal(transactionSchema.safeParse({ ...transaction, unit: "随意单位" }).success, false);
});
