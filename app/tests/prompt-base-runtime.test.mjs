import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { COLLECTIONS, createRepository } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { getSettings } from "../server/settings.mjs";
import { getPromptConfig, initializePromptBase, promptHistory, promptHistoryVersion } from "../server/prompt-config.mjs";
import { promptAdminView } from "../server/prompt-admin.mjs";
import { responseInstructions } from "../server/prompt-builders.mjs";
import { directContext, directPrompt, directPromptHash } from "../server/direct-menu-planner.mjs";
import { readStallCatalog, STALL_CATALOG_KEY } from "../server/stored-stall-catalog.mjs";
import { approvedMenuActions, completedMenuResult, menuRecoveryRecords, resumeMenuWorkflow, runMenuWorkflow, sourceRules } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], seed: 1, count: 2 };
const snapshot = store => Object.fromEntries(COLLECTIONS.map(name => [name, store.all(name)]));
const configPayload = (config, patch = {}) => ({ version: config.version, baseFingerprint: config.baseFingerprint,
  actionGenerationText: config.actionGenerationText, menuSystemText: config.menuSystemText, approvedActionText: config.approvedActionText,
  rules: structuredClone(config.rules), ...patch });

function fixture(t) {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 16 }, (_, index) => ({
    id: `D-${group}-${index}`, name: `${stall}候选${index}`, stall, price: 12, unit: "份", category: "菜品", active: true,
    spicy: "不辣", vegetarian: "素食", mainIngredient: `蔬菜${index}`, method: "炒", labelSource: "厨房核验",
  })));
  const store = createRepository(createMemoryAdapter(), () => ({ dishes,
    feedback: [{ id: "F1", content: "希望增加不同蔬菜的轮换选择", restaurant: "档口甲", date: "2026-09-10", type: "建议", status: "未处理" }],
    rules: [{ stall: "档口甲", meal: "午餐", text: "BASE_SOURCE_RULE：保持候选真实且同餐不同名", source: { file: "fixture-rules.xlsx", sheet: "排菜规则", row: 3, cell: "B3" } },
      { stall: "档口乙", meal: "晚餐", text: "BASE_SECOND_RULE：不同蔬菜轮换", source: { file: "fixture-rules.xlsx", sheet: "排菜规则", row: 4, cell: "B4" } }],
    recipes: [], inventory: [], report: {},
  }));
  getSettings(store);
  store.put("meta", STALL_CATALOG_KEY, { storageMode: "database", source: { file: "fixture-catalog.xlsx", sha256: "fixture" },
    groups: ["档口甲", "档口乙"].map(stall => ({ stall, origin: "supplement", records: [] })), warnings: [], stats: {} });
  const action = { source: "aggregate", feedbackIds: ["F1"], targetStall: "档口甲", kind: "menu", status: "approved",
    enabled: true, revision: 1, priority: "medium" };
  for (const item of [{ id: "APPROVED_A", title: "APPROVED_SELECTED_MARKER", menuInstruction: "APPROVED_SELECTED_INSTRUCTION" },
    { id: "PENDING_A", title: "PENDING_EXCLUDED_MARKER", menuInstruction: "PENDING_EXCLUDED_INSTRUCTION", status: "pending" },
    { id: "SERVICE_A", title: "SERVICE_EXCLUDED_MARKER", menuInstruction: "", kind: "service" },
    { id: "DISABLED_A", title: "DISABLED_EXCLUDED_MARKER", menuInstruction: "DISABLED_EXCLUDED_INSTRUCTION", enabled: false }])
    store.put("actions", item.id, { ...action, ...item });
  t.after(() => store.close());
  return store;
}

function mockedAi(planner = directWeeklyResponse) {
  const calls = [];
  return { calls, status: () => ({ configured: true, model: "prompt-base-isolated-test" }), async respond(request) {
    calls.push(structuredClone(request));
    return { data: request.role === "planner" ? await planner(request) : { verdict: "pass", summary: "隔离菜单核验完成", findings: [] },
      model: "prompt-base-isolated-test", requestId: `fixture-${calls.length}`, usage: { input_tokens: 10, output_tokens: 5 } };
  } };
}

function planningState(store) {
  const snapshots = { promptConfig: getPromptConfig(store), planningMode: "per-stall",
    dishes: store.all("dishes"), stallCatalog: readStallCatalog(store), rules: sourceRules(store),
    sourceRules: sourceRules(store, false), actions: approvedMenuActions(store), fixedDishes: [] };
  return { candidates: directContext(snapshots, options).candidates, prompt: directPrompt(snapshots), promptHash: directPromptHash(snapshots) };
}

async function readHistory(app, version = 0) {
  for (const url of ["/api/prompt-config", "/api/prompt-config/history?page=1&pageSize=10", `/api/prompt-config/history/${version}`]) {
    const response = await app.inject({ url, headers: { host: "localhost" } });
    assert.equal(response.statusCode, 200, url);
  }
}

function assertRuntimePreview(view, ai) {
  const plannerCalls = ai.calls.filter(call => call.role === "planner");
  assert.equal(plannerCalls.length, 12);
  for (const call of plannerCalls) {
    const preview = view.previews.menuByStall.find(item => item.stall === call.input.targetStall);
    assert.equal(responseInstructions(call.prompt), preview.text, "preview must equal the next actual model instructions, including the Responses boundary");
    assert.ok(call.prompt.includes(view.menuSystemText));
    assert.ok(call.prompt.includes(view.approvedActionText));
    for (const rule of view.rules)
      assert.equal(call.prompt.includes(rule.text), rule.enabled, `rule ${rule.id} must follow its enabled state`);
    const expectedActions = call.input.targetStall === "档口甲" ? ["APPROVED_A"] : [];
    assert.deepEqual(call.input.approvedActions.map(action => action.id), expectedActions);
    assert.equal(call.prompt.includes("APPROVED_SELECTED_INSTRUCTION"), expectedActions.length > 0);
    for (const marker of ["PENDING_EXCLUDED", "SERVICE_EXCLUDED", "DISABLED_EXCLUDED"]) assert.ok(!call.prompt.includes(marker));
  }
}

test("base initialization and history reads preserve v0 candidates, prompt hash and failed-run recovery checkpoints", async t => {
  const store = fixture(t);
  const settings = getSettings(store);
  const failing = mockedAi(request => {
    if (request.input.week === 2 && request.input.targetStall === "档口乙") throw new Error("isolated fixture timeout");
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai: failing, input: options, settings }), /fixture timeout/);
  const prior = store.all("menuRuns")[0];
  assert.equal(prior.snapshots.promptConfig.version, 0);
  assert.equal(prior.plannerBatches.length, 1);
  assert.equal(prior.stallBatches.length, 3);
  const before = snapshot(store);
  const configBefore = getPromptConfig(store);
  const planningBefore = planningState(store);
  const recoveryBefore = menuRecoveryRecords(store, settings);
  assert.equal(recoveryBefore[0].resumable, true);
  assert.equal(planningBefore.promptHash, prior.promptHash);

  const base = initializePromptBase(store);
  assert.equal(base.version, 0);
  assert.deepEqual(getPromptConfig(store), configBefore, "metadata initialization must not change the runtime config DTO or its source concurrency token");
  assert.equal(store.get("meta", "prompt-config:current"), null);
  assert.equal(store.get("meta", "prompt-config:version-0"), null);
  for (const collection of COLLECTIONS.filter(name => name !== "meta"))
    assert.deepEqual(store.all(collection), before[collection], `initialization must not write ${collection}`);
  assert.deepEqual(store.all("meta"), [...before.meta, base], "the baseline is the only new stored record");
  const initialized = snapshot(store);
  assert.deepEqual(initializePromptBase(store), base);
  const app = createApp(store, undefined, { ai: failing });
  t.after(() => app.close());
  assert.equal(promptHistory(store).total, 1);
  assert.equal(promptHistoryVersion(store, 0).operation, "base");
  await readHistory(app);
  assert.deepEqual(snapshot(store), initialized, "idempotent initialization and all history/config reads are non-mutating");
  assert.deepEqual(planningState(store), planningBefore);
  assert.deepEqual(menuRecoveryRecords(store, settings), recoveryBefore);
  assert.equal(failing.calls.length, 4, "metadata operations must not call the model");

  const resumedAi = mockedAi();
  const resumed = await resumeMenuWorkflow({ store, ai: resumedAi, runId: prior.id, settings });
  assert.deepEqual([resumedAi.calls[0].input.week, resumedAi.calls[0].input.targetStall], [2, "档口乙"]);
  assert.equal(resumedAi.calls.filter(call => call.role === "planner").length, 9);
  const child = store.get("menuRuns", resumed.workflow.runId);
  assert.deepEqual(child.stallBatches.slice(0, 3), prior.stallBatches);
  assert.equal(child.promptHash, prior.promptHash);
  assert.equal(resumed.workflow.stale, false);
  assert.deepEqual(store.get("menuRuns", prior.id), prior, "recovery leaves the original saved run unchanged");
});

test("base and history metadata leave a completed menu and its persisted plan unchanged", async t => {
  const store = fixture(t);
  const settings = getSettings(store);
  const ai = mockedAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  store.put("plans", "P-SAVED", { ...plan, id: "P-SAVED" });
  const run = store.get("menuRuns", plan.workflow.runId);
  const plans = store.all("plans");
  const planningBefore = planningState(store);
  const resultBefore = completedMenuResult(store, run.id, settings);
  initializePromptBase(store);
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const beforeReads = snapshot(store);
  await readHistory(app);
  assert.deepEqual(snapshot(store), beforeReads);
  assert.deepEqual(planningState(store), planningBefore);
  assert.deepEqual(store.get("menuRuns", run.id), run);
  assert.deepEqual(store.all("plans"), plans);
  assert.deepEqual(completedMenuResult(store, run.id, settings), resultBefore);
  assert.equal(resultBefore.workflow.stale, false);
  assert.equal(ai.calls.length, 13, "viewing baseline/history must not regenerate or reinspect a completed menu");
});

test("confirm and restore responses preview the exact next-generation rules and approved Actions without rewriting historical runs", async t => {
  const store = fixture(t);
  const settings = getSettings(store);
  initializePromptBase(store);
  const base = promptHistoryVersion(store, 0);
  const baseView = promptAdminView(store);
  const sourceBefore = store.get("meta", "rules");
  const candidatesBefore = planningState(store).candidates;
  const baselineHash = planningState(store).promptHash;
  const passiveAi = mockedAi();
  const app = createApp(store, undefined, { ai: passiveAi });
  t.after(() => app.close());
  const savedResponse = await app.inject({ method: "PUT", url: "/api/prompt-config", headers: { host: "localhost" },
    payload: configPayload(baseView, { actionGenerationText: "CONFIRMED_FEEDBACK_PROMPT：从整批真实反馈归纳可执行改善事项",
      menuSystemText: "CONFIRMED_MENU_PROMPT：从各档口真实候选中选择轮换菜单",
      approvedActionText: "CONFIRMED_ACTION_PROMPT：仅落实已批准且启用的范围内排菜事项",
      rules: baseView.rules.map((rule, index) => index ? { ...rule, enabled: false } : { ...rule, text: "CONFIRMED_RULE：轮换现有候选并保留人工核验" }) }) });
  assert.equal(savedResponse.statusCode, 200);
  const saved = savedResponse.json();
  assert.equal(saved.version, 1);
  assert.equal(saved.base.isCurrent, false);
  assert.equal(passiveAi.calls.length, 0, "confirm only saves; it does not generate menus");
  assert.equal(promptHistoryVersion(store, 1).operation, "confirm");
  const savedHistory = promptHistoryVersion(store, 1);
  const confirmedAi = mockedAi();
  const confirmedPlan = await runMenuWorkflow({ store, ai: confirmedAi, input: options, settings });
  assertRuntimePreview(saved, confirmedAi);
  const confirmedRun = store.get("menuRuns", confirmedPlan.workflow.runId);
  assert.equal(saved.previews.menuSystem, responseInstructions(directPrompt(confirmedRun.snapshots)));
  assert.equal(confirmedRun.snapshots.promptConfig.version, saved.version);
  assert.notEqual(confirmedRun.promptHash, baselineHash);
  assert.deepEqual(confirmedRun.snapshots.rules.map(rule => rule.text), ["CONFIRMED_RULE：轮换现有候选并保留人工核验"]);
  assert.deepEqual(planningState(store).candidates, candidatesBefore);

  const restoredResponse = await app.inject({ method: "POST", url: "/api/prompt-config/restore-base", headers: { host: "localhost" },
    payload: { version: saved.version, baseFingerprint: saved.baseFingerprint } });
  assert.equal(restoredResponse.statusCode, 200);
  const restored = restoredResponse.json();
  assert.equal(restored.version, 2, "restore appends a new version instead of rewriting version 0 or 1");
  assert.equal(restored.base.isCurrent, true);
  assert.equal(promptHistoryVersion(store, 2).operation, "restore-base");
  for (const key of ["actionGenerationText", "menuSystemText", "approvedActionText"]) assert.equal(restored[key], base[key]);
  assert.ok(restored.rules.every(rule => rule.enabled));
  assert.equal(passiveAi.calls.length, 0, "restoring configuration must not start model work");
  assert.deepEqual(store.get("meta", "rules"), sourceBefore, "config edits and restore never overwrite the imported source rules");
  assert.deepEqual(promptHistoryVersion(store, 0), base);
  assert.deepEqual(promptHistoryVersion(store, 1), savedHistory);
  assert.deepEqual(store.get("menuRuns", confirmedRun.id), confirmedRun);
  const restoredAi = mockedAi();
  const restoredPlan = await runMenuWorkflow({ store, ai: restoredAi, input: options, settings });
  assertRuntimePreview(restored, restoredAi);
  const restoredRun = store.get("menuRuns", restoredPlan.workflow.runId);
  assert.equal(restoredRun.snapshots.promptConfig.version, restored.version);
  assert.equal(restoredRun.promptHash, baselineHash, "restoring base recreates the effective baseline instructions, regardless of revision metadata");
  assert.equal(restored.previews.menuSystem, responseInstructions(directPrompt(restoredRun.snapshots)));
  assert.deepEqual(planningState(store).candidates, candidatesBefore);
  assert.deepEqual(store.get("menuRuns", confirmedRun.id), confirmedRun);
  assert.deepEqual(promptHistory(store).items.map(item => [item.version, item.operation]), [[2, "restore-base"], [1, "confirm"], [0, "base"]]);
  const beforeReads = snapshot(store);
  await readHistory(app, 1);
  assert.deepEqual(snapshot(store), beforeReads);
});
