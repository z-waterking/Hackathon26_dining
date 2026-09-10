import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { ensureDemoActions } from "../server/demo-actions.mjs";
import { generateMenu, checkMenu } from "../server/menus.mjs";
import { approvedMenuActions, attachMenuWorkflow, runMenuWorkflow, runDemoMenuWorkflow, reinspectMenuWorkflow } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const dishes = ["甲档口", "乙档口"].flatMap((stall, group) => Array.from({ length: 12 }, (_, index) => ({
  id: `dish-${group}-${String(index).padStart(2, "0")}`, name: `${stall}菜品${index}`, stall,
  price: 12, unit: "份", active: true, spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "",
})));
const settings = { version: 1, plannerPrompt: "测试内部配置", inspectorPrompt: "测试检验内部配置", operatorNotes: "" };
const options = { demo: true, scope: "all", start: "2026-09-07", seed: 1, meals: ["午餐", "晚餐"], count: 2 };
function setup(items = dishes) {
  const store = createStore(":memory:", () => ({ dishes: items, feedback: [], rules: [{ stall: "全部档口", text: "同餐次不重复", source: { file: "排菜规则.xlsx", sheet: "规则", row: 3 } }], recipes: [], inventory: [], report: {} }));
  store.put("settings", "current", settings);
  return store;
}
function approve(store, id) {
  const action = store.get("actions", id);
  store.put("actions", id, { ...action, status: "approved", approvedAt: "2026-09-08T01:00:00Z", revision: action.revision + 1 });
}
function realAi() {
  const calls = [];
  return { calls, async respond(input) {
    calls.push(input);
    return { data: input.role === "planner" ? directWeeklyResponse(input) : { verdict: "pass", summary: "AI测试响应", findings: [] }, model: "mock-ai" };
  } };
}

test("demo seed creates 12 explicitly labeled feedback rows and four evidence-backed aggregate pending actions", () => {
  const store = setup();
  try {
    const result = ensureDemoActions(store);
    assert.equal(result.createdFeedback, 12);
    assert.equal(result.createdActions, 4);
    assert.equal(result.actions.filter((action) => action.menuInstruction).length, 3);
    assert.ok(result.feedback.every((feedback) => feedback.demo && feedback.source === "demo" && feedback.content.startsWith("[演示数据") && feedback.aiAnalysis.replyDraft));
    for (const action of result.actions) {
      assert.equal(action.status, "pending");
      assert.equal(action.feedbackIds.length, 3);
      assert.equal(action.evidence.length, 3);
      assert.equal(action.demo, true);
      for (const evidence of action.evidence) assert.equal(evidence.quote, store.get("feedback", evidence.feedbackId).content);
      for (const policy of action.demoPolicy) {
        const dish = store.get("dishes", policy.dishId);
        assert.equal(dish.active, true);
        assert.equal(dish.stall, action.targetStall);
        assert.equal(dish.vegetarian, "未知");
      }
    }
  } finally { store.close(); }
});

test("repeated demo seed preserves edits and approval even if the original dish becomes inactive", () => {
  const store = setup();
  try {
    const result = ensureDemoActions(store);
    const original = result.actions[0];
    const changed = { ...original, status: "approved", title: "运营已修改的示例", revision: 8 };
    store.put("actions", original.id, changed);
    store.put("feedback", result.feedback[0].id, { ...result.feedback[0], reply: "保存的回复" });
    for (const dish of dishes) store.put("dishes", dish.id, { ...dish, active: false });
    const again = ensureDemoActions(store);
    assert.equal(again.createdFeedback, 0);
    assert.equal(again.createdActions, 0);
    assert.deepEqual(again.actions[0], changed);
    assert.equal(again.feedback[0].reply, "保存的回复");
  } finally { store.close(); }
});

test("demo seed rejects ID collisions and inadequate active inventory without partial writes", () => {
  const store = setup();
  const empty = setup(dishes.slice(0, 2));
  try {
    store.put("actions", "A-demo-aggregate-prefer", { id: "A-demo-aggregate-prefer", title: "真实行动" });
    assert.throws(() => ensureDemoActions(store), /ID.*冲突/);
    assert.equal(store.all("feedback").length, 0);
    assert.throws(() => ensureDemoActions(empty), /至少需要 3 道/);
    assert.equal(empty.all("actions").length, 0);
  } finally { store.close(); empty.close(); }
});

test("simulation requires explicit demo mode, applies only approved sample policies, and never records AI usage", async () => {
  const store = setup();
  try {
    const seeded = ensureDemoActions(store);
    const baseline = generateMenu(store.all("dishes"), options);
    await assert.rejects(runDemoMenuWorkflow({ store, input: { ...options, demo: false }, settings }), /显式/);
    const before = await runDemoMenuWorkflow({ store, input: options, settings });
    assert.deepEqual(before.entries, baseline.entries);
    assert.equal(before.workflow.actionImpacts.length, 0);
    for (const action of seeded.actions) approve(store, action.id);
    const plan = await runDemoMenuWorkflow({ store, input: options, settings });
    assert.equal(plan.demo, true);
    assert.equal(plan.workflow.mode, "demo");
    assert.match(plan.workflow.source, /不调用 AI/);
    assert.equal(plan.workflow.requiresHumanApproval, true);
    assert.equal(plan.workflow.actionImpacts.length, 3);
    assert.equal(plan.workflow.planner.model, "local-demo-no-ai");
    assert.equal(plan.workflow.inspector.model, "local-demo-no-ai");
    assert.equal(store.all("aiUsage").length, 0);
    for (const action of seeded.actions.filter((item) => item.menuInstruction)) {
      const { dishId, kind } = action.demoPolicy[0];
      const beforeCount = baseline.entries.filter((entry) => entry.dishId === dishId).length;
      const afterCount = plan.entries.filter((entry) => entry.dishId === dishId).length;
      if (kind === "prefer") assert.ok(afterCount > beforeCount);
      if (kind === "avoid") assert.ok(afterCount < beforeCount);
      if (kind === "exclude") assert.equal(afterCount, 0);
    }
    assert.equal(checkMenu(store.all("dishes"), plan).entries.length, plan.entries.length);
    const run = store.get("menuRuns", plan.workflow.runId);
    assert.equal(run.demo, true);
    assert.equal(run.snapshots.actions[0].feedbackIds.length, 3);
    assert.equal(run.snapshots.actions[0].evidence.length, 3);
  } finally { store.close(); }
});

test("edited or unavailable sample policy is unresolved instead of falsely replaying the old instruction", async () => {
  const store = setup();
  try {
    const seeded = ensureDemoActions(store);
    const action = seeded.actions[0];
    approve(store, action.id);
    store.put("actions", action.id, { ...store.get("actions", action.id), menuInstruction: "运营修改成完全不同的目标", revision: 3 });
    const edited = await runDemoMenuWorkflow({ store, input: options, settings });
    assert.equal(edited.workflow.actionImpacts[0].status, "not_applied");
    assert.equal(edited.workflow.status, "blocked");
    assert.match(edited.workflow.planner.unresolved[0].reason, /已编辑/);
    const excluded = seeded.actions.find((item) => item.demoPolicy[0]?.kind === "exclude");
    approve(store, excluded.id);
    const dish = store.get("dishes", excluded.demoPolicy[0].dishId);
    store.put("dishes", dish.id, { ...dish, active: false });
    const inactive = await runDemoMenuWorkflow({ store, input: options, settings });
    assert.match(inactive.workflow.planner.unresolved.find((item) => item.actionId === excluded.id).reason, /已停用/);
  } finally { store.close(); }
});

test("formal workflow completely isolates demo actions and demo changes do not invalidate formal plans", async () => {
  const store = setup();
  const ai = realAi();
  try {
    const seeded = ensureDemoActions(store);
    for (const action of seeded.actions) approve(store, action.id);
    assert.equal(approvedMenuActions(store).length, 0);
    assert.equal(approvedMenuActions(store, { demo: true }).length, 3);
    const plan = await runMenuWorkflow({ store, ai, input: { ...options, demo: false }, settings });
    assert.equal(plan.workflow.mode, "ai");
    assert.ok(!JSON.stringify(ai.calls).includes("A-demo-"));
    assert.ok(!JSON.stringify(ai.calls).includes("F-demo-"));
    assert.equal(store.get("menuRuns", plan.workflow.runId).snapshots.actions.length, 0);
    const action = store.get("actions", seeded.actions[0].id);
    store.put("actions", action.id, { ...action, enabled: false, revision: 9 });
    assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, false);
    await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /模拟排菜测试入口/);
    assert.equal(ai.calls.length, 7);
  } finally { store.close(); }
});

test("simulation ignores real actions and safely re-inspects only within its server-recorded mode", async () => {
  const store = setup();
  let realCalls = 0;
  try {
    const seeded = ensureDemoActions(store);
    approve(store, seeded.actions[0].id);
    store.put("actions", "A-real", { id: "A-real", feedbackIds: ["F-real1", "F-real2"], title: "真实行动不可进入演示", targetStall: "全部档口", menuInstruction: "真实指令不可进入演示", priority: "high", status: "approved", enabled: true, revision: 1 });
    const plan = await runDemoMenuWorkflow({ store, input: options, settings });
    assert.ok(!JSON.stringify(store.get("menuRuns", plan.workflow.runId).plannerInput).includes("A-real"));
    store.put("actions", "A-real", { ...store.get("actions", "A-real"), menuInstruction: "调整真实指令", revision: 2 });
    assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, false);
    const ai = { respond() { realCalls++; throw new Error("不允许调用真实AI"); } };
    await assert.rejects(reinspectMenuWorkflow({ store, ai, input: { ...plan, demo: false }, settings }), /模式不可混用/);
    assert.throws(() => attachMenuWorkflow(store, plan, { ...plan.workflow, mode: "ai" }, settings), /模式不可混用/);
    const rechecked = await reinspectMenuWorkflow({ store, ai, input: plan, settings });
    assert.equal(realCalls, 0);
    assert.equal(rechecked.workflow.mode, "demo");
    assert.equal(rechecked.demo, true);
    assert.equal(store.get("menuRuns", rechecked.workflow.runId).parentRunId, plan.workflow.runId);
  } finally { store.close(); }
});
