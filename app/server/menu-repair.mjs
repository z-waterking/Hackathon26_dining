import { readFileSync } from "node:fs";
import { z } from "zod";
import { fitsPrice } from "./domain.mjs";
import { batchOptionsSchema, checkMenu } from "./menus.mjs";
import { attachMenuWorkflow, menuFingerprint } from "./menu-workflow.mjs";
import { directContext } from "./direct-menu-planner.mjs";
import { readStallCatalog, catalogFingerprint } from "./stored-stall-catalog.mjs";
import { audit } from "./settings.mjs";

const repairable = new Set(["PRICE", "POOL", "MISSING", "DUPLICATE", "REPEAT", "DUMPLING_OVERLAP",
  "MILD_PRICE", "GROUP_SPICE", "MAIN", "MILD", "SPICY", "VEGETARIAN", "METHOD", "STEAM_SPICE", "SHARED_MENU"]);
const issueSchema = z.object({ code: z.string().min(1).max(80), stall: z.string().max(100),
  date: z.string().max(10), meal: z.string().max(20), text: z.string().max(3000) }).strict();
const requestSchema = z.object({ plan: z.record(z.string(), z.unknown()), issue: issueSchema }).strict();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameGroup = (a, b) => ["stall", "date", "meal"].every(key => a[key] === b[key]);
const issueKey = issue => JSON.stringify([issue.level, issue.code, issue.stall, issue.date, issue.meal, issue.text]);
const known = value => Boolean(value && value !== "未知");
const labels = ["spicy", "vegetarian", "mainIngredient", "method"];
const dishIdentity = dish => dish && JSON.stringify([dish.name.replace(/\s/g, ""), dish.price, dish.unit]);

function introducesIssues(before, after) {
  const remaining = new Map();
  for (const issue of before) remaining.set(issueKey(issue), (remaining.get(issueKey(issue)) || 0) + 1);
  for (const issue of after) {
    const key = issueKey(issue);
    if (!remaining.get(key)) return true;
    remaining.set(key, remaining.get(key) - 1);
  }
  return false;
}

/** A bounded AI proposal changes one service group, never source data or prior runs. */
export async function repairMenuConflict({ store, ai, input, settings }) {
  const request = requestSchema.parse(input);
  const original = structuredClone(request.plan);
  const prior = store.get("menuRuns", original.workflow?.runId || "");
  if (original.partial || original.demo || prior?.demo || prior?.generationMode !== "gpt-direct" ||
      prior.stage !== "completed" || !prior.workflow || !prior.plan)
    throw new Error("仅支持已完成真实 AI 生成与检验的六周菜单，请先完成生成");
  if (original.workflow?.mode && original.workflow.mode !== "ai" ||
      original.generationRunId && original.generationRunId !== prior.id)
    throw new Error("菜单所属生成与检验记录不一致");
  if (!equal(batchOptionsSchema.parse(original), prior.input))
    throw new Error("菜单日期、餐次或配置已变更，请重新生成");
  const currentSettings = () => store.get("settings", "current") || settings;
  const checked = plan => attachMenuWorkflow(store,
    checkMenu(store.all("dishes"), { ...plan, generationMode: prior.generationMode }, null, { fixedDishes: prior.snapshots.fixedDishes }),
    { runId: prior.id, mode: "ai" }, currentSettings());
  // Test the original inspected menu, not the edited draft, to separate changes
  // to dishes from stale source rules / catalog / approvals / configuration.
  const assertStable = () => {
    if (!equal(store.get("menuRuns", prior.id), prior)) throw new Error("生成记录已变更，请重新打开菜单");
    const baseline = checked(prior.plan);
    if (baseline.workflow.stale) throw new Error(baseline.workflow.staleReasons.join("；"));
    if (!equal(store.get("meta", "menu-fixed-dishes") || [], prior.snapshots.fixedDishes || []) ||
        !equal(store.get("meta", "menu-fixed-staples") || [], prior.snapshots.fixedStaples || []))
      throw new Error("固定出品来源已变更，请重新生成");
  };
  assertStable();
  const before = checked(original);
  const target = before.validation.issues.find(issue => issue.code === request.issue.code &&
    sameGroup(issue, request.issue) && issue.text === request.issue.text);
  if (!target) throw new Error("该冲突已变化或不存在，请重新校验菜单后操作");
  const unchanged = summary => ({ plan: before, repair: { status: "unchanged", changedEntries: 0, summary } });
  if (target.level !== "error" || !repairable.has(target.code) || !target.date || !target.meal ||
      target.code === "SHARED_MENU" && target.stall !== "五味坊")
    return unchanged("此项需要人工核验、补充来源或定位，不能通过自动换菜标记为已解决。");
  const catalog = readStallCatalog(store);
  if (!catalog?.groups?.length) return unchanged("缺少已入库的档口候选菜，请先导入菜库。");
  const catalogHash = catalogFingerprint(catalog);
  const dishes = store.all("dishes");
  const byId = new Map(dishes.map(dish => [dish.id, dish]));
  const context = directContext({ ...prior.snapshots, dishes, stallCatalog: catalog, planningMode: "per-stall" }, prior.input);
  const layout = context.layout.find(item => item.stall === target.stall);
  if (!layout || layout.manualRequired || layout.fixed || ["百变厨房", "老广老北", "宽窄巷子"].includes(target.stall))
    return unchanged("人工上传或固定出品档口需要运营维护可信来源，不支持 AI 自动换菜。");
  const excluded = new Set((prior.planner.decisions || []).filter(item => item.kind === "exclude").map(item => item.dishId));
  const group = before.entries.filter(entry => sameGroup(entry, target));
  const sameMeal = before.entries.filter(entry => entry.date === target.date && entry.meal === target.meal);
  const sourceDishes = new Set(sameMeal.filter(entry => entry.stall === "寻味列车").map(entry => dishIdentity(byId.get(entry.dishId))).filter(Boolean));
  const candidates = context.candidates.filter(dish => dish.stall === target.stall && !excluded.has(dish.id) &&
    (target.stall !== "五味坊" || sourceDishes.has(dishIdentity(dish))))
    .map((dish, localIndex) => ({ localIndex, id: dish.id, name: dish.name, stall: dish.stall, price: dish.price, unit: dish.unit,
      spicy: dish.spicy || "未知", vegetarian: dish.vegetarian || "未知", mainIngredient: dish.mainIngredient || "",
      method: dish.method || "", labelSource: dish.labelSource || "" }));
  const slots = group.map(entry => {
    const previous = byId.get(entry.dishId);
    return { slot: entry.slot, dishId: entry.dishId, priceRule: entry.priceRule, allowedIndexes: candidates
      .filter(dish => fitsPrice(dish, entry.priceRule) && labels.every(key => !known(previous?.[key]) || known(dish[key])))
      .map(dish => dish.localIndex) };
  });
  if (!slots.length || slots.some(slot => !slot.allowedIndexes.length))
    return unchanged("本餐存在无合规候选的槽位（价格、来源或核验标签不足），请先维护菜库或关联来源菜单。");
  const responseSchema = z.object({ summary: z.string().min(1).max(1200),
    selections: z.array(z.number().int().min(0).max(candidates.length - 1)).length(slots.length) }).strict();
  const describe = entry => ({ week: entry.week, day: entry.day, date: entry.date, meal: entry.meal, stall: entry.stall,
    slot: entry.slot, dishId: entry.dishId, name: byId.get(entry.dishId)?.name || "待补", price: byId.get(entry.dishId)?.price, unit: byId.get(entry.dishId)?.unit });
  const response = await ai.respond({ role: "menu_repair",
    prompt: readFileSync(new URL("./prompts/menu-repair.md", import.meta.url), "utf8"),
    schema: z.toJSONSchema(responseSchema), maxOutputTokens: 2500,
    input: { target, slots, candidates,
      sourceRules: prior.snapshots.rules.filter(rule => rule.appliesTo.includes(target.stall) || rule.appliesTo.includes("全部档口")),
      approvedActions: prior.snapshots.actions.filter(action => [target.stall, "全部档口"].includes(action.targetStall))
        .map(({ id, title, targetStall, menuInstruction, priority }) => ({ id, title, targetStall, menuInstruction, priority })),
      stallSixWeeks: before.entries.filter(entry => entry.stall === target.stall).map(describe),
      otherStallsInMeal: sameMeal.filter(entry => entry.stall !== target.stall).map(describe),
      currentIssues: before.validation.issues.filter(issue => issue.stall === target.stall),
    } });
  assertStable();
  if (catalogFingerprint(readStallCatalog(store)) !== catalogHash) throw new Error("修复期间数据库候选菜库已变化，请重新打开菜单");
  const parsed = responseSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.selections.some((index, slot) => !slots[slot].allowedIndexes.includes(index)))
    return unchanged("AI 返回的候选索引或槽位约束无效，原菜单已保留；未自动重试。");
  const selections = parsed.data.selections;
  let changedEntries = 0;
  const proposed = { ...before, entries: before.entries.map(entry => {
    if (!sameGroup(entry, target)) return entry;
    const dishId = candidates[selections[group.findIndex(item => item.slot === entry.slot)]].id;
    if (dishId !== entry.dishId) changedEntries++;
    return { ...entry, dishId };
  }) };
  const after = checked(proposed);
  const targetCount = plan => plan.validation.issues.filter(issue => issue.code === target.code && sameGroup(issue, target)).length;
  if (!changedEntries || targetCount(after) >= targetCount(before) ||
      introducesIssues(before.validation.issues, after.validation.issues) ||
      after.validation.labelCoverage < before.validation.labelCoverage)
    return unchanged("本次 AI 提案未减少目标冲突，或产生了新的冲突/核验缺口；原菜单已保留，请人工调整或再次尝试。");
  after.workflow.repairPendingInspection = true;
  audit(store, "menu.conflict.repaired", prior.id, { issue: request.issue,
    beforeFingerprint: menuFingerprint(before), afterFingerprint: menuFingerprint(after),
    changes: group.flatMap(entry => {
      const updated = after.entries.find(item => sameGroup(item, entry) && item.slot === entry.slot);
      return updated.dishId === entry.dishId ? [] : [{ stall: entry.stall, date: entry.date, meal: entry.meal, slot: entry.slot, from: entry.dishId, to: updated.dishId }];
    }), model: response.model || "", requestId: response.requestId || "" });
  return { plan: after, repair: { status: "repaired", changedEntries,
    summary: `已调整本餐 ${changedEntries} 个菜品槽位，目标冲突减少且未新增本地冲突。旧评分已失效，请重新运行 AI 检验员后保存。` } };
}
