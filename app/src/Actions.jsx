import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { Badge } from "./shared";
import { ActionList } from "./FeedbackWorkflow";
import ActionGenerationWait from "./ActionGenerationWait";
import { diningApi } from "./api/dining";
import { createGenerationId } from "./generation-id";
import { useI18n } from "./i18n";
import "./actions.css";

export default function Actions({ data, run, busy, onNavigate }) {
  const { t, tr, locale } = useI18n();
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [cancelState, setCancelState] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const generationInFlight = useRef(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
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
  const cancelGeneration = async () => {
    const generation = generationInFlight.current;
    if (!generation || generation.finished || generation.cancelPending) return;
    generation.cancelPending = true;
    setCancelState("cancelling"); setCancelError("");
    try {
      const result = await diningApi.generations.cancel(generation.id);
      if (generationInFlight.current !== generation || generation.finished) return;
      // Cancellation is acknowledged here, but only the original request can
      // confirm that generation stopped. Never abort the browser as a substitute.
      setCancelState(result.cancelled ? "cancelling" : "finishing");
    } catch (error) {
      if (generationInFlight.current !== generation || generation.finished) return;
      generation.cancelPending = false;
      setCancelState(""); setCancelError(error.message);
    }
  };
  const generate = async () => {
    if (busy || generationInFlight.current) return;
    let id;
    try { id = createGenerationId(); }
    catch { setGenerationError(t("浏览器无法创建安全的生成标识，请使用支持 Web Crypto 的浏览器。", "The browser cannot create a secure generation ID. Use a browser that supports Web Crypto.")); return; }
    const generation = { id, cancelPending: false, finished: false };
    generationInFlight.current = generation;
    setGenerationScope({ count: feedback.length, month });
    setGenerating(true); setGenerationError(""); setCancelError(""); setCancelState(""); setCancelled(false);
    try {
      await run(async () => {
        try {
          // Explicit generation calls the configured model; opening the page does not.
          // Failed requests never substitute sample data for genuine model output.
          const result = await diningApi.actions.summarize({ month, demo: false, force: true, generationId: generation.id });
          generation.finished = true;
          setSummary({ ...result, month }); setSummaryError(""); setStatus("");
          return result.analysis ? t(`AI 已分析 ${result.sourceCount} 条真实反馈，${result.actions.length} 个事项可查看和审批`, `AI analyzed ${result.sourceCount} feedback records. ${result.actions.length} actions are ready for review and approval.`) : t("该范围暂无可分析的真实反馈", "No real feedback is available to analyze in this scope.");
        } catch (error) {
          generation.finished = true;
          if (error.code === "GENERATION_CANCELLED") {
            setCancelled(true);
            return t("已取消 Action 生成，已有事项保持不变。", "Action generation cancelled. Existing actions are unchanged.");
          }
          setGenerationError(error.message); throw error;
        }
      }, { background: true });
    }
    finally {
      if (generationInFlight.current === generation) {
        generationInFlight.current = null;
        setGenerating(false); setCancelState(""); setCancelError("");
      }
    }
  };
  return <div className="action-module">
    <header className="action-page-heading"><div><span className="eyebrow">FEEDBACK TO ACTION</span><h1>{t("Action 事项", "Actions")}</h1><p>{t("AI 分析真实反馈，提出具体改善措施。确认后再执行。", "AI analyzes real feedback and proposes specific improvements. Review and approve them before implementation.")}</p></div>
      <button className="primary" disabled={actionBusy || !feedback.length || !data.aiStatus?.configured} onClick={generate}>
        {generating ? <LoaderCircle size={17} className="action-spinner" /> : <Sparkles size={17} />}
        {generating ? t("AI 正在分析真实反馈…", "AI is analyzing feedback…") : t("AI 生成改善事项", "Generate improvement actions")}
      </button>
    </header>
    <div className="action-scope"><label>{t("反馈月份", "Feedback month")} <input type="month" aria-label={t("事项反馈月份", "Action feedback month")} value={month} disabled={actionBusy} onChange={(event) => { setMonth(event.target.value); setGenerationError(""); }} /></label>
      {month ? <button className="text-button" disabled={actionBusy} onClick={() => setMonth("")}>{t("使用全部反馈", "Use all feedback")}</button> : <Badge>{t("全部月份", "All months")}</Badge>}
      <span className="action-counts">{t(`${feedback.length} 条真实反馈 · ${actions.filter((item) => item.status === "pending").length} 项待审批 · ${actions.filter((item) => item.status === "approved").length} 项已批准`, `${feedback.length} feedback records · ${actions.filter((item) => item.status === "pending").length} pending · ${actions.filter((item) => item.status === "approved").length} approved`)}</span>
    </div>
    {generating && <ActionGenerationWait count={generationScope.count} month={generationScope.month} onCancel={cancelGeneration} cancelState={cancelState} cancelError={cancelError} />}
    {cancelled && !generating && <p className="notice action-cancelled" role="status">{t("已取消 Action 生成，已有事项保持不变。", "Action generation cancelled. Existing actions are unchanged.")}</p>}
    {!data.aiStatus?.configured && <p className="notice" role="alert">{data.aiStatus?.reason ? tr(data.aiStatus.reason) : t("AI 服务未配置，请配置服务端后重启。", "AI is not configured. Configure the server and restart it.")}</p>}
    {(generationError || summaryError) && <p className="notice action-error" role="alert">{tr(generationError || summaryError)}{t("。已有事项保持不变，可重试。", ". Existing actions are unchanged. You can retry.")}</p>}
    {current?.analysis && <details className="action-analysis" onToggle={(event) => setAnalysisOpen(event.currentTarget.open)}><summary>{t(`最近 AI 分析 · ${current.analysis.sourceCount} 条反馈 · `, `Latest AI analysis · ${current.analysis.sourceCount} feedback records · `)}{new Date(current.analysis.createdAt).toLocaleString(locale)}</summary><p>{analysisOpen ? tr(current.analysis.summary) : current.analysis.summary}</p></details>}
    <section className="work-section action-items"><div className="section-heading"><h2>{t("改善事项", "Improvement actions")} <span>{visible.length}</span></h2><select aria-label={t("Action 审批状态", "Action approval status")} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("全部状态", "All statuses")}</option><option value="pending">{t("待审批", "Pending approval")}</option><option value="approved">{t("已批准", "Approved")}</option><option value="rejected">{t("已拒绝", "Rejected")}</option></select></div>
      <p className="muted small">{t("让每个建议都有下一步。查看卡片了解措施与反馈依据，确认后再审批。", "Give each suggestion a next step. Review each card’s proposed changes and feedback evidence before approval.")}</p>
      <ActionList actions={visible} allActions={actions} run={run} busy={actionBusy} showSource feedback={data.feedback.filter((item) => !item.demo)} emptyText={status ? t("当前状态下没有事项", "No actions with this status.") : current?.analysis ? t("本次分析未发现需要新增的改善事项", "This analysis found no new improvement actions to add.") : t("点击「AI 生成改善事项」，从真实反馈中整理可执行的改进。", "Select “Generate improvement actions” to turn real feedback into actionable improvements.")} />
    </section>
    <div className="action-footer-note"><p>{t("已批准并启用的排菜要求参与下一次六周菜单；服务与流程改善由运营跟进。", "Approved and enabled menu requirements apply to the next six-week menu. Operations follows up on service and process improvements.")}</p><button className="text-button" onClick={() => onNavigate("menus")}>{t("前往六周菜单", "Go to six-week menus")} <ArrowRight size={15} /></button></div>
  </div>;
}
