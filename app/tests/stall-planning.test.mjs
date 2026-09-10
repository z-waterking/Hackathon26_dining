import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CATALOG_FILE, parseStallCatalog, loadStallCatalog, prepareStallCatalog } from "../server/stall-catalog.mjs";
import { STALL_MENU_VERSION, directContext, materializeWeek } from "../server/direct-menu-planner.mjs";
import { stallRequest, materializeStall, stallPlanningOrder, ruleOnlyStall, stallQuality, mergeStallWeek } from "../server/stall-menu-planner.mjs";
import { attachMenuWorkflow, runMenuWorkflow, resumeMenuWorkflow } from "../server/menu-workflow.mjs";
import { createApp } from "../server/app.mjs";
import { createStore } from "../server/store.mjs";
import { publicData } from "../server/public-data.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";

const source = { file: CATALOG_FILE, sha256: "test-source-sha" };
const options = { scope: "all", start: "2026-09-14", count: 2, meals: ["午餐", "晚餐"], seed: 2 };
const settings = { version: 1, plannerPrompt: "内存测试排菜配置", inspectorPrompt: "内存测试检验配置", operatorNotes: "" };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const dish = (id, stall, name, price = 12, unit = "份") => ({ id, stall, name, price, unit, active: true,
  spicy: "不辣", vegetarian: "非素食", mainIngredient: `原料-${id}`, method: "炒", labelSource: "厨房核验" });
function cellPair(book, sheet, nameCell, priceCell, name, price) {
  const tab = book.getWorksheet(sheet);
  tab.getCell(nameCell).value = name;
  tab.getCell(priceCell).value = price;
}
function workbook() {
  // Entirely in memory: never exported or written over any source workbook.
  const book = new ExcelJS.Workbook();
  for (const name of ["寻味列车+五味坊", "一锅烟火", "T1-2F量味厨房", "T1-3F档口", "早餐菜单", "北京小院+南洋烟火"]) book.addWorksheet(name);
  cellPair(book, "寻味列车+五味坊", "B3", "C3", "共享菜", 8);
  cellPair(book, "一锅烟火", "B3", "C3", "炖菜", 30);
  cellPair(book, "T1-2F量味厨房", "B2", "C2", "量味热菜", 4.5);
  cellPair(book, "T1-2F量味厨房", "F2", "G2", "量味凉菜", 3);
  cellPair(book, "T1-2F量味厨房", "J2", "K2", "杂粮", 1);
  for (const [name, left, right] of [["水饺", "B", "C"], ["面条", "F", "G"], ["蒸菜", "J", "K"], ["百变菜", "N", "O"], ["广式菜", "R", "S"]])
    cellPair(book, "T1-3F档口", `${left}3`, `${right}3`, name, 12);
  cellPair(book, "早餐菜单", "B2", "C2", "包子", "2元/个");
  cellPair(book, "北京小院+南洋烟火", "A2", "B2", "共同小菜", 5);
  cellPair(book, "北京小院+南洋烟火", "E2", "F2", "小院独有", 18);
  cellPair(book, "北京小院+南洋烟火", "G2", "H2", "南洋独有", 20);
  return book;
}

test("preprocessing maps every original sheet to separate stall pools with correct source cells and units", () => {
  const book = workbook();
  cellPair(book, "T1-3F档口", "B4", "C4", "按斤水饺", "28/斤");
  cellPair(book, "早餐菜单", "E2", "F2", "自助早餐", "10元/位");
  const parsed = parseStallCatalog(book, source);
  assert.equal(parsed.coveredStalls.length, 12);
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.records.filter(record => record.name === "共享菜").map(record => record.stall), ["寻味列车", "五味坊"]);
  assert.deepEqual(parsed.records.filter(record => record.name === "共同小菜").map(record => record.stall), ["北京小院", "南洋烟火"]);
  assert.deepEqual(parsed.records.filter(record => record.name === "小院独有").map(record => record.stall), ["北京小院"]);
  assert.deepEqual(parsed.records.filter(record => record.name === "南洋独有").map(record => record.stall), ["南洋烟火"]);
  assert.equal(parsed.records.find(record => record.name === "包子").unit, "个");
  assert.equal(parsed.records.find(record => record.name === "按斤水饺").unit, "斤");
  assert.equal(parsed.records.find(record => record.name === "自助早餐").unit, "位");
  assert.deepEqual(parsed.records.filter(record => record.stall === "量味厨房").map(record => [record.unit, record.category]),
    [["100g", "热菜"], ["100g", "凉菜"], ["100g", "主食杂粮"]]);
  assert.deepEqual(parsed.records.find(record => record.name === "共享菜").sources[0], { file: CATALOG_FILE, sheet: "寻味列车+五味坊", row: 3, nameCell: "B3", priceCell: "C3" });
});

test("source duplicates merge provenance but preserve stall, price and unit distinctions", () => {
  const book = workbook();
  cellPair(book, "寻味列车+五味坊", "B4", "C4", " 共 享 菜 ", "8元/份");
  cellPair(book, "寻味列车+五味坊", "B5", "C5", "共享菜", 6);
  cellPair(book, "寻味列车+五味坊", "B6", "C6", "共享菜", "8/100克");
  const parsed = parseStallCatalog(book, source);
  const records = parsed.records.filter(record => record.stall === "寻味列车");
  assert.equal(records.length, 3);
  assert.equal(records.find(record => record.price === 8 && record.unit === "份").sources.length, 2);
  assert.ok(records.some(record => record.unit === "100g" && record.price === 8));
  assert.equal(parsed.stats.duplicates, 2, "one duplicate source maps independently to two shared stalls");
  assert.equal(parsed.stats.sourceRows, parsed.stats.uniqueDishes + parsed.stats.duplicates + parsed.stats.rejected);
});

test("malformed price/name rows are isolated without removing valid neighboring candidates", () => {
  const book = workbook();
  for (const [row, name, price] of [[4, "坏价格", "待定"], [5, "负价格", -1], [6, "", 10], [7, "长".repeat(70), 8], [8, "名称", 9]])
    cellPair(book, "一锅烟火", `B${row}`, `C${row}`, name, price);
  const parsed = parseStallCatalog(book, source);
  assert.equal(parsed.rejected.length, 5);
  assert.equal(parsed.records.filter(record => record.stall === "一锅烟火").length, 1);
  assert.ok(parsed.rejected.every(record => record.sheet === "一锅烟火" && record.reason && record.nameCell && record.priceCell));
  assert.ok(parsed.records.every(record => Number.isFinite(record.price) && record.price >= 0));
});

test("missing required source sheets fail instead of silently falling back to the old pool", () => {
  const book = workbook();
  book.removeWorksheet("早餐菜单");
  assert.throws(() => parseStallCatalog(book, source), /缺少.*早餐菜单|早餐菜单.*缺少/);
});

test("an empty required stall is a source error instead of a hidden supplement fallback", () => {
  const book = workbook();
  cellPair(book, "T1-3F档口", "B3", "C3", "", "");
  assert.throws(() => parseStallCatalog(book, source), /饺好运/);
});

test("source identities restrict active candidates without changing disabled rows or labels", () => {
  const loaded = parseStallCatalog(workbook(), source);
  const dishes = loaded.records.map((record, index) => ({ ...dish(`D${index}`, record.stall, record.name, record.price, record.unit), category: record.category }));
  const disabled = dishes.find(record => record.stall === "一锅烟火");
  disabled.active = false;
  const absent = dishes.find(record => record.stall === "南粉北面");
  const active = dishes.filter(record => record.id !== absent.id);
  const primaryExtra = dish("not-in-source", "寻味列车", "菜库中但源表没有");
  const supplement = dish("supplement", "补充档口", "单独来源菜");
  active.push(primaryExtra, supplement, { ...supplement, id: "disabled-supplement", active: false });
  const before = structuredClone(active);
  const original = structuredClone(loaded);
  const result = prepareStallCatalog(loaded, active);
  assert.deepEqual(active, before);
  assert.deepEqual(loaded, original);
  assert.ok(!result.groups.flatMap(group => group.candidateIds).includes(disabled.id));
  assert.ok(result.groups.find(group => group.stall === "一锅烟火").records.some(record => record.dishIds.includes(disabled.id) && record.candidateId === null));
  assert.ok(!result.groups.flatMap(group => group.candidateIds).includes(primaryExtra.id));
  assert.equal(result.groups.find(group => group.stall === "南粉北面").unresolved.length, 1);
  assert.equal(result.groups.find(group => group.stall === "补充档口").origin, "supplement");
  assert.deepEqual(result.groups.find(group => group.stall === "补充档口").candidateIds, [supplement.id]);
  assert.ok(result.groups.find(group => group.stall === "量味厨房").candidateIds.every(id => active.find(record => record.id === id).category !== "主食杂粮"));
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test("checked-in original workbook is read-only and retains the expected preprocessing control totals", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const path = join(root, CATALOG_FILE);
  const before = sha256(await readFile(path));
  const result = await loadStallCatalog(root);
  const after = sha256(await readFile(path));
  assert.equal(after, before);
  assert.equal(result.source.sha256, before);
  assert.equal(result.coveredStalls.length, 12);
  assert.deepEqual(result.stats, { sourceRows: 2649, uniqueDishes: 2614, duplicates: 33, rejected: 2 });
  assert.equal(result.warnings.length, 0);
  assert.ok(result.records.every(record => record.sources.length && result.coveredStalls.includes(record.stall)));
});

function snapshotFixture({ actions = [] } = {}) {
  const dishes = ["档口甲", "档口乙"].flatMap((stall, index) => Array.from({ length: 16 }, (_, number) => dish(`${index}-${number}`, stall, `${stall}菜${number}`)));
  const groups = ["档口甲", "档口乙"].map(stall => ({ stall, origin: "primary", candidateIds: dishes.filter(item => item.stall === stall).map(item => item.id), unresolved: [] }));
  return { dishes, rules: [], actions, settings, planningMode: "per-stall", stallCatalog: { source, groups, fingerprint: "test-catalog", warnings: [], stats: { uniqueDishes: 32 } }, fixedDishes: [], fixedStaples: [] };
}
function setup(t, { actions = [] } = {}) {
  const snapshots = snapshotFixture({ actions });
  const store = createStore(":memory:", () => ({ dishes: snapshots.dishes, feedback: [], rules: [], inventory: [], recipes: [], report: {} }));
  store.put("settings", "current", settings);
  store.put("meta", "preprocessed-stall-catalog", snapshots.stallCatalog);
  for (const action of actions) store.put("actions", action.id, action);
  t.after(() => store.close());
  return { store, snapshots };
}
function mockAi(planner = directWeeklyResponse, inspect = () => ({ verdict: "pass", summary: "测试独立检查完成", findings: [] })) {
  const calls = [];
  return { calls, async respond(request) {
    calls.push(structuredClone(request));
    return { data: await (request.role === "planner" ? planner(request) : inspect(request)), model: "test-only-no-network", requestId: `test-${calls.length}`, usage: { input_tokens: 10, output_tokens: 5 } };
  } };
}

async function databaseRuntime(t, ai = mockAi(), { storedCatalog = true } = {}) {
  const { store } = setup(t);
  const root = await mkdtemp(join(tmpdir(), "dining-db-catalog-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A rule workbook remains a separate, intentionally live dependency. Never
  // create the source menu workbook: all menu candidates are database records.
  const rules = new ExcelJS.Workbook();
  const sheet = rules.addWorksheet("排菜规则-数据库运行测试");
  sheet.getCell("A3").value = "档口甲";
  sheet.getCell("B3").value = "每餐使用本档已核验菜品";
  sheet.getCell("A4").value = "档口乙";
  sheet.getCell("B4").value = "每餐使用本档已核验菜品";
  await rules.xlsx.writeFile(join(root, "餐厅排菜规则+示例.xlsx"));
  const loaded = { source, coveredStalls: ["档口甲", "档口乙"], warnings: [], rejected: [],
    records: store.all("dishes").map(item => ({ stall: item.stall, name: item.name, price: item.price, unit: item.unit, sources: [{ file: CATALOG_FILE, sheet: "database-fixture", row: 3 }] })),
    stats: { sourceRows: 32, uniqueDishes: 32, duplicates: 0, rejected: 0 } };
  store.put("meta", "preprocessed-stall-catalog", storedCatalog ? { ...prepareStallCatalog(loaded, store.all("dishes")),
    storageMode: "database", importVersion: "stall-import-v1", importedAt: "2026-09-09T00:00:00Z" } : null);
  const app = createApp(store, undefined, { ai, root, menuRuleRoot: root });
  t.after(() => app.close());
  const request = (url, payload) => app.inject({ method: payload ? "POST" : "GET", url, ...(payload ? { payload } : {}) });
  return { store, root, ai, app, request };
}

test("database runtime serves candidates and generates, recovers and reinspects without the source menu workbook", async t => {
  const { store, root, ai, request } = await databaseRuntime(t);
  await assert.rejects(readFile(join(root, CATALOG_FILE)), { code: "ENOENT" });
  const storedBefore = structuredClone(store.get("meta", "preprocessed-stall-catalog"));
  const catalog = await request("/api/dishes");
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().length, 32);
  const generated = await request("/api/plans/generate", { ...options, useAi: true });
  assert.equal(generated.statusCode, 200, generated.body);
  const plan = generated.json();
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.snapshots.planningMode, "per-stall");
  assert.equal(run.snapshots.stallCatalog.storageMode, "database");
  assert.equal(run.stallBatches.length, 12);
  assert.ok(plan.entries.every(entry => store.get("dishes", entry.dishId)?.stall === entry.stall));
  assert.deepEqual(store.get("meta", "preprocessed-stall-catalog"), storedBefore, "generation never reimports or rewrites catalog metadata");
  const plannerCalls = ai.calls.filter(call => call.role === "planner").length;
  const restored = await request(`/api/menu-runs/${run.id}/result`);
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().workflow.stale, false);
  const inspected = await request("/api/plans/inspect", plan);
  assert.equal(inspected.statusCode, 200, inspected.body);
  assert.equal(ai.calls.filter(call => call.role === "planner").length, plannerCalls);
  assert.equal(inspected.json().workflow.stale, false);
  // An unrelated file appearing under the old filename does not alter the DB
  // snapshot or block reinspection: only explicit import may change candidates.
  await writeFile(join(root, CATALOG_FILE), "not a workbook; runtime must ignore this file");
  const stillCurrent = await request(`/api/menu-runs/${run.id}/result`);
  assert.equal(stillCurrent.json().workflow.stale, false);
  assert.deepEqual(store.get("meta", "preprocessed-stall-catalog"), storedBefore);
  assert.equal(store.all("plans").length, 0);
});

test("database runtime streams weeks and resumes saved stalls with no source menu file", async t => {
  let failed = false;
  const ai = mockAi(request => {
    if (!failed && request.input.week === 2 && request.input.targetStall === "档口乙") { failed = true; throw new Error("isolated network timeout"); }
    return directWeeklyResponse(request);
  });
  const { store, root, request } = await databaseRuntime(t, ai);
  const started = await request("/api/plans/generate-stream", { ...options, useAi: true });
  assert.equal(started.statusCode, 200);
  const events = started.body.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "week" && event.completedWeeks === 1));
  assert.equal(events.at(-1).type, "error");
  const prior = store.all("menuRuns").at(-1);
  assert.equal(prior.stallBatches.length, 3);
  const callsBeforeResume = ai.calls.length;
  const resumed = await request("/api/plans/resume-stream", { runId: prior.id });
  const remainingEvents = resumed.body.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(remainingEvents.at(-1).type, "completed", resumed.body);
  assert.equal(ai.calls[callsBeforeResume].input.week, 2);
  assert.equal(ai.calls[callsBeforeResume].input.targetStall, "档口乙");
  const completed = remainingEvents.at(-1).plan;
  assert.equal(store.get("menuRuns", completed.workflow.runId).stallBatches.length, 12);
  await assert.rejects(readFile(join(root, CATALOG_FILE)), { code: "ENOENT" });
  assert.equal(store.all("plans").length, 0);
});

test("formal runtime requires imported database metadata while demo keeps its explicit isolated path", async t => {
  const { store, ai, request } = await databaseRuntime(t, mockAi(), { storedCatalog: false });
  for (const meta of [null, { source, groups: [], fingerprint: "legacy-only" }]) {
    store.put("meta", "preprocessed-stall-catalog", meta);
    const result = await request("/api/plans/generate", { ...options, useAi: true });
    assert.ok(result.statusCode >= 400);
    assert.match(result.json().error, /入库|导入|import/i);
  }
  assert.equal(ai.calls.length, 0);
  const demo = await request("/api/plans/generate", { ...options, demo: true, useAi: false });
  assert.equal(demo.statusCode, 200, demo.body);
  assert.equal(demo.json().workflow.mode, "demo");
  assert.equal(ai.calls.length, 0);
});

test("database candidate changes still invalidate completed menus and block reinspection before model calls", async t => {
  const { store, ai, request } = await databaseRuntime(t);
  const generated = await request("/api/plans/generate", { ...options, useAi: true });
  assert.equal(generated.statusCode, 200, generated.body);
  const plan = generated.json();
  const selected = store.get("dishes", plan.entries[0].dishId);
  store.put("dishes", selected.id, { ...selected, active: false });
  const stale = attachMenuWorkflow(store, plan, plan.workflow, settings);
  assert.equal(stale.workflow.stale, true);
  assert.ok(stale.workflow.staleReasons.some(reason => /数据库菜单库|菜库/.test(reason)));
  const before = ai.calls.length;
  const inspected = await request("/api/plans/inspect", plan);
  assert.ok(inspected.statusCode >= 400);
  assert.match(inspected.json().error, /候选菜库|菜库.*变/);
  assert.equal(ai.calls.length, before);
});

test("database edits during generation reject the output and cannot reuse earlier stall checkpoints", async t => {
  const { store, ai, request } = await databaseRuntime(t);
  let changed = false;
  const respond = ai.respond;
  ai.respond = async input => {
    const response = await respond(input);
    if (!changed && input.role === "planner" && input.input.targetStall === "档口乙") {
      const current = store.get("dishes", "0-0");
      store.put("dishes", current.id, { ...current, active: false });
      changed = true;
    }
    return response;
  };
  const generated = await request("/api/plans/generate", { ...options, useAi: true });
  assert.ok(generated.statusCode >= 400);
  assert.match(generated.json().error, /生成期间.*菜库.*变化/);
  const prior = store.all("menuRuns").at(-1);
  assert.equal(prior.status, "failed");
  const callsBefore = ai.calls.length;
  const resumed = await request("/api/plans/resume", { runId: prior.id });
  assert.ok(resumed.statusCode >= 400);
  assert.match(resumed.json().error, /菜库已变化|菜库.*变化/);
  assert.equal(ai.calls.length, callsBefore);
  assert.equal(store.all("plans").length, 0);
});

test("each stall gets only its bounded S0 catalog and its own exact preceding weekly menus", () => {
  const snapshots = snapshotFixture();
  const context = directContext(snapshots, options);
  const first = context.layout[0];
  const second = context.layout[1];
  const firstRequest = stallRequest(snapshots, options, context, first, 1, [], []);
  const firstResult = materializeStall(directWeeklyResponse(firstRequest), firstRequest, options, 1, first);
  const secondRequest = stallRequest(snapshots, options, context, second, 1, [], [firstResult]);
  assert.deepEqual(Object.keys(secondRequest.input.dishCatalog), ["S0"]);
  assert.equal(secondRequest.input.dishCatalog.S0.length, 16);
  assert.ok(secondRequest.input.dishCatalog.S0.every(row => row[1].startsWith("档口乙")));
  assert.equal(secondRequest.input.catalogCoverage.provided, 16);
  assert.ok(secondRequest.input.selectedOtherStalls.every(entry => entry.stall === "档口甲"));
  const secondResult = materializeStall(directWeeklyResponse(secondRequest), secondRequest, options, 1, second);
  const merged = mergeStallWeek(1, [firstResult, secondResult], context, [], options);
  const next = stallRequest(snapshots, options, context, second, 2, [merged.compact], []);
  assert.deepEqual(next.input.previousWeeks, [{ week: 1, menus: { S0: secondResult.compact.menus[0].dishIndexes.map(index => context.catalogs.S1.indexOf(index)) } }]);
  assert.ok(next.input.previousWeeks[0].menus.S0.every(index => index >= 0 && index < 16));
  const invalid = directWeeklyResponse(secondRequest);
  invalid.menus.S0[0] = 16;
  assert.throws(() => materializeStall(invalid, secondRequest, options, 1, second), error => error.code === "MENU_SCHEMA_INVALID");
  assert.ok(secondResult.entries.every(entry => snapshots.dishes.find(item => item.id === entry.dishId).stall === "档口乙"));
});

test("weekly publication follows all separate stall calls and feeds accepted history into later weeks", async t => {
  const { store } = setup(t);
  const events = [];
  const ai = mockAi(request => {
    const { week, targetStall } = request.input;
    assert.equal(events.filter(event => event.type === "week").length, week - 1);
    assert.deepEqual(request.input.previousWeeks.map(prior => prior.week), Array.from({ length: week - 1 }, (_, index) => index + 1));
    assert.deepEqual(Object.keys(request.input.dishCatalog), ["S0"]);
    for (const prior of request.input.previousWeeks) {
      const stored = store.all("menuRuns").at(-1).stallBatches.find(batch => batch.week === prior.week && batch.stall === targetStall);
      assert.deepEqual(prior.menus.S0, stored.result.menus.S0);
    }
    assert.equal(request.input.selectedOtherStalls.length, targetStall === "档口甲" ? 0 : 20);
    return directWeeklyResponse(request);
  });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings, onProgress: event => events.push(structuredClone(event)) });
  assert.deepEqual(ai.calls.filter(call => call.role === "planner").map(call => [call.input.week, call.input.targetStall]), Array.from({ length: 6 }, (_, index) => [[index + 1, "档口甲"], [index + 1, "档口乙"]]).flat());
  assert.deepEqual(events.map(event => event.type), ["started", ...Array(6).fill("week"), "inspecting"]);
  assert.equal(plan.entries.length, 240);
  assert.equal(store.get("menuRuns", plan.workflow.runId).stallBatches.length, 12);
  assert.equal(store.all("plans").length, 0);
  assert.ok(events.filter(event => event.type === "week").every(event => event.plan.entries.length === event.completedWeeks * 40 && !event.plan.workflow));
});

const globalAction = { id: "A-all", title: "使用真实候选", feedbackIds: ["F1"], targetStall: "全部档口", menuInstruction: "选用真实候选并标记落实位置", priority: "medium", revision: 1, status: "approved", enabled: true };
test("all-stall approved Action merges to one review per week with actual per-stall evidence", async t => {
  const { store } = setup(t, { actions: [globalAction] });
  const ai = mockAi();
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.planner.actionReviews.length, 6);
  assert.ok(run.planner.actionReviews.every(review => review.actionId === globalAction.id && review.status === "applied" && review.occurrences.length === 2));
  assert.equal(plan.workflow.actionImpacts[0].status, "applied");
  assert.equal(plan.workflow.actionImpacts[0].occurrences.length, 12);
  const context = directContext(run.snapshots, options);
  for (const batch of run.plannerBatches) {
    const restored = materializeWeek(batch.result, run.snapshots, options, context, batch.week);
    assert.deepEqual(restored.reviews, run.planner.actionReviews.filter(review => review.week === batch.week), "resume and original aggregation must use identical evidence");
  }
});

test("single-stall requests exclude other stalls' Actions and reject foreign evidence", async t => {
  const actions = [{ ...globalAction }, { ...globalAction, id: "A-甲", targetStall: "档口甲", menuInstruction: "甲档专属调整" }, { ...globalAction, id: "A-乙", targetStall: "档口乙", menuInstruction: "乙档专属调整" }];
  const { store, snapshots } = setup(t, { actions });
  const context = directContext(snapshots, options);
  const item = context.layout[0];
  const request = stallRequest(snapshots, options, context, item, 1, [], []);
  assert.deepEqual(request.input.approvedActions.map(action => action.id), ["A-all", "A-甲"]);
  assert.ok(!JSON.stringify(request.input.approvedActions).includes("F1"), "feedback evidence stays out of the generation payload");
  const foreign = directWeeklyResponse(request);
  foreign.actionReviews[0].actionId = "A-乙";
  assert.throws(() => materializeStall(foreign, request, options, 1, item), error => error.code === "MENU_ACTION_REFERENCE");
  const crossStall = directWeeklyResponse(request);
  crossStall.actionReviews[0].evidence[0].stallIndex = 1;
  assert.throws(() => materializeStall(crossStall, request, options, 1, item), error => error.code === "MENU_SCHEMA_INVALID");
  const ai = mockAi(call => {
    const isFirst = call.input.targetStall === "档口甲";
    assert.ok(call.prompt.includes("A-all"), "all-stall approved adjustments stay in each system prompt");
    assert.ok(call.prompt.includes(isFirst ? "A-甲" : "A-乙"));
    assert.ok(call.prompt.includes(isFirst ? "甲档专属调整" : "乙档专属调整"));
    assert.ok(!call.prompt.includes(isFirst ? "A-乙" : "A-甲"), "foreign action IDs must not leak through the system prompt");
    assert.ok(!call.prompt.includes(isFirst ? "乙档专属调整" : "甲档专属调整"), "foreign adjustment text must not influence this stall");
    return directWeeklyResponse(call);
  });
  await runMenuWorkflow({ store, ai, input: options, settings });
  assert.equal(ai.calls.filter(call => call.role === "planner").length, 12);
});

test("invalid single-stall output corrects only that stall and records rejected evidence privately", async t => {
  const { store } = setup(t);
  let attempts = 0;
  const ai = mockAi(request => {
    const response = directWeeklyResponse(request);
    if (request.input.week === 1 && request.input.targetStall === "档口乙" && ++attempts === 1) response.menus.S0[0] = 9999;
    return response;
  });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.deepEqual(ai.calls.slice(0, 3).map(call => call.input.targetStall), ["档口甲", "档口乙", "档口乙"]);
  assert.equal(ai.calls[2].input.qualityCorrection.previousOutput.menus.S0[0], 9999);
  assert.deepEqual(ai.calls[1].input.selectedOtherStalls, ai.calls[2].input.selectedOtherStalls);
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.plannerAttempts.filter(attempt => attempt.status === "invalid").length, 1);
  assert.equal(run.plannerAttempts.find(attempt => attempt.status === "invalid").data.menus.S0[0], 9999);
  assert.equal(publicData(run).stallBatches, undefined);
  assert.equal(publicData(run).plannerAttempts, undefined);
  assert.equal(run.stallBatches.filter(batch => batch.week === 1 && batch.stall === "档口甲").length, 1);
});

test("a fixable local duplicate triggers bounded quality correction without hiding the first choice", async t => {
  const { store } = setup(t);
  let attempts = 0;
  const ai = mockAi(request => {
    const response = directWeeklyResponse(request);
    if (request.input.week === 1 && request.input.targetStall === "档口甲" && ++attempts === 1) response.menus.S0[1] = response.menus.S0[0];
    return response;
  });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.deepEqual(ai.calls.slice(0, 3).map(call => call.input.targetStall), ["档口甲", "档口甲", "档口乙"]);
  assert.ok(ai.calls[1].input.qualityCorrection.issues.some(issue => issue.code === "DUPLICATE"));
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.plannerAttempts[0].status, "quality_review");
  assert.equal(run.stallBatches[0].attempt, 2);
  assert.equal(run.stallBatches[0].quality.count, 0);
});

test("known spicy-price, price-group spice and main-ingredient violations enter the repair report", () => {
  const snapshots = snapshotFixture();
  snapshots.dishes = [8, 8, 8, 6, 6, 6, 5, 4].map((price, index) => ({ ...dish(`X${index}`, "寻味列车", `热菜${index}`, price),
    spicy: price === 4 ? "辣" : "不辣", mainIngredient: price === 8 ? "重复主料" : `主料${index}` }));
  snapshots.stallCatalog.groups = [{ stall: "寻味列车", candidateIds: snapshots.dishes.map(item => item.id) }];
  const context = directContext(snapshots, options);
  const item = context.layout[0];
  const request = stallRequest(snapshots, options, context, item, 1, [], []);
  const result = materializeStall(directWeeklyResponse(request), request, options, 1, item);
  const quality = stallQuality(result, request, options, 1, []);
  for (const code of ["MILD_PRICE", "GROUP_SPICE", "MAIN"]) assert.ok(quality.issues.some(issue => issue.code === code), code);
});

test("quality correction stops after three attempts and retains honest unresolved conflicts", async t => {
  const { store } = setup(t);
  const ai = mockAi(request => {
    const response = directWeeklyResponse(request);
    if (request.input.week === 1 && request.input.targetStall === "档口甲") response.menus.S0[1] = response.menus.S0[0];
    return response;
  });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  const attempts = ai.calls.filter(call => call.role === "planner" && call.input.week === 1 && call.input.targetStall === "档口甲");
  assert.equal(attempts.length, 3);
  assert.ok(plan.validation.issues.some(issue => issue.code === "DUPLICATE" && issue.level === "error"));
  assert.equal(plan.workflow.status, "blocked");
  assert.ok(plan.workflow.score.blockers > 0);
  assert.ok(plan.workflow.score.value < 100);
  const batch = store.get("menuRuns", plan.workflow.runId).stallBatches[0];
  assert.ok(batch.quality.count > 0);
  assert.equal(batch.result.menus.S0[0], batch.result.menus.S0[1], "unresolved output is not silently replaced with local dishes");
});

test("partial-stall timeout resumes after saved stalls without recalling earlier paid work", async t => {
  const { store } = setup(t);
  const failedAi = mockAi(request => {
    if (request.input.week === 2 && request.input.targetStall === "档口乙") throw Object.assign(new Error("test transport timeout"), { code: "ETIMEDOUT" });
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai: failedAi, input: options, settings }), /timeout/);
  const prior = store.all("menuRuns").at(-1);
  const before = structuredClone(prior);
  assert.equal(prior.plannerBatches.length, 1);
  assert.deepEqual(prior.stallBatches.map(batch => [batch.week, batch.stall]), [[1, "档口甲"], [1, "档口乙"], [2, "档口甲"]]);
  assert.equal(failedAi.calls.length, 4, "transport failure is not automatically retried");
  const ai = mockAi();
  const plan = await resumeMenuWorkflow({ store, ai, runId: prior.id, settings });
  assert.equal(ai.calls[0].input.week, 2);
  assert.equal(ai.calls[0].input.targetStall, "档口乙");
  assert.equal(ai.calls[0].input.previousWeeks.length, 1);
  assert.equal(ai.calls[0].input.selectedOtherStalls.length, 20);
  assert.equal(ai.calls.filter(call => call.role === "planner").length, 9);
  const child = store.get("menuRuns", plan.workflow.runId);
  assert.equal(child.parentRunId, prior.id);
  assert.equal(child.resumedWeeks, 1);
  assert.equal(child.stallBatches.length, 12);
  assert.deepEqual(child.stallBatches.slice(0, 3).map(batch => batch.result), prior.stallBatches.map(batch => batch.result));
  assert.ok(child.stallBatches.slice(0, 3).every(batch => batch.sourceRunId === prior.id && batch.format === STALL_MENU_VERSION));
  assert.ok(child.stallBatches.slice(3).every(batch => batch.sourceRunId === child.id && batch.format === STALL_MENU_VERSION));
  assert.deepEqual(child.planner.usage, { input_tokens: 90, output_tokens: 45 }, "current run counts only the nine new paid planner calls");
  assert.deepEqual(child.planner.acceptedOutputUsage, { input_tokens: 120, output_tokens: 60 });
  assert.deepEqual(child.planner.reusedUsage, { input_tokens: 30, output_tokens: 15 }, "reused totals include the partial week's saved stall");
  assert.deepEqual(store.get("menuRuns", prior.id), before);
  assert.equal(store.all("plans").length, 0);
});

test("resume rejects duplicated, skipped, reordered and incompatible stall checkpoints before model calls", async t => {
  const { store } = setup(t);
  const fail = mockAi(request => {
    if (request.input.week === 2 && request.input.targetStall === "档口乙") throw new Error("test timeout");
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai: fail, input: options, settings }));
  const prior = store.all("menuRuns").at(-1);
  const mutations = [
    run => { run.stallBatches[1] = structuredClone(run.stallBatches[0]); },
    run => { run.stallBatches = [run.stallBatches[1], run.stallBatches[0], run.stallBatches[2]]; },
    run => { run.stallBatches[2].stall = "档口乙"; },
    run => { run.stallBatches[2].week = 3; },
    run => { run.stallBatches[2].format = "invented"; },
    run => { run.stallBatches.splice(0, 1); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(prior);
    mutate(invalid);
    store.put("menuRuns", invalid.id, invalid);
    const ai = mockAi();
    await assert.rejects(resumeMenuWorkflow({ store, ai, runId: prior.id, settings }), /档口不是连续完整记录/);
    assert.equal(ai.calls.length, 0);
  }
});

test("resume rejects a corrupted partial-stall output before calling the next paid stall", async t => {
  const { store } = setup(t);
  const fail = mockAi(request => {
    if (request.input.week === 1 && request.input.targetStall === "档口乙") throw new Error("test timeout");
    return directWeeklyResponse(request);
  });
  await assert.rejects(runMenuWorkflow({ store, ai: fail, input: options, settings }));
  const prior = store.all("menuRuns").at(-1);
  prior.stallBatches[0].result.menus.S0[0] = 9999;
  store.put("menuRuns", prior.id, prior);
  const ai = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: prior.id, settings }), error => error.diagnostics?.code === "MENU_SCHEMA_INVALID");
  assert.equal(ai.calls.length, 0);
});

test("changing preprocessed source fingerprint blocks resume before another model request", async t => {
  const { store } = setup(t);
  const fail = mockAi(() => { throw new Error("test failure"); });
  await assert.rejects(runMenuWorkflow({ store, ai: fail, input: options, settings }));
  const prior = store.all("menuRuns").at(-1);
  const catalog = store.get("meta", "preprocessed-stall-catalog");
  store.put("meta", "preprocessed-stall-catalog", { ...catalog, fingerprint: "changed" });
  const ai = mockAi();
  await assert.rejects(resumeMenuWorkflow({ store, ai, runId: prior.id, settings }), /数据库候选菜库已变化/);
  assert.equal(ai.calls.length, 0);
});

test("stall quality only repairs current-week positions and preserves the previous-week history", () => {
  const snapshots = snapshotFixture();
  snapshots.dishes = Array.from({ length: 16 }, (_, index) => dish(`N${index}`, "南粉北面", `面条${index}`));
  snapshots.stallCatalog.groups = [{ stall: "南粉北面", candidateIds: snapshots.dishes.map(item => item.id) }];
  const context = directContext(snapshots, options);
  const item = context.layout[0];
  const firstRequest = stallRequest(snapshots, options, context, item, 1, [], []);
  const firstRaw = directWeeklyResponse(firstRequest);
  firstRaw.menus.S0[1] = firstRaw.menus.S0[0];
  const previous = materializeStall(firstRaw, firstRequest, options, 1, item);
  const oldEntries = structuredClone(previous.entries);
  const nextRequest = stallRequest(snapshots, options, context, item, 2, [previous.compact], []);
  const current = materializeStall(directWeeklyResponse(nextRequest), nextRequest, options, 2, item);
  const report = stallQuality(current, nextRequest, options, 2, [previous]);
  assert.equal(report.issues.filter(issue => issue.code === "DUPLICATE").length, 0);
  assert.deepEqual(previous.entries, oldEntries);
});

test("shared menus schedule source first and do not retry genuinely impossible shared slots", () => {
  const snapshots = snapshotFixture();
  snapshots.dishes = [dish("W8", "五味坊", "共享8", 8), dish("W5", "五味坊", "共享5", 5), dish("W4", "五味坊", "共享4", 4),
    dish("X8", "寻味列车", "寻味独有8", 8), dish("X6", "寻味列车", "寻味独有6", 6), dish("X5", "寻味列车", "寻味独有5", 5), dish("X4", "寻味列车", "寻味独有4", 4)];
  snapshots.stallCatalog.groups = ["五味坊", "寻味列车"].map(stall => ({ stall, candidateIds: snapshots.dishes.filter(item => item.stall === stall).map(item => item.id) }));
  const context = directContext(snapshots, options);
  assert.deepEqual(stallPlanningOrder(context).map(item => item.stall), ["寻味列车", "五味坊"]);
  const item = context.layout.find(item => item.stall === "五味坊");
  const request = stallRequest(snapshots, options, context, item, 1, [], []);
  assert.ok(request.input.sharedAllowedBySlot.every(slot => slot.indexes.length === 0));
  assert.equal(request.context.layout[0].noFeasibleSlots, true);
  assert.ok(ruleOnlyStall(request, options).menus.S0.every(index => index === -1));
  const raw = directWeeklyResponse(request);
  raw.menus.S0.fill(-1);
  const result = materializeStall(raw, request, options, 1, item);
  assert.equal(stallQuality(result, request, options, 1, []).issues.filter(issue => issue.code === "MISSING_AVAILABLE").length, 0);
});

test("fully impossible shared selections and missing fixed sources complete as honest gaps with zero planner calls", async t => {
  const data = [dish("X", "寻味列车", "源档停用菜", 8), dish("W", "五味坊", "无共享来源菜", 8), dish("F", "宽窄巷子", "非固定来源菜", 4)];
  data[0].active = false;
  const store = createStore(":memory:", () => ({ dishes: data, feedback: [], rules: [{ stall: "宽窄巷子", text: "此档口固定出品" }], inventory: [], recipes: [], report: {} }));
  t.after(() => store.close());
  store.put("settings", "current", settings);
  store.put("meta", "preprocessed-stall-catalog", { source, warnings: [], stats: { uniqueDishes: 3 }, fingerprint: "gap-fixture",
    groups: data.map(item => ({ stall: item.stall, origin: "primary", candidateIds: item.active ? [item.id] : [], unresolved: [] })) });
  const ai = mockAi(() => { throw new Error("source-constrained stalls must not call a planner"); });
  const plan = await runMenuWorkflow({ store, ai, input: options, settings });
  assert.deepEqual(ai.calls.map(call => call.role), ["inspector"]);
  assert.ok(plan.entries.every(entry => !entry.dishId));
  assert.ok(plan.validation.issues.some(issue => issue.code === "MISSING"));
  assert.ok(plan.validation.issues.some(issue => issue.code === "FIXED_SOURCE"));
  assert.equal(plan.workflow.status, "blocked");
  assert.equal(plan.workflow.score.targetMet, false);
  const run = store.get("menuRuns", plan.workflow.runId);
  assert.equal(run.stallBatches.length, 18);
  assert.ok(run.stallBatches.every(batch => batch.mode === "source-rule"));
  assert.deepEqual(run.planner.usage, { input_tokens: 0, output_tokens: 0 });
});

test("manual and fixed stalls keep source constraints without using local random menus", () => {
  const snapshots = snapshotFixture();
  snapshots.rules = [{ id: "R-manual", appliesTo: ["档口甲"], text: "该部分菜单需预留人工上传" }, { id: "R-fixed", appliesTo: ["档口乙"], text: "此档口固定出品" }];
  snapshots.fixedDishes = snapshots.dishes.filter(item => item.stall === "档口乙").slice(0, 2).map(item => ({ ...item, meal: "午餐" }));
  const context = directContext(snapshots, options);
  const manual = stallRequest(snapshots, options, context, context.layout[0], 1, [], []);
  const fixed = stallRequest(snapshots, options, context, context.layout[1], 1, [], []);
  assert.ok(ruleOnlyStall(manual, options).menus.S0.every(index => index === -1));
  assert.deepEqual([...new Set(ruleOnlyStall(fixed, options).menus.S0)], [0, 1]);
  const invalid = ruleOnlyStall(fixed, options);
  invalid.menus.S0[0] = 2;
  assert.throws(() => materializeStall(invalid, fixed, options, 1, context.layout[1]), error => error.code === "MENU_FIXED_SOURCE");
});
