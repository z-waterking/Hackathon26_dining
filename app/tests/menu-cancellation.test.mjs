import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { runMenuWorkflow, resumeMenuWorkflow, menuRecoveryRecords, completedMenuResult } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", count: 2, meals: ["午餐", "晚餐"], seed: 2, useAi: true };
const settings = { version: 1, plannerPrompt: "隔离测试排菜配置", inspectorPrompt: "隔离测试检验配置", operatorNotes: "" };
const cancellation = () => Object.assign(new Error("private cancellation detail must not escape"), { code: "GENERATION_CANCELLED", statusCode: 409 });
const inspect = () => ({ verdict: "pass", summary: "测试独立核验完成，待人工确认", findings: [] });

function setup(t, { perStall = false } = {}) {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 16 }, (_, number) => ({
    id: `${group}-${number}`, name: `${stall}菜${number}`, stall, price: 12, unit: "份", active: true,
    spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料${number}`, method: "炒", labelSource: "厨房现场核验",
  })));
  const store = createRepository(createMemoryAdapter(), () => ({ dishes, feedback: [], rules: [], report: {} }));
  store.put("settings", "current", settings);
  if (perStall) store.put("meta", "preprocessed-stall-catalog", { source: { file: "isolated-menu.xlsx", sha256: "fixture" },
    groups: ["档口甲", "档口乙"].map(stall => ({ stall, origin: "primary", candidateIds: dishes.filter(dish => dish.stall === stall).map(dish => dish.id), unresolved: [] })),
    fingerprint: "fixture", warnings: [], stats: { uniqueDishes: dishes.length } });
  t.after(() => store.close());
  return store;
}

function mockAi(planner = directWeeklyResponse, inspector = inspect) {
  const calls = [];
  return { calls, async respond(request) {
    // Keep the real signal reference; fixtures never send HTTP requests.
    calls.push(request);
    const data = await (request.role === "planner" ? planner : inspector)(request);
    return { data, model: "isolated-cancellation-test", usage: { input_tokens: 10, output_tokens: 5 } };
  } };
}

function expectCancelled(error) {
  assert.equal(error.code, "GENERATION_CANCELLED");
  assert.equal(error.statusCode, 409);
  assert.equal(error.diagnostics.code, "GENERATION_CANCELLED");
  assert.match(error.message, /已取消/);
  assert.ok(!error.message.includes("private"));
  return true;
}

test("already cancelled generation performs no writes or model calls", async t => {
  const store = setup(t);
  const controller = new AbortController();
  controller.abort(cancellation());
  const ai = mockAi();
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(ai.calls.length, 0);
  assert.equal(store.all("menuRuns").length, 0);
});

test("cancel after a published week stops further requests and preserves the exact resumable prefix", async t => {
  const store = setup(t);
  const controller = new AbortController();
  const ai = mockAi();
  const events = [];
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal, onProgress: event => {
    events.push(structuredClone(event));
    if (event.type === "week") controller.abort(cancellation());
  } }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(run.status, "cancelled");
  assert.equal(run.stage, "cancelled");
  assert.equal(run.plannerBatches.length, 1);
  assert.equal(run.planner, undefined);
  assert.equal(run.workflow, undefined);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].signal, controller.signal);
  assert.deepEqual(events.map(event => event.type), ["started", "week"]);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
  assert.throws(() => completedMenuResult(store, run.id, settings), /尚无完整菜单/);
  const prior = structuredClone(run);
  const next = mockAi();
  const resumed = await resumeMenuWorkflow({ store, ai: next, runId: run.id, settings });
  assert.deepEqual(next.calls.map(request => request.role === "planner" ? request.input.week : request.role), [2, 3, 4, 5, 6, "inspector"]);
  assert.deepEqual(resumed.entries.filter(entry => entry.week === 1), events.at(-1).plan.entries);
  assert.deepEqual(store.get("menuRuns", run.id), prior);
  assert.equal(store.all("plans").length, 0);
});

test("in-flight model abort is cancelled rather than retried and retains earlier accepted weeks", async t => {
  const store = setup(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const ai = mockAi(request => {
    if (request.input.week !== 2) return directWeeklyResponse(request);
    started.resolve();
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  });
  const pending = runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal });
  const rejected = assert.rejects(pending, expectCancelled);
  await started.promise;
  controller.abort(cancellation());
  await rejected;
  const run = store.all("menuRuns")[0];
  assert.deepEqual(ai.calls.map(request => request.input.week), [1, 2]);
  assert.equal(run.plannerBatches.length, 1);
  assert.equal(run.plannerAttempts.at(-1).status, "cancelled");
  assert.equal(run.plannerAttempts.at(-1).data, undefined);
  assert.equal(run.diagnostics.week, 2);
  assert.equal(run.workflow, undefined);
});

test("cancel at the final weekly checkpoint keeps all real weeks without beginning inspection", async t => {
  const store = setup(t);
  const controller = new AbortController();
  const observingStore = { ...store, put(collection, id, record) {
    store.put(collection, id, record);
    if (collection === "menuRuns" && record.status === "running" && record.plannerBatches?.length === 6) controller.abort(cancellation());
  } };
  const ai = mockAi();
  const events = [];
  await assert.rejects(runMenuWorkflow({ store: observingStore, ai, input: options, settings, signal: controller.signal, onProgress: event => events.push(event) }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(run.status, "cancelled");
  assert.equal(run.stage, "cancelled");
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(run.planner, undefined);
  assert.equal(run.workflow, undefined);
  assert.equal(ai.calls.length, 6);
  assert.equal(events.filter(event => event.type === "week").length, 5);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
});

test("late model output after abort is discarded without structural correction or checkpoint", async t => {
  const store = setup(t);
  const controller = new AbortController();
  const ai = mockAi(() => { controller.abort(cancellation()); return { invalid: "late response" }; });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(ai.calls.length, 1);
  assert.equal(run.plannerAttempts[0].status, "cancelled");
  assert.equal(run.plannerAttempts[0].data, undefined);
  assert.equal(run.plannerBatches.length, 0);
  assert.equal(run.planner, undefined);
});

for (const perStall of [false, true]) test(`cancellation between rejected output and retry prevents another model call (${perStall ? "stall" : "week"})`, async t => {
  const store = setup(t, { perStall });
  const controller = new AbortController();
  const observingStore = { ...store, put(collection, id, record) {
    store.put(collection, id, record);
    if (collection === "menuRuns" && record.plannerAttempts?.at(-1)?.status === "invalid") controller.abort(cancellation());
  } };
  const ai = mockAi(() => ({ invalid: true }));
  await assert.rejects(runMenuWorkflow({ store: observingStore, ai, input: options, settings, signal: controller.signal }), expectCancelled);
  assert.equal(ai.calls.length, 1);
  const run = store.all("menuRuns")[0];
  assert.equal(run.status, "cancelled");
  assert.equal(run.plannerBatches.length, 0);
  assert.equal(run.stallBatches.length, 0);
});

test("per-stall cancellation retains a partial week's accepted stalls and resumes only the remainder", async t => {
  const store = setup(t, { perStall: true });
  const controller = new AbortController();
  const ai = mockAi(request => {
    if (request.input.week === 2 && request.input.targetStall === "档口乙") { controller.abort(cancellation()); request.signal.throwIfAborted(); }
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(run.status, "cancelled");
  assert.equal(run.plannerBatches.length, 1);
  assert.deepEqual(run.stallBatches.map(batch => [batch.week, batch.stall]), [[1, "档口甲"], [1, "档口乙"], [2, "档口甲"]]);
  assert.equal(run.diagnostics.stall, "档口乙");
  assert.equal(ai.calls.length, 4);
  assert.equal(run.planner, undefined);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
  const prior = structuredClone(run);
  const next = mockAi();
  const resumed = await resumeMenuWorkflow({ store, ai: next, runId: run.id, settings });
  assert.equal(next.calls[0].input.week, 2);
  assert.equal(next.calls[0].input.targetStall, "档口乙");
  assert.equal(next.calls.filter(request => request.role === "planner").length, 9);
  const child = store.get("menuRuns", resumed.workflow.runId);
  assert.deepEqual(child.stallBatches.slice(0, 3), prior.stallBatches);
  assert.deepEqual(store.get("menuRuns", prior.id), prior);
  assert.equal(store.all("plans").length, 0);
});

test("cancellation between per-stall quality review and correction makes no repair request", async t => {
  const store = setup(t, { perStall: true });
  const controller = new AbortController();
  const observingStore = { ...store, put(collection, id, record) {
    store.put(collection, id, record);
    if (collection === "menuRuns" && record.plannerAttempts?.at(-1)?.status === "quality_review") controller.abort(cancellation());
  } };
  const ai = mockAi(request => { const result = directWeeklyResponse(request); result.menus.S0[1] = result.menus.S0[0]; return result; });
  await assert.rejects(runMenuWorkflow({ store: observingStore, ai, input: options, settings, signal: controller.signal }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(ai.calls.length, 1);
  assert.equal(run.status, "cancelled");
  assert.equal(run.stallBatches.length, 0);
  assert.equal(run.planner, undefined);
});

test("cancel before independent inspection retains all six weeks but does not claim an inspected result", async t => {
  const store = setup(t);
  const controller = new AbortController();
  const ai = mockAi();
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal, onProgress: event => {
    if (event.type === "inspecting") controller.abort(cancellation());
  } }), expectCancelled);
  const run = store.all("menuRuns")[0];
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(run.failedStage, "inspecting");
  assert.equal(run.workflow, undefined);
  assert.equal(ai.calls.length, 6);
  const next = mockAi();
  await resumeMenuWorkflow({ store, ai: next, runId: run.id, settings });
  assert.deepEqual(next.calls.map(request => request.role), ["inspector"]);
});

test("a late inspector response after abort cannot mark a run completed or overwrite saved plans", async t => {
  const store = setup(t);
  const original = await runMenuWorkflow({ store, ai: mockAi(), input: options, settings });
  store.put("plans", "P-SAVED", { ...original, id: "P-SAVED" });
  const plansBefore = store.all("plans");
  const originalRun = store.get("menuRuns", original.workflow.runId);
  const controller = new AbortController();
  const ai = mockAi(directWeeklyResponse, request => { assert.equal(request.signal, controller.signal); controller.abort(cancellation()); return inspect(); });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, signal: controller.signal }), expectCancelled);
  const run = store.all("menuRuns").at(-1);
  assert.equal(run.status, "cancelled");
  assert.equal(run.failedStage, "inspecting");
  assert.equal(run.workflow, undefined);
  assert.equal(ai.calls.length, 7);
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
  assert.deepEqual(store.get("menuRuns", originalRun.id), originalRun);
  assert.deepEqual(store.all("plans"), plansBefore);
});

test("resuming can be cancelled again and changed inputs still block cancelled-run recovery", async t => {
  const store = setup(t);
  const initial = new AbortController();
  await assert.rejects(runMenuWorkflow({ store, ai: mockAi(), input: options, settings, signal: initial.signal, onProgress: event => {
    if (event.type === "week") initial.abort(cancellation());
  } }), expectCancelled);
  const prior = store.all("menuRuns")[0];
  const next = new AbortController();
  const ai = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: prior.id, settings, signal: next.signal, onProgress: () => next.abort(cancellation()) }), expectCancelled);
  const child = store.all("menuRuns").at(-1);
  assert.equal(ai.calls.length, 0);
  assert.equal(child.status, "cancelled");
  assert.equal(child.plannerBatches.length, 1);
  assert.equal(child.planner, undefined);
  assert.deepEqual(store.get("menuRuns", prior.id), prior);
  const dish = store.get("dishes", "0-0");
  store.put("dishes", dish.id, { ...dish, active: false });
  assert.ok(menuRecoveryRecords(store, settings).every(run => !run.resumable));
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: child.id, settings }), /已变化/);
  assert.equal(ai.calls.length, 0);
});

for (const streaming of [false, true]) test(`HTTP ${streaming ? "NDJSON" : "JSON"} generation and resume cancel by client ID through workflow without extra model calls`, { timeout: 5000 }, async t => {
  const store = setup(t, { perStall: true });
  let mode = "generate";
  let entered = Promise.withResolvers();
  const ai = mockAi(request => {
    const blocked = mode === "generate" && request.input.week === 2 && request.input.targetStall === "档口乙"
      || mode === "resume" && request.input.week === 3 && request.input.targetStall === "档口乙";
    if (!blocked) return directWeeklyResponse(request);
    assert.ok(request.signal instanceof AbortSignal);
    entered.resolve(request.signal);
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  });
  ai.status = () => ({ configured: true, model: "isolated-cancel-http" });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const suffix = streaming ? "-stream" : "";
  const generationId = `menu-${streaming ? "stream" : "json"}-cancel-1`;
  const pending = app.inject({ method: "POST", url: `/api/plans/generate${suffix}`, payload: { ...options, generationId } }).then(response => response);
  const signal = await entered.promise;
  const cancel = await app.inject({ method: "POST", url: `/api/generations/${generationId}/cancel`, payload: {} });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().cancelled, true);
  assert.equal(signal.aborted, true);
  const result = await pending;
  const first = store.all("menuRuns")[0];
  function assertResponse(response, run) {
    assert.equal(response.statusCode, streaming ? 200 : 409);
    const events = streaming ? response.body.trim().split("\n").map(line => JSON.parse(line)) : [];
    const error = streaming ? events.at(-1) : response.json();
    assert.equal(error.code, "GENERATION_CANCELLED");
    assert.equal(error.runId, run.id);
    assert.ok(!response.body.includes("private cancellation"));
    if (streaming) {
      assert.match(response.headers["content-type"], /application\/x-ndjson/);
      assert.equal(error.type, "error");
      assert.ok(!events.some(event => event.type === "completed"));
    }
    assert.equal(run.status, "cancelled");
    assert.equal(run.stage, "cancelled");
    assert.equal(run.workflow, undefined);
    return events;
  }
  const events = assertResponse(result, first);
  assert.equal(first.plannerBatches.length, 1);
  assert.equal(first.stallBatches.length, 3);
  assert.equal(ai.calls.length, 4);
  if (streaming) assert.deepEqual(events.filter(event => event.type === "week").map(event => event.completedWeeks), [1]);
  const duplicateCancel = await app.inject({ method: "POST", url: `/api/generations/${generationId}/cancel`, payload: {} });
  assert.equal(duplicateCancel.json().status, "cancelled");
  const prior = structuredClone(first);
  mode = "resume";
  entered = Promise.withResolvers();
  const resumeId = `menu-${streaming ? "stream" : "json"}-cancel-2`;
  const resumedPending = app.inject({ method: "POST", url: `/api/plans/resume${suffix}`, payload: { runId: first.id, generationId: resumeId } }).then(response => response);
  const resumedSignal = await entered.promise;
  const resumedCancel = await app.inject({ method: "POST", url: `/api/generations/${resumeId}/cancel`, payload: {} });
  assert.equal(resumedCancel.json().cancelled, true);
  assert.equal(resumedSignal.aborted, true);
  const resumedResult = await resumedPending;
  const child = store.all("menuRuns").at(-1);
  const resumedEvents = assertResponse(resumedResult, child);
  assert.equal(child.parentRunId, first.id);
  assert.equal(child.plannerBatches.length, 2);
  assert.equal(child.stallBatches.length, 5);
  assert.equal(ai.calls.length, 7);
  assert.deepEqual(ai.calls.slice(4).map(request => [request.input.week, request.input.targetStall]), [[2, "档口乙"], [3, "档口甲"], [3, "档口乙"]]);
  if (streaming) {
    assert.equal(resumedEvents[0].type, "started");
    assert.equal(resumedEvents[0].completedWeeks, 1);
    assert.deepEqual(resumedEvents.filter(event => event.type === "week").map(event => event.completedWeeks), [2]);
  }
  assert.deepEqual(store.get("menuRuns", first.id), prior);
  assert.equal(store.all("plans").length, 0);
  const recovery = await app.inject({ method: "GET", url: "/api/menu-runs" });
  assert.ok(recovery.json().find(record => record.id === child.id).resumable);
  // A fully completed result wins over a late cancellation request.
  mode = "complete";
  const finalId = `menu-${streaming ? "stream" : "json"}-completed`;
  const final = await app.inject({ method: "POST", url: `/api/plans/resume${suffix}`, payload: { runId: child.id, generationId: finalId } });
  assert.equal(final.statusCode, 200);
  const completed = store.all("menuRuns").at(-1);
  assert.equal(completed.stage, "completed");
  const lateCancel = await app.inject({ method: "POST", url: `/api/generations/${finalId}/cancel`, payload: {} });
  assert.deepEqual(lateCancel.json(), { id: finalId, status: "completed", cancelled: false });
  assert.deepEqual(store.get("menuRuns", completed.id), completed);
});

for (const streaming of [false, true]) test(`HTTP ${streaming ? "NDJSON" : "JSON"} cancellation arriving before generation leaves no run or model work`, async t => {
  const store = setup(t);
  const ai = mockAi();
  ai.status = () => ({ configured: true, model: "isolated-cancel-http" });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const generationId = `menu-early-${streaming ? "stream" : "json"}`;
  const cancel = await app.inject({ method: "POST", url: `/api/generations/${generationId}/cancel`, payload: {} });
  assert.equal(cancel.statusCode, 200);
  const response = await app.inject({ method: "POST", url: `/api/plans/generate${streaming ? "-stream" : ""}`, payload: { ...options, generationId } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "GENERATION_CANCELLED");
  assert.equal(ai.calls.length, 0);
  assert.equal(store.all("menuRuns").length, 0);
});
