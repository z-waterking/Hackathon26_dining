// Explicit live integration: uses the configured Azure deployment, real local
// rules/catalog and approved Actions; saves a new draft, never approves it.
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { initializeLocalStore } from "../app/server/bootstrap.mjs";
import { createApp } from "../app/server/app.mjs";
import { createAiClient } from "../app/server/ai.mjs";

if (!process.argv.includes("--confirm-live")) throw new Error("此命令会调用付费GPT并保存新菜单草案；确认后传入 --confirm-live");
const root = resolve(import.meta.dirname, "..");
const start = process.argv.find(x => x.startsWith("--start="))?.slice(8) || "2026-09-14";
loadEnvFile(resolve(root, "app/.env"));
const dbFile = resolve(root, "app/data/dining.sqlite");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(resolve(root, "app/data/backups"), { recursive: true });
const db = new DatabaseSync(dbFile, { readOnly: true });
await backup(db, resolve(root, `app/data/backups/dining-before-direct-menu-${stamp}.sqlite`));
db.close();
const store = await initializeLocalStore({ filename: dbFile });
const live = createAiClient(store);
const runUsageIds = new Set(store.all("aiUsage").map(r => r.id));
const protectedDigest = () => JSON.stringify(["feedback", "actions", "dishes"].map(table => store.all(table)));
const original = protectedDigest();
const ai = { status: live.status, async respond(request) {
  console.log(JSON.stringify({ stage: request.role, week: request.input.week || null, state: "started" }));
  const response = await live.respond(request);
  console.log(JSON.stringify({ stage: request.role, week: request.input.week || null, state: "received", model: response.model, tokens: response.usage }));
  return response;
} };
const app = createApp(store, undefined, { ai, menuRuleRoot: root });
process.once("SIGINT", () => {
  for (const record of store.all("aiUsage").filter(r => !runUsageIds.has(r.id) && r.status === "running"))
    store.put("aiUsage", record.id, { ...record, status: "cancelled", error: "本地联调主动停止；上游可能已产生费用", completedAt: new Date().toISOString() });
  console.error("已停止联调；未保存未完成菜单，上游费用以Azure为准");
  process.exit(130);
});
const call = (url, payload) => app.inject({ method: "POST", url, headers: { host: "127.0.0.1" }, payload });
try {
  console.log(JSON.stringify({ model: live.status().model, start, meals: ["午餐", "晚餐"], approvedMenuActions: store.all("actions").filter(a => !a.demo && a.feedbackIds?.length && a.enabled && a.status === "approved" && a.menuInstruction?.trim()).length }));
  const result = await call("/api/plans/generate", { scope: "all", useAi: true, demo: false, start, meals: ["午餐", "晚餐"], count: 4, seed: 1 });
  if (result.statusCode !== 200) throw new Error(result.json().error || `生成失败 ${result.statusCode}`);
  const plan = result.json();
  if (plan.workflow?.stale) throw new Error("菜单生成时业务资料已变化，未保存过时菜单");
  const saved = await call("/api/plans", plan);
  if (saved.statusCode !== 201) throw new Error(saved.json().error || "菜单保存失败");
  const final = saved.json();
  const usage = store.all("aiUsage").filter(r => !runUsageIds.has(r.id));
  console.log(JSON.stringify({ ok: true, planId: final.id, runId: final.workflow.runId, generationMode: final.generationMode, weeks: 6, stalls: final.stalls.length, slots: final.entries.length, filled: final.entries.filter(e => e.dishId).length, validation: { errors: final.validation.errors, warnings: final.validation.warnings }, verdict: final.workflow.inspector.verdict, status: final.status, businessRecordsUnchanged: original === protectedDigest(), calls: usage.length, inputTokens: usage.reduce((n,r) => n + (r.inputTokens || 0), 0), outputTokens: usage.reduce((n,r) => n + (r.outputTokens || 0), 0) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await app.close(); store.close(); }
