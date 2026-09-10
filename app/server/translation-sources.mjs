import { hasChinese, translationParts } from "../shared/translation-text.mjs";
import { translate } from "../src/i18n-text.js";
import { readable } from "../src/ui-text.js";
import { projectMenuTrace } from "../src/menu-trace-projection.js";
import { feedbackInsights, monthlySummary } from "./feedback-ai.mjs";
import { getActionSummary } from "./action-summary.mjs";
import { promptAdminView } from "./prompt-admin.mjs";
import { attachMenuWorkflow, menuRecoveryRecords } from "./menu-workflow.mjs";
import { publicData, publicMenuRun } from "./public-data.mjs";
import { defaultSettings } from "./settings.mjs";
import { createAiClient } from "./ai.mjs";

const originalFields = new Set([
  "menu", "menus", "actualMenu", "previousWeeks", "entries", "dishes", "dishCatalog",
  "candidates", "fixedStaples", "fixedDishes", "ingredients", "recipes", "records",
  "feedback", "feedbacks", "feedbackRecords", "sourceFeedback", "originalFeedback",
  "feedbackSnapshot", "rawFeedback", "passages", "quote", "quotes", "content",
  "source", "sources", "file", "filename", "fileName", "sheet", "cell", "path",
  "raw", "rawResponse", "response", "output", "meta", "sourceMaterials", "uiTranslations",
  "menuByStall", "tuples", "staples", "dish", "dishName", "stall", "stalls", "targetStall",
  "rawContent", "provenance", "targetRow",
]);
const promptFields = new Set([
  "prompt", "rawPrompt", "systemPrompt", "plannerPrompt", "inspectorPrompt", "feedbackPrompt",
  "operatorNotes", "menuSystemText", "approvedActionText", "actionPromptText", "actionGenerationText",
  "prompts", "promptConfig", "settings", "previews", "localConstraintsText",
]);
const isObject = value => value !== null && typeof value === "object";
const items = value => Array.isArray(value) ? value : [];
const monthOf = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])/.test(value) ? value.slice(0, 7) : "";

// Collect only display prose already supported by the UI. Do not enumerate
// meta: source-sheet snapshots and quoted feedback must never reach the model.
// includePrompts is for explicit offline pre-generation / Prompt DTOs only;
// workspace responses must use false so their cache cannot expose Prompts.
function sourceCollector(includePrompts) {
  const collected = new Set();
  const threadContinuations = new Set();
  function registerOriginals(value) {
    if (Array.isArray(value)) { value.forEach(registerOriginals); return; }
    if (!isObject(value)) return;
    if (value.kind === "线程补充" && hasChinese(value.text)) threadContinuations.add(value.text);
    for (const [key, item] of Object.entries(value)) if (!originalFields.has(key)) registerOriginals(item);
  }
  const add = text => {
    if (!hasChinese(text) || translate("en", text) !== text) return text;
    for (const part of translationParts(text))
      if (hasChinese(part) && translate("en", part) === part) collected.add(part);
    return text;
  };
  const addFollowup = text => {
    if (typeof text === "string" && ![...threadContinuations].some(original => text.includes(original))) add(text);
  };
  function permitted(value) {
    if (Array.isArray(value)) return value.map(permitted);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !originalFields.has(key) && !(value.kind === "线程补充" && key === "text") && (includePrompts || !promptFields.has(key)) && !/(?:Id|Ids|Hash|Fingerprint|Path)$/.test(key))
      .map(([key, item]) => [key, permitted(item)]));
  }
  function prose(value) {
    projectMenuTrace(permitted(value), { language: "en", translateText: add });
  }
  function readableProse(value) {
    // Match readable() exactly when it selects a known explanation or joins
    // explanations. A JSON fallback containing original data is not translated.
    if (typeof value === "string" || typeof value === "number" || value == null) { add(readable(value)); return; }
    if (Array.isArray(value)) {
      if (JSON.stringify(permitted(value)) === JSON.stringify(value)) add(readable(value));
      value.forEach(readableProse); return;
    }
    const selected = value.text || value.summary || value.description || value.reason;
    if (selected) { readableProse(selected); return; }
    const safe = permitted(value);
    if (JSON.stringify(safe) === JSON.stringify(value)) add(readable(value));
    prose(safe);
  }
  function actionTexts(action) {
    if (!isObject(action)) return;
    for (const key of ["title", "description", "menuInstruction", "reason"]) add(action[key]);
    if (typeof action.menuInstruction === "string") add(action.menuInstruction.trim());
    for (const item of items(action.history || action.revisions || action.adjustments)) {
      if (!isObject(item)) continue;
      add(item.kind);
      readableProse(item.reason || item.note || item.description || item.changes || item.status || item);
      if (item.previous) prose(item.previous);
    }
  }
  function workflowTexts(workflow) {
    if (!isObject(workflow)) return;
    prose(workflow);
    add(workflow.source);
    if (Array.isArray(workflow.staleReasons)) add(workflow.staleReasons.join("；"));
    for (const impact of items(workflow.actionImpacts))
      for (const item of items(impact?.evidence)) readableProse(item);
    for (const warning of items(workflow.catalogInfo?.warnings || workflow.stallCatalog?.warnings)) readableProse(warning);
  }
  function planTexts(plan) {
    if (!isObject(plan)) return;
    add(plan.status);
    prose({ validation: plan.validation, summary: plan.summary, description: plan.description });
    workflowTexts(plan.workflow);
  }
  function feedbackTexts(item) {
    if (!isObject(item)) return;
    for (const key of ["channel", "type", "category", "status", "reply", "notes"]) add(item[key]);
    for (const event of items(item.events)) { add(event?.kind); if (event?.kind !== "线程补充") add(event?.text); }
    for (const reply of items(item.replies)) add(reply?.text);
    if (item.aiAnalysis) {
      readableProse(item.aiAnalysis.summary); add(item.aiAnalysis.replyDraft);
      for (const keyword of items(item.aiAnalysis.keywords)) add(typeof keyword === "string" ? keyword : keyword?.text);
    }
    for (const key of ["反馈来源", "反馈类别", "问题分类", "回复记录", "备注"]) add(item.targetRow?.[key]);
    addFollowup(item.targetRow?.反馈跟进);
    add(items(item.events).filter(event => !["创建", "保存回复", "历史回复", "线程补充"].includes(event?.kind)).map(event => event?.text).filter(Boolean).join("\n"));
  }
  function promptTexts(config) {
    if (!includePrompts || !isObject(config)) return;
    for (const key of ["actionGenerationText", "menuSystemText", "approvedActionText", "localConstraintsText"]) add(config[key]);
    for (const rule of items(config.rules)) { add(rule?.text); add(rule?.originalText); add(rule?.source?.label); }
    for (const key of ["actionGeneration", "menuSystem", "approvedActions"]) add(config.previews?.[key]);
  }
  function payloadTexts(payload) {
    if (Array.isArray(payload)) { payload.forEach(payloadTexts); return; }
    if (!isObject(payload)) return;
    prose(payload);
    actionTexts(payload);
    feedbackTexts(payload);
    if (Array.isArray(payload.feedback)) payload.feedback.forEach(feedbackTexts);
    else feedbackTexts(payload.feedback);
    for (const action of items(payload.actions)) actionTexts(action);
    planTexts(payload);
    planTexts(payload.plan);
    for (const plan of items(payload.plans)) planTexts(plan);
    readableProse(payload.summary);
    readableProse(payload.aiSummary);
    add(payload.labelSource);
    add(payload.costNote);
    add(payload.aiStatus?.costNote);
    add(payload.aiStatus?.reason);
    for (const keyword of items(payload.keywords)) add(typeof keyword === "string" ? keyword : keyword?.text);
    for (const row of items(payload.rows)) feedbackTexts(row);
    for (const issue of items(payload.report?.issues)) add(issue?.reason);
    if (Object.keys(payload.report?.mapping || {}).length) add(JSON.stringify(payload.report.mapping, null, 2));
    if (Array.isArray(payload.issues) && payload.issues.every(issue => typeof issue === "string")) add(payload.issues.join("；"));
    promptTexts(payload);
  }
  return { collected, add, registerOriginals, prose, readableProse, actionTexts, workflowTexts, planTexts, feedbackTexts, promptTexts, payloadTexts };
}

export function collectPayloadTranslationSources(payload, { includePrompts = false } = {}) {
  const collector = sourceCollector(includePrompts);
  collector.registerOriginals(payload);
  // Feedback wrapper fields are protected as source subtrees in the generic
  // traversal, but their reply / follow-up display fields are explicitly read.
  if (isObject(payload)) collector.registerOriginals(payload.feedback);
  collector.payloadTexts(includePrompts ? payload : publicData(payload));
  return [...collector.collected];
}

export function collectTranslationSources(store, { root: _root, includePrompts = true, payloads = [] } = {}) {
  const records = new Map();
  const get = (collection, id) => collection === "settings" && id === "current"
    ? store.get(collection, id) || defaultSettings : store.get(collection, id);
  const all = collection => {
    if (!records.has(collection)) records.set(collection, store.all(collection));
    return records.get(collection);
  };
  // Derived read helpers can consult getSettings, but can never initialize it.
  const reads = { get, all };
  const { collected, add, registerOriginals, prose, readableProse, actionTexts, workflowTexts, planTexts, feedbackTexts, promptTexts, payloadTexts } = sourceCollector(includePrompts);

  const feedback = all("feedback");
  registerOriginals(feedback);
  registerOriginals(all("actions"));
  for (const payload of payloads) { registerOriginals(payload); registerOriginals(payload?.feedback); }
  for (const action of all("actions")) actionTexts(action);
  const months = [...new Set(feedback.map(item => monthOf(item.date)).filter(Boolean))];
  for (const item of feedback) feedbackTexts(item);
  for (const month of ["", ...months]) {
    const insights = feedbackInsights(reads, { month });
    for (const keyword of insights.keywords) add(keyword.text);
    for (const key of Object.keys(insights.byType)) add(key);
    for (const key of Object.keys(insights.byStatus)) add(key);
    for (const demo of [false, true]) add(getActionSummary(reads, { month, demo }).analysis?.summary);
    if (month) {
      const summary = monthlySummary(reads, month);
      readableProse(summary.summary); readableProse(summary.aiSummary);
    }
  }
  for (const batch of all("imports")) {
    for (const issue of batch.report?.issues || []) add(issue.reason);
    if (Object.keys(batch.report?.mapping || {}).length) add(JSON.stringify(batch.report.mapping, null, 2));
  }
  for (const dish of all("dishes")) add(dish.labelSource);
  for (const recipe of get("meta", "recipes") || [])
    if (Array.isArray(recipe.issues)) add(recipe.issues.join("；"));
  for (const plan of all("plans")) {
    planTexts(plan);
    if (plan.workflow?.runId) {
      try { planTexts(attachMenuWorkflow(reads, plan, plan.workflow, get("settings", "current"))); }
      catch { /* Invalid historical records have no current successful detail DTO. */ }
    }
  }
  for (const run of all("menuRuns")) {
    const view = publicMenuRun(run);
    prose(view); planTexts(run.plan); workflowTexts(view.workflow);
    // Run snapshots in this public DTO contain only Action / rule evidence.
    for (const action of view.snapshots?.actions || []) actionTexts(action);
    if (run.stage === "completed" && run.plan && run.workflow) {
      try { planTexts(attachMenuWorkflow(reads, run.plan, run.workflow, get("settings", "current"))); }
      catch { /* Retain only historical public descriptions when stale input is invalid. */ }
    }
  }
  prose(menuRecoveryRecords(reads, get("settings", "current")));
  const aiStatus = createAiClient(reads).status();
  add(aiStatus.costNote); add(aiStatus.reason);
  // Rules are also displayed on the menu tab; raw prompt instructions are not.
  for (const rule of get("meta", "rules") || []) add(rule.text);
  if (includePrompts) {
    promptTexts(promptAdminView(reads));
  }
  for (const payload of payloads) payloadTexts(includePrompts ? payload : publicData(payload));
  return [...collected];
}
