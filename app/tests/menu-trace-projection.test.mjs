import test from "node:test";
import assert from "node:assert/strict";
import { formatMenuTrace, projectMenuTrace } from "../src/menu-trace-projection.js";

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function translator() {
  const calls = [];
  return { calls, translateText: text => { calls.push(text); return "English: " + text; } };
}

test("audit projection translates rule, Action and planner/inspector prose without mutating source snapshots", () => {
  const source = freeze({
    input: { scope: "all", meals: ["午餐", "晚餐"], start: "2026-09-14", count: 4 },
    actions: [{ id: "行动-1", feedbackIds: ["反馈-1"], title: "增加清淡素菜", description: "试行并跟进",
      menuInstruction: "优先清淡菜", targetStall: "寻味列车", status: "approved", priority: "high",
      evidence: [{ feedbackId: "反馈-1", quote: "这个菜太咸了" }] }],
    rules: [{ id: "规则-1", stall: "寻味列车", originalStall: "寻味列车", appliesTo: ["寻味列车"],
      text: "每餐至少一道素菜", originalText: "素菜至少一道", meal: "午餐", source: { file: "规则.xlsx", sheet: "菜单", row: 5 } }],
    planner: { model: "模型-标识", summary: "已编排菜单", decisions: [{ dishId: "菜-1", kind: "prefer", reason: "符合行动要求", ruleIds: ["规则-1"] }],
      unresolved: [{ actionId: "行动-2", reason: "候选不足" }], warnings: ["标签待核验"], usage: { totalTokens: 123 } },
    inspector: { verdict: "revise", summary: "仍需复核", findings: [{ severity: "warning", text: "核对过敏原", dishIds: ["菜-1"] }] },
  });
  const original = JSON.stringify(source);
  const translation = translator();
  const result = projectMenuTrace(source, { language: "en", ...translation });
  assert.equal(result.actions[0].title, "English: 增加清淡素菜");
  assert.equal(result.actions[0].menuInstruction, "English: 优先清淡菜");
  assert.equal(result.rules[0].text, "English: 每餐至少一道素菜");
  assert.equal(result.rules[0].originalText, "English: 素菜至少一道");
  assert.equal(result.planner.summary, "English: 已编排菜单");
  assert.equal(result.planner.decisions[0].reason, "English: 符合行动要求");
  assert.equal(result.planner.unresolved[0].reason, "English: 候选不足");
  assert.equal(result.planner.warnings[0], "English: 标签待核验");
  assert.equal(result.inspector.summary, "English: 仍需复核");
  assert.equal(result.inspector.findings[0].text, "English: 核对过敏原");
  assert.deepEqual(result.input.meals, ["Lunch", "Dinner"]);
  assert.equal(result.input.scope, "All stalls");
  assert.equal(result.actions[0].status, "Approved");
  assert.equal(result.actions[0].priority, "High");
  assert.equal(result.planner.decisions[0].kind, "Prefer");
  assert.equal(result.inspector.verdict, "Revision required");
  assert.equal(result.inspector.findings[0].severity, "Warning");
  assert.equal(result.actions[0].id, "行动-1");
  assert.deepEqual(result.actions[0].evidence, source.actions[0].evidence);
  assert.deepEqual(result.rules[0].source, source.rules[0].source);
  assert.equal(result.rules[0].stall, "寻味列车");
  assert.equal(result.actions[0].targetStall, "寻味列车");
  assert.equal(result.planner.model, "模型-标识");
  assert.equal(JSON.stringify(source), original);
  assert.deepEqual(Object.keys(result), Object.keys(source));
  assert.ok(!translation.calls.includes("这个菜太咸了"));
  assert.ok(!translation.calls.includes("规则.xlsx"));
});

test("menu, recipe, feedback, quote and file/ID fields are never submitted for translation", () => {
  const raw = { name: "番茄炒蛋", title: "原始菜名", text: "馒头、米饭", summary: "原菜单说明", meal: "午餐",
    ingredients: [{ name: "鸡蛋", note: "原始配方" }], status: "原始状态" };
  const source = { summary: "审核摘要", actualMenu: raw, menus: [raw], dishes: [raw], entries: [raw],
    fixedStaples: [raw], fixedDishes: [raw], recipes: [raw], candidates: [raw], previousWeeks: [raw],
    feedback: { content: "希望加菜", title: "员工反馈", note: "原始备注" },
    records: [{ summary: "员工原话", passages: [{ text: "反馈片段" }] }],
    evidence: ["原始证据字符串", { quote: "原始引用", feedbackId: "反馈-1" }],
    source: { text: "源标识", file: "来源文件.xlsx" }, file: "规则.xlsx", sheet: "第一页", cell: "A1",
    ruleIds: ["规则-1"], promptHash: "中文指纹", ruleSourcePath: "中文路径", unknownField: "未识别字段" };
  const translation = translator();
  const result = projectMenuTrace(freeze(source), { language: "en", ...translation });
  assert.deepEqual(translation.calls, ["审核摘要"]);
  assert.deepEqual(result, { ...source, summary: "English: 审核摘要" });
  assert.notEqual(result.actualMenu, source.actualMenu);
});

test("only supplied Prompt fields are projected; no new audit fields are invented", () => {
  const source = { prompts: { planner: "按规则排菜", inspector: "独立核验" }, promptConfig: { menuSystemText: "遵守源规则", approvedActionText: "仅批准事项" },
    plannerPrompt: "规划要求", rawPrompt: "原始指令", settings: { operatorNotes: "减少重复" },
    promptVersion: 3, systemPromptId: "系统提示标识" };
  const translation = translator();
  const result = projectMenuTrace(source, { language: "en", ...translation });
  assert.equal(result.prompts.planner, "English: 按规则排菜");
  assert.equal(result.prompts.inspector, "English: 独立核验");
  assert.equal(result.promptConfig.menuSystemText, "English: 遵守源规则");
  assert.equal(result.promptConfig.approvedActionText, "English: 仅批准事项");
  assert.equal(result.plannerPrompt, "English: 规划要求");
  assert.equal(result.rawPrompt, "English: 原始指令");
  assert.equal(result.settings.operatorNotes, "English: 减少重复");
  assert.equal(result.systemPromptId, "系统提示标识");
  assert.deepEqual(projectMenuTrace({ summary: "Ready" }, { language: "en", ...translation }), { summary: "Ready" });
});

test("collapsed sections and Chinese mode never queue translations; opening only projects display data", () => {
  const source = freeze({ title: "改善事项", status: "approved", quote: "原话" });
  const translation = translator();
  assert.equal(formatMenuTrace(source, { language: "en", ...translation }), null);
  assert.equal(formatMenuTrace(source, { expanded: false, language: "en", ...translation }), null);
  assert.equal(formatMenuTrace(source, { expanded: true, language: "zh", ...translation }), JSON.stringify(source, null, 2));
  assert.deepEqual(projectMenuTrace(source, { language: "zh", ...translation }), source);
  assert.deepEqual(translation.calls, []);
  assert.deepEqual(JSON.parse(formatMenuTrace(source, { expanded: true, language: "en", ...translation })),
    { title: "English: 改善事项", status: "Approved", quote: "原话" });
  assert.deepEqual(translation.calls, ["改善事项"]);
  assert.equal(formatMenuTrace(source, { expanded: true, language: "zh", ...translation }), JSON.stringify(source, null, 2));
  assert.deepEqual(translation.calls, ["改善事项"]);
});

test("translation placeholders only affect translated fields and preserve primitives and unknown enum values", () => {
  const source = { note: "正在核验", priority: "custom-priority", title: "English title", warnings: [],
    count: 0, enabled: false, value: null, actionIds: ["A1"], evidence: [{ quote: "反馈原话" }] };
  const result = projectMenuTrace(source, { language: "en", translateText: () => "Translating…" });
  assert.deepEqual(result, { ...source, note: "Translating…" });
});
