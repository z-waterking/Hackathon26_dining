import { useId } from "react";
import { ArrowUpRight, CookingPot, MapPin } from "lucide-react";
import { menuActionState } from "../shared/menu-action-state.mjs";
import "./menu-actions.css";

export default function MenuActionsPanel({ actions = [], useAi = true, hasPlan = false, onManage }) {
  const headingId = useId();
  const { eligible, menuItems, approvedCount, pendingCount, serviceApproved } = menuActionState(actions);
  const counts = [
    ["已批准总数", approvedCount],
    ["可用于排菜", eligible.length],
    ["待审批", pendingCount],
    ["服务及其他改善", serviceApproved.length],
  ];

  return <section className="menu-actions-panel" aria-labelledby={headingId}>
    <header className="menu-actions-heading">
      <div className="menu-actions-heading-copy">
        <div className="menu-actions-title"><CookingPot size={20} aria-hidden="true" /><h2 id={headingId}>排菜 Action</h2><span>当前清单</span></div>
        <p>{hasPlan ? "当前清单用于下一次 AI 生成；已有菜单及其 Action 快照不会随清单更新。" : "当前清单用于下一次 AI 生成；后续调整事项不会改写已生成菜单的 Action 快照。"}</p>
      </div>
      <button type="button" className="menu-actions-manage" onClick={onManage}>管理 Action 事项<ArrowUpRight size={16} aria-hidden="true" /></button>
    </header>

    <dl className="menu-actions-counts">{counts.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}<span>项</span></dd></div>)}</dl>

    {!useAi && <p className="menu-actions-mode-note">当前选择本地规则生成，以下 Action 不参与本次排菜；切换至 AI 生成后，可使用当前可用事项。</p>}
    {!!eligible.length && <p className="menu-actions-available">当前可用于排菜 {eligible.length} 项</p>}
    {!eligible.length && <div className="menu-actions-empty"><strong>当前可用于排菜 0 项</strong><p>请在 Action 事项中批准并启用有效的排菜要求。服务改善不用于选菜。</p></div>}

    {!!menuItems.length && <div className="menu-actions-scroll" role="region" aria-label="排菜 Action 清单" tabIndex={0}>
      <ul className="menu-actions-list">{menuItems.map(({ action, reason, statusLabel }, index) => {
        const available = eligible.some((item) => item === action || (action.id && item.id === action.id));
        return <li className={"menu-actions-item " + (available ? "is-eligible" : "is-unavailable")} key={action.id || index}>
          <article>
            <header><h3>{action.title || "未命名排菜事项"}</h3><span className="menu-actions-status">{statusLabel}</span></header>
            <p className="menu-actions-location"><MapPin size={12} aria-hidden="true" /><span>{action.targetStall || "档口未设置"}</span></p>
            <div className="menu-actions-instruction"><span>排菜要求</span><p>{typeof action.menuInstruction === "string" && action.menuInstruction.trim() || "尚未填写排菜要求"}</p></div>
            <p className="menu-actions-reason">{reason || (available ? "可作为下一次 AI 生成的排菜要求。" : "暂不可用于排菜，请前往 Action 事项查看。")}</p>
          </article>
        </li>;
      })}</ul>
    </div>}

    <footer className="menu-actions-footer">
      <p>仅展示正式 Action。服务及其他改善统计为已批准事项，用于现场运营跟进，不用于选菜。</p>
      {!!serviceApproved.length && <details className="menu-actions-service"><summary>查看已批准的服务及其他改善 · {serviceApproved.length} 项</summary><ul>{serviceApproved.map((action, index) => <li key={action.id || index}>{action.title || "未命名改善事项"}</li>)}</ul></details>}
    </footer>
  </section>;
}
