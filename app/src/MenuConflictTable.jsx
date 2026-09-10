import { useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Badge, Empty, Pagination } from "./shared";

const repairCodes = new Set(["PRICE", "POOL", "MISSING", "DUPLICATE", "REPEAT", "DUMPLING_OVERLAP", "MILD", "MILD_PRICE", "GROUP_SPICE", "MAIN", "SPICY", "VEGETARIAN", "METHOD", "STEAM_SPICE", "SHARED_MENU"]);

function repairAvailability(row, plan) {
  if (row.source !== "local") return "AI 汇总发现需先定位到本地冲突，不能直接代替人工核验。";
  if (plan.demo || plan.workflow?.demo || plan.workflow?.mode === "demo") return "历史模拟记录仅供查看，不发起真实 AI 修复。";
  if (!plan.workflow?.runId || plan.workflow?.generationMode !== "gpt-direct") return "仅具有完整真实 GPT 运行记录的菜单可修复，此草案需人工处理。";
  if (["百变厨房", "老广老北", "宽窄巷子"].includes(row.stall)) return "人工核验：固定或人工上传档口不能由 AI 修改出品，需按来源规则处理。";
  if (row.level !== "error" || !repairCodes.has(row.code)) return "人工核验：补充标签、规则或来源后重新检查，不能自动标为完成。";
  if (!row.stall || row.stall === "全部档口" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "") || !row.meal) return "人工定位：此问题尚未定位到单档口、日期与餐次。";
  if (row.code === "SHARED_MENU" && row.stall !== "五味坊") return "共享菜问题需要先核对来源档口，本轮仅支持五味坊引用修复。";
  if (/人工.*(?:上传|菜单)|(?:缺少|缺失|未找到).*(?:可信|固定出品|规则|来源)|(?:规则|来源).*(?:缺少|缺失|不完整|未提供)/.test(row.text || "")) return "人工核验：需先补齐人工菜单或可信规则来源，AI 不能编造缺失依据。";
  if (!(plan.entries || []).some(entry => (entry.stall || plan.stall) === row.stall && entry.date === row.date && entry.meal === row.meal)) return "人工定位：当前菜单没有匹配的档口、日期与餐次。";
  return "";
}

export default function MenuConflictTable({ plan, workflow = plan.workflow, aiStatus, busy, onRepair, repairState, viewState, onViewChange }) {
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
  return <section className="menu-conflict-section" aria-label="菜单冲突与核验列表">
    <div className="menu-conflict-heading"><h3>冲突与核验明细</h3><span>{rows.length} 条记录 · 每页 {size} 条</span></div>
    <p className="muted small">本地校验与 AI 发现统一列出；未定位问题显示“全局 / 未定位”。AI 修复仅尝试调整该档口当天该餐次，不修改标签或规则，也不自动批准。</p>
    <div className="menu-conflict-filters"><label>档口<select aria-label="冲突档口" value={stall} onChange={event => setView(current => ({ ...current, stall: event.target.value, page: 1 }))}><option value="">全部档口</option>{stalls.map(value => <option key={value} value={value}>{value}</option>)}<option value="__global">全局 / 未定位</option></select></label><label>级别<select aria-label="冲突级别" value={level} onChange={event => setView(current => ({ ...current, level: event.target.value, page: 1 }))}><option value="">全部级别</option><option value="error">冲突</option><option value="warning">待核验</option></select></label></div>
    {repairState?.error && <p className="notice menu-repair-error" role="alert">{repairState.error}；原菜单保持不变，可重试或人工处理。</p>}
    {repairState?.pending ? <div className="menu-repair-wait" role="status"><LoaderCircle size={18} className="spin" /><span>AI 正在修复 {repairState.issue.stall} · {repairState.issue.date} · {repairState.issue.meal}，完成后将重新检查整份菜单。未收到有效结果前保留原菜单。</span></div> : repairState?.summary && <p className="notice menu-repair-result" role="status">{repairState.summary}{repairState.status === "repaired" ? ` 本次调整 ${repairState.changedEntries ?? 0} 个槽位；旧 AI 检验与评分已失效，请重新 AI 检验后保存。` : " 菜单未改变；仍保留当前冲突，不能视为已解决。"}</p>}
    {rows.length ? <><div className="menu-conflict-scroll"><table className="menu-conflict-table" aria-label="冲突详情"><thead><tr><th scope="col">档口</th><th scope="col">日期</th><th scope="col">餐次</th><th scope="col">冲突</th><th scope="col">核验</th><th scope="col">操作</th></tr></thead><tbody>{visible.map(row => {
      const reason = repairAvailability(row, plan);
      return <tr key={row.key}><td>{row.stall || "全局 / 未定位"}</td><td>{row.date || "未定位"}</td><td>{row.meal || "未定位"}</td><td><p>{row.text}</p>{row.code && <small className="source">{row.code}</small>}{!!row.actionIds?.length && <small className="source">关联 Action：{row.actionIds.join("、")}</small>}{!!row.ruleIds?.length && <small className="source">依据规则：{row.ruleIds.join("、")}</small>}</td><td><Badge tone={row.level === "error" ? "red" : "gold"}>{row.level === "error" ? "冲突" : "待核验"}</Badge><small>{row.source === "local" ? "本地规则" : workflow?.stale ? "上次 AI 检验 · 已过期" : "AI 检验发现"}</small></td><td>{reason ? <span className="menu-conflict-manual">{reason}</span> : <><button className="menu-issue-repair" disabled={busy || repairState?.pending || !aiStatus?.configured || !onRepair} onClick={() => onRepair({ code: row.code, stall: row.stall, date: row.date, meal: row.meal, text: row.text })}><Sparkles size={13} />AI 修复</button><small>{aiStatus?.configured ? "一次 AI 调用 · 仅此餐次" : "AI 未配置"}</small></>}</td></tr>;
    })}</tbody></table>{!filtered.length && <Empty text="当前筛选下暂无冲突记录" />}</div><Pagination page={current} setPage={setPage} count={filtered.length} size={size} /></> : <Empty text="未记录本地冲突或 AI 待核验项" />}
  </section>;
}
