export const FEEDBACK_TYPES = [
  { name: "批评", color: "#df7b67" },
  { name: "建议", color: "#598ccc" },
  { name: "表扬", color: "#479e85" },
  { name: "询问", color: "#9d83bc" },
];
const otherType = { name: "其他 / 待分类", color: "#9aa9b3" };

export function displayFeedbackType(value) {
  const type = typeof value === "string" ? value.trim() : "";
  return type === "投诉" ? "批评" : FEEDBACK_TYPES.some((item) => item.name === type) ? type : otherType.name;
}

export function buildFeedbackDistribution(records) {
  const counts = new Map();
  for (const record of records) {
    const name = displayFeedbackType(record.type);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let start = 0;
  const types = counts.has(otherType.name) ? [...FEEDBACK_TYPES, otherType] : FEEDBACK_TYPES;
  return types.map((type) => {
    const count = counts.get(type.name) || 0;
    const fraction = records.length ? count / records.length : 0;
    const result = { ...type, count, fraction, start, percent: Math.round(fraction * 1000) / 10 };
    start += fraction;
    return result;
  });
}

function parseFeedbackDate(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})(?:-(\d{2})(?:T.*)?)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day !== null && (day < 1 || day > lastDay)) return null;
  return { month: `${match[1]}-${match[2]}`, day, lastDay };
}

export function buildFeedbackTrend(records, month = "", t = (text) => text) {
  const scope = month ? records.filter((record) => record.date?.startsWith(month)) : records;
  const types = buildFeedbackDistribution(scope);
  const parsed = scope.map((record) => ({ record, date: parseFeedbackDate(record.date) }));
  const monthDate = month ? parseFeedbackDate(month) : null;
  const keys = monthDate
    ? Array.from({ length: Math.ceil(monthDate.lastDay / 7) }, (_, index) => ({ key: String(index), label: index * 7 + 1 === monthDate.lastDay ? t(`${monthDate.lastDay}日`, `Day ${monthDate.lastDay}`) : t(`${index * 7 + 1}–${Math.min(monthDate.lastDay, index * 7 + 7)}日`, `Days ${index * 7 + 1}–${Math.min(monthDate.lastDay, index * 7 + 7)}`) }))
    : [...new Set(parsed.filter((item) => item.date).map((item) => item.date.month))].sort().map((key) => ({ key, label: key }));
  const buckets = keys.map((key) => ({ ...key, total: 0, counts: Object.fromEntries(types.map((type) => [type.name, 0])) }));
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  let monthOnlyCount = 0;
  let undatedCount = 0;
  for (const { record, date } of parsed) {
    if (!date) { undatedCount++; continue; }
    if (monthDate && date.day === null) { monthOnlyCount++; continue; }
    const key = monthDate ? String(Math.floor((date.day - 1) / 7)) : date.month;
    const bucket = byKey.get(key);
    if (!bucket) continue;
    bucket.total++;
    bucket.counts[displayFeedbackType(record.type)]++;
  }
  return { buckets, types, monthOnlyCount, undatedCount, plottedCount: buckets.reduce((total, bucket) => total + bucket.total, 0) };
}

export function buildHandlingOverview(records) {
  const statuses = [
    { name: "未处理", color: "#dfac67" },
    { name: "跟进中", color: "#648fbd" },
    { name: "已完成", color: "#499e83" },
  ].map((state) => {
    const count = records.filter((record) => record.status === state.name).length;
    return { ...state, count, percent: records.length ? count / records.length * 100 : 0 };
  });
  const completed = statuses[2].count;
  return { statuses, completed, total: records.length, completionRate: records.length ? Math.round(completed / records.length * 100) : 0, unknownCount: records.length - statuses.reduce((total, state) => total + state.count, 0) };
}
