import { useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Badge, Empty, Pagination } from "./shared";
import { useI18n } from "./i18n";

const repairCodes = new Set(["PRICE", "POOL", "MISSING", "DUPLICATE", "REPEAT", "DUMPLING_OVERLAP", "MILD", "MILD_PRICE", "GROUP_SPICE", "MAIN", "SPICY", "VEGETARIAN", "METHOD", "STEAM_SPICE", "SHARED_MENU"]);

function repairAvailability(row, plan, t) {
  if (row.source !== "local") return t("AI 汇总发现需先定位到本地冲突，不能直接代替人工核验。", "Link this AI finding to a specific local issue before repair. Human verification is still required.");
  if (plan.demo || plan.workflow?.demo || plan.workflow?.mode === "demo") return t("历史模拟记录仅供查看，不发起真实 AI 修复。", "Historical demo records are read-only; real AI repair is unavailable.");
  if (!plan.workflow?.runId || plan.workflow?.generationMode !== "gpt-direct") return t("仅具有完整真实 GPT 运行记录的菜单可修复，此草案需人工处理。", "Repair requires a completed real GPT run. Review this draft manually.");
  if (["百变厨房", "老广老北", "宽窄巷子"].includes(row.stall)) return t("人工核验：固定或人工上传档口不能由 AI 修改出品，需按来源规则处理。", "Manual review: fixed-output and manually supplied stalls must follow their source rules; AI cannot change them.");
  if (row.level !== "error" || !repairCodes.has(row.code)) return t("人工核验：补充标签、规则或来源后重新检查，不能自动标为完成。", "Manual review: supply verified labels, rules or sources, then check again. This cannot be auto-completed.");
  if (!row.stall || row.stall === "全部档口" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "") || !row.meal) return t("人工定位：此问题尚未定位到单档口、日期与餐次。", "Locate the issue first: a specific stall, date and meal are required.");
  if (row.code === "SHARED_MENU" && row.stall !== "五味坊") return t("共享菜问题需要先核对来源档口，本轮仅支持五味坊引用修复。", "Verify the source stall first. Shared-menu repair currently supports only 五味坊.");
  if (/人工.*(?:上传|菜单)|(?:缺少|缺失|未找到).*(?:可信|固定出品|规则|来源)|(?:规则|来源).*(?:缺少|缺失|不完整|未提供)/.test(row.text || "")) return t("人工核验：需先补齐人工菜单或可信规则来源，AI 不能编造缺失依据。", "Manual review: supply the missing manual menu or trusted rules first. AI cannot invent sources.");
  if (!(plan.entries || []).some(entry => (entry.stall || plan.stall) === row.stall && entry.date === row.date && entry.meal === row.meal)) return t("人工定位：当前菜单没有匹配的档口、日期与餐次。", "No matching stall, date and meal was found in this menu.");
  return "";
}

export default function MenuConflictTable({ plan, workflow = plan.workflow, aiStatus, busy, onRepair, repairState, viewState, onViewChange }) {
  const { t, tr } = useI18n();
  const [localView, setLocalView] = useState({ stall: "", level: "", page: 1 });
  const { stall, level, page } = viewState || localView;
  const setView = onViewChange || setLocalView;
  const setPage = value => setView(current => ({ ...current, page: value }));
  const rows = [
    ...(plan.validation?.issues || []).map((issue, index) => ({ ...issue, source: "local", key: "local-" + index, stall: issue.stall || (plan.scope !== "all" ? plan.stall : "") })),
    ...(workflow?.inspector?.findings || []).map((issue, index) => ({ ...issue, source: "ai", key: "ai-" + index, level: issue.severity === "error" ? "error" : "warning" })),
  ];
  const stalls = [...new Set(rows.map(row => row.stall).filter(Boolean))];
  const filtered = rows.filter(row => (!stall || (stall === "__global" ? !row.stall : row.stall === stall)) && (!level || row.level === level));
  const size = 10;
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / size)));
  const visible = filtered.slice((current - 1) * size, current * size);
  return <section className="menu-conflict-section" aria-label={t("菜单冲突与核验列表", "Menu conflicts and verification")}>
    <div className="menu-conflict-heading"><h3>{t("冲突与核验明细", "Conflicts and verification details")}</h3><span>{t(`${rows.length} 条记录 · 每页 ${size} 条`, `${rows.length} records · ${size} per page`)}</span></div>
    <p className="muted small">{t("本地校验与 AI 发现统一列出；未定位问题显示“全局 / 未定位”。AI 修复仅尝试调整该档口当天该餐次，不修改标签或规则，也不自动批准。", "Local checks and AI findings are listed together. Unlocated issues appear as Global / Unlocated. AI repair only adjusts the selected stall, date and meal; it does not change labels or rules, or approve the menu.")}</p>
    <div className="menu-conflict-filters"><label>{t("档口", "Stall")}<select aria-label={t("冲突档口", "Issue stall")} value={stall} onChange={event => setView(current => ({ ...current, stall: event.target.value, page: 1 }))}><option value="">{t("全部档口", "All stalls")}</option>{stalls.map(value => <option key={value} value={value}>{value}</option>)}<option value="__global">{t("全局 / 未定位", "Global / Unlocated")}</option></select></label><label>{t("级别", "Severity")}<select aria-label={t("冲突级别", "Issue severity")} value={level} onChange={event => setView(current => ({ ...current, level: event.target.value, page: 1 }))}><option value="">{t("全部级别", "All severities")}</option><option value="error">{t("冲突", "Conflict")}</option><option value="warning">{t("待核验", "Needs verification")}</option></select></label></div>
    {repairState?.error && <p className="notice menu-repair-error" role="alert">{tr(repairState.error)}{t("；原菜单保持不变，可重试或人工处理。", "; the original menu is unchanged. Retry or review it manually.")}</p>}
    {repairState?.pending ? <div className="menu-repair-wait" role="status"><LoaderCircle size={18} className="spin" /><span>{t(`AI 正在修复 ${repairState.issue.stall} · ${repairState.issue.date} · ${repairState.issue.meal}，完成后将重新检查整份菜单。未收到有效结果前保留原菜单。`, `AI is repairing ${repairState.issue.stall} · ${repairState.issue.date} · ${t(repairState.issue.meal)}. The entire menu will be checked again; the original is retained until a valid result arrives.`)}</span></div> : repairState?.summary && <p className="notice menu-repair-result" role="status">{tr(repairState.summary)}{repairState.status === "repaired" ? t(` 本次调整 ${repairState.changedEntries ?? 0} 个槽位；旧 AI 检验与评分已失效，请重新 AI 检验后保存。`, ` ${repairState.changedEntries ?? 0} slots changed. The previous AI review and score are no longer valid; run AI inspection before saving.`) : t(" 菜单未改变；仍保留当前冲突，不能视为已解决。", " The menu is unchanged; existing conflicts remain unresolved.")}</p>}
    {rows.length ? <><div className="menu-conflict-scroll"><table className="menu-conflict-table" aria-label={t("冲突详情", "Conflict details")}><thead><tr>{[["档口","Stall"],["日期","Date"],["餐次","Meal"],["冲突","Conflict"],["核验","Verification"],["操作","Actions"]].map(([zh,en]) => <th key={zh} scope="col">{t(zh,en)}</th>)}</tr></thead><tbody>{visible.map(row => {
      const reason = repairAvailability(row, plan, t);
      return <tr key={row.key}><td>{row.stall || t("全局 / 未定位", "Global / Unlocated")}</td><td>{row.date || t("未定位", "Unlocated")}</td><td>{row.meal ? t(row.meal) : t("未定位", "Unlocated")}</td><td><p>{tr(row.text)}</p>{row.code && <small className="source">{row.code}</small>}{!!row.actionIds?.length && <small className="source">{t("关联 Action：", "Related Actions: ")}{row.actionIds.join("、")}</small>}{!!row.ruleIds?.length && <small className="source">{t("依据规则：", "Source rules: ")}{row.ruleIds.join("、")}</small>}</td><td><Badge tone={row.level === "error" ? "red" : "gold"}>{row.level === "error" ? t("冲突", "Conflict") : t("待核验", "Needs verification")}</Badge><small>{row.source === "local" ? t("本地规则", "Local rules") : workflow?.stale ? t("上次 AI 检验 · 已过期", "Previous AI review · Stale") : t("AI 检验发现", "AI finding")}</small></td><td>{reason ? <span className="menu-conflict-manual">{reason}</span> : <><button className="menu-issue-repair" disabled={busy || repairState?.pending || !aiStatus?.configured || !onRepair} onClick={() => onRepair({ code: row.code, stall: row.stall, date: row.date, meal: row.meal, text: row.text })}><Sparkles size={13} />{t("AI 修复", "AI repair")}</button><small>{aiStatus?.configured ? t("一次 AI 调用 · 仅此餐次", "One AI call · This meal only") : t("AI 未配置", "AI not configured")}</small></>}</td></tr>;
    })}</tbody></table>{!filtered.length && <Empty text={t("当前筛选下暂无冲突记录", "No conflicts match these filters")} />}</div><Pagination page={current} setPage={setPage} count={filtered.length} size={size} /></> : <Empty text={t("未记录本地冲突或 AI 待核验项", "No local conflicts or AI verification items recorded")} />}
  </section>;
}
