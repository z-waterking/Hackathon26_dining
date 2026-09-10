import test from "node:test";
import assert from "node:assert/strict";
import { createDiningApi } from "../src/api/dining.js";
import { ApiError, createHttpClient } from "../src/api/http.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function recorder(baseUrl = "/api") {
  const calls = [];
  const api = createDiningApi({ baseUrl, fetchImpl: async (url, init) => { calls.push({ url, ...init }); return Response.json({ ok: true }); } });
  return { api, calls };
}
test("one API client supplies every feature and centralizes URL, method and payload", async () => {
  const { api, calls } = recorder("https://example.test/dining/api/");
  await api.workspace.load();
  await api.feedback.insights("2026-09");
  await api.actions.summary({ month: "", demo: false });
  await api.feedback.update("F / 中", { status: "跟进中" });
  await api.catalog.recipes("菜/1");
  await api.plans.inspect({ demo: true });
  await api.analytics.get({ start: "2026-09-01", end: undefined, demo: false });
  assert.equal(calls[0].url, "https://example.test/dining/api/data");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url, "https://example.test/dining/api/feedback/insights?month=2026-09");
  assert.equal(calls[2].url, "https://example.test/dining/api/actions/summary?month=&demo=false");
  assert.equal(calls[3].url, "https://example.test/dining/api/feedback/F%20%2F%20%E4%B8%AD");
  assert.equal(calls[3].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[3].body), { status: "跟进中" });
  assert.equal(calls[4].url, "https://example.test/dining/api/recipes/%E8%8F%9C%2F1");
  assert.equal(calls[5].method, "POST");
  assert.equal(calls[6].url, "https://example.test/dining/api/pos?start=2026-09-01&demo=false");
  assert.equal(api.imports.downloadUrl("I/1", "csv"), "https://example.test/dining/api/imports/I%2F1/download?format=csv");
  assert.throws(() => api.imports.downloadUrl("I1", "exe"));
  assert.throws(() => api.plans.get(".."));
});
test("original file upload uses the same base and preserves bytes with safe metadata", async () => {
  const { api, calls } = recorder("/moved/api");
  const file = new File(["xlsx-bytes"], "旧表.xlsx");
  await api.feedback.importOriginal(file);
  assert.equal(calls[0].url, "/moved/api/feedback/upload");
  assert.equal(calls[0].body, file);
  assert.equal(calls[0].headers["Content-Type"], "application/octet-stream");
  assert.equal(calls[0].headers["X-File-Name"], encodeURIComponent(file.name));
  assert.throws(() => api.feedback.importOriginal(new File([], "empty.xlsx")), /空文件/);
  assert.throws(() => api.feedback.importOriginal(new File(["x"], "a.csv")), /xlsx/);
  assert.throws(() => api.feedback.importOriginal({ name: "large.xlsx", size: 10 * 1024 * 1024 + 1 }), /10 MB/);
  assert.equal(calls.length, 1);
});

test("menu recovery uses the central API with encoded IDs and explicit resume writes", async () => {
  const { api, calls } = recorder("/moved/api");
  await api.plans.recoverableRuns();
  await api.plans.resume("MR / 中");
  await api.plans.result("MR / 中");
  assert.equal(calls[0].url, "/moved/api/menu-runs?recoverable=true");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url, "/moved/api/plans/resume");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { runId: "MR / 中" });
  assert.equal(calls[2].url, "/moved/api/menu-runs/MR%20%2F%20%E4%B8%AD/result");
  assert.equal(calls[2].method, "GET");
  assert.throws(() => api.plans.resume(".."));
  assert.throws(() => api.plans.result(""));
});

test("menu conflict repair uses the shared API and preserves the exact draft and issue", async () => {
  const { api, calls } = recorder("/moved/api");
  const input = { plan: { scope: "all", entries: [], workflow: { runId: "MR-REPAIR" } },
    issue: { code: "DUPLICATE", stall: "南粉北面", date: "2026-09-07", meal: "午餐", text: "同餐重复" } };
  await api.plans.repair(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/moved/api/plans/repair");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), input);
});

test("prompt configuration uses the dedicated shared GET and PUT API", async () => {
  const { api, calls } = recorder("/moved/api");
  const input = { version: 1, baseFingerprint: "a".repeat(64), actionGenerationText: "反馈规则", menuSystemText: "排菜规则", approvedActionText: "Action要求", rules: [] };
  await api.prompts.get();
  await api.prompts.save(input);
  assert.deepEqual(calls.map(call => [call.url, call.method]), [["/moved/api/prompt-config", "GET"], ["/moved/api/prompt-config", "PUT"]]);
  assert.deepEqual(JSON.parse(calls[1].body), input);
});

test("HTTP errors retain safe generation recovery metadata but not raw AI content", async () => {
  for (const wrapped of [false, true]) {
    const details = { message: "第 3 周生成未完成", code: "MENU_SLOT_INVALID", runId: "MR-RECOVER", week: 3, stall: "寻味列车", day: 2, meal: "午餐", slot: 0,
      plannerPrompt: "private system prompt", plannerAttempts: [{ output: "private model output" }] };
    const body = wrapped ? { error: details } : { ...details, error: details.message };
    const http = createHttpClient({ fetchImpl: async () => Response.json(body, { status: 502 }) });
    await assert.rejects(http.send("/plans/generate"), (error) => {
      assert.equal(error.message, details.message);
      assert.equal(error.status, 502);
      for (const key of ["code", "runId", "week", "stall", "day", "meal", "slot"]) assert.equal(error[key], details[key]);
      assert.equal(error.plannerPrompt, undefined);
      assert.equal(error.plannerAttempts, undefined);
      return true;
    });
  }
});
test("API transport normalizes JSON, proxy, network and empty responses without automatic writes/retries", async () => {
  const response = (reply) => createHttpClient({ fetchImpl: async () => reply });
  await assert.rejects(response(Response.json({ error: "输入不完整" }, { status: 400 })).send("/feedback"), (e) => e instanceof ApiError && e.status === 400 && e.message === "输入不完整");
  await assert.rejects(response(new Response("<html>private proxy details</html>", { status: 502 })).send("/data"), /502/);
  await assert.rejects(response(new Response("not-json")).send("/data"), /格式异常/);
  await assert.rejects(createHttpClient({ fetchImpl: () => { throw new Error("socket-private"); } }).send("/data"), /无法连接/);
  assert.equal(await response(new Response(null, { status: 204 })).send("/feedback"), null);
  assert.throws(() => createHttpClient({ baseUrl: "javascript:bad" }));
  assert.throws(() => createHttpClient().url("//other.example/data"));
});
test("views cannot bypass the domain API client or embed server URLs", () => {
  const root = resolve(import.meta.dirname, "../src");
  for (const name of readdirSync(root).filter((name) => /\.(jsx|js)$/.test(name))) {
    const source = readFileSync(resolve(root, name), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b|["'`]\/api(?:\/|["'`])/u, name);
    assert.doesNotMatch(source, /import.*\brequest\b.*from.*["']\.\/api["']/u, name);
  }
});
