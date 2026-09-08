import { z } from "zod";
import {
  generatePlan,
  validatePlan,
  planOptionsSchema,
  dateSchema,
  slotPrices,
} from "./domain.mjs";

const batchOptionsSchema = planOptionsSchema
  .omit({ stall: true })
  .extend({ scope: z.literal("all") });
const entrySchema = z.object({
  date: dateSchema,
  week: z.number().int(),
  day: z.number().int(),
  meal: z.enum(["早餐", "午餐", "晚餐"]),
  slot: z.number().int(),
  dishId: z.string().max(100),
  stall: z.string().min(1).max(100).optional(),
});

export function menuStalls(plan) {
  return plan.scope === "all" ? plan.stalls : [plan.stall];
}

export function generateMenu(dishes, input, feedback = []) {
  if (input.scope !== "all") return generatePlan(dishes, input, feedback);
  const options = batchOptionsSchema.parse(input);
  const stalls = [...new Set(dishes.map((dish) => dish.stall))];
  if (!stalls.length) throw new Error("菜库中没有档口");
  const entries = stalls.flatMap((stall) =>
    generatePlan(dishes, { ...options, stall }, feedback).entries.map(
      (entry) => ({ ...entry, stall }),
    ),
  );
  const plan = {
    ...options,
    stall: "全部档口",
    stalls,
    entries,
    createdAt: new Date().toISOString(),
  };
  return { ...plan, validation: validateMenu(plan, dishes) };
}

export function validateMenu(plan, dishes, previous = null) {
  if (plan.scope !== "all")
    return validatePlan(
      plan,
      dishes,
      previous?.scope === "all" ? null : previous,
    );
  const issues = [];
  let verifiedEntries = 0;
  let changedEntries = 0;
  let comparable =
    previous?.scope === "all" &&
    JSON.stringify(previous.stalls) === JSON.stringify(plan.stalls);
  for (const stall of plan.stalls) {
    const current = {
      ...plan,
      stall,
      entries: plan.entries.filter((entry) => entry.stall === stall),
    };
    const prior = comparable
      ? {
          ...previous,
          stall,
          entries: previous.entries.filter((entry) => entry.stall === stall),
        }
      : null;
    const result = validatePlan(current, dishes, prior);
    issues.push(
      ...result.issues
        .filter((issue) => issue.code !== "CROSS_STALL")
        .map((issue) => ({ ...issue, stall })),
    );
    if (result.changeRate === null) comparable = false;
    else changedEntries += (result.changeRate / 100) * current.entries.length;
  }
  const byId = new Map(dishes.map((dish) => [dish.id, dish]));
  const occurrences = new Map();
  for (const entry of plan.entries) {
    const dish = byId.get(entry.dishId);
    if (!dish) continue;
    if (
      dish.spicy !== "未知" &&
      dish.vegetarian !== "未知" &&
      dish.mainIngredient &&
      dish.method
    )
      verifiedEntries++;
    const key = JSON.stringify([
      entry.date,
      entry.meal,
      dish.name.replace(/\s/g, ""),
    ]);
    if (!occurrences.has(key))
      occurrences.set(key, {
        date: entry.date,
        meal: entry.meal,
        name: dish.name,
        stalls: new Set(),
      });
    occurrences.get(key).stalls.add(entry.stall);
  }
  for (const occurrence of occurrences.values()) {
    if (occurrence.stalls.size < 2) continue;
    issues.push({
      level: "warning",
      code: "CROSS_STALL_DUPLICATE",
      date: occurrence.date,
      meal: occurrence.meal,
      stall: [...occurrence.stalls].join("、"),
      text: `${occurrence.name} 在多个档口出现，需按共享例外和实际开餐范围复核。`,
    });
  }
  issues.push({
    level: "warning",
    code: "SERVICE_TIMES",
    date: "",
    meal: "",
    stall: "全部档口",
    text: "按所选餐次统一生成全部菜库档口；实际开餐范围、早餐菜库归属及主食需现场复核。",
  });
  return {
    issues,
    errors: issues.filter((issue) => issue.level === "error").length,
    warnings: issues.filter((issue) => issue.level === "warning").length,
    labelCoverage: Math.round((verifiedEntries / plan.entries.length) * 100),
    changeRate: comparable
      ? Math.round((changedEntries / plan.entries.length) * 100)
      : null,
  };
}

export function checkMenu(dishes, input, previous = null) {
  const options =
    input.scope === "all"
      ? batchOptionsSchema.parse(input)
      : planOptionsSchema.parse(input);
  const stalls =
    input.scope === "all"
      ? [...new Set(dishes.map((dish) => dish.stall))]
      : [options.stall];
  if (!stalls.length) throw new Error("菜库中没有档口");
  const expectedEntries = [];
  for (const stall of stalls) {
    for (let week = 0; week < 6; week++) {
      for (let day = 0; day < 5; day++) {
        const date = new Date(`${options.start}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + week * 7 + day);
        for (const meal of options.meals) {
          for (const [slot, priceRule] of slotPrices(
            stall,
            options.count,
          ).entries()) {
            expectedEntries.push({
              date: date.toISOString().slice(0, 10),
              week: week + 1,
              day: day + 1,
              meal,
              slot,
              priceRule,
              ...(input.scope === "all" ? { stall } : {}),
            });
          }
        }
      }
    }
  }
  const structure = {
    ...options,
    ...(input.scope === "all" ? { stall: "全部档口", stalls } : {}),
    entries: expectedEntries,
    createdAt: new Date().toISOString(),
  };
  if (
    structure.scope === "all" &&
    JSON.stringify(input.stalls) !== JSON.stringify(structure.stalls)
  )
    throw new Error("全部档口清单不完整或已变更，请重新生成");
  const entries = z.array(entrySchema).parse(input.entries);
  if (entries.length !== structure.entries.length)
    throw new Error("菜单槽位数量不正确，必须保留完整六周及全部档口");
  const byId = new Map(dishes.map((dish) => [dish.id, dish]));
  const checked = entries.map((entry, index) => {
    const expected = structure.entries[index];
    const fields =
      structure.scope === "all"
        ? ["date", "week", "day", "meal", "slot", "stall"]
        : ["date", "week", "day", "meal", "slot"];
    if (fields.some((field) => entry[field] !== expected[field]))
      throw new Error("菜单日期、档口或槽位结构不正确");
    const dish = byId.get(entry.dishId);
    if (
      entry.dishId &&
      (!dish || dish.stall !== (expected.stall || structure.stall))
    )
      throw new Error("替换菜品不属于该档口");
    return {
      ...expected,
      dishId: entry.dishId,
      nameKey: dish ? dish.name.replace(/\s/g, "") : "",
    };
  });
  const plan = { ...structure, entries: checked };
  return { ...plan, validation: validateMenu(plan, dishes, previous) };
}
