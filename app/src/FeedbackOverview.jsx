import { ArrowRight, CalendarDays, CheckCircle2, ClipboardList, Clock3, FileInput, MessageSquare, Plus, Sparkles, TrendingUp } from "lucide-react";
import heroImage from "./assets/hero.png";
import { Badge, Empty } from "./shared";

const statusCards = [
  ["未处理", "等待首次响应", ClipboardList, "blue"],
  ["跟进中", "持续推进改善", Clock3, "amber"],
  ["已完成", "已记录处理结果", CheckCircle2, "green"],
  ["全部反馈", "真实反馈记录", MessageSquare, "violet"],
];

function FeedbackPreview({ title, subtitle, items, onSelect, completed = false }) {
  return <section className="fd-panel fd-preview"><header><div><h2>{title}</h2><p>{subtitle}</p></div><span className={`fd-dot ${completed ? "green" : "blue"}`} /></header>{items.length ? <div className="fd-preview-list">{items.slice(0, 4).map((item) => <button key={item.id} onClick={() => onSelect(item)} className="fd-feedback-link"><span className={`fd-feedback-icon ${completed ? "green" : "blue"}`}><MessageSquare size={16} /></span><span><strong>{item.restaurant || "待确认餐厅"}</strong><small>{item.content}</small><em>{item.date} · {item.category || "待分类"}</em></span><Badge>{item.status}</Badge><ArrowRight size={14} /></button>)}</div> : <Empty text={completed ? "本期暂无已完成反馈" : "本期没有待处理反馈"} />}</section>;
}

function FeedbackCharts({ records, month }) {
  const months = [...new Set(records.map((item) => item.date?.slice(0, 7)).filter(Boolean))].sort();
  const chartMonth = month || months.at(-1) || new Date().toLocaleDateString("en-CA").slice(0, 7);
  const range = records.filter((item) => item.date?.startsWith(chartMonth));
  const buckets = Array.from({ length: 6 }, (_, index) => ({ label: index === 5 ? "26–月底" : `${index * 5 + 1}–${index * 5 + 5}日`, all: 0, complete: 0 }));
  for (const item of range) { const day = Number(item.date.slice(8, 10)); if (!day) continue; const bucket = buckets[Math.min(5, Math.floor((day - 1) / 5))]; bucket.all++; if (item.status === "已完成") bucket.complete++; }
  const max = Math.max(1, ...buckets.map((item) => item.all));
  const points = (field) => buckets.map((bucket, index) => `${42 + index * 91},${166 - bucket[field] / max * 122}`).join(" ");
  const typeColors = { 建议: "#2e85dc", 投诉: "#edb34d", 表扬: "#42a183", 询问: "#8978ca" };
  const types = Object.entries(typeColors).map(([name, color]) => ({ name, color, count: records.filter((item) => item.type === name).length }));
  const total = types.reduce((sum, item) => sum + item.count, 0);
  let progress = 0;
  const segments = types.map((item) => { const start = progress; progress += item.count / Math.max(1, total) * 100; return `${item.color} ${start}% ${progress}%`; });
  return <div className="fd-charts"><section className="fd-panel"><header><div><h2><TrendingUp size={17} />反馈趋势</h2><p>{chartMonth} · 按反馈日期统计，已完成为当前状态</p></div><div className="fd-chart-legend"><span><i className="blue" />反馈量</span><span><i className="green" />已完成</span></div></header><div className="fd-line-chart"><svg viewBox="0 0 545 205" role="img" aria-label={`${chartMonth}反馈趋势：${buckets.map((item) => `${item.label} ${item.all}条反馈，${item.complete}条已完成`).join("；")}`}>{[0, 1, 2, 3].map((value) => <g key={value}><line x1="42" y1={44 + value * 122 / 3} x2="497" y2={44 + value * 122 / 3} stroke="#e5edf3" strokeDasharray="3 4" /><text x="26" y={48 + value * 122 / 3} textAnchor="end" fill="#90a0ad" fontSize="10">{Math.round(max * (1 - value / 3))}</text></g>)}<polyline points={points("all")} fill="none" stroke="#2e85dc" strokeWidth="2.5" /><polyline points={points("complete")} fill="none" stroke="#42a183" strokeWidth="2.5" />{buckets.map((bucket, index) => <g key={bucket.label}><circle cx={42 + index * 91} cy={166 - bucket.all / max * 122} r="3.5" fill="#2e85dc"><title>{bucket.label}：{bucket.all}条反馈</title></circle><circle cx={42 + index * 91} cy={166 - bucket.complete / max * 122} r="3" fill="#42a183" /><text x={42 + index * 91} y="191" textAnchor="middle" fill="#8798a5" fontSize="10">{bucket.label}</text></g>)}</svg></div></section><section className="fd-panel"><header><div><h2>反馈类型分布</h2><p>{month || "全部月份"} · 不含示例数据</p></div></header><div className="fd-type-chart"><div className="fd-donut" style={{ background: total ? `conic-gradient(${segments.join(",")})` : "#edf1f4" }} role="img" aria-label={`反馈类型分布：${types.map((item) => `${item.name}${item.count}条`).join("，")}`}><span><strong>{total}</strong><small>真实反馈</small></span></div><div className="fd-type-legend">{types.map((item) => <div key={item.name}><i style={{ background: item.color }} /><span>{item.name}</span><strong>{item.count}</strong><small>{total ? Math.round(item.count / total * 100) : 0}%</small></div>)}</div></div></section></div>;
}

export default function FeedbackOverview({ records, month, onSelect, onStatus, onCreate, onUpload, onSummary, onAggregate, onDemo }) {
  const waiting = records.filter((item) => item.status !== "已完成").sort((left, right) => right.date.localeCompare(left.date));
  const complete = records.filter((item) => item.status === "已完成").sort((left, right) => right.date.localeCompare(left.date));
  return <div className="feedback-overview">
    <section className="fd-hero" style={{ backgroundImage: `linear-gradient(90deg, rgba(7, 71, 57, .98) 0%, rgba(13, 85, 63, .91) 48%, rgba(12, 75, 47, .1) 100%), url(${heroImage})` }}><div><span>BJW DINING · FEEDBACK & CARE</span><h2>倾听你的声音，<br className="fd-mobile-break" />提升用餐体验</h2><p>每一份反馈，都让下一餐更好一点。</p><button onClick={onAggregate}><Sparkles size={15} />从反馈中发现改善机会<ArrowRight size={15} /></button></div><div className="fd-hero-label"><span /><CalendarDays size={14} />{month || "全部月份"} · 餐饮运营</div></section>
    <div className="fd-metrics" aria-label="真实反馈统计">{statusCards.map(([status, detail, Icon, color]) => <button className={`fd-metric ${color}`} key={status} onClick={() => onStatus(status === "全部反馈" ? "" : status)}><span className="fd-metric-icon"><Icon size={22} /></span><span><small>{status}</small><strong>{status === "全部反馈" ? records.length : records.filter((item) => item.status === status).length}</strong><em>{detail}</em></span><ArrowRight size={14} /></button>)}</div>
    <section className="fd-panel fd-shortcuts"><h2>快捷入口</h2><div>{[["新建反馈", Plus, onCreate, "blue"], ["导入旧表", FileInput, onUpload, "green"], ["查看月报", CalendarDays, onSummary, "amber"], ["汇总改善事项", Sparkles, onAggregate, "violet"], ["体验示例事项", ClipboardList, onDemo, "teal"]].map(([title, Icon, click, color]) => <button key={title} onClick={click}><span className={color}><Icon size={19} /></span>{title}</button>)}</div></section>
    <div className="fd-preview-grid"><FeedbackPreview title="待处理反馈" subtitle="需要关注的建议、投诉与询问" items={waiting} onSelect={onSelect} /><FeedbackPreview title="最近完成" subtitle="让处理过程与结果留有记录" items={complete} onSelect={onSelect} completed /></div>
    <FeedbackCharts records={records} month={month} />
  </div>;
}
