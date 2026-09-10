import { createHash } from "node:crypto";

export const STALL_CATALOG_KEY = "preprocessed-stall-catalog";
export const catalogFingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eligible = dish => Boolean(dish?.active && !dish.deletedAt && dish.category !== "主食杂粮");
const manuallyMaintained = dish => dish?.origin === "manual" || dish?.catalogManualOverride === true;

function candidateRecord(dish) {
  if (!manuallyMaintained(dish))
    return { name: dish.name, price: dish.price, unit: dish.unit, sources: dish.sources || [], candidateId: dish.id };
  const origin = dish.origin === "manual" ? "manual" : "manual-override";
  // Current operator-maintained details are not evidence from the original
  // workbook. Keep that evidence on the stored dish/source rows, unmodified.
  return { stall: dish.stall, name: dish.name, price: dish.price, unit: dish.unit, category: dish.category, origin,
    dishIds: [dish.id], sources: [{ type: origin, dishId: dish.id }], candidateId: dish.id };
}

// Runtime read model: all source mappings and dish information come from the
// repository. No workbook, file path, parser or file hash check is used here.
export function readStallCatalog(store) {
  const stored = store.get("meta", STALL_CATALOG_KEY);
  if (!stored) return null;
  // Recorded legacy runs and isolated service fixtures keep their old shape.
  if (stored.storageMode !== "database") return structuredClone(stored);
  if (!Array.isArray(stored.groups) || stored.groups.some(group => !Array.isArray(group.records)))
    throw new Error("已入库档口来源记录不完整，请重新执行原菜单导入");
  const dishes = store.all("dishes");
  const byId = new Map(dishes.map(dish => [dish.id, dish]));
  const groups = stored.groups.map(group => {
    if (group.origin === "supplement") {
      const pool = dishes.filter(dish => dish.stall === group.stall && eligible(dish));
      return { ...group, candidateIds: pool.map(dish => dish.id), records: pool.map(candidateRecord), unresolved: [] };
    }
    const sourceRecords = group.records.map(record => {
      const candidate = record.category === "主食杂粮" ? null : (record.dishIds || []).map(id => byId.get(id))
        .find(dish => dish?.stall === group.stall && eligible(dish) && !manuallyMaintained(dish));
      return { ...record, candidateId: candidate?.id || null };
    });
    // A disabled, archived or relocated dish still exists. Its source mapping
    // remains historical evidence, not a missing row to silently replace.
    const unresolved = sourceRecords.filter(record => !(record.dishIds || []).some(id => byId.has(id)))
      .map(record => ({ name: record.name, price: record.price, unit: record.unit, reason: "已导入来源关联的菜品记录缺失，未使用其他来源替代" }));
    // Only explicit operator changes may extend a source-backed stall's pool.
    // Unmapped historical/imported dishes must not bypass its source mapping.
    const manualRecords = dishes.filter(dish => dish.stall === group.stall && eligible(dish) && manuallyMaintained(dish))
      .map(candidateRecord);
    const records = [...sourceRecords, ...manualRecords];
    return { ...group, records, candidateIds: [...new Set(records.flatMap(record => record.candidateId ? [record.candidateId] : []))], unresolved };
  });
  // Explicitly added DB stalls without an original-sheet mapping remain
  // supplemental; they are not silently omitted from the all-stall workflow.
  for (const stall of new Set(dishes.map(dish => dish.stall))) {
    if (groups.some(group => group.stall === stall)) continue;
    const pool = dishes.filter(dish => dish.stall === stall && eligible(dish));
    groups.push({ stall, origin: "supplement", candidateIds: pool.map(dish => dish.id), records: pool.map(candidateRecord), unresolved: [] });
  }
  const { fingerprint: _fingerprint, ...base } = stored;
  const result = { ...base, groups };
  return { ...result, fingerprint: catalogFingerprint(result) };
}

export function requireStoredStallCatalog(store) {
  const catalog = readStallCatalog(store);
  if (catalog?.storageMode !== "database")
    throw new Error("原始菜单尚未正式入库。请在项目根目录执行 node tools/Import-StallCatalog.mjs --apply；运行时不自动读取Excel");
  return catalog;
}
