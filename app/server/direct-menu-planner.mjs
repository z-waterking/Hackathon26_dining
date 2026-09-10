import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { slotPrices, fitsPrice } from "./domain.mjs";
import { configuredMenuPrompt } from "./prompt-builders.mjs";

export const DIRECT_MENU_VERSION = "gpt-direct-v2";
export const STALL_MENU_VERSION = "gpt-stall-v1";
const manualRule = /该部分菜单需预留人工上传/;
const scopeRules = (rules, stall) => rules.filter((rule) => rule.appliesTo.includes(stall) || rule.appliesTo.includes("全部档口"));
const businessAction = ({ id, title, targetStall, menuInstruction, priority, revision }) => ({ id, title, targetStall, menuInstruction, priority, revision });
export function directPrompt(snapshots) {
  if (snapshots.promptConfig) return configuredMenuPrompt(snapshots);
  const template = readFileSync(new URL(snapshots.planningMode === "per-stall" ? "./prompts/menu-stall-planner.md" : "./prompts/menu-planner.md", import.meta.url), "utf8");
  return [template,
    "# 本地文件规则（餐饮业务约束，保留来源）", JSON.stringify(snapshots.rules),
    "# 已批准运营调整（不得覆盖源硬规则）", JSON.stringify(snapshots.actions.map(businessAction))].join("\n");
}
export const directPromptHash = (snapshots) => createHash("sha256").update(directPrompt(snapshots)).digest("hex");

export function directContext(snapshots, options) {
  const stalls = [...new Set(snapshots.dishes.map((dish) => dish.stall))];
  const allowed = snapshots.planningMode === "per-stall" && snapshots.stallCatalog
    ? new Set(snapshots.stallCatalog.groups.flatMap(group => group.candidateIds)) : null;
  const candidates = snapshots.dishes.filter((dish) => dish.active && dish.category !== "主食杂粮" && (!allowed || allowed.has(dish.id)));
  const catalogs = Object.fromEntries(stalls.map((stall, index) => [`S${index}`, candidates.flatMap((dish, i) => dish.stall === stall ? [i] : [])]));
  const layout = stalls.map((stall, stallIndex) => {
    const rules = scopeRules(snapshots.rules, stall);
    const sourceRules = scopeRules(snapshots.sourceRules || snapshots.rules, stall);
    const fixed = sourceRules.some((r) => /此档口固定出品/.test(r.text));
    const fixedSource = (snapshots.fixedDishes || []).filter(d => d.stall === stall);
    const fixedDishIndexes = fixed ? candidates.flatMap((d, i) => d.stall === stall && fixedSource.some(source => source.name === d.name && source.price === d.price && source.unit === d.unit) ? [i] : []) : [];
    const priceRules = slotPrices(stall, options.count);
    const allowedByPrice = Object.fromEntries([...new Set(priceRules)].filter(price => price !== "*").map(price =>
      [String(price), candidates.flatMap((d, i) => d.stall === stall && fitsPrice(d, price) ? [i] : [])]));
    return { key: `S${stallIndex}`, stall, stallIndex, priceRules, allowedByPrice, manualRequired: sourceRules.some((r) => manualRule.test(r.text)),
      fixed, fixedDishIndexes, fixedSource, fixedSourceMissing: fixed && (!fixedDishIndexes.length || fixedSource.some(source => !fixedDishIndexes.some(i => candidates[i].name === source.name && candidates[i].price === source.price && candidates[i].unit === source.unit))),
      ruleIds: rules.map((r) => r.id), ruleMissing: !rules.length };
  });
  return { stalls, candidates, layout, catalogs };
}

function responseSchema(context, options, menus) {
  const slotCount = Math.max(...context.layout.map((item) => item.priceRules.length));
  return z.object({
    summary: z.string().min(1).max(2000),
    menus,
    actionReviews: z.array(z.object({ actionId: z.string().min(1).max(150), status: z.enum(["applied", "partial", "not_applied"]),
      note: z.string().min(1).max(1000), evidence: z.array(z.object({
        stallIndex: z.number().int().min(0).max(context.stalls.length - 1), day: z.number().int().min(1).max(5),
        mealIndex: z.number().int().min(0).max(options.meals.length - 1), slot: z.number().int().min(0).max(slotCount - 1),
      }).strict()).max(160),
    }).strict()).max(200), warnings: z.array(z.string().min(1).max(800)).max(40),
  }).strict();
}

export function weeklySchema(context, options) {
  // Bound each field to its own catalog, without a full-catalog enum or a model-selected stall ID.
  const menus = z.object(Object.fromEntries(context.layout.map(item => [item.key,
    z.array(z.number().int().min(-1).max(context.catalogs[item.key].length - 1))
      .length(5 * options.meals.length * item.priceRules.length),
  ]))).strict();
  return responseSchema(context, options, menus);
}

function legacyWeeklySchema(context, options) {
  const slotCount = Math.max(...context.layout.map(item => item.priceRules.length));
  return responseSchema(context, options, z.array(z.object({
    stallIndex: z.number().int().min(0).max(context.stalls.length - 1),
    dishIndexes: z.array(z.number().int().min(-1).max(context.candidates.length - 1))
      .min(1).max(5 * options.meals.length * slotCount),
  }).strict()).length(context.stalls.length));
}

function localLayout(context) {
  return context.layout.map(item => {
    const indexes = context.catalogs[item.key];
    const local = index => indexes.indexOf(index);
    return { ...item, candidateCount: indexes.length,
      allowedByPrice: Object.fromEntries(Object.entries(item.allowedByPrice).map(([price, allowed]) => [price, allowed.map(local)])),
      fixedDishIndexes: item.fixedDishIndexes.map(local),
    };
  });
}

function localPreviousWeeks(previousWeeks, context) {
  // Persisted compact menus use global indexes for both versions. Only model input is localized.
  return previousWeeks.map(previous => ({ week: previous.week, menus: Object.fromEntries(previous.menus.map(menu => {
    const item = context.layout[menu.stallIndex];
    if (!item) throw menuError("MENU_PREVIOUS_STALL", "已完成周次包含无效档口，不能静默复用", { week: previous.week });
    const indexes = context.catalogs[item.key];
    return [item.key, menu.dishIndexes.map(dishIndex => {
      if (dishIndex === -1) return -1;
      const local = indexes.indexOf(dishIndex);
      if (local === -1) throw menuError("MENU_PREVIOUS_DISH", "已完成周次包含候选外菜品，不能静默复用", { week: previous.week, stall: item.stall, dishIndex });
      return local;
    })];
  })) }));
}

export function weeklyInput(snapshots, options, context, week, previousWeeks) {
  const { candidates, catalogs } = context;
  return { week, totalWeeks: 6, start: options.start, meals: options.meals, workingDays: 5, layout: localLayout(context),
    dishFields: ["localIndex", "name", "price", "unit", "active", "verified"],
    dishCatalog: Object.fromEntries(Object.entries(catalogs).map(([key, indexes]) => [key, indexes.map((global, local) => {
      const d = candidates[global];
      return [local, d.name, d.price, d.unit, true,
        Object.fromEntries(["spicy", "vegetarian", "mainIngredient", "method", "labelSource"].filter(key => d[key] && d[key] !== "未知").map(key => [key, d[key]]))];
    })])),
    unknownLabels: "verified中没有的字段均为未知；不可猜测为已核验，但仍可安排具体候选并标记复核。每档口的localIndex独立从0开始，仅在对应S键内有效。",
    approvedActions: snapshots.actions.map(businessAction), previousWeeks: localPreviousWeeks(previousWeeks, context), fixedStaples: snapshots.fixedStaples || [],
    catalogCoverage: { provided: candidates.length, totalActive: candidates.length, complete: true },
    note: "menus为固定S键对象，每键数组只能引用dishCatalog同一S键内的localIndex。所有档口候选均完整提供，没有抽样或截断；不得跨S键使用索引。",
  };
}

function menuError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  // Only known field names and trusted layout values are surfaced for a bounded correction request.
  error.diagnostics = { code, week: details.week ?? null, stall: details.stall ?? null,
    day: details.day ?? null, meal: details.meal ?? null, slot: details.slot ?? null,
    dishIndex: Number.isSafeInteger(details.dishIndex) ? details.dishIndex : null };
  return error;
}

function positionDetails(item, options, offset) {
  if (!item || !Number.isSafeInteger(offset) || offset < 0) return {};
  const perMeal = item.priceRules.length;
  const day = Math.floor(offset / (perMeal * options.meals.length)) + 1;
  const mealIndex = Math.floor(offset / perMeal) % options.meals.length;
  return day <= 5 ? { day, meal: options.meals[mealIndex], slot: offset % perMeal } : {};
}

function parseWeek(raw, context, options, week, legacy) {
  const schema = legacy ? legacyWeeklySchema(context, options) : weeklySchema(context, options);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path || [];
    const item = path[0] === "menus" ? (legacy ? context.layout[raw?.menus?.[path[1]]?.stallIndex] : context.layout.find(item => item.key === path[1])) : undefined;
    const offset = legacy ? path[3] : path[2];
    const dishIndex = legacy ? raw?.menus?.[path[1]]?.dishIndexes?.[offset] : raw?.menus?.[path[1]]?.[offset];
    throw menuError("MENU_SCHEMA_INVALID", "AI 菜单结构或候选索引不符合本周档口约束，未使用本地算法补齐",
      { week, stall: item?.stall, ...positionDetails(item, options, offset), dishIndex });
  }
  if (legacy) return parsed.data;
  return { ...parsed.data, menus: context.layout.map(item => ({ stallIndex: item.stallIndex,
    dishIndexes: parsed.data.menus[item.key].map(local => local === -1 ? -1 : context.catalogs[item.key][local]),
  })) };
}

export function materializeWeek(raw, snapshots, options, context, week) {
  return materializeCanonical(parseWeek(raw, context, options, week, false), snapshots, options, context, week, true);
}

// Read-only compatibility for a recorded successful v1 week. Never use this to accept a fresh v2 response.
export function materializeLegacyWeek(raw, snapshots, options, context, week) {
  return materializeCanonical(parseWeek(raw, context, options, week, true), snapshots, options, context, week);
}

function materializeCanonical(result, snapshots, options, context, week, localDiagnostics = false) {
  const { stalls, candidates, layout } = context;
  const rows = new Map(result.menus.map((menu) => [menu.stallIndex, menu]));
  if (rows.size !== stalls.length) throw menuError("MENU_STALL_COVERAGE", "AI 菜单档口重复或遗漏，未生成完整菜单", { week });
  const entries = [];
  for (const item of layout) {
    const row = rows.get(item.stallIndex);
    if (!row || row.dishIndexes.length !== 5 * options.meals.length * item.priceRules.length)
      throw menuError("MENU_SLOT_COUNT", "AI 菜单槽位数量不正确，未使用本地算法补齐", { week, stall: item.stall });
    let index = 0;
    for (let day = 1; day <= 5; day++) {
      const date = new Date(`${options.start}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
      for (const meal of options.meals) for (const [slot, priceRule] of item.priceRules.entries()) {
        const dishIndex = row.dishIndexes[index++];
        const dish = candidates[dishIndex];
        const details = { week, stall: item.stall, day, meal, slot, dishIndex: localDiagnostics && dishIndex !== -1 ? context.catalogs[item.key].indexOf(dishIndex) : dishIndex };
        if (dishIndex !== -1 && (!dish || dish.stall !== item.stall)) throw menuError("MENU_DISH_REFERENCE", "AI 菜单引用候选外菜品或错误档口", details);
        if (item.manualRequired && dishIndex !== -1) throw menuError("MENU_MANUAL_REQUIRED", "源规则要求人工上传的档口不可由 AI 代填", details);
        if (item.fixed && dishIndex !== -1 && !item.fixedDishIndexes.includes(dishIndex)) throw menuError("MENU_FIXED_SOURCE", "AI 固定出品与源文件不符，不能把历史错误菜库当作固定样例", details);
        entries.push({ date: date.toISOString().slice(0, 10), week, day, meal, stall: item.stall, slot, priceRule, dishId: dish?.id || "", nameKey: dish?.name.replace(/\s/g, "") || "" });
      }
    }
  }
  if (entries.every(entry => !entry.dishId) && layout.some(item => !item.manualRequired && !item.noFeasibleSlots &&
      !(snapshots.planningMode === "per-stall" && item.stall === "五味坊" && layout.some(source => source.stall === "寻味列车") && !entries.some(entry => entry.stall === "寻味列车" && entry.dishId)) &&
      (item.fixed ? item.fixedDishIndexes.length : candidates.some(dish => dish.stall === item.stall))))
    throw menuError("MENU_EMPTY", "AI 未选出任何具体菜品，仅返回待补位置；未将空表保存为菜单", { week });
  const actions = new Map(snapshots.actions.map(a => [a.id, a]));
  const seen = new Set();
  const reviews = result.actionReviews.map(review => {
    const action = actions.get(review.actionId);
    if (!action || seen.has(action.id)) throw menuError("MENU_ACTION_REFERENCE", "AI 菜单事项引用不存在、未批准或重复", { week });
    seen.add(action.id);
    const positions = review.evidence.map(ref => {
      const entry = entries.find(e => e.stall === stalls[ref.stallIndex] && e.day === ref.day && e.meal === options.meals[ref.mealIndex] && e.slot === ref.slot);
      if (!entry?.dishId || !["全部档口", entry.stall].includes(action.targetStall)) throw menuError("MENU_ACTION_EVIDENCE", "AI 行动证据不在实际菜单内或超出批准档口", { week, stall: stalls[ref.stallIndex], day: ref.day, meal: options.meals[ref.mealIndex], slot: ref.slot });
      return { week, day: entry.day, meal: entry.meal, stall: entry.stall, slot: entry.slot, dishId: entry.dishId };
    });
    const occurrences = [...new Map(positions.map(position => [JSON.stringify(position), position])).values()];
    const status = review.status === "applied" && !occurrences.length ? "partial" : review.status;
    return { actionId: action.id, week, status, note: review.note + (status !== review.status ? "（没有可定位的菜单证据，保留人工核验。）" : ""), occurrences };
  });
  for (const action of snapshots.actions) if (!seen.has(action.id)) reviews.push({ actionId: action.id, week, status: "not_applied", note: "排菜员未提供该周落实说明，需复核。", occurrences: [] });
  return { entries, reviews, summary: result.summary, warnings: result.warnings, compact: { week, menus: result.menus } };
}

export function directActionImpacts(plan, planner, actions, dishes) {
  const byId = new Map(dishes.map(d => [d.id, d]));
  return actions.map(action => {
    const reviews = (planner.actionReviews || []).filter(r => r.actionId === action.id);
    const occurrences = reviews.flatMap(r => r.occurrences);
    const valid = occurrences.every(r => plan.entries.some(e => ["week", "day", "meal", "stall", "slot", "dishId"].every(k => e[k] === r[k])));
    const status = !valid || !reviews.length || reviews.every(r => r.status === "not_applied") ? "not_applied"
      : reviews.length === 6 && reviews.every(r => r.status === "applied") ? "applied" : "partial";
    return { actionId: action.id, title: action.title, targetStall: action.targetStall, revision: action.revision, instruction: action.menuInstruction,
      direct: true, status, selectedEntries: valid ? occurrences.length : 0, occurrences: valid ? occurrences : [],
      evidence: valid ? reviews.map(r => `第${r.week}周：${r.note}${r.occurrences.length ? `（${[...new Set(r.occurrences.map(e => byId.get(e.dishId)?.name || e.dishId))].slice(0, 6).join("、")}）` : ""}`) : ["菜单已修改，原事项落实位置与实际菜品不一致，需重新生成或复核。"],
    };
  });
}
