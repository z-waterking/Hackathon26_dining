import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { generateMenu, checkMenu } from "../server/menus.mjs";
import { approvedMenuActions, attachMenuWorkflow, menuFingerprint, runMenuWorkflow, reinspectMenuWorkflow } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-07", meals: ["午餐", "晚餐"], seed: 3, count: 2 };
const settings = { version: 1, plannerPrompt: "排菜员测试指令", inspectorPrompt: "独立检验员测试指令", feedbackPrompt: "反馈测试指令", operatorNotes: "优先考虑运营已核验的菜品" };
const dishes = ["档口甲", "档口乙"].flatMap((stall, group) => Array.from({ length: 12 }, (_, index) => ({
  id: `${group}-${index}`, name: `${stall}菜${index}`, stall, price: 12, unit: "份", active: true,
  spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料${index}`, method: "炒", labelSource: "厨房现场核验",
})));
const action = { id: "A-1", source: "aggregate", feedbackIds: ["F-1"], title: "调整菜品选择", targetStall: "档口甲", menuInstruction: "选择已核验菜品并暂时停用档口甲菜0", priority: "high", status: "approved", enabled: true, revision: 2 };
function setup(t, sourceDishes = dishes) {
  const store = createStore(":memory:", () => ({ dishes: sourceDishes,
    feedback: [{ id: "F-1", content: "反馈原文不应直接传给排菜员", type: "投诉", status: "未处理" }],
    rules: [{ stall: "档口甲", text: "同餐菜品不重复", meal: "午餐", source: { file: "餐厅排菜规则+示例.xlsx", sheet: "排菜规则", row: 3, cell: "B3" } }], inventory: [], recipes: [], report: {},
  }));
  store.put("actions", action.id, action);
  store.put("settings", "current", settings);
  t.after(() => store.close());
  return store;
}
const planner = (request) => directWeeklyResponse(request, { excludeIds: ["D0"] });
const inspector = () => ({ verdict: "pass", summary: "已检查全部实际菜单，仍需运营人工确认。", findings: [] });
function mockAi(overrides = {}) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(structuredClone(request));
    const data = await (overrides[request.role] || (request.role === "planner" ? planner : inspector))(request);
    return { data, model: "mock-model", usage: { input_tokens: 100, output_tokens: 50 }, requestId: `request-${calls.length}` };
  } };
}

test("GPT chooses all six weeks before independent inspection, using only approved enabled real actions", async (t) => {
  const store = setup(t);
  for (const [id, patch] of [["pending", { status: "pending" }], ["rejected", { status: "rejected" }], ["disabled", { enabled: false }], ["non-menu", { menuInstruction: " " }], ["demo", { demo: true }]])
    store.put("actions", id, { ...action, id, ...patch });
  store.put("actions", "legacy-single", { ...action, id: "legacy-single", feedbackIds: undefined, feedbackId: "F-1" });
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: { ...options, scope: undefined, stall: "档口甲" }, settings });
  assert.equal(plan.scope, "all");
  assert.equal(plan.generationMode, "gpt-direct");
  assert.equal(plan.entries.length, 2 * 6 * 5 * 2 * 2);
  assert.ok(!plan.entries.some((entry) => entry.dishId === "0-0"));
  assert.deepEqual(ai.calls.map((call) => call.role), [...Array(6).fill("planner"), "inspector"]);
  for (const [index, request] of ai.calls.slice(0, 6).entries()) {
    assert.equal(request.input.week, index + 1);
    assert.equal(request.input.previousWeeks.length, index);
    assert.deepEqual(request.input.approvedActions.map((item) => item.id), ["A-1"]);
    assert.equal(request.input.catalogCoverage.complete, true);
    assert.equal(Object.values(request.input.dishCatalog).flat().length, dishes.length);
    assert.ok(request.prompt.includes("同餐菜品不重复"));
    assert.ok(request.prompt.includes(action.menuInstruction));
  }
  assert.ok(!JSON.stringify(ai.calls).includes("反馈原文不应直接传给排菜员"));
  assert.equal(ai.calls[6].input.actualMenu.tuples.length, plan.entries.length);
  assert.equal(ai.calls[6].input.actualMenu.weeks, 6);
  assert.equal(plan.workflow.requiresHumanApproval, true);
  assert.equal(plan.workflow.actionImpacts[0].status, "applied");
  assert.equal(plan.workflow.actionImpacts[0].selectedEntries, 6);
  assert.equal(plan.workflow.actionImpacts[0].baselineEntries, undefined);
  assert.equal(plan.workflow.actionImpacts[0].changedEntries, undefined);
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.stage, "completed");
  assert.equal(run.plannerBatches.length, 6);
  assert.equal(run.snapshots.rules[0].source.row, 3);
  assert.equal(run.snapshots.rules[0].meal, "午餐");
  assert.equal(run.snapshots.actions[0].revision, 2);
  assert.equal(run.workflow.menuFingerprint, menuFingerprint(plan));
  assert.equal(store.all("plans").length, 0);
});

test("legacy local generation ignores unapproved feedback but still supports explicit selection policies", () => {
  const baseline = generateMenu(dishes, options);
  assert.deepEqual(generateMenu(dishes, options, [{ content: "不要档口甲菜0", type: "投诉", status: "未处理" }]).entries, baseline.entries);
  const count = (plan) => plan.entries.filter((entry) => entry.dishId === "0-0").length;
  assert.ok(count(generateMenu(dishes, options, [], [{ dishId: "0-0", kind: "prefer", weight: 3 }])) > count(baseline));
  assert.ok(count(generateMenu(dishes, options, [], [{ dishId: "0-0", kind: "avoid", weight: 3 }])) < count(baseline));
});

test("GPT draft retains canonical source stall order", async (t) => {
  const store = setup(t, [...dishes.filter((dish) => dish.stall === "档口乙"), ...dishes.filter((dish) => dish.stall === "档口甲")]);
  const plan = await runMenuWorkflow({ store, ai: mockAi(), input: options, settings });
  assert.deepEqual(plan.stalls, ["档口乙", "档口甲"]);
  assert.deepEqual(checkMenu(store.all("dishes"), plan).entries, plan.entries);
});

test("invalid weekly output fails instead of locally filling an incomplete or fabricated menu", async (t) => {
  const cases = [
    ["candidate outside catalog", (data) => { data.menus.S0[0] = 99999; }],
    ["cross-stall global index", (data) => { data.menus.S0[0] = 12; }],
    ["unexpected stall", (data) => { data.menus.S9 = data.menus.S1; delete data.menus.S1; }],
    ["short output", (data) => { data.menus.S0.pop(); }],
    ["unapproved action", (data) => { data.actionReviews[0].actionId = "A-unapproved"; }],
    ["out-of-scope action evidence", (data) => { data.actionReviews[0].evidence[0].stallIndex = 1; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const store = setup(t);
    const ai = mockAi({ planner: (request) => { const data = planner(request); mutate(data); return data; } });
    await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }));
    const run = store.all("menuRuns")[0];
    assert.equal(run.stage, "failed");
    assert.equal(run.failedStage, "planning");
    assert.equal(run.workflow, undefined);
    assert.equal(run.plan, undefined);
    assert.equal(store.all("plans").length, 0);
    assert.equal(ai.calls.length, 3);
  });
});

test("missing weekly action reviews remain explicitly unimplemented", async (t) => {
  const store = setup(t);
  const ai = mockAi({ planner: (request) => directWeeklyResponse(request, { includeReviews: false }) });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.equal(plan.workflow.actionImpacts[0].status, "not_applied");
  assert.equal(plan.workflow.inspector.verdict, "revise");
  assert.equal(plan.workflow.status, "blocked");
  assert.match(plan.workflow.actionImpacts[0].evidence[0], /未提供.*落实说明/);
  assert.equal(ai.calls[6].input.actionImpacts[0].status, "not_applied");
});

test("source aliases and combined stalls remain traceable within the system prompt", async (t) => {
  const store = setup(t);
  store.put("meta", "rules", [{ stall: "档口甲&档口乙", text: "菜品需复核" }, { stall: "续行", text: "暂缓选用" }, { stall: "铁锅炖", text: "至少两道炖菜" }]);
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  const rules = store.get("menuRuns", plan.workflow.runId).snapshots.rules;
  assert.deepEqual(rules[0].appliesTo, ["档口甲", "档口乙"]);
  assert.deepEqual(rules[1].appliesTo, rules[0].appliesTo);
  assert.deepEqual(rules[2].appliesTo, ["一锅烟火"]);
  assert.equal(rules[2].originalStall, "铁锅炖");
  assert.ok(ai.calls[0].prompt.includes("至少两道炖菜"));
});

test("local hard-rule errors cannot be overruled by an AI pass", async (t) => {
  const store = setup(t);
  const ai = mockAi({ planner: (request) => { const data = directWeeklyResponse(request, { includeReviews: false }); data.menus.S0[0] = -1; return data; } });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.ok(plan.validation.errors > 0);
  assert.equal(plan.workflow.status, "blocked");
  assert.equal(plan.workflow.inspector.verdict, "revise");
  assert.ok(plan.workflow.inspector.findings.some((finding) => /硬规则/.test(finding.text)));
});

test("inspector cannot cite a dish missing from the actual six-week menu", async (t) => {
  const store = setup(t);
  const ai = mockAi({ inspector: () => ({ ...inspector(), findings: [{ severity: "warning", text: "无效引用", actionIds: [], ruleIds: [], dishIds: ["0-0"] }] }) });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /检验菜品引用/);
  assert.equal(store.all("menuRuns")[0].failedStage, "inspecting");
  assert.equal(store.all("plans").length, 0);
});

test("manual-upload source rules keep AI slots empty and flag review", async (t) => {
  const store = setup(t, [...dishes, { ...dishes[0], id: "manual-dish", stall: "老广老北" }]);
  store.put("meta", "rules", [...store.get("meta", "rules"), { stall: "老广老北", text: "该部分菜单需预留人工上传入口，格式为六周菜单当中示例样式" }]);
  const plan = await runMenuWorkflow({ store, ai: mockAi(), input: options, settings });
  assert.equal(plan.entries.filter((entry) => entry.stall === "老广老北").length, 120);
  assert.ok(plan.entries.filter((entry) => entry.stall === "老广老北").every((entry) => entry.dishId === ""));
  assert.equal(plan.workflow.requiresHumanApproval, true);
  assert.ok(plan.validation.issues.some((issue) => issue.stall === "老广老北"));
});

test("manual edits invalidate stored inspection and reinspect actual edited menu without replanning", async (t) => {
  const store = setup(t);
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  const changed = structuredClone(plan);
  changed.entries[0].dishId = "0-0";
  const restored = attachMenuWorkflow(store, checkMenu(dishes, changed), { ...plan.workflow, status: "approved", inspector: { verdict: "pass", summary: "伪造" } }, settings);
  assert.equal(restored.workflow.status, "stale");
  assert.notEqual(restored.workflow.inspector.summary, "伪造");
  const result = await reinspectMenuWorkflow({ store, ai, input: { ...restored, workflow: { runId: plan.workflow.runId } }, settings });
  assert.equal(result.workflow.stale, false);
  assert.equal(ai.calls.filter((call) => call.role === "planner").length, 6);
  assert.equal(ai.calls.filter((call) => call.role === "inspector").length, 2);
  assert.match(ai.calls.at(-1).prompt, /本地文件规则/);
  assert.match(ai.calls.at(-1).prompt, /同餐菜品不重复/);
  assert.equal(result.workflow.actionImpacts[0].status, "not_applied");
  assert.equal(result.workflow.status, "blocked");
  assert.equal(store.get("menuRuns", result.workflow.runId).parentRunId, plan.workflow.runId);
});

test("approval, source and planning changes invalidate runs while raw feedback and reply prompts do not", async (t) => {
  const store = setup(t);
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  store.put("feedback", "F-2", { id: "F-2", content: "新反馈不能直接影响菜单" });
  assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, false);
  assert.equal(attachMenuWorkflow(store, plan, plan.workflow, { ...settings, version: 2, feedbackPrompt: "更新反馈回复风格" }).workflow.stale, false);
  const newSettings = { ...settings, version: 2, plannerPrompt: "运营修改了排菜要求" };
  assert.equal(attachMenuWorkflow(store, plan, plan.workflow, newSettings).workflow.stale, true);
  await assert.rejects(reinspectMenuWorkflow({ store, ai, input: plan, settings: newSettings }), /重新生成/);
  const oldRules = store.get("meta", "rules");
  store.put("meta", "rules", [{ ...oldRules[0], text: "更新源规则" }]);
  assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, true);
  await assert.rejects(reinspectMenuWorkflow({ store, ai, input: plan, settings }), /重新生成/);
  store.put("meta", "rules", oldRules);
  store.put("actions", action.id, { ...action, revision: 3, menuInstruction: "新的已批准要求" });
  assert.match(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.staleReasons.join(" "), /行动/);
  await assert.rejects(reinspectMenuWorkflow({ store, ai, input: plan, settings }), /重新生成/);
  assert.equal(approvedMenuActions(store)[0].revision, 3);
});

test("mid-generation action changes stop before another week is generated", async (t) => {
  const store = setup(t);
  const ai = mockAi({ planner: (request) => { store.put("actions", action.id, { ...action, enabled: false }); return planner(request); } });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /生成期间.*变化/);
  assert.equal(ai.calls.length, 1);
  assert.equal(store.all("menuRuns")[0].stage, "failed");
  assert.equal(store.all("plans").length, 0);
});

test("changes to rule-source metadata, fixed staples or fixed dishes stop the generation snapshot", async (t) => {
  const changes = [
    ["menu-rule-source", { file: "changed.xlsx", sha256: "changed-source-hash" }],
    ["menu-fixed-staples", [{ stall: "档口甲", meal: "午餐", text: "主食已变更" }]],
    ["menu-fixed-dishes", [{ stall: "档口甲", meal: "午餐", name: "新固定菜品", price: 4, unit: "100g" }]],
  ];
  for (const [key, value] of changes) await t.test(key, async (t) => {
    const store = setup(t);
    const ai = mockAi({ planner: (request) => { store.put("meta", key, value); return planner(request); } });
    await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /生成期间.*变化/);
    assert.equal(ai.calls.length, 1);
    const run = store.all("menuRuns")[0];
    assert.equal(run.stage, "failed");
    assert.equal(run.failedStage, "planning");
    assert.equal(run.workflow, undefined);
    assert.equal(store.all("plans").length, 0);
  });
});

test("restored inspection rechecks fixed output against trusted run sources without rewriting choices", async (t) => {
  const fixed = ["骨汤麻辣烫", "老式麻辣烫"].map((name, index) => ({ ...dishes[0], id: `fixed-${index}`, name, stall: "宽窄巷子", price: 4, unit: "100g" }));
  const old = { ...dishes[0], id: "old-breakfast", name: "油条", stall: "宽窄巷子", price: 2, unit: "份" };
  const store = setup(t, [...dishes, ...fixed, old]);
  const fixedDishes = options.meals.flatMap((meal) => fixed.map(({ name, price, unit }) => ({ stall: "宽窄巷子", meal, name, price, unit })));
  store.put("meta", "menu-fixed-dishes", fixedDishes);
  store.put("meta", "rules", [...store.get("meta", "rules"), { stall: "宽窄巷子", text: "此档口固定出品，保持不变，复制样例即可" }]);
  const ai = mockAi({ planner: (request) => {
    const result = planner(request);
    for (const item of request.input.layout.filter((layout) => layout.fixed)) {
      result.menus[item.key] = result.menus[item.key].map((_, index) => item.fixedDishIndexes[index % item.fixedDishIndexes.length]);
    }
    return result;
  } });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.equal(plan.validation.issues.filter((issue) => issue.code === "FIXED_SOURCE").length, 0);
  const changed = structuredClone(plan);
  changed.entries.find((entry) => entry.stall === "宽窄巷子").dishId = old.id;
  changed.fixedDishes = options.meals.map((meal) => ({ ...old, meal }));
  changed.validation = { ...changed.validation, errors: 0, issues: [] };
  const before = structuredClone(changed.entries);
  const restored = attachMenuWorkflow(store, changed, plan.workflow, settings);
  assert.deepEqual(restored.entries, before, "inspection must report the wrong dish without silently substituting a source dish");
  assert.deepEqual(restored.fixedDishes, fixedDishes);
  assert.equal(restored.validation.issues.filter((issue) => issue.code === "FIXED_SOURCE").length, 1);
  assert.match(restored.validation.issues.find((issue) => issue.code === "FIXED_SOURCE").text, /骨汤麻辣烫/);
  assert.equal(restored.workflow.stale, true);
  assert.equal(store.get("dishes", old.id).name, "油条");
});

test("removing the direct-mode flag or forging clean validation cannot bypass manual-source requirements", async (t) => {
  const manualDish = { ...dishes[0], id: "manual-source-dish", name: "人工菜品", stall: "老广老北" };
  const store = setup(t, [...dishes, manualDish]);
  store.put("meta", "rules", [...store.get("meta", "rules"), { stall: "老广老北", text: "该部分菜单需预留人工上传入口，格式为六周菜单当中示例样式" }]);
  const plan = await runMenuWorkflow({ store, ai: mockAi(), input: options, settings });
  for (const generationMode of [undefined, "strategy"]) {
    const client = structuredClone(plan);
    if (generationMode === undefined) delete client.generationMode;
    else client.generationMode = generationMode;
    client.demo = true;
    for (const entry of client.entries.filter((entry) => entry.stall === "老广老北")) entry.dishId = manualDish.id;
    client.validation = { errors: 0, warnings: 0, issues: [], changeRate: 0, labelCoverage: 100 };
    const checked = checkMenu(store.all("dishes"), client, plan);
    assert.ok(!checked.validation.issues.some((issue) => issue.code === "MANUAL_SOURCE_REQUIRED"), "initial client-mode check demonstrates the regression setup");
    const changeRate = checked.validation.changeRate;
    assert.equal(typeof changeRate, "number");
    const cleaned = { ...checked, validation: { ...checked.validation, errors: 0, warnings: 0, issues: [] } };
    const before = structuredClone(cleaned.entries);
    const restored = attachMenuWorkflow(store, cleaned, plan.workflow, settings);
    assert.equal(restored.generationMode, "gpt-direct");
    assert.equal(restored.demo, false);
    assert.ok(restored.validation.issues.some((issue) => issue.code === "MANUAL_SOURCE_REQUIRED" && issue.level === "error" && issue.stall === "老广老北"));
    assert.ok(restored.validation.issues.some((issue) => issue.code === "MANUAL_REQUIRED"));
    assert.ok(restored.validation.errors > 0);
    assert.equal(restored.validation.changeRate, changeRate);
    assert.deepEqual(restored.entries, before, "report manual-source violation without changing selected dishes");
    assert.equal(restored.workflow.stale, true);
  }
});

test("changes during inspection reject an outdated result before returning", async (t) => {
  const store = setup(t);
  const ai = mockAi({ inspector: () => { store.put("actions", action.id, { ...action, enabled: false }); return inspector(); } });
  await assert.rejects(runMenuWorkflow({ store, ai, input: options, settings }), /生成期间.*变化/);
  const run = store.all("menuRuns")[0];
  assert.equal(run.stage, "failed");
  assert.equal(run.failedStage, "inspecting");
  assert.equal(run.workflow, undefined);
  assert.equal(store.all("plans").length, 0);
});

test("source-file bytes invalidate an existing draft and persist through independent reinspection", async (t) => {
  const store = setup(t);
  const root = await mkdtemp(join(tmpdir(), "menu-workflow-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ruleSourcePath = join(root, "source.xlsx");
  await writeFile(ruleSourcePath, "isolated original source bytes");
  const sha256 = createHash("sha256").update(await readFile(ruleSourcePath)).digest("hex");
  store.put("meta", "menu-rule-source", { file: "source.xlsx", sha256 });
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings, ruleSourcePath });
  assert.equal(attachMenuWorkflow(store, plan, plan.workflow, settings).workflow.stale, false);
  const inspected = await reinspectMenuWorkflow({ store, ai, input: plan, settings });
  assert.equal(store.get("menuRuns", inspected.workflow.runId).ruleSourcePath, ruleSourcePath);
  await writeFile(ruleSourcePath, "isolated changed source bytes");
  const stale = attachMenuWorkflow(store, inspected, inspected.workflow, settings);
  assert.equal(stale.workflow.stale, true);
  assert.match(stale.workflow.staleReasons.join(" "), /本地.*规则文件/);
  await assert.rejects(reinspectMenuWorkflow({ store, ai, input: inspected, settings }), /本地.*规则.*变化/);
});
