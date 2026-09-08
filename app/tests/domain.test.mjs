import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTransactions,
  generatePlan,
  validatePlan,
  transactionSchema,
  feedbackSchema,
  parseCsv,
} from "../server/domain.mjs";

const dishes = Array.from({ length: 80 }, (_, index) => ({
  id: String(index),
  name: `菜品${index}`,
  stall: "饺好运",
  unit: "份",
  price: 12,
  active: true,
  spicy: "未知",
  vegetarian: "未知",
  mainIngredient: "",
  method: "",
}));
test("six-week generation is deterministic and respects same-day and two-day exclusion", () => {
  const options = {
    stall: "饺好运",
    start: "2026-09-07",
    meals: ["午餐", "晚餐"],
    seed: 12,
    count: 4,
  };
  const plan = generatePlan(dishes, options);
  assert.equal(plan.entries.length, 240);
  assert.deepEqual(plan.entries, generatePlan(dishes, options).entries);
  assert.equal(plan.validation.errors, 0);
  assert.ok(plan.validation.warnings > 0);
  assert.equal(plan.validation.labelCoverage, 0);
  assert.equal(plan.entries.at(-1).date, "2026-10-16");
  plan.entries[1].dishId = plan.entries[0].dishId;
  assert.ok(validatePlan(plan, dishes).errors > 0);
  assert.throws(() =>
    generatePlan(dishes, { ...options, start: "2026-09-08" }),
  );
});
test("insufficient inventory creates explicit gaps instead of inventing dishes", () => {
  const plan = generatePlan(dishes.slice(0, 2), {
    stall: "饺好运",
    start: "2026-09-07",
    meals: ["午餐"],
  });
  assert.ok(plan.entries.some((entry) => !entry.dishId));
  assert.ok(plan.validation.errors > 0);
});
test("POS refunds, voids and transaction count have separate meanings", () => {
  const base = {
    transactionId: "1",
    lineId: "1",
    time: "2026-08-02T12:30",
    stall: "饺好运",
    dishId: "1",
    dishName: "菜",
    quantity: 2,
    amount: 24,
    status: "sale",
    unit: "份",
  };
  const result = aggregateTransactions([
    base,
    { ...base, lineId: "2", amount: 12, quantity: 1 },
    {
      ...base,
      transactionId: "2",
      status: "refund",
      amount: -12,
      quantity: -1,
    },
    { ...base, transactionId: "3", status: "void", amount: 100 },
  ]);
  assert.equal(result.revenue, 24);
  assert.equal(result.sales, 1);
  assert.equal(result.ranking[0].quantity, 2);
  assert.equal(aggregateTransactions([base], { start: "2026-09-01" }).rows, 0);
  assert.equal(
    transactionSchema.safeParse({ ...base, quantity: "" }).success,
    false,
  );
  assert.equal(
    transactionSchema.safeParse({ ...base, time: "2026-02-30T25:00" }).success,
    false,
  );
  assert.equal(
    transactionSchema.safeParse({ ...base, status: "refund" }).success,
    false,
  );
});
test("CSV parser handles quoting and required feedback fields", () => {
  assert.equal(
    parseCsv('name,note\n"菜,一","第一行\n第二行"')[0].note,
    "第一行\n第二行",
  );
  assert.equal(feedbackSchema.safeParse({ content: " " }).success, false);
});
