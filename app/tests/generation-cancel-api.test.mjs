import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { getActionSummary, summarizeActions } from "../server/action-summary.mjs";

const STALL = "测试蔬菜档口";
const OLD_TITLE = "已保存并由运营确认的原有事项";
const NEW_TITLE = "取消后不得写入的新改善事项";
const SUMMARY = "已保存的反馈分析需要保留，不得因取消生成而替换。";
const GENERATED_SUMMARY = "本次新生成的反馈分析。";
const BODY = Object.freeze({ month: "", demo: false, force: true });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function aiResult(request, { title = NEW_TITLE, summary = GENERATED_SUMMARY } = {}) {
  const first = request.input.records[0];
  return { data: { summary, actions: [{ sourceKey: "", kind: "menu", title,
    description: "核验菜库后试行清淡蔬菜轮换并记录供应结果。", targetStall: STALL,
    menuInstruction: "午餐使用已核验的清淡蔬菜菜品并保持轮换。", priority: "medium",
    feedbackIds: [first.id], evidenceIds: [first.passages[0].id] }] },
    model: "mock-generation-cancel", requestId: "mock-request", usage: {} };
}

function controlledAi({ observeAbort = true } = {}) {
  const calls = [];
  const waiters = new Map();
  return {
    calls,
    status: () => ({ configured: true, model: "mock-generation-cancel" }),
    respond(request) {
      assert.equal(request.role, "actions", "The fixture never invokes translation or another model role");
      const gate = deferred();
      const call = { request, gate };
      calls.push(call);
      waiters.get(calls.length)?.resolve(call);
      if (observeAbort && request.signal) {
        const abort = () => gate.reject(request.signal.reason || Object.assign(new Error("Aborted mock generation"), { name: "AbortError" }));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }
      return gate.promise;
    },
    started(number = 1) {
      if (calls[number - 1]) return Promise.resolve(calls[number - 1]);
      if (!waiters.has(number)) waiters.set(number, deferred());
      return waiters.get(number).promise;
    },
    complete(number = 1, options) {
      const call = calls[number - 1];
      assert.ok(call, "A started mock AI request is required");
      call.gate.resolve(aiResult(call.request, options));
    },
    releaseAll() { calls.forEach(call => call.gate.resolve(aiResult(call.request))); },
  };
}

// No SQLite file or listening socket: all business state lives in the memory
// adapter and every HTTP request uses Fastify inject with an explicit AI mock.
async function fixture(t, ai = controlledAi()) {
  const store = createRepository(createMemoryAdapter(), () => ({
    feedback: [{ id: "F-CANCEL", content: "希望午餐增加已核验的清淡素食选择。", restaurant: STALL, date: "2026-09-10",
      type: "建议", category: "菜品", status: "未处理", events: [], replies: [], sources: [] }],
    dishes: [{ id: "D-CANCEL", name: "清炒蔬菜", stall: STALL, active: true, price: 8, priceText: "8", unit: "份", spicy: "不辣", vegetarian: "素食" }],
    rules: [], recipes: [], inventory: [], report: {},
  }));
  await summarizeActions(store, { respond: async request => aiResult(request, { title: OLD_TITLE, summary: SUMMARY }) });
  const old = store.all("actions")[0];
  store.put("actions", old.id, { ...old, status: "approved", revision: 3, menuInstruction: "运营已经确认的要求保持不变。" });
  const app = createApp(store, undefined, { ai, prepareEnglish: false });
  t.after(async () => { ai.releaseAll?.(); await app.close(); store.close(); });
  return { store, app, ai };
}

function snapshot(store) {
  return { actions: store.all("actions"), summary: getActionSummary(store),
    summaries: store.all("meta").filter(item => item?.scope === "real:all"),
    aggregated: store.all("audit").filter(item => item.kind === "actions.aggregated") };
}

function start(app, generationId, extra = {}) {
  return app.inject({ method: "POST", url: "/api/actions/summarize", payload: { ...BODY, ...extra, ...(generationId === undefined ? {} : { generationId }) } }).then(response => response);
}

function cancel(app, id, extra = {}) {
  return app.inject({ method: "POST", url: `/api/generations/${encodeURIComponent(id)}/cancel`, payload: {}, ...extra });
}

function assertCancelled(response) {
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "GENERATION_CANCELLED");
  assert.equal(typeof response.json().error, "string");
  for (const key of ["prompt", "rawPrompt", "systemPrompt", "actionPromptText", "plannerPrompt", "stack", "request", "signal"])
    assert.equal(response.json()[key], undefined, `Cancellation errors must not expose ${key}`);
}

test("cancelling Action generation aborts its active AI request and preserves all prior Actions and analysis", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const before = snapshot(store);
  const id = "action-cancel-active-001";
  const pending = start(app, id);
  const call = await ai.started();
  assert.ok(call.request.signal instanceof AbortSignal);
  assert.equal(call.request.signal.aborted, false);
  const stopped = await cancel(app, id);
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { id, status: "cancelling", cancelled: true });
  assert.equal(call.request.signal.aborted, true);
  const result = await pending;
  assertCancelled(result);
  assert.deepEqual((await cancel(app, id)).json(), { id, status: "cancelled", cancelled: true });
  assert.ok(!result.body.includes(call.request.prompt));
  assert.ok(!stopped.body.includes(call.request.prompt));
  assert.deepEqual(snapshot(store), before);
  assert.equal(ai.calls.length, 1);
});

test("a late AI success after cancellation is ignored and cannot create Actions or replace analysis", { timeout: 8000 }, async t => {
  const ai = controlledAi({ observeAbort: false });
  const { store, app } = await fixture(t, ai);
  const before = snapshot(store);
  const id = "action-cancel-late-0002";
  const pending = start(app, id);
  const call = await ai.started();
  const stopped = await cancel(app, id);
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().cancelled, true);
  assert.equal(call.request.signal.aborted, true);
  ai.complete();
  assertCancelled(await pending);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.all("actions").some(action => action.title === NEW_TITLE), false);
  assert.equal(ai.calls.length, 1);
});

test("cancel arriving before start leaves a tombstone that blocks the late request without any model call", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const before = snapshot(store);
  const id = "action-cancel-before-03";
  const first = await cancel(app, id);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { id, status: "cancelled", cancelled: true });
  const second = await cancel(app, id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().status, "cancelled");
  assertCancelled(await start(app, id));
  assertCancelled(await start(app, id));
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(snapshot(store), before);
});

test("cancelling an unrelated generation never aborts or blocks a different active Action request", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const activeId = "action-generation-isolated-04";
  const cancelledId = "another-generation-cancel-04";
  const pending = start(app, activeId);
  const call = await ai.started();
  const unrelated = await cancel(app, cancelledId);
  assert.equal(unrelated.statusCode, 200);
  assert.equal(unrelated.json().id, cancelledId);
  assert.equal(call.request.signal.aborted, false);
  ai.complete();
  const result = await pending;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().analysis.summary, GENERATED_SUMMARY);
  assert.ok(store.all("actions").some(action => action.title === NEW_TITLE));
  assert.ok(store.all("actions").some(action => action.title === OLD_TITLE && action.status === "approved"));
  assert.equal(ai.calls.length, 1);
  assertCancelled(await start(app, cancelledId));
  assert.equal(ai.calls.length, 1);
});

test("a completed generation is reported as completed on cancel and the same ID cannot replay paid work", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const id = "action-generation-completed-05";
  const pending = start(app, id);
  await ai.started();
  const duplicate = await start(app, id);
  assert.ok(duplicate.statusCode >= 400);
  assert.equal(ai.calls.length, 1, "An in-flight duplicate must not call AI twice");
  ai.complete();
  assert.equal((await pending).statusCode, 200);
  const completed = snapshot(store);
  const stopped = await cancel(app, id);
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { id, status: "completed", cancelled: false });
  const replay = await start(app, id);
  assert.ok(replay.statusCode >= 400);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(snapshot(store), completed);
});

test("a cancelled ID cannot restart paid work and fresh IDs remain usable", { timeout: 8000 }, async t => {
  const { app, ai } = await fixture(t);
  const id = "action-generation-replay-06";
  const pending = start(app, id);
  await ai.started();
  await cancel(app, id);
  assertCancelled(await pending);
  assertCancelled(await start(app, id));
  assert.equal(ai.calls.length, 1);
  const fresh = start(app, "action-generation-fresh-06");
  await ai.started(2);
  ai.complete(2);
  assert.equal((await fresh).statusCode, 200);
  assert.equal(ai.calls.length, 2);
});

test("cancel after an ordinary generation failure reports failed rather than claiming cancellation", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const before = snapshot(store);
  const id = "action-generation-failed-07";
  const pending = start(app, id);
  const call = await ai.started();
  call.gate.reject(new Error("Mock model unavailable"));
  assert.ok((await pending).statusCode >= 400);
  const stopped = await cancel(app, id);
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { id, status: "failed", cancelled: false });
  assert.ok((await start(app, id)).statusCode >= 400);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(snapshot(store), before);
});

test("generation IDs and cancel origins are validated before registering or invoking model work", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const before = snapshot(store);
  for (const id of ["", "short", "a".repeat(101), "has space-0001", "bad/slash-0001", "中文标识不应接受", "bad.query?0001"]) {
    const result = await start(app, id);
    assert.ok(result.statusCode >= 400 && result.statusCode < 500, `Invalid generation ID ${JSON.stringify(id)} must fail safely`);
    if (id) {
      const stopped = await cancel(app, id);
      assert.ok(stopped.statusCode >= 400 && stopped.statusCode < 500);
    }
  }
  const unsafe = await cancel(app, "action-unsafe-origin-07", { headers: { origin: "https://untrusted.example" } });
  assert.equal(unsafe.statusCode, 403);
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(snapshot(store), before);
  const allowed = start(app, "action-unsafe-origin-07");
  await ai.started();
  ai.complete();
  assert.equal((await allowed).statusCode, 200, "A forbidden cancellation cannot register a tombstone");
});

test("legacy Action requests without generationId remain compatible and complete normally", { timeout: 8000 }, async t => {
  const { store, app, ai } = await fixture(t);
  const pending = start(app);
  await ai.started();
  ai.complete();
  const result = await pending;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().analysis.summary, GENERATED_SUMMARY);
  assert.ok(store.all("actions").some(action => action.title === NEW_TITLE));
  assert.equal(ai.calls.length, 1);
});
