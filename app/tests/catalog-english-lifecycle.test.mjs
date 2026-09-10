import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository, COLLECTIONS } from "../server/data/repository.mjs";
import { createDish, updateDish, archiveDish, restoreDish } from "../server/catalog-service.mjs";
import { readStallCatalog, STALL_CATALOG_KEY } from "../server/stored-stall-catalog.mjs";
import { englishNameSummary, prepareCatalogEnglish } from "../server/catalog-english.mjs";

const source = { file: "原始菜单.xlsx", sheet: "菜品", row: 5, nameCell: "B5", priceCell: "C5" };
const original = { id: "D-ENGLISH", name: "清炒西兰花", english: "Stir-fried Broccoli", stall: "档口甲", price: 8, unit: "份", priceText: "8元/份",
  category: "热菜", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "",
  active: true, sources: [source], raw: { name: "清炒西兰花", english: "Stir-fried Broccoli" }, revision: 3 };
const aiMetadata = { sourceName: original.name, origin: "ai", status: "needs_review", updatedAt: "2026-09-09T00:00:00Z", model: "translation-model" };
const knownLabels = { spicy: "不辣", vegetarian: "素食", mainIngredient: "西兰花", method: "炒", labelSource: "厨房现场核验", verifiedAt: "2026-09-08T00:00:00Z" };

function setup(t, item = original) {
  const store = createRepository(createMemoryAdapter(), () => ({ dishes: [item] }));
  store.put("meta", STALL_CATALOG_KEY, { storageMode: "database", source: { file: source.file }, groups: [{ stall: item.stall, origin: "primary",
    records: [{ name: item.name, price: item.price, unit: item.unit, category: item.category, dishIds: [item.id], sources: [source] }],
    candidateIds: [item.id], unresolved: [] }] });
  t.after(() => store.close());
  return store;
}
const snapshot = store => Object.fromEntries(COLLECTIONS.map(collection => [collection, store.all(collection)]));
const creation = { name: "菌菇炖豆腐", stall: original.stall, price: 12, unit: "份" };
const formFields = ["name", "english", "stall", "price", "unit", "category", "spicy", "vegetarian", "mainIngredient", "method", "calories", "allergens", "labelSource", "active"];
const fullForm = item => Object.fromEntries(formFields.filter(field => item[field] !== undefined && (field !== "labelSource" || item[field])).map(field => [field, item[field]]));
const englishState = (dish, status = "ready") => ({ sourceName: dish.name, origin: "manual", status, updatedAt: dish.updatedAt });

test("manual creation stores trimmed English against the current Chinese name and missing metadata for empty defaults", t => {
  const store = setup(t);
  const named = createDish(store, { ...creation, name: "  菌菇炖豆腐  ", english: "  Tofu with Mushrooms  " });
  assert.equal(named.name, creation.name);
  assert.equal(named.english, "Tofu with Mushrooms");
  assert.deepEqual(named.englishName, englishState(named));
  assert.equal(named.englishName.updatedAt, named.createdAt);
  assert.equal(named.sourceName, undefined);
  assert.equal(named.englishHistory, undefined);
  assert.deepEqual(store.get("dishes", named.id).englishName, named.englishName);
  const omitted = createDish(store, { ...creation, name: "无英文新品" });
  assert.equal(omitted.english, "");
  assert.deepEqual(omitted.englishName, englishState(omitted, "missing"));
  const blank = createDish(store, { ...creation, name: "手工留空新品", english: "  " });
  assert.equal(blank.english, "");
  assert.deepEqual(blank.englishName, englishState(blank, "missing"));
});

test("invalid nonempty manual English is retained for review without automatic translation or false ready metadata", async t => {
  const store = setup(t);
  for (const [index, english] of ["手工填写中文", "Broccoli 西兰花", "12345", "Broccoli\nName"].entries()) {
    const added = createDish(store, { ...creation, name: `待核对英文菜${index}`, english });
    assert.equal(added.english, english);
    assert.deepEqual(added.englishName, englishState(added, "needs_review"));
  }
  const updated = updateDish(store, original.id, { english: "不是英文", expectedRevision: 3 });
  assert.deepEqual(updated.englishName, englishState(updated, "needs_review"));
  assert.equal(updated.catalogManualOverride, undefined);
  assert.deepEqual(englishNameSummary(store), { total: 5, ready: 0, missing: 0, needsReview: 5, uniqueMissing: 0 });
  let calls = 0;
  const before = store.all("dishes");
  const result = await prepareCatalogEnglish(store, { async respond() { calls++; throw new Error("Unexpected translation"); } });
  assert.equal(calls, 0);
  assert.equal(result.filled, 0);
  assert.deepEqual(store.all("dishes"), before);
  const fixed = updateDish(store, original.id, { english: "Manually Corrected Broccoli", expectedRevision: 4 });
  assert.deepEqual(fixed.englishName, englishState(fixed));
  assert.equal(englishNameSummary(store).ready, 1);
});

test("changing English alone sets manual-ready metadata without changing candidates, source provenance or verification", t => {
  const item = { ...original, ...knownLabels, sourceName: "配方原菜名", englishName: aiMetadata };
  const store = setup(t, item);
  const catalog = readStallCatalog(store);
  const updated = updateDish(store, item.id, { english: " Broccoli Sauté ", expectedRevision: 3 });
  assert.equal(updated.english, "Broccoli Sauté");
  assert.deepEqual(updated.englishName, englishState(updated));
  assert.equal(updated.verifiedAt, item.verifiedAt);
  assert.equal(updated.sourceName, item.sourceName);
  assert.equal(updated.sourceIdentity, undefined);
  assert.equal(updated.catalogManualOverride, undefined);
  assert.equal(updated.englishHistory, undefined);
  assert.deepEqual(updated.sources, item.sources);
  assert.deepEqual(updated.raw, item.raw);
  assert.equal(updated.revision, 4);
  assert.deepEqual(readStallCatalog(store), catalog);
  assert.deepEqual(store.all("audit")[0].fields, ["english"]);
});

test("an English-only full-form save cannot renew a kitchen verification or approve previously unverified labels", t => {
  for (const verified of [true, false]) {
    const item = { ...original, ...knownLabels, englishName: aiMetadata };
    if (!verified) delete item.verifiedAt;
    const store = setup(t, item);
    const catalog = readStallCatalog(store);
    const updated = updateDish(store, item.id, { ...fullForm(item), english: "Manually Edited Broccoli", expectedRevision: 3 });
    assert.equal(updated.verifiedAt, item.verifiedAt);
    assert.equal(updated.catalogManualOverride, undefined);
    assert.deepEqual(updated.englishName, englishState(updated));
    assert.deepEqual(readStallCatalog(store), catalog);
  }
});

test("English metadata uses the trimmed current name even for legacy source rows with surrounding whitespace", t => {
  const item = { ...original, name: `  ${original.name}  `, sourceName: "配方原名" };
  const store = setup(t, item);
  const updated = updateDish(store, item.id, { english: "New Broccoli Translation", expectedRevision: 3 });
  assert.equal(updated.name, item.name);
  assert.equal(updated.englishName.sourceName, original.name);
  assert.equal(updated.sourceName, item.sourceName);
  assert.equal(updated.catalogManualOverride, undefined);
});

test("unchanged full-form or unrelated saves retain AI origin and review status rather than approving its suggestion", t => {
  const item = { ...original, ...knownLabels, englishName: aiMetadata };
  const store = setup(t, item);
  const before = snapshot(store);
  const noop = updateDish(store, item.id, { ...fullForm(item), english: `  ${item.english}  `, expectedRevision: 3 });
  assert.deepEqual(noop, item);
  assert.deepEqual(snapshot(store), before);
  const updated = updateDish(store, item.id, { ...fullForm(item), active: false, expectedRevision: 3 });
  assert.deepEqual(updated.englishName, aiMetadata);
  assert.equal(updated.english, item.english);
  assert.equal(updated.englishHistory, undefined);
});

test("renaming without a genuinely new English label clears the stale pair and records its original source", t => {
  for (const input of [{ name: "西兰花炒木耳" }, { name: "西兰花炒木耳", english: original.english },
    { name: "西兰花炒木耳", english: ` ${original.english} ` }]) {
    const store = setup(t);
    const updated = updateDish(store, original.id, { ...input, expectedRevision: 3 });
    assert.equal(updated.english, "");
    assert.deepEqual(updated.englishName, englishState(updated, "missing"));
    assert.deepEqual(updated.englishHistory, [{ sourceName: original.name, english: original.english, origin: "source", changedAt: updated.updatedAt }]);
    assert.equal(updated.sourceName, original.name);
    assert.equal(updated.catalogManualOverride, true);
    assert.deepEqual(updated.sources, original.sources);
    assert.deepEqual(updated.raw, original.raw);
  }
});

test("renaming with a new English label stores the new manual pair and retains the old AI pair in history", t => {
  const item = { ...original, sourceName: "不可改写的配方原名", englishName: aiMetadata };
  const store = setup(t, item);
  const updated = updateDish(store, item.id, { name: "  西兰花炒木耳  ", english: "  Broccoli with Wood Ear Mushrooms  ", expectedRevision: 3 });
  assert.equal(updated.name, "西兰花炒木耳");
  assert.equal(updated.english, "Broccoli with Wood Ear Mushrooms");
  assert.deepEqual(updated.englishName, englishState(updated));
  assert.deepEqual(updated.englishHistory, [{ sourceName: original.name, english: original.english, origin: "ai", changedAt: updated.updatedAt }]);
  assert.equal(updated.sourceName, item.sourceName);
  assert.notEqual(updated.englishName.sourceName, updated.sourceName);
  assert.deepEqual(updated.sources, item.sources);
});

test("explicitly clearing English leaves missing metadata and never immediately fills from history or prior AI metadata", t => {
  const item = { ...original, englishName: aiMetadata, englishHistory: [{ sourceName: "历史名称", english: "History", origin: "manual", changedAt: "2026-09-01T00:00:00Z" }] };
  const store = setup(t, item);
  const updated = updateDish(store, item.id, { english: "  ", expectedRevision: 3 });
  assert.equal(updated.english, "");
  assert.deepEqual(updated.englishName, englishState(updated, "missing"));
  assert.deepEqual(updated.englishHistory, item.englishHistory);
  assert.equal(updated.catalogManualOverride, undefined);
  const before = snapshot(store);
  assert.deepEqual(updateDish(store, item.id, { english: "", expectedRevision: 4 }), updated);
  assert.deepEqual(snapshot(store), before);
  const renamed = updateDish(store, item.id, { name: "英文仍待补", english: "", expectedRevision: 4 });
  assert.equal(renamed.english, "");
  assert.deepEqual(renamed.englishName, englishState(renamed, "missing"));
  assert.deepEqual(renamed.englishHistory, item.englishHistory, "an empty old label cannot create a meaningless history row");
});

test("explicit empty English while renaming archives the previous pair instead of retaining the old translation", t => {
  const item = { ...original, englishName: { ...aiMetadata, origin: "manual", status: "ready" } };
  const store = setup(t, item);
  const updated = updateDish(store, item.id, { name: "新菜名待译", english: "", expectedRevision: 3 });
  assert.equal(updated.english, "");
  assert.deepEqual(updated.englishName, englishState(updated, "missing"));
  assert.equal(updated.englishHistory[0].origin, "manual");
  assert.equal(updated.englishHistory[0].sourceName, original.name);
});

test("English history retains at most the newest twenty name pairs across repeated renames", t => {
  const store = setup(t);
  let current = original;
  const expected = [];
  for (let index = 0; index < 25; index++) {
    const previous = current;
    current = updateDish(store, original.id, { name: `菜品新名${index}`, english: `Dish Translation ${index}`, expectedRevision: previous.revision });
    expected.push({ sourceName: previous.name, english: previous.english, origin: previous.englishName?.origin || "source", changedAt: current.updatedAt });
    assert.deepEqual(current.englishHistory, expected.slice(-20));
    assert.ok(current.englishHistory.length <= 20);
  }
  assert.equal(current.englishHistory.length, 20);
  assert.equal(current.sourceName, original.name);
  assert.equal(current.englishName.sourceName, current.name);
});

test("English-only changes do not erase an existing catalog override or append renamed-history rows", t => {
  const item = { ...original, origin: "manual", catalogManualOverride: true, englishName: aiMetadata,
    englishHistory: [{ sourceName: "曾用名", english: "Previous", origin: "source", changedAt: "2026-09-01T00:00:00Z" }] };
  const store = setup(t, item);
  const catalog = readStallCatalog(store);
  const updated = updateDish(store, item.id, { english: "Verified Manual Translation", expectedRevision: 3 });
  assert.equal(updated.catalogManualOverride, true);
  assert.deepEqual(updated.englishHistory, item.englishHistory);
  assert.deepEqual(readStallCatalog(store), catalog);
});

test("English metadata and history are protected server-owned fields on every catalog mutation", t => {
  const store = setup(t);
  for (const [field, value] of [["englishName", { sourceName: "forged", origin: "manual", status: "ready" }],
    ["englishHistory", [{ sourceName: "forged", english: "forged" }]], ["sourceName", "forged"]]) {
    const before = snapshot(store);
    const invalid = error => error.code === "CATALOG_INVALID_INPUT" && error.statusCode === 400 && !error.message.includes("forged");
    assert.throws(() => createDish(store, { ...creation, [field]: value }), invalid);
    assert.throws(() => updateDish(store, original.id, { english: "Changed", [field]: value }), invalid);
    assert.throws(() => archiveDish(store, original.id, { [field]: value }), invalid);
    assert.throws(() => restoreDish(store, original.id, { [field]: value }), invalid);
    assert.deepEqual(snapshot(store), before);
  }
});

test("English lifecycle changes are revision-checked, blocked during generation and rolled back with audit failures", t => {
  const store = setup(t, { ...original, englishName: aiMetadata });
  let before = snapshot(store);
  assert.throws(() => updateDish(store, original.id, { name: "过期改名", expectedRevision: 2 }), error => error.code === "CATALOG_REVISION_CONFLICT");
  assert.deepEqual(snapshot(store), before);
  store.put("menuRuns", "MR-ACTIVE", { id: "MR-ACTIVE", status: "running" });
  before = snapshot(store);
  assert.throws(() => updateDish(store, original.id, { english: "New Translation", expectedRevision: 3 }), error => error.code === "CATALOG_GENERATION_RUNNING");
  assert.deepEqual(snapshot(store), before);
  store.put("menuRuns", "MR-ACTIVE", { id: "MR-ACTIVE", status: "completed" });
  const failing = { ...store, put(collection, id, value) { if (collection === "audit") throw new Error("audit unavailable"); return store.put(collection, id, value); } };
  before = snapshot(store);
  assert.throws(() => updateDish(failing, original.id, { name: "失败的改名", english: "New Pair", expectedRevision: 3 }), /audit unavailable/);
  assert.throws(() => createDish(failing, { ...creation, english: "New English" }), /audit unavailable/);
  assert.deepEqual(snapshot(store), before);
});

test("archive and restore preserve the current English pair, review status and bounded history", t => {
  const item = { ...original, englishName: aiMetadata, englishHistory: [{ sourceName: "旧名", english: "Old", origin: "source", changedAt: "2026-09-01T00:00:00Z" }] };
  const store = setup(t, item);
  const archived = archiveDish(store, item.id, { expectedRevision: 3 });
  const restored = restoreDish(store, item.id, { expectedRevision: 4 });
  for (const result of [archived, restored]) {
    assert.equal(result.english, item.english);
    assert.deepEqual(result.englishName, item.englishName);
    assert.deepEqual(result.englishHistory, item.englishHistory);
  }
});
