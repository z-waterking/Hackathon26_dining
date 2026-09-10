import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { getActionSummary, summarizeActions } from "../server/action-summary.mjs";
import { getSettings } from "../server/settings.mjs";
import { ensureDemoActions } from "../server/demo-actions.mjs";

const feedback = (id, content, extra = {}) => ({ id, content, restaurant: "档口甲", date: "2026-09-08",
  type: "建议", category: "菜品", status: "未处理", events: [], ...extra });
function database(t, records = [
  feedback("F1", "希望午餐增加素食选择", { date: "2026-07-08" }),
  feedback("F2", "蔬菜品种太少，希望增加青菜", { date: "2026-08-08" }),
  feedback("F3", "希望提供更多素食菜品"),
]) {
  const store = createStore(":memory:", () => ({ feedback: records, dishes: [{ id: "D1", name: "青菜", stall: "档口甲" }],
    rules: [], recipes: [], inventory: [], report: {} }));
  t.after(() => store.close());
  return store;
}
function proposal(extra = {}) {
  return { sourceKey: "", kind: "menu", title: "增加素食选择", description: "核对菜库并增加不同蔬菜的轮换",
    targetStall: "档口甲", menuInstruction: "午餐轮换至少两种素食菜品", priority: "medium",
    feedbackIds: ["F1", "F2", "F3"], evidence: [{ feedbackId: "F1", quote: "增加素食选择" }, { feedbackId: "F2", quote: "蔬菜品种太少" }], ...extra };
}
function fakeAi(data, callback = () => {}) {
  return { respond: async (input) => {
    callback(input);
    const actions = data.actions.map(({ evidence, ...action }) => ({ ...action, evidenceIds: evidence.map(({ feedbackId, quote }) =>
      input.input.records.find((record) => record.id === feedbackId)?.passages.find((passage) => passage.text.includes(quote))?.id || "unknown-quote") }));
    return { data: { ...data, actions }, model: "test-actions", requestId: "test-action-request", usage: {} };
  } };
}

test("all-month aggregation merges three feedback records into one pending action", async (t) => {
  const store = database(t);
  let sent;
  const result = await summarizeActions(store, fakeAi({ summary: "三条反馈共同关注素食多样性", actions: [proposal()] }, (request) => { sent = request; }));
  assert.equal(sent.role, "actions");
  assert.deepEqual(sent.input.records.map((record) => record.id), ["F1", "F2", "F3"]);
  assert.equal(sent.input.scope.month, "全部月份");
  assert.equal(sent.input.sourceCount, 3);
  assert.equal(sent.input.records[0].passages[0].text, store.get("feedback", "F1").content);
  assert.equal(sent.schema.properties.actions.items.properties.evidence, undefined);
  assert.ok(sent.schema.properties.actions.items.properties.evidenceIds);
  assert.match(sent.prompt, /核验：.*措施：.*验收：/);
  assert.match(sent.prompt, /不能把过去的反馈断言为今天仍在发生/);
  assert.match(sent.prompt, /不能为每条反馈逐条生成行动/);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  assert.equal(action.source, "aggregate");
  assert.equal(action.status, "pending");
  assert.equal(action.enabled, true);
  assert.equal(action.revision, 1);
  assert.equal(action.demo, false);
  assert.deepEqual(action.feedbackIds, ["F1", "F2", "F3"]);
  assert.equal(action.evidence[0].quote, store.get("feedback", "F1").content);
  assert.equal(result.reused, false);
  assert.deepEqual(Object.keys(result.analysis).sort(), ["createdAt", "id", "sourceCount", "sourceFingerprint", "summary"]);
  assert.ok(!JSON.stringify(result).includes(getSettings(store).feedbackPrompt));
  assert.equal(store.all("audit").filter((entry) => entry.kind === "actions.aggregated").length, 1);
});

test("not every feedback requires an action, zero proposals and empty scopes are valid", async (t) => {
  const store = database(t, [feedback("F1", "午餐很好吃，继续保持")]);
  const before = getActionSummary(store, { month: "2026-08" });
  assert.deepEqual(before, { analysis: null, sourceCount: 0, actions: [] });
  let calls = 0;
  const ai = fakeAi({ summary: "仅有积极评价，本次无需新增行动", actions: [] }, () => { calls++; });
  const empty = await summarizeActions(store, ai, { month: "2026-08" });
  assert.equal(empty.reused, true);
  assert.equal(calls, 0);
  const result = await summarizeActions(store, ai);
  assert.equal(result.actions.length, 0);
  assert.equal(result.analysis.sourceCount, 1);
  await summarizeActions(store, ai);
  assert.equal(calls, 1, "an empty action list is also cached");
  assert.throws(() => getActionSummary(store, { month: "2026-13" }));
});

test("real generation failure preserves existing actions and analysis without fabricating replacements", async (t) => {
  const store = database(t);
  await summarizeActions(store, fakeAi({ summary: "已分析", actions: [proposal()] }));
  const before = getActionSummary(store);
  const actions = store.all("actions");
  await assert.rejects(summarizeActions(store, { respond: async () => { throw new Error("Azure AI 请求失败"); } }, { force: true }), /Azure AI/);
  assert.deepEqual(store.all("actions"), actions);
  assert.deepEqual(getActionSummary(store), before);
});

test("model selects exact source passages; long feedback is complete and mismatched references fail closed", async (t) => {
  const content = "希望改进供餐".repeat(120) + "🥗请保留结尾";
  const store = database(t, [feedback("F1", content), feedback("F2", "第二条独立反馈")]);
  const { evidence: _evidence, ...base } = proposal({ feedbackIds: ["F1"] });
  const ai = { respond: async ({ input }) => {
    assert.equal(input.records[0].passages.map((item) => item.text).join(""), content);
    assert.ok(input.records[0].passages.every((item) => item.text.length <= 400));
    return { data: { summary: "需要改善供餐", actions: [{ ...base, evidenceIds: [input.records[0].passages.at(-1).id] }] } };
  } };
  const result = await summarizeActions(store, ai);
  assert.ok(content.endsWith(result.actions[0].evidence[0].quote));
  const before = store.all("actions");
  await assert.rejects(summarizeActions(store, { respond: async ({ input }) => ({ data: { summary: "错误引用", actions: [{ ...base, evidenceIds: [input.records[1].passages[0].id] }] } }) }, { force: true }), /原文片段/);
  assert.deepEqual(store.all("actions"), before);
});

test("cache and force refresh preserve manual approval, edited title and execution details", async (t) => {
  const store = database(t);
  let calls = 0;
  const ai = fakeAi({ summary: "素食是共同主题", actions: [proposal()] }, () => { calls++; });
  const first = await summarizeActions(store, ai);
  const action = first.actions[0];
  const edited = { ...action, title: "运营确认的蔬菜轮换", menuInstruction: "运营指定两周检查一次",
    status: "approved", enabled: false, revision: 8, history: [...action.history, { kind: "人工批准" }] };
  store.put("actions", action.id, edited);
  assert.equal((await summarizeActions(store, ai)).reused, true);
  assert.equal(calls, 1);
  const refreshed = await summarizeActions(store, ai, { force: true });
  assert.equal(calls, 2);
  assert.equal(refreshed.actions.length, 1);
  assert.equal(refreshed.actions[0].title, edited.title);
  assert.equal(refreshed.actions[0].status, "approved");
  assert.equal(refreshed.actions[0].menuInstruction, edited.menuInstruction);
  assert.equal(refreshed.actions[0].enabled, false);
  assert.equal(refreshed.actions[0].revision, 8);
  assert.notEqual(refreshed.analysis.id, first.analysis.id);
  assert.ok(store.get("meta", `action-summary-run:${first.analysis.id}`));
});

test("new same-topic evidence reuses a source key across month views without replacing human fields", async (t) => {
  const store = database(t);
  const first = await summarizeActions(store, fakeAi({ summary: "增加素食", actions: [proposal()] }));
  const action = first.actions[0];
  store.put("actions", action.id, { ...action, title: "人工另定标题", status: "approved", revision: 2 });
  store.put("feedback", "F4", feedback("F4", "希望再增加素食", { date: "2026-10-01" }));
  assert.equal(getActionSummary(store).analysis, null);
  const next = await summarizeActions(store, fakeAi({ summary: "新反馈继续支持既有事项", actions: [proposal({
    sourceKey: action.sourceKey, title: "另一个AI标题", feedbackIds: ["F4"], evidence: [{ feedbackId: "F4", quote: "再增加素食" }],
  })] }), { month: "2026-10" });
  assert.equal(store.all("actions").length, 1);
  assert.equal(next.actions[0].title, "人工另定标题");
  assert.equal(next.actions[0].status, "approved");
  assert.deepEqual(next.actions[0].feedbackIds, ["F1", "F2", "F3", "F4"]);
  assert.equal(next.actions[0].history.at(-1).kind, "聚合补充依据");
});

test("demo and real records, actions and caches are strictly isolated", async (t) => {
  const store = database(t, [
    feedback("R1", "真实素食选择较少"), feedback("D1", "演示素食选择较少", { demo: true }),
    feedback("D2", "演示二", { demo: "truthy legacy marker" }),
    feedback("S1", "月度汇总", { summaryRecord: true }), feedback("Q1", "隔离", { quarantined: true }),
  ]);
  let realIds;
  const real = await summarizeActions(store, fakeAi({ summary: "真实聚合", actions: [proposal({ feedbackIds: ["R1"], evidence: [{ feedbackId: "R1", quote: "真实素食" }] })] }, ({ input }) => { realIds = input.records.map((record) => record.id); }));
  assert.deepEqual(realIds, ["R1"]);
  let demoInput;
  const demo = await summarizeActions(store, fakeAi({ summary: "演示聚合", actions: [proposal({ feedbackIds: ["D1"], evidence: [{ feedbackId: "D1", quote: "演示素食" }] })] }, ({ input }) => { demoInput = input; }), { demo: true });
  assert.deepEqual(demoInput.records.map((record) => record.id), ["D1", "D2"]);
  assert.deepEqual(demoInput.existingActions, []);
  assert.equal(real.actions.length, 1);
  assert.equal(demo.actions.length, 1);
  assert.notEqual(real.actions[0].id, demo.actions[0].id);
  assert.equal(getActionSummary(store).actions[0].demo, false);
  assert.equal(getActionSummary(store, { demo: true }).actions[0].demo, true);
  assert.throws(() => getActionSummary(store, { demo: "false" }));
});

test("rejects fabricated feedback, quotes, scopes and inappropriate service menu instructions atomically", async (t) => {
  const invalid = [
    proposal({ feedbackIds: ["invented"] }),
    proposal({ evidence: [{ feedbackId: "F1", quote: "这是改写而不是原文" }] }),
    proposal({ feedbackIds: ["F1"], evidence: [{ feedbackId: "F2", quote: "蔬菜品种太少" }] }),
    proposal({ targetStall: "不存在" }),
    proposal({ sourceKey: "untrusted-new-id" }),
    proposal({ kind: "service", menuInstruction: "把队伍排进菜单" }),
    proposal({ kind: "menu", menuInstruction: "" }),
  ];
  for (const action of invalid) {
    const store = database(t);
    await assert.rejects(summarizeActions(store, fakeAi({ summary: "不应写入", actions: [action] })));
    assert.equal(store.all("actions").length, 0);
    assert.equal(store.all("audit").length, 0);
    assert.equal(getActionSummary(store).analysis, null);
  }
  const store = database(t);
  await assert.rejects(summarizeActions(store, fakeAi({ summary: "超过六个", actions: Array.from({ length: 7 }, () => proposal()) })));
});

test("service aggregation leaves menu requirements empty and need not cite unrelated feedback", async (t) => {
  const store = database(t, [feedback("F1", "排队时间很长"), feedback("F2", "餐具清洁改善了")]);
  const result = await summarizeActions(store, fakeAi({ summary: "建议优化排队，清洁评价无需新事项", actions: [proposal({
    kind: "service", title: "优化排队", description: "测量高峰排队时长并安排引导",
    targetStall: "全部档口", menuInstruction: "", feedbackIds: ["F1"], evidence: [{ feedbackId: "F1", quote: "排队时间很长" }],
  })] }));
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].menuInstruction, "");
  assert.deepEqual(result.actions[0].feedbackIds, ["F1"]);
});

test("refuses results if complete input or internal settings change while AI runs", async (t) => {
  for (const mutation of [
    (store) => store.put("feedback", "F4", feedback("F4", "新反馈改变范围")),
    (store) => store.put("feedback", "F1", { ...store.get("feedback", "F1"), content: "内容已修改" }),
    (store) => store.put("settings", "current", { ...getSettings(store), version: 2 }),
    (store) => store.put("actions", "other", { id: "other", title: "新事项", targetStall: "全部档口", source: "aggregate", feedbackIds: ["F1"], demo: false }),
  ]) {
    const store = database(t);
    await assert.rejects(summarizeActions(store, fakeAi({ summary: "旧快照结果", actions: [proposal()] }, () => mutation(store))), /已更新|原文片段/);
    assert.equal(store.all("audit").length, 0);
    assert.equal(getActionSummary(store).analysis, null);
  }
});

test("input limits fail before AI calls and never silently truncate", async (t) => {
  for (const records of [
    Array.from({ length: 1001 }, (_, index) => feedback(`F${index}`, "普通反馈")),
    [feedback("F1", "字".repeat(150001))],
  ]) {
    const store = database(t, records);
    let calls = 0;
    await assert.rejects(summarizeActions(store, fakeAi({ summary: "不应调用", actions: [] }, () => { calls++; })), /超过1000条|超过150000字符/);
    assert.equal(calls, 0);
  }
});

test("duplicate normalized topics in one response merge evidence into one item", async (t) => {
  const store = database(t);
  const result = await summarizeActions(store, fakeAi({ summary: "同一主题统一处理", actions: [
    proposal({ title: "增加 素食选择！", feedbackIds: ["F1"], evidence: [{ feedbackId: "F1", quote: "增加素食选择" }] }),
    proposal({ title: "增加素食选择", feedbackIds: ["F2", "F3"], evidence: [{ feedbackId: "F2", quote: "蔬菜品种太少" }] }),
  ] }));
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].feedbackIds, ["F1", "F2", "F3"]);
  assert.equal(result.actions[0].evidence.length, 2);
  assert.equal(store.all("audit").at(-1).created, 1);
});

test("built-in aggregate examples appear in demo summary without admitting legacy single-feedback actions", (t) => {
  const store = database(t, [feedback("real-feedback", "真实顾客意见")]);
  for (const [index, name] of ["青菜", "豆腐", "土豆"].entries()) {
    const id = `demo-dish-${index}`;
    store.put("dishes", id, { id, name, stall: "档口甲", active: true, price: 12, unit: "份" });
  }
  const seeded = ensureDemoActions(store);
  assert.equal(seeded.createdFeedback, 12);
  assert.equal(seeded.createdActions, 4);
  const feedbackId = seeded.feedbackIds[0];
  store.put("actions", "legacy-single", { id: "legacy-single", source: "demo", demo: true, feedbackId });
  store.put("actions", "legacy-single-array", { id: "legacy-single-array", source: "demo", demo: true, feedbackIds: [feedbackId], evidence: [{ feedbackId, quote: "演示" }] });
  store.put("actions", "misflagged-demo", { ...seeded.actions[0], id: "misflagged-demo", demo: false, feedbackIds: ["real-feedback"] });
  const summary = getActionSummary(store, { demo: true });
  assert.equal(summary.sourceCount, 12);
  assert.equal(summary.actions.length, 4);
  assert.deepEqual(summary.actions.map((action) => action.id).sort(), [...seeded.actionIds].sort());
  assert.ok(summary.actions.every((action) => action.feedbackIds.length === 3 && action.evidence.length === 3));
  const month = seeded.feedback[0].date.slice(0, 7);
  assert.equal(getActionSummary(store, { demo: true, month }).actions.length, 4);
  assert.equal(getActionSummary(store).sourceCount, 1);
  assert.equal(getActionSummary(store).actions.length, 0, "demo-tagged examples never enter the real aggregate list");
  const reloaded = ensureDemoActions(store);
  assert.equal(reloaded.createdActions, 0);
  assert.equal(getActionSummary(store, { demo: true }).actions.length, 4);
});
