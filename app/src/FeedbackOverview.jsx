import { ArrowUpRight, ChartNoAxesCombined, CheckCheck, CircleDot, Layers3, MessageSquareText, ShieldCheck, Sparkles } from "lucide-react";
import FeedbackWordCloud from "./FeedbackWordCloud";
import { buildFeedbackDistribution, buildFeedbackTrend, buildHandlingOverview } from "./feedback-charts";
import { useI18n } from "./i18n";

function ActionBanner({ onNavigate }) {
  const { t } = useI18n();
  return <section className="fd-ai-banner fd-hero" aria-labelledby="feedback-ai-title">
    <div className="fd-ai-copy">
      <span className="fd-ai-eyebrow"><Sparkles size={13} /> AI ASSISTED DINING</span>
      <h2 id="feedback-ai-title">{t("AI 读懂反馈，", "AI understands feedback,")}<br /><span>{t("把改善变成行动。", "turning insights into action.")}</span></h2>
      <p>{t("从全部反馈中归纳共性问题，自动生成可执行的 Action。", "Find recurring issues across feedback and generate practical actions.")}<br className="fd-desktop-break" />{t("由运营调整、审批，让改善进入下一餐。", "Operations reviews and approves changes for future meals.")}</p>
      <button onClick={() => onNavigate?.("actions")}>{t("进入 Action 事项", "Open Actions")} <ArrowUpRight size={17} /></button>
    </div>
    <div className="fd-ai-art" aria-hidden="true">
      <div className="fd-ai-orbit orbit-one" /><div className="fd-ai-orbit orbit-two" />
      <div className="fd-ai-source"><span><MessageSquareText size={15} /> {t("汇集反馈", "Collect feedback")}</span><i /><i /><i /></div>
      <div className="fd-ai-core"><Sparkles size={29} /><span>AI</span></div>
      <div className="fd-ai-output"><span><Layers3 size={15} /> {t("聚合 Action", "Combine actions")}</span><i /><i /><em><ShieldCheck size={13} /> {t("人工审批后生效", "Subject to approval")}</em></div>
      <span className="fd-ai-spark spark-one" /><span className="fd-ai-spark spark-two" /><span className="fd-ai-spark spark-three" />
    </div>
  </section>;
}

function FeedbackTrend({ records, month }) {
  const { t, language } = useI18n();
  const trend = buildFeedbackTrend(records, month, t);
  const { buckets, types } = trend;
  const yMax = Math.max(4, Math.ceil(Math.max(0, ...buckets.flatMap((bucket) => types.map((type) => bucket.counts[type.name]))) / 4) * 4);
  const x = (index) => buckets.length === 1 ? 292 : 42 + index * 498 / Math.max(1, buckets.length - 1);
  const y = (count) => 181 - count / yMax * 153;
  const labelEvery = Math.max(1, Math.ceil((buckets.length - 1) / 6));
  const notes = [trend.monthOnlyCount > 0 && t(`${trend.monthOnlyCount} 条仅记录月份，未分配到具体周`, `${trend.monthOnlyCount} records have a month only and cannot be assigned to a week`), trend.undatedCount > 0 && t(`${trend.undatedCount} 条日期待核验，未计入趋势`, `${trend.undatedCount} records with unverified dates are excluded from this trend`)].filter(Boolean);
  return <section className="fd-panel fd-dashboard-card fd-trend-card" aria-label={t("反馈趋势", "Feedback trends")}>
    <header><div><h2><ChartNoAxesCombined size={17} />{t("反馈趋势", "Feedback trends")}</h2><p>{month || t("全部月份", "All months")} · {month ? t("按周分类统计", "Weekly by type") : t("按月分类统计", "Monthly by type")}</p></div><span className="fd-card-total"><strong>{records.length}</strong>{t("条反馈", " records")}</span></header>
    <div className="fd-chart-legend">{types.map((type) => <span key={type.name}><i style={{ background: type.color }} />{t(type.name)}</span>)}</div>
    <div className="fd-trend-body">
      {trend.plottedCount ? <svg viewBox="0 0 570 224" role="img" aria-label={t(`${month || "全部月份"}分类反馈趋势，${trend.plottedCount} 条有可用日期的反馈`, `${month || "All months"} feedback trends by type, ${trend.plottedCount} records with usable dates`)}>
        <title>{month ? t("按反馈类型展示的周度趋势", "Weekly trends by feedback type") : t("按反馈类型展示的月度趋势", "Monthly trends by feedback type")}</title>
        <desc>{buckets.map((bucket) => `${bucket.label}${language === "en" ? ": " : "："}${types.map((type) => t(`${type.name} ${bucket.counts[type.name]} 条`, `${t(type.name)} ${bucket.counts[type.name]} records`)).join(language === "en" ? ", " : "，")}`).join(language === "en" ? "; " : "；")}</desc>
        {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line x1="42" y1={y(tick * yMax / 4)} x2="540" y2={y(tick * yMax / 4)} stroke="#e7eeef" strokeDasharray={tick ? "3 5" : undefined} /><text x="29" y={y(tick * yMax / 4) + 4} textAnchor="end" fill="#83949d" fontSize="11">{tick * yMax / 4}</text></g>)}
        {types.filter((type) => type.count > 0).map((type) => <g key={type.name}>
          <polyline points={buckets.map((bucket, index) => `${x(index)},${y(bucket.counts[type.name])}`).join(" ")} fill="none" stroke={type.color} strokeWidth="2.5" strokeLinejoin="round" />
          {buckets.map((bucket, index) => <circle key={bucket.key} cx={x(index)} cy={y(bucket.counts[type.name])} r="3.3" fill="white" stroke={type.color} strokeWidth="2"><title>{t(`${bucket.label} · ${type.name}：${bucket.counts[type.name]} 条`, `${bucket.label} · ${t(type.name)}: ${bucket.counts[type.name]} records`)}</title></circle>)}
        </g>)}
        {buckets.map((bucket, index) => index % labelEvery === 0 || index === buckets.length - 1 ? <text key={bucket.key} x={x(index)} y="208" textAnchor="middle" fill="#798e97" fontSize="11">{bucket.label}</text> : null)}
      </svg> : <div className="fd-chart-empty"><ChartNoAxesCombined size={29} /><span>{records.length ? t("暂无可按当前时间粒度展示的反馈", "No feedback can be shown at this time interval") : t("当前范围暂无反馈", "No feedback in this period")}</span></div>}
    </div>
    <p className="fd-card-footnote">{notes.join(language === "en" ? "; " : "；") || t("按原始反馈日期统计 · 不含示例与月汇总记录", "Based on original feedback dates · Excludes demos and monthly summaries")}</p>
  </section>;
}

function FeedbackTypes({ records, month }) {
  const { t, language } = useI18n();
  const types = buildFeedbackDistribution(records);
  const total = records.length;
  return <section className="fd-panel fd-dashboard-card fd-types-card" aria-label={t("反馈类型分布", "Feedback by type")}>
    <header><div><h2><CircleDot size={17} />{t("反馈类型分布", "Feedback by type")}</h2><p>{month || t("全部月份", "All months")} · {t("看见不同声音的占比", "The share of each type of feedback")}</p></div></header>
    <div className="fd-type-chart">
      <svg className="fd-type-ring" viewBox="0 0 210 210" role="img" aria-label={t(`反馈类型分布，共 ${total} 条：`, `Feedback by type, ${total} records: `) + types.map((type) => t(`${type.name} ${type.count} 条`, `${t(type.name)} ${type.count} records`)).join(language === "en" ? ", " : "，")}>
        <title>{t("真实反馈的类型分布", "Real feedback by type")}</title>
        <circle cx="105" cy="105" r="79" fill="none" stroke="#edf2f1" strokeWidth="22" />
        {types.filter((type) => type.count > 0).map((type) => {
          const length = type.fraction * 100;
          const gap = length === 100 ? 0 : Math.min(1.5, length * .2);
          return <circle key={type.name} cx="105" cy="105" r="79" fill="none" stroke={type.color} strokeWidth="22" pathLength="100" strokeDasharray={`${length - gap} ${100 - length + gap}`} strokeDashoffset={-type.start * 100 - gap / 2} transform="rotate(-90 105 105)"><title>{t(`${type.name}：${type.count} 条（${type.percent}%）`, `${t(type.name)}: ${type.count} records (${type.percent}%)`)}</title></circle>;
        })}
        <text x="105" y="109" textAnchor="middle" className="fd-ring-total">{total}</text><text x="105" y="131" textAnchor="middle" className="fd-ring-label">{t("真实反馈", "Real feedback")}</text>
      </svg>
      <div className="fd-type-legend">{types.map((type) => <div key={type.name}><span className="fd-type-name"><i style={{ background: type.color }} />{t(type.name)}</span><strong>{type.count}<small>{t("条", " records")}</small></strong><span className="fd-type-percent">{type.percent}%</span></div>)}</div>
    </div>
    <p className="fd-card-footnote">{t("“投诉”统一展示为“批评”，原始反馈记录保持不变", "Complaints are displayed as criticism; original records are unchanged")}</p>
  </section>;
}

function HandlingOverview({ records, onStatus }) {
  const { t } = useI18n();
  const handling = buildHandlingOverview(records);
  return <section className="fd-panel fd-dashboard-card fd-status-card" aria-label={t("处理概览", "Handling overview")}>
    <header><div><h2><CheckCheck size={17} />{t("处理概览", "Handling overview")}</h2><p>{t("当前处理状态 · 每一份反馈都有回响", "Current status · Every piece of feedback matters")}</p></div></header>
    <div className="fd-handling-summary"><div><strong>{handling.total ? handling.completionRate : "—"}{handling.total > 0 && <small>%</small>}</strong><span>{t("反馈完成率", "Completion rate")}</span></div><p><b>{handling.completed}</b> / {handling.total} {t("条已完成", "completed")}</p></div>
    <div className="fd-handling-states">{handling.statuses.map((state) => <button key={state.name} onClick={() => onStatus?.(state.name)} aria-label={t(`查看${state.name}反馈，${state.count}条`, `View ${t(state.name)} feedback, ${state.count} records`)}><span className="fd-handling-state-name"><i style={{ background: state.color }} />{t(state.name)}</span><span className="fd-handling-track"><i style={{ background: state.color, width: `${state.percent}%` }} /></span><strong>{state.count}</strong><ArrowUpRight size={13} /></button>)}</div>
    <p className="fd-card-footnote">{handling.unknownCount ? t(`${handling.unknownCount} 条状态待核验 · `, `${handling.unknownCount} records have unverified status · `) : ""}{t("点击状态，在下方台账查看对应反馈", "Select a status to view matching feedback in the table below")}</p>
  </section>;
}

export default function FeedbackOverview({ records, month, onNavigate, onStatus, insights, insightsLoading, insightsError, onRetryInsights, toolbar }) {
  const { t } = useI18n();
  return <div className="feedback-overview">
    <ActionBanner onNavigate={onNavigate} />
    {toolbar}
    <div className="fd-dashboard-grid" aria-label={t("反馈数据看板", "Feedback dashboard")}>
      <FeedbackTrend records={records} month={month} />
      <FeedbackTypes records={records} month={month} />
      <section className="fd-panel fd-dashboard-card fd-cloud-card" aria-label={t("反馈热词词云", "Feedback word cloud")}><header><div><h2><MessageSquareText size={17} />{t("反馈热词词云", "Feedback word cloud")}</h2><p>{month || t("全部月份", "All months")} · {t("词越大，提及它的反馈越多", "Larger words appear in more feedback")}</p></div></header><div className="fd-wordcloud-body"><FeedbackWordCloud words={insights?.keywords || []} label={t("反馈热词词云", "Feedback word cloud")} loading={insightsLoading} error={insightsError} onRetry={onRetryInsights} /></div></section>
      <HandlingOverview records={records} onStatus={onStatus} />
    </div>
  </div>;
}
