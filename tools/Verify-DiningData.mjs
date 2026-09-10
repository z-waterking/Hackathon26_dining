// Read-only pre-release checks: no workbook import, database writes or AI calls.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { COLLECTIONS } from "../app/server/data/repository.mjs";
import { readStallCatalog } from "../app/server/stored-stall-catalog.mjs";
import { promptAdminView } from "../app/server/prompt-admin.mjs";
import { approvedMenuActions } from "../app/server/menu-workflow.mjs";
import { menuActionState } from "../app/shared/menu-action-state.mjs";
import { convertedBatchRows } from "../app/server/bootstrap.mjs";
import { publicData, publicMenuRun } from "../app/server/public-data.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.argv.length > 2) throw new Error("Usage: node tools/Verify-DiningData.mjs (checks this workspace only)");
const filename = resolve(root, "app/data/dining.sqlite");
if (!existsSync(filename)) throw new Error("Database not found; no file was created");
const db = new DatabaseSync(filename, { readOnly: true });
const errors = [];
const notes = [];
const fail = (check, id) => errors.push({ check, ...(id ? { id } : {}) });
const sortedIds = rows => rows.map(row => row.id).sort();
const tally = (rows, key) => Object.fromEntries([...new Set(rows.map(row => String(row[key] ?? "unset")))].map(value => [value, rows.filter(row => String(row[key] ?? "unset") === value).length]));
let report;
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("sqlite-integrity");
  if (db.prepare("PRAGMA foreign_key_check").all().length) fail("sqlite-foreign-keys");
  const data = new Map();
  for (const table of COLLECTIONS) {
    const records = new Map();
    // Collection names are a code-owned allowlist, never external input.
    for (const row of db.prepare("SELECT id,data FROM " + table + " ORDER BY rowid").all()) {
      let value;
      try { value = JSON.parse(row.data); } catch { fail("invalid-json:" + table, row.id); continue; }
      if (value?.id && table !== "meta" && table !== "settings" && value.id !== row.id) fail("record-id:" + table, row.id);
      records.set(row.id, value);
    }
    data.set(table, records);
  }
  db.exec("ROLLBACK");
  // All service projections operate on a consistent captured snapshot.
  const store = { all: table => [...data.get(table).values()], get: (table, id) => data.get(table).get(id) ?? null,
    put() { throw new Error("Read-only audit rejects writes"); }, atomic() { throw new Error("Read-only audit rejects transactions"); } };
  const dishes = store.all("dishes"), feedback = store.all("feedback"), actions = store.all("actions");
  const plans = store.all("plans"), runs = store.all("menuRuns"), batches = store.all("imports");
  const dishById = new Map(dishes.map(row => [row.id, row]));
  const feedbackById = new Map(feedback.map(row => [row.id, row]));
  const stalls = new Set(dishes.map(row => row.stall));
  const conversionKeys = new Set();
  for (const row of feedback) {
    if (!row.conversionKey) continue;
    if (conversionKeys.has(row.conversionKey)) fail("duplicate-conversion-key", row.id);
    conversionKeys.add(row.conversionKey);
  }
  let legacyActions = 0;
  for (const action of actions) {
    if (!Array.isArray(action.feedbackIds)) legacyActions++;
    const refs = action.feedbackIds || (action.feedbackId ? [action.feedbackId] : []);
    for (const id of refs) {
      const source = feedbackById.get(id);
      if (!source) fail("action-feedback-reference", action.id);
      else if (Boolean(action.demo) !== Boolean(source.demo)) fail("action-feedback-demo-boundary", action.id);
    }
    for (const evidence of action.evidence || []) {
      const source = feedbackById.get(evidence.feedbackId);
      if (!refs.includes(evidence.feedbackId) || !source) fail("action-evidence-reference", action.id);
      else if (typeof evidence.quote !== "string" || !evidence.quote.trim() || !String(source.content || "").includes(evidence.quote)) fail("action-evidence-quote", action.id);
    }
  }
  const eligible = approvedMenuActions(store);
  if (JSON.stringify(sortedIds(eligible)) !== JSON.stringify(sortedIds(menuActionState(actions).eligible))) fail("action-client-server-eligibility");
  for (const action of eligible) if (action.targetStall !== "全部档口" && !stalls.has(action.targetStall)) fail("action-target-stall", action.id);
  const catalog = readStallCatalog(store);
  if (catalog?.storageMode !== "database") fail("catalog-not-imported");
  for (const group of catalog?.groups || []) {
    if (new Set(group.candidateIds).size !== group.candidateIds.length) fail("duplicate-catalog-candidate", group.stall);
    for (const id of group.candidateIds) {
      const dish = dishById.get(id);
      if (!dish || !dish.active || dish.stall !== group.stall || dish.category === "主食杂粮") fail("catalog-candidate-reference", group.stall);
    }
    if (group.unresolved?.length) fail("catalog-missing-source-record", group.stall);
  }
  let emptySlots = 0;
  for (const plan of plans) {
    const positions = new Set();
    for (const entry of plan.entries || []) {
      const position = JSON.stringify([entry.stall || plan.stall, entry.date, entry.meal, entry.slot]);
      if (positions.has(position)) fail("duplicate-plan-slot", plan.id);
      positions.add(position);
      if (!entry.dishId) { emptySlots++; continue; }
      const dish = dishById.get(entry.dishId);
      if (!dish || dish.stall !== (entry.stall || plan.stall)) fail("plan-dish-reference", plan.id);
    }
    if (plan.workflow?.runId) {
      const run = store.get("menuRuns", plan.workflow.runId);
      if (!run?.workflow || run.stage !== "completed") fail("plan-inspection-reference", plan.id);
    }
  }
  for (const run of runs) {
    if (run.parentRunId && !store.get("menuRuns", run.parentRunId)) fail("run-parent-reference", run.id);
    const runDishes = new Map((run.snapshots?.dishes || []).map(dish => [dish.id, dish]));
    for (const entry of run.plan?.entries || []) {
      if (!entry.dishId) continue;
      const dish = runDishes.get(entry.dishId);
      if (!dish || dish.stall !== (entry.stall || run.plan.stall)) fail("run-snapshot-dish-reference", run.id);
    }
  }
  let convertedRows = 0;
  for (const batch of batches) {
    const view = convertedBatchRows(store, batch.id, root);
    convertedRows += view.rows.length;
    if (batch.imported && view.rows.some(row => !row.feedbackId)) fail("conversion-feedback-reference", batch.id);
    if (view.headers.length !== 10 || view.rows.some(row => Object.keys(row.targetRow).join("|") !== view.headers.join("|"))) fail("conversion-view-ten-column-format", batch.id);
    for (const key of ["outputPath", "csvPath"]) if (!batch[key] || !existsSync(batch[key])) fail("conversion-artifact:" + key, batch.id);
    // Early batches predate XLSX export; the UI only offers recorded formats.
    if (batch.xlsxPath && !existsSync(batch.xlsxPath)) fail("conversion-artifact:xlsxPath", batch.id);
    else if (!batch.xlsxPath) notes.push({ check: "legacy-import-csv-only", id: batch.id });
  }
  const config = promptAdminView(store);
  if (JSON.stringify(sortedIds(eligible)) !== JSON.stringify(sortedIds(config.approvedActions))) fail("prompt-approved-action-projection");
  for (const rule of config.rules.filter(rule => rule.enabled)) if (!config.previews.menuSystem.includes(rule.text)) fail("prompt-rule-injection", rule.id);
  if (config.version > 0 && !store.get("meta", "prompt-config:version-" + config.version)) fail("prompt-version-history");
  const forbidden = new Set(["apiKey", "api_key", "prompts", "prompt", "promptConfig", "actionPromptText", "plannerInput", "inspectorInput", "plannerAttempts", "plannerBatches", "stallBatches"]);
  const scanPublic = value => {
    if (Array.isArray(value)) { value.forEach(scanPublic); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { if (forbidden.has(key)) fail("public-internal-field:" + key); scanPublic(child); }
  };
  scanPublic(publicData({ feedback, dishes, plans, actions }));
  runs.map(publicMenuRun).forEach(scanPublic);
  if (legacyActions) notes.push({ check: "legacy-single-feedback-actions-excluded-from-aggregation", count: legacyActions });
  if (emptySlots) notes.push({ check: "existing-menu-gaps-not-data-corruption", count: emptySlots });
  notes.push({ check: "historical-menu-run-statuses", counts: tally(runs, "status") });
  report = { ok: errors.length === 0, readOnly: true, sqliteIntegrity: integrity[0]?.integrity_check === "ok",
    counts: Object.fromEntries([...data].map(([name, rows]) => [name, rows.size])),
    feedback: { business: feedback.filter(row => !row.demo && !row.summaryRecord && !row.quarantined).length, demo: feedback.filter(row => row.demo).length, summary: feedback.filter(row => row.summaryRecord).length },
    eligibleMenuActions: eligible.length, catalogStalls: catalog?.groups.length || 0, promptVersion: config.version, enabledRules: config.rules.filter(rule => rule.enabled).length,
    importBatches: batches.length, convertedRows, notes, errors };
} finally { db.close(); }
console.log(JSON.stringify(report, null, 2));
if (!report?.ok) process.exitCode = 1;
