import { planOptionsSchema, slotPrices } from "./domain.mjs";

const TARGET = 80;
const DIMENSIONS = [
  { key: "completeness", label: "供给完整", weight: 30 },
  { key: "rules", label: "价位、固定出品与档口规则", weight: 25 },
  { key: "rotation", label: "重复与轮换", weight: 20 },
  { key: "actions", label: "已批准 Action 执行", weight: 15 },
  { key: "verifiability", label: "可核验性", weight: 10 },
];
const ROTATION_CODES = new Set(["DUPLICATE", "REPEAT", "DUMPLING_OVERLAP", "MAIN", "CROSS_STALL_DUPLICATE"]);
const SEVERE_RULE_CODES = new Set(["POOL", "FIXED_SOURCE", "SHARED_MENU", "MANUAL_SOURCE_REQUIRED", "POLICY_EXCLUDED"]);
const clamp = (number) => Math.min(1, Math.max(0, number));
const round = (number) => Math.round(number * 10) / 10;
const groupKey = (entry, plan) => JSON.stringify([entry.stall || plan.stall, entry.date, entry.meal]);
const normalizedText = (text) => String(text || "").replace(/[\s，。；、:：,.!?！？]/g, "");
const issueKey = (issue) => JSON.stringify([issue.code, issue.stall || "", issue.date || "", issue.meal || ""]);

// Only a server-owned, fully checked six-week plan is a scoring input. Empty
// slots are valid structure and lose completeness points; omitted weeks/slots
// are not a complete assessment and must never receive a provisional high score.
function completeStructure(plan) {
  if (!plan || plan.partial === true) return null;
  const parsed = planOptionsSchema.safeParse({ ...plan, stall: plan.scope === "all" ? "全部档口" : plan.stall });
  if (!parsed.success || !Array.isArray(plan.entries)) return null;
  const options = parsed.data;
  const stalls = plan.scope === "all" ? plan.stalls : [options.stall];
  if (!Array.isArray(stalls) || !stalls.length || stalls.some(stall => typeof stall !== "string" || !stall.trim()) || new Set(stalls).size !== stalls.length) return null;
  const slots = new Map(stalls.map(stall => [stall, slotPrices(stall, options.count)]));
  const expected = 6 * 5 * options.meals.length * [...slots.values()].reduce((sum, values) => sum + values.length, 0);
  if (plan.entries.length !== expected) return null;
  const positions = new Set();
  const groups = new Map();
  for (const entry of plan.entries) {
    if (!entry || !Number.isInteger(entry.week) || entry.week < 1 || entry.week > 6 || !Number.isInteger(entry.day) || entry.day < 1 || entry.day > 5) return null;
    const stall = entry.stall || options.stall;
    const prices = slots.get(stall);
    if (!prices || !options.meals.includes(entry.meal) || !Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= prices.length || entry.priceRule !== prices[entry.slot] || typeof entry.dishId !== "string") return null;
    const date = new Date(`${options.start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (entry.week - 1) * 7 + entry.day - 1);
    if (entry.date !== date.toISOString().slice(0, 10)) return null;
    const position = JSON.stringify([stall, entry.week, entry.day, entry.meal, entry.slot]);
    if (positions.has(position)) return null;
    positions.add(position);
    const key = groupKey(entry, plan);
    if (!groups.has(key)) groups.set(key, { stall, date: entry.date, meal: entry.meal, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return { groups, total: expected };
}

function validValidation(validation) {
  return validation && Array.isArray(validation.issues) &&
    validation.issues.every(issue => issue && ["error", "warning"].includes(issue.level) && typeof issue.code === "string" && issue.code.length > 0) &&
    Number.isInteger(validation.errors) && validation.errors === validation.issues.filter(issue => issue.level === "error").length &&
    Number.isInteger(validation.warnings) && validation.warnings === validation.issues.filter(issue => issue.level === "warning").length &&
    Number.isFinite(validation.labelCoverage) && validation.labelCoverage >= 0 && validation.labelCoverage <= 100;
}

function validInspector(inspector) {
  return inspector && ["pass", "revise"].includes(inspector.verdict) && Array.isArray(inspector.findings) &&
    inspector.findings.every(finding => finding && ["error", "warning"].includes(finding.severity) && typeof finding.text === "string" && finding.text.trim());
}

function affectedGroups(issues, groups, { datedOnly = false } = {}) {
  const affected = new Set();
  for (const issue of issues) {
    if (datedOnly && !issue.date) continue;
    const stalls = issue.stall && issue.stall !== "全部档口" ? issue.stall.split("、") : null;
    for (const [key, group] of groups) {
      if (issue.date && issue.date !== group.date || issue.meal && issue.meal !== group.meal || stalls && !stalls.includes(group.stall)) continue;
      affected.add(key);
    }
  }
  return affected;
}

/**
 * Explainable quality score, not publication authorization. The caller must
 * supply checkMenu/validateMenu output plus trusted inspector/action impacts;
 * saved/client plan.score and plan.workflow are deliberately never consumed.
 *
 * All recurring issue deductions use affected service groups (stall/date/meal)
 * rather than raw warning counts. A hard error always costs points; severe
 * source/pool violations have a 10-point floor so large plans cannot dilute it.
 */
export function scoreMenu(plan, { actionImpacts = [], inspector, stale = false } = {}) {
  const validation = plan?.validation;
  const issues = Array.isArray(validation?.issues) ? validation.issues : [];
  const localErrors = issues.filter(issue => issue?.level === "error");
  const inspectorErrors = Array.isArray(inspector?.findings) ? inspector.findings.filter(finding => finding?.severity === "error") : [];
  const unknownIssues = issues.filter(issue => issue?.level === "warning" && !ROTATION_CODES.has(issue.code));
  const unknownCount = new Set(unknownIssues.map(issueKey)).size;
  // These are the actual two inspection lists, not a score-derived estimate.
  // Mirrored inspector findings remain visible blockers but do not multiply
  // their score penalty below. A score of 80+ never clears these errors.
  const blockers = localErrors.length + inspectorErrors.length;
  const structure = completeStructure(plan);
  const reason = stale ? "菜单或依据已变更，需重新审核" : !structure ? "六周菜单结构尚未完整，暂不评分"
    : !validValidation(validation) ? "缺少有效的完整本地校验，暂不评分"
      : !validInspector(inspector) ? "独立检验尚未完成，暂不评分" : "";
  if (reason) return {
    value: null, target: TARGET, targetMet: false, version: "menu-score-v1", label: "待完整审核",
    dimensions: DIMENSIONS.map(dimension => ({ ...dimension, earned: null, detail: reason })),
    blockers, unknownCount, summary: `${reason}。评分不能代替人工批准。`,
  };

  const { groups, total } = structure;
  const missingIssues = localErrors.filter(issue => issue.code === "MISSING");
  const missingGroups = affectedGroups(missingIssues, groups);
  let missing = plan.entries.filter(entry => !entry.dishId.trim()).length;
  // Normally checkMenu makes MISSING synonymous with empty slots. If a trusted
  // validator reports missing candidates with nonempty IDs, do not score those
  // unresolved service groups as completely supplied.
  for (const key of missingGroups) {
    const entries = groups.get(key).entries;
    if (entries.every(entry => entry.dishId.trim())) missing += entries.length;
  }
  const supplyEarned = 30 - Math.min(30, missing || missingIssues.length ? Math.max(30 * missing / total, 1) : 0);

  const ruleErrors = localErrors.filter(issue => issue.code !== "MISSING" && !ROTATION_CODES.has(issue.code));
  const rulesAffected = affectedGroups(ruleErrors, groups).size;
  const severe = ruleErrors.some(issue => SEVERE_RULE_CODES.has(issue.code));
  const rulePenalty = ruleErrors.length ? Math.max(rulesAffected / groups.size, severe ? 0.4 : 0.2) : 0;
  const localTexts = new Set(issues.map(issue => normalizedText(issue.text)).filter(Boolean));
  const novelInspectorErrors = inspectorErrors.filter(finding => !localTexts.has(normalizedText(finding.text)) &&
    !(localErrors.length && /本地硬规则发现.*项错误.*强制阻止/.test(finding.text)));
  // Without a structured location/code, a model finding cannot be converted
  // into invented thousands of violating slots. A bounded 5-point risk hold
  // overlaps (rather than stacks) with the local rule penalty.
  const inspectorPenalty = novelInspectorErrors.length ? 0.2 : 0;
  const rulesEarned = 25 * (1 - clamp(Math.max(rulePenalty, inspectorPenalty)));

  const rotationIssues = issues.filter(issue => ROTATION_CODES.has(issue.code));
  const rotationAffected = affectedGroups(rotationIssues, groups).size;
  const rotationFloor = rotationIssues.some(issue => issue.level === "error") ? 0.1 : rotationIssues.length ? 0.05 : 0;
  const rotationEarned = 20 * (1 - clamp(Math.max(rotationAffected / groups.size, rotationFloor)));

  // Explicit inputs are server-produced impact records, not raw actions or
  // client workflow summaries. Duplicate IDs receive the least favorable
  // status, so duplicates cannot inflate the execution percentage.
  const actionValues = new Map();
  const actionStatuses = new Map([["applied", 1], ["partial", 0.5], ["not_applied", 0]]);
  for (const impact of Array.isArray(actionImpacts) ? actionImpacts : []) {
    if (!impact || typeof impact.actionId !== "string" || !impact.actionId) continue;
    const value = actionStatuses.get(impact.status) ?? 0;
    actionValues.set(impact.actionId, Math.min(actionValues.get(impact.actionId) ?? 1, value));
  }
  const actionCount = actionValues.size;
  const applied = [...actionValues.values()].filter(value => value === 1).length;
  const partial = [...actionValues.values()].filter(value => value === 0.5).length;
  const actionEarned = actionCount ? 15 * [...actionValues.values()].reduce((sum, value) => sum + value, 0) / actionCount : 15;

  const uncertaintyRate = affectedGroups(unknownIssues, groups, { datedOnly: true }).size / groups.size;
  const uncertaintyFloor = unknownIssues.some(issue => !issue.date) ? 0.2 : unknownIssues.length ? 0.1 : 0;
  const verificationEarned = 10 * (1 - clamp(Math.max(1 - validation.labelCoverage / 100, uncertaintyRate, uncertaintyFloor)));
  const details = [
    `已安排 ${total - missing}/${total} 个槽位；按实际缺位比例计分，有缺位至少扣 1 分，人工待补槽位也计入缺位。`,
    `硬规则影响 ${rulesAffected}/${groups.size} 个档口餐次；普通硬错误至少扣 5 分，固定来源、菜库或档口等严重错误至少扣 10 分。${novelInspectorErrors.length ? "检验员另有风险提示，采用不重复叠加的至多 5 分风险扣分。" : ""}`,
    `重复或轮换问题影响 ${rotationAffected}/${groups.size} 个档口餐次；同一餐次重复提示合并，已确认错误至少扣 2 分，跨档口重复提醒至少扣 1 分。`,
    actionCount ? `${actionCount} 项已批准排菜 Action：已落实 ${applied}，部分落实 ${partial}，未落实 ${actionCount - applied - partial}；分别按 100%、50%、0% 计分。`
      : "N/A：本轮没有已批准且启用的排菜 Action，本项不扣分；这不是行动执行成果。",
    `完整标签覆盖 ${validation.labelCoverage}%；${unknownCount} 项类别/餐次待核验，未知信息不按硬规则违规计分，本维度最多扣 10 分。`,
  ];
  const earned = [supplyEarned, rulesEarned, rotationEarned, actionEarned, verificationEarned];
  const dimensions = DIMENSIONS.map((dimension, index) => ({ ...dimension, earned: round(earned[index]), detail: details[index] }));
  const value = round(dimensions.reduce((sum, dimension) => sum + dimension.earned, 0));
  const targetMet = value >= TARGET;
  return {
    value, target: TARGET, targetMet, version: "menu-score-v1",
    label: targetMet ? "达到优化目标" : value >= 60 ? "仍需改善" : "需重点整改",
    dimensions, blockers, unknownCount,
    summary: `${value} 分，${targetMet ? "达到" : "未达到"} ${TARGET} 分优化目标。${blockers ? `仍有 ${blockers} 项本地/检验员硬错误，不能因达标而发布。` : "无已报告硬错误，仍需人工批准。"}${unknownCount ? `另有 ${unknownCount} 项待核验；未知不等于合规。` : ""}`,
  };
}
