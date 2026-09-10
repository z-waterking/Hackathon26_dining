import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { completedMenuResult, menuRecoveryRecords, resumeMenuWorkflow, runMenuWorkflow } from "../server/menu-workflow.mjs";
import { publicData, publicMenuRun } from "../server/public-data.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], seed: 3, count: 2 };
const settings = { version: 1, plannerPrompt: "内部排菜配置", inspectorPrompt: "内部检验配置", feedbackPrompt: "内部反馈配置", operatorNotes: "使用已核验候选" };
const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 12 }, (_, index) => ({
  id: `${group}-${index}`, name: `${stall}菜${index}`, stall, price: 12, unit: "份", active: true,
  spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料${index}`, method: "炒", labelSource: "厨房核验",
})));
const action = { id: "A-1", source: "aggregate", feedbackIds: ["F-1"], title: "安排已核验菜品", targetStall: "档口甲",
  menuInstruction: "使用已核验候选菜品", priority: "high", status: "approved", enabled: true, revision: 2 };
const sha256 = value => createHash("sha256").update(value).digest("hex");
function setup(t) {
  const store = createStore(":memory:", () => ({ dishes, feedback: [{ id: "F-1", content: "真实反馈仅为测试来源" }],
    rules: [{ stall: "档口甲", text: "同餐菜品不重复", meal: "午餐" }], inventory: [], recipes: [], report: {} }));
  store.put("actions", action.id, action);
  store.put("settings", "current", settings);
  t.after(() => store.close());
  return store;
}
const inspector = () => ({ verdict: "pass", summary: "已独立检查全部六周；保留人工审核。", findings: [] });
function mockAi({ planner = directWeeklyResponse, inspect = inspector } = {}) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(structuredClone(request));
    const data = await (request.role === "planner" ? planner(request) : inspect(request));
    return { data, model: "test-no-network", usage: { input_tokens: 100, output_tokens: 20 }, requestId: `test-${calls.length}` };
  } };
}
function invalidAt(week) {
  return request => {
    const data = directWeeklyResponse(request);
    if (request.input.week === week) { data.summary = "SERVER_ONLY_INVALID_MENU"; data.menus.S0[0] = 99999; }
    return data;
  };
}
async function failedRun(store, { week = 3, ruleSourcePath } = {}) {
  const ai = mockAi({ planner: invalidAt(week) });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings, ruleSourcePath }));
  return { ai, run: store.all("menuRuns").at(-1) };
}

test("semantic failure retries only its week and retains every original attempt", async t => {
  const store = setup(t);
  const { ai, run } = await failedRun(store);
  assert.deepEqual(ai.calls.map(call => call.input.week), [1, 2, 3, 3, 3]);
  assert.deepEqual(run.plannerBatches.map(batch => batch.week), [1, 2]);
  assert.deepEqual(run.plannerAttempts.map(item => [item.week, item.attempt, item.status]),
    [[1, 1, "accepted"], [2, 1, "accepted"], [3, 1, "invalid"], [3, 2, "invalid"], [3, 3, "invalid"]]);
  const failures = run.plannerAttempts.filter(item => item.status === "invalid");
  assert.ok(failures.every(item => item.data.menus.S0[0] === 99999 && item.data.summary === "SERVER_ONLY_INVALID_MENU"));
  assert.ok(failures.every(item => item.diagnostics.week === 3 && item.diagnostics.code && item.requestId && item.usage.input_tokens === 100));
  assert.equal(ai.calls[2].input.correction, undefined);
  assert.equal(ai.calls[3].input.correction.attempt, 2);
  assert.deepEqual(ai.calls[3].input.correction.previousOutput, failures[0].data);
  assert.equal(ai.calls[4].input.correction.attempt, 3);
  assert.deepEqual(ai.calls[4].input.previousWeeks, ai.calls[2].input.previousWeeks);
  assert.equal(run.failedStage, "planning");
  assert.equal(run.plan, undefined);
  assert.equal(store.all("plans").length, 0);
});

test("a valid correction continues later weeks without rerunning the accepted prefix", async t => {
  const store = setup(t);
  let weekTwoAttempts = 0;
  const ai = mockAi({ planner: request => {
    const result = directWeeklyResponse(request);
    if (request.input.week === 2 && ++weekTwoAttempts === 1) result.menus.S0.pop();
    return result;
  } });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.deepEqual(ai.calls.filter(call => call.role === "planner").map(call => call.input.week), [1, 2, 2, 3, 4, 5, 6]);
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(run.plannerAttempts.filter(item => item.status === "accepted").length, 6);
  assert.equal(run.plannerAttempts.filter(item => item.status === "invalid").length, 1);
  assert.deepEqual(run.planner.usage, { input_tokens: 700, output_tokens: 140 }, "current usage includes the invalid response that was corrected");
  assert.deepEqual(run.planner.acceptedOutputUsage, { input_tokens: 600, output_tokens: 120 });
  assert.deepEqual(run.planner.reusedUsage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(plan.entries.length, 2 * 6 * 5 * 2 * 2);
  assert.equal(store.all("plans").length, 0);
});

test("a transport timeout is not automatically retried", async t => {
  const store = setup(t);
  const ai = mockAi({ planner: () => { throw Object.assign(new Error("upstream request timed out"), { code: "ETIMEDOUT", statusCode: 504 }); } });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /timed out/);
  assert.equal(ai.calls.length, 1);
  const run = store.all("menuRuns")[0];
  assert.equal(run.plannerAttempts.length, 1);
  assert.equal(run.plannerAttempts[0].status, "failed");
  assert.equal(run.plannerAttempts[0].data, undefined);
  assert.equal(run.plannerBatches.length, 0);
  assert.equal(store.all("plans").length, 0);
});

test("resume creates a child and calls only the failed and remaining weeks", async t => {
  const store = setup(t);
  const { run: prior } = await failedRun(store);
  const before = structuredClone(prior);
  const ai = mockAi();
  const plan = await resumeMenuWorkflow({ store, ai, runId: prior.id, settings });
  assert.deepEqual(ai.calls.map(call => call.role === "planner" ? call.input.week : call.role), [3, 4, 5, 6, "inspector"]);
  assert.equal(ai.calls[0].input.previousWeeks.length, 2);
  const child = store.get("menuRuns", plan.workflow.runId);
  assert.notEqual(child.id, prior.id);
  assert.equal(child.parentRunId, prior.id);
  assert.equal(child.resumedWeeks, 2);
  assert.equal(child.plannerBatches.length, 6);
  assert.deepEqual(child.plannerBatches.slice(0, 2).map(batch => batch.result), prior.plannerBatches.map(batch => batch.result));
  assert.ok(child.plannerBatches.slice(0, 2).every(batch => batch.sourceRunId === prior.id));
  assert.deepEqual(child.plannerAttempts.map(item => item.week), [3, 4, 5, 6]);
  assert.deepEqual(child.planner.usage, { input_tokens: 400, output_tokens: 80 }, "only this resumed run's four planner requests are counted");
  assert.deepEqual(child.planner.acceptedOutputUsage, { input_tokens: 600, output_tokens: 120 });
  assert.deepEqual(child.planner.reusedUsage, { input_tokens: 200, output_tokens: 40 });
  assert.deepEqual(store.get("menuRuns", prior.id), before);
  assert.equal(store.all("plans").length, 0);
  const duplicateAi = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai: duplicateAi, runId: prior.id, settings }), /已经继续/);
  assert.equal(duplicateAi.calls.length, 0);
});

test("an inspector failure reuses all six planner results and retries inspection only", async t => {
  const store = setup(t);
  const firstAi = mockAi({ inspect: () => { throw new Error("isolated inspector timeout"); } });
  await assert.rejects(runMenuWorkflow({ store, ai: firstAi, input: options, settings }), /inspector timeout/);
  const prior = store.all("menuRuns")[0];
  assert.equal(prior.failedStage, "inspecting");
  assert.equal(prior.plannerBatches.length, 6);
  assert.ok(prior.plan.entries.length > 0);
  const ai = mockAi();
  const plan = await resumeMenuWorkflow({ store, ai, runId: prior.id, settings });
  assert.deepEqual(ai.calls.map(call => call.role), ["inspector"]);
  assert.deepEqual(plan.entries, prior.plan.entries);
  const child = store.get("menuRuns", plan.workflow.runId);
  assert.equal(child.resumedWeeks, 6);
  assert.equal(child.plannerAttempts.length, 0);
  assert.deepEqual(child.planner.usage, { input_tokens: 0, output_tokens: 0 }, "inspector-only resume makes no new planner request");
  assert.deepEqual(child.planner.acceptedOutputUsage, { input_tokens: 600, output_tokens: 120 });
  assert.deepEqual(child.planner.reusedUsage, { input_tokens: 600, output_tokens: 120 });
  assert.equal(child.parentRunId, prior.id);
  assert.equal(store.all("plans").length, 0);
});

test("changed business snapshots reject resume before making any model call", async t => {
  const changes = [
    ["rules", store => store.put("meta", "rules", [{ stall: "档口甲", text: "更新规则" }])],
    ["source metadata", store => store.put("meta", "menu-rule-source", { file: "changed.xlsx", sha256: "changed" })],
    ["fixed staples", store => store.put("meta", "menu-fixed-staples", [{ stall: "档口甲", meal: "午餐", text: "新的主食" }])],
    ["fixed dishes", store => store.put("meta", "menu-fixed-dishes", [{ stall: "档口甲", meal: "午餐", name: "新固定菜品", price: 4, unit: "份" }])],
    ["actions", store => store.put("actions", action.id, { ...action, revision: 3, menuInstruction: "新的菜单事项" })],
    ["dishes", store => store.put("dishes", dishes[0].id, { ...dishes[0], price: 13 })],
    ["stored settings", store => store.put("settings", "current", { ...settings, operatorNotes: "新的运营偏好" })],
  ];
  for (const [name, change] of changes) await t.test(name, async t => {
    const store = setup(t);
    const { run } = await failedRun(store, { week: 2 });
    change(store);
    const ai = mockAi();
    await assert.rejects(resumeMenuWorkflow({ store, ai, runId: run.id, settings }), /变化/);
    assert.equal(ai.calls.length, 0);
    assert.equal(store.all("menuRuns").length, 1);
    assert.equal(menuRecoveryRecords(store, settings)[0].resumable, false);
  });
  await t.test("passed settings", async t => {
    const store = setup(t);
    const { run } = await failedRun(store, { week: 2 });
    const ai = mockAi();
    await assert.rejects(resumeMenuWorkflow({ store, ai, runId: run.id, settings: { ...settings, inspectorPrompt: "新的检验要求" } }), /配置已变化/);
    assert.equal(ai.calls.length, 0);
  });
});

test("source-file byte changes and unavailable source files prevent resume", async t => {
  const store = setup(t);
  const directory = await mkdtemp(join(tmpdir(), "menu-resume-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ruleSourcePath = join(directory, "test-source.xlsx");
  await writeFile(ruleSourcePath, "isolated original source bytes");
  store.put("meta", "menu-rule-source", { file: "test-source.xlsx", sha256: sha256(await readFile(ruleSourcePath)) });
  const { run } = await failedRun(store, { week: 2, ruleSourcePath });
  await writeFile(ruleSourcePath, "changed source bytes");
  const ai = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: run.id, settings }), /源规则文件已变化/);
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: run.id, settings, ruleSourcePath: join(directory, "missing.xlsx") }), /源规则文件已变化/);
  assert.equal(ai.calls.length, 0);
  assert.equal(store.all("menuRuns").length, 1);
});

test("resume refuses saved gaps, invalid accepted output and prompt tampering", async t => {
  const mutations = [
    ["gap", run => { run.plannerBatches.splice(1, 1); }, /连续完整/],
    ["invalid accepted raw result", run => { run.plannerBatches[0].result.menus.S0[0] = 99999; }, /./],
    ["prompt digest mismatch", run => { run.snapshots.prompts.planner += "篡改"; }, /快照不完整/],
    ["unknown planner version", run => { run.plannerVersion = "unknown-future-format"; }, /指令已变化/],
  ];
  for (const [name, mutate, error] of mutations) await t.test(name, async t => {
    const store = setup(t);
    const { run } = await failedRun(store, { week: 4 });
    mutate(run);
    store.put("menuRuns", run.id, run);
    const ai = mockAi();
    await assert.rejects(resumeMenuWorkflow({ store, ai, runId: run.id, settings }), error);
    assert.equal(ai.calls.length, 0);
    assert.equal(store.all("menuRuns").length, 1);
  });
});

test("legacy valid prefix is rebuilt with global indexes and continues with scoped indexes", async t => {
  const store = setup(t);
  const { run } = await failedRun(store);
  const template = (await readFile(new URL("./fixtures/menu-planner-v1.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n").trimEnd() + "\n";
  assert.equal(sha256(template), "68706a10c753eb855f383701b36ed9120828a18b6b7f099f989c62972d764f07");
  const businessActions = run.snapshots.actions.map(({ id, title, targetStall, menuInstruction, priority, revision }) => ({ id, title, targetStall, menuInstruction, priority, revision }));
  const prompt = [template, "# 本地文件规则（餐饮业务约束，保留来源）", JSON.stringify(run.snapshots.rules),
    "# 已批准运营调整（不得覆盖源硬规则）", JSON.stringify(businessActions)].join("\n");
  run.snapshots.prompts.planner = prompt;
  run.promptHash = sha256(prompt);
  run.plannerVersion = "gpt-direct-v1";
  delete run.plannerAttempts;
  for (const batch of run.plannerBatches) {
    delete batch.format;
    batch.result.menus = Object.entries(batch.result.menus).map(([key, indexes]) => ({
      stallIndex: Number(key.slice(1)), dishIndexes: indexes.map(index => index === -1 ? -1 : Number(key.slice(1)) * 12 + index),
    }));
  }
  store.put("menuRuns", run.id, run);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, true);
  const ai = mockAi();
  const plan = await resumeMenuWorkflow({ store, ai, runId: run.id, settings });
  assert.deepEqual(ai.calls.filter(call => call.role === "planner").map(call => call.input.week), [3, 4, 5, 6]);
  assert.ok(ai.calls[0].input.dishCatalog.S0);
  assert.ok(ai.calls[0].input.previousWeeks.every(week => Array.isArray(week.menus.S0)));
  assert.ok(plan.entries.filter(entry => entry.week <= 2 && entry.stall === "档口乙").every(entry => entry.dishId.startsWith("1-")));
  const child = store.get("menuRuns", plan.workflow.runId);
  assert.equal(child.plannerBatches[0].format, "gpt-direct-v1");
  assert.equal(child.plannerBatches[2].format, child.plannerVersion);
  assert.notEqual(child.plannerVersion, "gpt-direct-v1");
  assert.equal(child.parentRunId, run.id);
  assert.equal(store.all("plans").length, 0);
});

test("completed results are fetched without generating again or automatically saving a plan", async t => {
  const store = setup(t);
  const plan = await runMenuWorkflow({ store, ai: mockAi(), input: options, settings });
  const result = completedMenuResult(store, plan.workflow.runId, settings);
  assert.deepEqual(result.entries, plan.entries);
  assert.equal(result.workflow.requiresHumanApproval, true);
  const ai = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: plan.workflow.runId, settings }), /已完成请查看结果/);
  assert.equal(ai.calls.length, 0);
  assert.equal(menuRecoveryRecords(store, settings)[0].canUseSavedResult, true);
  assert.equal(menuRecoveryRecords(store, settings)[0].resumable, false);
  assert.equal(store.all("plans").length, 0);
});

test("raw failed attempts remain server-only in generic and menu API projections", async t => {
  const store = setup(t);
  const { run } = await failedRun(store);
  assert.ok(run.plannerAttempts.some(item => item.data?.summary === "SERVER_ONLY_INVALID_MENU"));
  for (const projected of [publicData(run), publicMenuRun(run), menuRecoveryRecords(store, settings)]) {
    const serialized = JSON.stringify(projected);
    assert.ok(!serialized.includes("SERVER_ONLY_INVALID_MENU"));
    assert.ok(!serialized.includes("plannerAttempts"));
    assert.ok(!serialized.includes("本地文件规则（餐饮业务约束"));
    assert.ok(!serialized.includes("内部检验配置"));
  }
});

test("HTTP recovery endpoints expose safe progress, explicitly resume, and fetch results without more AI calls", async t => {
  const store = setup(t);
  let shouldFail = true;
  const ai = mockAi({ planner: request => shouldFail ? invalidAt(3)(request) : directWeeklyResponse(request) });
  ai.status = () => ({ configured: true, model: "test-no-network" });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const request = async (url, payload) => app.inject({ method: payload === undefined ? "GET" : "POST", url,
    headers: { host: "127.0.0.1", ...(payload === undefined ? {} : { "content-type": "application/json" }) }, payload });
  const failed = await request("/api/plans/generate", { ...options, useAi: true });
  assert.equal(failed.statusCode, 502);
  const failure = failed.json();
  assert.ok(failure.runId);
  assert.equal(failure.week, 3);
  const records = (await request("/api/menu-runs")).json();
  assert.equal(records[0].id, failure.runId);
  assert.equal(records[0].completedWeeks, 2);
  assert.equal(records[0].resumable, true);
  assert.equal(records[0].canUseSavedResult, false);
  const trace = await request(`/api/menu-runs/${failure.runId}`);
  assert.equal(trace.statusCode, 200);
  for (const body of [failed.body, JSON.stringify(records), trace.body])
    for (const text of ["SERVER_ONLY_INVALID_MENU", "plannerAttempts", "plannerBatches", settings.plannerPrompt, settings.inspectorPrompt])
      assert.ok(!body.includes(text), `${text} must remain server-side`);
  const callsAfterFailure = ai.calls.length;
  const badResume = await request("/api/plans/resume", { runId: failure.runId, start: "2026-10-05" });
  assert.equal(badResume.statusCode, 400, "the client cannot change dates during resume");
  assert.equal(ai.calls.length, callsAfterFailure);
  shouldFail = false;
  const recovered = await request("/api/plans/resume", { runId: failure.runId });
  assert.equal(recovered.statusCode, 200, recovered.body);
  const plan = recovered.json();
  assert.equal(plan.entries.length, 2 * 6 * 5 * 2 * 2);
  const callsAfterResume = ai.calls.length;
  assert.equal(callsAfterResume - callsAfterFailure, 5);
  const result = await request(`/api/menu-runs/${plan.workflow.runId}/result`);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().entries, plan.entries);
  assert.equal(ai.calls.length, callsAfterResume);
  assert.equal(store.all("plans").length, 0);
  const latest = (await request("/api/menu-runs")).json()[0];
  assert.equal(latest.parentRunId, failure.runId);
  assert.equal(latest.completedWeeks, 6);
  assert.equal(latest.canUseSavedResult, true);
  assert.equal(latest.resumable, false);
});

test("HTTP resume shares the menu workflow lock and does not duplicate in-flight planner calls", async t => {
  const store = setup(t);
  const { run } = await failedRun(store);
  let signalStarted;
  let release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  let waited = false;
  const ai = mockAi({ planner: async request => {
    if (!waited) { waited = true; signalStarted(); await pause; }
    return directWeeklyResponse(request);
  } });
  ai.status = () => ({ configured: true, model: "test-no-network" });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const request = (url, payload) => app.inject({ method: "POST", url, headers: { host: "127.0.0.1", "content-type": "application/json" }, payload });
  const pending = request("/api/plans/resume", { runId: run.id });
  await started;
  try {
    const duplicate = await request("/api/plans/resume", { runId: run.id });
    assert.equal(duplicate.statusCode, 400);
    assert.match(duplicate.json().error, /正在进行/);
    const other = await request("/api/plans/generate", { ...options, useAi: true });
    assert.equal(other.statusCode, 400);
    assert.match(other.json().error, /正在进行/);
    assert.equal(ai.calls.length, 1);
  } finally { release(); }
  const completed = await pending;
  assert.equal(completed.statusCode, 200, completed.body);
  assert.deepEqual(ai.calls.map(call => call.role === "planner" ? call.input.week : call.role), [3, 4, 5, 6, "inspector"]);
  assert.equal(store.all("plans").length, 0);
});
