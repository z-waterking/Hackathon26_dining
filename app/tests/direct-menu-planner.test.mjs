import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DIRECT_MENU_VERSION, directContext, directPrompt, directPromptHash, weeklySchema, weeklyInput, materializeWeek, materializeLegacyWeek, directActionImpacts } from "../server/direct-menu-planner.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { start: "2026-09-07", count: 2, meals: ["午餐", "晚餐"] };
function fixture() {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 15 }, (_, i) => ({
    id: `${group}-${i}`, name: `${stall}菜${i}`, stall, price: 12, unit: "份", category: "菜品", active: true,
    spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", labelSource: "",
  })));
  const snapshots = { settings: { plannerPrompt: "基础系统规则" }, dishes,
    rules: [{ id: "R1", appliesTo: ["档口甲"], stall: "档口甲", text: "不推断未知标签", source: { file: "餐厅排菜规则+示例.xlsx", sheet: "规则", row: 3, cell: "B3" } }],
    actions: [{ id: "A1", title: "调整供应", targetStall: "档口甲", menuInstruction: "仅按已核验菜品调整", priority: "medium", revision: 2, feedbackIds: ["F-private"], evidence: [{ quote: "原始反馈不要进入排菜输入" }] }],
    fixedStaples: [{ stall: "档口甲", meal: "午餐", text: "米饭0.5", source: { cell: "C11" } }],
  };
  return { snapshots, context: directContext(snapshots, options) };
}
function resultFor(snapshots, context, week = 1) {
  const input = weeklyInput(snapshots, options, context, week, []);
  return directWeeklyResponse({ input });
}

test("direct system prompt contains sourced rules and approved business adjustments, not feedback evidence", () => {
  const { snapshots } = fixture();
  const prompt = directPrompt(snapshots);
  assert.match(prompt, /本次周次/);
  assert.match(prompt, /本次只输出input.week指定的一周/);
  assert.ok(!prompt.includes("基础系统规则"), "legacy six-week role text must not conflict with the weekly template");
  assert.match(prompt, /不推断未知标签/);
  assert.match(prompt, /仅按已核验菜品调整/);
  assert.match(prompt, /B3/);
  assert.ok(!prompt.includes("F-private"));
  assert.ok(!prompt.includes("原始反馈不要进入排菜输入"));
  const fingerprint = directPromptHash(snapshots);
  assert.equal(fingerprint.length, 64);
  snapshots.rules[0].text = "源规则已调整";
  assert.notEqual(directPromptHash(snapshots), fingerprint);
});

test("weekly input includes the complete active catalog and previous weeks without truncation or inferred tags", () => {
  const { snapshots } = fixture();
  snapshots.dishes.push(...Array.from({ length: 620 }, (_, i) => ({ ...snapshots.dishes[0], id: `extra-${i}` })),
    { ...snapshots.dishes[0], id: "inactive", active: false }, { ...snapshots.dishes[0], id: "fixed-staple", category: "主食杂粮" });
  const context = directContext(snapshots, options);
  const previousWeeks = [{ week: 1, menus: [] }];
  const input = weeklyInput(snapshots, options, context, 2, previousWeeks);
  assert.equal(Object.values(input.dishCatalog).flat().length, 650);
  assert.deepEqual(input.catalogCoverage, { provided: 650, totalActive: 650, complete: true });
  assert.equal(input.totalWeeks, 6);
  assert.equal(input.workingDays, 5);
  assert.deepEqual(input.previousWeeks, [{ week: 1, menus: {} }]);
  assert.deepEqual(input.fixedStaples, snapshots.fixedStaples);
  assert.deepEqual(input.dishFields, ["localIndex", "name", "price", "unit", "active", "verified"]);
  assert.equal(input.dishCatalog.S0[0][0], 0);
  assert.equal(input.dishCatalog.S0[634][0], 634);
  assert.equal(input.dishCatalog.S1[0][0], 0);
  assert.equal(input.dishCatalog.S0[0][input.dishFields.indexOf("active")], true);
  assert.deepEqual(input.dishCatalog.S0[0][input.dishFields.indexOf("verified")], {});
  assert.match(input.unknownLabels, /未知.*仍可安排具体候选/);
  assert.ok(!JSON.stringify(input).includes("F-private"));
  assert.ok(!JSON.stringify(input).includes("原始反馈不要进入排菜输入"));
});

test("v2 schema binds every stall key to bounded local indexes without any large catalog enum", () => {
  const { snapshots } = fixture();
  snapshots.dishes.push(...Array.from({ length: 1300 }, (_, i) => ({ ...snapshots.dishes[0], id: `large-${i}` })));
  const context = directContext(snapshots, options);
  const schema = weeklySchema(context, options);
  const json = z.toJSONSchema(schema);
  assert.equal(DIRECT_MENU_VERSION, "gpt-direct-v2");
  assert.deepEqual(json.properties.menus.required, ["S0", "S1"]);
  assert.equal(json.properties.menus.additionalProperties, false);
  assert.equal(json.properties.menus.properties.S0.items.minimum, -1);
  assert.equal(json.properties.menus.properties.S0.items.maximum, 1314);
  assert.equal(json.properties.menus.properties.S1.items.maximum, 14);
  assert.equal(json.properties.menus.properties.S0.minItems, 20);
  assert.equal(json.properties.menus.properties.S0.maxItems, 20);
  assert.equal(json.properties.menus.properties.S0.items.enum, undefined);
  const raw = resultFor(snapshots, context);
  assert.ok(schema.safeParse(raw).success);
  for (const mutate of [
    value => { value.menus.S1[0] = 15; },
    value => { value.menus.S0[0] = 1315; },
    value => { value.menus.S0.pop(); },
    value => { value.menus.S2 = value.menus.S0; },
    value => { delete value.menus.S1; },
    value => { value.menus = Object.entries(value.menus).map(([key, dishIndexes]) => ({ stallIndex: Number(key.slice(1)), dishIndexes })); },
  ]) {
    const invalid = structuredClone(raw);
    mutate(invalid);
    assert.equal(schema.safeParse(invalid).success, false);
    assert.throws(() => materializeWeek(invalid, snapshots, options, context, 2), error => error.code === "MENU_SCHEMA_INVALID" && error.diagnostics.week === 2);
  }
});

test("grouped catalog, price allowlists and fixed indexes all share the same local numbering", () => {
  const { snapshots } = fixture();
  const dish = (id, stall, price) => ({ ...snapshots.dishes[0], id, name: id, stall, price });
  snapshots.dishes = [dish("shared-eight", "五味坊", 8), dish("source-eight", "寻味列车", 8),
    dish("shared-five", "五味坊", 5), dish("source-six", "寻味列车", 6),
    dish("fixed-a", "固定档口", 12), dish("fixed-b", "固定档口", 12)];
  snapshots.rules = [{ id: "fixed", appliesTo: ["固定档口"], text: "此档口固定出品" }];
  snapshots.fixedDishes = snapshots.dishes.slice(4).map(({ name, stall, price, unit }) => ({ name, stall, price, unit }));
  const context = directContext(snapshots, options);
  const input = weeklyInput(snapshots, options, context, 1, []);
  assert.deepEqual(context.catalogs, { S0: [0, 2], S1: [1, 3], S2: [4, 5] });
  assert.deepEqual(input.dishCatalog.S0.map(row => row[0]), [0, 1]);
  assert.deepEqual(input.dishCatalog.S1.map(row => row[0]), [0, 1]);
  assert.deepEqual(input.layout[0].allowedByPrice[8], [0]);
  assert.deepEqual(input.layout[0].allowedByPrice[5], [1]);
  assert.deepEqual(input.layout[1].allowedByPrice[6], [1]);
  assert.deepEqual(input.layout[2].fixedDishIndexes, [0, 1]);
  assert.deepEqual(context.layout[2].fixedDishIndexes, [4, 5], "internal global indexes are not mutated");
  assert.equal(input.catalogCoverage.provided, 6, "both linked stalls retain every candidate");
});

test("a stall with no active candidates can only emit placeholders without borrowing another catalog", () => {
  const { snapshots } = fixture();
  snapshots.dishes.filter(dish => dish.stall === "档口乙").forEach(dish => { dish.active = false; });
  const context = directContext(snapshots, options);
  const input = weeklyInput(snapshots, options, context, 1, []);
  assert.deepEqual(input.dishCatalog.S1, []);
  assert.equal(input.layout[1].candidateCount, 0);
  const json = z.toJSONSchema(weeklySchema(context, options));
  assert.equal(json.properties.menus.properties.S1.items.minimum, -1);
  assert.equal(json.properties.menus.properties.S1.items.maximum, -1);
  const raw = directWeeklyResponse({ input });
  const result = materializeWeek(raw, snapshots, options, context, 1);
  assert.ok(result.entries.filter(entry => entry.stall === "档口乙").every(entry => !entry.dishId));
  raw.menus.S1[0] = 0;
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 1), error => error.code === "MENU_SCHEMA_INVALID");
});

test("legacy successful weeks materialize explicitly and previous selections become v2 local references", () => {
  const { snapshots, context } = fixture();
  const raw = resultFor(snapshots, context);
  const current = materializeWeek(raw, snapshots, options, context, 1);
  const legacy = { ...raw, menus: current.compact.menus };
  assert.throws(() => materializeWeek(legacy, snapshots, options, context, 1), error => error.code === "MENU_SCHEMA_INVALID");
  const reused = materializeLegacyWeek(legacy, snapshots, options, context, 1);
  assert.deepEqual(reused, current);
  const next = weeklyInput(snapshots, options, context, 2, [reused.compact]);
  assert.deepEqual(next.previousWeeks, [{ week: 1, menus: raw.menus }]);
  const wrongStall = structuredClone(legacy);
  wrongStall.menus[0].dishIndexes[0] = 15;
  assert.throws(() => materializeLegacyWeek(wrongStall, snapshots, options, context, 1), error => error.code === "MENU_DISH_REFERENCE");
  assert.throws(() => weeklyInput(snapshots, options, context, 2, [{ week: 1, menus: wrongStall.menus }]), error => error.code === "MENU_PREVIOUS_DISH");
});

test("diagnostics pinpoint only safe local references and never include raw response text", () => {
  const { snapshots } = fixture();
  snapshots.rules.push({ id: "manual", appliesTo: ["档口乙"], text: "该部分菜单需预留人工上传" });
  const context = directContext(snapshots, options);
  const raw = resultFor(snapshots, context);
  raw.summary = "secret-output-must-not-be-in-diagnostics";
  raw.menus.S1[6] = 3;
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 4), error => {
    assert.deepEqual(error.diagnostics, { code: "MENU_MANUAL_REQUIRED", week: 4, stall: "档口乙", day: 2, meal: "晚餐", slot: 0, dishIndex: 3 });
    assert.ok(!JSON.stringify(error).includes(raw.summary));
    return true;
  });
  raw.menus.S1[6] = 9999;
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 4), error => {
    assert.deepEqual(error.diagnostics, { code: "MENU_SCHEMA_INVALID", week: 4, stall: "档口乙", day: 2, meal: "晚餐", slot: 0, dishIndex: 9999 });
    return true;
  });
});

test("fixed staple instructions do not incorrectly mark the whole stall as fixed", () => {
  const { snapshots } = fixture();
  snapshots.rules[0].text = "排菜完成后加上主食，该部分固定出品，不做变动";
  assert.equal(directContext(snapshots, options).layout[0].fixed, false);
  snapshots.rules[0].text = "此档口固定出品，保持不变，复制样例即可";
  assert.equal(directContext(snapshots, options).layout[0].fixed, true);
});

test("fixed output without an exact source match cannot reuse historical catalog dishes", () => {
  const { snapshots } = fixture();
  snapshots.rules[0].text = "此档口固定出品，保持不变，复制样例即可";
  const sourceDish = { stall: "档口甲", name: "档口甲菜0", price: 12, unit: "份" };
  for (const fixedDishes of [[], [{ ...sourceDish, name: "源文件另一道菜" }],
    [{ ...sourceDish, price: 13 }], [{ ...sourceDish, unit: "碗" }], [{ ...sourceDish, stall: "档口乙" }]]) {
    snapshots.fixedDishes = fixedDishes;
    const context = directContext(snapshots, options);
    assert.equal(context.layout[0].fixed, true);
    assert.equal(context.layout[0].fixedSourceMissing, true);
    assert.deepEqual(context.layout[0].fixedDishIndexes, []);
    assert.throws(() => materializeWeek(resultFor(snapshots, context), snapshots, options, context, 1), /固定出品与源文件不符/);
  }
});

test("fixed output permits only source name, price and unit matched indexes and keeps real IDs", () => {
  const { snapshots } = fixture();
  snapshots.rules[0].text = "此档口固定出品，保持不变，复制样例即可";
  snapshots.fixedDishes = [0, 1].map((index) => ({ stall: "档口甲", name: `档口甲菜${index}`, price: 12, unit: "份",
    source: { file: "餐厅排菜规则+示例.xlsx", sheet: "规则", row: index + 14, cell: `C${index + 14}` } }));
  const context = directContext(snapshots, options);
  assert.equal(context.layout[0].fixedSourceMissing, false);
  assert.deepEqual(context.layout[0].fixedDishIndexes, [0, 1]);
  assert.deepEqual(context.layout[0].fixedSource, snapshots.fixedDishes);
  const raw = resultFor(snapshots, context);
  raw.menus.S0 = raw.menus.S0.map((_, index) => index % 2);
  const result = materializeWeek(raw, snapshots, options, context, 1);
  assert.deepEqual([...new Set(result.entries.filter((entry) => entry.stall === "档口甲").map((entry) => entry.dishId))], ["0-0", "0-1"]);
  raw.menus.S0[0] = 2;
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 1), /固定出品与源文件不符/);
});

test("price allowlists use real stall, amount and portion unit rather than matching price alone", () => {
  const { snapshots } = fixture();
  const dish = (id, stall, price, unit = "份", patch = {}) => ({ ...snapshots.dishes[0], id, stall, price, unit, ...patch });
  snapshots.dishes = [
    dish("eight-serving", "寻味列车", 8), dish("eight-weight", "寻味列车", 8, "100g"),
    dish("six-serving", "寻味列车", 6), dish("five-serving", "寻味列车", 5), dish("four-serving", "寻味列车", 4),
    dish("inactive-eight", "寻味列车", 8, "份", { active: false }),
    dish("staple-eight", "寻味列车", 8, "份", { category: "主食杂粮" }),
    dish("thirty-weight", "一锅烟火", 30, "100g"), dish("cheap-serving", "一锅烟火", 29),
    dish("other-eight", "档口乙", 8),
  ];
  const context = directContext(snapshots, options);
  const ids = (indexes) => indexes.map((index) => context.candidates[index].id);
  assert.deepEqual(Object.fromEntries(Object.entries(context.layout[0].allowedByPrice).map(([price, indexes]) => [price, ids(indexes)])),
    { 8: ["eight-serving"], 6: ["six-serving"], 5: ["five-serving"], 4: ["four-serving"] });
  assert.deepEqual(context.layout[1].allowedByPrice, { ">=30": [] });
  assert.deepEqual(context.layout[2].allowedByPrice, {}, "wildcard slots do not need a fabricated price filter");
  snapshots.dishes.push(dish("thirty-serving", "一锅烟火", 30));
  const matched = directContext(snapshots, options);
  assert.deepEqual(matched.layout[1].allowedByPrice[">=30"].map((index) => matched.candidates[index].id), ["thirty-serving"]);
});

test("fixed source remains incomplete when just one expected dish matches the catalog", () => {
  const { snapshots } = fixture();
  snapshots.rules[0].text = "此档口固定出品，保持不变，复制样例即可";
  snapshots.fixedDishes = [
    { stall: "档口甲", name: "档口甲菜0", price: 12, unit: "份" },
    { stall: "档口甲", name: "源中缺失的第二道菜", price: 12, unit: "份" },
  ];
  const context = directContext(snapshots, options);
  assert.deepEqual(context.layout[0].fixedDishIndexes, [0]);
  assert.equal(context.layout[0].fixedSourceMissing, true);
});

test("weekly indexes become exact day/meal/slot references without changing model selections", () => {
  const { snapshots, context } = fixture();
  const raw = resultFor(snapshots, context, 3);
  const result = materializeWeek(raw, snapshots, options, context, 3);
  assert.equal(result.entries.length, 40);
  assert.equal(result.entries[0].date, "2026-09-21");
  assert.equal(result.entries[0].dishId, context.candidates[context.catalogs.S0[raw.menus.S0[0]]].id);
  assert.notEqual(result.entries[0].dishId, `D${raw.menus.S0[0]}`, "local real IDs are retained instead of model-facing short references");
  assert.equal(result.entries[20].dishId, context.candidates[context.catalogs.S1[raw.menus.S1[0]]].id);
  assert.equal(result.compact.menus[1].dishIndexes[0], context.catalogs.S1[raw.menus.S1[0]], "persisted compact references remain global and canonical");
  assert.equal(result.entries[19].date, "2026-09-25");
  assert.deepEqual(result.entries.slice(0, 4).map(({ day, meal, slot }) => [day, meal, slot]),
    [[1, "午餐", 0], [1, "午餐", 1], [1, "晚餐", 0], [1, "晚餐", 1]]);
  assert.equal(result.reviews[0].occurrences[0].dishId, result.entries[0].dishId);
});

test("verified catalog fields preserve confirmed labels but never manufacture missing attributes", () => {
  const { snapshots } = fixture();
  snapshots.dishes[0] = { ...snapshots.dishes[0], id: "real-long-database-id-1234567890", spicy: "不辣", method: "炒", labelSource: "厨房核验" };
  const context = directContext(snapshots, options);
  const input = weeklyInput(snapshots, options, context, 1, []);
  assert.deepEqual(input.dishCatalog.S0[0][5], { spicy: "不辣", method: "炒", labelSource: "厨房核验" });
  assert.equal(input.dishCatalog.S0[0][0], 0);
  assert.ok(!JSON.stringify(input.dishCatalog).includes("real-long-database-id-1234567890"));
  const result = materializeWeek(directWeeklyResponse({ input }), snapshots, options, context, 1);
  assert.equal(result.entries[0].dishId, "real-long-database-id-1234567890");
});

test("an all-empty week with usable non-manual candidates is rejected instead of becoming a menu", () => {
  const { snapshots, context } = fixture();
  const raw = resultFor(snapshots, context);
  Object.values(raw.menus).forEach((menu) => menu.fill(-1));
  raw.actionReviews = [];
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 1), /未选出任何具体菜品.*空表/);
});

test("manual-upload stalls reject fabricated AI fills and allow only empty placeholders", () => {
  const { snapshots } = fixture();
  snapshots.rules[0].text = "该部分菜单需预留人工上传入口，格式按源文件示例";
  const context = directContext(snapshots, options);
  const raw = resultFor(snapshots, context);
  const result = materializeWeek(raw, snapshots, options, context, 1);
  assert.ok(result.entries.filter((entry) => entry.stall === "档口甲").every((entry) => entry.dishId === ""));
  raw.menus.S0[0] = 0;
  assert.throws(() => materializeWeek(raw, snapshots, options, context, 1), /人工上传.*不可由 AI 代填/);
});

test("unsupported action claims are downgraded and duplicate evidence positions count once", () => {
  const { snapshots, context } = fixture();
  const raw = resultFor(snapshots, context);
  raw.actionReviews[0].evidence.push({ ...raw.actionReviews[0].evidence[0] });
  assert.equal(materializeWeek(raw, snapshots, options, context, 1).reviews[0].occurrences.length, 1);
  raw.actionReviews[0].evidence = [];
  const review = materializeWeek(raw, snapshots, options, context, 1).reviews[0];
  assert.equal(review.status, "partial");
  assert.match(review.note, /没有可定位/);
  raw.actionReviews = [];
  assert.equal(materializeWeek(raw, snapshots, options, context, 1).reviews[0].status, "not_applied");
});

test("unknown actions, duplicate reviews, empty evidence slots and wrong target stalls are rejected", () => {
  const { snapshots, context } = fixture();
  for (const mutate of [
    (raw) => { raw.actionReviews[0].actionId = "not-approved"; },
    (raw) => { raw.actionReviews.push(structuredClone(raw.actionReviews[0])); },
    (raw) => { raw.menus.S0[0] = -1; },
    (raw) => { raw.actionReviews[0].evidence[0].stallIndex = 1; },
  ]) {
    const raw = resultFor(snapshots, context);
    mutate(raw);
    assert.throws(() => materializeWeek(raw, snapshots, options, context, 1), /引用|证据/);
  }
});

test("direct impacts refer to six actual weekly selections, never a invented local baseline", () => {
  const { snapshots, context } = fixture();
  const weeks = Array.from({ length: 6 }, (_, i) => materializeWeek(resultFor(snapshots, context, i + 1), snapshots, options, context, i + 1));
  const plan = { entries: weeks.flatMap((week) => week.entries) };
  const planner = { actionReviews: weeks.flatMap((week) => week.reviews) };
  const impact = directActionImpacts(plan, planner, snapshots.actions, snapshots.dishes)[0];
  assert.equal(impact.status, "applied");
  assert.equal(impact.selectedEntries, 6);
  assert.equal(impact.baselineEntries, undefined);
  assert.equal(impact.changedEntries, undefined);
  planner.actionReviews[5].status = "partial";
  assert.equal(directActionImpacts(plan, planner, snapshots.actions, snapshots.dishes)[0].status, "partial");
  plan.entries[0].dishId = "edited-dish";
  const invalid = directActionImpacts(plan, planner, snapshots.actions, snapshots.dishes)[0];
  assert.equal(invalid.status, "not_applied");
  assert.equal(invalid.selectedEntries, 0);
  assert.deepEqual(invalid.occurrences, []);
});
