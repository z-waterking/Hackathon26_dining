import test from "node:test";
import assert from "node:assert/strict";
import { generatePlan, manualMenuStalls, validatePlan } from "../server/domain.mjs";
import { checkMenu, generateMenu, validateMenu } from "../server/menus.mjs";

const options = { start: "2026-09-07", meals: ["午餐", "晚餐"], seed: 4, count: 4 };
const dish = (stall, id, patch = {}) => ({
  id, name: `菜品${id}`, stall, price: 8, unit: "份", active: true, category: "",
  spicy: "不辣", vegetarian: "素食", mainIngredient: id, method: "炒", labelSource: "厨房核验", ...patch,
});
const entry = (item, date = options.start, meal = "午餐", slot = 0) => ({
  date, week: 1, day: 1, meal, slot, dishId: item.id, nameKey: item.name.replace(/\s/g, ""), priceRule: "*",
});
const plan = (stall, entries, extra = {}) => ({ ...options, stall, entries, ...extra });
const hasCode = (validation, code) => validation.issues.some((issue) => issue.code === code);

test("hot-food stalls retain same-day and two-calendar-day exclusions without applying them to other stalls", () => {
  for (const stall of ["寻味列车", "五味坊", "一锅烟火", "蒸心食意"]) {
    const item = dish(stall, stall);
    for (const [date, meal] of [["2026-09-07", "晚餐"], ["2026-09-08", "午餐"], ["2026-09-09", "午餐"]]) {
      const result = validatePlan(plan(stall, [entry(item), entry(item, date, meal)]), [item]);
      assert.ok(hasCode(result, "REPEAT"), `${stall}: ${date}/${meal}`);
    }
    assert.ok(!hasCode(validatePlan(plan(stall, [entry(item), entry(item, "2026-09-10")]), [item]), "REPEAT"));
    // Validation must not classify all earlier dates as within two days.
    assert.ok(!hasCode(validatePlan(plan(stall, [entry(item, "2026-09-10"), entry(item)]), [item]), "REPEAT"));
  }
});

test("noodle rules disallow same-day lunch/dinner overlap but allow next-day reuse", () => {
  const item = dish("南粉北面", "N-1");
  assert.ok(hasCode(validatePlan(plan(item.stall, [entry(item), entry(item, options.start, "晚餐")]), [item]), "REPEAT"));
  assert.ok(!hasCode(validatePlan(plan(item.stall, [entry(item), entry(item, "2026-09-08")]), [item]), "REPEAT"));
  assert.ok(!hasCode(validatePlan(plan(item.stall, [entry(item, options.start, "早餐"), entry(item)]), [item]), "REPEAT"));
  const items = Array.from({ length: 8 }, (_, index) => dish(item.stall, `N-${index}`));
  const generated = generatePlan(items, { ...options, stall: item.stall });
  assert.equal(generated.entries.length, 240);
  assert.ok(generated.entries.every((item) => item.dishId));
  assert.ok(!hasCode(generated.validation, "REPEAT"));
});

test("dumplings permit exactly 50% lunch/dinner overlap and daily reuse, but not three shared fillings", () => {
  const items = Array.from({ length: 6 }, (_, index) => dish("饺好运", `D-${index}`));
  const make = (laterIndexes, firstMeal = "午餐", laterMeal = "晚餐") => plan("饺好运", [
    ...items.slice(0, 4).map((item, index) => entry(item, options.start, firstMeal, index)),
    ...laterIndexes.map((index, slot) => entry(items[index], options.start, laterMeal, slot)),
  ]);
  const half = validatePlan(make([0, 1, 4, 5]), items);
  assert.ok(!hasCode(half, "DUMPLING_OVERLAP"));
  assert.ok(!hasCode(half, "REPEAT"));
  assert.ok(hasCode(validatePlan(make([0, 1, 2, 5]), items), "DUMPLING_OVERLAP"));
  assert.ok(hasCode(validatePlan(make([0, 1, 2, 5], "晚餐", "午餐"), items), "DUMPLING_OVERLAP"));
  const generated = generatePlan(items, { ...options, stall: "饺好运" });
  assert.equal(generated.entries.length, 240);
  assert.ok(generated.entries.every((item) => item.dishId));
  assert.ok(!hasCode(generated.validation, "DUMPLING_OVERLAP"));
  assert.ok(!hasCode(generated.validation, "REPEAT"));
});

function sharedFixture() {
  const source = [8, 8, 8, 6, 6, 6, 5, 4].map((price, index) => dish("寻味列车", `X-${index}`, {
    price, spicy: [0, 3].includes(index) ? "辣" : "不辣",
  }));
  const shared = [0, 1, 6, 7].map((index) => ({ ...source[index], id: `W-${index}`, stall: "五味坊" }));
  const items = [...source, ...shared];
  const entries = [source, shared].flatMap((group) => group.map((item, slot) => ({ ...entry(item, options.start, "午餐", slot), stall: item.stall, priceRule: item.price })));
  return { items, plan: { ...options, scope: "all", stall: "全部档口", stalls: ["寻味列车", "五味坊"], entries } };
}

test("Wuweifang shares the prescribed dishes with the same meal and valid sharing is not a cross-stall conflict", () => {
  const fixture = sharedFixture();
  const result = validateMenu(fixture.plan, fixture.items);
  assert.equal(result.errors, 0);
  assert.ok(!hasCode(result, "SHARED_MENU"));
  assert.ok(!hasCode(result, "RULE_CONFLICT"));
  assert.ok(!hasCode(result, "CROSS_STALL_DUPLICATE"));
  const single = validatePlan(plan("五味坊", fixture.plan.entries.filter((item) => item.stall === "五味坊")), fixture.items);
  assert.ok(!hasCode(single, "RULE_CONFLICT"));
  assert.ok(hasCode(single, "CROSS_STALL"));
});

test("shared dishes must match names, prices and units and come from that exact date and meal", () => {
  for (const patch of [{ name: "其他菜" }, { price: 9 }, { unit: "100g" }]) {
    const fixture = sharedFixture();
    const changed = fixture.items.map((item) => item.id === "W-0" ? { ...item, ...patch } : item);
    assert.ok(hasCode(validateMenu(fixture.plan, changed), "SHARED_MENU"), JSON.stringify(patch));
  }
  for (const field of ["date", "meal"]) {
    const fixture = sharedFixture();
    for (const item of fixture.plan.entries.filter((item) => item.stall === "寻味列车"))
      item[field] = field === "date" ? "2026-09-08" : "晚餐";
    assert.ok(hasCode(validateMenu(fixture.plan, fixture.items), "SHARED_MENU"));
  }
  const missing = sharedFixture();
  missing.plan.entries.find((item) => item.stall === "五味坊").dishId = "";
  const result = validateMenu(missing.plan, missing.items);
  assert.ok(hasCode(result, "SHARED_MENU"));
  assert.ok(hasCode(result, "MISSING"));
});

test("a third stall is not included in the Xunwei/Wuweifang sharing exception", () => {
  const fixture = sharedFixture();
  const third = { ...fixture.items[0], id: "THIRD", stall: "其他档口" };
  fixture.items.push(third);
  fixture.plan.stalls.push(third.stall);
  fixture.plan.entries.push({ ...entry(third), stall: third.stall });
  assert.ok(hasCode(validateMenu(fixture.plan, fixture.items), "CROSS_STALL_DUPLICATE"));
});

test("direct GPT drafts preserve manual-menu placeholders and cannot claim automatically populated slots as uploaded menus", () => {
  const items = manualMenuStalls.flatMap((stall, group) => Array.from({ length: 4 }, (_, index) => dish(stall, `${group}-${index}`)));
  const generated = generateMenu(items, { ...options, scope: "all" });
  assert.ok(generated.entries.every((item) => item.dishId));
  assert.ok(!hasCode(generated.validation, "MANUAL_SOURCE_REQUIRED"));
  const placeholder = { ...generated, generationMode: "gpt-direct", entries: generated.entries.map((item) => ({ ...item, dishId: "" })) };
  const checked = checkMenu(items, placeholder);
  assert.equal(checked.generationMode, "gpt-direct");
  assert.equal(checked.entries.length, generated.entries.length);
  assert.ok(checked.entries.every((item) => !item.dishId));
  assert.equal(checked.validation.issues.filter((issue) => issue.code === "MANUAL_REQUIRED").length, 2);
  assert.ok(hasCode(checked.validation, "MISSING"));
  assert.ok(checked.validation.errors > 0);
  const filled = checkMenu(items, { ...generated, generationMode: "gpt-direct" });
  assert.ok(hasCode(filled.validation, "MANUAL_SOURCE_REQUIRED"));
});

test("unknown rules and source labels remain explicit uncertainties without being invented by validation", () => {
  const item = dish("量味厨房", "UNKNOWN", { spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", labelSource: "" });
  const snapshot = structuredClone(item);
  const generic = validatePlan(plan(item.stall, [entry(item)]), [item]);
  assert.ok(hasCode(generic, "MANUAL"));
  assert.equal(generic.labelCoverage, 0);
  const source = { ...item, stall: "寻味列车" };
  const second = { ...source, id: "UNKNOWN-6", name: "未知半荤菜", price: 6 };
  const knownRule = validatePlan(plan(source.stall, [entry(source), entry(second, options.start, "午餐", 1)]), [source, second]);
  assert.ok(hasCode(knownRule, "LABELS"));
  assert.ok(knownRule.issues.filter((issue) => ["MILD", "SPICY", "GROUP_SPICE"].includes(issue.code)).every((issue) => issue.level === "warning"));
  assert.deepEqual(item, snapshot);
});
