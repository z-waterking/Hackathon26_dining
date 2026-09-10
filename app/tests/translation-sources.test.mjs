import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "../server/store.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";
import { collectPayloadTranslationSources, collectTranslationSources } from "../server/translation-sources.mjs";
import { cachedTranslationView, createUiTranslator, prewarmUiTranslations } from "../server/ui-translations.mjs";
import { hasChinese, translationParts } from "../shared/translation-text.mjs";
import { monthlySummary } from "../server/feedback-ai.mjs";
import { defaultSettings } from "../server/settings.mjs";

const keyFor = (text, version = "ui-en-v1") => "ui-translation:" + createHash("sha256").update(version + "\0" + text).digest("hex");
const allState = store => Object.fromEntries(COLLECTIONS.map(name => [name, store.all(name)]));
function setup(t) {
  const store = createStore(":memory:", () => ({ dishes: [{ id: "D1", name: "原菜单禁止发送", stall: "原档口禁止发送", price: 10, unit: "份", active: true }],
    feedback: [{ id: "F1", content: "原反馈禁止发送", date: "2026-09-01", channel: "渠道说明甲", category: "分类说明甲", status: "未处理", type: "建议",
      reply: "当前回复甲", replies: [{ text: "已存回复甲" }], events: [{ kind: "跟进类型甲", text: "跟进说明甲" }, { kind: "跟进类型乙", text: "跟进说明乙" }],
      targetRow: { 反馈内容: "转换原文禁止发送", 餐厅: "转换档口禁止发送", 反馈跟进: "转换跟进甲", 回复记录: "转换回复甲" },
      aiAnalysis: { summary: ["分析说明甲", "分析说明乙"], replyDraft: "回复草稿甲", keywords: ["汇总热词甲"] } }],
    recipes: [{ name: "配方菜名禁止发送", ingredients: [{ name: "原料禁止发送" }], issues: ["配方错误甲", "配方错误乙"] }],
    rules: [{ stall: "原档口禁止发送", text: "资料排菜规则甲", meal: "午餐", source: { file: "规则.xlsx", sheet: "规则表", row: 3 } }], inventory: [], report: {} }));
  t.after(() => store.close());
  store.put("actions", "A1", { id: "A1", title: "改善事项甲", description: "改善说明甲", menuInstruction: "  菜单要求甲  ", targetStall: "原档口禁止发送",
    status: "approved", enabled: true, feedbackIds: ["F1"], evidence: [{ quote: "引用原文禁止发送" }], history: [{ kind: "调整类型甲",
      reason: ["修改原因甲", "修改原因乙"], previous: { title: "修改前标题甲", description: "修改前说明甲", content: "前快照原文禁止发送",
        sources: [{ text: "前快照来源禁止发送" }], evidence: [{ quote: "前快照引用禁止发送" }] } }] });
  store.put("meta", "source-sheet:do-not-read", { data: { title: "源文件内容禁止发送", text: "源文件单元格禁止发送" } });
  return store;
}

test("shared translation splitting preserves exact source including newline boundaries", () => {
  for (const input of ["", "already English", "中文", "中".repeat(810) + "\n" + "文".repeat(2500), "中".repeat(2000) + "\n尾部中文"]) {
    assert.equal(translationParts(input).join(""), input);
    assert.ok(translationParts(input).every(part => part.length <= 2001));
  }
  assert.equal(hasChinese(null), false);
  assert.equal(hasChinese("English"), false);
  assert.equal(hasChinese("中文"), true);
});

test("store source collection is read-only and excludes original feedback, menus, sources and Prompt-only text", t => {
  const store = setup(t);
  const before = allState(store);
  const reads = { get: store.get, all(name) { assert.notEqual(name, "meta", "collector must never scan all metadata"); return store.all(name); } };
  const publicSources = collectTranslationSources(reads, { includePrompts: false });
  for (const expected of ["改善事项甲", "改善说明甲", "菜单要求甲", "  菜单要求甲  ", "修改前标题甲", "修改原因甲；修改原因乙",
    "渠道说明甲", "分类说明甲", "当前回复甲", "已存回复甲", "跟进说明甲\n跟进说明乙", "转换跟进甲", "转换回复甲",
    "分析说明甲；分析说明乙", "回复草稿甲", "汇总热词甲", "配方错误甲；配方错误乙", "资料排菜规则甲"])
    assert.ok(publicSources.includes(expected), "missing expected allowlisted display prose");
  assert.ok(publicSources.every(text => !text.includes("禁止发送")));
  assert.ok(!publicSources.includes("未处理"), "static dictionary entries need no model translation");
  assert.ok(!publicSources.includes(defaultSettings.plannerPrompt));
  assert.deepEqual(allState(store), before);
  const allSources = collectTranslationSources(reads);
  assert.ok(allSources.length > publicSources.length);
  assert.ok(allSources.some(text => text.includes("你是")));
  assert.deepEqual(allState(store), before);
  assert.equal(store.get("settings", "current"), null);
});

test("payload projection matches combined workflow UI text and avoids raw snapshots and prompt boundaries", () => {
  const payload = { summary: ["当前摘要甲", "当前摘要乙"], promptConfig: { title: "私有配置禁止发送", menuSystemText: "私有系统禁止发送" },
    plan: { entries: [{ text: "原菜单禁止发送" }], fixedStaples: [{ text: "主食禁止发送" }], validation: { issues: [{ text: "冲突描述甲" }] },
      workflow: { source: "当前生成方式甲", staleReasons: ["失效原因甲", "失效原因乙"],
        score: { label: "评分标题甲", summary: "评分摘要甲", dimensions: [{ label: "维度标题甲", detail: "维度说明甲" }] },
        planner: { summary: "排菜摘要甲", unresolved: [{ reason: "未解决说明甲" }], raw: { text: "模型原始内容禁止发送" } },
        inspector: { summary: "检验摘要甲", findings: [{ text: "检验问题甲" }] },
        actionImpacts: [{ title: "应用标题甲", instruction: "应用要求甲", evidence: ["执行依据甲", { reason: "执行原因甲", quote: "引用禁止发送" }] }],
        stallCatalog: { warnings: [{ reason: "来源待核验甲" }], records: [{ text: "菜库原始内容禁止发送" }] } } },
    snapshots: { prompts: { planner: "留痕指令禁止发送" }, feedback: [{ text: "留痕反馈禁止发送" }], actions: [{ title: "历史标题甲" }] } };
  const copy = structuredClone(payload);
  const sources = collectPayloadTranslationSources(payload);
  for (const text of ["当前摘要甲；当前摘要乙", "当前生成方式甲", "失效原因甲；失效原因乙", "冲突描述甲", "评分摘要甲", "维度说明甲",
    "排菜摘要甲", "未解决说明甲", "检验问题甲", "应用要求甲", "执行依据甲", "执行原因甲", "来源待核验甲", "历史标题甲"])
    assert.ok(sources.includes(text));
  assert.ok(sources.every(text => !text.includes("禁止发送")));
  assert.deepEqual(payload, copy);
});

test("Prompt DTO translation scope includes current instructions and rules but excludes unused per-stall previews", () => {
  const payload = { actionGenerationText: "反馈生成指令甲", menuSystemText: "排菜系统指令甲", approvedActionText: "批准事项指令甲", localConstraintsText: "本地约束甲",
    rules: [{ text: "当前规则甲", originalText: "来源规则甲", source: { label: "运营来源甲", file: "来源标识禁止发送.xlsx" } }],
    previews: { actionGeneration: "实际反馈指令甲", menuSystem: "实际排菜指令甲", approvedActions: "实际批准指令甲", menuByStall: [{ text: "隐藏档口指令禁止发送" }] } };
  const visible = collectPayloadTranslationSources(payload, { includePrompts: true });
  for (const text of ["反馈生成指令甲", "排菜系统指令甲", "批准事项指令甲", "本地约束甲", "当前规则甲", "来源规则甲", "运营来源甲", "实际反馈指令甲", "实际排菜指令甲", "实际批准指令甲"])
    assert.ok(visible.includes(text));
  assert.ok(visible.every(text => !text.includes("禁止发送")));
  const publicSources = collectPayloadTranslationSources(payload);
  assert.ok(!publicSources.some(text => /指令|本地约束/.test(text)));
});

test("thread continuations stay original even in nested feedback and combined handling text", t => {
  const store = setup(t);
  const item = store.get("feedback", "F1");
  item.events.push({ kind: "线程补充", text: "员工续帖禁止发送" });
  item.targetRow.反馈跟进 = "原有跟进\n员工续帖禁止发送";
  store.put("feedback", item.id, item);
  const before = allState(store);
  for (const sources of [collectTranslationSources(store, { includePrompts: false }),
    collectPayloadTranslationSources({ item }), collectPayloadTranslationSources({ feedback: item }),
    collectPayloadTranslationSources({ rows: [{ targetRow: item.targetRow }], item })]) {
    assert.ok(sources.every(text => !text.includes("员工续帖禁止发送") && !text.includes("原反馈禁止发送") && !text.includes("转换原文禁止发送")));
  }
  assert.deepEqual(allState(store), before);
});

test("generic API counters and malformed optional arrays never make payload cache projection fail", () => {
  for (const payload of [{ rows: 42, actions: 3, plans: 1, keywords: 4, events: 3, replies: 8, history: 9, rules: 16 },
    { rows: null, actions: {}, plans: "统计", keywords: null, events: {}, replies: null, history: "记录", rules: {} },
    { events: [null], replies: [null], history: [null], workflow: { actionImpacts: [null], stallCatalog: { warnings: 2 } } }]) {
    assert.doesNotThrow(() => collectPayloadTranslationSources(payload));
    assert.doesNotThrow(() => collectPayloadTranslationSources(payload, { includePrompts: true }));
  }
});

test("short original feedback phrases do not suppress independent Action, rule or Prompt explanations", t => {
  const store = setup(t);
  store.put("feedback", "short", { id: "short", content: "菜单", date: "2026-09-02", events: [] });
  store.put("actions", "short-action", { id: "short-action", title: "菜单丰富度调整甲", description: "根据菜单反馈执行改善甲", status: "pending" });
  const sources = collectTranslationSources(store);
  assert.ok(sources.includes("菜单丰富度调整甲"));
  assert.ok(sources.includes("根据菜单反馈执行改善甲"));
  assert.ok(sources.includes("资料排菜规则甲"));
  assert.ok(sources.some(text => text.includes("菜单") && text.includes("只")));
});

test("lightweight DTO sources include catalog label evidence, AI status notes and nested feedback replies", () => {
  const sources = collectPayloadTranslationSources({ labelSource: "厨房核验说明甲", costNote: "估算费用说明甲",
    aiStatus: { costNote: "当前预算说明甲", reason: "服务状态说明甲" },
    feedback: { content: "原文不翻译", reply: "回复说明甲" } });
  for (const text of ["厨房核验说明甲", "估算费用说明甲", "当前预算说明甲", "服务状态说明甲", "回复说明甲"])
    assert.ok(sources.includes(text));
  assert.ok(!sources.includes("原文不翻译"));
});

test("saved plan custom review statuses are included in offline source collection", t => {
  const store = setup(t);
  store.put("plans", "P-status", { id: "P-status", status: "运营待复查甲", entries: [], validation: { issues: [] } });
  assert.ok(collectTranslationSources(store, { includePrompts: false }).includes("运营待复查甲"));
});

test("saved monthly summaries can be collected without implicitly initializing settings", t => {
  const store = setup(t);
  const reads = { all: store.all, get: (name, id) => name === "settings" ? defaultSettings : store.get(name, id) };
  const summary = monthlySummary(reads, "2026-09");
  store.put("meta", "feedback-summary-2026-09", { text: "已有月报说明甲", sourceFingerprint: summary.sourceFingerprint, promptVersion: 1 });
  const before = allState(store);
  assert.ok(collectTranslationSources(store, { includePrompts: false }).includes("已有月报说明甲"));
  assert.deepEqual(allState(store), before);
});

test("cache views return only exact prepared Chinese parts in the provided scope", t => {
  const store = setup(t);
  const text = "中文缓存甲";
  store.put("meta", keyFor(text), { version: "ui-en-v1", source: text, english: "Prepared A" });
  store.put("meta", keyFor("私有指令甲"), { version: "ui-en-v1", source: "私有指令甲", english: "Private prompt" });
  store.put("meta", keyFor("错配缓存甲"), { version: "ui-en-v1", source: "其他源文", english: "Wrong source" });
  store.put("meta", keyFor("过时缓存甲"), { version: "ui-en-v0", source: "过时缓存甲", english: "Wrong version" });
  store.put("meta", keyFor("空白缓存甲"), { version: "ui-en-v1", source: "空白缓存甲", english: " " });
  const before = allState(store);
  assert.deepEqual(cachedTranslationView(store, [text, text, "English", "错配缓存甲", "过时缓存甲", "空白缓存甲"]),
    { translations: [{ source: text, english: "Prepared A" }], total: 4, ready: 1, missing: 3 });
  assert.deepEqual(allState(store), before);
});

test("prewarm batches are bounded and serial, reports contain counts only, and cache hits never call AI", async t => {
  const store = setup(t);
  const original = allState(store);
  const texts = Array.from({ length: 33 }, (_, index) => "待译文本" + index + "中".repeat(500));
  texts.push("长段落" + "文".repeat(4100));
  let active = 0;
  const calls = [];
  const progress = [];
  const ai = { async respond(request) {
    assert.equal(active++, 0);
    calls.push(request);
    await Promise.resolve();
    active--;
    return { data: { translations: request.input.texts.map(item => ({ id: item.id, english: "Translated " + item.id })) } };
  } };
  const result = await prewarmUiTranslations(store, ai, texts, { onProgress: item => progress.push(item) });
  assert.ok(calls.length > 1);
  assert.equal(result.missing, 0);
  assert.equal(result.translated, result.total);
  assert.equal(result.batches, calls.length);
  for (const request of calls) {
    assert.equal(request.role, "ui_translation");
    assert.ok(request.input.texts.length <= 20);
    assert.ok(request.input.texts.reduce((sum, item) => sum + item.text.length, 0) <= 10000);
  }
  assert.ok(progress.every(item => Object.values(item).every(value => typeof value === "number")));
  const count = calls.length;
  const repeat = await prewarmUiTranslations(store, ai, texts);
  assert.equal(calls.length, count);
  assert.equal(repeat.cached, repeat.total);
  assert.equal(repeat.translated, 0);
  assert.equal(repeat.batches, 0);
  for (const collection of COLLECTIONS.filter(name => name !== "meta")) assert.deepEqual(store.all(collection), original[collection]);
  for (const item of original.meta) assert.ok(store.all("meta").some(value => JSON.stringify(value) === JSON.stringify(item)));
});

test("separate translator instances share an in-process store queue and failed batches keep only earlier successful cache", async t => {
  const store = setup(t);
  let calls = 0;
  const ai = { async respond(request) { calls++; await Promise.resolve(); return { data: { translations: request.input.texts.map(item => ({ id: item.id, english: "Ready" })) } }; } };
  await Promise.all([createUiTranslator(store, ai).translate({ texts: ["并发文本甲"] }), createUiTranslator(store, ai).translate({ texts: ["并发文本甲"] })]);
  assert.equal(calls, 1);
  let failedCalls = 0;
  const inputs = Array.from({ length: 22 }, (_, index) => "失败测试" + index);
  await assert.rejects(prewarmUiTranslations(store, { async respond(request) {
    if (++failedCalls === 2) throw new Error("private upstream failure");
    return { data: { translations: request.input.texts.map(item => ({ id: item.id, english: "Saved first batch" })) } };
  } }, inputs), error => error.statusCode === 502 && !error.message.includes("private upstream"));
  const view = cachedTranslationView(store, inputs);
  assert.equal(view.ready, 20);
  assert.equal(view.missing, 2);
});
