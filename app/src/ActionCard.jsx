import { useId } from "react";
import { ArrowUpRight, Check, CircleDashed, CookingPot, MapPin, MessageSquareText, Quote, Sparkles, UsersRound, X } from "lucide-react";

const kinds = {
  menu: { label: "排菜优化", icon: CookingPot },
  service: { label: "服务改善", icon: UsersRound },
  other: { label: "运营提升", icon: Sparkles },
};
const statuses = {
  pending: { label: "待审批", icon: CircleDashed },
  approved: { label: "已批准", icon: Check },
  rejected: { label: "已拒绝", icon: X },
};

export default function ActionCard({ action, index, onOpen }) {
  const titleId = useId();
  const kind = action.menuInstruction ? "menu" : kinds[action.kind] ? action.kind : "other";
  const { label, icon: Icon } = kinds[kind];
  const status = statuses[action.status] ? action.status : "pending";
  const { label: statusLabel, icon: StatusIcon } = statuses[status];
  const priority = ["high", "medium", "low"].includes(action.priority) ? action.priority : "medium";
  const references = [...new Set((action.feedbackIds || [action.feedbackId]).filter(Boolean))];
  const quote = action.evidence?.find((item) => item.quote)?.quote;
  return <article className={`action-card action-kind-${kind}`} aria-labelledby={titleId}>
    <header className="action-card-top">
      <span className="action-kind-label"><span className="action-category-icon"><Icon size={20} strokeWidth={1.6} aria-hidden="true" /></span>{label}</span>
      <span className={`action-priority priority-${priority}`}><span className="priority-bars" aria-hidden="true"><i /><i /><i /></span>{{ high: "高优先级", medium: "中优先级", low: "低优先级" }[priority]}</span>
    </header>
    <div className="action-card-heading"><span className="action-card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><h3 id={titleId}>{action.title}</h3></div>
    <p className="action-card-location"><MapPin size={12} aria-hidden="true" /><span>{action.targetStall || "全部档口"}</span></p>
    <p className="action-card-description">{action.description || "查看事项，补充具体改善措施。"}</p>
    <div className="action-card-evidence"><span><Quote size={12} aria-hidden="true" />反馈依据</span><blockquote>{quote || "查看详情，核对关联反馈的原始内容。"}</blockquote></div>
    <div className="action-card-meta"><span><MessageSquareText size={13} aria-hidden="true" />{references.length} 条相关反馈</span><span>版本 {action.revision || 1}</span></div>
    <footer className="action-card-bottom"><div className="action-card-state"><span className={`action-status status-${status}`}><StatusIcon size={13} aria-hidden="true" />{statusLabel}</span>{action.enabled === false && <span className="action-disabled">已停用</span>}</div><button type="button" className="action-card-open" onClick={onOpen} aria-haspopup="dialog">查看与审批<ArrowUpRight size={16} aria-hidden="true" /></button></footer>
  </article>;
}
