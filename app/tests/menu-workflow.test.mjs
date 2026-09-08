import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { generateMenu, checkMenu } from "../server/menus.mjs";
import {
  approvedMenuActions, attachMenuWorkflow, menuFingerprint, runMenuWorkflow, reinspectMenuWorkflow,
} from "../server/menu-workflow.mjs";

const options = { scope: "all", start: "2026-09-07", meals: ["午餐", "晚餐"], seed: 3, count: 2 };
const settings = { version: 1, plannerPrompt: "排菜员测试指令", inspectorPrompt: "独立检验员测试指令", feedbackPrompt: "反馈测试指令", operatorNotes: "优先考虑运营已核验的菜品" };
const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 12 }, (_, index) => ({
  id: `${group}-${index}`, name: `${stall}菜${index}`, stall, price: 12, unit: "份", active: true,
  spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料${index}`, method: "炒", labelSource: "厨房现场核验",
})));
const action = { id: "A-1", source: "aggregate", feedbackIds: ["F-1"], title: "暂停菜品0", targetStall: "档口甲", menuInstruction: "暂时停用档口甲菜0，待复核", priority: "high", status: "approved", enabled: true, revision: 2 };
function setup() {
  const store = createStore(":memory:", () => ({
    dishes, feedback: [{ id: "F-1", content: "反馈原文不应直接传给排菜员", type: "投诉", status: "未处理" }],
    rules: [{ stall: "档口甲", text: "同餐菜品不重复", source: { file: "餐厅排菜规则+示例.xlsx", sheet: "排菜规则", row: 3 } }],
    inventory: [], recipes: [], report: {},
  }));
  store.put("actions", action.id, action);
  store.put("settings", "current", settings);
  return store;
}
const planner = () => ({
  summary: "依据批准的行动停用菜品0，六周按本地价格和重复规则编排。",
  decisions: [{ dishId: "0-0", kind: "exclude", weight: 3, actionIds: [action.id], ruleIds: [], reason: "执行运营批准的临时停用要求" }],
  unresolved: [],
});
const inspector = () => ({ verdict: "pass", summary: "已检查全部实际菜单，仍需运营人工确认。", findings: [] });
function mockAi(overrides = {}) {
  const calls = [];
  return {
    calls,
    async respond(request) {
      calls.push(structuredClone(request));
      const data = await (overrides[request.role] || (request.role === "planner" ? planner : inspector))(request);
      return { data, model: "mock-model", usage: { input_tokens: 100, output_tokens: 50 }, requestId: `request-${calls.length}` };
    },
  };
}

test("AI workflow applies only approved enabled actions, persists provenance, and inspects real six-week output", async () => {
  const store = setup();
  for (const [id, patch] of [["pending", { status: "pending" }], ["rejected", { status: "rejected" }], ["disabled", { enabled: false }], ["non-menu", { menuInstruction: " " }]])
    store.put("actions", id, { ...action, id, ...patch });
  store.put("actions", "legacy-single", { ...action, id: "legacy-single", feedbackIds: undefined, feedbackId: "F-1" });
  const ai = mockAi();
  try {
    const baseline = generateMenu(dishes, options);
    assert.ok(baseline.entries.some((entry) => entry.dishId === "0-0"));
    const plan = await runMenuWorkflow({ store, ai, input: { ...options, scope: undefined, stall: "档口甲" }, settings });
    assert.equal(plan.scope, "all");
    assert.equal(plan.entries.length, 2 * 6 * 5 * 2 * 2);
    assert.ok(!plan.entries.some((entry) => entry.dishId === "0-0"));
    assert.deepEqual(ai.calls.map((call) => call.role), ["planner", "inspector"]);
    assert.deepEqual(ai.calls[0].input.approvedActions.map((item) => item.id), ["A-1"]);
    assert.ok(!JSON.stringify(ai.calls).includes("反馈原文不应直接传给排菜员"));
    assert.equal(ai.calls[1].input.actualMenu.tuples.length, plan.entries.length);
    assert.equal(ai.calls[1].input.actualMenu.weeks, 6);
    assert.equal(plan.workflow.status, "needs_review");
    assert.equal(plan.workflow.requiresHumanApproval, true);
    assert.equal(plan.workflow.actionImpacts[0].status, "applied");
    assert.equal(plan.workflow.actionImpacts[0].selectedEntries, 0);
    assert.ok(plan.workflow.actionImpacts[0].baselineEntries > 0);
    assert.ok(plan.workflow.actionImpacts[0].changedEntries > 0);
    const run = store.get("menuRuns", plan.workflow.runId);
    assert.equal(run.stage, "completed");
    assert.equal(run.snapshots.settings.version, 1);
    assert.equal(run.snapshots.rules[0].source.row, 3);
    assert.equal(run.snapshots.actions[0].revision, 2);
    assert.equal(run.workflow.menuFingerprint, menuFingerprint(plan));
    assert.equal(store.all("plans").length, 0);
  } finally { store.close(); }
});

test("raw unapproved feedback cannot affect deterministic menu generation, but prefer/avoid policies do", () => {
  const baseline = generateMenu(dishes, options);
  const rawComplaint = [{ type: "投诉", status: "未处理", content: baseline.entries[0].dishId === "0-0" ? "档口甲菜0" : dishes.find((dish) => dish.id === baseline.entries[0].dishId).name }];
  assert.deepEqual(generateMenu(dishes, options, rawComplaint).entries, baseline.entries);
  const preferred = generateMenu(dishes, options, [], [{ dishId: "0-0", kind: "prefer", weight: 3 }]);
  const avoided = generateMenu(dishes, options, [], [{ dishId: "0-0", kind: "avoid", weight: 3 }]);
  const count = (plan) => plan.entries.filter((entry) => entry.dishId === "0-0").length;
  assert.ok(count(preferred) > count(baseline));
  assert.ok(count(avoided) < count(baseline));
});

test("AI draft uses the canonical store stall order even when hashed dish IDs sort differently", async () => {
  const sourceDishes = [...dishes.filter((dish) => dish.stall === "档口乙"), ...dishes.filter((dish) => dish.stall === "档口甲")];
  const store = createStore(":memory:", () => ({ dishes: sourceDishes, feedback: [], rules: [], inventory: [], recipes: [], report: {} }));
  try {
    const ai = mockAi({ planner: () => ({ summary: "按原档口顺序排菜", decisions: [], unresolved: [] }) });
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    assert.deepEqual(plan.stalls, ["档口乙", "档口甲"]);
    assert.deepEqual(checkMenu(store.all("dishes"), plan).entries, plan.entries);
  } finally { store.close(); }
});

test("unknown or out-of-scope planner references fail and leave a failed run without a usable plan", async (t) => {
  const patches = [
    ["unknown dish", { dishId: "invented" }, /候选外/],
    ["unapproved action", { actionIds: ["A-unapproved"] }, /行动引用/],
    ["unknown rule", { ruleIds: ["R-invented"] }, /规则引用/],
    ["wrong stall", { dishId: "1-0" }, /目标档口/],
    ["no basis", { actionIds: [], ruleIds: [] }, /缺少.*依据/],
  ];
  for (const [name, patch, message] of patches) await t.test(name, async () => {
    const store = setup();
    try {
      const ai = mockAi({ planner: () => ({ ...planner(), decisions: [{ ...planner().decisions[0], ...patch }] }) });
      await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), message);
      const run = store.all("menuRuns")[0];
      assert.equal(run.stage, "failed");
      assert.equal(run.failedStage, "planning");
      assert.equal(run.workflow, undefined);
      assert.equal(ai.calls.length, 1);
    } finally { store.close(); }
  });
});

test("omitted actions have explicit not-applied evidence rather than disappearing", async () => {
  const store = setup();
  try {
    const ai = mockAi({ planner: () => ({ summary: "无法转换为菜库策略", decisions: [], unresolved: [] }) });
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    assert.equal(plan.workflow.actionImpacts[0].status, "not_applied");
    assert.equal(plan.workflow.inspector.verdict, "revise");
    assert.equal(plan.workflow.status, "blocked");
    assert.match(plan.workflow.actionImpacts[0].evidence[0], /未落实/);
    assert.equal(ai.calls[1].input.actionImpacts[0].status, "not_applied");
  } finally { store.close(); }
});

test("source rule strategy must stay within its stall, with explicit combined names and source aliases supported", async () => {
  const store = setup();
  try {
    const ai = mockAi({ planner: (request) => ({ ...planner(), decisions: [{ ...planner().decisions[0], dishId: "1-0", actionIds: [], ruleIds: [request.input.sourceRules[0].id] }] }) });
    await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /源规则的目标档口/);
    store.put("meta", "rules", [{ stall: "档口甲&档口乙", text: "菜品需复核" }, { stall: "续行", text: "暂缓选用" }, { stall: "铁锅炖", text: "至少两道炖菜" }]);
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    const rules = store.get("menuRuns", plan.workflow.runId).snapshots.rules;
    assert.deepEqual(rules[0].appliesTo, ["档口甲", "档口乙"]);
    assert.deepEqual(rules[1].appliesTo, rules[0].appliesTo);
    assert.deepEqual(rules[2].appliesTo, ["一锅烟火"]);
  } finally { store.close(); }
});

test("local hard-rule errors cannot be overridden by an AI pass", async () => {
  const store = setup();
  try {
    for (const dish of store.all("dishes")) store.put("dishes", dish.id, { ...dish, active: false });
    const ai = mockAi({ planner: () => ({ summary: "候选不可用", decisions: [], unresolved: [] }) });
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    assert.ok(plan.validation.errors > 0);
    assert.equal(plan.workflow.status, "blocked");
    assert.equal(plan.workflow.inspector.verdict, "revise");
    assert.ok(plan.workflow.inspector.findings.some((finding) => /硬规则/.test(finding.text)));
  } finally { store.close(); }
});

test("inspector must reference only dishes actually on the six-week menu", async () => {
  const store = setup();
  try {
    const ai = mockAi({ inspector: () => ({ ...inspector(), findings: [{ severity: "warning", text: "无效引用", actionIds: [], ruleIds: [], dishIds: ["0-0"] }] }) });
    await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /检验菜品引用/);
    assert.equal(store.all("menuRuns")[0].failedStage, "inspecting");
  } finally { store.close(); }
});

test("manual edits invalidate trustworthy inspection and can be independently re-inspected", async () => {
  const store = setup();
  const ai = mockAi();
  try {
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    const changed = structuredClone(plan);
    changed.entries[0].dishId = "0-0";
    const checked = checkMenu(dishes, changed);
    const restored = attachMenuWorkflow(store, checked, { ...plan.workflow, status: "approved", inspector: { verdict: "pass", summary: "伪造" } }, settings);
    assert.equal(restored.workflow.status, "stale");
    assert.equal(restored.workflow.stale, true);
    assert.notEqual(restored.workflow.inspector.summary, "伪造");
    const result = await reinspectMenuWorkflow({ store, ai, input: { ...restored, workflow: { runId: plan.workflow.runId } }, settings });
    assert.equal(result.workflow.stale, false);
    assert.equal(ai.calls.filter((call) => call.role === "planner").length, 1);
    assert.equal(ai.calls.filter((call) => call.role === "inspector").length, 2);
    assert.equal(result.workflow.actionImpacts[0].status, "partial");
    assert.equal(result.workflow.status, "blocked");
    assert.ok(result.validation.issues.some((issue) => issue.code === "POLICY_EXCLUDED"));
    assert.equal(store.get("menuRuns", result.workflow.runId).parentRunId, plan.workflow.runId);
  } finally { store.close(); }
});

test("approved action and prompt changes invalidate inspections, while unrelated feedback text does not", async () => {
  const store = setup();
  const ai = mockAi();
  try {
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    store.put("feedback", "F-2", { id: "F-2", content: "新反馈不能直接影响菜单" });
    assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, false);
    const feedbackOnlySettings = { ...settings, version: 2, feedbackPrompt: "更新反馈回复风格" };
    assert.equal(attachMenuWorkflow(store, plan, plan.workflow, feedbackOnlySettings).workflow.stale, false);
    const newSettings = { ...settings, version: 2, plannerPrompt: "运营修改了排菜要求" };
    assert.equal(attachMenuWorkflow(store, plan, plan.workflow, newSettings).workflow.stale, true);
    await assert.rejects(reinspectMenuWorkflow({ store, ai, input: plan, settings: newSettings }), /重新生成/);
    store.put("actions", action.id, { ...action, revision: 3, menuInstruction: "减少菜品0，恢复一部分" });
    const stale = attachMenuWorkflow(store, plan, plan.workflow, settings);
    assert.equal(stale.workflow.status, "stale");
    assert.match(stale.workflow.staleReasons.join(" "), /行动/);
    await assert.rejects(reinspectMenuWorkflow({ store, ai, input: plan, settings }), /重新生成/);
    assert.equal(approvedMenuActions(store)[0].revision, 3);
  } finally { store.close(); }
});

test("configuration changes while the model is running are detected before returning", async () => {
  const store = setup();
  try {
    const ai = mockAi({ inspector: () => { store.put("actions", action.id, { ...action, enabled: false }); return inspector(); } });
    const plan = await runMenuWorkflow({ store, ai, input: options, settings });
    assert.equal(plan.workflow.status, "stale");
    assert.match(plan.workflow.staleReasons.join(" "), /行动/);
  } finally { store.close(); }
});
