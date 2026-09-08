import { useEffect, useState } from "react";
import { ClipboardCheck, FlaskConical, RefreshCw, Sparkles } from "lucide-react";
import { AiAvailability } from "./FeedbackWorkflow";
import { Badge, Empty } from "./shared";
import { request } from "./api";

export default function FeedbackActionsPanel({ data, demo, run, busy, onLoadDemo, onNavigate }) {
  const [month, setMonth] = useState("");
  const [response, setResponse] = useState(null);
  const [retry, setRetry] = useState(0);
  const current = response?.month === month && response?.demo === demo && response?.actions === data.actions && response?.retry === retry;
  useEffect(() => {
    let ignore = false;
    request(`/actions/summary?month=${encodeURIComponent(month)}&demo=${demo}`).then((result) => { if (!ignore) setResponse({ result, month, demo, actions: data.actions, retry }); }).catch((failure) => { if (!ignore) setResponse({ error: failure.message, month, demo, actions: data.actions, retry }); });
    return () => { ignore = true; };
  }, [month, demo, data.actions, retry]);
  const result = current ? response.result : null;
  const sourceCount = result?.sourceCount ?? data.feedback.filter((item) => !item.summaryRecord && !item.quarantined && !!item.demo === demo && (!month || item.date?.startsWith(month))).length;
  const actions = result?.actions || [];
  return (
    <section className="fd-panel fd-aggregate" id="feedback-improvements" aria-label="汇总改善事项">
      <header>
        <div><h2><ClipboardCheck size={19} />从反馈到改善事项{demo && <Badge tone="gold">示例</Badge>}</h2><p>汇总多条反馈形成少量可执行事项，运营审核后再影响排菜。</p></div>
        <button disabled={busy} onClick={onLoadDemo}><FlaskConical size={16} />加载示例 Action</button>
      </header>
      <div className="fd-aggregate-toolbar">
        <label>汇总范围<select aria-label="改善事项汇总范围" value={month ? "month" : "all"} onChange={(event) => setMonth(event.target.value === "all" ? "" : new Date().toLocaleDateString("en-CA").slice(0, 7))}><option value="all">全部{demo ? "示例" : "真实"}反馈</option><option value="month">按月份</option></select></label>
        {month && <input type="month" aria-label="改善事项汇总月份" value={month} onChange={(event) => setMonth(event.target.value)} />}
        <span className="fd-scope-count">{sourceCount} 条{demo ? "示例" : "真实"}反馈</span>
        <button className="primary" disabled={busy || !sourceCount || !data.aiStatus?.configured} onClick={() => run(async () => { const next = await request("/actions/summarize", { month, demo }); setResponse({ result: next, month, demo, actions: data.actions, retry }); return `已汇总 ${next.analysis?.sourceCount || sourceCount} 条反馈，整理 ${next.actions?.length || 0} 项改善事项`; })}><Sparkles size={15} />汇总反馈生成改善事项</button>
        <button onClick={() => onNavigate?.("actions")}>进入 Action 模块</button>
      </div>
      <AiAvailability status={data.aiStatus} />
      {demo && <p className="fd-demo-notice">示例反馈与事项仅用于审批和模拟排菜测试，不计入正式反馈统计。</p>}
      {current && response.error ? (
        <p className="notice" role="alert">{response.error}<button onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新加载事项</button></p>
      ) : !current ? <p className="muted small">正在读取跨反馈改善事项…</p> : (
        <>
          {result?.analysis && <div className="fd-aggregate-summary"><strong>{result.analysis.sourceCount || sourceCount} 条反馈 · 汇总归纳</strong><p>{result.analysis.summary}</p><small>{result.analysis.createdAt ? new Date(result.analysis.createdAt).toLocaleString("zh-CN") : ""}</small></div>}
          {actions.length ? (
            <>
              <div className="fd-aggregate-count"><span>{actions.length} 项改善事项</span><small>编辑、批准和拒绝统一在 Action 模块完成</small></div>
              <div className="fd-action-previews">{actions.slice(0, 6).map((action) => (
                <button key={action.id} onClick={() => onNavigate?.("actions")}>
                  <span><strong>{action.title}</strong><small>关联 {action.feedbackIds?.length || (action.feedbackId ? 1 : 0)} 条反馈 · {action.targetStall || "全部档口"}</small>{action.evidence?.[0]?.quote && <em>“{action.evidence[0].quote}”</em>}</span>
                  <Badge tone={action.status === "approved" ? "green" : action.status === "rejected" ? "gray" : "gold"}>{{ pending: "待审批", approved: "已批准", rejected: "已拒绝" }[action.status] || action.status}</Badge>
                </button>
              ))}</div>
            </>
          ) : <Empty text={sourceCount ? "尚未汇总出改善事项。可先汇总反馈，或加载示例体验审批。" : "当前范围暂无反馈，请先上传旧表或录入反馈。"} />}
        </>
      )}
    </section>
  );
}
