import { useId } from "react";
import { Sparkles } from "lucide-react";
import { useI18n } from "./i18n";

export default function ActionGenerationWait({ count, month, onCancel, cancelState = "", cancelError = "" }) {
  const { t, tr } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  return <section className="action-generation-wait" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <div className="action-wait-art" aria-hidden="true">
      <span className="action-wait-ring" /><span className="action-wait-ring inner" />
      <div className="action-wait-core"><Sparkles size={30} strokeWidth={1.5} /></div>
    </div>
    <span className="action-wait-eyebrow">AI IS WORKING</span>
    <h2 id={titleId}>{t("正在生成改善事项", "Generating improvement actions")}</h2>
    <p id={descriptionId}>{t(`AI 正在分析${month || "全部月份"}的 `, "AI is analyzing ")}<strong>{count}</strong>{t(" 条真实反馈，", ` real feedback records from ${month || "all months"},`)}<br />{t("整理可执行的改进措施与原文依据。", "to identify actionable improvements and supporting evidence.")}</p>
    <div className="action-wait-track" aria-hidden="true"><span /></div>
    <p className="action-wait-status" role="status">{cancelState === "cancelling" ? t("正在请求服务端取消，请等待停止确认。", "Requesting server cancellation. Waiting for confirmation that generation stopped.") : cancelState === "finishing" ? t("服务端已结束本次生成，正在接收结果。", "The server has finished this generation. Waiting for the result.") : t("请稍候，完成后将自动显示结果", "Please wait. Results will appear automatically.")}<span className="action-wait-dots" aria-hidden="true"><i /><i /><i /></span></p>
    {onCancel && <button type="button" className="action-cancel-generation" onClick={onCancel} disabled={Boolean(cancelState)}>{cancelState === "cancelling" ? t("正在取消…", "Cancelling…") : cancelState === "finishing" ? t("等待结果…", "Waiting for result…") : t("取消生成", "Cancel generation")}</button>}
    {cancelError && <p className="action-cancel-error" role="alert">{tr(cancelError)}{t("。取消请求未成功，生成仍在继续，可重试取消。", " Cancellation was not confirmed. Generation is still running; you can retry cancellation.")}</p>}
    <small>{t("可切换到其他页面继续操作，返回此页查看结果；请勿刷新浏览器", "You can use other pages and return here for the results. Do not refresh the browser.")}</small>
  </section>;
}
