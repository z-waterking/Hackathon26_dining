import test from "node:test";
import assert from "node:assert/strict";
import { buildFeedbackDistribution, buildFeedbackTrend, buildHandlingOverview, displayFeedbackType } from "../src/feedback-charts.js";

test("feedback distribution maps criticism for display without mutating source records", () => {
  const records = [{ type: "投诉" }, { type: "批评" }, { type: "建议" }, { type: "未分类" }, { type: " 表扬 " }];
  const before = structuredClone(records);
  const types = buildFeedbackDistribution(records);
  assert.equal(displayFeedbackType("投诉"), "批评");
  assert.equal(types.find((type) => type.name === "批评").count, 2);
  assert.equal(types.find((type) => type.name === "其他 / 待分类").count, 1);
  assert.equal(types.reduce((total, type) => total + type.count, 0), records.length);
  assert.equal(types.reduce((total, type) => total + type.fraction, 0), 1);
  assert.deepEqual(records, before);
});

test("monthly trend includes all months and retains month precision records", () => {
  const trend = buildFeedbackTrend([
    { date: "2026-08-21", type: "建议" }, { date: "2026-06", type: "投诉" },
    { date: "2026-07-03", type: "批评" }, { date: "2026-08", type: "表扬" },
    { date: "2026-02-30", type: "建议" }, { date: "", type: "询问" },
  ]);
  assert.deepEqual(trend.buckets.map((bucket) => bucket.key), ["2026-06", "2026-07", "2026-08"]);
  assert.deepEqual(trend.buckets.map((bucket) => bucket.total), [1, 1, 2]);
  assert.equal(trend.buckets[0].counts.批评, 1);
  assert.equal(trend.monthOnlyCount, 0);
  assert.equal(trend.undatedCount, 2);
  assert.equal(trend.plottedCount, 4);
});

test("weekly trend never assigns month-only feedback to an invented day", () => {
  const trend = buildFeedbackTrend([
    { date: "2026-09", type: "投诉" }, { date: "2026-09-01", type: "投诉" },
    { date: "2026-09-08", type: "建议" }, { date: "2026-09-30", type: "表扬" },
    { date: "2026-09-31", type: "询问" }, { date: "2026-08-31", type: "询问" },
  ], "2026-09");
  assert.deepEqual(trend.buckets.map((bucket) => bucket.label), ["1–7日", "8–14日", "15–21日", "22–28日", "29–30日"]);
  assert.deepEqual(trend.buckets.map((bucket) => bucket.total), [1, 1, 0, 0, 1]);
  assert.equal(trend.monthOnlyCount, 1);
  assert.equal(trend.undatedCount, 1);
  assert.equal(trend.plottedCount, 3);
});

test("weekly buckets honor leap years and count unknown types without losing feedback", () => {
  const trend = buildFeedbackTrend([{ date: "2024-02-29", type: "其他" }], "2024-02");
  assert.equal(trend.buckets.at(-1).label, "29日");
  assert.equal(trend.buckets.at(-1).counts["其他 / 待分类"], 1);
  assert.equal(trend.plottedCount, 1);
});

test("empty charts have no fabricated proportions and handling uses current real statuses", () => {
  assert.ok(buildFeedbackDistribution([]).every((type) => type.count === 0 && type.percent === 0));
  assert.equal(buildFeedbackTrend([], "2026-09").plottedCount, 0);
  const handling = buildHandlingOverview([{ status: "已完成" }, { status: "跟进中" }, { status: "未处理" }, { status: "待确认" }]);
  assert.equal(handling.total, 4);
  assert.equal(handling.completed, 1);
  assert.equal(handling.completionRate, 25);
  assert.equal(handling.unknownCount, 1);
  assert.deepEqual(handling.statuses.map((state) => state.count), [1, 1, 1]);
  assert.equal(buildHandlingOverview([]).completionRate, 0);
});
