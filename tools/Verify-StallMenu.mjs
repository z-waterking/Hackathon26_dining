// Bounded, explicit paid smoke test. Only usage rows touch the live repository.
// All menu runs, candidate preprocessing and plans remain in memory.
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createRepository, COLLECTIONS } from "../app/server/data/repository.mjs";
import { createMemoryAdapter } from "../app/server/data/memory-adapter.mjs";
import { createAiClient } from "../app/server/ai.mjs";
import { syncMenuSourceRules } from "../app/server/menu-source-rules.mjs";
import { requireStoredStallCatalog } from "../app/server/stored-stall-catalog.mjs";
import { getSettings } from "../app/server/settings.mjs";
import { runMenuWorkflow } from "../app/server/menu-workflow.mjs";

if (!process.argv.includes("--confirm-live")) throw new Error("此验证最多调用两次付费 GPT，确认后传 --confirm-live；不会保存菜单或批准业务事项");
const root = resolve(import.meta.dirname, "..");
loadEnvFile(resolve(root, "app/.env"));
const db = new DatabaseSync(resolve(root, "app/data/dining.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");
const all = table => db.prepare("SELECT data FROM " + table + " ORDER BY rowid").all().map(row => JSON.parse(row.data));
const store = createRepository(createMemoryAdapter(), () => ({}));
const protectedTables = COLLECTIONS.filter(name => name !== "aiUsage");
const digest = () => createHash("sha256").update(JSON.stringify(protectedTables.map(all))).digest("hex");
const original = digest();
const stop = new Error("有界验证已到两次调用上限，未请求完整六周菜单");
let calls = 0;
try {
  if (all("menuRuns").some(run => run.status === "running")) throw new Error("生产菜单正在生成，请结束后再验证");
  for (const table of COLLECTIONS) for (const row of db.prepare("SELECT id, data FROM " + table + " ORDER BY rowid").all())
    store.put(table, row.id, JSON.parse(row.data));
  await syncMenuSourceRules(store, root);
  const catalog = requireStoredStallCatalog(store);
  const usageStore = { all(name) { if (name !== "aiUsage") throw new Error("验证仅允许访问用量集合"); return all(name); },
    put(name, id, record) {
      if (name !== "aiUsage") throw new Error("验证禁止写业务集合");
      db.prepare("INSERT INTO aiUsage (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(record));
    } };
  const realAi = createAiClient(usageStore);
  const ai = { async respond(request) {
    if (calls >= 2 || request.role !== "planner") throw stop;
    calls++;
    console.log(JSON.stringify({ state: "requesting", call: calls, stall: request.input.targetStall, week: request.input.week,
      candidates: request.input.catalogCoverage.provided, correction: Boolean(request.input.qualityCorrection) }));
    const result = await realAi.respond(request);
    console.log(JSON.stringify({ state: "received", call: calls, model: result.model, usage: result.usage }));
    return result;
  } };
  try {
    await runMenuWorkflow({ store, ai, settings: getSettings(store), ruleSourcePath: resolve(root, "餐厅排菜规则+示例.xlsx"),
      input: { scope: "all", start: "2026-09-14", meals: ["午餐", "晚餐"], count: 2, seed: 1, useAi: true } });
  } catch (error) { if (error.message !== stop.message) throw error; }
  const run = store.all("menuRuns").at(-1);
  const attempts = run.plannerAttempts.filter(attempt => attempt.data);
  if (!attempts.length || attempts.some(attempt => !["accepted", "quality_review"].includes(attempt.status))) throw new Error("真实返回未通过本档结构/引用验证，请查看实现；未保存业务菜单");
  console.log(JSON.stringify({ ok: true, calls, completeSixWeeks: false, businessRecordsUnchanged: original === digest(), sourceStats: catalog.stats,
    acceptedStalls: run.stallBatches.map(batch => ({ week: batch.week, stall: batch.stall, attempt: batch.attempt, qualityIssues: batch.quality.count, mode: batch.mode })),
    validatedAttempts: attempts.map(attempt => ({ stall: attempt.stall, status: attempt.status, qualityIssues: attempt.quality.count })),
    inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens || 0), 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.output_tokens || 0), 0) }));
  if (original !== digest()) throw new Error("验证期间业务数据发生变化，需要核实并发操作；未覆盖数据");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); db.close(); }
