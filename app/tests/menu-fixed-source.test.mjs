import test from "node:test";
import assert from "node:assert/strict";
import { checkMenu, generateMenu, validateFixedMenuSources, validateMenu } from "../server/menus.mjs";

const stall = "宽窄巷子";
const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], count: 4, seed: 2 };
const record = (id, name, patch = {}) => ({ id, name, stall, price: 4, unit: "100g", active: true,
  spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", ...patch });
const correct = [record("FIXED-1", "骨汤麻辣烫"), record("FIXED-2", "老式麻辣烫")];
const wrong = [record("OLD-1", "油条", { price: 2, unit: "份" }), record("OLD-2", "水煎包", { price: 3, unit: "份" })];
const fixedDishes = options.meals.flatMap((meal) => correct.map(({ name, price, unit }, index) => ({
  stall, meal, name, price, unit, source: { file: "餐厅排菜规则+示例.xlsx", sheet: "排菜规则-宽窄巷子", cell: `C${index + (meal === "午餐" ? 14 : 49)}` },
})));
const direct = (dishes, extra = {}) => ({ ...generateMenu(dishes, options), generationMode: "gpt-direct", fixedDishes, ...extra });
const fixedErrors = (result) => result.issues.filter((issue) => issue.code === "FIXED_SOURCE");

test("old GPT selections from the wrong breakfast source are errors, without rewriting any selected dishes", () => {
  const plan = direct(wrong);
  const before = structuredClone(plan.entries);
  const issues = validateFixedMenuSources(plan, wrong, fixedDishes);
  assert.equal(issues.length, 6 * 5 * 2);
  assert.ok(issues.every((issue) => issue.level === "error" && issue.stall === stall && /骨汤麻辣烫/.test(issue.text)));
  const validation = validateMenu(plan, wrong);
  assert.equal(fixedErrors(validation).length, 60);
  assert.ok(validation.errors >= 60);
  assert.deepEqual(plan.entries, before);
  assert.ok(plan.entries.every((entry) => entry.dishId.startsWith("OLD-")));
});

test("correct fixed meals match exact source names, prices and units regardless of slot order", () => {
  const plan = direct(correct);
  assert.equal(fixedErrors(validateMenu(plan, correct)).length, 0);
  const changed = structuredClone(plan);
  [changed.entries[0].dishId, changed.entries[1].dishId] = [changed.entries[1].dishId, changed.entries[0].dishId];
  assert.equal(validateFixedMenuSources(changed, correct, fixedDishes).length, 0);
  for (const patch of [{ name: "其他麻辣烫" }, { price: 5 }, { unit: "份" }]) {
    const mutated = correct.map((dish, index) => index ? dish : { ...dish, ...patch });
    assert.equal(validateFixedMenuSources(plan, mutated, fixedDishes).length, 60);
  }
});

test("missing fixed source, omitted dishes and duplicate selections never pass as complete fixed menus", () => {
  const plan = direct(correct);
  assert.equal(validateFixedMenuSources(plan, correct).length, 60);
  assert.equal(validateFixedMenuSources(plan, correct, fixedDishes.filter((dish) => dish.meal === "午餐")).length, 30);
  const missing = structuredClone(plan);
  missing.entries[0].dishId = "";
  assert.equal(validateFixedMenuSources(missing, correct, fixedDishes).length, 1);
  assert.ok(validateMenu(missing, correct).issues.some((issue) => issue.code === "MISSING"));
  const duplicate = structuredClone(plan);
  duplicate.entries[1].dishId = duplicate.entries[0].dishId;
  assert.equal(validateFixedMenuSources(duplicate, correct, fixedDishes).length, 1);
});

test("checkMenu accepts only its server source argument, not client-supplied fixed dishes", () => {
  const plan = direct(wrong);
  const forged = options.meals.flatMap((meal) => wrong.map(({ name, price, unit }) => ({ stall, meal, name, price, unit })));
  const input = { ...plan, fixedDishes: forged };
  const checked = checkMenu(wrong, input, null, { fixedDishes });
  assert.deepEqual(checked.fixedDishes, fixedDishes);
  assert.notEqual(checked.fixedDishes, fixedDishes);
  assert.equal(fixedErrors(checked.validation).length, 60);
  const withoutServerSource = checkMenu(wrong, input);
  assert.deepEqual(withoutServerSource.fixedDishes, []);
  assert.equal(fixedErrors(withoutServerSource.validation).length, 60);
  assert.ok(withoutServerSource.validation.issues.some((issue) => /缺少.*可信/.test(issue.text)));
  const valid = checkMenu(correct, direct(correct), null, { fixedDishes });
  assert.equal(fixedErrors(valid.validation).length, 0);
});

test("local and demo generations retain legacy behavior, while stored direct snapshots validate on read", () => {
  const local = generateMenu(wrong, options);
  assert.equal(validateFixedMenuSources(local, wrong, fixedDishes).length, 0);
  assert.equal(fixedErrors(validateMenu({ ...local, fixedDishes, demo: true }, wrong)).length, 0);
  const stored = JSON.parse(JSON.stringify(direct(wrong)));
  assert.equal(fixedErrors(validateMenu(stored, wrong)).length, 60);
  const legacySingle = { ...generateMenu(wrong, { ...options, scope: undefined, stall }), generationMode: "gpt-direct", fixedDishes };
  assert.equal(fixedErrors(validateMenu(legacySingle, wrong)).length, 60);
});
