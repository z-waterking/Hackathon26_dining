import test from "node:test";
import assert from "node:assert/strict";
import { monthlySummary } from "../server/feedback-ai.mjs";

function summaryFor(feedback, dishes = []) {
  const store = {
    all: (table) => ({ feedback, dishes, actions: [] })[table] || [],
    get: () => null,
  };
  return monthlySummary(store, "2026-09");
}
const record = (id, content, extra = {}) => ({ id, content, date: "2026-09-08", status: "未处理", ...extra });

test("monthly keywords preserve dining phrases and omit signature and conversational fragments", () => {
  const result = summaryFor([
    record("1", "张三今天觉得寻味列车的麻辣烫好吃，希望增加素菜。寻味列车的麻辣烫好吃。\n姓名：李四\nAlias: employee@example.test"),
    record("2", "经常只有以前里面东西另外报名，服务态度很好。豆浆太甜，建议少糖。王小明"),
  ], [{ name: "麻辣烫", stall: "寻味列车" }]);
  const words = new Map(result.keywords.map((item) => [item.text, item.count]));
  for (const term of ["寻味列车", "麻辣烫", "素菜", "好吃", "服务态度", "豆浆", "太甜", "少糖"])
    assert.equal(words.get(term), 1);
  for (const term of ["张三", "李四", "王小明", "寻味", "列车", "麻辣", "经常", "里面", "报名", "服务"])
    assert.equal(words.has(term), false);
});

test("word cloud counts documents, excludes summaries and quarantine, and preserves approved menu names", () => {
  const result = summaryFor([
    record("1", "鱼香茄子很好吃，鱼香茄子可以保留。素食素食"),
    record("2", "素食选择少，等待时间很长"),
    record("3", "素食月度汇总", { summaryRecord: true }),
    record("4", "素食测试", { quarantined: true }),
    record("5", "素食", { date: "2026-08-31" }),
  ], [{ name: "鱼香茄子", stall: "五味坊" }]);
  assert.equal(result.total, 2);
  assert.equal(result.summaryRecords, 1);
  const words = new Map(result.keywords.map((item) => [item.text, item.count]));
  assert.equal(words.get("素食"), 2);
  assert.equal(words.get("鱼香茄子"), 1);
  assert.equal(words.get("等待时间"), 1);
  assert.equal(words.has("茄子"), false, "do not inflate a dish mention with its substring");
});

test("keyword model changes invalidate saved monthly summaries", () => {
  const feedback = [record("1", "鱼香茄子很好吃")];
  const before = summaryFor(feedback);
  const after = summaryFor(feedback, [{ name: "鱼香茄子", stall: "五味坊" }]);
  assert.notEqual(before.sourceFingerprint, after.sourceFingerprint);
});

test("negative phrases do not become positive topic substrings", () => {
  const result = summaryFor([record("1", "米饭不好吃，蔬菜不新鲜，餐盘不干净，汤没有味道。")]);
  const terms = new Set(result.keywords.map((item) => item.text));
  for (const term of ["不好吃", "不新鲜", "不干净", "没有味道"]) assert.ok(terms.has(term));
  for (const term of ["好吃", "新鲜", "干净", "味道"]) assert.ok(!terms.has(term));
});
