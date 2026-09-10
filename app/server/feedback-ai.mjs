import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, getSettings } from "./settings.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const analysisSchema = z.object({
  summary: z.string().max(2000), replyDraft: z.string().max(5000),
  keywords: z.array(z.string().min(2).max(30)).max(15),
});
const actionUpdateSchema = z.object({
  title: z.string().trim().min(2).max(150).optional(),
  description: z.string().trim().min(2).max(2000).optional(),
  targetStall: z.string().trim().min(1).max(100).optional(),
  menuInstruction: z.string().trim().max(2000).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  reason: z.string().trim().max(2000).default(""),
}).strict();
const fingerprint = (item) => hash([item.content, item.restaurant, item.type, item.date, item.reply || "", item.replies || [], item.events || []]);
function required(store, id) {
  const feedback = store.get("feedback", id);
  if (!feedback) throw new Error("反馈不存在");
  return feedback;
}
function allowedStalls(store) { return ["全部档口", ...new Set(store.all("dishes").map((dish) => dish.stall))]; }

export async function analyzeFeedback(store, ai, id, { force = false } = {}) {
  const item = required(store, id);
  const settings = getSettings(store);
  const sourceFingerprint = fingerprint(item);
  const actionsForFeedback = () => store.all("actions").filter((action) => action.feedbackIds?.includes(id));
  if (!force && item.aiAnalysis?.sourceFingerprint === sourceFingerprint && item.aiAnalysis.promptVersion === settings.version)
    return { feedback: item, actions: actionsForFeedback(), reused: true };
  const response = await ai.respond({
    role: "feedback", prompt: `${settings.feedbackPrompt}\n本次只分析单条反馈并起草回复，不生成Action或改善事项。改善事项由另一个流程汇总全部反馈后生成。回复仅保存为草稿，不对外发送。`,
    input: { feedback: { id: item.id, content: item.content, restaurant: item.restaurant, type: item.type,
      category: item.category, date: item.date, historicalReply: item.reply || "", replies: (item.replies || []).map(({ text }) => ({ text })),
      followup: (item.events || []).map(({ kind, text }) => ({ kind, text })) } },
    schema: z.toJSONSchema(analysisSchema),
  });
  const result = analysisSchema.parse(response.data);
  const current = required(store, id);
  if (fingerprint(current) !== sourceFingerprint || getSettings(store).version !== settings.version)
    throw new Error("分析期间反馈或提示词已变更，请重新分析");
  const at = new Date().toISOString();
  const updated = { ...current, aiAnalysis: { summary: result.summary, replyDraft: result.replyDraft,
    keywords: result.keywords, sourceFingerprint, promptVersion: settings.version, model: response.model,
    createdAt: at, requestId: response.requestId } };
  store.atomic(() => {
    store.put("feedback", id, updated);
    audit(store, "feedback.reply_drafted", id, { promptVersion: settings.version });
  });
  return { feedback: updated, actions: actionsForFeedback() };
}

export function saveReply(store, id, rawInput) {
  const { text } = z.object({ text: z.string().trim().min(2).max(5000) }).strict().parse(rawInput);
  const item = required(store, id);
  const at = new Date().toISOString();
  const reply = { id: randomUUID(), text, at, delivery: "local" };
  const updated = { ...item, replies: [...(item.replies || []), reply],
    reply: text, updatedAt: at, events: [...(item.events || []), { at, kind: "保存回复", text }] };
  store.atomic(() => { store.put("feedback", id, updated); audit(store, "feedback.reply_saved", id, { replyId: reply.id }); });
  return updated;
}

export function updateAction(store, id, rawInput) {
  const input = actionUpdateSchema.parse(rawInput);
  const item = store.get("actions", id);
  if (!item) throw new Error("行动不存在");
  if (input.targetStall && !allowedStalls(store).includes(input.targetStall)) throw new Error("请选择现有档口或全部档口");
  const { reason, ...changes } = input;
  // Menu participation follows the operator's business requirement, never a
  // stale AI category (e.g. a service item later given a menu requirement).
  if (changes.menuInstruction !== undefined) changes.kind = changes.menuInstruction ? "menu" : item.kind === "service" ? "service" : "other";
  const changed = ["title", "description", "targetStall", "menuInstruction", "priority"]
    .some((key) => changes[key] !== undefined && changes[key] !== item[key]);
  const status = changes.status || (changed && item.status === "approved" ? "pending" : item.status);
  const at = new Date().toISOString();
  const revision = (item.revision || 1) + 1;
  const updated = { ...item, ...changes, status, revision, updatedAt: at,
    approvedAt: status === "approved" ? at : null,
    history: [...(item.history || []), { at, kind: status === "approved" ? "运营批准" : status === "rejected" ? "运营拒绝" : "运营调整",
      reason, revision, status, previous: { kind: item.kind, title: item.title, description: item.description, targetStall: item.targetStall,
        menuInstruction: item.menuInstruction, priority: item.priority, enabled: item.enabled, status: item.status, revision: item.revision } }] };
  store.atomic(() => { store.put("actions", id, updated); audit(store, "action.updated", id, { status, revision, reason }); });
  return updated;
}

// A dining vocabulary prevents free Chinese segmentation from promoting
// signatures, pronouns and fragments (e.g. “寻味” + “列车”) into cloud topics.
// These are literal mentions, not sentiment or evidence that an issue occurred.
const diningTerms = new Set([
  "口味", "味道", "没味道", "没有味道", "好吃", "不好吃", "不太好吃", "难吃", "太咸", "偏咸", "少盐", "低盐", "咸淡",
  "太辣", "偏辣", "少辣", "不辣", "辣度", "麻辣", "清淡", "油腻", "少油",
  "太甜", "偏甜", "少糖", "低糖", "无糖", "甜度", "酸味", "口感", "发苦",
  "新鲜", "不新鲜", "变质", "发霉", "异味", "异物", "头发", "虫子", "生熟", "没熟",
  "食品安全", "卫生", "干净", "不干净", "清洁", "消毒", "餐具", "筷子", "勺子", "餐盘",
  "价格", "涨价", "降价", "定价", "性价比", "收费", "退款", "称重", "计量", "份量", "分量",
  "排队", "等候", "等待时间", "出餐速度", "出餐", "服务态度", "服务质量", "服务",
  "保温", "温度", "热菜", "凉菜", "冷菜", "热饭", "剩菜", "供餐", "打包", "售罄",
  "营养", "热量", "卡路里", "蛋白质", "过敏原", "过敏", "标签", "配料", "食材",
  "菜单", "菜品", "品种", "种类", "重复", "轮换", "新品", "早餐", "午餐", "晚餐",
  "素食", "素菜", "荤菜", "蔬菜", "青菜", "水果", "肉类", "主食", "粗粮", "杂粮",
  "米饭", "炒饭", "面条", "面食", "米线", "米粉", "包子", "饺子", "馒头", "粥",
  "牛肉", "猪肉", "鸡肉", "羊肉", "鸭肉", "鱼肉", "鸡蛋", "海鲜", "虾仁", "豆腐",
  "土豆", "辣椒", "茄子", "番茄", "西红柿", "黄瓜", "西兰花", "白菜", "蘑菇",
  "饮料", "饮品", "豆浆", "牛奶", "酸奶", "咖啡", "果汁", "汤品",
  "麻辣烫", "麻辣香锅", "辣子鸡", "红烧肉", "汉堡", "炸鸡", "沙拉", "烤鱼", "烤肉", "川菜",
].filter((term) => term.length >= 2));
const ignoredMenuNames = new Set(["餐厅", "食堂", "菜单", "菜名", "品名", "合计", "总计", "日期", "价格", "备注"]);

function keywordVocabulary(store) {
  const terms = new Set(diningTerms);
  for (const dish of store.all("dishes")) {
    for (const value of [dish.name, dish.stall]) {
      const term = String(value || "").trim();
      if (/^[\p{Script=Han}]{2,16}$/u.test(term) && !ignoredMenuNames.has(term)) terms.add(term);
    }
  }
  return [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right, "zh-CN"));
}

function mentionedDiningTerms(content, vocabulary) {
  const text = String(content || "")
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, " ")
    .replace(/(^|\n)\s*(?:姓名|署名|联系人|alias|email|name)\s*[:：][^\n]*/gi, "$1");
  const occupied = new Uint8Array(text.length);
  const mentioned = new Set();
  // Longest exact phrase wins at each position: “麻辣烫” does not also
  // generate “麻辣”, and known dishes/restaurant names stay intact.
  for (const term of vocabulary) {
    let position = text.indexOf(term);
    while (position !== -1) {
      const end = position + term.length;
      if (!occupied.subarray(position, end).some(Boolean)) {
        mentioned.add(term);
        occupied.fill(1, position, end);
      }
      position = text.indexOf(term, end);
    }
  }
  return mentioned;
}

function diningKeywordCounts(store, records) {
  const counts = new Map();
  const vocabulary = keywordVocabulary(store);
  for (const item of records) {
    for (const term of mentionedDiningTerms(item.content, vocabulary))
      counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "zh-CN")).slice(0, 40);
}

const insightsScopeSchema = z.object({
  month: z.union([z.literal(""), monthSchema]).default(""),
}).strict();

function feedbackMonth(item) {
  const value = typeof item.date === "string" ? item.date.slice(0, 7) : "";
  return monthSchema.safeParse(value).success ? value : "";
}

function countBy(records, key, fallback) {
  const counts = new Map();
  for (const item of records) {
    const value = typeof item[key] === "string" && item[key].trim() ? item[key].trim() : fallback;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b, "zh-CN")));
}

// Dashboard data is computed locally and deliberately does not access model
// configuration, cached AI reports or write/audit methods. The same literal
// per-feedback keyword count is also used by the existing monthly report.
export function feedbackInsights(store, rawScope = {}) {
  const { month } = insightsScopeSchema.parse(rawScope);
  const records = store.all("feedback").filter((item) =>
    !item.demo && !item.summaryRecord && !item.quarantined && (!month || feedbackMonth(item) === month));
  const months = new Map();
  let undated = 0;
  for (const item of records) {
    const key = feedbackMonth(item);
    if (!key) { undated++; continue; }
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(item);
  }
  return {
    month, total: records.length, keywords: diningKeywordCounts(store, records),
    byType: countBy(records, "type", "未分类"),
    byStatus: countBy(records, "status", "未处理"),
    byMonth: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({
      month: key, total: items.length, byType: countBy(items, "type", "未分类"),
    })),
    undated,
  };
}

export function monthlySummary(store, month) {
  monthSchema.parse(month);
  const all = store.all("feedback").filter((item) => item.date?.startsWith(month) && !item.quarantined && !item.demo);
  const records = all.filter((item) => !item.summaryRecord);
  const keywords = diningKeywordCounts(store, records);
  const sourceFingerprint = hash({ keywordVersion: 2, keywords, records: records.map((item) => [item.id, fingerprint(item), item.status]) });
  const saved = store.get("meta", `feedback-summary-${month}`);
  const feedbackIds = new Set(records.map((item) => item.id));
  // Aggregate Actions may cite several months. Count an Action once in each
  // relevant month, while retaining legacy single-feedback links.
  const actions = store.all("actions").filter((action) => !action.demo &&
    [...(Array.isArray(action.feedbackIds) ? action.feedbackIds : []), action.feedbackId]
      .some((id) => typeof id === "string" && feedbackIds.has(id)));
  return { month, total: records.length, summaryRecords: all.length - records.length,
    keywords, sourceFingerprint, approvedActions: actions.filter((action) => action.status === "approved").length,
    pendingActions: actions.filter((action) => action.status === "pending").length,
    summary: records.length ? `本月 ${records.length} 条单条反馈，${records.filter((item) => item.status === "已完成").length} 条已完成。高频主题：${keywords.slice(0, 6).map((item) => `${item.text}（${item.count}条）`).join("、") || "暂无"}。词云按提及该词的反馈条数计算。` : "本月暂无单条反馈",
    aiSummary: saved && saved.sourceFingerprint === sourceFingerprint && saved.promptVersion === getSettings(store).version ? saved : null };
}

export async function summarizeMonth(store, ai, month) {
  const summary = monthlySummary(store, month);
  if (!summary.total || summary.aiSummary) return summary;
  const settings = getSettings(store);
  const records = store.all("feedback").filter((item) => item.date?.startsWith(month) && !item.summaryRecord && !item.quarantined && !item.demo);
  if (records.length > 1000) throw new Error("本月反馈超过单次摘要上限1000条，请先按档口整理");
  const schema = z.object({ text: z.string().min(1).max(6000) });
  const response = await ai.respond({ role: "summary",
    prompt: `${settings.feedbackPrompt}\n请总结本月员工关注的主要事项、积极评价与需跟进事项。区分反馈观点与已核实事实，引用反馈ID，不能声称未执行的行动已经完成。不得输出个人身份或联系方式。`,
    input: { month, keywords: summary.keywords, records: records.map(({ id, content, restaurant, type, status }) => ({ id, content, restaurant, type, status })) },
    schema: z.toJSONSchema(schema) });
  const result = schema.parse(response.data);
  if (monthlySummary(store, month).sourceFingerprint !== summary.sourceFingerprint || getSettings(store).version !== settings.version)
    throw new Error("摘要生成期间资料已更新，请重试");
  const aiSummary = { ...result, createdAt: new Date().toISOString(), model: response.model,
    sourceFingerprint: summary.sourceFingerprint, promptVersion: settings.version };
  store.atomic(() => { store.put("meta", `feedback-summary-${month}`, aiSummary); audit(store, "feedback.month_summarized", month, { total: summary.total }); });
  return { ...summary, aiSummary };
}
