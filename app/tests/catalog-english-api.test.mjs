import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const dish = { id: "D-English", name: "清炒西兰花", english: "", stall: "测试档口", price: 8, unit: "份", priceText: "8", active: true, sources: [] };
async function fixture(t, respond) {
  const store = createStore(":memory:", () => ({ dishes: [dish], feedback: [{ id: "F-private", content: "PRIVATE_FEEDBACK_NOT_FOR_TRANSLATION" }], recipes: [{ name: dish.name, private: "PRIVATE_RECIPE_NOT_FOR_TRANSLATION" }] }));
  const app = createApp(store, undefined, { ai: { status: () => ({ configured: true }), respond } });
  t.after(async () => { await app.close(); store.close(); });
  const request = (url, payload = {}) => app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });
  return { store, app, request };
}

test("English summary/workspace reads never translate; explicit preparation persists names and is reused", async t => {
  let calls = 0;
  const { store, app, request } = await fixture(t, async ({ role, input, signal }) => {
    calls++;
    assert.equal(role, "dish_names");
    assert.deepEqual(Object.keys(input), ["names"]);
    assert.deepEqual(input.names, [{ id: 0, sourceName: dish.name }]);
    assert.ok(signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_|stall|recipes|feedback/);
    return { data: { translations: [{ id: 0, english: "Stir-fried Broccoli" }] }, model: "mock-only", requestId: "R-mock" };
  });
  const before = JSON.stringify(store.all("dishes"));
  const summary = (await app.inject({ method: "GET", url: "/api/dishes/english-summary" })).json();
  assert.equal(summary.missing, 1);
  await app.inject({ method: "GET", url: "/api/data" });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(store.all("dishes")), before);
  const prepared = await request("/api/dishes/prepare-english", { generationId: "english-generation-a" });
  assert.equal(prepared.statusCode, 200);
  assert.equal(prepared.json().missing, 0);
  assert.equal(prepared.json().needsReview, 1);
  assert.equal(store.get("dishes", dish.id).name, dish.name);
  assert.equal(store.get("dishes", dish.id).englishName.origin, "ai");
  assert.equal(store.all("catalogEnglish").length, 1);
  const again = await request("/api/dishes/prepare-english", { generationId: "english-generation-b" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().filled, 0);
  assert.equal(calls, 1);
});

test("English preparation cancellation aborts only that generation and discards late output", async t => {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  let aiSignal;
  const { store, request } = await fixture(t, async ({ signal }) => { aiSignal = signal; started.resolve(); return released.promise; });
  const pending = request("/api/dishes/prepare-english", { generationId: "english-cancel-task" }).then(result => result);
  await started.promise;
  const cancellation = await request("/api/generations/english-cancel-task/cancel");
  assert.equal(cancellation.json().cancelled, true);
  assert.equal(aiSignal.aborted, true);
  released.resolve({ data: { translations: [{ id: 0, english: "Late output" }] } });
  const result = await pending;
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().code, "GENERATION_CANCELLED");
  assert.equal(store.get("dishes", dish.id).english, "");
  assert.equal(store.all("catalogEnglish").length, 0);
});

test("preparation writes require same-origin JSON and reject arbitrary translation input", async t => {
  let calls = 0;
  const { app, request } = await fixture(t, () => { calls++; throw new Error("Unexpected AI"); });
  assert.equal((await request("/api/dishes/prepare-english", { generationId: "english-bad-input", texts: ["not a dish"] })).statusCode, 400);
  const crossOrigin = await app.inject({ method: "POST", url: "/api/dishes/prepare-english", headers: { origin: "https://other.example", "content-type": "application/json" }, payload: {} });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/dishes/prepare-english" })).statusCode, 415);
  assert.equal(calls, 0);
});
