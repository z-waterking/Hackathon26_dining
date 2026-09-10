// Display-only projection of audit JSON. Never use this result in API payloads,
// exports or persistence. Unknown fields keep their original values.
const proseFields = new Set([
  "title", "description", "summary", "reason", "note", "notes", "detail", "explanation",
  "text", "originalText", "instruction", "instructions", "menuInstruction",
  "warning", "warnings", "message", "error", "label", "staleReasons", "unresolved",
  "prompt", "rawPrompt", "systemPrompt", "plannerPrompt", "inspectorPrompt",
  "feedbackPrompt", "operatorNotes", "menuSystemText", "approvedActionText", "actionPromptText",
]);
const originalFields = new Set([
  // These are source records, not UI descriptions, even when they contain a
  // field named text, summary or title. Preserve complete subtrees.
  "menu", "menus", "actualMenu", "previousWeeks", "entries", "dishes", "dishCatalog",
  "candidates", "fixedStaples", "fixedDishes", "ingredients", "recipes",
  "feedback", "feedbacks", "feedbackRecords", "sourceFeedback", "originalFeedback",
  "feedbackSnapshot", "rawFeedback", "records", "passages", "quote", "quotes", "content",
  "source", "sources", "file", "filename", "fileName", "sheet", "cell", "path",
]);
const enumFields = new Set([
  "status", "verdict", "kind", "priority", "severity", "level", "scope",
  "meal", "meals", "stage", "mode", "origin", "role", "generationMode",
]);
const englishEnums = Object.freeze({
  approved: "Approved", pending: "Pending approval", rejected: "Rejected",
  applied: "Applied", partial: "Partially applied", not_applied: "Not applied",
  needs_review: "Awaiting human review", blocked: "Blocked", stale: "Stale",
  running: "Running", completed: "Completed", failed: "Failed", repaired: "Repaired", unchanged: "Unchanged",
  pass: "Pass", revise: "Revision required", high: "High", medium: "Medium", low: "Low",
  prefer: "Prefer", avoid: "Avoid", exclude: "Exclude", menu: "Menu", service: "Service", other: "Other",
  error: "Error", warning: "Warning", all: "All stalls", single: "Single stall",
  planning: "Planning", inspecting: "Inspecting", planner: "Planner", inspector: "Inspector",
  demo: "Demo", ai: "AI", strategy: "Strategy", "gpt-direct": "Direct GPT", "source-rule": "Source rule",
  source: "Source", primary: "Primary", supplemental: "Supplemental", custom: "Custom", override: "Override",
  "早餐": "Breakfast", "午餐": "Lunch", "晚餐": "Dinner", "待确认": "To be confirmed",
  "已批准": "Approved", "待审批": "Pending approval", "已拒绝": "Rejected",
  "已落实": "Applied", "部分落实": "Partially applied", "尚未落实": "Not applied",
  "待审核": "Awaiting review", "待人工审核": "Awaiting human review",
  "批评": "Criticism", "建议": "Suggestion", "表扬": "Praise",
});
const hasChinese = value => /\p{Script=Han}/u.test(value);
const copy = value => Array.isArray(value) ? value.map(copy)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;

export function projectMenuTrace(value, { language = "zh", translateText = text => text } = {}) {
  if (language !== "en") return copy(value);
  const translateProse = text => hasChinese(text) ? translateText(text) : text;
  function visit(item, key = "", parentKey = "") {
    if (originalFields.has(key) || /(?:Id|Ids|Hash|Fingerprint|Path)$/.test(key)) return copy(item);
    if (typeof item === "string") {
      if (enumFields.has(key)) return englishEnums[item] ?? translateProse(item);
      if (proseFields.has(key) || parentKey === "prompts" || key === "rules" || key === "sourceRules") return translateProse(item);
      // Legacy evidence strings may be verbatim feedback. Only explicit
      // explanation fields are translated; quote/content always stay original.
      return item;
    }
    if (Array.isArray(item)) return item.map(entry => visit(entry, key, parentKey));
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([childKey, entry]) => [childKey, visit(entry, childKey, key)]));
    return item;
  }
  return visit(value);
}

export function formatMenuTrace(value, { expanded = false, ...options } = {}) {
  // Collapsed audit sections must never queue translations or expose a loading
  // projection. Chinese uses the exact existing JSON representation.
  if (!expanded) return null;
  return JSON.stringify(options.language === "en" ? projectMenuTrace(value, options) : value, null, 2);
}
