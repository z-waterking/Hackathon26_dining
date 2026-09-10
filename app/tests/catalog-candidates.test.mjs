import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { readStallCatalog, STALL_CATALOG_KEY } from "../server/stored-stall-catalog.mjs";

const source = { file: "原始菜单.xlsx", sha256: "a".repeat(64) };
const evidence = { file: source.file, fileSha256: source.sha256, sheet: "档口甲", row: 4, nameCell: "B4", priceCell: "C4" };
const dish = (id, extra = {}) => ({ id, name: `菜品${id}`, stall: "档口甲", price: 12, unit: "份",
  category: "热菜", active: true, origin: "imported", sources: [evidence], ...extra });
const record = (item, extra = {}) => ({ stall: item.stall, name: item.name, price: item.price, unit: item.unit, category: item.category,
  sources: [evidence], raw: { name: item.name, priceText: "12元/份" }, dishIds: [item.id], candidateId: item.id, ...extra });
const primary = (stall, records = []) => ({ stall, origin: "primary", records, candidateIds: records.map(item => item.candidateId), unresolved: [] });
function setup(t, dishes, groups) {
  const store = createRepository(createMemoryAdapter(), () => ({ dishes }));
  t.after(() => store.close());
  store.put("meta", STALL_CATALOG_KEY, { storageMode: "database", source, fingerprint: "import-time-fingerprint", groups });
  return store;
}
const groupAt = (store, stall = "档口甲") => readStallCatalog(store).groups.find(item => item.stall === stall);
const update = (store, id, values) => store.put("dishes", id, { ...store.get("dishes", id), ...values });

test("manual additions join a mapped stall but unmapped legacy/imported dishes cannot bypass the source mapping", t => {
  const mapped = dish("D-source");
  const manual = dish("D-manual", { origin: "manual", sources: [] });
  const legacy = dish("D-legacy");
  const invalidOverride = dish("D-invalid", { catalogManualOverride: "true" });
  const store = setup(t, [mapped, manual, legacy, invalidOverride], [primary(mapped.stall, [record(mapped)])]);
  const group = groupAt(store);
  assert.deepEqual(group.candidateIds, [mapped.id, manual.id]);
  assert.equal(group.unresolved.length, 0);
  const added = group.records.find(item => item.candidateId === manual.id);
  assert.equal(added.origin, "manual");
  assert.deepEqual(added.dishIds, [manual.id]);
  assert.deepEqual(added.sources, [{ type: "manual", dishId: manual.id }]);
});

test("renamed or repriced source dishes use an explicit manual override record without rewriting original evidence", t => {
  const original = dish("D-source");
  const sourceRecord = record(original);
  const changed = { ...original, name: "运营新菜名", price: 15, unit: "位", catalogManualOverride: true,
    sourceName: original.name, sourceIdentity: { name: original.name, stall: original.stall, price: original.price, unit: original.unit } };
  const store = setup(t, [changed], [primary(original.stall, [sourceRecord])]);
  const before = { meta: store.get("meta", STALL_CATALOG_KEY), dishes: store.all("dishes") };
  const group = groupAt(store);
  assert.deepEqual(group.candidateIds, [original.id]);
  assert.deepEqual(group.records[0], { ...sourceRecord, candidateId: null });
  const added = group.records[1];
  assert.deepEqual([added.name, added.price, added.unit, added.origin], [changed.name, 15, "位", "manual-override"]);
  assert.deepEqual(added.sources, [{ type: "manual-override", dishId: original.id }]);
  assert.equal(added.sources.some(item => item.file || item.sheet || item.row), false);
  assert.deepEqual({ meta: store.get("meta", STALL_CATALOG_KEY), dishes: store.all("dishes") }, before);
  assert.equal(group.unresolved.length, 0);
});

test("an explicitly relocated source dish joins its new mapped stall and is not reported missing at its old stall", t => {
  const original = dish("D-moved");
  const other = dish("D-other", { stall: "档口乙" });
  const store = setup(t, [{ ...original, stall: other.stall, catalogManualOverride: true }, other],
    [primary(original.stall, [record(original)]), primary(other.stall, [record(other)])]);
  const oldGroup = groupAt(store, original.stall);
  const nextGroup = groupAt(store, other.stall);
  assert.deepEqual(oldGroup.candidateIds, []);
  assert.deepEqual(oldGroup.records[0], { ...record(original), candidateId: null });
  assert.equal(oldGroup.unresolved.length, 0);
  assert.deepEqual(nextGroup.candidateIds, [other.id, original.id]);
  assert.equal(nextGroup.records.find(item => item.candidateId === original.id).origin, "manual-override");
});

test("a stall change without explicit override cannot authorize an unmapped imported candidate at the destination", t => {
  const original = dish("D-moved");
  const store = setup(t, [{ ...original, stall: "档口乙" }], [primary(original.stall, [record(original)]), primary("档口乙")]);
  assert.deepEqual(groupAt(store, original.stall).candidateIds, []);
  assert.equal(groupAt(store, original.stall).unresolved.length, 0);
  assert.deepEqual(groupAt(store, "档口乙").candidateIds, []);
});

test("disabled and soft-deleted source dishes retain source mappings without becoming unresolved or eligible", t => {
  const disabled = dish("D-disabled", { active: false });
  const archived = dish("D-archived", { deletedAt: "2026-09-10T01:00:00Z" });
  const unknownActive = dish("D-no-active", { active: undefined });
  const store = setup(t, [disabled, archived, unknownActive], [primary(disabled.stall, [record(disabled), record(archived), record(unknownActive)])]);
  const first = groupAt(store);
  assert.deepEqual(first.candidateIds, []);
  assert.equal(first.records.length, 3);
  assert.ok(first.records.every(item => item.candidateId === null));
  assert.deepEqual(first.unresolved, []);
  update(store, archived.id, { deletedAt: null, active: true });
  assert.deepEqual(groupAt(store).candidateIds, [archived.id]);
});

test("soft-deleted or inactive manual and override entries are excluded, and restoration returns only active entries", t => {
  const entries = [
    dish("D-manual-inactive", { origin: "manual", active: false }),
    dish("D-manual-deleted", { origin: "manual", deletedAt: "2026-09-10T01:00:00Z" }),
    dish("D-override-inactive", { catalogManualOverride: true, active: false }),
    dish("D-override-deleted", { catalogManualOverride: true, deletedAt: "2026-09-10T01:00:00Z" }),
  ];
  const store = setup(t, entries, [primary("档口甲")]);
  assert.deepEqual(groupAt(store).candidateIds, []);
  update(store, entries[1].id, { deletedAt: null });
  update(store, entries[2].id, { active: true });
  assert.deepEqual(groupAt(store).candidateIds, [entries[1].id, entries[2].id]);
});

test("manual category overrides can leave source staple classification without modifying the original source row", t => {
  const original = dish("D-staple", { category: "主食杂粮" });
  const stillStaple = dish("D-manual-staple", { origin: "manual", category: "主食杂粮" });
  const store = setup(t, [{ ...original, category: "热菜", catalogManualOverride: true }, stillStaple],
    [primary(original.stall, [record(original)])]);
  const group = groupAt(store);
  assert.deepEqual(group.candidateIds, [original.id]);
  assert.equal(group.records[0].category, "主食杂粮");
  assert.equal(group.records[0].candidateId, null);
  assert.equal(group.records[1].category, "热菜");
  update(store, original.id, { category: "主食杂粮" });
  assert.deepEqual(groupAt(store).candidateIds, []);
});

test("only genuinely absent linked IDs are unresolved, including duplicate mappings with an archived surviving record", t => {
  const surviving = dish("D-surviving", { active: false, deletedAt: "2026-09-10T01:00:00Z" });
  const missing = dish("D-missing");
  const store = setup(t, [surviving], [primary(surviving.stall, [
    record(surviving, { dishIds: ["D-absent-duplicate", surviving.id] }),
    record(missing),
  ])]);
  const group = groupAt(store);
  assert.deepEqual(group.candidateIds, []);
  assert.equal(group.records.length, 2);
  assert.deepEqual(group.unresolved.map(item => item.name), [missing.name]);
});

test("multiple source rows or manual identities never duplicate candidate IDs or shadow retained source evidence", t => {
  const original = dish("D-source");
  const changed = { ...original, catalogManualOverride: true };
  const manual = dish("D-manual", { origin: "manual", catalogManualOverride: true });
  const store = setup(t, [changed, manual], [primary(original.stall, [record(original), record(original, { raw: { duplicate: true } })])]);
  const group = groupAt(store);
  assert.deepEqual(group.candidateIds, [changed.id, manual.id]);
  assert.equal(group.records.length, 4);
  assert.equal(group.records.filter(item => item.candidateId === changed.id).length, 1);
  assert.equal(group.records.find(item => item.candidateId === manual.id).origin, "manual");
});

test("new manual stalls and existing supplemental stalls retain isolated pools and truthful manual provenance", t => {
  const legacy = dish("D-supp-source", { stall: "补充档口" });
  const manual = dish("D-supp-manual", { stall: legacy.stall, origin: "manual" });
  const deleted = dish("D-supp-deleted", { stall: legacy.stall, deletedAt: "2026-09-10T01:00:00Z" });
  const relocated = dish("D-new-stall", { stall: "新建档口", catalogManualOverride: true });
  const store = setup(t, [legacy, manual, deleted, relocated], [primary("档口甲"),
    { stall: legacy.stall, origin: "supplement", candidateIds: [], records: [], unresolved: [] }]);
  const supplement = groupAt(store, legacy.stall);
  assert.deepEqual(supplement.candidateIds, [legacy.id, manual.id]);
  assert.deepEqual(supplement.records[0].sources, legacy.sources);
  assert.deepEqual(supplement.records[1].sources, [{ type: "manual", dishId: manual.id }]);
  const newStall = groupAt(store, relocated.stall);
  assert.equal(newStall.origin, "supplement");
  assert.deepEqual(newStall.candidateIds, [relocated.id]);
  assert.deepEqual(newStall.records[0].sources, [{ type: "manual-override", dishId: relocated.id }]);
  assert.deepEqual(groupAt(store).candidateIds, []);
});

test("manual candidate updates and archive state change runtime fingerprints without persisting runtime projections", t => {
  const manual = dish("D-manual", { origin: "manual" });
  const store = setup(t, [manual], [primary(manual.stall)]);
  const originalMeta = store.get("meta", STALL_CATALOG_KEY);
  const first = readStallCatalog(store);
  assert.deepEqual(readStallCatalog(store), first);
  update(store, manual.id, { name: "更新的菜名", price: 16 });
  const changed = readStallCatalog(store);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(changed.groups[0].records[0].name, "更新的菜名");
  update(store, manual.id, { deletedAt: "2026-09-10T01:00:00Z" });
  assert.notEqual(readStallCatalog(store).fingerprint, changed.fingerprint);
  assert.deepEqual(store.get("meta", STALL_CATALOG_KEY), originalMeta);
});
