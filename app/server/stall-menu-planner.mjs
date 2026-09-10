import { weeklyInput, weeklySchema, materializeWeek } from "./direct-menu-planner.mjs";
import { validatePlan } from "./domain.mjs";

export function stallPlanningOrder(context) {
  const order = [...context.layout];
  // Shared-menu dependency: its own pool is still generated in a separate call.
  const source = order.findIndex(item => item.stall === "寻味列车");
  const shared = order.findIndex(item => item.stall === "五味坊");
  if (source > shared && shared !== -1) { const [item] = order.splice(source, 1); order.splice(shared, 0, item); }
  return order;
}

export function stallRequest(snapshots, options, full, item, week, previousWeeks, accepted) {
  const actions = snapshots.actions.filter(action => ["全部档口", item.stall].includes(action.targetStall));
  const localSnapshots = { ...snapshots, actions };
  const context = { ...full, stalls: [item.stall], layout: [{ ...item, key: "S0", stallIndex: 0 }], catalogs: { S0: full.catalogs[item.key] } };
  const history = previousWeeks.map(prior => ({ week: prior.week, menus: prior.menus.filter(menu => menu.stallIndex === item.stallIndex).map(menu => ({ ...menu, stallIndex: 0 })) }));
  const input = weeklyInput(localSnapshots, options, context, week, history);
  const byId = new Map(snapshots.dishes.map(dish => [dish.id, dish]));
  input.targetStall = item.stall;
  input.qualityTarget = 80;
  input.catalogCoverage = { provided: context.catalogs.S0.length, totalActive: context.catalogs.S0.length, complete: true };
  input.note = "当前档口完整候选均在 dishCatalog.S0 中，无抽样或截断；只能引用本档 localIndex。其他档口已选菜单仅作协调参考。";
  input.selectedOtherStalls = accepted.flatMap(result => result.entries.map(entry => {
    const dish = byId.get(entry.dishId);
    return { day: entry.day, meal: entry.meal, stall: entry.stall, name: dish?.name || null, price: dish?.price ?? null, unit: dish?.unit || null };
  }));
  if (item.stall === "寻味列车") {
    const sharedNames = new Set(full.candidates.filter(dish => dish.stall === "五味坊").map(dish => JSON.stringify([dish.name.replace(/\s/g, ""), dish.price, dish.unit])));
    input.sharedCandidateIndexes = context.catalogs.S0.flatMap((global, local) => sharedNames.has(JSON.stringify([full.candidates[global].name.replace(/\s/g, ""), full.candidates[global].price, full.candidates[global].unit])) ? [local] : []);
  }
  if (item.stall === "五味坊") input.sharedAllowedBySlot = Array.from({ length: 5 }, (_, day) => options.meals.flatMap(meal => item.priceRules.map(price => ({
    day: day + 1, meal, price, indexes: context.catalogs.S0.flatMap((global, local) => {
      const dish = full.candidates[global];
      return dish.price === price && input.selectedOtherStalls.some(selected => selected.stall === "寻味列车" && selected.day === day + 1 && selected.meal === meal &&
        selected.name?.replace(/\s/g, "") === dish.name.replace(/\s/g, "") && selected.price === dish.price && selected.unit === dish.unit) ? [local] : [];
    }),
  })))).flat();
  context.layout[0].noFeasibleSlots = Boolean(input.sharedAllowedBySlot?.every(slot => !slot.indexes.length));
  return { input, schema: weeklySchema(context, options), context, snapshots: localSnapshots };
}

export function materializeStall(data, request, options, week, item) {
  const result = materializeWeek(data, request.snapshots, options, request.context, week);
  result.compact.menus[0].stallIndex = item.stallIndex;
  return result;
}

export function ruleOnlyStall(request, options) {
  const item = request.context.layout[0];
  if (!item.manualRequired && !item.fixed && !item.noFeasibleSlots && request.context.catalogs.S0.length) return null;
  const indexes = request.input.layout[0].fixedDishIndexes;
  return { summary: item.manualRequired ? "源规则要求人工上传，保留明确待补位置" : item.fixed ? "沿用源规则固定出品，未使用AI随机替代" : item.noFeasibleSlots ? "同餐寻味列车没有可共享菜品，保留待补位置" : "本档口没有可选候选，保留待补位置",
    menus: { S0: Array.from({ length: 5 * options.meals.length * item.priceRules.length }, (_, index) => item.fixed && !item.manualRequired ? indexes[index % item.priceRules.length] ?? -1 : -1) },
    actionReviews: request.snapshots.actions.map(action => ({ actionId: action.id, status: "not_applied", note: "本档口沿用固定出品或因来源限制待补，不自动宣称行动完成", evidence: [] })), warnings: [],
  };
}

export function stallQuality(result, request, options, week, previous) {
  const entries = [...previous.flatMap(w => w.entries.filter(e => e.stall === request.input.targetStall)), ...result.entries];
  const plan = { ...options, stall: request.input.targetStall, generationMode: "gpt-direct", entries };
  const currentDates = new Set(result.entries.map(entry => entry.date));
  const report = validatePlan(plan, request.snapshots.dishes);
  const fixableCodes = new Set(["PRICE", "POOL", "DUPLICATE", "REPEAT", "DUMPLING_OVERLAP", "MILD", "MILD_PRICE", "GROUP_SPICE", "MAIN", "SPICY", "VEGETARIAN", "METHOD", "STEAM_SPICE", "STEAM_VEG"]);
  const issues = report.issues.filter(issue => issue.level === "error" && currentDates.has(issue.date) && fixableCodes.has(issue.code));
  const byId = new Map(request.snapshots.dishes.map(dish => [dish.id, dish]));
  for (const entry of result.entries) {
    if (!entry.dishId && !request.context.layout[0].manualRequired) {
      const layout = request.input.layout[0];
      const allowed = request.input.sharedAllowedBySlot
        ? request.input.sharedAllowedBySlot.find(slot => slot.day === entry.day && slot.meal === entry.meal && slot.price === entry.priceRule)?.indexes
        : entry.priceRule === "*" ? request.context.catalogs.S0 : layout.allowedByPrice[String(entry.priceRule)];
      if (allowed?.length) issues.push({ code: "MISSING_AVAILABLE", date: entry.date, meal: entry.meal, text: "此槽位有真实候选但未选择" });
    }
    if (request.input.sharedAllowedBySlot && entry.dishId) {
      const allowed = request.input.sharedAllowedBySlot.find(slot => slot.day === entry.day && slot.meal === entry.meal && slot.price === entry.priceRule)?.indexes || [];
      const dish = byId.get(entry.dishId);
      if (!allowed.some(index => request.context.candidates[request.context.catalogs.S0[index]].id === dish?.id))
        issues.push({ code: "SHARED_MENU", date: entry.date, meal: entry.meal, text: "必须匹配同餐寻味列车的同名同价出品" });
    }
  }
  return { week, stall: request.input.targetStall, count: issues.length, issues: issues.slice(0, 50) };
}

export function mergeStallWeek(week, results, context, actions, options) {
  const raw = { summary: results.map(r => r.summary).join("；").slice(0, 2000),
    menus: Object.fromEntries(context.layout.map(item => {
      const result = results.find(r => r.entries[0]?.stall === item.stall);
      const globals = result.compact.menus[0].dishIndexes;
      return [item.key, globals.map(index => index < 0 ? -1 : context.catalogs[item.key].indexOf(index))];
    })), actionReviews: actions.map(action => {
      const reviews = results.flatMap(result => result.reviews.filter(review => review.actionId === action.id));
      return { actionId: action.id, status: reviews.length && reviews.every(review => review.status === "applied") ? "applied"
        : reviews.some(review => review.status !== "not_applied") ? "partial" : "not_applied",
        note: reviews.map(review => review.note).join("；").slice(0, 1000) || "未找到可执行档口",
        evidence: reviews.flatMap(review => review.occurrences.map(entry => ({ stallIndex: context.stalls.indexOf(entry.stall), day: entry.day,
          mealIndex: options.meals.indexOf(entry.meal), slot: entry.slot }))).slice(0, 160),
      };
    }), warnings: results.flatMap(result => result.warnings).slice(0, 40) };
  const reviews = raw.actionReviews.map(review => ({ actionId: review.actionId, week, status: review.status, note: review.note,
    occurrences: review.evidence.map(ref => {
      const entry = results.flatMap(result => result.entries).find(entry => entry.stall === context.stalls[ref.stallIndex] && entry.day === ref.day && entry.meal === options.meals[ref.mealIndex] && entry.slot === ref.slot);
      return { week, day: entry.day, meal: entry.meal, stall: entry.stall, slot: entry.slot, dishId: entry.dishId };
    }),
  }));
  return { entries: context.stalls.flatMap(stall => results.flatMap(r => r.entries.filter(e => e.stall === stall))),
    reviews, summary: raw.summary, warnings: raw.warnings,
    compact: { week, menus: context.layout.map(item => results.find(r => r.entries[0]?.stall === item.stall).compact.menus[0]) }, raw };
}
