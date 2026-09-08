import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { analyzeFeedback, updateAction, saveReply, monthlySummary, summarizeMonth } from "../server/feedback-ai.mjs";
import { getSettings, saveSettings, settingsHistory } from "../server/settings.mjs";
import { createAiClient } from "../server/ai.mjs";

function database() {
  return createStore(":memory:", () => ({ feedback: [{ id: "F1", content: "希望增加素食，蔬菜选择太少",
    restaurant: "档口甲", date: "2026-09-08", type: "建议", category: "菜品", status: "未处理", events: [] }],
    dishes: [{ id: "D1", name: "青菜", stall: "档口甲" }], rules: [], recipes: [], report: {}, inventory: [] }));
}
const proposal = { summary: "需要增加素食选择", replyDraft: "感谢建议，将提交运营评估。", keywords: ["素食"],
  actions: [{ title: "增加午餐素食", description: "检查素食候选并安排午餐", targetStall: "档口甲", menuInstruction: "午餐增加素食选项", priority: "medium" }] };

test("single feedback only drafts replies; aggregate action approval and edits remain auditable", async () => {
  const store = database();
  let calls = 0;
  const ai = { respond: async () => { calls++; return { data: proposal, model: "test", requestId: "test-id" }; } };
  try {
    const result = await analyzeFeedback(store, ai, "F1");
    assert.deepEqual(result.actions, []);
    assert.equal(store.all("actions").length, 0, "single feedback never generates an Action");
    assert.equal(store.get("feedback", "F1").replies, undefined);
    await analyzeFeedback(store, ai, "F1");
    assert.equal(calls, 1, "identical analysis is reused");
    const action = { id: "A-aggregate", source: "aggregate", kind: "menu", feedbackIds: ["F1"],
      title: "增加午餐素食", description: "评估本月素食需求", targetStall: "档口甲",
      menuInstruction: "午餐增加素食选项", priority: "medium", status: "pending", enabled: true, revision: 1,
      history: [{ at: new Date().toISOString(), kind: "汇总提议", revision: 1 }] };
    store.put("actions", action.id, action);
    assert.equal(updateAction(store, action.id, { status: "approved", reason: "运营已确认" }).status, "approved");
    const edited = updateAction(store, action.id, { menuInstruction: "每天两道素菜" });
    assert.equal(edited.status, "pending", "changing approved instructions requires review again");
    assert.equal(edited.history.length, 3);
    assert.equal(updateAction(store, action.id, { menuInstruction: "至少一道素菜", status: "approved" }).status, "approved");
    assert.throws(() => updateAction(store, action.id, { targetStall: "不存在" }));
    const reply = saveReply(store, "F1", { text: "已提交厨师长审核" });
    assert.equal(reply.replies[0].delivery, "local");
    assert.equal(reply.status, "未处理", "a reply is not evidence of completed work");
    await analyzeFeedback(store, ai, "F1");
    assert.equal(calls, 2);
    assert.equal(store.all("actions").length, 1);
    assert.equal(store.all("actions")[0].status, "approved");
    const linked = await analyzeFeedback(store, ai, "F1");
    assert.equal(linked.actions[0].id, action.id, "draft endpoint can read already linked aggregate actions");
  } finally { store.close(); }
});

test("monthly word counts exclude summary rows, zero months are empty, cached AI report becomes stale", async () => {
  const store = database();
  try {
    store.put("feedback", "summary", { id: "summary", date: "2026-09", content: "素食素食", summaryRecord: true });
    const summary = monthlySummary(store, "2026-09");
    assert.equal(summary.total, 1);
    assert.equal(summary.keywords.find((item) => item.text === "素食").count, 1);
    assert.equal(monthlySummary(store, "2026-10").total, 0);
    assert.throws(() => monthlySummary(store, "2026-13"));
    const report = await summarizeMonth(store, { respond: async () => ({ data: { text: "F1 关注素食" }, model: "test" }) }, "2026-09");
    assert.equal(report.aiSummary.text, "F1 关注素食");
    saveReply(store, "F1", { text: "已记录建议" });
    assert.equal(monthlySummary(store, "2026-09").aiSummary, null);
    const initial = getSettings(store);
    const { version, createdAt, ...input } = initial;
    assert.equal(version, 1);
    assert.ok(createdAt);
    saveSettings(store, { ...input, operatorNotes: "早餐优先温热餐食" });
    assert.equal(settingsHistory(store).length, 2);
    assert.equal(getSettings(store).version, 2);
  } finally { store.close(); }
});

test("Responses adapter keeps secret server-side, records tokens and rejects incomplete outputs", async () => {
  const store = database();
  const config = { endpoint: "https://test.services.ai.azure.com/openai/v1/responses", apiKey: "test-secret",
    model: "test-deployment", modelVersion: "test", budgetUsd: 150, inputPrice: null, outputPrice: null, timeoutMs: 1000 };
  let sent;
  try {
    const ai = createAiClient(store, { config, fetchImpl: async (_url, request) => { sent = request;
      return new Response(JSON.stringify({ id: "response-1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }] }), { status: 200 }); } });
    const result = await ai.respond({ role: "feedback", prompt: "测试", input: {}, schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } });
    assert.equal(result.data.ok, true);
    assert.equal(JSON.parse(sent.body).store, false);
    assert.equal(JSON.parse(sent.body).model, "test-deployment");
    assert.equal(sent.headers["api-key"], "test-secret");
    assert.equal(JSON.stringify(ai.status()).includes("test-secret"), false);
    assert.equal(ai.status().inputTokens, 10);
    assert.equal(ai.status().estimatedCostUsd, null);
    const broken = createAiClient(store, { config, fetchImpl: async () => new Response(JSON.stringify({ status: "incomplete", usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 }) });
    await assert.rejects(broken.respond({ role: "feedback", prompt: "测试", input: {}, schema: {} }), /未完成/);
    assert.equal(store.all("aiUsage").at(-1).status, "failed");
  } finally { store.close(); }
});
