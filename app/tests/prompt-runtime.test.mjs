import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";
import { createApp } from "../server/app.mjs";
import { getSettings } from "../server/settings.mjs";
import { getPromptConfig, savePromptConfig } from "../server/prompt-config.mjs";
import { responseInstructions } from "../server/prompt-builders.mjs";
import { approvedMenuActions, runMenuWorkflow, sourceRules } from "../server/menu-workflow.mjs";
import { getActionSummary, summarizeActions } from "../server/action-summary.mjs";
import { aiConfig, createAiClient } from "../server/ai.mjs";
import { directContext, directPrompt } from "../server/direct-menu-planner.mjs";
import { STALL_CATALOG_KEY } from "../server/stored-stall-catalog.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], seed: 1, count: 2 };
const texts = suffix => ({ actionGenerationText: `ACTION_RUNTIME_${suffix}：从全部真实反馈提炼可执行事项`,
  menuSystemText: `MENU_RUNTIME_${suffix}：仅从真实候选生成指定档口菜单`,
  approvedActionText: `APPROVED_RUNTIME_${suffix}：仅落实当前范围已批准排菜事项` });
const ruleText = suffix => `RULE_RUNTIME_${suffix}：轮换实际候选，保留核验要求`;
const snapshot = store => Object.fromEntries(COLLECTIONS.map(name => [name, store.all(name)]));
const configPayload = (config, patch = {}) => ({ version: config.version, baseFingerprint: config.baseFingerprint,
  actionGenerationText: config.actionGenerationText, menuSystemText: config.menuSystemText, approvedActionText: config.approvedActionText,
  rules: structuredClone(config.rules), ...patch });

function setup(t, { perStall = false, actions = true } = {}) {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 12 }, (_, index) => ({
    id: `D-${group}-${index}`, name: `${stall}候选${index}`, stall, price: 12, unit: "份", category: "菜品", active: true,
    spicy: "不辣", vegetarian: "素食", mainIngredient: `蔬菜${index}`, method: "炒", labelSource: "厨房核验",
  })));
  const store = createStore(":memory:", () => ({ dishes,
    feedback: [{ id: "F1", content: "希望增加不同蔬菜的轮换选择", restaurant: "档口甲", date: "2026-09-10", type: "建议", status: "未处理" }],
    rules: [{ stall: "档口甲", meal: "午餐", text: "SOURCE_ONLY_RULE：保持候选真实且同餐不同名", source: { file: "fixture-rules.xlsx", sheet: "排菜规则", row: 3, cell: "B3" } },
      { stall: "档口乙", meal: "晚餐", text: "SOURCE_SECOND_RULE：不同蔬菜轮换", source: { file: "fixture-rules.xlsx", sheet: "排菜规则", row: 4, cell: "B4" } }],
    recipes: [], inventory: [], report: {},
  }));
  getSettings(store);
  if (perStall) store.put("meta", STALL_CATALOG_KEY, { storageMode: "database", source: { file: "fixture-catalog.xlsx", sha256: "fixture" },
    groups: ["档口甲", "档口乙"].map(stall => ({ stall, origin: "supplement", records: [] })), warnings: [], stats: {} });
  if (actions) {
    const base = { source: "aggregate", feedbackIds: ["F1"], targetStall: "档口甲", kind: "menu", status: "approved", enabled: true, revision: 1, priority: "medium" };
    for (const action of [{ id: "APPROVED_A", title: "APPROVED_SELECTED_MARKER", menuInstruction: "APPROVED_SELECTED_INSTRUCTION" },
      { id: "PENDING_A", title: "PENDING_EXCLUDED_MARKER", menuInstruction: "PENDING_EXCLUDED_INSTRUCTION", status: "pending" },
      { id: "SERVICE_A", title: "SERVICE_EXCLUDED_MARKER", menuInstruction: "", kind: "service" },
      { id: "DISABLED_A", title: "DISABLED_EXCLUDED_MARKER", menuInstruction: "DISABLED_EXCLUDED_INSTRUCTION", enabled: false }])
      store.put("actions", action.id, { ...base, ...action });
  }
  t.after(() => store.close());
  return store;
}

function saveVersion(store, suffix) {
  const config = getPromptConfig(store);
  return savePromptConfig(store, configPayload(config, { ...texts(suffix),
    rules: config.rules.map((rule, index) => index ? rule : { ...rule, text: ruleText(suffix) }) }));
}

function actionProposal(request) {
  const record = request.input.records[0];
  return { summary: "根据全部反馈归纳具体的蔬菜轮换建议", actions: [{
    sourceKey: request.input.existingActions[0]?.sourceKey || "", kind: "menu", feedbackIds: [record.id],
    evidenceIds: [record.passages[0].id], title: "增加蔬菜轮换", description: "核验：现有菜库；措施：轮换蔬菜；验收：收集试行反馈",
    targetStall: "档口甲", menuInstruction: "从已核验菜库中轮换不同蔬菜", priority: "medium",
  }] };
}

function mockedAi(onRequest = () => {}) {
  const calls = [];
  return { calls, status: () => ({ configured: true, model: "prompt-runtime-no-network" }), async respond(request) {
    calls.push(structuredClone(request));
    await onRequest(request);
    const data = request.role === "planner" ? directWeeklyResponse(request) : request.role === "actions" ? actionProposal(request)
      : { verdict: "pass", summary: "逐周核验完成，仍需人工确认", findings: [] };
    return { data, model: "prompt-runtime-no-network", requestId: `fixture-${calls.length}`, usage: { input_tokens: 10, output_tokens: 5 } };
  } };
}

test("saved configuration reaches real menu consumers, effective rules and approved Action scope", async t => {
  const store = setup(t, { perStall: true });
  const sourceBefore = structuredClone(store.get("meta", "rules"));
  const config = saveVersion(store, "SAVED");
  const ai = mockedAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  const planner = ai.calls.filter(call => call.role === "planner");
  assert.equal(planner.length, 12);
  for (const call of planner) {
    assert.ok(call.prompt.includes(config.menuSystemText));
    assert.ok(call.prompt.includes(config.approvedActionText));
    assert.ok(call.prompt.includes(ruleText("SAVED")));
    assert.ok(!call.prompt.includes(config.actionGenerationText), "Action-generation instructions do not leak into the menu role");
    assert.ok(!call.prompt.includes("SOURCE_ONLY_RULE"), "effective AI rules replace their editable source wording");
    for (const marker of ["PENDING_EXCLUDED", "SERVICE_EXCLUDED", "DISABLED_EXCLUDED"]) assert.ok(!JSON.stringify(call).includes(marker));
    assert.deepEqual(call.input.approvedActions.map(action => action.id), call.input.targetStall === "档口甲" ? ["APPROVED_A"] : []);
  }
  const inspector = ai.calls.find(call => call.role === "inspector");
  assert.ok(!inspector.prompt.includes(config.approvedActionText), "selection instructions must not replace the inspector's findings-only protocol");
  assert.ok(inspector.prompt.includes("APPROVED_SELECTED_INSTRUCTION"));
  assert.deepEqual(inspector.input.approvedActions.map(action => [action.id, action.menuInstruction]), [["APPROVED_A", "APPROVED_SELECTED_INSTRUCTION"]]);
  assert.ok(inspector.prompt.includes(ruleText("SAVED")));
  assert.ok(inspector.input.sourceRules.some(rule => rule.text === ruleText("SAVED")));
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.snapshots.promptConfig.version, config.version);
  assert.equal(run.snapshots.rules[0].text, ruleText("SAVED"));
  assert.equal(run.snapshots.sourceRules[0].text, sourceBefore[0].text);
  assert.deepEqual(store.get("meta", "rules"), sourceBefore, "saving AI rules does not overwrite imported Excel rules");
  assert.equal(store.get("actions", "APPROVED_A").status, "approved");
  assert.equal(store.get("actions", "PENDING_A").status, "pending");
});

test("no eligible Action injects neither pending menu instructions nor approved service matters", async t => {
  const store = setup(t);
  const approved = store.get("actions", "APPROVED_A");
  store.put("actions", approved.id, { ...approved, status: "pending" });
  saveVersion(store, "EMPTY_ACTION_SCOPE");
  assert.deepEqual(approvedMenuActions(store), []);
  const ai = mockedAi();
  await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  for (const call of ai.calls.filter(call => call.role === "planner")) {
    assert.deepEqual(call.input.approvedActions, []);
    assert.match(call.prompt, /没有符合参与条件的排菜 Action/);
    for (const marker of ["APPROVED_SELECTED", "PENDING_EXCLUDED", "SERVICE_EXCLUDED", "DISABLED_EXCLUDED"]) assert.ok(!call.prompt.includes(marker));
  }
});

test("editing rule wording cannot disable source manual/fixed attributes or manufacture them for another stall", t => {
  const store = setup(t, { actions: false });
  store.put("meta", "rules", [
    { stall: "档口甲", text: "该部分菜单需预留人工上传", meal: "午餐" },
    { stall: "档口乙", text: "此档口固定出品", meal: "午餐" },
  ]);
  store.put("meta", "menu-fixed-dishes", [{ stall: "档口乙", name: "档口乙候选0", price: 12, unit: "份", meal: "午餐" }]);
  const source = sourceRules(store, false);
  const config = getPromptConfig(store);
  savePromptConfig(store, configPayload(config, { ...texts("STRUCTURAL"), rules: config.rules.map(rule => ({ ...rule, text: "运营修改：这里正常排菜，不再保留原来的措辞" })) }));
  const snapshots = { dishes: store.all("dishes"), actions: [], sourceRules: source, rules: sourceRules(store), fixedDishes: store.get("meta", "menu-fixed-dishes") };
  const context = directContext(snapshots, options);
  assert.equal(context.layout[0].manualRequired, true);
  assert.equal(context.layout[0].fixed, false);
  assert.equal(context.layout[1].manualRequired, false);
  assert.equal(context.layout[1].fixed, true);
  assert.ok(context.layout[1].fixedDishIndexes.length > 0);
  const normal = directContext({ ...snapshots, sourceRules: source.map(rule => ({ ...rule, text: "源规则仅要求真实候选" })),
    rules: snapshots.rules.map(rule => ({ ...rule, text: "该部分菜单需预留人工上传，此档口固定出品" })) }, options);
  assert.ok(normal.layout.every(item => !item.manualRequired && !item.fixed));
});

test("Action prompt changes invalidate only cached analysis and preserve an operator-approved item", async t => {
  const store = setup(t, { actions: false });
  const firstConfig = saveVersion(store, "ACTION_OLD");
  const ai = mockedAi();
  const first = await summarizeActions(store, ai);
  assert.equal(ai.calls.length, 1);
  assert.ok(ai.calls[0].prompt.includes(firstConfig.actionGenerationText));
  const id = first.actions[0].id;
  const approved = { ...store.get("actions", id), title: "运营人工确认的蔬菜方案", menuInstruction: "保留运营批准的精确指令", status: "approved", revision: 4 };
  store.put("actions", id, approved);
  const cached = await summarizeActions(store, ai);
  assert.equal(cached.reused, true);
  assert.equal(ai.calls.length, 1);
  const secondConfig = saveVersion(store, "ACTION_NEW");
  assert.equal(getActionSummary(store).analysis, null);
  const second = await summarizeActions(store, ai);
  assert.equal(second.reused, false);
  assert.equal(ai.calls.length, 2, "no force flag is needed after the action-generation prompt changes");
  assert.ok(ai.calls[1].prompt.includes(secondConfig.actionGenerationText));
  assert.ok(!ai.calls[1].prompt.includes(firstConfig.actionGenerationText));
  assert.deepEqual(store.get("actions", id), approved, "new analysis never rewrites the operator's decision");
  assert.equal(store.all("actions").length, 1);
});

test("saving during generation leaves its captured prompt and rules unchanged until the next run", async t => {
  const store = setup(t, { perStall: true, actions: false });
  const original = saveVersion(store, "RUN_OLD");
  let updated;
  const ai = mockedAi(request => { if (!updated && request.role === "planner") updated = saveVersion(store, "RUN_NEW"); });
  const first = await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  for (const call of ai.calls.filter(call => call.role === "planner")) {
    assert.ok(call.prompt.includes(original.menuSystemText));
    assert.ok(call.prompt.includes(original.approvedActionText));
    assert.ok(call.prompt.includes(ruleText("RUN_OLD")));
    assert.ok(!call.prompt.includes(updated.menuSystemText));
    assert.ok(!call.prompt.includes(ruleText("RUN_NEW")));
  }
  const prior = structuredClone(store.get("menuRuns", first.workflow.runId));
  assert.equal(prior.stage, "completed");
  assert.equal(prior.snapshots.promptConfig.version, original.version);
  const nextAi = mockedAi();
  await runMenuWorkflow({ store, ai: nextAi, input: options, settings: getSettings(store) });
  assert.ok(nextAi.calls.filter(call => call.role === "planner").every(call => call.prompt.includes(updated.menuSystemText) && call.prompt.includes(ruleText("RUN_NEW"))));
  assert.deepEqual(store.get("menuRuns", prior.id), prior, "a new run does not rewrite historical prompt snapshots");
});

test("configuration HTTP DTO is read-only on GET, uses optimistic saves, and does not expose prompts through business APIs", async t => {
  const store = setup(t, { perStall: true });
  const ai = mockedAi();
  const app = createApp(store, resolve(tmpdir(), "prompt-runtime-no-dist"), { ai });
  t.after(() => app.close());
  const get = url => app.inject({ url, headers: { host: "localhost" } });
  const put = payload => app.inject({ method: "PUT", url: "/api/prompt-config", headers: { host: "localhost", "content-type": "application/json" }, payload });
  const beforeRead = snapshot(store);
  const firstResponse = await get("/api/prompt-config");
  assert.equal(firstResponse.statusCode, 200);
  const first = firstResponse.json();
  assert.equal(first.version, 0);
  assert.ok(first.previews.actionGeneration && first.previews.menuSystem && first.previews.approvedActions);
  assert.deepEqual(first.previews.menuByStall.map(item => item.stall), ["档口甲", "档口乙"]);
  assert.deepEqual(snapshot(store), beforeRead, "reading configuration creates neither revisions nor audit records");
  const payload = configPayload(first, { ...texts("HTTP"), rules: first.rules.map((rule, index) => index ? rule : { ...rule, text: ruleText("HTTP") }) });
  const save = await put(payload);
  assert.equal(save.statusCode, 200);
  const saved = save.json();
  assert.equal(saved.version, 1);
  assert.equal(saved.actionGenerationText, texts("HTTP").actionGenerationText);
  assert.ok(saved.previews.menuByStall[0].text.includes(texts("HTTP").menuSystemText));
  const afterSave = snapshot(store);
  const conflict = await put({ ...payload, menuSystemText: texts("STALE_CLIENT").menuSystemText });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(snapshot(store), afterSave, "stale version cannot overwrite current config or create partial writes");
  assert.equal((await get("/api/prompt-config")).json().version, saved.version);
  assert.deepEqual(snapshot(store), afterSave);
  const plan = await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.ok(run.snapshots.prompts.planner.includes(saved.menuSystemText));
  for (const url of ["/api/data", "/api/menu-runs", `/api/menu-runs/${run.id}`, `/api/menu-runs/${run.id}/result`]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, url);
    for (const marker of [saved.actionGenerationText, saved.menuSystemText, saved.approvedActionText, "promptConfig", "plannerAttempts", "apiKey"])
      assert.ok(!response.body.includes(marker), `${url} must not expose ${marker}`);
  }
  assert.equal(store.get("actions", "APPROVED_A").status, "approved");
  assert.equal(store.get("actions", "PENDING_A").status, "pending");
});

test("previews exactly match consumer instructions including filtered actions and the Responses boundary", async t => {
  const store = setup(t, { perStall: true });
  const ai = mockedAi();
  const app = createApp(store, resolve(tmpdir(), "prompt-runtime-no-dist"), { ai });
  t.after(() => app.close());
  saveVersion(store, "EXACT_PREVIEW");
  const response = await app.inject({ url: "/api/prompt-config", headers: { host: "localhost" } });
  assert.equal(response.statusCode, 200);
  const config = response.json();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(config.previews.menuSystem, responseInstructions(directPrompt(run.snapshots)));
  for (const call of ai.calls.filter(call => call.role === "planner")) {
    const preview = config.previews.menuByStall.find(item => item.stall === call.input.targetStall);
    assert.equal(preview.text, responseInstructions(call.prompt), `${call.input.targetStall} must preview the exact instructions actually sent`);
    assert.match(preview.execution, /候选|发送/);
  }
  const actionAi = mockedAi();
  await summarizeActions(store, actionAi);
  assert.equal(config.previews.actionGeneration, responseInstructions(actionAi.calls[0].prompt));
  assert.equal(ai.calls.filter(call => call.role === "planner").length, 12);
  assert.equal(actionAi.calls.length, 1);
});

test("independent prompt overrides survive source refresh and reject edits based on an old source fingerprint", t => {
  const store = setup(t, { actions: false });
  const saved = saveVersion(store, "SOURCE_OVERLAY");
  const source = store.get("meta", "rules");
  store.put("meta", "rules", source.map((rule, index) => index ? rule : { ...rule, text: "SOURCE_REFRESHED：新的源文件原文" }));
  store.put("meta", "menu-rule-source", { file: "fixture-rules.xlsx", sha256: "changed-source", fingerprint: "changed-source" });
  const beforeRead = snapshot(store);
  const refreshed = getPromptConfig(store);
  assert.equal(refreshed.menuSystemText, saved.menuSystemText);
  assert.equal(refreshed.rules[0].text, saved.rules[0].text);
  assert.notEqual(refreshed.baseFingerprint, saved.baseFingerprint);
  assert.throws(() => savePromptConfig(store, configPayload(saved, { menuSystemText: texts("STALE_SOURCE").menuSystemText })), error => error.statusCode === 409);
  assert.deepEqual(snapshot(store), beforeRead);
  assert.equal(sourceRules(store, false)[0].text, "SOURCE_REFRESHED：新的源文件原文");
  assert.equal(sourceRules(store)[0].text, ruleText("SOURCE_OVERLAY"));
});

test("Action preview equals the actual Responses request instructions without making a network request", async t => {
  const store = setup(t, { perStall: true, actions: false });
  saveVersion(store, "WIRE_FORMAT");
  const bodies = [];
  const ai = createAiClient(store, { config: aiConfig({ AZURE_OPENAI_API_KEY: "TEST_ONLY_NOT_A_REAL_SECRET",
    AZURE_OPENAI_RESPONSES_ENDPOINT: "https://fixture.services.ai.azure.com/openai/v1/responses", AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol" }),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      bodies.push(body);
      return { ok: true, headers: new Headers(), json: async () => ({ id: "mock-responses-request", status: "completed",
        model: "gpt-5.6-sol", usage: { input_tokens: 12, output_tokens: 8 }, output_text: JSON.stringify(actionProposal({ input: JSON.parse(body.input) })) }) };
    },
  });
  const app = createApp(store, resolve(tmpdir(), "prompt-runtime-no-dist"), { ai });
  t.after(() => app.close());
  const view = (await app.inject({ url: "/api/prompt-config", headers: { host: "localhost" } })).json();
  await summarizeActions(store, ai);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].instructions, view.previews.actionGeneration);
  assert.equal(bodies[0].model, "gpt-5.6-sol");
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].text.format.strict, true);
  assert.equal(store.all("aiUsage")[0].status, "completed");
});

test("without a stored stall catalog the preview matches the whole-week consumer mode", async t => {
  const store = setup(t, { actions: false });
  saveVersion(store, "WHOLE_WEEK");
  const ai = mockedAi();
  const app = createApp(store, resolve(tmpdir(), "prompt-runtime-no-dist"), { ai });
  t.after(() => app.close());
  const view = (await app.inject({ url: "/api/prompt-config", headers: { host: "localhost" } })).json();
  assert.deepEqual(view.previews.menuByStall, []);
  const plan = await runMenuWorkflow({ store, ai, input: options, settings: getSettings(store) });
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.snapshots.planningMode, undefined);
  assert.equal(view.previews.menuSystem, responseInstructions(directPrompt(run.snapshots)));
  assert.ok(ai.calls.filter(call => call.role === "planner").every(call => view.previews.menuSystem === responseInstructions(call.prompt)));
});
