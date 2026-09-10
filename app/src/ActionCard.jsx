import { useId } from "react";
import { ArrowUpRight, Check, CircleDashed, CookingPot, MapPin, MessageSquareText, Quote, Sparkles, UsersRound, X } from "lucide-react";
import { useI18n } from "./i18n";

const kinds = {
  menu: { label: "排菜优化", en: "Menu optimization", icon: CookingPot },
  service: { label: "服务改善", en: "Service improvement", icon: UsersRound },
  other: { label: "运营提升", en: "Operations improvement", icon: Sparkles },
};
const statuses = {
  pending: { label: "待审批", en: "Pending approval", icon: CircleDashed },
  approved: { label: "已批准", en: "Approved", icon: Check },
  rejected: { label: "已拒绝", en: "Rejected", icon: X },
};

export default function ActionCard({ action, index, onOpen }) {
  const { t, tr } = useI18n();
  const titleId = useId();
  const kind = action.menuInstruction ? "menu" : kinds[action.kind] ? action.kind : "other";
  const { label, en, icon: Icon } = kinds[kind];
  const status = statuses[action.status] ? action.status : "pending";
  const { label: statusLabel, en: statusEn, icon: StatusIcon } = statuses[status];
  const priority = ["high", "medium", "low"].includes(action.priority) ? action.priority : "medium";
  const references = [...new Set((action.feedbackIds || [action.feedbackId]).filter(Boolean))];
  const quote = action.evidence?.find((item) => item.quote)?.quote;
  return <article className={`action-card action-kind-${kind}`} aria-labelledby={titleId}>
    <header className="action-card-top">
      <span className="action-kind-label"><span className="action-category-icon"><Icon size={20} strokeWidth={1.6} aria-hidden="true" /></span>{t(label, en)}</span>
      <span className={`action-priority priority-${priority}`}><span className="priority-bars" aria-hidden="true"><i /><i /><i /></span>{t({ high: "高优先级", medium: "中优先级", low: "低优先级" }[priority], { high: "High priority", medium: "Medium priority", low: "Low priority" }[priority])}</span>
    </header>
    <div className="action-card-heading"><span className="action-card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><h3 id={titleId}>{tr(action.title)}</h3></div>
    <p className="action-card-location"><MapPin size={12} aria-hidden="true" /><span>{!action.targetStall || action.targetStall === "全部档口" ? t("全部档口", "All stalls") : action.targetStall}</span></p>
    <p className="action-card-description">{action.description ? tr(action.description) : t("查看事项，补充具体改善措施。", "Open this action to add specific improvement steps.")}</p>
    <div className="action-card-evidence"><span><Quote size={12} aria-hidden="true" />{t("反馈依据", "Feedback evidence")}</span><blockquote>{quote || t("查看详情，核对关联反馈的原始内容。", "Open the details to verify the original linked feedback.")}</blockquote></div>
    <div className="action-card-meta"><span><MessageSquareText size={13} aria-hidden="true" />{t(`${references.length} 条相关反馈`, `${references.length} linked feedback records`)}</span><span>{t("版本", "Revision")} {action.revision || 1}</span></div>
    <footer className="action-card-bottom"><div className="action-card-state"><span className={`action-status status-${status}`}><StatusIcon size={13} aria-hidden="true" />{t(statusLabel, statusEn)}</span>{action.enabled === false && <span className="action-disabled">{t("已停用", "Disabled")}</span>}</div><button type="button" className="action-card-open" onClick={onOpen} aria-haspopup="dialog">{t("查看与审批", "Review & approve")}<ArrowUpRight size={16} aria-hidden="true" /></button></footer>
  </article>;
}
