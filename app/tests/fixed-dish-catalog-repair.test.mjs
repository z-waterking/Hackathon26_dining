import test from "node:test";
import assert from "node:assert/strict";
import { fixedDishRepairId, planFixedDishCatalogRepair } from "../server/fixed-dish-catalog-repair.mjs";

const fixedDishes = ["午餐", "晚餐"].flatMap((meal) => ["骨汤麻辣烫", "老式麻辣烫"].map((name, index) => {
  const row = (meal === "午餐" ? 14 : 49) + index;
  return { stall: "宽窄巷子", meal, name, price: 4, unit: "100g", priceText: "4元/100g",
    source: { file: "餐厅排菜规则+示例.xlsx", sheet: "排菜规则-蒸心食意&宽窄巷子", row, cell: `C${row}`, priceCell: `D${row}`, fileSha256: "a".repeat(64) } };
}));
const existing = [
  { id: "OLD-1", stall: "宽窄巷子", name: "油条", price: 2, unit: "份", active: true, vegetarian: "素食", labelSource: "人工核验原记录" },
  { id: "OLD-2", stall: "宽窄巷子", name: "水煎包", price: 3, unit: "份", active: false },
  { id: "OTHER", stall: "其他档口", name: "骨汤麻辣烫", price: 4, unit: "100g", active: true },
];

test("pure repair proposes only two missing fixed dishes and preserves existing records without inventing labels", () => {
  const before = structuredClone({ existing, fixedDishes });
  const proposal = planFixedDishCatalogRepair(existing, fixedDishes);
  assert.equal(proposal.additions.length, 2);
  assert.equal(proposal.existing.length, 0);
  assert.deepEqual(new Set(proposal.additions.map((dish) => dish.name)), new Set(["骨汤麻辣烫", "老式麻辣烫"]));
  assert.deepEqual({ existing, fixedDishes }, before);
  for (const dish of proposal.additions) {
    assert.equal(dish.stall, "宽窄巷子");
    assert.equal(dish.price, 4);
    assert.equal(dish.unit, "100g");
    assert.equal(dish.priceText, "4元/100g");
    assert.equal(dish.active, true);
    assert.equal(dish.category, "固定出品");
    assert.equal(dish.spicy, "未知");
    assert.equal(dish.vegetarian, "未知");
    assert.equal(dish.mainIngredient, "");
    assert.equal(dish.method, "");
    assert.equal(dish.labelSource, "");
    assert.equal(dish.calories, null);
    assert.equal(dish.allergens, "");
    assert.equal(dish.sources.length, 2);
    assert.deepEqual(dish.sources.map((source) => source.meal), ["午餐", "晚餐"]);
    assert.ok(dish.sources.every((source) => source.fileSha256 === "a".repeat(64)));
  }
});

test("stable identities are independent of row order, price text formatting and file fingerprint", () => {
  const first = planFixedDishCatalogRepair(existing, fixedDishes);
  const reordered = fixedDishes.toReversed().map((dish) => ({ ...dish, priceText: "4 元 / 100克", source: { ...dish.source, fileSha256: "b".repeat(64) } }));
  const second = planFixedDishCatalogRepair(existing, reordered);
  assert.deepEqual(first.additions.map((dish) => dish.id), second.additions.map((dish) => dish.id));
  assert.equal(fixedDishRepairId(fixedDishes[0]), fixedDishRepairId({ ...fixedDishes[0], name: " 骨汤 麻辣烫 " }));
  assert.notEqual(fixedDishRepairId(fixedDishes[0]), fixedDishRepairId({ ...fixedDishes[0], unit: "份" }));
});

test("idempotent proposal does not reactivate or overwrite an existing exact match under any ID", () => {
  const first = planFixedDishCatalogRepair(existing, fixedDishes);
  const inactive = { ...first.additions[0], id: "OPERATOR-EXISTING", active: false, spicy: "辣", labelSource: "厨房核验" };
  const source = [...existing, inactive, first.additions[1]];
  const before = structuredClone(source);
  const second = planFixedDishCatalogRepair(source, fixedDishes);
  assert.equal(second.additions.length, 0);
  assert.equal(second.existing.length, 2);
  assert.equal(second.existing.filter((item) => !item.active).length, 1);
  assert.deepEqual(source, before);
});

test("price or unit differences are not treated as existing fixed dishes", () => {
  const source = [
    { ...fixedDishes[0], id: "WRONG-PRICE", price: 5 },
    { ...fixedDishes[1], id: "WRONG-UNIT", unit: "份" },
  ];
  assert.equal(planFixedDishCatalogRepair(source, fixedDishes).additions.length, 2);
});

test("stable-ID collisions reject the entire proposal even if another exact match exists", () => {
  const collision = { id: fixedDishRepairId(fixedDishes[0]), stall: "宽窄巷子", name: "油条", price: 2, unit: "份" };
  assert.throws(() => planFixedDishCatalogRepair([...existing, collision], fixedDishes), /ID冲突/);
  const exact = { ...fixedDishes[0], id: "EXACT" };
  assert.throws(() => planFixedDishCatalogRepair([...existing, collision, exact], fixedDishes), /ID冲突/);
});

test("partial, mismatched or unsourced fixed menus fail closed", () => {
  assert.throws(() => planFixedDishCatalogRepair(existing, fixedDishes.slice(1)), /四条可信/);
  for (const patch of [
    { price: null }, { unit: "未知" }, { name: " " }, { stall: "早餐" },
    { source: { ...fixedDishes[0].source, file: "错误早餐来源.xlsx" } },
    { source: { ...fixedDishes[0].source, fileSha256: "" } },
    { source: { ...fixedDishes[0].source, priceCell: "E14" } },
  ]) {
    const bad = fixedDishes.map((dish, index) => index === 0 ? { ...dish, ...patch } : dish);
    assert.throws(() => planFixedDishCatalogRepair(existing, bad), /拒绝/);
  }
  const changedDinner = fixedDishes.map((dish, index) => index === 2 ? { ...dish, price: 5 } : dish);
  assert.throws(() => planFixedDishCatalogRepair(existing, changedDinner), /午晚餐固定出品/);
});
