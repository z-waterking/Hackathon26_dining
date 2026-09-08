import test from "node:test";
import assert from "node:assert/strict";
import { generateMenu, checkMenu } from "../server/menus.mjs";
import { menuRows } from "../src/menu-export.js";

const dishes = ["档口甲", "档口乙", "无可用菜档口"].flatMap((stall, group) =>
  Array.from({ length: 12 }, (_, index) => ({
    id: `${group}-${index}`,
    stall,
    name: `菜品${index}`,
    price: 12,
    priceText: "12",
    unit: "份",
    active: group !== 2,
    spicy: "未知",
    vegetarian: "未知",
    mainIngredient: "",
    method: "",
  })),
);
const options = {
  scope: "all",
  start: "2026-09-07",
  meals: ["午餐", "晚餐"],
  seed: 1,
  count: 4,
};

test("one generation covers all stalls and six weeks, including empty-candidate stalls", () => {
  const plan = generateMenu(dishes, options);
  assert.deepEqual(plan.stalls, ["档口甲", "档口乙", "无可用菜档口"]);
  assert.equal(plan.entries.length, 3 * 6 * 5 * 2 * 4);
  for (const stall of plan.stalls) {
    const entries = plan.entries.filter((entry) => entry.stall === stall);
    assert.deepEqual(
      [...new Set(entries.map((entry) => entry.week))],
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(new Set(entries.map((entry) => entry.date)).size, 30);
  }
  assert.ok(
    plan.validation.issues.some(
      (issue) => issue.code === "MISSING" && issue.stall === "无可用菜档口",
    ),
  );
  assert.ok(
    plan.validation.issues.some(
      (issue) => issue.code === "CROSS_STALL_DUPLICATE",
    ),
  );
  assert.deepEqual(checkMenu(dishes, plan).entries, plan.entries);
  const changed = structuredClone(plan);
  changed.entries[0].dishId = "1-0";
  assert.throws(() => checkMenu(dishes, changed), /不属于该档口/);
  assert.throws(
    () => checkMenu(dishes, { ...plan, entries: plan.entries.slice(1) }),
    /完整六周/,
  );
  assert.throws(
    () => checkMenu(dishes, { ...plan, stalls: plan.stalls.slice(1) }),
    /清单不完整/,
  );
});

test("menu export is a weekly menu grid without internal details and supports old plans", () => {
  const plan = generateMenu(dishes, options);
  const rows = menuRows(plan, dishes);
  assert.equal(rows.length, 3 * 6 * 2 * 4);
  assert.deepEqual(Object.keys(rows[0]), [
    "周次",
    "日期",
    "餐次",
    "档口",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
  ]);
  assert.match(rows[0].周一, /菜品.*（¥12）/);
  assert.equal(rows.at(-1).日期, "2026-10-12 至 2026-10-16");
  assert.ok(
    rows.some((row) => row.档口 === "无可用菜档口" && row.周一 === "待补菜"),
  );
  const legacy = generateMenu(dishes, {
    ...options,
    scope: undefined,
    stall: "档口甲",
  });
  assert.equal(menuRows(legacy, dishes).length, 6 * 2 * 4);
  assert.deepEqual(checkMenu(dishes, legacy).entries, legacy.entries);
});
