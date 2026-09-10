import { prepareStallCatalog } from "./stall-catalog.mjs";
import { STALL_CATALOG_KEY, catalogFingerprint } from "./stored-stall-catalog.mjs";
import { audit } from "./settings.mjs";

const identity = dish => JSON.stringify([dish.stall, dish.name.replace(/\s/g, ""), dish.price, dish.unit]);
const sourceKey = source => JSON.stringify([source.file, source.fileSha256, source.sheet, source.row, source.nameCell, source.priceCell]);
const mergeSources = (existing, added) => {
  const sources = [...existing];
  const keys = new Set(existing.map(sourceKey));
  for (const source of added) if (!keys.has(sourceKey(source))) { sources.push(source); keys.add(sourceKey(source)); }
  return sources;
};

export function planStallCatalogImport(store, loaded) {
  if (!loaded?.records?.length || !loaded.source?.sha256 || !loaded.coveredStalls?.length)
    throw new Error("原始菜单解析结果不完整，未入库");
  const dishes = store.all("dishes");
  const byIdentity = new Map();
  const byId = new Map(dishes.map(dish => [dish.id, dish]));
  for (const dish of dishes) {
    const key = identity(dish);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(dish);
  }
  const writes = new Map();
  let inserted = 0;
  let reused = 0;
  let sourcesUpdated = 0;
  const ambiguities = [];
  for (const record of loaded.records) {
    if (!loaded.coveredStalls.includes(record.stall) || !record.name || !Number.isFinite(record.price) || record.price < 0 ||
        !["份", "个", "斤", "100g", "位"].includes(record.unit) || !record.sources?.length)
      throw new Error("原始菜单存在未验证条目，未入库");
    const sources = record.sources.map(source => ({ ...source, fileSha256: loaded.source.sha256, priceText: record.priceText }));
    const key = identity(record);
    const matches = byIdentity.get(key) || [];
    if (matches.length) {
      reused++;
      if (matches.length > 1) ambiguities.push({ stall: record.stall, name: record.name, dishIds: matches.map(dish => dish.id), reason: "已有多个同身份ID，保留全部，按数据库顺序选取可用项" });
      for (const match of matches) {
        const current = writes.get(match.id) || match;
        const merged = mergeSources(current.sources || [], sources);
        if (merged.length !== (current.sources || []).length) {
          if (!writes.has(match.id)) sourcesUpdated++;
          writes.set(match.id, { ...current, sources: merged });
        }
      }
      continue;
    }
    // Do not reuse the historical hash(stall|name|priceText): it can collide
    // with a legacy row whose displayed price and structural unit disagree.
    const id = "D-stall-" + catalogFingerprint(key).slice(0, 24);
    if (byId.has(id)) throw new Error("新导入菜品ID与已有记录冲突，未覆盖数据");
    const dish = { id, stall: record.stall, name: record.name, price: record.price, priceText: record.priceText, unit: record.unit,
      category: record.category || "", english: "", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "",
      calories: null, allergens: "", labelSource: "", active: true, sources };
    writes.set(id, dish); byId.set(id, dish); byIdentity.set(key, [dish]); inserted++;
  }
  const finalDishes = dishes.map(dish => writes.get(dish.id) || dish);
  for (const [id, dish] of writes) if (!dishes.some(existing => existing.id === id)) finalDishes.push(dish);
  const prepared = prepareStallCatalog(loaded, finalDishes);
  const previous = store.get("meta", STALL_CATALOG_KEY);
  const { fingerprint: _fingerprint, ...base } = prepared;
  const catalogBody = { ...base, storageMode: "database", importVersion: "stall-import-v1",
    importedAt: previous?.storageMode === "database" && previous.source?.sha256 === loaded.source.sha256 ? previous.importedAt : new Date().toISOString(), ambiguities };
  const catalog = { ...catalogBody, fingerprint: catalogFingerprint(catalogBody) };
  const changed = writes.size > 0 || previous?.fingerprint !== catalog.fingerprint;
  return { inserted, reused, sourcesUpdated, changed, stats: loaded.stats, ambiguities, catalog, writes: [...writes.values()] };
}

export function importStallCatalog(store, loaded) {
  return store.atomic(() => {
    if (store.all("menuRuns").some(run => run.status === "running"))
      throw new Error("菜单正在生成，请完成后再导入，避免中途更换候选库");
    const { writes, ...report } = planStallCatalogImport(store, loaded);
    if (!report.changed) return report;
    for (const dish of writes) store.put("dishes", dish.id, dish);
    store.put("meta", STALL_CATALOG_KEY, report.catalog);
    audit(store, "menu.stall_catalog_imported", loaded.source.file, { sha256: loaded.source.sha256, inserted: report.inserted, reused: report.reused,
      sourcesUpdated: report.sourcesUpdated, stats: loaded.stats, groups: report.catalog.groups.map(group => ({ stall: group.stall, origin: group.origin, candidateCount: group.candidateIds.length })) });
    return report;
  });
}
