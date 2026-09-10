import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository, COLLECTIONS } from "../server/data/repository.mjs";
import { CATALOG_ENGLISH_PROTOCOL_VERSION, catalogEnglishKey, englishNameSummary, prepareCatalogEnglish } from "../server/catalog-english.mjs";

const dish = (id, name, english = "", extra = {}) => ({ id, name, english, stall: "原档口不得传给翻译模型", price: 8, unit: "份", active: true,
  sources: [{ file: "原始文件不得传给翻译模型.xlsx", sheet: "原始表", row: 2 }], spicy: "未知", vegetarian: "未知", labelSource: "", ...extra });
function setup(t, dishes) {
  const store = createRepository(createMemoryAdapter(), () => ({ dishes, feedback: [{ id: "F-1", content: "原反馈不得传给翻译模型" }],
    recipes: [{ name: "原配方不得传给翻译模型" }], rules: [], report: {} }));
  store.put("meta", "catalog-english-lease", { owner: "", expiresAt: 0 });
  t.after(() => store.close());
  return store;
}
const snapshot = store => Object.fromEntries(COLLECTIONS.map(key => [key, store.all(key)]));
function cache(store, name, english, extra = {}) {
  const id = catalogEnglishKey(name);
  store.put("catalogEnglish", id, { id, sourceName: name, english, origin: "ai", model: "cached-model", requestId: "cached-request",
    protocolVersion: CATALOG_ENGLISH_PROTOCOL_VERSION, createdAt: "2026-09-10T00:00:00Z", ...extra });
}
function mockAi(impl) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(request);
    const data = impl ? await impl(request, calls.length) : { translations: request.input.names.map(item => ({ id: item.id, english: `English Dish ${calls.length}-${item.id}` })) };
    return { data, model: "mock-dish-names", requestId: `mock-${calls.length}`, usage: { input_tokens: 10, output_tokens: 10 } };
  } };
}
const cancelled = () => Object.assign(new Error("cancelled"), { code: "GENERATION_CANCELLED", statusCode: 409 });

test("summary is read-only, ignores archived dishes, and separates missing and review counts", t => {
  const store = setup(t, [dish("1", "白菜"), dish("2", " 白菜 ", " "), dish("3", "豆腐", "Tofu"),
    dish("4", "青菜", "Greens", { englishName: { sourceName: "青菜", origin: "ai", status: "needs_review" } }),
    dish("5", "已删除", "", { deletedAt: "2026-09-10" }), dish("6", "未启用", "Disabled dish", { active: false })]);
  const before = snapshot(store);
  assert.deepEqual(englishNameSummary(store), { total: 5, ready: 2, missing: 2, needsReview: 1, uniqueMissing: 1 });
  assert.deepEqual(snapshot(store), before);
});

test("exact source-name translation deduplicates trimmed names only and persists provenance without other edits", async t => {
  const store = setup(t, [dish("1", " 青椒土豆丝 "), dish("2", "青椒土豆丝", "", { revision: 4 }), dish("3", "青椒 土豆丝"), dish("4", "旧菜", "Existing Name")]);
  const before = snapshot(store);
  const ai = mockAi();
  const progress = [];
  const result = await prepareCatalogEnglish(store, ai, { onProgress: value => progress.push(value) });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(ai.calls[0].input, { names: [{ id: 0, sourceName: "青椒土豆丝" }, { id: 1, sourceName: "青椒 土豆丝" }] });
  assert.equal(ai.calls[0].role, "dish_names");
  assert.equal(ai.calls[0].schema.additionalProperties, false);
  assert.match(ai.calls[0].prompt, /health claims/);
  for (const text of ["原档口", "原始文件", "原反馈", "原配方"]) assert.ok(!JSON.stringify(ai.calls).includes(text));
  assert.deepEqual(result, { total: 4, ready: 1, missing: 0, needsReview: 3, uniqueMissing: 0, filled: 3, reused: 0, generated: 2, batches: 1 });
  const first = store.get("dishes", "1");
  assert.equal(first.name, " 青椒土豆丝 ");
  assert.equal(first.english, store.get("dishes", "2").english);
  assert.equal(first.revision, 1);
  assert.equal(store.get("dishes", "2").revision, 5);
  assert.deepEqual(first.englishName, { sourceName: "青椒土豆丝", origin: "ai", status: "needs_review", model: "mock-dish-names", requestId: "mock-1", updatedAt: first.updatedAt });
  for (const prior of before.dishes.slice(0, 3)) {
    const { english: _english, englishName: _englishName, revision: _revision, updatedAt: _updatedAt, ...current } = store.get("dishes", prior.id);
    const { english: _oldEnglish, revision: _oldRevision, ...original } = prior;
    assert.deepEqual(current, original);
  }
  assert.deepEqual(store.get("dishes", "4"), before.dishes[3]);
  for (const key of COLLECTIONS.filter(key => !["dishes", "audit", "catalogEnglish"].includes(key))) assert.deepEqual(store.all(key), before[key]);
  const id = createHash("sha256").update("青椒土豆丝").digest("hex");
  const translated = store.get("catalogEnglish", id);
  assert.equal(translated.sourceName, "青椒土豆丝");
  assert.equal(translated.protocolVersion, CATALOG_ENGLISH_PROTOCOL_VERSION);
  assert.equal(store.all("audit").length, 3);
  assert.ok(store.all("audit").every(row => row.kind === "dish.english_prepared"));
  assert.ok(progress.every(value => Object.values(value).every(item => typeof item === "number")));
});

test("existing source/manual names and exact caches fill blanks without model calls", async t => {
  const store = setup(t, [dish("1", "豆腐", "Tofu"), dish("2", "豆腐"), dish("3", "青菜", "Greens", { origin: "manual" }), dish("4", "青菜"),
    dish("5", "白菜"), dish("6", "蘑菇")]);
  cache(store, "白菜", "Cabbage");
  cache(store, "蘑菇", "Mushrooms", { origin: "source" });
  const ai = mockAi();
  const result = await prepareCatalogEnglish(store, ai);
  assert.equal(ai.calls.length, 0);
  assert.equal(result.filled, 4);
  assert.equal(result.reused, 4);
  assert.equal(result.generated, 0);
  assert.equal(result.batches, 0);
  assert.equal(store.get("dishes", "2").englishName.origin, "source");
  assert.equal(store.get("dishes", "4").englishName.origin, "manual");
  assert.equal(store.get("dishes", "5").englishName.status, "needs_review");
  assert.equal(store.get("dishes", "6").englishName.status, "ready");
  const before = snapshot(store);
  assert.equal((await prepareCatalogEnglish(store, ai)).filled, 0);
  assert.deepEqual(snapshot(store), before);
});

test("conflicting existing English does not choose an existing or cached variant", async t => {
  const store = setup(t, [dish("1", "菜名", "First Name"), dish("2", "菜名", "Second Name"), dish("3", "菜名")]);
  cache(store, "菜名", "First Name", { origin: "manual" });
  const ai = mockAi();
  const result = await prepareCatalogEnglish(store, ai);
  assert.equal(ai.calls.length, 1);
  assert.equal(result.reused, 0);
  assert.equal(result.generated, 1);
  assert.equal(store.get("dishes", "1").english, "First Name");
  assert.equal(store.get("dishes", "2").english, "Second Name");
  assert.equal(store.get("dishes", "3").english, "English Dish 1-0");
  assert.equal(store.get("catalogEnglish", catalogEnglishKey("菜名")).english, "First Name", "human cache is not overwritten");
});

test("mismatched, obsolete and invalid cache rows are never reused", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜"), dish("3", "丙菜"), dish("4", "丁菜")]);
  cache(store, "甲菜", "Wrong Source", { sourceName: "另一菜名" });
  cache(store, "乙菜", "Obsolete", { protocolVersion: "dish-english-v0" });
  cache(store, "丙菜", "中文不得复用");
  cache(store, "丁菜", "Wrong Origin", { origin: "invented" });
  const ai = mockAi();
  assert.equal((await prepareCatalogEnglish(store, ai)).generated, 4);
  assert.equal(ai.calls[0].input.names.length, 4);
});

test("stale or needs-review source names cannot silently become a ready translation on another row", async t => {
  const store = setup(t, [dish("1", "甲菜", "Source Needs Review", { englishName: { sourceName: "甲菜", origin: "source", status: "needs_review" } }),
    dish("2", "甲菜"), dish("3", "乙菜", "Old English Name", { englishName: { sourceName: "旧菜", origin: "manual", status: "ready" } }), dish("4", "乙菜")]);
  cache(store, "甲菜", "Source Needs Review", { origin: "source" });
  cache(store, "乙菜", "Old English Name", { origin: "manual" });
  const ai = mockAi();
  const result = await prepareCatalogEnglish(store, ai);
  assert.equal(ai.calls[0].input.names.length, 2);
  assert.equal(result.reused, 0);
  assert.equal(store.get("dishes", "2").englishName.status, "needs_review");
  assert.equal(store.get("dishes", "4").englishName.status, "needs_review");
  assert.equal(store.get("dishes", "1").english, "Source Needs Review");
  assert.equal(store.get("dishes", "3").english, "Old English Name");
});

test("model work is serial in groups of fifty unique names and skips archived rows", async t => {
  const store = setup(t, [...Array.from({ length: 101 }, (_, index) => dish(`D-${index}`, `菜品${index}`)), dish("deleted", "绝不发送", "", { deletedAt: "2026-09-10" })]);
  let active = 0;
  const ai = mockAi(async request => { active++; assert.equal(active, 1); await Promise.resolve(); active--; return { translations: request.input.names.map(({ id }) => ({ id, english: `Dish ${id}` })) }; });
  const result = await prepareCatalogEnglish(store, ai);
  assert.deepEqual(ai.calls.map(call => call.input.names.length), [50, 50, 1]);
  assert.equal(result.filled, 101);
  assert.equal(result.generated, 101);
  assert.equal(result.batches, 3);
  assert.equal(store.get("dishes", "deleted").english, "");
});

test("invalid model batches are rejected atomically and never automatically retried", async t => {
  const variations = [
    () => ({ translations: [] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 0, english: "Duplicate" }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 2, english: "Unknown" }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 1, english: "中文" }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 1, english: " " }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 1, english: "x".repeat(201) }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 1, english: "Second", note: "extra" }] }),
    () => ({ translations: [{ id: 0, english: "First" }, { id: 1, english: "Second" }], commentary: "extra" }),
  ];
  for (const impl of variations) {
    const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜")]);
    const before = snapshot(store);
    const ai = mockAi(impl);
    await assert.rejects(prepareCatalogEnglish(store, ai), error => error.code === "CATALOG_ENGLISH_INVALID_OUTPUT");
    assert.equal(ai.calls.length, 1);
    assert.deepEqual(snapshot(store), before);
  }
});

test("concurrent operator name, revision, archive and English changes prevent stale filling", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜"), dish("3", "丙菜"), dish("4", "丁菜"), dish("5", "戊菜")]);
  const ai = mockAi(request => {
    store.put("dishes", "1", { ...store.get("dishes", "1"), name: "已改菜名" });
    store.put("dishes", "2", { ...store.get("dishes", "2"), revision: 1 });
    store.put("dishes", "3", { ...store.get("dishes", "3"), deletedAt: "2026-09-10", active: false });
    store.put("dishes", "4", { ...store.get("dishes", "4"), english: "Operator Name" });
    return { translations: request.input.names.map(({ id }) => ({ id, english: `Dish ${id}` })) };
  });
  const result = await prepareCatalogEnglish(store, ai);
  assert.equal(result.filled, 1);
  assert.equal(result.generated, 1);
  assert.equal(store.get("dishes", "1").english, "");
  assert.equal(store.get("dishes", "2").english, "");
  assert.equal(store.get("dishes", "3").english, "");
  assert.equal(store.get("dishes", "4").english, "Operator Name");
  assert.equal(store.all("catalogEnglish").length, 1);
  assert.equal(store.all("audit").length, 1);
});

test("new manual same-name English wins over a model response already in flight", async t => {
  const store = setup(t, [dish("1", "同菜名"), dish("2", "同菜名")]);
  const ai = mockAi(() => {
    store.put("dishes", "1", { ...store.get("dishes", "1"), english: "Human Choice", revision: 1, englishName: { sourceName: "同菜名", origin: "manual", status: "ready" } });
    return { translations: [{ id: 0, english: "Discarded Model Choice" }] };
  });
  const result = await prepareCatalogEnglish(store, ai);
  assert.equal(result.filled, 1);
  assert.equal(result.reused, 1);
  assert.equal(result.generated, 0);
  assert.equal(store.get("dishes", "2").english, "Human Choice");
  assert.equal(store.get("dishes", "2").englishName.origin, "manual");
  assert.equal(store.get("catalogEnglish", catalogEnglishKey("同菜名")).origin, "manual");
});

test("cancellation preserves prior batches and discards late output, with no automatic retry", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜")]);
  const controller = new AbortController();
  const ai = mockAi((request, number) => {
    assert.equal(request.signal, controller.signal);
    if (number === 2) controller.abort(cancelled());
    return { translations: request.input.names.map(({ id }) => ({ id, english: "Dish Name" })) };
  });
  await assert.rejects(prepareCatalogEnglish(store, ai, { signal: controller.signal, batchSize: 1 }), error => error.code === "GENERATION_CANCELLED");
  assert.equal(ai.calls.length, 2);
  assert.equal(store.get("dishes", "1").english, "Dish Name");
  assert.equal(store.get("dishes", "2").english, "");
  assert.equal(store.all("catalogEnglish").length, 1);
  const resumed = mockAi();
  assert.equal((await prepareCatalogEnglish(store, resumed)).filled, 1);
  assert.equal(resumed.calls[0].input.names[0].sourceName, "乙菜");
});

test("progress cancellation keeps the last completed batch and an already-aborted call is read-free", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜")]);
  const controller = new AbortController();
  const ai = mockAi();
  await assert.rejects(prepareCatalogEnglish(store, ai, { signal: controller.signal, batchSize: 1, onProgress: value => { if (value.filled) controller.abort(cancelled()); } }), error => error.code === "GENERATION_CANCELLED");
  assert.equal(ai.calls.length, 1);
  const before = snapshot(store);
  await assert.rejects(prepareCatalogEnglish(store, ai, { signal: controller.signal }), error => error.code === "GENERATION_CANCELLED");
  assert.deepEqual(snapshot(store), before);
});

test("model failure preserves earlier batches and the store lock releases for an explicit retry", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜")]);
  const ai = mockAi((request, number) => { if (number === 2) throw new Error("model unavailable"); return { translations: [{ id: 0, english: "First Dish" }] }; });
  await assert.rejects(prepareCatalogEnglish(store, ai, { batchSize: 1 }), /model unavailable/);
  assert.equal(ai.calls.length, 2);
  assert.equal(store.all("catalogEnglish").length, 1);
  assert.equal((await prepareCatalogEnglish(store, mockAi())).filled, 1);
});

test("concurrent preparation for the same repository refuses before another paid request", async t => {
  const store = setup(t, [dish("1", "甲菜")]);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ai = mockAi(async () => { entered.resolve(); await release.promise; return { translations: [{ id: 0, english: "Dish" }] }; });
  const pending = prepareCatalogEnglish(store, ai);
  await entered.promise;
  try { await assert.rejects(prepareCatalogEnglish(store, ai), error => error.statusCode === 409 && error.code === "CATALOG_ENGLISH_RUNNING"); }
  finally { release.resolve(); }
  assert.equal((await pending).filled, 1);
  assert.equal(ai.calls.length, 1);
});

test("cache, dish and audit mutations roll back together when audit storage fails", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜")]);
  let audits = 0;
  const failing = { ...store, put(collection, id, value) { if (collection === "audit" && ++audits === 2) throw Error("audit failure"); store.put(collection, id, value); } };
  const before = snapshot(store);
  await assert.rejects(prepareCatalogEnglish(failing, mockAi()), /audit failure/);
  assert.deepEqual(snapshot(store), before);
});

test("invalid preparation options fail before model work or writes", async t => {
  const store = setup(t, [dish("1", "甲菜")]);
  const ai = mockAi();
  const before = snapshot(store);
  for (const batchSize of [0, -1, 51, 1.5, "50"]) await assert.rejects(prepareCatalogEnglish(store, ai, { batchSize }), /1 至 50/);
  await assert.rejects(prepareCatalogEnglish(store, ai, { onProgress: true }), /回调/);
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(snapshot(store), before);
});

test("shared database lease prevents paid work through another repository wrapper", async t => {
  const store = setup(t, [dish("1", "甲菜")]);
  const firstStore = { ...store };
  const secondStore = { ...store };
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ai = mockAi(async () => { entered.resolve(); await release.promise; return { translations: [{ id: 0, english: "Dish" }] }; });
  const pending = prepareCatalogEnglish(firstStore, ai, { now: () => 1000 });
  await entered.promise;
  const lease = store.get("meta", "catalog-english-lease");
  assert.match(lease.owner, /^[0-9a-f-]{36}$/);
  assert.equal(lease.expiresAt, 601000);
  const otherAi = mockAi();
  try {
    await assert.rejects(prepareCatalogEnglish(secondStore, otherAi, { now: () => 1000 }), error => error.code === "CATALOG_ENGLISH_RUNNING" && error.statusCode === 409);
    assert.deepEqual(store.get("meta", "catalog-english-lease"), lease);
    assert.equal(otherAi.calls.length, 0);
  } finally { release.resolve(); }
  await pending;
  assert.deepEqual(store.get("meta", "catalog-english-lease"), { owner: "", expiresAt: 0 });
});

test("an expired lease blocks late writes even before another process takes ownership", async t => {
  const store = setup(t, [dish("1", "甲菜")]);
  let now = 1000;
  const ai = mockAi(() => { now += 600000; return { translations: [{ id: 0, english: "Late Dish" }] }; });
  await assert.rejects(prepareCatalogEnglish(store, ai, { now: () => now }), error => error.code === "CATALOG_ENGLISH_LEASE_LOST" && error.statusCode === 409);
  assert.equal(store.get("dishes", "1").english, "");
  assert.equal(store.all("catalogEnglish").length, 0);
  assert.equal(store.all("audit").length, 0);
  assert.deepEqual(store.get("meta", "catalog-english-lease"), { owner: "", expiresAt: 0 });
});

test("expired ownership can be replaced and the old process cannot commit or release the replacement lease", async t => {
  const store = setup(t, [dish("1", "甲菜")]);
  const firstStore = { ...store };
  const secondStore = { ...store };
  let now = 1000;
  const firstEntered = Promise.withResolvers();
  const firstRelease = Promise.withResolvers();
  const firstAi = mockAi(async () => { firstEntered.resolve(); await firstRelease.promise; return { translations: [{ id: 0, english: "Expired Dish" }] }; });
  const first = prepareCatalogEnglish(firstStore, firstAi, { now: () => now });
  const firstRejected = assert.rejects(first, error => error.code === "CATALOG_ENGLISH_LEASE_LOST");
  await firstEntered.promise;
  const oldOwner = store.get("meta", "catalog-english-lease").owner;
  now += 600001;
  const secondEntered = Promise.withResolvers();
  const secondRelease = Promise.withResolvers();
  const secondAi = mockAi(async () => { secondEntered.resolve(); await secondRelease.promise; return { translations: [{ id: 0, english: "Current Dish" }] }; });
  const second = prepareCatalogEnglish(secondStore, secondAi, { now: () => now });
  await secondEntered.promise;
  const replacementLease = store.get("meta", "catalog-english-lease");
  assert.notEqual(replacementLease.owner, oldOwner);
  firstRelease.resolve();
  await firstRejected;
  assert.deepEqual(store.get("meta", "catalog-english-lease"), replacementLease);
  assert.equal(store.get("dishes", "1").english, "");
  secondRelease.resolve();
  assert.equal((await second).filled, 1);
  assert.equal(store.get("dishes", "1").english, "Current Dish");
  assert.equal(store.all("catalogEnglish").length, 1);
  assert.deepEqual(store.get("meta", "catalog-english-lease"), { owner: "", expiresAt: 0 });
});

test("each batch renews the short lease without accumulating metadata rows", async t => {
  const store = setup(t, [dish("1", "甲菜"), dish("2", "乙菜"), dish("3", "丙菜")]);
  let now = 1000;
  const expirations = [];
  const ai = mockAi(() => { expirations.push(store.get("meta", "catalog-english-lease").expiresAt); now += 300000; return { translations: [{ id: 0, english: "Dish" }] }; });
  const beforeCount = store.all("meta").length;
  assert.equal((await prepareCatalogEnglish(store, ai, { batchSize: 1, now: () => now })).batches, 3);
  assert.deepEqual(expirations, [601000, 901000, 1201000]);
  assert.equal(store.all("meta").length, beforeCount);
  assert.deepEqual(store.get("meta", "catalog-english-lease"), { owner: "", expiresAt: 0 });
});
