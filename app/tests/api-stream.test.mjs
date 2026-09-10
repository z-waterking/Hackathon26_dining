import test from "node:test";
import assert from "node:assert/strict";
import { createDiningApi } from "../src/api/dining.js";
import { ApiError, createHttpClient } from "../src/api/http.js";

const encoder = new TextEncoder();
const eventsText = (events, newline = true) => events.map((event) => JSON.stringify(event)).join("\n") + (newline ? "\n" : "");
function streamResponse(chunks, { close = true, onCancel = () => {} } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      if (close) controller.close();
    },
    cancel: onCancel,
  }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

test("progressive menu API posts once through the common transport and forwards events and abort signal", async () => {
  const calls = [];
  const seen = [];
  const plan = { id: "P1", entries: [{ dishName: "香菇青菜" }] };
  const events = [{ type: "started", runId: "MR1", plan: { entries: [] } }, { type: "week", runId: "MR1", week: 1, plan }, { type: "inspecting", runId: "MR1", plan }, { type: "completed", runId: "MR1", plan }];
  const api = createDiningApi({ baseUrl: "/moved/api", fetchImpl: async (url, init) => { calls.push({ url, ...init }); return streamResponse([eventsText(events)]); } });
  const controller = new AbortController();
  assert.deepEqual(await api.plans.generateProgressive({ weeks: 6 }, { onEvent: (event) => seen.push(event), signal: controller.signal }), plan);
  assert.deepEqual(seen, events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/moved/api/plans/generate-stream");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Accept, "application/x-ndjson");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].body), { weeks: 6 });
});

test("progressive recovery validates the ID and returns the final plan without changing legacy methods", async () => {
  const calls = [];
  const plan = { id: "P2" };
  const api = createDiningApi({ fetchImpl: async (url, init) => { calls.push({ url, ...init }); return streamResponse([eventsText([{ type: "completed", runId: "MR2", plan }])]); } });
  assert.deepEqual(await api.plans.resumeProgressive("MR / 中"), plan);
  assert.equal(calls[0].url, "/api/plans/resume-stream");
  assert.deepEqual(JSON.parse(calls[0].body), { runId: "MR / 中" });
  assert.equal(calls[0].method, "POST");
  assert.throws(() => api.plans.resumeProgressive(".."), /ID/);
  assert.throws(() => api.plans.resumeProgressive(""), /ID/);
  assert.equal(calls.length, 1);
  assert.equal(typeof api.plans.generate, "function");
  assert.equal(typeof api.plans.resume, "function");
});

test("NDJSON parses UTF-8 split at every byte, CRLF, blank lines and a final line without newline", async () => {
  const plan = { id: "P3", title: "第一周 · 中餐🍜" };
  const events = [{ type: "started", runId: "MR3" }, { type: "heartbeat", runId: "MR3" }, { type: "completed", runId: "MR3", plan }];
  const data = encoder.encode("\n\r\n" + eventsText(events, false).replaceAll("\n", "\r\n\n"));
  const chunks = Array.from(data, (byte) => new Uint8Array([byte]));
  const seen = [];
  const http = createHttpClient({ fetchImpl: async () => streamResponse(chunks) });
  assert.deepEqual(await http.stream("/plans/generate-stream", { onEvent: async (event) => { await Promise.resolve(); seen.push(event); } }), plan);
  assert.deepEqual(seen, events);
});

test("NDJSON emits weeks before completion instead of buffering the entire response", async () => {
  let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; } });
  const http = createHttpClient({ fetchImpl: async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }) });
  const firstWeek = Promise.withResolvers();
  let settled = false;
  const result = http.stream("/plans/generate-stream", { onEvent: (event) => { if (event.type === "week") firstWeek.resolve(event); } }).finally(() => { settled = true; });
  const plan = { id: "P4", entries: [{ week: 1 }] };
  streamController.enqueue(encoder.encode(eventsText([{ type: "week", runId: "MR4", week: 1, plan }])));
  assert.equal((await firstWeek.promise).week, 1);
  assert.equal(settled, false);
  streamController.enqueue(encoder.encode(eventsText([{ type: "completed", runId: "MR4", plan }])));
  assert.deepEqual(await result, plan);
});

test("stream errors expose only whitelisted diagnostics and retain the most recent run ID", async () => {
  const seen = [];
  const payload = { type: "error", error: "第 2 周生成未完成", code: "MENU_SLOT_INVALID", week: 2, stall: "寻味列车", day: 1, meal: "午餐", slot: 0, plannerPrompt: "private", plannerAttempts: [{ raw: "private" }] };
  const http = createHttpClient({ fetchImpl: async () => streamResponse([eventsText([{ type: "started", runId: "MR5" }, payload])]) });
  await assert.rejects(http.stream("/plans/generate-stream", { onEvent: (event) => seen.push(event) }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, payload.error);
    assert.equal(error.runId, "MR5");
    for (const field of ["code", "week", "stall", "day", "meal", "slot"]) assert.equal(error[field], payload[field]);
    assert.equal(error.plannerPrompt, undefined);
    assert.equal(error.plannerAttempts, undefined);
    return true;
  });
  assert.equal(seen.at(-1).type, "error");
});

test("non-200 JSON errors use existing safe HTTP diagnostics and never retry a stream POST", async () => {
  let calls = 0;
  const api = createDiningApi({ fetchImpl: async () => { calls++; return Response.json({ error: { message: "已有排菜任务正在运行", runId: "MR6", code: "MENU_BUSY", plannerPrompt: "private" } }, { status: 409 }); } });
  await assert.rejects(api.plans.generateProgressive({}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.runId, "MR6");
    assert.equal(error.code, "MENU_BUSY");
    assert.equal(error.plannerPrompt, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test("proxy and network failures are normalized without exposing response contents or retrying", async () => {
  let calls = 0;
  const http = createHttpClient({ fetchImpl: async () => { calls++; return new Response("<html>private proxy details</html>", { status: 502 }); } });
  await assert.rejects(http.stream("/plans/generate-stream"), (error) => error instanceof ApiError && error.status === 502 && !error.message.includes("private"));
  assert.equal(calls, 1);
  const disconnected = createHttpClient({ fetchImpl: () => { calls++; throw new Error("private socket details"); } });
  await assert.rejects(disconnected.stream("/plans/generate-stream"), /无法连接/);
  assert.equal(calls, 2);
});

test("empty and premature streams are never reported as successful menus", async () => {
  for (const events of [[], [{ type: "started", runId: "MR7" }], [{ type: "week", runId: "MR7", week: 1, plan: { id: "partial" } }]]) {
    let calls = 0;
    const http = createHttpClient({ fetchImpl: async () => { calls++; return streamResponse([eventsText(events)]); } });
    await assert.rejects(http.stream("/plans/generate-stream"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "MENU_STREAM_INCOMPLETE");
      assert.equal(error.runId, events.length ? "MR7" : undefined);
      assert.match(error.message, /生成记录/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("malformed event types, JSON, UTF-8 and missing completed plans fail with safe errors", async () => {
  const invalid = ["{not json}\n", eventsText([{ type: "unknown" }]), eventsText([null]), eventsText([{ type: "completed" }]), eventsText([{ type: "completed", plan: [] }]), new Uint8Array([0xc3, 0x28])];
  for (const chunk of invalid) {
    const http = createHttpClient({ fetchImpl: async () => streamResponse([eventsText([{ type: "started", runId: "MR8" }]), chunk]) });
    await assert.rejects(http.stream("/plans/generate-stream"), (error) => error instanceof ApiError && error.code === "MENU_STREAM_INVALID" && error.runId === "MR8");
  }
});

test("successful JSON or HTML cannot masquerade as a generation stream", async () => {
  for (const response of [Response.json({ plan: { id: "P9" } }), new Response("<html>app shell</html>", { headers: { "Content-Type": "text/html" } })]) {
    const http = createHttpClient({ fetchImpl: async () => response });
    await assert.rejects(http.stream("/plans/generate-stream"), (error) => error instanceof ApiError && error.code === "MENU_STREAM_INVALID");
  }
});

test("callback failures cancel and unlock the reader even if the server stream remains open", async () => {
  let cancelled = false;
  const response = streamResponse([eventsText([{ type: "started", runId: "MR9" }])], { close: false, onCancel: () => { cancelled = true; } });
  const http = createHttpClient({ fetchImpl: async () => response });
  const callbackError = new Error("view unmounted");
  await assert.rejects(http.stream("/plans/generate-stream", { onEvent: () => { throw callbackError; } }), (error) => error === callbackError);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("completion does not await a lingering connection and cancels its reader", async () => {
  let cancelled = false;
  const response = streamResponse([eventsText([{ type: "completed", runId: "MR10", plan: { id: "P10" } }])], { close: false, onCancel: () => { cancelled = true; } });
  const http = createHttpClient({ fetchImpl: async () => response });
  assert.deepEqual(await http.stream("/plans/generate-stream"), { id: "P10" });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("reader disconnects preserve checkpoints and distinguish explicit aborts without retries", async () => {
  for (const abort of [false, true]) {
    let calls = 0;
    let controller;
    const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "Content-Type": "application/x-ndjson" } });
    const http = createHttpClient({ fetchImpl: async () => { calls++; return response; } });
    const request = http.stream("/plans/generate-stream", { onEvent: () => { controller.error(abort ? new DOMException("private abort details", "AbortError") : new Error("private socket details")); } });
    controller.enqueue(encoder.encode(eventsText([{ type: "started", runId: "MR11" }])));
    await assert.rejects(request, (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.runId, "MR11");
      assert.equal(error.code, abort ? "MENU_STREAM_ABORTED" : "MENU_STREAM_INCOMPLETE");
      assert.equal(error.name, abort ? "AbortError" : "ApiError");
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(response.body.locked, false);
  }
});

test("invalid callback is rejected before initiating a billable request", async () => {
  let calls = 0;
  const http = createHttpClient({ fetchImpl: async () => { calls++; return streamResponse([]); } });
  await assert.rejects(http.stream("/plans/generate-stream", { onEvent: "invalid" }), TypeError);
  assert.equal(calls, 0);
});
