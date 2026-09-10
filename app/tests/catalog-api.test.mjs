import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
import { createStore } from "../server/store.mjs";
import { readStallCatalog, STALL_CATALOG_KEY } from "../server/stored-stall-catalog.mjs";
import { directContext } from "../server/direct-menu-planner.mjs";

const baseDish = { id: "D-source", name: "原菜名", stall: "测试档口", price: 8, priceText: "8/份", unit: "份",
  english: "", category: "", active: true, spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "",
  sources: [{ file: "original.xlsx", sheet: "原档口", row: 2 }] };
function fixture(t) {
  const store = createStore(":memory:", () => ({ dishes: [baseDish], feedback: [], recipes: [{ name: "原菜名", ingredients: [], source: baseDish.sources[0] }] }));
  let aiCalls = 0;
  const app = createApp(store, undefined, { ai: { status: () => ({ configured: true }), respond() { aiCalls++; throw new Error("Catalog writes must not call AI"); } } });
  t.after(async () => { await app.close(); store.close(); assert.equal(aiCalls, 0); });
  const call = async (method, url, payload = {}) => {
    const result = await app.inject({ method, url, headers: { "content-type": "application/json" }, payload });
    return { status: result.statusCode, data: result.json() };
  };
  return { store, app, call };
}

test("catalog API creates, edits, archives and restores without breaking old menu or recipe references", async t => {
  const { store, call } = fixture(t);
  const saved = { id: "P-history", entries: [{ dishId: baseDish.id }], status: "待审核草案" };
  store.put("plans", saved.id, saved);
  const created = await call("POST", "/api/dishes", { name: "新增菜品", stall: baseDish.stall, price: 9, unit: "份" });
  assert.equal(created.status, 201);
  assert.equal(created.data.origin, "manual");
  assert.equal(created.data.name, "新增菜品");
  assert.equal(created.data.spicy, "未知");
  assert.equal(created.data.verifiedAt, undefined);
  assert.ok(created.data.id);
  const edit = await call("PATCH", `/api/dishes/${baseDish.id}`, { name: "调整菜名", price: 10, expectedRevision: 0 });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.sourceName, baseDish.name);
  assert.deepEqual(edit.data.sources, baseDish.sources);
  const recipes = await (await call("GET", `/api/recipes/${baseDish.id}`)).data;
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].name, baseDish.name);
  const deleted = await call("DELETE", `/api/dishes/${baseDish.id}`, { expectedRevision: edit.data.revision });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.data.deletedAt);
  assert.equal(deleted.data.active, false);
  assert.deepEqual(store.get("plans", saved.id), saved);
  assert.equal(store.get("dishes", baseDish.id).id, baseDish.id);
  const workspace = (await call("GET", "/api/data")).data;
  const listed = (await call("GET", "/api/dishes")).data;
  assert.deepEqual(workspace.dishes, listed);
  assert.ok(listed.find(dish => dish.id === baseDish.id).deletedAt);
  const restored = await call("POST", `/api/dishes/${baseDish.id}/restore`, { expectedRevision: deleted.data.revision });
  assert.equal(restored.status, 200);
  assert.equal(Boolean(restored.data.deletedAt), false);
  assert.equal(restored.data.active, true);
  assert.equal(restored.data.name, "调整菜名");
  assert.deepEqual(store.get("plans", saved.id), saved);
});

test("catalog API validates writes, stale revisions and menu generation conflicts atomically", async t => {
  const { store, call } = fixture(t);
  const original = structuredClone(store.all("dishes"));
  for (const input of [
    { name: "", stall: baseDish.stall, price: 9, unit: "份" },
    { name: "新菜", stall: "伪造档口", price: 9, unit: "份" },
    { name: "新菜", stall: baseDish.stall, price: -1, unit: "份" },
    { name: "新菜", stall: baseDish.stall, price: null, unit: "份" },
    { name: "新菜", stall: baseDish.stall, price: 9, unit: "份", sources: [{ file: "forged.xlsx" }] },
  ]) assert.equal((await call("POST", "/api/dishes", input)).status, 400);
  assert.deepEqual(store.all("dishes"), original);
  assert.equal((await call("PATCH", `/api/dishes/${baseDish.id}`, { name: "新名", expectedRevision: 7 })).status, 409);
  assert.equal((await call("DELETE", `/api/dishes/${baseDish.id}`, { expectedRevision: 7 })).status, 409);
  assert.deepEqual(store.all("dishes"), original);
  store.put("menuRuns", "MR-running", { id: "MR-running", status: "running" });
  for (const [method, url, input] of [
    ["POST", "/api/dishes", { name: "新菜", stall: baseDish.stall, price: 9, unit: "份" }],
    ["PATCH", `/api/dishes/${baseDish.id}`, { price: 9 }],
    ["DELETE", `/api/dishes/${baseDish.id}`, {}],
  ]) assert.equal((await call(method, url, input)).status, 409);
  assert.deepEqual(store.all("dishes"), original);
  assert.equal(store.all("audit").length, 0);
});

test("catalog mutations retain same-origin JSON protection and do not permit protected fields", async t => {
  const { store, app, call } = fixture(t);
  const original = structuredClone(store.get("dishes", baseDish.id));
  const crossOrigin = await app.inject({ method: "DELETE", url: `/api/dishes/${baseDish.id}`, headers: { origin: "https://untrusted.example", "content-type": "application/json" }, payload: {} });
  assert.equal(crossOrigin.statusCode, 403);
  const noJson = await app.inject({ method: "DELETE", url: `/api/dishes/${baseDish.id}` });
  assert.equal(noJson.statusCode, 415);
  for (const input of [{ id: "D-forged" }, { deletedAt: "" }, { origin: "manual" }, { sources: [] }, { catalogManualOverride: true }])
    assert.equal((await call("PATCH", `/api/dishes/${baseDish.id}`, input)).status, 400);
  assert.deepEqual(store.get("dishes", baseDish.id), original);
});

test("API-created dishes reach the real per-stall planner candidate projection and leave it on deletion", async t => {
  const { store, call } = fixture(t);
  const other = { ...baseDish, id: "D-other-stall", stall: "第二档口" };
  store.put("dishes", other.id, other);
  store.put("meta", STALL_CATALOG_KEY, { storageMode: "database", groups: [baseDish, other].map(dish => ({ stall: dish.stall, origin: "primary",
    records: [{ name: dish.name, price: dish.price, unit: dish.unit, dishIds: [dish.id], sources: dish.sources }], candidateIds: [dish.id], unresolved: [] })) });
  const currentCandidates = () => directContext({ dishes: store.all("dishes"), planningMode: "per-stall", stallCatalog: readStallCatalog(store), rules: [], actions: [], fixedDishes: [] }, { count: 1, meals: ["午餐"] }).candidates;
  const result = await call("POST", "/api/dishes", { name: "真实维护入口新增菜", stall: baseDish.stall, price: 12, unit: "份" });
  assert.equal(result.status, 201);
  assert.equal(currentCandidates().find(dish => dish.id === result.data.id).stall, baseDish.stall);
  const updated = await call("PATCH", `/api/dishes/${result.data.id}`, { stall: other.stall, expectedRevision: result.data.revision });
  assert.equal(updated.status, 200);
  assert.equal(currentCandidates().find(dish => dish.id === result.data.id).stall, other.stall);
  const archived = await call("DELETE", `/api/dishes/${result.data.id}`, { expectedRevision: updated.data.revision });
  assert.equal(archived.status, 200);
  assert.equal(currentCandidates().some(dish => dish.id === result.data.id), false);
  const restored = await call("POST", `/api/dishes/${result.data.id}/restore`, { expectedRevision: archived.data.revision });
  assert.equal(restored.status, 200);
  assert.equal(currentCandidates().find(dish => dish.id === result.data.id).stall, other.stall);
});
