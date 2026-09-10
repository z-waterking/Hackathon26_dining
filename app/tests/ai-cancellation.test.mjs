import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createAiClient } from "../server/ai.mjs";
import { cancellationError } from "../server/generation-tasks.mjs";

const config = { endpoint: "https://test.services.ai.azure.com/openai/v1/responses", apiKey: "private-key", model: "gpt-5.6-sol",
  budgetUsd: 150, inputPrice: 1, outputPrice: 2, timeoutMs: 1000 };
const request = { role: "actions", prompt: "private-prompt", input: {}, schema: {} };
const isCancelled = error => error.code === "GENERATION_CANCELLED" && error.statusCode === 409;
function fixture(t, fetchImpl) {
  const store = createStore(":memory:", () => ({ feedback: [], dishes: [] }));
  t.after(() => store.close());
  return { store, ai: createAiClient(store, { config, fetchImpl }) };
}

test("AI cancelled before start neither calls Azure nor writes usage", async t => {
  let calls = 0;
  const { store, ai } = fixture(t, () => { calls++; throw new Error("unexpected"); });
  const controller = new AbortController();
  controller.abort(cancellationError());
  await assert.rejects(ai.respond({ ...request, signal: controller.signal }), isCancelled);
  assert.equal(calls, 0);
  assert.equal(store.all("aiUsage").length, 0);
});

test("cancelling a synchronous response aborts the upstream connection without retry", async t => {
  let calls = 0;
  let upstreamSignal;
  const started = Promise.withResolvers();
  const { store, ai } = fixture(t, (_url, init) => {
    calls++;
    upstreamSignal = init.signal;
    assert.equal(JSON.parse(init.body).store, false);
    started.resolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const result = ai.respond({ ...request, signal: controller.signal });
  const rejected = assert.rejects(result, isCancelled);
  await started.promise;
  controller.abort(cancellationError());
  await rejected;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(store.all("aiUsage")[0].status, "cancelled");
  assert.equal(store.all("aiUsage")[0].errorCode, "GENERATION_CANCELLED");
  assert.doesNotMatch(JSON.stringify(store.all("aiUsage")), /private-key|private-prompt/);
});

test("late model output is discarded after cancellation while reported token usage is retained", async t => {
  const released = Promise.withResolvers();
  const { store, ai } = fixture(t, () => released.promise);
  const controller = new AbortController();
  const result = ai.respond({ ...request, signal: controller.signal });
  const rejected = assert.rejects(result, isCancelled);
  controller.abort(cancellationError());
  released.resolve(Response.json({ id: "safe-request-id", status: "completed", output_text: '{"private-result":true}',
    usage: { input_tokens: 50, output_tokens: 10 } }));
  await rejected;
  const record = store.all("aiUsage")[0];
  assert.equal(record.status, "cancelled");
  assert.equal(record.inputTokens, 50);
  assert.equal(record.outputTokens, 10);
  assert.equal(record.estimatedCostUsd, 0.00007);
  assert.doesNotMatch(JSON.stringify(record), /private-result/);
});

test("ordinary timeouts remain failures, not user cancellations", async t => {
  const { store, ai } = fixture(t, () => { throw new DOMException("timeout", "TimeoutError"); });
  const controller = new AbortController();
  await assert.rejects(ai.respond({ ...request, signal: controller.signal }), error => {
    assert.equal(error.statusCode, 502);
    assert.notEqual(error.code, "GENERATION_CANCELLED");
    assert.match(error.message, /超时/);
    return true;
  });
  assert.equal(store.all("aiUsage")[0].status, "failed");
});
