import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRepository } from "../server/data/repository.mjs";
import { createSqliteAdapter } from "../server/data/sqlite-adapter.mjs";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
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
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
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
