import { useEffect, useState } from "react";
import { ArrowRight, CheckCheck, FlaskConical, Layers3, ListChecks, Sparkles } from "lucide-react";
import { Badge, Empty, Metric } from "./shared";
import { ActionList } from "./FeedbackWorkflow";
import { diningApi } from "./api/dining";
import "./actions.css";

export default function Actions({ data, run, busy, onNavigate }) {
  const [demo, setDemo] = useState(false);
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const feedback = data.feedback.filter((item) => Boolean(item.demo) === demo && !item.summaryRecord && !item.quarantined && (!month || item.date?.startsWith(month)));
  const ids = new Set(feedback.map((item) => item.id));
  const actions = (data.actions || []).filter((item) => item.feedbackIds?.length && Boolean(item.demo) === demo && item.feedbackIds.some((id) => ids.has(id)));
  const visible = actions.filter((item) => !status || item.status === status);
  useEffect(() => {
    let ignore = false;
    diningApi.actions.summary({ month, demo }).then((result) => { if (!ignore) { setSummary({ ...result, month, demo }); setSummaryError(""); } }).catch((error) => { if (!ignore) setSummaryError(error.message); });
    return () => { ignore = true; };
  }, [month, demo, data.actions, data.feedback]);
  const current = summary?.month === month && summary?.demo === demo ? summary : null;
  const loadDemo = () => run(async () => { const result = await diningApi.actions.loadDemo(); setDemo(true); setMonth(""); setStatus(""); return `示例已就绪：${result.feedbackIds.length} 条反馈归纳为 ${result.actionIds.length} 个事项，可直接编辑审批`; });
  const approved = actions.filter((item) => item.status === "approved" && item.enabled);
  return <div className="action-module">
    <header className="action-page-heading"><div><span className="eyebrow">IMPROVEMENT / ACTIONS</span><h1>Action 事项</h1><p>从多条反馈中归纳共同问题，把改善措施统一管理和审批。</p></div><button onClick={loadDemo} disabled={busy}><FlaskConical size={17} />加载示例 Action</button></header>
    <div className="action-scope"><div className="segmented" role="group" aria-label="事项数据范围"><button className={!demo ? "active" : ""} aria-pressed={!demo} onClick={() => setDemo(false)}>真实反馈事项</button><button className={demo ? "active" : ""} aria-pressed={demo} onClick={() => setDemo(true)}>示例事项</button></div><label>反馈范围 <input type="month" aria-label="事项反馈月份" value={month} onChange={(event) => setMonth(event.target.value)} /></label>{month ? <button className="text-button" onClick={() => setMonth("")}>使用全部反馈</button> : <Badge>全部月份</Badge>}</div>
    {demo && <p className="demo-notice"><FlaskConical size={18} />这些是功能测试样例，正式统计和正式排菜会排除示例事项。可以先批准一个排菜事项，再到六周菜单选择“模拟排菜测试”。</p>}
    <div className="metrics action-metrics"><Metric label="汇总来源" value={feedback.length} detail="条反馈 · 可共同支撑同一事项" icon={Layers3} color="blue" /><Metric label="改善事项" value={actions.length} detail="按共同问题归纳" icon={ListChecks} /><Metric label="等待审批" value={actions.filter((item) => item.status === "pending").length} detail="确认内容后批准或拒绝" icon={Sparkles} color="gold" /><Metric label="已批准启用" value={approved.length} detail={`${approved.filter((item) => item.menuInstruction).length} 项涉及排菜`} icon={CheckCheck} /></div>
    <section className="work-section action-summary-section"><div className="section-heading"><h2>汇总反馈，整理改善事项</h2><button className="primary" disabled={busy || !feedback.length || !data.aiStatus?.configured} onClick={() => run(async () => { const result = await diningApi.actions.summarize({ month, demo }); setSummary({ ...result, month, demo }); return `已汇总 ${result.sourceCount} 条反馈，整理 ${result.actions.length} 个改善事项`; })}><Sparkles size={16} />汇总反馈生成改善事项</button></div><p>系统读取选定范围的全部反馈，合并相似诉求，形成少量可执行事项。每项保留相关反馈作为依据；运营只需调整事项内容并审批。</p>{current?.analysis ? <div className="aggregate-summary"><Badge>{current.analysis.sourceCount} 条反馈</Badge><p>{current.analysis.summary}</p></div> : demo ? <p className="muted">预置样例已整理为 4 个事项，可不调用 AI 直接测试编辑与审批。</p> : <p className="muted">尚未汇总该范围，点击按钮生成改善事项。</p>}{summaryError && <p className="notice">{summaryError}</p>}</section>
    <section className="work-section"><div className="section-heading"><h2>事项清单 <span>{visible.length}</span></h2><select aria-label="Action 审批状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="pending">待审批</option><option value="approved">已批准</option><option value="rejected">已拒绝</option></select></div><p className="muted small">展开事项可修改内容、查看关联反馈并审批。修改已批准内容后会重新等待审批。</p>{actions.length ? <ActionList actions={visible} run={run} busy={busy} showSource feedback={data.feedback} /> : <Empty text={demo ? "点击“加载示例 Action”准备测试数据" : "汇总反馈后将在此展示改善事项"} />}</section>
    <div className="action-next-step"><div><strong>批准后，让改善要求进入排菜</strong><p>服务流程等事项保留在清单中；填写了排菜要求的已批准事项参与下一次六周菜单。</p></div><button onClick={() => onNavigate("menus")}>前往六周菜单 <ArrowRight size={16} /></button></div>
  </div>;
}
