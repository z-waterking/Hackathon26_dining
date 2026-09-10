import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { prepareCatalogEnglish } from "../server/catalog-english.mjs";
import { readStallCatalog } from "../server/stored-stall-catalog.mjs";
import { completedMenuResult, menuFingerprint, menuRecoveryRecords, resumeMenuWorkflow, runMenuWorkflow } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], seed: 2, count: 2 };
const settings = { version: 1, plannerPrompt: "隔离菜单排菜配置", inspectorPrompt: "隔离菜单检验配置", operatorNotes: "" };

function fixture(t) {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 16 }, (_, number) => ({
    id: `${group}-${number}`, name: `${stall}菜${number}`, english: "", stall, price: 12, unit: "份", active: true,
    spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料${number}`, method: "炒", labelSource: "厨房现场核验",
    sources: [{ file: "isolated-source.xlsx", sheet: stall, row: number + 1 }],
    ...(number === 0 ? { origin: "manual" } : number === 1 ? { catalogManualOverride: true } : {}),
  })));
  const store = createRepository(createMemoryAdapter(), () => ({ dishes, feedback: [], rules: [], report: {} }));
  store.put("settings", "current", settings);
  store.put("meta", "preprocessed-stall-catalog", { storageMode: "database", source: { file: "isolated-source.xlsx", sha256: "fixture" },
    groups: ["档口甲", "档口乙"].map(stall => ({ stall, origin: stall === "档口甲" ? "primary" : "supplement", candidateIds: [], unresolved: [],
      records: dishes.filter(dish => dish.stall === stall).map(dish => ({ name: dish.name, price: dish.price, unit: dish.unit, dishIds: [dish.id], sources: dish.sources })) })),
    warnings: [], stats: { uniqueDishes: dishes.length } });
  t.after(() => store.close());
  return store;
}

function menuAi(planner = directWeeklyResponse) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(request);
    return { data: request.role === "planner" ? await planner(request) : { verdict: "pass", summary: "独立菜单核验完成", findings: [] },
      model: "isolated-menu-test", usage: { input_tokens: 10, output_tokens: 5 } };
  } };
}

function translationAi() {
  const calls = [];
  return { calls, async respond(request) {
    assert.equal(request.role, "dish_names");
    calls.push(request);
    return { data: { translations: request.input.names.map(({ id }) => ({ id, english: `Translated Dish ${calls.length}-${id}` })) },
      model: "isolated-translation-test", requestId: `translation-${calls.length}` };
  } };
}

test("preparing English and incrementing dish revisions does not stale completed menus or candidate fingerprints", async t => {
  const store = fixture(t);
  const ai = menuAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  store.put("plans", "P-SAVED", { ...plan, id: "P-SAVED" });
  const runBefore = store.get("menuRuns", plan.workflow.runId);
  const plansBefore = store.all("plans");
  const catalogBefore = readStallCatalog(store);
  const dishesBefore = store.all("dishes");
  const translated = await prepareCatalogEnglish(store, translationAi(), { batchSize: 9 });
  assert.equal(translated.filled, dishesBefore.length);
  assert.ok(store.all("dishes").every(dish => dish.english && dish.revision === 1));
  assert.deepEqual(readStallCatalog(store), catalogBefore);
  const result = completedMenuResult(store, plan.workflow.runId, settings);
  assert.equal(result.workflow.stale, false);
  assert.deepEqual(result.workflow.staleReasons, []);
  assert.equal(menuFingerprint(result), menuFingerprint(plan));
  assert.deepEqual(result.entries, plan.entries);
  assert.deepEqual(store.get("menuRuns", plan.workflow.runId), runBefore);
  assert.deepEqual(store.all("plans"), plansBefore);
  assert.equal(ai.calls.length, 13, "English preparation must not trigger replanning or inspection");
});

test("failed per-stall runs remain resumable after English metadata changes and reuse completed checkpoints", async t => {
  const store = fixture(t);
  const failing = menuAi(request => {
    if (request.input.week === 2 && request.input.targetStall === "档口乙") throw new Error("isolated fixture timeout");
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai: failing, input: options, settings }), /fixture timeout/);
  const prior = store.all("menuRuns")[0];
  assert.equal(prior.plannerBatches.length, 1);
  assert.equal(prior.stallBatches.length, 3);
  const catalogBefore = readStallCatalog(store);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
  await prepareCatalogEnglish(store, translationAi());
  assert.deepEqual(readStallCatalog(store), catalogBefore);
  const recovery = menuRecoveryRecords(store, settings).find(run => run.id === prior.id);
  assert.equal(recovery.resumable, true);
  assert.equal(recovery.completedWeeks, 1);
  const resumedAi = menuAi();
  const resumed = await resumeMenuWorkflow({ store, ai: resumedAi, runId: prior.id, settings });
  assert.deepEqual([resumedAi.calls[0].input.week, resumedAi.calls[0].input.targetStall], [2, "档口乙"]);
  assert.equal(resumedAi.calls.filter(call => call.role === "planner").length, 9);
  const child = store.get("menuRuns", resumed.workflow.runId);
  assert.deepEqual(child.stallBatches.slice(0, 3), prior.stallBatches);
  assert.equal(resumed.workflow.stale, false);
  assert.deepEqual(store.get("menuRuns", prior.id), prior);
  assert.equal(store.all("plans").length, 0);
});

test("English preparation during menu generation does not alter its source snapshot or later weeks", async t => {
  const store = fixture(t);
  const catalogBefore = readStallCatalog(store);
  const translation = translationAi();
  const menus = menuAi();
  let sourceSnapshot;
  const plan = await runMenuWorkflow({ store, ai: menus, input: options, settings, onProgress: async event => {
    if (event.type !== "week" || event.completedWeeks !== 1) return;
    sourceSnapshot = store.get("menuRuns", event.runId).snapshots;
    const result = await prepareCatalogEnglish(store, translation);
    assert.equal(result.filled, 32);
    assert.deepEqual(readStallCatalog(store), catalogBefore);
    assert.deepEqual(store.get("menuRuns", event.runId).snapshots, sourceSnapshot);
  } });
  assert.equal(plan.workflow.stale, false);
  assert.equal(plan.entries.length, 240);
  assert.equal(menus.calls.filter(call => call.role === "planner").length, 12);
  assert.equal(translation.calls.length, 1);
  assert.deepEqual(store.get("menuRuns", plan.workflow.runId).snapshots, sourceSnapshot);
  assert.ok(!JSON.stringify(menus.calls).includes("Translated Dish"), "English presentation data stays out of planning inputs");
});

test("an isolated HTTP disconnect does not cancel accepted English preparation or strand its database lease", { timeout: 5000 }, async t => {
  const store = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let upstreamSignal;
  let calls = 0;
  const observed = { ...store, put(collection, id, value) {
    store.put(collection, id, value);
    if (collection === "meta" && id === "catalog-english-lease" && value.owner === "") finished.resolve();
  } };
  const app = createApp(observed, undefined, { ai: { status: () => ({ configured: true }), async respond(request) {
    calls++; upstreamSignal = request.signal; entered.resolve(); await release.promise;
    return { data: { translations: request.input.names.map(({ id }) => ({ id, english: `Detached Dish ${id}` })) }, model: "isolated-detached-test" };
  } } });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  try {
    const request = fetch(`${base}/api/dishes/prepare-english`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: "isolated-disconnected-english" }), signal: controller.signal });
    const disconnected = assert.rejects(request, error => error.name === "AbortError");
    await entered.promise;
    controller.abort();
    await disconnected;
    assert.equal(upstreamSignal.aborted, false, "only explicit generation cancellation aborts model work");
    release.resolve();
    await finished.promise;
    assert.equal(calls, 1);
    assert.ok(store.all("dishes").every(dish => dish.english.startsWith("Detached Dish") && dish.revision === 1));
    assert.deepEqual(store.get("meta", "catalog-english-lease"), { owner: "", expiresAt: 0 });
    const summary = await app.inject({ method: "GET", url: "/api/dishes/english-summary" });
    assert.equal(summary.json().missing, 0);
    assert.equal(summary.json().needsReview, 32);
  } finally { release.resolve(); await app.close(); }
});
