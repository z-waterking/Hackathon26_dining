import test from "node:test";
import assert from "node:assert/strict";
import { menuRows } from "../src/menu-export.js";

const weekdays = ["周一", "周二", "周三", "周四", "周五"];
const fixedStaples = [
  { stall: "寻味列车", meal: "午餐", text: "米饭 0.5     杂粮饭 1.2      馒头（100g)0.4" },
  { stall: "寻味列车", meal: "晚餐", text: "米饭 0.5     花卷（90g)0.4    玉米（200g)4" },
  { stall: "一锅烟火", meal: "午餐", text: "米饭0.5     贴饼子2      卷子2  " },
  { stall: "一锅烟火", meal: "晚餐", text: "米饭0.5     贴饼子2      卷子2\n以原表为准" },
];
const dishes = ["寻味列车", "一锅烟火"].flatMap((stall, index) => [
  { id: `D-${index}-0`, name: `${stall}热菜甲`, stall, price: 8 },
  { id: `D-${index}-1`, name: `${stall}热菜乙`, stall, price: 6, priceText: "6/份" },
]);

function fixture(meals = ["午餐", "晚餐"]) {
  const start = "2026-09-14";
  const entries = [];
  for (const stall of ["寻味列车", "一锅烟火"]) for (let week = 1; week <= 6; week++) {
    for (let day = 1; day <= 5; day++) {
      const date = new Date(`${start}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
      for (const meal of meals) for (let slot = 0; slot < 2; slot++) {
        entries.push({ date: date.toISOString().slice(0, 10), week, day, meal, stall, slot,
          dishId: dishes.filter((dish) => dish.stall === stall)[slot].id });
      }
    }
  }
  return { scope: "all", stall: "全部档口", stalls: ["寻味列车", "一锅烟火"], start, meals, entries };
}

test("four fixed-staple source texts append all six weeks without replacing or mutating hot dishes", () => {
  const plan = fixture();
  const baseline = menuRows(plan, dishes);
  const withStaples = { ...plan, fixedStaples: structuredClone(fixedStaples) };
  const original = structuredClone(withStaples);
  const rows = menuRows(withStaples, dishes);
  const extra = rows.filter((row) => row.档口.endsWith("（固定主食）"));
  assert.equal(extra.length, 4 * 6);
  assert.equal(rows.length, baseline.length + 24);
  assert.deepEqual(rows.filter((row) => !row.档口.endsWith("（固定主食）")), baseline);
  assert.deepEqual(withStaples, original);
  assert.equal(withStaples.entries.length, 2 * 6 * 5 * 2 * 2);
  for (const staple of fixedStaples) {
    const sourceRows = extra.filter((row) => row.档口 === `${staple.stall}（固定主食）` && row.餐次 === staple.meal);
    assert.deepEqual(sourceRows.map((row) => row.周次), ["第1周", "第2周", "第3周", "第4周", "第5周", "第6周"]);
    assert.equal(sourceRows[0].日期, "2026-09-14 至 2026-09-18");
    assert.equal(sourceRows.at(-1).日期, "2026-10-19 至 2026-10-23");
    for (const row of sourceRows) for (const day of weekdays) assert.equal(row[day], staple.text);
  }
  assert.ok(extra.every((row) => Object.keys(row).join(",") === "周次,日期,餐次,档口,周一,周二,周三,周四,周五"));
});

test("fixed staples export only selected meals and never invent breakfast staples", () => {
  for (const meals of [["午餐"], ["晚餐"], ["早餐"], ["早餐", "晚餐"]]) {
    const plan = fixture(meals);
    const baseline = menuRows(plan, dishes);
    const rows = menuRows({ ...plan, fixedStaples }, dishes);
    const expectedStaples = fixedStaples.filter((staple) => meals.includes(staple.meal));
    assert.equal(rows.length, baseline.length + expectedStaples.length * 6);
    assert.ok(rows.every((row) => meals.includes(row.餐次)));
    assert.deepEqual(rows.filter((row) => !row.档口.endsWith("（固定主食）")), baseline);
    assert.ok(!rows.some((row) => row.档口.endsWith("（固定主食）") && row.餐次 === "早餐"));
  }
});

test("legacy or empty-staple plans keep the original menu export shape", () => {
  const plan = fixture(["午餐"]);
  const baseline = menuRows(plan, dishes);
  assert.deepEqual(menuRows({ ...plan, fixedStaples: [] }, dishes), baseline);
  assert.equal(baseline.length, 2 * 6 * 2);
  assert.match(baseline[0].周一, /热菜甲（¥8）/);
});
