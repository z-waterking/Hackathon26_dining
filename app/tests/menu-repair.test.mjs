import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { importStallCatalog } from "../server/stall-catalog-import.mjs";
import { readStallCatalog } from "../server/stored-stall-catalog.mjs";
import { runMenuWorkflow } from "../server/menu-workflow.mjs";
import { repairMenuConflict } from "../server/menu-repair.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const options = { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], count: 2, seed: 1 };
const settings = { version: 1, plannerPrompt: "服务端排菜测试配置", inspectorPrompt: "服务端检验测试配置", operatorNotes: "" };
const inspect = () => ({ verdict: "pass", summary: "检查全部六周，保留本地校验错误", findings: [] });
const businessState = store => Object.fromEntries(["dishes", "plans", "menuRuns", "actions", "settings", "meta"].map(collection => [collection, store.all(collection)]));
const inGroup = (entry, issue) => entry.stall === issue.stall && entry.date === issue.date && entry.meal === issue.meal;
const selector = issue => Object.fromEntries(["code", "stall", "date", "meal", "text"].map(key => [key, issue[key]]));
const countTarget = (plan, issue) => plan.validation.issues.filter(item => item.code === issue.code && inGroup(item, issue)).length;
const candidateId = candidate => candidate.id || candidate.dishId;
function mockAi(reply) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(structuredClone(request));
    return { data: await reply(request), model: "test-only-no-network", usage: { input_tokens: 10, output_tokens: 5 }, requestId: `test-${calls.length}` };
  } };
}
async function fixture(t, { stall = "档口甲", duplicates = [1], customPlanner, mutateDishes, rules = [] } = {}) {
  const dishes = [stall, "档口乙"].flatMap((name, group) => Array.from({ length: 40 }, (_, index) => ({
    id: `D${group}-${index}`, name: `${name}菜${index}`, stall: name, price: 12, unit: "份", priceText: "12/份", active: true, category: "",
    spicy: "不辣", vegetarian: "素食", mainIngredient: `原料${index}`, method: "炒", labelSource: "厨房核验", calories: null, allergens: "", sources: [],
  })));
  mutateDishes?.(dishes);
  const store = createStore(":memory:", () => ({ dishes, feedback: [], inventory: [], recipes: [], rules, report: {} }));
  t.after(() => store.close());
  store.put("settings", "current", settings);
  const records = dishes.map((item, index) => ({ stall: item.stall, name: item.name, price: item.price, unit: item.unit, priceText: item.priceText, category: item.category,
    sources: [{ file: "第一轮+第二轮纯菜单库.xlsx", sheet: "内存测试来源", row: index + 1, nameCell: `B${index + 1}`, priceCell: `C${index + 1}` }] }));
  importStallCatalog(store, { version: "stall-catalog-v1", source: { file: "第一轮+第二轮纯菜单库.xlsx", sha256: "b".repeat(64) },
    coveredStalls: [stall, "档口乙"], records, warnings: [], rejected: [], stats: { sourceRows: records.length, uniqueDishes: records.length, duplicates: 0, rejected: 0 } });
  const ai = mockAi(request => {
    if (request.role === "inspector") return inspect();
    const response = directWeeklyResponse(request);
    if (request.input.targetStall === stall && duplicates.includes(request.input.week)) response.menus.S0[1] = response.menus.S0[0];
    return customPlanner ? customPlanner(request, response) : response;
  });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  const issue = selector(plan.validation.issues.find(item => item.code === "DUPLICATE" && item.stall === stall) || plan.validation.issues[0]);
  return { store, plan, issue, dishes, stall };
}
function validReply(plan, issue, request) {
  assert.equal(request.role, "menu_repair");
  const candidates = request.input.candidates;
  const selected = new Set();
  const target = plan.entries.filter(entry => inGroup(entry, issue));
  const selections = request.input.slots.map((slot, index) => {
    const indexes = slot.allowedIndexes;
    const currentId = target[index].dishId;
    const candidate = indexes.map(localIndex => candidates.find(item => item.localIndex === localIndex))
      .find(item => candidateId(item) === currentId && !selected.has(item.name)) || indexes.map(localIndex => candidates.find(item => item.localIndex === localIndex))
      .find(item => !selected.has(item.name));
    assert.ok(candidate, "fixture must have an unambiguous legal replacement");
    selected.add(candidate.name);
    return candidate.localIndex;
  });
  return { summary: "更换本餐重复项，保留其他日期与档口", selections };
}
async function notRepaired(operation) {
  try {
    const result = await operation();
    assert.equal(result.repair.status, "unchanged");
    assert.equal(result.repair.changedEntries, 0);
    return result;
  } catch (error) {
    // Assertion errors are test failures, not expected service rejection.
    if (error.code === "ERR_ASSERTION") throw error;
    return null;
  }
}

test("single conflict repair makes one model call and changes only the selected service group", async t => {
  const { store, plan, issue } = await fixture(t);
  const original = structuredClone(plan);
  const before = businessState(store);
  const ai = mockAi(request => {
    const pool = readStallCatalog(store).groups.find(group => group.stall === issue.stall).candidateIds;
    assert.ok(request.input.candidates.every(item => pool.includes(candidateId(item))));
    assert.equal(request.input.slots.length, 2);
    assert.ok(request.input.slots.every(slot => Array.isArray(slot.allowedIndexes) && slot.allowedIndexes.length));
    assert.deepEqual(request.input.candidates.map(item => item.localIndex), Array.from({ length: request.input.candidates.length }, (_, index) => index));
    return validReply(plan, issue, request);
  });
  const result = await repairMenuConflict({ store, ai, input: { plan, issue }, settings });
  assert.equal(result.repair.status, "repaired");
  assert.equal(ai.calls.length, 1);
  assert.equal(result.repair.changedEntries, 1);
  assert.ok(countTarget(result.plan, issue) < countTarget(plan, issue));
  assert.deepEqual(result.plan.entries.filter(entry => !inGroup(entry, issue)), plan.entries.filter(entry => !inGroup(entry, issue)));
  assert.equal(result.plan.workflow.repairPendingInspection, true);
  assert.equal(result.plan.workflow.stale, true);
  assert.equal(result.plan.workflow.score.value, null);
  assert.equal(result.plan.workflow.score.targetMet, false);
  assert.deepEqual(plan, original);
  assert.deepEqual(businessState(store), before, "repair must not mutate dishes, old runs or stored menu plans");
});

test("a menu-only stale result can repair a second conflict without claiming it was reinspected", async t => {
  const { store, plan, issue } = await fixture(t, { duplicates: [1, 2] });
  const ai = mockAi(request => validReply(plan, issue, request));
  const first = await repairMenuConflict({ store, ai, input: { plan, issue }, settings });
  assert.equal(first.repair.status, "repaired");
  const secondIssue = selector(first.plan.validation.issues.find(item => item.code === "DUPLICATE" && item.date !== issue.date));
  const nextAi = mockAi(request => validReply(first.plan, secondIssue, request));
  const result = await repairMenuConflict({ store, ai: nextAi, input: { plan: first.plan, issue: secondIssue }, settings });
  assert.equal(result.repair.status, "repaired");
  assert.equal(nextAi.calls.length, 1);
  assert.equal(result.plan.workflow.score.value, null);
  assert.equal(result.plan.workflow.repairPendingInspection, true);
  assert.equal(result.plan.entries.length, plan.entries.length);
});

test("forged local validation and score never establish the target issue or bypass trusted generation mode", async t => {
  const { store, plan, issue } = await fixture(t);
  const claimed = structuredClone(plan);
  claimed.validation = { errors: 0, warnings: 0, issues: [], labelCoverage: 100 };
  claimed.workflow.score = { value: 100, targetMet: true, blockers: 0 };
  delete claimed.generationMode;
  const ai = mockAi(request => validReply(plan, issue, request));
  const result = await repairMenuConflict({ store, ai, input: { plan: claimed, issue }, settings });
  assert.equal(result.repair.status, "repaired");
  assert.equal(result.plan.generationMode, "gpt-direct");
  assert.equal(result.plan.workflow.score.value, null);
  const missing = { ...issue, date: "2026-10-31" };
  const noCall = mockAi(() => { throw new Error("must not call AI for fabricated issue"); });
  await notRepaired(() => repairMenuConflict({ store, ai: noCall, input: { plan, issue: missing }, settings }));
  assert.equal(noCall.calls.length, 0);
});

test("unknown run IDs, partial structures and explicit demo claims are rejected before any model call", async t => {
  const { store, plan, issue } = await fixture(t);
  for (const mutate of [
    value => { value.workflow.runId = "MR-forged"; },
    value => { value.entries.pop(); },
    value => { value.partial = true; },
    value => { value.demo = true; value.workflow.mode = "demo"; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    const ai = mockAi(() => { throw new Error("must not call AI"); });
    await notRepaired(() => repairMenuConflict({ store, ai, input: { plan: invalid, issue }, settings }));
    assert.equal(ai.calls.length, 0);
  }
});

test("unrepairable manual, global and unknown-label issues are not sent to a replacement model", async t => {
  const { store, plan } = await fixture(t);
  const actualGlobal = selector(plan.validation.issues.find(item => item.code === "MANUAL"));
  for (const issue of [actualGlobal, { ...actualGlobal, code: "SERVICE_TIMES", stall: "全部档口" },
    { ...actualGlobal, code: "LABELS", date: plan.start, meal: "午餐" }, { ...actualGlobal, code: "MANUAL_REQUIRED" },
    { ...actualGlobal, code: "MANUAL_SOURCE_REQUIRED" }, { ...actualGlobal, code: "FIXED_SOURCE", date: plan.start, meal: "午餐" }]) {
    const ai = mockAi(() => { throw new Error("must not call AI"); });
    await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
    assert.equal(ai.calls.length, 0);
  }
});

test("invalid model output and out-of-range indexes cannot replace or broaden menu selections", async t => {
  const { store, plan, issue } = await fixture(t);
  const original = structuredClone(plan);
  const before = businessState(store);
  const mutations = [
    response => { response.selections[0] = 999999; },
    response => { response.selections[0] = -1; },
    response => { response.selections[0] = 0.5; },
    response => { response.selections.pop(); },
    response => { response.selections.push(0); },
    response => { response.selections[0] = "D1-0"; },
    response => { response.otherStall = "档口乙"; },
  ];
  for (const mutate of mutations) {
    const ai = mockAi(request => { const response = validReply(plan, issue, request); mutate(response); return response; });
    const result = await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
    assert.equal(ai.calls.length, 1);
    if (result) assert.deepEqual(result.plan.entries, plan.entries);
    assert.deepEqual(plan, original);
    assert.deepEqual(businessState(store), before);
  }
});

test("unchanged selection or a differently named duplicate does not count as fixing the issue", async t => {
  const { store, plan, issue } = await fixture(t);
  for (const candidateOffset of [0, 1]) {
    const ai = mockAi(request => ({ summary: "不能把冲突挪给另一道菜", selections: request.input.slots.map(() => request.input.candidates[candidateOffset].localIndex) }));
    const result = await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
    assert.equal(ai.calls.length, 1);
    if (result) assert.deepEqual(result.plan.entries, plan.entries);
  }
});

test("fixing lunch duplication may not introduce a later same-day noodle repeat", async t => {
  const { store, plan, issue } = await fixture(t, { stall: "南粉北面" });
  const dinner = plan.entries.find(entry => entry.stall === issue.stall && entry.date === issue.date && entry.meal === "晚餐");
  const ai = mockAi(request => {
    const response = validReply(plan, issue, request);
    const later = request.input.candidates.find(item => candidateId(item) === dinner.dishId);
    if (!later) return { ...response, selections: response.selections.map(() => -1) };
    response.selections[1] = later.localIndex;
    return response;
  });
  const before = businessState(store);
  const result = await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
  assert.equal(ai.calls.length, 1);
  if (result) assert.deepEqual(result.plan.entries, plan.entries);
  assert.deepEqual(businessState(store), before);
});

test("a known vegetarian error cannot be hidden by substituting a candidate with unknown vegetarian status", async t => {
  const { store, plan } = await fixture(t, { stall: "南粉北面", duplicates: [], mutateDishes: dishes => {
    for (const item of dishes.filter(item => item.stall === "南粉北面")) item.vegetarian = "非素食";
    dishes.find(item => item.id === "D0-39").vegetarian = "未知";
  }, customPlanner: (request, response) => {
    if (request.input.targetStall === "南粉北面") response.menus.S0 = response.menus.S0.map((_, index) => index % 16);
    return response;
  } });
  const issue = selector(plan.validation.issues.find(item => item.code === "VEGETARIAN" && item.level === "error"));
  const before = businessState(store);
  const ai = mockAi(request => {
    const response = validReply(plan, issue, request);
    const unknown = request.input.candidates.find(item => item.id === "D0-39");
    response.selections[1] = unknown?.localIndex ?? -1;
    return response;
  });
  const result = await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
  assert.ok(ai.calls.length <= 1);
  if (result) assert.deepEqual(result.plan.entries, plan.entries);
  assert.deepEqual(businessState(store), before);
});

test("repairing a source stall cannot break the same-meal menu already shared by 五味坊", async t => {
  const sourceNames = ["共享八元甲", "共享八元乙", "替换八元丙", "替换八元丁", "六元甲", "六元乙", "六元丙", "共享五元", "共享四元"];
  const prices = [8, 8, 8, 8, 6, 6, 6, 5, 4];
  const records = sourceNames.map((name, index) => ({ id: `X${index}`, name, stall: "寻味列车", price: prices[index], unit: "份", priceText: `${prices[index]}/份`, active: true, category: "",
    spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", labelSource: "", calories: null, allergens: "", sources: [] }));
  records.push(...[0, 1, 7, 8].map((sourceIndex, index) => ({ ...records[sourceIndex], id: `W${index}`, stall: "五味坊" })));
  const store = createStore(":memory:", () => ({ dishes: records, feedback: [], inventory: [], recipes: [], rules: [], report: {} }));
  t.after(() => store.close());
  store.put("settings", "current", settings);
  importStallCatalog(store, { version: "stall-catalog-v1", source: { file: "第一轮+第二轮纯菜单库.xlsx", sha256: "c".repeat(64) }, coveredStalls: ["寻味列车", "五味坊"],
    records: records.map((item, index) => ({ ...item, sources: [{ file: "第一轮+第二轮纯菜单库.xlsx", sheet: "共享测试", row: index + 1, nameCell: `B${index + 1}`, priceCell: `C${index + 1}` }] })),
    warnings: [], rejected: [], stats: { sourceRows: records.length, uniqueDishes: records.length, duplicates: 0, rejected: 0 } });
  const generator = mockAi(request => {
    if (request.role === "inspector") return inspect();
    const response = directWeeklyResponse(request);
    const indexes = request.input.targetStall === "寻味列车" ? [0, 0, 1, 4, 5, 6, 7, 8] : [0, 1, 2, 3];
    response.menus.S0 = response.menus.S0.map((_, index) => indexes[index % indexes.length]);
    return response;
  });
  const plan = await runMenuWorkflow({ store, ai: generator, input: options, settings });
  const issue = selector(plan.validation.issues.find(item => item.code === "DUPLICATE" && item.stall === "寻味列车"));
  assert.ok(!plan.validation.issues.some(item => item.code === "SHARED_MENU" && item.date === issue.date && item.meal === issue.meal));
  const ai = mockAi(request => {
    assert.ok(request.input.otherStallsInMeal.some(entry => entry.stall === "五味坊"));
    return { summary: "该提案虽然解决源档重复，但删掉五味坊引用的共享八元乙，必须拒绝", selections: ["X0", "X2", "X3", "X4", "X5", "X6", "X7", "X8"]
      .map(id => request.input.candidates.find(item => item.id === id).localIndex) };
  });
  const before = businessState(store);
  const result = await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
  assert.equal(ai.calls.length, 1);
  if (result) assert.deepEqual(result.plan.entries, plan.entries);
  assert.deepEqual(businessState(store), before);
});

test("external dish, source, settings, action or catalog changes block repair before calling AI", async t => {
  const changes = [
    store => { const item = store.all("dishes")[0]; store.put("dishes", item.id, { ...item, spicy: "辣" }); },
    store => store.put("meta", "rules", [{ stall: "档口甲", text: "规则已变更" }]),
    store => store.put("settings", "current", { ...settings, operatorNotes: "新要求" }),
    store => store.put("actions", "A-new", { id: "A-new", title: "新批准调整", status: "approved", enabled: true, feedbackIds: ["F-new"], targetStall: "档口甲", menuInstruction: "不同菜品选择", revision: 1 }),
    store => { const catalog = store.get("meta", "preprocessed-stall-catalog"); store.put("meta", "preprocessed-stall-catalog", { ...catalog, importVersion: "changed" }); },
  ];
  for (const change of changes) {
    const { store, plan, issue } = await fixture(t);
    change(store);
    const ai = mockAi(() => { throw new Error("external stale must not incur a paid request"); });
    await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
    assert.equal(ai.calls.length, 0);
  }
});

test("mid-request catalog changes reject the now-stale suggestion and do not mutate saved menus", async t => {
  const { store, plan, issue } = await fixture(t);
  const runs = store.all("menuRuns");
  const original = structuredClone(plan);
  const ai = mockAi(request => {
    const response = validReply(plan, issue, request);
    const item = store.all("dishes")[0];
    store.put("dishes", item.id, { ...item, active: false });
    return response;
  });
  await notRepaired(() => repairMenuConflict({ store, ai, input: { plan, issue }, settings }));
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(plan, original);
  assert.deepEqual(store.all("menuRuns"), runs);
  assert.equal(store.all("plans").length, 0);
});

test("model transport failures propagate without an automatic paid retry or changing the original plan", async t => {
  const { store, plan, issue } = await fixture(t);
  const before = businessState(store);
  const ai = mockAi(() => { throw Object.assign(new Error("test repair transport timeout"), { code: "ETIMEDOUT" }); });
  await assert.rejects(repairMenuConflict({ store, ai, input: { plan, issue }, settings }), /timeout/);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(businessState(store), before);
});

test("repair HTTP endpoint shares the menu lock and never calls an inspector or persists a new menu", { timeout: 10000 }, async t => {
  const { store, plan, issue } = await fixture(t);
  const before = businessState(store);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  t.after(() => gate.resolve());
  const ai = mockAi(async request => {
    assert.equal(request.role, "menu_repair");
    entered.resolve();
    await gate.promise;
    return validReply(plan, issue, request);
  });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const headers = { "Content-Type": "application/json" };
  const repairing = app.inject({ method: "POST", url: "/api/plans/repair", headers, payload: { plan, issue } }).then(response => response);
  await entered.promise;
  for (const [url, payload] of [["/api/plans/repair", { plan, issue }], ["/api/plans/generate", { ...options, useAi: true }], ["/api/plans/inspect", plan], ["/api/plans/resume", { runId: plan.workflow.runId }]]) {
    const locked = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(locked.statusCode, 400);
    assert.match(locked.json().error, /正在进行|等待当前请求/);
  }
  gate.resolve();
  const response = await repairing;
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.repair.status, "repaired");
  assert.equal(result.plan.workflow.repairPendingInspection, true);
  assert.equal(result.plan.workflow.score.value, null);
  assert.deepEqual(ai.calls.map(call => call.role), ["menu_repair"]);
  assert.deepEqual(businessState(store), before);
  assert.ok(!response.body.includes(settings.plannerPrompt));
  const checked = await app.inject({ method: "POST", url: "/api/plans/check", headers, payload: result.plan });
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.json().workflow.repairPendingInspection, true);
  assert.equal(checked.json().workflow.score.value, null);
});

test("repair HTTP failures do not leak rejected model output and release the business lock", async t => {
  const { store, plan, issue } = await fixture(t);
  const before = businessState(store);
  let attempts = 0;
  const ai = mockAi(request => {
    if (++attempts === 1) return { summary: "SERVER_ONLY_REJECTED_OUTPUT", selections: [-1], prompt: "SERVER_ONLY_HIDDEN_PROMPT", apiKey: "SERVER_ONLY_SECRET" };
    if (attempts === 2) throw Object.assign(new Error("Azure AI 请求超时，请稍后重试"), { statusCode: 502 });
    return validReply(plan, issue, request);
  });
  const app = createApp(store, undefined, { ai });
  t.after(() => app.close());
  const request = { method: "POST", url: "/api/plans/repair", headers: { "Content-Type": "application/json" }, payload: { plan, issue } };
  const invalid = await app.inject(request);
  assert.equal(invalid.statusCode, 200);
  assert.equal(invalid.json().repair.status, "unchanged");
  assert.ok(!invalid.body.includes("SERVER_ONLY"));
  const failed = await app.inject(request);
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error, /请求超时/);
  const recovered = await app.inject(request);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().repair.status, "repaired");
  assert.deepEqual(ai.calls.map(call => call.role), ["menu_repair", "menu_repair", "menu_repair"]);
  assert.deepEqual(businessState(store), before);
});
