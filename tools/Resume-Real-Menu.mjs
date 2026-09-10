// Explicit paid integration against the already-running application, not a
// second app/store instance. Only --save writes a new, unapproved draft.
import { request } from "node:http";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";

if (!process.argv.includes("--confirm-live")) throw new Error("此命令会调用付费 GPT 继续失败菜单；确认后传入 --confirm-live");
const runId = process.argv.find(arg => arg.startsWith("--run="))?.slice(6);
if (!/^MR-[a-f0-9-]{36}$/.test(runId || "")) throw new Error("请提供 --run=MR-...");
const root = resolve(import.meta.dirname, "..");
const db = new DatabaseSync(resolve(root, "app/data/dining.sqlite"), { readOnly: true });
const all = table => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.data));
const readRun = id => {
  const row = db.prepare("SELECT data FROM menuRuns WHERE id = ?").get(id);
  return row && JSON.parse(row.data);
};
const protectedDigest = () => JSON.stringify(["feedback", "actions", "dishes", "settings", "meta"].map(all));
const call = (method, path, payload) => new Promise((resolveCall, reject) => {
  const body = payload === undefined ? null : JSON.stringify(payload);
  const req = request({ hostname: "127.0.0.1", port: 4317, method, path,
    headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
  }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("error", reject);
    response.on("end", () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (response.statusCode >= 400) reject(new Error(`${data.error || "请求失败"} (${response.statusCode}; ${data.runId || runId})`));
        else resolveCall(data);
      } catch (error) { reject(error); }
    });
  });
  req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error("等待超过 30 分钟；请先查看运行记录，切勿盲目重复调用")));
  req.on("error", reject);
  req.end(body);
});
let progress;
try {
  const records = await call("GET", "/api/menu-runs");
  if (!records.some(record => record.id === runId && record.resumable)) throw new Error("该记录当前不可恢复，请先在菜单页检查原因");
  if (all("menuRuns").some(run => run.status === "running")) throw new Error("存在运行中的菜单，请等待结束后再联调");
  const prior = readRun(runId);
  const original = protectedDigest();
  const usageIds = new Set(all("aiUsage").map(row => row.id));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = resolve(root, `app/data/backups/dining-before-menu-resume-${stamp}.sqlite`);
  await mkdir(resolve(root, "app/data/backups"), { recursive: true });
  await backup(db, backupFile);
  console.log(JSON.stringify({ state: "starting", parentRunId: runId, reusedWeeks: prior.plannerBatches.length, backup: backupFile }));
  let previousProgress = "";
  progress = setInterval(() => {
    const run = all("menuRuns").findLast(row => row.parentRunId === runId);
    if (!run) return;
    const current = JSON.stringify({ runId: run.id, status: run.status, stage: run.stage, week: run.currentWeek,
      completedWeeks: run.plannerBatches?.length || 0, attempt: run.plannerAttempts?.at(-1)?.attempt });
    if (current !== previousProgress) console.log(current);
    previousProgress = current;
  }, 20000);
  const plan = await call("POST", "/api/plans/resume", { runId });
  const resumed = readRun(plan.workflow?.runId);
  const prefixUnchanged = prior.plannerBatches.every((batch, index) =>
    JSON.stringify(batch.result) === JSON.stringify(resumed.plannerBatches[index]?.result));
  const dishes = new Map(all("dishes").map(dish => [dish.id, dish]));
  const wrongStall = plan.entries.filter(entry => entry.dishId && dishes.get(entry.dishId)?.stall !== entry.stall).length;
  if (plan.workflow?.stale || !prefixUnchanged || wrongStall || original !== protectedDigest())
    throw new Error("恢复验证未通过：快照变化、旧周次变化或菜品档口错误；未保存草案");
  const final = process.argv.includes("--save") ? await call("POST", "/api/plans", plan) : plan;
  const usage = all("aiUsage").filter(row => !usageIds.has(row.id));
  console.log(JSON.stringify({ ok: true, runId: resumed.id, parentRunId: runId, planId: final.id || null,
    saved: process.argv.includes("--save"), status: final.status, plannerVersion: resumed.plannerVersion,
    model: resumed.planner?.model, reusedWeeks: resumed.resumedWeeks, completedWeeks: resumed.plannerBatches.length,
    stalls: final.stalls.length, slots: final.entries.length, filled: final.entries.filter(entry => entry.dishId).length,
    wrongStall, prefixUnchanged, businessRecordsUnchanged: original === protectedDigest(),
    validation: { errors: final.validation.errors, warnings: final.validation.warnings }, verdict: final.workflow.inspector.verdict,
    calls: usage.length, inputTokens: usage.reduce((sum, row) => sum + (row.inputTokens || 0), 0),
    outputTokens: usage.reduce((sum, row) => sum + (row.outputTokens || 0), 0) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { clearInterval(progress); db.close(); }
