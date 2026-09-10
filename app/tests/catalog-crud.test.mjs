import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository, COLLECTIONS } from "../server/data/repository.mjs";
import { createDish, updateDish, archiveDish, restoreDish } from "../server/catalog-service.mjs";

const source = { file: "原始菜单.xlsx", sheet: "热菜", row: 3, priceText: "8元/份" };
const original = { id: "D-ORIGINAL", name: "清炒西兰花", english: "Broccoli", stall: "档口甲", price: 8, unit: "份", priceText: "8元/份",
  category: "热菜", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "",
  active: true, sources: [source], rawNote: "原始业务字段" };
const creation = { name: "菌菇炖豆腐", stall: "档口甲", price: 12, unit: "份" };
const knownTags = { spicy: "不辣", vegetarian: "素食", mainIngredient: "蔬菜", method: "炒", active: true, calories: 180, allergens: "无已知过敏原", labelSource: "厨房现场核验记录" };
const unknownTags = { spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "手工录入，待核验" };

function setup(t) {
  const store = createRepository(createMemoryAdapter(), () => ({ dishes: [original, { ...original, id: "D-SECOND", name: "家常豆腐", stall: "档口乙", active: false }], feedback: [], rules: [], report: {} }));
  store.put("meta", "preprocessed-stall-catalog", { groups: [{ stall: "档口甲", records: [] }, { stall: "映射新档", records: [] }] });
  t.after(() => store.close());
  return store;
}
const snapshot = store => Object.fromEntries(COLLECTIONS.map(collection => [collection, store.all(collection)]));
const conflict = code => error => error.statusCode === 409 && error.code === code;

test("manual creation has stable ID, safe unknown defaults, current display price and atomic audit", t => {
  const store = setup(t);
  const meta = store.all("meta");
  const dish = createDish(store, creation);
  assert.match(dish.id, /^D-[0-9a-f-]{36}$/);
  assert.equal(dish.origin, "manual");
  assert.equal(dish.revision, 1);
  assert.equal(dish.priceText, "12/份");
  assert.equal(dish.active, true);
  assert.equal(dish.english, "");
  assert.equal(dish.category, "");
  assert.equal(dish.verifiedAt, undefined);
  for (const [field, value] of Object.entries(unknownTags)) assert.equal(dish[field], value);
  assert.deepEqual(dish.sources, []);
  assert.deepEqual(store.get("dishes", dish.id), dish);
  assert.deepEqual(store.all("meta"), meta);
  assert.equal(store.all("audit")[0].kind, "dish.created");
  assert.equal(store.all("audit")[0].targetId, dish.id);
  dish.sources.push({ forged: true });
  assert.deepEqual(store.get("dishes", dish.id).sources, []);
});

test("creation accepts only existing or mapped stalls and respects numeric boundary values", t => {
  const store = setup(t);
  const first = createDish(store, { ...creation, name: "  零元样品  ", stall: " 映射新档 ", price: 0, unit: " 个 ", english: " Sample ", category: " 点心 " });
  assert.equal(first.name, "零元样品");
  assert.equal(first.stall, "映射新档");
  assert.equal(first.priceText, "0/个");
  assert.equal(first.english, "Sample");
  assert.equal(first.category, "点心");
  assert.equal(createDish(store, { ...creation, name: "价格上限", price: 10000 }).price, 10000);
  const before = snapshot(store);
  assert.throws(() => createDish(store, { ...creation, stall: "不存在的档口" }), /现有菜库或已映射/);
  assert.deepEqual(snapshot(store), before);
});

test("invalid fields and server-owned metadata are rejected without writes", t => {
  const store = setup(t);
  const invalid = [null, [], {}, { ...creation, name: " " }, { ...creation, name: "菜".repeat(151) },
    { ...creation, price: -1 }, { ...creation, price: 10001 }, { ...creation, price: Infinity }, { ...creation, price: NaN }, { ...creation, price: "12" },
    { ...creation, stall: "档".repeat(101) }, { ...creation, unit: "" }, { ...creation, unit: "份".repeat(21) }, { ...creation, english: "x".repeat(201) }, { ...creation, category: "类".repeat(101) },
    { ...creation, calories: 901 }, { ...creation, calories: Infinity }, { ...creation, mainIngredient: "料".repeat(101) }, { ...creation, labelSource: "x" },
    ...["id", "sources", "source", "sourceName", "sourceIdentity", "origin", "deletedAt", "activeBeforeArchive", "verifiedAt", "revision", "expectedRevision", "catalogManualOverride", "priceText"].map(field => ({ ...creation, [field]: "forged" }))];
  for (const input of invalid) {
    const before = snapshot(store);
    assert.throws(() => createDish(store, input), error => error.code === "CATALOG_INVALID_INPUT" && !error.message.includes("forged"));
    assert.deepEqual(snapshot(store), before);
  }
  for (const field of ["id", "sources", "origin", "deletedAt", "sourceIdentity", "revision", "catalogManualOverride", "verifiedAt"]) {
    const before = snapshot(store);
    assert.throws(() => updateDish(store, original.id, { [field]: "forged" }), /不可修改/);
    assert.throws(() => archiveDish(store, original.id, { [field]: "forged" }), /不可修改/);
    assert.throws(() => restoreDish(store, original.id, { [field]: "forged" }), /不可修改/);
    assert.deepEqual(snapshot(store), before);
  }
});

test("known labels require explicit evidence and unknown defaults never receive verification timestamps", t => {
  const store = setup(t);
  for (const tags of [{ spicy: "不辣" }, { vegetarian: "素食" }, { mainIngredient: "豆腐" }, { method: "炖" }, { calories: 0 }, { allergens: "大豆" }]) {
    assert.throws(() => createDish(store, { ...creation, ...tags }), /核验依据/);
    assert.throws(() => updateDish(store, original.id, tags), /核验依据/);
  }
  for (const labelSource of ["待核验", "尚未核实", "unknown", "Unverified source"]) assert.throws(() => createDish(store, { ...creation, spicy: "不辣", labelSource }), /核验依据/);
  const unknown = createDish(store, { ...creation, labelSource: "厨房提供记录" });
  assert.equal(unknown.verifiedAt, undefined);
  const verified = createDish(store, { ...creation, name: "已核验新品", ...knownTags });
  assert.equal(verified.verifiedAt, verified.createdAt);
  const updated = updateDish(store, original.id, knownTags);
  assert.equal(updated.verifiedAt, updated.updatedAt);
  assert.equal(updated.revision, 1, "legacy records have revision zero");
  assert.deepEqual(updated.sources, original.sources);
  const reset = updateDish(store, original.id, { ...unknownTags, expectedRevision: 1 });
  assert.equal(reset.verifiedAt, undefined);
});

test("identity adjustments retain original identity once, preserve sources and opt into manual candidates", t => {
  const store = setup(t);
  const changed = updateDish(store, original.id, { name: " 西兰花炒木耳 ", stall: "档口乙", price: 9.5, unit: "100g", english: "Broccoli and fungus", category: "凉菜", expectedRevision: 0 });
  assert.equal(changed.id, original.id);
  assert.equal(changed.name, "西兰花炒木耳");
  assert.equal(changed.sourceName, original.name);
  assert.deepEqual(changed.sourceIdentity, { name: original.name, stall: original.stall, price: original.price, unit: original.unit, priceText: original.priceText });
  assert.equal(changed.priceText, "9.5/100g");
  assert.equal(changed.catalogManualOverride, true);
  assert.deepEqual(changed.sources, original.sources);
  assert.equal(changed.rawNote, original.rawNote);
  assert.equal(changed.verifiedAt, undefined);
  const next = updateDish(store, original.id, { name: "第二次改名", price: 10, expectedRevision: 1 });
  assert.equal(next.sourceName, original.name);
  assert.deepEqual(next.sourceIdentity, changed.sourceIdentity);
  assert.equal(next.revision, 2);
  assert.equal(next.priceText, "10/100g");
  assert.deepEqual(next.sources, original.sources);
  assert.deepEqual(store.all("audit").map(item => item.kind), ["dish.updated", "dish.updated"]);
});

test("identity changes require explicit re-confirmation of retained known labels or resetting them to unknown", t => {
  const store = setup(t);
  const verified = updateDish(store, original.id, knownTags);
  const before = snapshot(store);
  for (const patch of [{ name: "新的菜名" }, { stall: "档口乙" }, { price: 10 }, { unit: "个" }]) {
    assert.throws(() => updateDish(store, original.id, patch), /重新确认标签核验依据/);
    assert.deepEqual(snapshot(store), before);
  }
  const confirmed = updateDish(store, original.id, { name: "改名并重新核验", labelSource: "改名后厨房重新核验", expectedRevision: verified.revision });
  assert.equal(confirmed.verifiedAt, confirmed.updatedAt);
  assert.equal(confirmed.spicy, "不辣");
  const reset = updateDish(store, original.id, { name: "改名后标签待查", ...unknownTags });
  assert.equal(reset.verifiedAt, undefined);
  assert.equal(reset.spicy, "未知");
  assert.equal(reset.calories, null);
});

test("classification changes are explicit candidate overrides without rewriting source identity", t => {
  const store = setup(t);
  const next = updateDish(store, original.id, { category: "主食杂粮" });
  assert.equal(next.catalogManualOverride, true);
  assert.equal(next.sourceName, undefined);
  assert.equal(next.sourceIdentity, undefined);
  assert.deepEqual(next.sources, original.sources);
  assert.deepEqual(store.get("meta", "preprocessed-stall-catalog"), { groups: [{ stall: "档口甲", records: [] }, { stall: "映射新档", records: [] }] });
});

test("optimistic revisions detect stale writes, legacy tag updates remain compatible, and no-op updates do not audit", t => {
  const store = setup(t);
  const next = updateDish(store, original.id, { english: "New English label", expectedRevision: 0 });
  assert.equal(next.revision, 1);
  const before = snapshot(store);
  assert.throws(() => updateDish(store, original.id, { english: "Stale", expectedRevision: 0 }), conflict("CATALOG_REVISION_CONFLICT"));
  assert.throws(() => archiveDish(store, original.id, { expectedRevision: 0 }), conflict("CATALOG_REVISION_CONFLICT"));
  assert.deepEqual(snapshot(store), before);
  assert.deepEqual(updateDish(store, original.id, { english: next.english, expectedRevision: 1 }), next);
  assert.deepEqual(snapshot(store), before);
  assert.throws(() => updateDish(store, original.id, { expectedRevision: 1 }), /至少修改/);
  assert.equal(updateDish(store, original.id, knownTags).revision, 2);
  for (const expectedRevision of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER]) assert.throws(() => updateDish(store, original.id, { english: "test", expectedRevision }), /数据版本/);
});

test("identity deduplication ignores whitespace and archived rows, but keeps price/unit/stall differences", t => {
  const store = setup(t);
  const before = snapshot(store);
  assert.throws(() => createDish(store, { ...creation, name: " 清 炒 西 兰 花 ", price: 8 }), conflict("CATALOG_DUPLICATE"));
  assert.deepEqual(snapshot(store), before);
  assert.throws(() => updateDish(store, "D-SECOND", { name: original.name, stall: original.stall }), conflict("CATALOG_DUPLICATE"));
  for (const patch of [{ price: 9 }, { unit: "100g" }, { stall: "档口乙" }]) assert.ok(createDish(store, { name: original.name, stall: original.stall, price: original.price, unit: original.unit, ...patch }).id);
  archiveDish(store, original.id);
  const replacement = createDish(store, { name: original.name, stall: original.stall, price: original.price, unit: original.unit });
  assert.ok(replacement.id !== original.id);
  const archived = store.get("dishes", original.id);
  assert.throws(() => restoreDish(store, original.id, { expectedRevision: archived.revision }), conflict("CATALOG_DUPLICATE"));
  assert.deepEqual(store.get("dishes", original.id), archived);
});

test("historical same-identity duplicates still permit legacy label and metadata maintenance", t => {
  const store = setup(t);
  const duplicate = { ...original, id: "D-LEGACY-DUPLICATE", sources: [{ ...source, row: 18 }] };
  store.put("dishes", duplicate.id, duplicate);
  const verified = updateDish(store, original.id, knownTags);
  assert.equal(verified.verifiedAt, verified.updatedAt);
  assert.equal(verified.revision, 1);
  assert.deepEqual(verified.sources, original.sources);
  const maintained = updateDish(store, original.id, { english: "Updated display label", active: false, expectedRevision: 1 });
  assert.equal(maintained.english, "Updated display label");
  assert.equal(maintained.active, false);
  assert.equal(maintained.revision, 2);
  assert.deepEqual(store.get("dishes", duplicate.id), duplicate);
  const before = snapshot(store);
  assert.throws(() => createDish(store, { name: original.name, stall: original.stall, price: original.price, unit: original.unit }), conflict("CATALOG_DUPLICATE"));
  assert.throws(() => updateDish(store, "D-SECOND", { name: original.name, stall: original.stall }), conflict("CATALOG_DUPLICATE"));
  assert.deepEqual(snapshot(store), before);
});

test("full-form label updates with unchanged price and unit preserve original price formatting", t => {
  const store = setup(t);
  const updated = updateDish(store, original.id, { ...knownTags, price: original.price, unit: original.unit, expectedRevision: 0 });
  assert.equal(updated.priceText, original.priceText);
  assert.equal(updated.sourceIdentity, undefined);
  assert.equal(updated.sourceName, undefined);
  assert.equal(updated.catalogManualOverride, undefined);
  assert.equal(updated.verifiedAt, updated.updatedAt);
  assert.deepEqual(updated.sources, original.sources);
  const changedPrice = updateDish(store, original.id, { ...knownTags, price: 10, unit: original.unit, expectedRevision: 1 });
  assert.equal(changedPrice.priceText, "10/份");
  assert.equal(changedPrice.sourceIdentity.priceText, original.priceText);
});

test("delete and restore are reversible, idempotent and retain dependent records and active state", t => {
  const store = setup(t);
  store.put("plans", "P-HISTORY", { id: "P-HISTORY", entries: [{ dishId: original.id, dishName: original.name }] });
  store.put("transactions", "T-HISTORY", { id: "T-HISTORY", dishId: original.id, dishName: original.name });
  store.put("menuRuns", "MR-HISTORY", { id: "MR-HISTORY", status: "completed", snapshots: { dishes: [original] } });
  const protectedBefore = Object.fromEntries(["plans", "transactions", "menuRuns", "meta"].map(key => [key, store.all(key)]));
  const archived = archiveDish(store, original.id, { expectedRevision: 0 });
  assert.equal(archived.active, false);
  assert.equal(archived.activeBeforeArchive, true);
  assert.ok(archived.deletedAt);
  assert.equal(archived.revision, 1);
  assert.deepEqual(archived.sources, original.sources);
  assert.deepEqual(archiveDish(store, original.id, { expectedRevision: 0 }), archived, "same request can be retried");
  assert.equal(store.all("audit").length, 1);
  assert.throws(() => updateDish(store, original.id, { active: true }), conflict("CATALOG_ARCHIVED"));
  assert.throws(() => restoreDish(store, original.id, { expectedRevision: 0 }), conflict("CATALOG_REVISION_CONFLICT"));
  const restored = restoreDish(store, original.id, { expectedRevision: 1 });
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.activeBeforeArchive, undefined);
  assert.equal(restored.active, true);
  assert.equal(restored.revision, 2);
  assert.deepEqual(restoreDish(store, original.id, { expectedRevision: 1 }), restored);
  assert.equal(store.all("audit").length, 2);
  const disabled = archiveDish(store, "D-SECOND");
  assert.equal(disabled.activeBeforeArchive, false);
  assert.equal(restoreDish(store, "D-SECOND").active, false);
  assert.deepEqual(Object.fromEntries(Object.keys(protectedBefore).map(key => [key, store.all(key)])), protectedBefore);
  assert.equal(store.all("dishes").length, 2);
  assert.deepEqual(store.all("audit").map(item => item.kind), ["dish.archived", "dish.restored", "dish.archived", "dish.restored"]);
});

test("every catalog mutation refuses while a menu run is running and never stops it", t => {
  const store = setup(t);
  const archived = archiveDish(store, "D-SECOND");
  const running = { id: "MR-ACTIVE", status: "running", stage: "planning", currentWeek: 2 };
  store.put("menuRuns", running.id, running);
  const before = snapshot(store);
  for (const action of [() => createDish(store, creation), () => updateDish(store, original.id, { english: "New" }), () => archiveDish(store, original.id),
    () => restoreDish(store, archived.id), () => archiveDish(store, archived.id), () => restoreDish(store, original.id)]) {
    assert.throws(action, conflict("CATALOG_GENERATION_RUNNING"));
    assert.deepEqual(snapshot(store), before);
  }
  store.put("menuRuns", running.id, { ...running, status: "cancelled" });
  assert.ok(createDish(store, creation).id);
});

test("missing IDs and illegal payloads do not create tombstones or audit rows", t => {
  const store = setup(t);
  const before = snapshot(store);
  for (const id of ["missing", "", null]) {
    assert.throws(() => updateDish(store, id, { english: "New" }), /不存在/);
    assert.throws(() => archiveDish(store, id), /不存在/);
    assert.throws(() => restoreDish(store, id), /不存在/);
  }
  assert.throws(() => archiveDish(store, original.id, { expectedRevision: -1 }), /数据版本/);
  assert.throws(() => restoreDish(store, original.id, { active: true }), /不可修改/);
  assert.deepEqual(snapshot(store), before);
});

test("audit failures roll back create, update, archive and restore atomically", t => {
  const store = setup(t);
  const archived = archiveDish(store, "D-SECOND");
  const broken = { ...store, put(collection, id, value) { if (collection === "audit") throw new Error("audit unavailable"); return store.put(collection, id, value); } };
  for (const action of [() => createDish(broken, creation), () => updateDish(broken, original.id, { english: "Change" }),
    () => archiveDish(broken, original.id), () => restoreDish(broken, archived.id)]) {
    const before = snapshot(store);
    assert.throws(action, /audit unavailable/);
    assert.deepEqual(snapshot(store), before);
  }
});
