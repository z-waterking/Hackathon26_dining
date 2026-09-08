import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

function setup() {
  const dishes = Array.from({ length: 12 }, (_, index) => ({
    id: `D-${String(index).padStart(2, "0")}`, name: `测试菜品${index}`,
    stall: "测试档口", active: true, price: 12, unit: "份",
    spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "",
  }));
  const store = createStore(":memory:", () => ({
    dishes, feedback: [], recipes: [], rules: [], inventory: [], report: {},
  }));
  const calls = [];
  const ai = {
    status: () => ({ configured: true, model: "api-test-no-network" }),
    respond: async (request) => {
      calls.push(structuredClone(request));
      throw new Error("API 测试禁止真实 AI 调用");
    },
  };
  const app = createApp(store, resolve(import.meta.dirname, "__missing_demo_api_dist__"), { ai });
  async function request(url, payload, method = payload === undefined ? "GET" : "POST") {
    const response = await app.inject({
      method, url, payload,
      headers: { host: "127.0.0.1", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    });
    return { status: response.statusCode, data: response.json() };
  }
  return { store, calls, request, close: async () => { await app.close(); store.close(); } };
}

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], count: 2, seed: 1 };

test("demo API seeds aggregates idempotently, applies approved policy, enforces explicit reinspection and isolates real data", async () => {
  const { store, calls, request, close } = setup();
  try {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const month = date.slice(0, 7);
    const real = await request("/api/feedback", {
      content: "希望午餐排队更有秩序", restaurant: "测试档口", date, channel: "手工", type: "建议",
    });
    assert.equal(real.status, 201);
    const beforeSummary = await request(`/api/feedback/summary?month=${month}`);
    assert.equal(beforeSummary.status, 200);
    assert.equal(beforeSummary.data.total, 1);

    const seeded = await request("/api/demo/actions", {});
    assert.equal(seeded.status, 200, JSON.stringify(seeded.data));
    assert.equal(seeded.data.createdFeedback, 12);
    assert.equal(seeded.data.createdActions, 4);
    assert.equal(seeded.data.feedback.length, 12);
    assert.equal(seeded.data.actions.length, 4);
    for (const action of seeded.data.actions) {
      assert.equal(action.status, "pending");
      assert.equal(action.demo, true);
      assert.equal(action.feedbackIds.length, 3);
      assert.equal(action.evidence.length, 3);
      for (const evidence of action.evidence)
        assert.equal(evidence.quote, seeded.data.feedback.find((item) => item.id === evidence.feedbackId).content);
    }
    const repeated = await request("/api/demo/actions", {});
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.createdFeedback, 0);
    assert.equal(repeated.data.createdActions, 0);
    assert.deepEqual(repeated.data.actionIds, seeded.data.actionIds);
    assert.deepEqual(repeated.data.feedbackIds, seeded.data.feedbackIds);

    const baseline = await request("/api/plans/generate", options);
    assert.equal(baseline.status, 200);
    const preferred = seeded.data.actions.find((action) => action.demoPolicy[0]?.kind === "prefer");
    assert.ok(preferred);
    const approved = await request(`/api/actions/${preferred.id}`, { status: "approved", reason: "仅批准示例以测试菜单影响" }, "PATCH");
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, "approved");
    const afterApprovalSeed = await request("/api/demo/actions", {});
    assert.equal(afterApprovalSeed.data.actions.find((action) => action.id === preferred.id).status, "approved");

    const generated = await request("/api/plans/generate", { ...options, demo: true });
    assert.equal(generated.status, 200, JSON.stringify(generated.data));
    const plan = generated.data;
    const dishId = preferred.demoPolicy[0].dishId;
    const count = (menu) => menu.entries.filter((entry) => entry.dishId === dishId).length;
    assert.ok(count(plan) > count(baseline.data));
    assert.equal(plan.entries.length, 6 * 5 * 2 * 2);
    assert.equal(plan.demo, true);
    assert.equal(plan.workflow.mode, "demo");
    assert.equal(plan.workflow.requiresHumanApproval, true);
    assert.equal(plan.workflow.actionImpacts.length, 1);
    assert.equal(plan.workflow.actionImpacts[0].actionId, preferred.id);
    assert.equal(plan.workflow.actionImpacts[0].status, "applied");
    assert.equal(plan.workflow.planner.model, "local-demo-no-ai");

    const missingFlag = structuredClone(plan);
    delete missingFlag.demo;
    const missing = await request("/api/plans/inspect", missingFlag);
    const explicitFalse = await request("/api/plans/inspect", { ...plan, demo: false });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /显式 demo: true/);
    assert.equal(explicitFalse.status, 400);
    const inspected = await request("/api/plans/inspect", { ...plan, demo: true });
    assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
    assert.equal(inspected.data.demo, true);
    assert.equal(inspected.data.workflow.mode, "demo");
    assert.equal(inspected.data.workflow.inspector.model, "local-demo-no-ai");
    assert.equal(calls.length, 0);
    assert.equal(store.all("aiUsage").length, 0);

    const data = await request("/api/data");
    assert.equal(data.status, 200);
    assert.equal(data.data.feedback.length, 13);
    assert.equal(data.data.feedback.filter((item) => item.demo === true).length, 12);
    assert.equal(data.data.feedback.filter((item) => !item.demo).length, 1);
    assert.ok(data.data.actions.every((action) => action.demo === true));
    const summary = await request(`/api/feedback/summary?month=${month}`);
    assert.equal(summary.data.total, 1);
    assert.equal(summary.data.sourceFingerprint, beforeSummary.data.sourceFingerprint);
    assert.deepEqual(summary.data.keywords, beforeSummary.data.keywords);
    assert.equal(summary.data.approvedActions, 0);
    assert.equal(summary.data.pendingActions, 0);
    const realActions = await request("/api/actions/summary");
    assert.equal(realActions.status, 200);
    assert.equal(realActions.data.sourceCount, 1);
    assert.deepEqual(realActions.data.actions, []);

    // The formal endpoint deliberately hits the throwing mock. Inspect the
    // actual planner input to prove approved demos were excluded before it.
    const formal = await request("/api/plans/generate", { ...options, useAi: true });
    assert.equal(formal.status, 502);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, "planner");
    assert.deepEqual(calls[0].input.approvedActions, []);
    assert.ok(!JSON.stringify(calls[0].input).includes("A-demo-"));
    assert.ok(!JSON.stringify(calls[0].input).includes("F-demo-"));
    const failedRun = store.all("menuRuns").at(-1);
    assert.equal(failedRun.demo, false);
    assert.equal(failedRun.stage, "failed");
    assert.deepEqual(failedRun.snapshots.actions, []);
  } finally { await close(); }
});

test("action API changes kind with menu requirements and does not replay a service sample as a menu policy", async () => {
  const { calls, request, close } = setup();
  try {
    const seeded = await request("/api/demo/actions", {});
    const service = seeded.data.actions.find((action) => action.kind === "service");
    assert.ok(service);
    assert.equal(service.menuInstruction, "");
    const menuAction = await request(`/api/actions/${service.id}`, { menuInstruction: "在测试档口优先安排测试菜品0", status: "approved", reason: "编辑示例以测试分类同步" }, "PATCH");
    assert.equal(menuAction.status, 200);
    assert.equal(menuAction.data.kind, "menu");
    assert.equal(menuAction.data.status, "approved");
    const generated = await request("/api/plans/generate", { ...options, demo: true });
    assert.equal(generated.status, 200);
    assert.equal(generated.data.workflow.actionImpacts[0].actionId, service.id);
    assert.equal(generated.data.workflow.actionImpacts[0].status, "not_applied");
    assert.match(generated.data.workflow.planner.unresolved[0].reason, /已编辑/);
    const cleared = await request(`/api/actions/${service.id}`, { menuInstruction: "", reason: "改回无排菜要求的事项" }, "PATCH");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.kind, "other");
    assert.equal(cleared.data.menuInstruction, "");
    assert.equal(cleared.data.status, "pending");
    assert.equal(calls.length, 0);
  } finally { await close(); }
});
