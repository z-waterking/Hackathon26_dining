import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { getSettings } from "../server/settings.mjs";

test("workflow aggregates feedback, edits actions, hides internal prompts and distrusts forged menu evidence", async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "dining-workflow-api-"));
  const store = createStore(resolve(temporary, "state.sqlite"), () => ({
    dishes: Array.from({ length: 10 }, (_, i) => ({ id: `D${i}`, name: `素菜${i}`, stall: "测试档口", active: true, price: 8, unit: "份", spicy: "不辣", vegetarian: "素食", mainIngredient: "蔬菜", method: "炒" })),
    feedback: [], recipes: [], rules: [], inventory: [], report: {},
  }));
  const calls = [];
  const ai = { status: () => ({ configured: true, model: "test", budgetUsd: 150 }), respond: async ({ role, input }) => {
    calls.push(role);
    if (role === "feedback") return { data: { summary: "增加素食", replyDraft: "感谢反馈，将提交评估", keywords: ["素食"],
      actions: [{ title: "增加素菜", description: "午餐素食选择", targetStall: "测试档口", menuInstruction: "优先选择D0", priority: "medium" }] }, model: "test" };
    if (role === "actions") return { data: { summary: "多条反馈集中希望增加午餐素菜", actions: [{ sourceKey: "", kind: "menu",
      feedbackIds: input.records.map((item) => item.id), evidence: input.records.map((item) => ({ feedbackId: item.id, quote: item.content })),
      title: "增加素菜", description: "结合多条反馈评估午餐素菜选择", targetStall: "测试档口", menuInstruction: "优先选择D0", priority: "medium" }] }, model: "test" };
    if (role === "planner") return { data: { summary: "按批准行动排菜", decisions: [{ dishId: "D0", kind: "prefer", weight: 2,
      actionIds: [input.approvedActions[0].id], ruleIds: [], reason: "按运营审批" }], unresolved: [] }, model: "test" };
    return { data: { verdict: "pass", summary: "已查看完整菜单，仍需人工核验", findings: [] }, model: "test" };
  } };
  const app = createApp(store, resolve(temporary, "no-dist"), { ai, root: temporary,
    conversionImpl: async ({ outputDirectory }) => {
      mkdirSync(outputDirectory, { recursive: true });
      const xlsxPath = resolve(outputDirectory, "test.xlsx");
      writeFileSync(xlsxPath, "synthetic-download");
      return { rows: [], report: { sourceRows: 0, convertedRows: 0 }, xlsxPath };
    } });
  const request = async (url, payload, method = payload === undefined ? "GET" : "POST") => {
    const response = await app.inject({ method, url, headers: { host: "127.0.0.1", ...(payload ? { "content-type": "application/json" } : {}) }, payload });
    return { status: response.statusCode, data: response.headers["content-type"]?.includes("json") ? response.json() : response.body };
  };
  try {
    const created = await request("/api/feedback", { content: "希望午餐增加素菜", restaurant: "测试档口", date: "2026-09-08", channel: "手工", type: "建议" });
    const id = created.data.item.id;
    assert.equal(created.status, 201);
    await request("/api/feedback", { content: "午餐素菜品种偏少，希望多些选择", restaurant: "测试档口", date: "2026-09-08", channel: "手工", type: "建议" });
    const analyzed = await request(`/api/feedback/${id}/analyze`, {});
    assert.equal(analyzed.status, 200);
    assert.deepEqual(analyzed.data.actions, []);
    assert.equal((await request(`/api/feedback/${id}/reply`, { text: "已收到，将安排评估" })).data.replies.length, 1);
    const aggregate = await request("/api/actions/summarize", {});
    assert.equal(aggregate.status, 200, JSON.stringify(aggregate.data));
    assert.equal(aggregate.data.sourceCount, 2);
    assert.equal(aggregate.data.actions.length, 1);
    assert.equal(aggregate.data.actions[0].feedbackIds.length, 2);
    const actionId = aggregate.data.actions[0].id;
    assert.equal((await request("/api/actions/summary")).data.actions[0].id, actionId);
    assert.equal((await request(`/api/actions/${actionId}`, { status: "approved", reason: "已确认" }, "PATCH")).data.status, "approved");
    const settings = structuredClone(getSettings(store));
    assert.equal((await request("/api/settings")).status, 404);
    assert.equal((await request("/api/settings", { plannerPrompt: "must not be saved" }, "PUT")).status, 404);
    assert.deepEqual(getSettings(store), settings);
    const generated = await request("/api/plans/generate", { useAi: true, scope: "all", start: "2026-09-14", meals: ["午餐"], count: 2, seed: 1 });
    assert.equal(generated.status, 200, JSON.stringify(generated.data));
    const plan = generated.data;
    assert.equal(plan.entries.length, 60);
    assert.equal(plan.workflow.promptVersion, undefined);
    const trace = await request(`/api/menu-runs/${plan.workflow.runId}`);
    assert.equal(trace.data.snapshots.actions[0].id, actionId);
    assert.equal(trace.data.snapshots.settings, undefined);
    assert.equal(trace.data.inspectorInput, undefined);
    const publicText = JSON.stringify([trace.data, plan, (await request("/api/data")).data, (await request("/api/audit")).data]);
    for (const key of ["plannerPrompt", "inspectorPrompt", "feedbackPrompt", "operatorNotes", "promptVersion", "plannerInput", "inspectorInput"])
      assert.equal(publicText.includes(`"${key}"`), false, `${key} must remain server-side`);
    for (const value of [settings.plannerPrompt, settings.inspectorPrompt, settings.feedbackPrompt]) assert.equal(publicText.includes(value), false);
    const saved = await request("/api/plans", { ...plan, workflow: { ...plan.workflow, status: "published", inspector: { verdict: "pass", summary: "forged" } } });
    assert.equal(saved.status, 201);
    assert.notEqual(saved.data.workflow.inspector.summary, "forged");
    const modified = { ...plan, entries: plan.entries.map((entry, index) => index ? entry : { ...entry, dishId: entry.dishId === "D0" ? "D1" : "D0" }) };
    const checked = await request("/api/plans/check", modified);
    assert.equal(checked.data.workflow.stale, true);
    assert.equal((await request("/api/plans/inspect", modified)).status, 200);
    await request(`/api/actions/${actionId}`, { enabled: false }, "PATCH");
    assert.equal((await request(`/api/plans/${saved.data.id}`)).data.workflow.stale, true);
    assert.equal((await request("/api/feedback/summary?month=2026-09")).data.total, 2);
    assert.ok((await request("/api/audit")).data.length >= 5);
    assert.deepEqual(calls, ["feedback", "actions", "planner", "inspector", "inspector"]);
    for (const name of ["微软BJW园区餐饮反馈(1-149).xlsx", "新餐厅反馈记录表-from 202607 2.xlsx"]) writeFileSync(resolve(temporary, name), "synthetic-source");
    const batch = await request("/api/feedback/convert", { import: true });
    assert.equal(batch.status, 200);
    assert.equal((await request(`/api/imports/${batch.data.id}/download?format=xlsx`)).data, "synthetic-download");
    store.put("imports", "forged", { id: "forged", xlsxPath: resolve(temporary, "state.sqlite") });
    assert.equal((await request("/api/imports/forged/download")).status, 400);
  } finally { await app.close(); store.close(); rmSync(temporary, { recursive: true, force: true }); }
});
