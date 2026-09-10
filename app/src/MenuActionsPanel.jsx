import { useId } from "react";
import { ArrowUpRight, CookingPot } from "lucide-react";
import { menuActionState } from "../shared/menu-action-state.mjs";
import { useI18n } from "./i18n";
import "./menu-actions.css";

export default function MenuActionsPanel({ actions = [], useAi = true, onManage }) {
  const { t, tr } = useI18n();
  const headingId = useId();
  const { eligible } = menuActionState(actions);

  return <section className="menu-actions-panel" aria-labelledby={headingId}>
    <header className="menu-actions-heading">
      <div className="menu-actions-title"><CookingPot size={18} aria-hidden="true" /><h2 id={headingId}>{t("排菜 Action", "Menu Actions")}</h2></div>
      <button type="button" className="menu-actions-manage" onClick={onManage}>{t("管理 Action 事项", "Manage Actions")}<ArrowUpRight size={16} aria-hidden="true" /></button>
    </header>
    {!useAi && eligible.length > 0 && <p className="menu-actions-mode-note">{t("本地规则模式不应用以下 Action。", "These Actions are not applied in local-rule mode.")}</p>}
    {eligible.length ? <div className="menu-actions-scroll" role="region" aria-label={t("排菜 Action 清单", "Menu Action list")} tabIndex={0}>
      <ul className="menu-actions-list">{eligible.map((action, index) => <li className="menu-actions-item" key={action.id || index}>
        <article>
          <h3>{tr(action.title) || t("未命名排菜事项", "Untitled menu Action")}</h3>
          <p>{tr(action.menuInstruction.trim())}</p>
        </article>
      </li>)}</ul>
    </div> : <p className="menu-actions-empty">{t("暂无已批准且可用于排菜的 Action。", "No approved Actions are ready for menu planning.")}</p>}
  </section>;
}
