import { useRef, useState } from "react";
import { ArrowUpRight, ClipboardCheck, Fingerprint, ListChecks, Sparkles, Target } from "lucide-react";
import { Badge, Empty, Modal } from "./shared";
import { readable } from "./ui-text";
import { diningApi } from "./api/dining";
import MenuConflictTable from "./MenuConflictTable";
import "./menu-score.css";

const impactLabels = { applied: "已落实", partial: "部分落实", not_applied: "尚未落实" };
const workflowLabels = { needs_review: "待人工审核", blocked: "检验存在阻断", stale: "需重新检验" };

function occurrenceKey(entry) {
  return JSON.stringify([entry.week, entry.day, entry.meal, entry.stall, entry.slot, entry.dishId]);
}

function ImpactOccurrences({ entries, dates, dishes }) {
  return <ul className="menu-impact-positions">{entries.map((entry, index) => {
    const date = entry.date || dates.get(occurrenceKey(entry)) || "日期未记录";
    const dish = dishes.get(entry.dishId)?.name || entry.dishName || "菜品 " + (entry.dishId || "未记录");
    return <li key={index}><strong>{dish}</strong><span>第 {entry.week} 周 · {date} · 周{["", "一", "二", "三", "四", "五", "六", "日"][entry.day] || entry.day} · {entry.meal} · {entry.stall} · 菜位 {Number.isInteger(entry.slot) ? entry.slot + 1 : "未记录"}</span></li>;
  })}</ul>;
}

function ActionImpacts({ workflow, plan, dishes, direct }) {
  const hasImpactRecord = Array.isArray(workflow.actionImpacts);
  const impacts = hasImpactRecord ? workflow.actionImpacts : [];
  const dates = new Map(plan.entries.map((entry) => [occurrenceKey(entry), entry.date]));
  return <section className="menu-impact-section" aria-labelledby="menu-impact-heading">
    <div className="section-heading"><h2 id="menu-impact-heading"><ListChecks size={18} />已批准 Action · 菜单执行记录</h2><Badge tone="blue">{hasImpactRecord ? impacts.length + " 项要求" : "执行记录缺失"}</Badge></div>
    <p className="muted small">保留本次生成时的批准版本。以下是具体落实位置，不代表与无 Action 菜单相比的因果增减；调整事项后需重新生成。</p>
    {workflow.stale && impacts.length > 0 && <p className="notice">{workflow.repairPendingInspection ? "上次审核记录，修复后待重新核验。" : "以下为上次检验的 Action 执行记录，已过期。"}不能作为当前菜单的落实证明。</p>}
    {impacts.length ? <div className="action-impacts menu-impact-grid">{impacts.map((impact, index) => {
      const occurrences = impact.occurrences || [];
      const evidence = impact.evidence || [];
      return <article className="menu-impact-card" key={impact.actionId || impact.id || index} aria-label={"Action 执行：" + impact.title}>
        <header><span className="menu-impact-number">{String(index + 1).padStart(2, "0")}</span><Badge tone={workflow.stale ? "gray" : impact.status === "applied" ? "green" : "gold"}>{workflow.stale ? "记录已过期" : impactLabels[impact.status] || impact.status}</Badge></header>
        <h3>{impact.title}</h3><p className="menu-impact-scope">{impact.targetStall || "全部档口"} · 批准版本 {impact.revision ?? "未记录"}</p>
        <div className="menu-impact-instruction"><small>排菜要求</small><p>{impact.instruction || "未记录排菜要求"}</p></div>
        {direct || impact.direct ? <div className="impact-numbers"><span>本次关联槽位 <strong>{impact.selectedEntries ?? occurrences.length}</strong></span></div> : <div className="impact-numbers"><span>基线槽位 <strong>{impact.baselineEntries ?? "未记录"}</strong></span><span>本次选用 <strong>{impact.selectedEntries ?? "未记录"}</strong></span><span>变化槽位 <strong>{impact.changedEntries ?? "未记录"}</strong></span></div>}
        <div className="menu-impact-evidence"><small>{impact.status === "applied" ? "执行依据" : "执行说明 / 未完全落实原因"}</small>{evidence.length ? evidence.slice(0, 2).map((item, i) => <p key={i}>{readable(item)}</p>) : <p>未提供可核验的执行说明，需人工复核。</p>}
          {evidence.length > 2 && <details><summary>其余周次执行说明 · {evidence.length - 2}</summary>{evidence.slice(2).map((item, i) => <p key={i}>{readable(item)}</p>)}</details>}
        </div>
        {occurrences.length ? <><ImpactOccurrences entries={occurrences.slice(0, 3)} dates={dates} dishes={dishes} />{occurrences.length > 3 && <details><summary>查看其余关联位置 · {occurrences.length - 3}</summary><ImpactOccurrences entries={occurrences.slice(3)} dates={dates} dishes={dishes} /></details>}</> : <p className="source">暂无可定位到具体菜品的关联记录，不能据此确认事项已落实。</p>}
        <footer>来源 Action：{impact.actionId || impact.id || "未记录"}</footer>
      </article>;
    })}</div> : <div className="menu-impact-empty"><ListChecks size={23} /><div><strong>{hasImpactRecord ? "此菜单生成时未纳入排菜 Action" : "此历史菜单未记录 Action 执行情况"}</strong><p>{hasImpactRecord ? "这是此菜单生成时的记录，不代表当前没有已批准事项。当前清单见页面上方“排菜 Action”；新增或调整要求需重新生成才会纳入。" : "缺少记录不代表没有批准事项，也不能确认其已落实；重新生成后可查看执行依据。"}</p></div></div>}
  </section>;
}

function ReviewDetails({ plan, workflow, score, direct, demo, onClose, aiStatus, busy, onRepair, repairState, conflictView, setConflictView }) {
  const ruleInfo = workflow.sourceRuleInfo;
  const catalogInfo = workflow.catalogInfo;
  const inspectorHeading = !workflow.inspector?.verdict ? "尚未完成 AI 检验" : workflow.stale ? "上次检验结论已过期" : workflow.inspector.verdict === "pass" ? (demo ? "模拟" : "AI") + " 检验通过 · 待人工审核" : "需要调整与复核";
  return <Modal title="菜单评分与检验详情" wide onClose={onClose}>
    <div className="menu-review-details">
      <p className="notice">{workflow.stale ? "检验结果已过期，请重新检验后再判断当前菜单。" : "评分用于辅助改进，达到 80 分不等于审核通过；阻断冲突、未知食品标签和未解决要求仍须核实。"}</p>
      <h3>评分构成</h3>
      {score ? <><p>{score.summary}</p><div className="menu-score-dimensions">{(score.dimensions || []).map((dimension) => <article key={dimension.key}><header><strong>{dimension.label}</strong><span>{dimension.earned} / {dimension.weight}</span></header><div className="menu-score-track" aria-hidden="true"><i style={{ width: (dimension.weight > 0 ? Math.max(0, Math.min(100, dimension.earned / dimension.weight * 100)) : 0) + "%" }} /></div><p>{dimension.detail}</p></article>)}</div><p className="source">评分版本：{score.version} · 目标 {score.target} 分 · 阻断 {score.blockers ?? 0} 项 · 待核验 {score.unknownCount ?? 0} 项</p></> : <p className="muted">此记录尚无服务端评分。可重新检验获取评分，页面不会补算或保底分数。</p>}
      <h3>本地规则校验</h3>
      <div className="detail-meta"><Badge tone="red">{plan.validation?.errors || 0} 项冲突</Badge><Badge tone="gold">{plan.validation?.warnings || 0} 项待核验</Badge><span>标签完整率 {plan.validation?.labelCoverage ?? "未记录"}% · 槽位变化率 {plan.validation?.changeRate == null ? "无可比基线" : plan.validation.changeRate + "%"}</span></div>
      <MenuConflictTable plan={plan} workflow={workflow} aiStatus={aiStatus} busy={busy} onRepair={onRepair} repairState={repairState} viewState={conflictView} onViewChange={setConflictView} />
      <h3>排菜员与检验员</h3>
      <div className="role-results"><div><span className="role-label">01 / 排菜员</span><h3>{direct ? "GPT 直接编排" : "规划与执行"}</h3>{workflow.planner?.model && <p className="source">模型：{workflow.planner.model}</p>}<p>{workflow.planner?.summary || "未返回规划摘要"}</p></div><div><span className="role-label">02 / 检验员</span><h3>{inspectorHeading}</h3>{workflow.inspector?.model && <p className="source">模型：{workflow.inspector.model}</p>}<p>{workflow.inspector?.summary || "尚无检验结论"}</p></div></div>
      {!!workflow.planner?.unresolved?.length && <><h3>未解决要求 · {workflow.planner.unresolved.length}</h3>{workflow.planner.unresolved.map((item, index) => <p className="summary-item" key={index}>{typeof item === "string" ? item : item.reason}<small className="source">Action：{item.actionId || "未关联"}</small></p>)}</>}
      <p className="muted small">AI 检验发现已与本地冲突合并展示于上方列表；仍以本地校验和人工审核为准。</p>
      <h3>数据来源与运行信息</h3>
      <p className="source">菜单范围：{plan.scope === "all" ? "全部档口" : "历史单档口 · " + plan.stall} · 生成或保存不代表人工审核通过。</p>
      {catalogInfo && <section className="menu-catalog-detail"><h3>菜库入库与档口来源</h3><p className="source">{catalogInfo.file || "本地菜单库"}{catalogInfo.sha256 ? " · 版本指纹 " + catalogInfo.sha256.slice(0, 12) : ""}</p><p className="small">原始条目 {catalogInfo.stats?.sourceRows ?? "未记录"} · 去重后 {catalogInfo.stats?.uniqueDishes ?? "未记录"} · 合并重复 {catalogInfo.stats?.duplicates ?? 0} · 隔离异常 {catalogInfo.stats?.rejected ?? 0}</p><p className="small">每个档口从自己的候选菜中独立编排；源库未覆盖的档口保留可追溯的补充菜库。异常或未匹配条目不作为已验证候选。</p><div className="menu-catalog-groups">{(catalogInfo.groups || []).map((group) => <div key={group.stall}><strong>{group.stall}</strong><Badge tone={group.origin === "primary" ? "green" : "gold"}>{group.origin === "primary" ? "原始菜单库" : "补充来源"}</Badge><span>{group.candidates} 道可选{group.unresolved ? " · " + group.unresolved + " 项待核实" : ""}</span></div>)}</div>{!!catalogInfo.warnings?.length && <details><summary>菜库入库待核实项 · {catalogInfo.warnings.length}</summary>{catalogInfo.warnings.map((warning, index) => <p className="source" key={index}>{readable(warning)}</p>)}</details>}</section>}
      {workflow.source && <p className="source">生成来源：{workflow.source}</p>}
      {ruleInfo && <p className="source">规则来源：{ruleInfo.file || "本地规则文件"} · {ruleInfo.ruleCount ?? "未记录"} 条规则{ruleInfo.sha256 ? " · 版本指纹 " + ruleInfo.sha256.slice(0, 12) : ""}</p>}
      <p className="source">运行 {workflow.runId} · {workflow.inspectedAt ? new Date(workflow.inspectedAt).toLocaleString("zh-CN") : "尚无检验时间"}</p>
      <p className="notice">本地规则约束不可被 Action 覆盖。检验结果供辅助审查，最终菜单仍需运营人员审核；生成或保存草案不代表发布。</p>
      {!!plan.fixedStaples?.length && <details className="action-evidence"><summary>固定主食 · 沿用源文件</summary>{plan.fixedStaples.filter((item) => plan.meals.includes(item.meal)).map((item, index) => <p key={index}><strong>{item.stall} · {item.meal}</strong>：{item.text}<small className="source">{item.source?.file} · {item.source?.sheet} · {item.source?.cell}</small></p>)}</details>}
    </div>
  </Modal>;
}

export default function MenuWorkflow({ plan, setPlan, aiStatus, run, busy, dishes = [], detailsOpen = false, onDetailsChange, onRepairBusyChange }) {
  const [trace, setTrace] = useState(null);
  const [repairState, setRepairState] = useState(null);
  const [conflictView, setConflictView] = useState({ stall: "", level: "", page: 1 });
  const repairInFlight = useRef(false);
  async function repairIssue(issue) {
    if (busy || repairInFlight.current || !aiStatus?.configured) return;
    repairInFlight.current = true;
    onRepairBusyChange?.(true);
    setRepairState({ pending: true, issue });
    const original = structuredClone(plan);
    try {
      const result = await diningApi.plans.repair({ plan: original, issue });
      if (!result?.plan?.entries || !result.plan.validation || !["repaired", "unchanged"].includes(result.repair?.status)) throw new Error("修复结果不完整，未替换原菜单");
      if (result.repair.status === "repaired" && (!result.plan.workflow?.stale || !result.plan.workflow?.repairPendingInspection)) throw new Error("修复结果缺少重新检验标记，未替换原菜单");
      if (result.repair.status === "repaired") setPlan(result.plan);
      setRepairState({ pending: false, issue, ...result.repair });
    } catch (error) {
      setRepairState({ pending: false, issue, error: error.message });
    } finally {
      repairInFlight.current = false;
      onRepairBusyChange?.(false);
    }
  }
  const workflow = plan.workflow;
  if (!workflow || plan.partial) return null;
  const demo = Boolean(plan.demo || workflow.demo || workflow.mode === "demo");
  const direct = workflow.generationMode === "gpt-direct";
  const score = Number.isFinite(workflow.score?.value) ? workflow.score : null;
  const stale = Boolean(workflow.stale || workflow.status === "stale");
  const blocked = workflow.status === "blocked" || (score?.blockers || 0) > 0;
  const tone = stale ? "stale" : blocked || !score || !score.targetMet ? "review" : "target";
  return <section className="workflow-section menu-result-review" aria-label="菜单评分与 Action 执行">
    <section className={"menu-score-hero " + tone} aria-label="菜单质量评分">
      <div className="menu-score-value" aria-label={score ? "菜单评分 " + score.value + " 分" + (stale ? "，已过期" : "") : stale ? "菜单评分已失效" : "菜单尚未评分"}><strong>{score ? score.value : "—"}</strong><span>/ 100</span><small>{stale ? score ? "上次评分 · 已过期" : "评分已失效" : demo ? "模拟检验评分" : "菜单质量评分"}</small></div>
      <div className="menu-score-copy"><div className="menu-score-eyebrow"><Target size={15} />质量目标 {score?.target ?? 80} 分<Badge tone={stale ? "gray" : score?.targetMet ? "green" : "gold"}>{stale ? "待重新评定" : !score ? "尚未评分" : score.targetMet ? "达到目标" : "仍需优化"}</Badge></div><h2>{stale ? "菜单或依据已更新，请重新检验" : score?.label || "菜单已生成，等待质量复核"}</h2><p>{stale ? score ? "此分值来自上次检验，不能代表当前菜单质量。" : "评分已失效，待重新检验。" : score?.summary || "此记录尚无质量分数，可重新检验后查看。"}</p><div className="menu-score-status"><Badge tone={blocked || stale ? "gold" : "blue"}>{stale ? workflowLabels.stale : workflowLabels[workflow.status] || "待人工审核"}</Badge><span>{stale ? "历史评分不再作为当前菜单的审核依据。" : blocked ? "存在阻断，不能以分值代替冲突处理。" : "达到目标不等于审核通过，最终仍需人工确认。"}</span></div></div>
      <button className="menu-score-details" disabled={busy} onClick={() => onDetailsChange?.(true)}><ClipboardCheck size={16} />查看评分与冲突详情<ArrowUpRight size={15} /></button>
    </section>
    {stale && !!workflow.staleReasons?.length && <p className="notice">{workflow.staleReasons.join("；")}</p>}
    {demo && <p className="notice">模拟测试 · 使用示例改善事项，不调用 Azure AI，不代表真实员工反馈或正式审核。</p>}
    <ActionImpacts workflow={{ ...workflow, stale }} plan={plan} dishes={new Map(dishes.map((dish) => [dish.id, dish]))} direct={direct} />
    <div className="menu-review-toolbar"><p className="source">{direct ? "GPT 直接编排" : "规划与执行"} · {workflow.inspectedAt ? "最近检验 " + new Date(workflow.inspectedAt).toLocaleString("zh-CN") : "尚无检验时间"}</p><div className="actions">{workflow.runId && <button disabled={busy} onClick={() => run(async () => { setTrace(await diningApi.plans.run(workflow.runId)); return "已读取本次排菜留痕"; })}><Fingerprint size={15} />查看运行留痕</button>}<button disabled={busy || (!demo && !aiStatus?.configured)} onClick={() => run(async () => { setPlan(await diningApi.plans.inspect({ ...plan, demo })); setRepairState(null); return "检验员已完成重新检验，请查看报告"; })}><Sparkles size={15} />{demo ? "重新模拟检验" : "重新 AI 检验"}</button></div></div>
    {detailsOpen && <ReviewDetails plan={plan} workflow={{ ...workflow, stale }} score={score} direct={direct} demo={demo} onClose={() => onDetailsChange?.(false)} aiStatus={aiStatus} busy={busy} onRepair={repairIssue} repairState={repairState} conflictView={conflictView} setConflictView={setConflictView} />}
    {trace && <Modal title="排菜运行留痕" wide onClose={() => setTrace(null)}><div className="detail-meta"><Badge>{trace.status || workflow.status}</Badge><span>{trace.id || workflow.runId}</span></div><p className="source">创建：{trace.createdAt ? new Date(trace.createdAt).toLocaleString("zh-CN") : "时间未记录"}</p>{[["排菜范围", trace.input], ["Action 快照", trace.snapshots?.actions], ["规则快照", trace.snapshots?.rules], ["排菜决策", trace.planner || trace.workflow?.planner], ["检验结果", trace.workflow?.inspector || trace.inspector]].map(([label, value]) => <details key={label}><summary>{label}</summary>{value ? <pre className="trace-json">{JSON.stringify(value, null, 2)}</pre> : <Empty text="未记录此项" />}</details>)}</Modal>}
  </section>;
}
