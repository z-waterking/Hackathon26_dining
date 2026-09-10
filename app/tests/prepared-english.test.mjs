import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { createQueryService } from "../server/data/query-service.mjs";
import { createPreparedEnglish } from "../server/prepared-english.mjs";
import { cachedTranslationView, prewarmUiTranslations } from "../server/ui-translations.mjs";
import { getPromptConfig, savePromptConfig } from "../server/prompt-config.mjs";
import { streamMenuProgress } from "../server/menu-progress-stream.mjs";
import { createDiningApi } from "../src/api/dining.js";
import { cachedTranslation } from "../src/translation-cache.js";

const STALL = "清禾食堂";
const DISH = "西兰花炒木耳";
const FEEDBACK = "原始反馈请保留中文：午餐蔬菜太油了，请增加清淡菜。";
const TITLE = "核验午餐蔬菜供应";
const DESCRIPTION = "先核对现有菜库，再记录午餐清淡蔬菜供应情况。";
const INSTRUCTION = "午餐选用已有菜库中已核验的清淡蔬菜。";
const RULE = "每餐至少安排一种已核验的清淡蔬菜。";
const PROMPTS = Object.freeze({
  actionGenerationText: "专用反馈指令标记甲：根据真实反馈生成待审批的改善事项。",
  menuSystemText: "专用菜单指令标记乙：遵循当前规则和菜库编排可核验菜单。",
  approvedActionText: "专用行动指令标记丙：仅将已批准事项加入下次菜单要求。",
});

function assertSourceResponse(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(value.uiTranslations, undefined);
  assert.equal(value.englishPreparation, undefined);
  for (const child of Object.values(value)) assertSourceResponse(child);
}

function translator({ beforeRespond } = {}) {
  const calls = [];
  const englishBySource = new Map();
  return {
    calls, englishBySource,
    status: () => ({ configured: true, model: "mock-prepared-english" }),
    async respond(request) {
      assert.equal(request.role, "ui_translation", "This fixture cannot perform business AI work");
      calls.push(request);
      await beforeRespond?.(request);
      const translations = request.input.texts.map(({ id, text }) => {
        const english = `Prepared English item ${calls.length}-${id}`;
        englishBySource.set(text, english);
        return { id, english };
      });
      return { data: { translations }, model: "mock-prepared-english" };
    },
  };
}

function fixture(t, options = {}) {
  const store = createRepository(createMemoryAdapter(), () => ({
    dishes: [{ id: "D-PREPARED", name: DISH, stall: STALL, active: true, price: 8, priceText: "8", unit: "份", spicy: "不辣", vegetarian: "素食", sources: [] }],
    feedback: [{ id: "F-PREPARED", content: FEEDBACK, restaurant: STALL, date: "2026-09-10", type: "建议", category: "菜品", status: "未处理", channel: "邮件", sources: [], events: [], replies: [] }],
    rules: [{ stall: STALL, text: RULE, meal: "午餐", source: { file: "rules.xlsx", sheet: "Rules", row: 2 } }],
    report: { workbooks: 1, sheets: 1, formulaErrors: 0 },
  }));
  store.put("actions", "A-PREPARED", { id: "A-PREPARED", title: TITLE, description: DESCRIPTION, menuInstruction: INSTRUCTION,
    targetStall: STALL, kind: "menu", status: "approved", priority: "medium", enabled: true, revision: 1, source: "aggregate",
    feedbackIds: ["F-PREPARED"], evidence: [{ feedbackId: "F-PREPARED", quote: FEEDBACK }], history: [] });
  const config = getPromptConfig(store);
  savePromptConfig(store, { version: config.version, baseFingerprint: config.baseFingerprint, rules: config.rules, ...PROMPTS });
  const ai = options.ai || translator();
  // Retired configuration cannot reactivate automatic translation.
  const app = createApp(store, undefined, { prepareEnglish: true, ai });
  t.after(async () => { await app.close(); store.close(); });
  return { store, app, ai };
}

test("Action PATCH preserves source content without automatic translation or response metadata", async t => {
  const { store, app, ai } = fixture(t);
  const original = { feedback: store.all("feedback"), dishes: store.all("dishes"), prompts: getPromptConfig(store), meta: store.all("meta") };
  const input = { title: "增加每周蔬菜轮换核验", description: "先核验供应记录，再试行已批准的蔬菜轮换并留存结果。", menuInstruction: INSTRUCTION, reason: "运营确认本次调整依据。" };
  const response = await app.inject({ method: "PATCH", url: "/api/actions/A-PREPARED", payload: input });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.title, input.title);
  assert.equal(body.description, input.description);
  assert.equal(body.menuInstruction, INSTRUCTION);
  assert.equal(body.targetStall, STALL);
  assert.deepEqual(body.evidence, [{ feedbackId: "F-PREPARED", quote: FEEDBACK }]);
  assert.equal(body.revision, 2);
  assertSourceResponse(body);
  assert.equal(ai.calls.length, 0);
  assert.equal(cachedTranslationView(store, [input.title, input.description, INSTRUCTION]).missing, 3);
  const stored = store.get("actions", "A-PREPARED");
  assert.equal(stored.title, input.title);
  assert.equal(stored.description, input.description);
  assert.equal(stored.uiTranslations, undefined);
  assert.equal(stored.englishPreparation, undefined);
  assert.deepEqual({ feedback: store.all("feedback"), dishes: store.all("dishes"), prompts: getPromptConfig(store), meta: store.all("meta") }, original);
});

test("read models omit translation metadata; legacy translation POST only reads existing cache", async t => {
  const ai = translator();
  const { store, app } = fixture(t, { ai });
  await prewarmUiTranslations(store, ai, [TITLE]);
  const callsBefore = ai.calls.length;
  const cachedBefore = store.all("meta");
  for (const url of ["/api/data", "/api/actions", "/api/actions/summary", "/api/prompt-config", "/api/feedback", "/api/feedback/insights", "/api/feedback/summary?month=2026-09", "/api/dishes", "/api/menu-runs", "/api/ai/status"]) {
    const response = await app.inject({ method: "GET", url, headers: { "accept-language": "en" } });
    assert.equal(response.statusCode, 200, url);
    assertSourceResponse(response.json());
    assert.ok(!response.body.includes(ai.englishBySource.get(TITLE)), url);
  }
  const insights = (await app.inject({ method: "GET", url: "/api/feedback/insights" })).json();
  assert.ok(insights.keywords.length > 0);
  assert.ok(insights.keywords.every(item => /[\u3400-\u9fff]/u.test(item.text)));
  const legacy = await app.inject({ method: "POST", url: "/api/ui-translations", payload: { texts: [TITLE, "缺失的英文版本不得触发现场翻译"] } });
  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(legacy.json(), { translations: [{ source: TITLE, english: ai.englishBySource.get(TITLE) }] });
  assert.equal(ai.calls.length, callsBefore);
  assert.deepEqual(store.all("meta"), cachedBefore, "Read endpoints do not add cache entries");
});

test("Prompt and rule reads retain source text while internal instructions stay out of workspace", async t => {
  const { store, app, ai } = fixture(t);
  await prewarmUiTranslations(store, ai, [...Object.values(PROMPTS), TITLE, RULE]);
  const cachedBefore = store.all("meta");
  const queries = createQueryService(store, { ai });
  const prompt = queries.promptConfig();
  const workspace = queries.workspace();
  assertSourceResponse(prompt);
  assertSourceResponse(workspace);
  for (const [key, source] of Object.entries(PROMPTS)) assert.equal(prompt[key], source);
  assert.equal(workspace.rules[0].text, RULE);
  assert.equal(workspace.actions[0].title, TITLE);
  assert.equal(workspace.feedback[0].content, FEEDBACK);
  assert.equal(workspace.dishes[0].name, DISH);
  const count = ai.calls.length;
  for (const url of ["/api/data", "/api/actions/summary"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    for (const source of Object.values(PROMPTS)) {
      assert.ok(!response.body.includes(source), `${url} excludes Prompt source text`);
      assert.ok(!response.body.includes(ai.englishBySource.get(source)), `${url} excludes Prompt-only English text`);
    }
    assert.equal(response.json().actionGenerationText, undefined);
    assert.equal(response.json().menuSystemText, undefined);
  }
  const dedicated = await app.inject({ method: "GET", url: "/api/prompt-config" });
  assert.equal(dedicated.statusCode, 200);
  assert.equal(dedicated.json().menuSystemText, PROMPTS.menuSystemText);
  assertSourceResponse(dedicated.json());
  assert.equal(ai.calls.length, count);
  assert.deepEqual(store.all("meta"), cachedBefore);
});

test("translation availability cannot affect Action writes because no translator is invoked", async t => {
  const ai = translator({ beforeRespond: () => { throw Error("private upstream credential detail"); } });
  const { store, app } = fixture(t, { ai });
  const title = "翻译失败时仍保存本次运营调整";
  const response = await app.inject({ method: "PATCH", url: "/api/actions/A-PREPARED", payload: { title } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.title, title);
  assert.equal(body.revision, 2);
  assertSourceResponse(body);
  assert.equal(store.get("actions", "A-PREPARED").title, title);
  assert.equal(store.get("actions", "A-PREPARED").revision, 2);
  assert.equal(store.all("audit").filter(item => item.kind === "action.updated").length, 1);
  assert.equal(cachedTranslationView(store, [title]).missing, 1);
  assert.ok(!response.body.includes("private upstream"));
  assert.equal(ai.calls.length, 0);
});

test("feedback POST and PATCH and Prompt PUT retain source content without translation work", async t => {
  const ai = translator({ beforeRespond: () => { throw Error("translation must not run"); } });
  const { store, app } = fixture(t, { ai });
  const created = await app.inject({ method: "POST", url: "/api/feedback", payload: { content: FEEDBACK, restaurant: STALL, date: "2026-09-10", type: "建议", channel: "邮件" } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().item.content, FEEDBACK);
  assertSourceResponse(created.json());
  const updated = await app.inject({ method: "PATCH", url: `/api/feedback/${created.json().item.id}`, payload: { status: "跟进中", owner: "运营人员", note: "已经开始核查原始供应记录。" } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().events.at(-1).text, "已经开始核查原始供应记录。");
  assertSourceResponse(updated.json());
  const config = getPromptConfig(store);
  const input = { version: config.version, baseFingerprint: config.baseFingerprint, rules: config.rules, ...PROMPTS, menuSystemText: `${PROMPTS.menuSystemText} 保持运营原文。` };
  const saved = await app.inject({ method: "PUT", url: "/api/prompt-config", payload: input });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().menuSystemText, input.menuSystemText);
  assertSourceResponse(saved.json());
  assert.equal(ai.calls.length, 0);
  assert.equal(cachedTranslationView(store, [FEEDBACK, input.menuSystemText]).missing, 2);
});

test("explicit offline preparation remains separate and never rewrites source records", async t => {
  const { store, ai } = fixture(t);
  const original = store.get("actions", "A-PREPARED");
  const english = createPreparedEnglish(store, ai, { enabled: true });
  for (const value of [null, "文本响应", 2, ["原数组"], { pipe() {} }]) assert.equal(await english(value, { prepare: true }), value);
  assert.equal(ai.calls.length, 0);
  const prepared = await english({ title: TITLE }, { prepare: true });
  assert.equal(prepared.title, TITLE);
  assert.equal(prepared.uiTranslations[0].english, ai.englishBySource.get(TITLE));
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(store.get("actions", "A-PREPARED"), original);
  const failing = createPreparedEnglish(store, translator({ beforeRespond: () => { throw Error("private upstream detail"); } }), { enabled: true });
  const result = await failing({ description: DESCRIPTION }, { prepare: true });
  assert.equal(result.description, DESCRIPTION);
  assert.equal(result.englishPreparation.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("private upstream"));
});

test("server menu stream emits source milestones without translation and retains safe projection", async () => {
  const chunks = [];
  let streamEnded;
  const ended = new Promise(resolve => { streamEnded = resolve; });
  const reply = { raw: new PassThrough(), header() {}, send(stream) { stream.setEncoding("utf8"); stream.on("data", chunk => chunks.push(chunk)); stream.on("end", streamEnded); } };
  const plan = { summary: "本周已安排清淡蔬菜，等待核验。", entries: [{ dishName: DISH, stall: STALL }], workflow: { runId: "MR-SOURCE", plannerPrompt: "private planner instructions" } };
  await streamMenuProgress(reply, async emit => {
    await emit({ type: "week", runId: "MR-SOURCE", week: 1, summary: "第一周已完成，正在继续排菜。", plan });
    return plan;
  }, { prepareEvent: () => { throw Error("retired preparation callback must not run"); } });
  await ended;
  const events = chunks.join("").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["week", "completed"]);
  assert.equal(events[0].summary, "第一周已完成，正在继续排菜。");
  assert.equal(events[1].plan.summary, plan.summary);
  assert.deepEqual(events[1].plan.entries, plan.entries);
  assert.equal(events[1].plan.workflow.plannerPrompt, undefined);
  assertSourceResponse(events);
});

test("client API preserves business payloads without hydrating a retired translation response cache", async () => {
  const source = "客户端普通响应专用说明";
  const payload = { title: source, uiTranslations: [{ source, english: "Prepared response explanation" }] };
  const calls = [];
  assert.equal(cachedTranslation(source), undefined);
  const api = createDiningApi({ fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(payload); } });
  const result = await api.actions.update("A-CLIENT", { title: source });
  assert.deepEqual(result, payload);
  assert.equal(cachedTranslation(source), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: source });
});

test("client stream retains source events and plans without translation hydration or extra requests", async () => {
  const weekSource = "客户端流周次说明";
  const completeSource = "客户端流完成说明";
  const planSource = "客户端最终计划说明";
  for (const source of [weekSource, completeSource, planSource]) assert.equal(cachedTranslation(source), undefined);
  const plan = { summary: planSource, entries: [{ dishName: DISH, stall: STALL }], uiTranslations: [{ source: planSource, english: "Prepared final plan" }] };
  const events = [
    { type: "started", runId: "MR-CLIENT" },
    { type: "week", runId: "MR-CLIENT", summary: weekSource, uiTranslations: [{ source: weekSource, english: "Prepared week explanation" }] },
    { type: "completed", runId: "MR-CLIENT", summary: completeSource, plan, uiTranslations: [{ source: completeSource, english: "Prepared completion explanation" }] },
  ];
  let requests = 0;
  const api = createDiningApi({ fetchImpl: async () => {
    requests++;
    return new Response(events.map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  } });
  const received = [];
  const result = await api.plans.generateProgressive({ useAi: true }, { onEvent: event => {
    received.push(event);
    for (const item of event.uiTranslations || []) assert.equal(cachedTranslation(item.source), undefined);
    if (event.type === "week") assert.equal(event.summary, weekSource);
  } });
  assert.deepEqual(received, events);
  assert.equal(cachedTranslation(planSource), undefined);
  assert.deepEqual(result, plan);
  assert.equal(requests, 1);
});
