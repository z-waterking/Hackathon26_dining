import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, getSettings } from "./settings.mjs";
import { getPromptConfig } from "./prompt-config.mjs";
import { actionGenerationPrompt } from "./prompt-builders.mjs";

const optionsSchema = z.object({
  month: z.union([z.literal(""), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)]).default(""),
  demo: z.boolean().default(false),
}).strict();
const requestSchema = optionsSchema.extend({ force: z.boolean().default(false) });
const proposalSchema = z.object({
  sourceKey: z.string().max(100),
  kind: z.enum(["menu", "service", "other"]),
  feedbackIds: z.array(z.string().min(1).max(200)).min(1).max(1000),
  evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().min(2).max(2000),
  targetStall: z.string().trim().min(1).max(100),
  menuInstruction: z.string().trim().max(2000),
  priority: z.enum(["low", "medium", "high"]),
}).strict();
const responseSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  actions: z.array(proposalSchema).max(6),
}).strict();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const scopeName = ({ month, demo }) => `${demo ? "demo" : "real"}:${month || "all"}`;
const sourceKeyFor = (action, demo) => `topic-${hash([demo, normalized(action.targetStall), normalized(action.title)]).slice(0, 32)}`;
const evidenceKey = ({ feedbackId, quote }) => JSON.stringify([feedbackId, quote]);

function aggregateActions(store, demo) {
  return store.all("actions").filter((action) => {
    if (Boolean(action.demo) !== demo || !Array.isArray(action.feedbackIds) || !action.feedbackIds.length) return false;
    if (action.source === "aggregate") return true;
    // Built-in examples are already evidence-backed aggregate actions, despite
    // their distinct source tag. Old per-feedback demo actions stay excluded.
    return demo && action.source === "demo" && action.feedbackIds.length >= 2 &&
      Array.isArray(action.evidence) && action.feedbackIds.every((id) => action.evidence.some((item) => item.feedbackId === id));
  });
}

function snapshot(store, options) {
  const records = store.all("feedback")
    .filter((record) => !record.summaryRecord && !record.quarantined && Boolean(record.demo) === options.demo && (!options.month || record.date?.startsWith(options.month)))
    .map((record) => ({
      id: record.id, content: String(record.content || ""), restaurant: record.restaurant || "待确认",
      date: record.date || "", type: record.type || "待分类", category: record.category || "待分类",
      status: record.status || "未处理", reply: record.reply || "",
      replies: (record.replies || []).map(({ text }) => ({ text })),
      followup: (record.events || []).map(({ kind, text }) => ({ kind, text })),
    })).sort((left, right) => left.id.localeCompare(right.id));
  const allowedStalls = ["全部档口", ...new Set(store.all("dishes").map((dish) => dish.stall).filter(Boolean))].sort();
  return { records, allowedStalls, sourceFingerprint: hash({ version: 2, scope: scopeName(options), records, allowedStalls }) };
}

function analysisView(analysis) {
  if (!analysis) return null;
  const { id, summary, sourceCount, sourceFingerprint, createdAt } = analysis;
  return { id, summary, sourceCount, sourceFingerprint, createdAt };
}

export function getActionSummary(store, rawOptions = {}) {
  const options = optionsSchema.parse(rawOptions);
  const source = snapshot(store, options);
  const current = store.get("meta", `action-summary:${scopeName(options)}`);
  const promptVersion = store.get("settings", "current")?.version || 1;
  const actualPromptHash = hash(actionGenerationPrompt(getPromptConfig(store), store.get("settings", "current") || {}));
  const valid = current?.sourceFingerprint === source.sourceFingerprint && current.promptVersion === promptVersion && current.actionPromptHash === actualPromptHash;
  const selectedIds = new Set(source.records.map((record) => record.id));
  const actions = aggregateActions(store, options.demo)
    .filter((action) => (action.feedbackIds || []).some((id) => selectedIds.has(id)))
    .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || "") || left.id.localeCompare(right.id));
  return { analysis: analysisView(valid ? current : null), sourceCount: source.records.length, actions };
}

function existingInput(store, demo) {
  return aggregateActions(store, demo).map((action) => ({
    id: action.id, sourceKey: action.sourceKey || sourceKeyFor(action, demo),
    title: action.title, description: action.description, targetStall: action.targetStall,
    kind: action.kind || (action.menuInstruction ? "menu" : "other"),
    menuInstruction: action.menuInstruction || "", status: action.status, enabled: action.enabled,
    revision: action.revision,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function evidenceInput(records) {
  const evidence = new Map();
  const inputRecords = records.map(({ content, ...record }, recordIndex) => {
    const passages = [];
    // Keep exact, bounded substrings. AI selects references, never transcribes
    // quotes; the server materializes evidence from the original snapshot.
    for (let start = 0; start < content.length;) {
      let end = Math.min(start + 400, content.length);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
      const text = content.slice(start, end);
      const id = `Q${recordIndex + 1}-${passages.length + 1}`;
      passages.push({ id, text });
      evidence.set(id, { feedbackId: record.id, quote: text });
      start = end;
    }
    return { ...record, passages };
  });
  return { records: inputRecords, evidence };
}

function validateProposals(result, source, existingActions) {
  const recordsById = new Map(source.records.map((record) => [record.id, record]));
  const knownKeys = new Set(existingActions.map((action) => action.sourceKey));
  for (const proposal of result.actions) {
    if (!source.allowedStalls.includes(proposal.targetStall)) throw new Error("汇总行动引用了不存在的档口，未保存结果");
    if (proposal.sourceKey && !knownKeys.has(proposal.sourceKey)) throw new Error("汇总行动引用了未知的已有事项，未保存结果");
    if (proposal.kind !== "menu" && proposal.menuInstruction) throw new Error("服务或其他改进行动不能包含排菜指令，未保存结果");
    if (proposal.kind === "menu" && !proposal.menuInstruction) throw new Error("排菜行动缺少具体菜单要求，未保存结果");
    const ids = new Set(proposal.feedbackIds);
    if (ids.size !== proposal.feedbackIds.length || [...ids].some((id) => !recordsById.has(id))) throw new Error("汇总行动的反馈引用不属于本次完整输入或重复，未保存结果");
    const citations = new Set();
    for (const evidence of proposal.evidence) {
      if (!ids.has(evidence.feedbackId) || !recordsById.get(evidence.feedbackId)?.content.includes(evidence.quote))
        throw new Error("汇总行动的证据必须是关联反馈中的原文片段，未保存结果");
      if (citations.has(evidenceKey(evidence))) throw new Error("汇总行动的证据重复，未保存结果");
      citations.add(evidenceKey(evidence));
    }
  }
}

export async function summarizeActions(store, ai, rawOptions = {}) {
  const { force, ...options } = requestSchema.parse(rawOptions);
  const initial = getActionSummary(store, options);
  if (!initial.sourceCount || (!force && initial.analysis)) return { ...initial, reused: true };
  const settings = getSettings(store);
  const config = getPromptConfig(store);
  const actualPrompt = actionGenerationPrompt(config, settings);
  const source = snapshot(store, options);
  if (source.records.length > 1000) throw new Error("本次范围超过1000条反馈，请选择月份后再汇总；未截断或发送部分资料");
  const existingActions = existingInput(store, options.demo);
  const catalog = evidenceInput(source.records);
  const input = { scope: { month: options.month || "全部月份", demo: options.demo }, sourceCount: source.records.length, records: catalog.records, allowedStalls: source.allowedStalls, existingActions };
  if (JSON.stringify(input).length > 150000) throw new Error("本次反馈和已有事项总输入超过150000字符，请缩小月份范围；未截断或发送部分资料");
  const startingInput = hash(existingActions);
  const response = await ai.respond({
    role: "actions", prompt: actualPrompt,
    input, schema: z.toJSONSchema(responseSchema), maxOutputTokens: 6000,
  });
  const result = responseSchema.parse(response.data);
  result.actions = result.actions.map(({ evidenceIds, ...action }) => ({ ...action, evidence: evidenceIds.map((id) => {
    const item = catalog.evidence.get(id);
    if (!item) throw new Error("汇总行动引用了不存在的原文片段，未保存结果");
    return { ...item };
  }) }));
  validateProposals(result, source, existingActions);
  const at = new Date().toISOString();
  const analysisId = `AS-${randomUUID()}`;
  store.atomic(() => {
    if (snapshot(store, options).sourceFingerprint !== source.sourceFingerprint || getSettings(store).version !== settings.version || hash(existingInput(store, options.demo)) !== startingInput)
      throw new Error("汇总期间反馈、菜单档口、已有事项或内部配置已更新，请重新汇总；未写入过时结果");
    const metaKey = `action-summary:${scopeName(options)}`;
    const previousAnalysis = store.get("meta", metaKey);
    const candidates = aggregateActions(store, options.demo);
    const actionIds = new Set();
    let created = 0;
    let supplemented = 0;
    for (const proposal of result.actions) {
      const sourceKey = proposal.sourceKey || sourceKeyFor(proposal, options.demo);
      const prior = candidates.find((action) => (action.sourceKey || sourceKeyFor(action, options.demo)) === sourceKey || sourceKeyFor(action, options.demo) === sourceKeyFor(proposal, options.demo));
      if (prior) {
        actionIds.add(prior.id);
        const feedbackIds = [...new Set([...(prior.feedbackIds || []), ...proposal.feedbackIds])];
        const evidence = [...new Map([...(prior.evidence || []), ...proposal.evidence].map((item) => [evidenceKey(item), item])).values()];
        if (feedbackIds.length !== (prior.feedbackIds || []).length || evidence.length !== (prior.evidence || []).length) {
          const updated = { ...prior, feedbackIds, evidence, lastReferencedAt: at,
            history: [...(prior.history || []), { at, kind: "聚合补充依据", analysisId,
              addedFeedbackIds: feedbackIds.filter((id) => !(prior.feedbackIds || []).includes(id)),
              addedEvidence: evidence.length - (prior.evidence || []).length,
              reason: "补充反馈依据，保留运营标题、操作要求和审批状态" }] };
          store.put("actions", prior.id, updated);
          candidates[candidates.indexOf(prior)] = updated;
          supplemented++;
        }
        continue;
      }
      const id = `A-aggregate-${hash([options.demo, sourceKey]).slice(0, 24)}`;
      if (store.get("actions", id)) throw new Error("汇总行动标识发生冲突，未保存结果，请重新汇总");
      const action = { ...proposal, id, sourceKey, source: "aggregate", demo: options.demo,
        feedbackIds: [...proposal.feedbackIds], evidence: [...proposal.evidence],
        status: "pending", enabled: true, revision: 1, createdAt: at, updatedAt: at,
        sourceFingerprint: source.sourceFingerprint, promptVersion: settings.version, analysisId,
        model: response.model || "", requestId: response.requestId || "",
        history: [{ at, kind: "全量反馈聚合提案", status: "pending", revision: 1, analysisId, reason: "待运营确认后批准" }] };
      store.put("actions", id, action);
      candidates.push(action);
      actionIds.add(id);
      created++;
    }
    const analysis = { id: analysisId, summary: result.summary, sourceCount: source.records.length,
      sourceFingerprint: source.sourceFingerprint, createdAt: at, month: options.month, demo: options.demo,
      scope: scopeName(options), promptVersion: settings.version, promptConfigVersion: config.version, actionPromptHash: hash(actualPrompt), actionPromptText: actualPrompt, model: response.model || "",
      requestId: response.requestId || "", actionIds: [...actionIds], previousAnalysisId: previousAnalysis?.id || null };
    if (previousAnalysis?.id) store.put("meta", `action-summary-run:${previousAnalysis.id}`, previousAnalysis);
    store.put("meta", `action-summary-run:${analysisId}`, analysis);
    store.put("meta", metaKey, analysis);
    audit(store, "actions.aggregated", analysisId, { scope: analysis.scope, sourceCount: analysis.sourceCount,
      sourceFingerprint: source.sourceFingerprint, actionIds: [...actionIds], created, supplemented, previousAnalysisId: analysis.previousAnalysisId });
  });
  return { ...getActionSummary(store, options), reused: false };
}
