import { useEffect, useState } from "react";
import { Check, FileCheck2, Save, Sparkles, X } from "lucide-react";
import { Badge, Empty, Field, Modal } from "./shared";
import { diningApi } from "./api/dining";
import { readable } from "./ui-text";
import FeedbackWordCloud from "./FeedbackWordCloud";
import ActionCard from "./ActionCard";
import { useI18n } from "./i18n";
import { LocalizedInput, LocalizedTextarea } from "./i18n-fields";

const actionLabels = { pending: "待审批", approved: "已批准", rejected: "已拒绝" };
const dateText = (value, locale, t) => value ? new Date(value).toLocaleString(locale) : t("时间待核验", "Time unverified");

function LazyDetails({ title, children, ...props }) {
  const [open, setOpen] = useState(false);
  return <details {...props} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && children()}</details>;
}

export function ConversionReport({ batch }) {
  const { t, tr } = useI18n();
  const report = batch.report || {};
  return (
    <div className="conversion-report">
      <p className="small">{t(`来源 ${report.sourceRows ?? "—"} 行 · 已转换 ${report.convertedRows ?? "—"} 行 · 与历史表匹配 ${report.matchedHistoricalRows ?? 0} 行 · 隔离待核验 ${report.quarantinedRows ?? 0} 行`, `Source: ${report.sourceRows ?? "—"} rows · Converted: ${report.convertedRows ?? "—"} · Matched to history: ${report.matchedHistoricalRows ?? 0} · Quarantined for review: ${report.quarantinedRows ?? 0}`)}</p>
      <div className="actions">
        {batch.xlsxPath && <a className="button" href={diningApi.imports.downloadUrl(batch.id, "xlsx")} download>{t("下载目标格式 XLSX", "Download formatted XLSX")}</a>}
        {batch.csvPath && <a className="button" href={diningApi.imports.downloadUrl(batch.id, "csv")} download>{t("下载转换 CSV", "Download converted CSV")}</a>}
      </div>
      {!!report.issues?.length && <LazyDetails title={<>{t("待核验与跳过明细", "Items requiring review or skipped")} · {report.issues.length}</>}>{() => report.issues.map((issue, index) => <p className="source" key={index}>{tr(issue.sheet)} · {t("行", "Row")} {issue.row} · {tr(issue.reason)}</p>)}</LazyDetails>}
      {Object.keys(report.mapping || {}).length > 0 && <LazyDetails title={t("字段转换映射", "Column mappings")}>{() => <pre className="trace-json">{tr(JSON.stringify(report.mapping, null, 2))}</pre>}</LazyDetails>}
    </div>
  );
}

export function AiAvailability({ status }) {
  const { t, tr } = useI18n();
  return (
    <p className={`ai-availability ${status?.configured ? "ready" : ""}`}>
      <Sparkles size={15} />
      {status?.configured
        ? t(`AI 已配置 · ${status.model || "服务端模型"}`, `AI configured · ${status.model || "Server model"}`)
        : status?.reason ? tr(status.reason) : t("AI 尚未配置，仍可使用本地录入、回复、审批与规则排菜。", "AI is not configured. Local entry, replies, approvals and rule-based planning remain available.")}
    </p>
  );
}

function ActionEditor({ action, run, busy, showSource, feedback, onSaved, onSavingChange }) {
  const { t, tr, locale } = useI18n();
  const [saveError, setSaveError] = useState("");
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
  const save = (status) => {
    if (busy) return;
    return run(async () => {
      setSaveError("");
      onSavingChange(true);
      let result;
      try { result = await diningApi.actions.update(action.id, { ...draft, ...(status ? { status } : {}) }); }
      catch (error) { setSaveError(error.message); throw error; }
      finally { onSavingChange(false); }
      // The write, not the later workspace refresh, completes this dialog.
      // Never dismiss after a failed request or just because run() has resolved.
      onSaved();
      return status ? t(`Action ${actionLabels[result.status] || actionLabels[status]}，已保留调整记录`, `Action ${t(actionLabels[result.status] || actionLabels[status])}; change history retained`) : result.status === "pending" && action.status === "approved" ? t("Action 调整已保存，内容变更需要重新审批", "Action changes saved. Content changes require approval again.") : t("Action 调整已保存", "Action changes saved");
    });
  };
  const history = action.history || action.revisions || action.adjustments || [];
  return (
    <div className="action-editor">
      <div className="action-editor-meta">
        <span>{action.targetStall === "全部档口" || !action.targetStall ? t("全部档口", "All stalls") : action.targetStall} · {t(`${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} 条相关反馈 · 版本 ${action.revision || 1}`, `${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} related records · Version ${action.revision || 1}`)}</span>
        <span className="badge-group"><Badge tone={action.status === "approved" ? "green" : action.status === "rejected" ? "gray" : "gold"}>{t(actionLabels[action.status] || action.status)}</Badge>{action.enabled === false && <Badge>{t("已停用", "Disabled")}</Badge>}</span>
      </div>
      {action.demo && <p className="notice">{t("示例事项 · 可编辑、审批并测试模拟排菜。修改预设排菜要求后，模拟器会标记需人工复核。", "Demo action · Edit, approve and test simulated planning. Changes to preset instructions require manual review.")}</p>}
      {showSource && <details className="action-evidence"><summary>{t(`查看关联反馈与依据（${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length}条）`, `View related feedback and evidence (${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} records)`)}</summary>{(action.feedbackIds || [action.feedbackId]).filter(Boolean).map((id) => { const item = feedback.find((record) => record.id === id); const evidence = (action.evidence || []).filter((entry) => entry.feedbackId === id); return <blockquote key={id}><small>{item?.date || ""} · {item?.restaurant || t("来源反馈", "Source feedback")} · {id}</small><p>{evidence.map((entry) => entry.quote).join("；") || item?.content || t("来源记录暂不可用", "Source record is currently unavailable")}</p></blockquote>; })}</details>}
      <form onSubmit={(event) => { event.preventDefault(); save(); }}>
        {saveError && <p role="alert" className="notice">{tr(saveError)}</p>}
        <Field label={t("Action 标题", "Action title")}><LocalizedInput required minLength={2} maxLength={150} value={draft.title} onChange={(event) => update("title", event.target.value)} /></Field>
        <Field label={t("改善说明", "Improvement description")}><LocalizedTextarea rows={5} required minLength={2} maxLength={2000} value={draft.description} onChange={(event) => update("description", event.target.value)} /></Field>
        <div className="form-grid">
          <Field label={t("影响档口", "Affected stall")}><input required maxLength={100} list="stall-list" placeholder={t("全部档口", "All stalls")} value={draft.targetStall} onChange={(event) => update("targetStall", event.target.value)} /></Field>
          <Field label={t("优先级", "Priority")}><select value={draft.priority} onChange={(event) => update("priority", event.target.value)}><option value="high">{t("高", "High")}</option><option value="medium">{t("中", "Medium")}</option><option value="low">{t("低", "Low")}</option></select></Field>
        </div>
        <Field label={t("排菜调整要求", "Menu adjustment instructions")}><LocalizedTextarea rows={3} maxLength={2000} value={draft.menuInstruction} onChange={(event) => update("menuInstruction", event.target.value)} placeholder={t("涉及菜单时填写具体要求；服务、流程等事项可以留空", "Enter specific menu requirements; leave blank for service or process actions")} /></Field>
        <Field label={t("调整 / 审批理由", "Change / approval reason")}><textarea rows={2} maxLength={2000} value={draft.reason} onChange={(event) => update("reason", event.target.value)} placeholder={t("记录本次调整依据，供运营追溯", "Record the reason for this change for future reference")} /></Field>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />{t("启用此事项（已批准的排菜要求在后续排菜中生效）", "Enable this action (approved menu instructions apply to future planning)")}</label>
        <footer className="form-footer action-footer">
          <button type="submit" disabled={busy || !draft.title.trim() || !draft.description.trim()}><Save size={15} />{t("保存调整", "Save changes")}</button>
          <button type="button" disabled={busy} onClick={(event) => { if (event.currentTarget.form.reportValidity()) save("rejected"); }}><X size={15} />{t("拒绝", "Reject")}</button>
          <button className="primary" type="button" disabled={busy || !draft.title.trim() || !draft.description.trim()} onClick={(event) => { if (event.currentTarget.form.reportValidity()) save("approved"); }}><Check size={15} />{t("批准 / Approve", "Approve")}</button>
        </footer>
      </form>
      {history.length > 0 && <LazyDetails className="audit-details" title={<>{t("调整记录", "Change history")} · {history.length}</>}>{() => <div className="timeline">{history.map((item, index) => <div key={item.id || index}><small>{dateText(item.at || item.createdAt, locale, t)} · {t("版本", "Version")} {item.revision || index + 1} · {tr(item.kind || actionLabels[item.status] || t("调整", "Change"))}</small><p>{tr(readable(item.reason || item.note || item.description || item.changes || item.status || item))}</p>{item.previous && <LazyDetails title={t("修改前的 Action 快照", "Action before this change")}>{() => <pre className="trace-json">{JSON.stringify(item.previous, null, 2)}</pre>}</LazyDetails>}</div>)}</div>}</LazyDetails>}
    </div>
  );
}

export function ActionList({ actions = [], allActions = actions, run, busy, showSource = false, feedback = [], emptyText = "暂无改善事项，可先汇总全部反馈。" }) {
  const { t, tr } = useI18n();
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  // Resolve against the full list so filtering never discards an unsaved draft.
  const selected = allActions.find((action) => action.id === selectedId);
  return <>
    {actions.length ? <div className="action-card-grid">{actions.map((action, index) => <ActionCard key={action.id} action={action} index={index} onOpen={() => setSelectedId(action.id)} />)}</div> : <Empty text={emptyText === "暂无改善事项，可先汇总全部反馈。" ? t(emptyText, "No improvement actions yet. Start by summarizing all feedback.") : tr(emptyText)} />}
    {selected && <Modal title={tr(selected.title)} onClose={() => setSelectedId(null)} busy={saving} wide>
      <ActionEditor key={`${selected.id}-${selected.revision || selected.updatedAt || selected.status}`} action={selected} run={run} busy={busy} showSource={showSource} feedback={feedback} onSaved={() => setSelectedId(null)} onSavingChange={setSaving} />
    </Modal>}
  </>;
}

export function FeedbackResponse({ feedback, actions = [], aiStatus, run, busy, onNavigate }) {
  const { t, tr, locale } = useI18n();
  const [reply, setReply] = useState("");
  return (
    <section className="feedback-response">
      <div className="section-heading"><h3>{t("反馈回复", "Feedback reply")}</h3><button disabled={busy || !aiStatus?.configured} onClick={() => run(async () => {
        const result = await diningApi.feedback.draftReply(feedback.id);
        setReply(result.feedback?.aiAnalysis?.replyDraft || "");
        return t("回复草稿已生成，可编辑后保存", "Reply draft generated. Edit it before saving.");
      })}><Sparkles size={15} />{t("AI 起草回复", "Draft reply with AI")}</button></div>
      <AiAvailability status={aiStatus} />
      {feedback.aiAnalysis && <div className="ai-analysis"><strong>{feedback.aiAnalysis.demo ? t("示例回复参考", "Example reply") : t("反馈分析", "Feedback analysis")}</strong><p>{tr(readable(feedback.aiAnalysis.summary))}</p><div className="badge-group">{(feedback.aiAnalysis.keywords || []).map((word, index) => <Badge key={index}>{tr(typeof word === "string" ? word : word.text)}</Badge>)}</div></div>}
      <form onSubmit={(event) => { event.preventDefault(); run(async () => { await diningApi.feedback.saveReply(feedback.id, reply.trim()); setReply(""); return t("回复已保存到本地记录", "Reply saved to the local record"); }); }}>
        <Field label={t("反馈回复", "Feedback reply")}><LocalizedTextarea rows={4} maxLength={5000} required value={reply} onChange={(event) => setReply(event.target.value)} placeholder={t("编辑给反馈人的回复，保存到本地反馈台账", "Edit a reply to the author and save it in the local feedback records")} /></Field>
        <div className="reply-toolbar"><small className="muted">{t("此处仅保存回复记录，不会发送邮件或消息。", "This saves a reply record only; no email or message is sent.")}</small><div className="actions">{feedback.aiAnalysis?.replyDraft && <button type="button" onClick={() => setReply(feedback.aiAnalysis.replyDraft)}>{feedback.aiAnalysis.demo ? t("使用示例回复草稿", "Use example reply draft") : t("使用 AI 回复草稿", "Use AI reply draft")}</button>}<button className="primary" disabled={busy || !reply.trim()}><Save size={15} />{t("保存回复", "Save reply")}</button></div></div>
      </form>
      {feedback.reply && <LazyDetails title={t("当前回复记录", "Current reply")}>{() => <p className="feedback-full">{tr(feedback.reply)}</p>}</LazyDetails>}
      {!!feedback.replies?.length && <LazyDetails title={<>{t("已保存回复", "Saved replies")} · {feedback.replies.length}</>}>{() => <div className="timeline">{feedback.replies.map((item) => <div key={item.id}><small>{dateText(item.at || item.createdAt, locale, t)}</small><p>{tr(item.text)}</p></div>)}</div>}</LazyDetails>}
      {!!actions.length && <><h3><FileCheck2 size={16} /> {t("关联改善事项", "Related improvement actions")}</h3><p className="muted small">{t("以下事项由多条反馈归纳而来，在 Action 模块统一编辑和审批。", "These actions combine multiple feedback records. Edit and approve them in the Actions module.")}</p><div className="linked-actions">{actions.map((action) => <div key={action.id}><strong>{tr(action.title)}</strong><Badge>{t(actionLabels[action.status])}</Badge><small>{t(`${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} 条相关反馈`, `${(action.feedbackIds || [action.feedbackId]).filter(Boolean).length} related records`)}</small></div>)}</div>{onNavigate && <button type="button" onClick={() => onNavigate("actions")}>{t("进入 Action 模块", "Open Actions")}</button>}</>}
    </section>
  );
}

export function MonthlyInsights({ month, feedback, aiStatus, run, busy }) {
  const { t, tr } = useI18n();
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
  if (!month) return <p className="notice">{t("请选择一个月份以查看词云与 AI 月报。", "Select a month to view the word cloud and AI report.")}</p>;
  return (
    <section className="monthly-insights">
      <div className="section-heading"><h3>{t("本月在讨论什么", "What people are discussing this month")}</h3><button disabled={busy || loading || !aiStatus?.configured || !result?.total} onClick={() => run(async () => { const next = await diningApi.feedback.summarize(month); setResponse({ month, feedback, retry, result: next, error: "" }); return t("AI 月度汇总已生成", "AI monthly summary generated"); })}><Sparkles size={15} />{t("生成 AI 月报", "Generate AI monthly report")}</button></div>
      <AiAvailability status={aiStatus} />
      {loading ? <p className="muted">{t("正在整理本月反馈…", "Preparing this month's feedback…")}</p> : error ? <div className="notice" role="alert">{tr(error)} <button onClick={() => setRetry((value) => value + 1)}>{t("重试词云", "Retry word cloud")}</button></div> : !result?.total ? <Empty text={t("该月暂无反馈，暂无词云或月度摘要", "No feedback, word cloud or summary is available for this month")} /> : <>
        <FeedbackWordCloud words={keywords} label={t(`${month} 反馈词云`, `${month} feedback word cloud`)} />
        <p className="insight-summary">{tr(readable(result.summary))}</p>
        {result.aiSummary && <div className="ai-analysis"><strong>{t("AI 月报", "AI monthly report")}</strong><p>{tr(readable(result.aiSummary))}</p></div>}
      </>}
    </section>
  );
}
