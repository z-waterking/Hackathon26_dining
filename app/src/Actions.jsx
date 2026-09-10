import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { Badge } from "./shared";
import { ActionList } from "./FeedbackWorkflow";
import ActionGenerationWait from "./ActionGenerationWait";
import { diningApi } from "./api/dining";
import "./actions.css";

export default function Actions({ data, run, busy, onNavigate }) {
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationScope, setGenerationScope] = useState({ count: 0, month: "" });
  const actionBusy = busy || generating;
  const feedback = data.feedback.filter((item) => !item.demo && !item.summaryRecord && !item.quarantined && (!month || item.date?.startsWith(month)));
  const ids = new Set(feedback.map((item) => item.id));
  const actions = (data.actions || []).filter((item) => !item.demo && item.source === "aggregate" && item.feedbackIds?.some((id) => ids.has(id)));
  const visible = actions.filter((item) => !status || item.status === status);
  useEffect(() => {
    let ignore = false;
    diningApi.actions.summary({ month, demo: false }).then((result) => {
      if (!ignore) { setSummary({ ...result, month }); setSummaryError(""); }
    }).catch((error) => { if (!ignore) setSummaryError(error.message); });
    return () => { ignore = true; };
  }, [month, data.actions, data.feedback]);
  const current = summary?.month === month ? summary : null;
  const generate = async () => {
    if (busy || generating) return;
    setGenerationScope({ count: feedback.length, month });
    setGenerating(true); setGenerationError("");
    try {
      await run(async () => {
        try {
          // Explicit generation calls the configured model; opening the page does not.
          // Failed requests never substitute sample data for genuine model output.
          const result = await diningApi.actions.summarize({ month, demo: false, force: true });
          setSummary({ ...result, month }); setSummaryError(""); setStatus("");
          return result.analysis ? `AI 已分析 ${result.sourceCount} 条真实反馈，${result.actions.length} 个事项可查看和审批` : "该范围暂无可分析的真实反馈";
        } catch (error) { setGenerationError(error.message); throw error; }
      }, { background: true });
    }
    finally { setGenerating(false); }
  };
  return <div className="action-module">
    <header className="action-page-heading"><div><span className="eyebrow">FEEDBACK TO ACTION</span><h1>Action 事项</h1><p>AI 分析真实反馈，提出具体改善措施。确认后再执行。</p></div>
      <button className="primary" disabled={actionBusy || !feedback.length || !data.aiStatus?.configured} onClick={generate}>
        {generating ? <LoaderCircle size={17} className="action-spinner" /> : <Sparkles size={17} />}
        {generating ? "AI 正在分析真实反馈…" : "AI 生成改善事项"}
      </button>
    </header>
    <div className="action-scope"><label>反馈月份 <input type="month" aria-label="事项反馈月份" value={month} disabled={actionBusy} onChange={(event) => { setMonth(event.target.value); setGenerationError(""); }} /></label>
      {month ? <button className="text-button" disabled={actionBusy} onClick={() => setMonth("")}>使用全部反馈</button> : <Badge>全部月份</Badge>}
      <span className="action-counts">{feedback.length} 条真实反馈 · {actions.filter((item) => item.status === "pending").length} 项待审批 · {actions.filter((item) => item.status === "approved").length} 项已批准</span>
    </div>
    {generating && <ActionGenerationWait count={generationScope.count} month={generationScope.month} />}
    {!data.aiStatus?.configured && <p className="notice" role="alert">{data.aiStatus?.reason || "AI 服务未配置，请配置服务端后重启。"}</p>}
    {(generationError || summaryError) && <p className="notice action-error" role="alert">{generationError || summaryError}。已有事项保持不变，可重试。</p>}
    {current?.analysis && <details className="action-analysis"><summary>最近 AI 分析 · {current.analysis.sourceCount} 条反馈 · {new Date(current.analysis.createdAt).toLocaleString("zh-CN")}</summary><p>{current.analysis.summary}</p></details>}
    <section className="work-section action-items"><div className="section-heading"><h2>改善事项 <span>{visible.length}</span></h2><select aria-label="Action 审批状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="pending">待审批</option><option value="approved">已批准</option><option value="rejected">已拒绝</option></select></div>
      <p className="muted small">让每个建议都有下一步。查看卡片了解措施与反馈依据，确认后再审批。</p>
      <ActionList actions={visible} allActions={actions} run={run} busy={actionBusy} showSource feedback={data.feedback.filter((item) => !item.demo)} emptyText={status ? "当前状态下没有事项" : current?.analysis ? "本次分析未发现需要新增的改善事项" : "点击「AI 生成改善事项」，从真实反馈中整理可执行的改进。"} />
    </section>
    <div className="action-footer-note"><p>已批准并启用的排菜要求参与下一次六周菜单；服务与流程改善由运营跟进。</p><button className="text-button" onClick={() => onNavigate("menus")}>前往六周菜单 <ArrowRight size={15} /></button></div>
  </div>;
}
