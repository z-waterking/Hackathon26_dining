import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { COLLECTIONS, createRepository } from "../server/data/repository.mjs";
import { createSqliteAdapter } from "../server/data/sqlite-adapter.mjs";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { createQueryService } from "../server/data/query-service.mjs";
import { getSettings } from "../server/settings.mjs";
import { runMenuWorkflow } from "../server/menu-workflow.mjs";
import { directWeeklyResponse } from "./fixtures/direct-menu.mjs";
const seed = () => ({ feedback: [{ id: "F1", content: "清淡素菜", date: "2026-09-09", status: "未处理", type: "建议", events: [], replies: [], sources: [] }], dishes: [{ id: "D1", name: "青菜", stall: "餐厅" }], recipes: [{ name: "青菜" }], rules: [], report: {}, inventory: [] });

for (const [name, factory] of [["sqlite", () => createSqliteAdapter(":memory:")], ["memory", createMemoryAdapter]]) {
  test(`${name} data port preserves IDs, copy semantics, ordering and rollback`, () => {
    const repo = createRepository(factory(), seed);
    try {
      assert.throws(() => repo.all("feedback; DROP TABLE dishes"));
      const copy = repo.get("feedback", "F1"); copy.content = "not persisted";
      assert.equal(repo.get("feedback", "F1").content, "清淡素菜");
      repo.put("actions", "A1", { id: "A1", revision: 1 });
      repo.put("actions", "A2", { id: "A2", revision: 1 });
      repo.put("actions", "A1", { id: "A1", revision: 2 });
      assert.deepEqual(repo.all("actions").map((r) => r.id), ["A1", "A2"]);
      assert.throws(() => repo.atomic(() => { repo.put("actions", "A3", { id: "A3" }); throw new Error("abort"); }));
      assert.equal(repo.get("actions", "A3"), null);
      assert.throws(() => repo.atomic(async () => {}), /synchronous/);
      assert.equal(repo.atomic(() => 42), 42);
    } finally { repo.close(); }
  });
  test(`${name} adapter serves identical resource API projections and persists commands`, async () => {
    const repo = createRepository(factory(), seed);
    const app = createApp(repo, resolve(tmpdir(), "no-dining-dist"), { ai: { status: () => ({ configured: false }) } });
    const get = async (url) => (await app.inject({ url, headers: { host: "localhost" } })).json();
    try {
      repo.put("actions", "A1", { id: "A1", promptVersion: 99, rawPrompt: "internal" });
      repo.put("plans", "P1", { id: "P1", entries: [1, 2] });
      const snapshot = await get("/api/data");
      for (const key of ["feedback", "dishes", "actions", "plans", "imports"]) assert.deepEqual(await get(`/api/${key}`), snapshot[key]);
      assert.equal(snapshot.plans[0].countEntries, 2);
      assert.equal(snapshot.actions[0].rawPrompt, undefined);
      assert.equal((await get("/api/feedback/insights")).total, 1);
      assert.equal((await get("/api/recipes/D1"))[0].name, "青菜");
      const reply = await app.inject({ method: "POST", url: "/api/feedback/F1/reply", headers: { host: "localhost", "content-type": "application/json" }, payload: { text: "已收到反馈" } });
      assert.equal(reply.statusCode, 200);
      assert.equal((await get("/api/feedback"))[0].reply, "已收到反馈");
    } finally { await app.close(); repo.close(); }
  });
  test(`${name} adapter shares read-only menu recovery projections between queries and HTTP`, async () => {
    const repo = createRepository(factory(), () => ({ ...seed(), dishes: Array.from({ length: 8 }, (_, index) => ({
      id: `D${index}`, name: `餐厅菜${index}`, stall: "餐厅", active: true, price: 12, unit: "份",
      spicy: "不辣", vegetarian: "素食", mainIngredient: `蔬菜${index}`, method: "炒", labelSource: "测试核验",
    })) }));
    let calls = 0;
    let fail = true;
    const ai = { status: () => ({ configured: true, model: "query-contract-no-network" }), async respond(request) {
      calls++;
      if (fail) throw new Error("isolated query contract failure");
      return { data: request.role === "planner" ? directWeeklyResponse(request)
        : { verdict: "pass", summary: "已完成测试检验，保留人工审批", findings: [] }, model: "query-contract-no-network" };
    } };
    const app = createApp(repo, resolve(tmpdir(), "no-dining-dist"), { ai });
    const queries = createQueryService(repo, { ai });
    const settings = getSettings(repo);
    const input = { scope: "all", start: "2026-09-14", meals: ["午餐"], count: 2, seed: 1 };
    const get = async url => app.inject({ url, headers: { host: "localhost" } });
    const snapshot = () => Object.fromEntries(COLLECTIONS.map(collection => [collection, repo.all(collection)]));
    const wireProjection = value => JSON.parse(JSON.stringify(value));
    try {
      await assert.rejects(runMenuWorkflow({ store: repo, ai, input, settings }));
      const failed = repo.all("menuRuns")[0];
      fail = false;
      const plan = await runMenuWorkflow({ store: repo, ai, input, settings });
      const completed = repo.get("menuRuns", plan.workflow.runId);
      completed.plan.prompt = "SERVER_ONLY_QUERY_PROMPT";
      completed.plannerAttempts[0].data.internalTrace = "SERVER_ONLY_QUERY_ATTEMPT";
      repo.put("menuRuns", completed.id, completed);
      const before = snapshot();
      const callsBeforeReads = calls;
      const listed = queries.menuRuns();
      assert.deepEqual((await get("/api/menu-runs")).json(), wireProjection(listed));
      assert.equal(listed.find(run => run.id === failed.id).resumable, true);
      assert.equal(listed.find(run => run.id === completed.id).canUseSavedResult, true);
      const result = queries.menuRunResult(completed.id);
      assert.deepEqual((await get(`/api/menu-runs/${completed.id}/result`)).json(), wireProjection(result));
      assert.deepEqual(result.entries, plan.entries);
      assert.equal(result.workflow.requiresHumanApproval, true);
      const trace = queries.menuRun(completed.id);
      assert.deepEqual((await get(`/api/menu-runs/${completed.id}`)).json(), wireProjection(trace));
      const projected = JSON.stringify([listed, result, trace]);
      for (const hidden of ["SERVER_ONLY_QUERY_PROMPT", "SERVER_ONLY_QUERY_ATTEMPT", "plannerAttempts", "plannerBatches", "plannerPrompt", "inspectorPrompt"])
        assert.ok(!projected.includes(hidden), `${hidden} must be hidden before the HTTP serialization layer`);
      assert.throws(() => queries.menuRunResult(failed.id), /尚无完整菜单结果/);
      assert.equal((await get(`/api/menu-runs/${failed.id}/result`)).statusCode, 400);
      assert.deepEqual(snapshot(), before, "query and HTTP reads must not write any repository collection");
      assert.equal(calls, callsBeforeReads, "query and HTTP reads must never call AI");
      assert.equal(repo.all("plans").length, 0);
      repo.put("meta", "rules", [{ stall: "餐厅", text: "已更新排菜规则" }]);
      const afterChange = snapshot();
      assert.equal(queries.menuRunResult(completed.id).workflow.stale, true);
      assert.equal(queries.menuRuns().find(run => run.id === failed.id).resumable, false);
      assert.equal((await get(`/api/menu-runs/${completed.id}/result`)).json().workflow.stale, true);
      assert.deepEqual(snapshot(), afterChange);
      assert.equal(calls, callsBeforeReads);
    } finally { await app.close(); repo.close(); }
  });
}
test("schema migration opens legacy SQLite without reseeding or rewriting any business record", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dining-migration-"));
  const filename = resolve(dir, "legacy.sqlite");
  const original = JSON.stringify({ id: "F-old", reply: "人工回复保留", status: "已完成", unknownFutureField: true });
  let db = new DatabaseSync(filename);
  db.exec("CREATE TABLE feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE meta (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.prepare("INSERT INTO feedback VALUES (?, ?)").run("F-old", original);
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("initialized", JSON.stringify({ version: 1 }));
  db.close();
  try {
    const repo = createStore(filename, () => { throw new Error("Must not re-seed"); });
    assert.equal(repo.get("feedback", "F-old").reply, "人工回复保留");
    repo.close();
    db = new DatabaseSync(filename);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM catalogEnglish").get().count, 0);
    assert.equal(db.prepare("SELECT data FROM feedback WHERE id = ?").get("F-old").data, original);
    db.exec("PRAGMA user_version = 999"); db.close();
    assert.throws(() => createStore(filename, seed), /版本高于/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("SQL implementation is isolated from application and domain services", () => {
  const root = resolve(import.meta.dirname, "../server");
  for (const name of readdirSync(root).filter((file) => file.endsWith(".mjs")))
    assert.doesNotMatch(readFileSync(resolve(root, name), "utf8"), /node:sqlite|new DatabaseSync|\.prepare\(/, name);
});

test("v1 catalog migrates to v2 without losing original names and persists English cache across reopen", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dining-english-migration-"));
  const filename = resolve(dir, "version-one.sqlite");
  const source = JSON.stringify({ id: "D-v1", name: "原中文菜名", english: "Existing English", sources: [{ file: "original.xlsx" }], revision: 3 });
  let db = new DatabaseSync(filename);
  db.exec("CREATE TABLE dishes (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE meta (id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1");
  db.prepare("INSERT INTO dishes VALUES (?, ?)").run("D-v1", source);
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("initialized", JSON.stringify({ version: 1 }));
  db.close();
  try {
    let repo = createStore(filename, () => { throw new Error("Do not reseed a v1 database"); });
    assert.deepEqual(repo.get("dishes", "D-v1"), JSON.parse(source));
    const cache = { id: "exact-name-key", sourceName: "原中文菜名", english: "Existing English", origin: "source", protocolVersion: "dish-english-v1" };
    repo.put("catalogEnglish", cache.id, cache);
    repo.close();
    repo = createStore(filename);
    assert.deepEqual(repo.get("catalogEnglish", cache.id), cache);
    repo.close();
    db = new DatabaseSync(filename, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT data FROM dishes WHERE id=?").get("D-v1").data, source);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("menu recovery GET routes delegate public projections to the query service", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../server/app.mjs"), "utf8");
  assert.match(source, /app\.get\("\/api\/menu-runs",[^\n]*queries\.menuRuns\(\)/);
  assert.match(source, /app\.get\("\/api\/menu-runs\/:id\/result",[^\n]*queries\.menuRunResult\(request\.params\.id\)/);
  assert.doesNotMatch(source, /menuRecoveryRecords|completedMenuResult/, "routes must not bypass the public query projection");
});
