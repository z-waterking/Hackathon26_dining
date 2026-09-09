import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { feedbackInsights, monthlySummary } from "../server/feedback-ai.mjs";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const record = (id, content, extra = {}) => ({ id, content, date: "2026-09-08",
  type: "建议", status: "未处理", restaurant: "测试档口", ...extra });
const source = [
  record("aug", "素食素食，鱼香茄子好吃。", { date: "2026-08-31", status: "已完成" }),
  record("sep1", "素食选择少，排队排队，等待时间很长。", { type: "批评", status: "跟进中" }),
  record("sep2", "鱼香茄子好吃，鱼香茄子继续保留。", { type: "表扬" }),
  record("demo", "素食排队", { demo: true }),
  record("monthly", "素食排队", { summaryRecord: true }),
  record("quarantine", "素食排队", { quarantined: true }),
];
const dishes = [{ id: "D1", name: "鱼香茄子", stall: "测试档口" }];
function readOnly(feedback = source) {
  return { all(table) {
    assert.ok(["feedback", "dishes"].includes(table), "insights must only read source records and vocabulary");
    return table === "feedback" ? feedback : dishes;
  } };
}

test("dashboard insights aggregate all months without demo, summary or quarantine rows", () => {
  const before = JSON.stringify(source);
  const result = feedbackInsights(readOnly());
  assert.equal(result.month, "");
  assert.equal(result.total, 3);
  assert.deepEqual(result.byType, { 建议: 1, 批评: 1, 表扬: 1 });
  assert.deepEqual(result.byStatus, { 已完成: 1, 跟进中: 1, 未处理: 1 });
  assert.deepEqual(result.byMonth, [
    { month: "2026-08", total: 1, byType: { 建议: 1 } },
    { month: "2026-09", total: 2, byType: { 批评: 1, 表扬: 1 } },
  ]);
  const words = new Map(result.keywords.map(({ text, count }) => [text, count]));
  assert.equal(words.get("素食"), 2, "repeated literal mentions in one feedback count once");
  assert.equal(words.get("鱼香茄子"), 2);
  assert.equal(words.get("排队"), 1);
  assert.equal(words.get("等待时间"), 1);
  assert.equal(words.has("茄子"), false, "longest known dish name wins");
  assert.equal(result.undated, 0);
  assert.equal(JSON.stringify(source), before, "source records remain untouched");
});

test("dashboard monthly filter uses the same keyword counts as the existing monthly report", () => {
  const result = feedbackInsights(readOnly(), { month: "2026-09" });
  const monthlyStore = { all: (table) => ({ feedback: source, dishes, actions: [] })[table], get: () => null };
  const report = monthlySummary(monthlyStore, "2026-09");
  assert.equal(result.total, 2);
  assert.equal(result.month, "2026-09");
  assert.deepEqual(result.keywords, report.keywords);
  assert.deepEqual(result.byMonth, [{ month: "2026-09", total: 2, byType: { 批评: 1, 表扬: 1 } }]);
  assert.deepEqual(feedbackInsights(readOnly(), { month: "" }), feedbackInsights(readOnly()));
});

test("empty scopes have no invented topics, types or months", () => {
  const empty = { month: "2026-10", total: 0, keywords: [], byType: {}, byStatus: {}, byMonth: [], undated: 0 };
  assert.deepEqual(feedbackInsights(readOnly(), { month: "2026-10" }), empty);
  assert.deepEqual(feedbackInsights(readOnly([])), { ...empty, month: "" });
});

test("legacy missing dates and categories stay explicit rather than being assigned a false month", () => {
  const result = feedbackInsights(readOnly([record("unknown", "菜单", { date: null, type: "", status: null })]));
  assert.equal(result.total, 1);
  assert.equal(result.undated, 1);
  assert.deepEqual(result.byType, { 未分类: 1 });
  assert.deepEqual(result.byStatus, { 未处理: 1 });
  assert.deepEqual(result.byMonth, []);
  assert.equal(feedbackInsights(readOnly([record("unknown", "菜单", { date: null })]), { month: "2026-09" }).total, 0);
});

test("dashboard scope validates month and rejects unsupported filters", () => {
  for (const month of ["2026-00", "2026-13", "2026-9", "2026-09-08", " 2026-09", null, 202609])
    assert.throws(() => feedbackInsights(readOnly(), { month }));
  assert.throws(() => feedbackInsights(readOnly(), { demo: true }));
});

test("dashboard GET endpoint is local, read-only and returns no feedback text or model configuration", async () => {
  const feedback = [...source, record("private", "素食建议。\n姓名：内部姓名\nEmail: private@example.test",
    { owner: "负责人姓名", reply: "内部回复", aiAnalysis: { promptVersion: 7, replyDraft: "内部草稿" } })];
  const store = createStore(":memory:", () => ({ feedback, dishes, recipes: [], rules: [], inventory: [], report: {} }));
  let calls = 0;
  const app = createApp(store, resolve(import.meta.dirname, "fixtures/no-dashboard-dist"), { ai: {
    status: () => ({ configured: false }),
    respond: () => { calls++; throw new Error("dashboard must not call AI"); },
  } });
  const tables = ["feedback", "dishes", "plans", "transactions", "meta", "actions", "settings", "menuRuns", "imports", "aiUsage", "audit"];
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, store.all(table)]));
  const before = snapshot();
  try {
    const response = await app.inject({ method: "GET", url: "/api/feedback/insights", headers: { host: "127.0.0.1" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().total, 4);
    assert.equal(response.headers["cache-control"], "no-store");
    for (const term of ["private@example.test", "内部姓名", "负责人姓名", "内部回复", "内部草稿", "promptVersion", "feedbackPrompt", "apiKey"])
      assert.equal(response.body.includes(term), false, `${term} must not be exposed`);
    const month = await app.inject({ method: "GET", url: "/api/feedback/insights?month=2026-08", headers: { host: "localhost" } });
    assert.equal(month.statusCode, 200);
    assert.equal(month.json().total, 1);
    const emptyMonth = await app.inject({ method: "GET", url: "/api/feedback/insights?month=", headers: { host: "localhost" } });
    assert.equal(emptyMonth.json().total, 4);
    for (const query of ["month=2026-13", "month=2026-9", "month=2026-09-01", "demo=true", "month=2026-08&month=2026-09"]) {
      const invalid = await app.inject({ method: "GET", url: `/api/feedback/insights?${query}`, headers: { host: "localhost" } });
      assert.equal(invalid.statusCode, 400, query);
    }
    const external = await app.inject({ method: "GET", url: "/api/feedback/insights", headers: { host: "external.example" } });
    assert.equal(external.statusCode, 403);
    assert.equal(calls, 0);
    assert.deepEqual(snapshot(), before, "GET does not persist reports, settings, usage or audit entries");
  } finally { await app.close(); store.close(); }
});
