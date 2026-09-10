import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { getSettings } from "../server/settings.mjs";
import { runMenuWorkflow, resumeMenuWorkflow } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";
import { PassThrough } from "node:stream";
import { streamMenuProgress } from "../server/menu-progress-stream.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], seed: 3, count: 2, useAi: true };
const deferred = () => Promise.withResolvers();
test("slow connected clients cannot indefinitely block the workflow or its business lock", { timeout: 2000 }, async () => {
  let continued = false;
  const reply = { raw: new PassThrough(), header() {}, send() {}, then() { throw new Error("do not await reply inside business lock"); } };
  await streamMenuProgress(reply, async emit => {
    await emit({ type: "week", runId: "slow-client-test", plan: { entries: Array(20000).fill({ dishId: "d" }) } });
    continued = true;
    return { workflow: { runId: "slow-client-test" } };
  }, { drainTimeoutMs: 10 });
  assert.equal(continued, true);
  assert.equal(reply.raw.destroyed, true);
});
function setup(t) {
  const store = createStore(":memory:", () => ({ dishes: ["甲", "乙"].flatMap((stall, group) => Array.from({ length: 12 }, (_, n) =>
    ({ id: `${group}-${n}`, name: `${stall}菜${n}`, stall, price: 12, unit: "份", active: true, spicy: "不辣",
      vegetarian: "非素食", mainIngredient: `原料${n}`, method: "炒", labelSource: "厨房核验" }))), feedback: [],
    rules: [{ stall: "甲", text: "同餐不能重复" }], recipes: [], inventory: [], report: {} }));
  t.after(() => store.close());
  return { store, settings: getSettings(store) };
}
function mockAi(planner = directWeeklyResponse, inspect = () => ({ verdict: "pass", summary: "独立核验完成，待人工审核", findings: [] })) {
  const calls = [];
  return { calls, status: () => ({ configured: true, model: "test-only" }), async respond(request) {
    calls.push(structuredClone(request));
    return { data: await (request.role === "planner" ? planner(request) : inspect(request)),
      model: "test-only", requestId: `test-${calls.length}`, usage: { input_tokens: 100, output_tokens: 20 } };
  } };
}

test("each accepted week is published before requesting the next, whose input contains every preceding menu", async t => {
  const { store, settings } = setup(t);
  const events = [];
  const ai = mockAi(request => {
    const week = request.input.week;
    assert.equal(events.filter(e => e.type === "week").length, week - 1);
    assert.deepEqual(request.input.previousWeeks.map(w => w.week), Array.from({ length: week - 1 }, (_, i) => i + 1));
    for (const previous of request.input.previousWeeks) {
      const original = store.all("menuRuns").at(-1).plannerBatches[previous.week - 1];
      assert.deepEqual(previous.menus, original.result.menus, "all accepted menus re-enter the model input");
    }
    return directWeeklyResponse(request);
  }, () => {
    assert.equal(events.at(-1).type, "inspecting");
    assert.equal(events.at(-1).plan.entries.length, 240);
    return { verdict: "pass", summary: "六周检验完成", findings: [] };
  });
  const plan = await runMenuWorkflow({ store, settings, ai, input: options, onProgress: async event => {
    events.push(structuredClone(event));
    if (event.type !== "week") return;
    const n = event.completedWeeks;
    assert.equal(store.get("menuRuns", event.runId).plannerBatches.length, n, "checkpoint persisted before publication");
    assert.equal(event.plan.entries.length, n * 40);
    assert.ok(event.plan.entries.every(entry => entry.week <= n));
    assert.equal(event.plan.partial, true);
    assert.equal(event.plan.workflow, undefined);
    assert.equal(event.plan.validation, undefined);
    // A consumer modifying its preview cannot change prior selections.
    event.plan.entries[0].dishId = "CLIENT_TAMPER";
  } });
  assert.deepEqual(events.map(e => e.type), ["started", ...Array(6).fill("week"), "inspecting"]);
  assert.equal(plan.partial, undefined);
  assert.equal(plan.entries.length, 240);
  assert.ok(plan.entries.every(e => e.dishId !== "CLIENT_TAMPER"));
  assert.equal(store.all("plans").length, 0);
});

test("failed week does not erase published weeks and resume publishes the prefix before new calls", async t => {
  const { store, settings } = setup(t);
  const events = [];
  const ai = mockAi(request => {
    if (request.input.week === 3) throw new Error("Azure AI 请求超时");
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, settings, ai, input: options, onProgress: e => events.push(e) }), /超时/);
  assert.deepEqual(events.filter(e => e.type === "week").map(e => e.completedWeeks), [1, 2]);
  const prior = store.all("menuRuns").at(-1);
  const resumedEvents = [];
  const resumeAi = mockAi(request => {
    assert.equal(resumedEvents[0].type, "started");
    assert.equal(resumedEvents[0].completedWeeks, 2);
    assert.equal(resumedEvents[0].plan.entries.length, 80);
    assert.ok(request.input.week >= 3);
    return directWeeklyResponse(request);
  });
  const result = await resumeMenuWorkflow({ store, settings, ai: resumeAi, runId: prior.id, onProgress: e => resumedEvents.push(e) });
  assert.deepEqual(resumedEvents.filter(e => e.type === "week").map(e => e.completedWeeks), [3, 4, 5, 6]);
  assert.deepEqual(result.entries.filter(e => e.week <= 2), events.at(-1).plan.entries);
  assert.equal(store.all("plans").length, 0);
});

async function startApp(t, ai) {
  const { store, settings } = setup(t);
  const app = createApp(store, undefined, { ai });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  return { app, store, settings, base };
}
async function post(base, path, body) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
}
async function* jsonLines(response) {
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  assert.equal(buffer.trim(), "");
}

test("real HTTP flushes week one while week two is gated, preserves lock, and completes without auto-save", { timeout: 15000 }, async t => {
  const gate = deferred();
  const entered = deferred();
  t.after(() => gate.resolve());
  const ai = mockAi(async request => {
    if (request.input.week === 2) { entered.resolve(); await gate.promise; }
    return directWeeklyResponse(request);
  });
  const { base, store } = await startApp(t, ai);
  const response = await post(base, "/api/plans/generate-stream", options);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type").startsWith("application/x-ndjson"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const iterator = jsonLines(response)[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  assert.equal(first.type, "started");
  const weekOne = (await iterator.next()).value;
  assert.equal(weekOne.type, "week");
  assert.equal(weekOne.plan.entries.length, 40);
  await entered.promise;
  assert.equal(store.all("menuRuns").at(-1).plannerBatches.length, 1);
  const competing = await post(base, "/api/plans/generate", options);
  assert.equal(competing.status, 400);
  assert.match((await competing.json()).error, /正在进行/);
  for (const path of ["/api/plans", "/api/plans/check", "/api/plans/inspect"]) {
    const rejected = await post(base, path, weekOne.plan);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /逐周预览/);
  }
  gate.resolve();
  const remaining = [];
  for await (const item of iterator) remaining.push(item);
  assert.deepEqual(remaining.map(e => e.type), [...Array(5).fill("week"), "inspecting", "completed"]);
  const sixWeeks = remaining.at(-2).plan;
  assert.equal(sixWeeks.partial, true);
  assert.equal((await post(base, "/api/plans", sixWeeks)).status, 400, "six uninspected weeks cannot be saved as final");
  const { partial: _partial, ...withoutPartial } = sixWeeks;
  assert.equal((await post(base, "/api/plans", withoutPartial)).status, 400, "removing client partial flag cannot bypass inspector");
  const { generationRunId: _generationRunId, ...withoutRun } = withoutPartial;
  assert.equal((await post(base, "/api/plans", withoutRun)).status, 400, "gpt-direct must have trusted completed evidence");
  const final = remaining.at(-1).plan;
  assert.equal(final.entries.length, 240);
  assert.equal(final.workflow.requiresHumanApproval, true);
  assert.equal(store.all("plans").length, 0);
  const serialized = JSON.stringify([first, weekOne, remaining]);
  for (const key of ["plannerAttempts", "plannerBatches", "prompts", "dishCatalog", "apiKey"]) assert.ok(!serialized.includes(key));
});

test("stream reports safe failure, resumes published prefix, and rejects bad options before streaming", async t => {
  let fail = true;
  const ai = mockAi(request => {
    if (fail && request.input.week === 2) throw new Error("Azure AI 请求超时");
    return directWeeklyResponse(request);
  });
  const { base, store } = await startApp(t, ai);
  const response = await post(base, "/api/plans/generate-stream", options);
  const events = [];
  for await (const item of jsonLines(response)) events.push(item);
  assert.deepEqual(events.map(e => e.type), ["started", "week", "error"]);
  assert.equal(events.at(-1).week, 2);
  assert.ok(events.at(-1).runId);
  const id = events.at(-1).runId;
  fail = false;
  const resumed = [];
  for await (const item of jsonLines(await post(base, "/api/plans/resume-stream", { runId: id }))) resumed.push(item);
  assert.equal(resumed[0].completedWeeks, 1);
  assert.deepEqual(resumed[0].plan.entries, events[1].plan.entries);
  assert.equal(resumed.at(-1).type, "completed");
  assert.equal(store.all("plans").length, 0);
  const count = ai.calls.length;
  for (const body of [{ ...options, demo: true }, { ...options, useAi: false }, { ...options, start: "bad" }]) {
    const invalid = await post(base, "/api/plans/generate-stream", body);
    assert.equal(invalid.status, 400);
    assert.ok(invalid.headers.get("content-type").startsWith("application/json"));
  }
  assert.equal(ai.calls.length, count);
});

test("browser disconnect detaches display without abandoning generation or checkpoints", { timeout: 15000 }, async t => {
  const gate = deferred();
  const completed = deferred();
  t.after(() => gate.resolve());
  const ai = mockAi(async request => {
    if (request.input.week === 2) await gate.promise;
    return directWeeklyResponse(request);
  }, () => { completed.resolve(); return { verdict: "pass", summary: "检验完成", findings: [] }; });
  const { base, store } = await startApp(t, ai);
  const response = await post(base, "/api/plans/generate-stream", options);
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert.ok(initial.value.length);
  await reader.cancel();
  gate.resolve();
  await completed.promise;
  await new Promise(resolve => setImmediate(resolve));
  const run = store.all("menuRuns").at(-1);
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(run.stage, "completed");
  assert.equal(ai.calls.length, 7);
  assert.equal(store.all("plans").length, 0);
});
