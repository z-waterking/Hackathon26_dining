import { createHash } from "node:crypto";

const SOURCE_FILE = "餐厅排菜规则+示例.xlsx";
const clean = (value) => String(value ?? "").replace(/[\u200b-\u200f\ufeff]/g, "").trim();
const nameKey = (value) => clean(value).replace(/\s/g, "");
const identity = (dish) => JSON.stringify([dish.stall, nameKey(dish.name), dish.price, dish.unit]);
const canonicalPriceText = (dish) => `${dish.price}元/${dish.unit}`;
export const fixedDishRepairId = (dish) => `D-${createHash("sha256").update(`${dish.stall}|${nameKey(dish.name)}|${canonicalPriceText(dish)}`).digest("hex").slice(0, 16)}`;

// Pure proposal builder. It never changes, disables or replaces an existing
// catalog record, including an inactive match or the historically wrong rows.
export function planFixedDishCatalogRepair(existingDishes, fixedDishes) {
  if (!Array.isArray(existingDishes) || !Array.isArray(fixedDishes) || fixedDishes.length !== 4)
    throw new Error("修复需要完整的四条可信宽窄巷子午晚餐固定出品来源");
  const byId = new Map();
  const existingByIdentity = new Map();
  for (const dish of existingDishes) {
    if (!dish?.id || byId.has(dish.id)) throw new Error("现有菜库ID缺失或重复，拒绝修复");
    byId.set(dish.id, dish);
    const key = identity(dish);
    if (!existingByIdentity.has(key)) existingByIdentity.set(key, []);
    existingByIdentity.get(key).push(dish);
  }
  const groups = new Map();
  const sourceHashes = new Set();
  for (const dish of fixedDishes) {
    const source = dish.source;
    if (dish.stall !== "宽窄巷子" || !["午餐", "晚餐"].includes(dish.meal) ||
      !clean(dish.name) || !Number.isFinite(dish.price) || dish.price <= 0 || !["100g", "份", "个", "斤"].includes(dish.unit) ||
      source?.file !== SOURCE_FILE || !source.sheet?.includes("宽窄巷子") || !/^[a-f0-9]{64}$/i.test(source.fileSha256 || "") ||
      !["C14", "C15", "C49", "C50"].includes(source.cell) || source.priceCell !== source.cell.replace("C", "D") ||
      !Number.isInteger(source.row) || source.cell !== `C${source.row}` ||
      (dish.meal === "午餐" ? ![14, 15].includes(source.row) : ![49, 50].includes(source.row)))
      throw new Error("固定出品来源、菜名、价格或单位不完整，拒绝猜测或修复");
    sourceHashes.add(source.fileSha256);
    const key = identity(dish);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dish);
  }
  if (sourceHashes.size !== 1 || groups.size !== 2 || [...groups.values()].some((group) =>
    group.length !== 2 || new Set(group.map((dish) => dish.meal)).size !== 2))
    throw new Error("午晚餐固定出品未对应两种相同菜品，拒绝部分修复");
  const additions = [];
  const existing = [];
  for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sourceDish = group.find((dish) => dish.meal === "午餐");
    const id = fixedDishRepairId(sourceDish);
    const collision = byId.get(id);
    if (collision && identity(collision) !== key) throw new Error(`稳定菜品ID冲突，拒绝覆盖 ${id}`);
    const matches = existingByIdentity.get(key) || [];
    if (matches.length) {
      existing.push({ name: clean(sourceDish.name), ids: matches.map((dish) => dish.id), active: matches.some((dish) => dish.active === true) });
      continue;
    }
    additions.push({ id, stall: sourceDish.stall, name: clean(sourceDish.name), price: sourceDish.price,
      priceText: canonicalPriceText(sourceDish), unit: sourceDish.unit, category: "固定出品", english: "",
      spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "", active: true,
      sources: group.map((dish) => ({ ...structuredClone(dish.source), meal: dish.meal })).sort((left, right) => left.row - right.row),
    });
  }
  return { additions, existing, sourceSha256: [...sourceHashes][0] };
}
