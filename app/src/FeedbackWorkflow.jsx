import { useEffect, useState } from "react";
import { Check, FileCheck2, Save, Sparkles, X } from "lucide-react";
import { Badge, Empty, Field, Modal } from "./shared";
import { diningApi } from "./api/dining";
import { readable } from "./ui-text";
import FeedbackWordCloud from "./FeedbackWordCloud";
import ActionCard from "./ActionCard";

const actionLabels = { pending: "待审批", approved: "已批准", rejected: "已拒绝" };
const dateText = (value) => value ? new Date(value).toLocaleString("zh-CN") : "时间待核验";

export function ConversionReport({ batch }) {
  const report = batch.report || {};
  return (
    <div className="conversion-report">
      <p className="small">来源 {report.sourceRows ?? "—"} 行 · 已转换 {report.convertedRows ?? "—"} 行 · 与历史表匹配 {report.matchedHistoricalRows ?? 0} 行 · 隔离待核验 {report.quarantinedRows ?? 0} 行</p>
      <div className="actions">
        {batch.xlsxPath && <a className="button" href={diningApi.imports.downloadUrl(batch.id, "xlsx")} download>下载目标格式 XLSX</a>}
        {batch.csvPath && <a className="button" href={diningApi.imports.downloadUrl(batch.id, "csv")} download>下载转换 CSV</a>}
      </div>
      {!!report.issues?.length && <details><summary>待核验与跳过明细 · {report.issues.length}</summary>{report.issues.map((issue, index) => <p className="source" key={index}>{issue.sheet} · 行 {issue.row} · {issue.reason}</p>)}</details>}
      {Object.keys(report.mapping || {}).length > 0 && <details><summary>字段转换映射</summary><pre className="trace-json">{JSON.stringify(report.mapping, null, 2)}</pre></details>}
    </div>
  );
}

export function AiAvailability({ status }) {
  return (
    <p className={`ai-availability ${status?.configured ? "ready" : ""}`}>
      <Sparkles size={15} />
      {status?.configured
        ? `AI 已配置 · ${status.model || "服务端模型"}`
        : status?.reason || "AI 尚未配置，仍可使用本地录入、回复、审批与规则排菜。"}
    </p>
  );
}

function ActionEditor({ action, run, busy, showSource, feedback }) {
  const [draft, setDraft] = useState({
    title: action.title || "",
    description: action.description || "",
    targetStall: action.targetStall || "全部档口",
    menuInstruction: action.menuInstruction || "",
    priority: action.priority || "medium",
    enabled: action.enabled !== false,
    reason: "",
  });
  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = (status) => run(async () => {
    const result = await diningApi.actions.update(action.id, { ...draft, ...(status ? { status } : {}) });
    return status ? `Action ${actionLabels[result.status] || actionLabels[status]}，已保留调整记录` : result.status === "pending" && action.status === "approved" ? "Action 调整已保存，内容变更需要重新审批" : "Action 调整已保存";
  });
  const history = action.history || action.revisions || action.adjustments || [];
  return (
    <div className="action-editor">
      <div className="action-editor-meta">
        <span>{action.targetStall || "全部档口"} · {(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} 条相关反馈 · 版本 {action.revision || 1}</span>
        <span className="badge-group"><Badge tone={action.status === "approved" ? "green" : action.status === "rejected" ? "gray" : "gold"}>{actionLabels[action.status] || action.status}</Badge>{action.enabled === false && <Badge>已停用</Badge>}</span>
      </div>
      {action.demo && <p className="notice">示例事项 · 可编辑、审批并测试模拟排菜。修改预设排菜要求后，模拟器会标记需人工复核。</p>}
      {showSource && <details className="action-evidence"><summary>查看关联反馈与依据（{(action.feedbackIds || [action.feedbackId]).filter(Boolean).length}条）</summary>{(action.feedbackIds || [action.feedbackId]).filter(Boolean).map((id) => { const item = feedback.find((record) => record.id === id); const evidence = (action.evidence || []).filter((entry) => entry.feedbackId === id); return <blockquote key={id}><small>{item?.date || ""} · {item?.restaurant || "来源反馈"} · {id}</small><p>{evidence.map((entry) => entry.quote).join("；") || item?.content || "来源记录暂不可用"}</p></blockquote>; })}</details>}
      <form onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Field label="Action 标题"><input required minLength={2} maxLength={150} value={draft.title} onChange={(event) => update("title", event.target.value)} /></Field>
        <Field label="改善说明"><textarea rows={5} required minLength={2} maxLength={2000} value={draft.description} onChange={(event) => update("description", event.target.value)} /></Field>
        <div className="form-grid">
          <Field label="影响档口"><input required maxLength={100} list="stall-list" placeholder="全部档口" value={draft.targetStall} onChange={(event) => update("targetStall", event.target.value)} /></Field>
          <Field label="优先级"><select value={draft.priority} onChange={(event) => update("priority", event.target.value)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></Field>
        </div>
        <Field label="排菜调整要求"><textarea rows={3} maxLength={2000} value={draft.menuInstruction} onChange={(event) => update("menuInstruction", event.target.value)} placeholder="涉及菜单时填写具体要求；服务、流程等事项可以留空" /></Field>
        <Field label="调整 / 审批理由"><textarea rows={2} maxLength={2000} value={draft.reason} onChange={(event) => update("reason", event.target.value)} placeholder="记录本次调整依据，供运营追溯" /></Field>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />启用此事项（已批准的排菜要求在后续排菜中生效）</label>
        <footer className="form-footer action-footer">
          <button type="submit" disabled={busy || !draft.title.trim() || !draft.description.trim()}><Save size={15} />保存调整</button>
          <button type="button" disabled={busy} onClick={(event) => { if (event.currentTarget.form.reportValidity()) save("rejected"); }}><X size={15} />拒绝</button>
          <button className="primary" type="button" disabled={busy || !draft.title.trim() || !draft.description.trim()} onClick={(event) => { if (event.currentTarget.form.reportValidity()) save("approved"); }}><Check size={15} />批准 / Approve</button>
        </footer>
      </form>
      {history.length > 0 && <details className="audit-details"><summary>调整记录 · {history.length}</summary><div className="timeline">{history.map((item, index) => <div key={item.id || index}><small>{dateText(item.at || item.createdAt)} · 版本 {item.revision || index + 1} · {item.kind || actionLabels[item.status] || "调整"}</small><p>{readable(item.reason || item.note || item.description || item.changes || item.status || item)}</p>{item.previous && <details><summary>修改前的 Action 快照</summary><pre className="trace-json">{JSON.stringify(item.previous, null, 2)}</pre></details>}</div>)}</div></details>}
    </div>
  );
}

export function ActionList({ actions = [], allActions = actions, run, busy, showSource = false, feedback = [], emptyText = "暂无改善事项，可先汇总全部反馈。" }) {
  const [selectedId, setSelectedId] = useState(null);
  // Status changes may remove a card from the filter without dismissing its editor.
  const selected = allActions.find((action) => action.id === selectedId);
  return <>
    {actions.length ? <div className="action-card-grid">{actions.map((action, index) => <ActionCard key={action.id} action={action} index={index} onOpen={() => setSelectedId(action.id)} />)}</div> : <Empty text={emptyText} />}
    {selected && <Modal title={selected.title} onClose={() => setSelectedId(null)} wide>
      <ActionEditor key={`${selected.id}-${selected.revision || selected.updatedAt || selected.status}`} action={selected} run={run} busy={busy} showSource={showSource} feedback={feedback} />
    </Modal>}
  </>;
}

export function FeedbackResponse({ feedback, actions = [], aiStatus, run, busy, onNavigate }) {
  const [reply, setReply] = useState("");
  return (
    <section className="feedback-response">
      <div className="section-heading"><h3>反馈回复</h3><button disabled={busy || !aiStatus?.configured} onClick={() => run(async () => {
        const result = await diningApi.feedback.draftReply(feedback.id);
        setReply(result.feedback?.aiAnalysis?.replyDraft || "");
        return "回复草稿已生成，可编辑后保存";
      })}><Sparkles size={15} />AI 起草回复</button></div>
      <AiAvailability status={aiStatus} />
      {feedback.aiAnalysis && <div className="ai-analysis"><strong>{feedback.aiAnalysis.demo ? "示例回复参考" : "反馈分析"}</strong><p>{readable(feedback.aiAnalysis.summary)}</p><div className="badge-group">{(feedback.aiAnalysis.keywords || []).map((word, index) => <Badge key={index}>{typeof word === "string" ? word : word.text}</Badge>)}</div></div>}
      <form onSubmit={(event) => { event.preventDefault(); run(async () => { await diningApi.feedback.saveReply(feedback.id, reply.trim()); setReply(""); return "回复已保存到本地记录"; }); }}>
        <Field label="反馈回复"><textarea rows={4} maxLength={5000} required value={reply} onChange={(event) => setReply(event.target.value)} placeholder="编辑给反馈人的回复，保存到本地反馈台账" /></Field>
        <div className="reply-toolbar"><small className="muted">此处仅保存回复记录，不会发送邮件或消息。</small><div className="actions">{feedback.aiAnalysis?.replyDraft && <button type="button" onClick={() => setReply(feedback.aiAnalysis.replyDraft)}>{feedback.aiAnalysis.demo ? "使用示例回复草稿" : "使用 AI 回复草稿"}</button>}<button className="primary" disabled={busy || !reply.trim()}><Save size={15} />保存回复</button></div></div>
      </form>
      {feedback.reply && <details><summary>当前回复记录</summary><p className="feedback-full">{feedback.reply}</p></details>}
      {!!feedback.replies?.length && <details><summary>已保存回复 · {feedback.replies.length}</summary><div className="timeline">{feedback.replies.map((item) => <div key={item.id}><small>{dateText(item.at || item.createdAt)}</small><p>{item.text}</p></div>)}</div></details>}
      {!!actions.length && <><h3><FileCheck2 size={16} /> 关联改善事项</h3><p className="muted small">以下事项由多条反馈归纳而来，在 Action 模块统一编辑和审批。</p><div className="linked-actions">{actions.map((action) => <div key={action.id}><strong>{action.title}</strong><Badge>{actionLabels[action.status]}</Badge><small>{(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} 条相关反馈</small></div>)}</div>{onNavigate && <button type="button" onClick={() => onNavigate("actions")}>进入 Action 模块</button>}</>}
    </section>
  );
}

export function MonthlyInsights({ month, feedback, aiStatus, run, busy }) {
  const [response, setResponse] = useState(null);
  const [retry, setRetry] = useState(0);
  const current = response?.month === month && response?.feedback === feedback && response?.retry === retry;
  const result = current ? response.result : null;
  const error = current ? response.error : "";
  const loading = !current;
  useEffect(() => {
    let ignore = false;
    if (!month) return;
    diningApi.feedback.summary(month).then((next) => { if (!ignore) setResponse({ month, feedback, retry, result: next, error: "" }); }).catch((failure) => { if (!ignore) setResponse({ month, feedback, retry, result: null, error: failure.message }); });
    return () => { ignore = true; };
  }, [month, feedback, retry]);
  const keywords = result?.keywords || [];
  if (!month) return <p className="notice">请选择一个月份以查看词云与 AI 月报。</p>;
  return (
    <section className="monthly-insights">
      <div className="section-heading"><h3>本月在讨论什么</h3><button disabled={busy || loading || !aiStatus?.configured || !result?.total} onClick={() => run(async () => { const next = await diningApi.feedback.summarize(month); setResponse({ month, feedback, retry, result: next, error: "" }); return "AI 月度汇总已生成"; })}><Sparkles size={15} />生成 AI 月报</button></div>
      <AiAvailability status={aiStatus} />
      {loading ? <p className="muted">正在整理本月反馈…</p> : error ? <div className="notice" role="alert">{error} <button onClick={() => setRetry((value) => value + 1)}>重试词云</button></div> : !result?.total ? <Empty text="该月暂无反馈，暂无词云或月度摘要" /> : <>
        <FeedbackWordCloud words={keywords} label={`${month} 反馈词云`} />
        <p className="insight-summary">{readable(result.summary)}</p>
        {result.aiSummary && <div className="ai-analysis"><strong>AI 月报</strong><p>{readable(result.aiSummary)}</p></div>}
      </>}
    </section>
  );
}
