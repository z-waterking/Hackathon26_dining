import { useRef, useState } from "react";
import { ArrowUpRight, ClipboardCheck, Fingerprint, ListChecks, Sparkles, Target } from "lucide-react";
import { Badge, Empty, Modal } from "./shared";
import { readable } from "./ui-text";
import { diningApi } from "./api/dining";
import MenuConflictTable from "./MenuConflictTable";
import { useI18n } from "./i18n";
import { formatMenuTrace } from "./menu-trace-projection";
import "./menu-score.css";

const impactLabels = { applied: ["已落实", "Applied"], partial: ["部分落实", "Partially applied"], not_applied: ["尚未落实", "Not applied"] };
const workflowLabels = { needs_review: ["待人工审核", "Awaiting human review"], blocked: ["检验存在阻断", "Inspection has blockers"], stale: ["需重新检验", "Reinspection required"] };

function occurrenceKey(entry) {
  return JSON.stringify([entry.week, entry.day, entry.meal, entry.stall, entry.slot, entry.dishId]);
}

function TraceSection({ label, english, value }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t(label, english)}</summary>
    {expanded && (value != null ? <pre className="trace-json">{formatMenuTrace(value, { expanded })}</pre> : <Empty text={t("未记录此项", "No record for this item")} />)}
  </details>;
}

function ImpactOccurrences({ entries, dates, dishes }) {
  const { t } = useI18n();
  return <ul className="menu-impact-positions">{entries.map((entry, index) => {
    const date = entry.date || dates.get(occurrenceKey(entry)) || t("日期未记录", "Date not recorded");
    const dish = dishes.get(entry.dishId)?.name || entry.dishName || t("菜品 ", "Dish ") + (entry.dishId || t("未记录", "Not recorded"));
    const weekday = ["", "一", "二", "三", "四", "五", "六", "日"][entry.day] || entry.day;
    return <li key={index}><strong>{dish}</strong><span>{t("第 " + entry.week + " 周", "Week " + entry.week)} · {date} · {t("周" + weekday, ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][entry.day] || "Day " + entry.day)} · {t(entry.meal)} · {entry.stall} · {t("菜位 ", "Slot ")}{Number.isInteger(entry.slot) ? entry.slot + 1 : t("未记录", "Not recorded")}</span></li>;
  })}</ul>;
}

function ActionImpacts({ workflow, plan, dishes, direct }) {
  const { t, tr } = useI18n();
  const hasImpactRecord = Array.isArray(workflow.actionImpacts);
  const impacts = hasImpactRecord ? workflow.actionImpacts : [];
  const dates = new Map(plan.entries.map((entry) => [occurrenceKey(entry), entry.date]));
  return <section className="menu-impact-section" aria-labelledby="menu-impact-heading">
    <div className="section-heading"><h2 id="menu-impact-heading"><ListChecks size={18} />{t("已批准 Action · 菜单执行记录", "Approved Actions · Menu execution record")}</h2><Badge tone="blue">{hasImpactRecord ? t(impacts.length + " 项要求", impacts.length + " requirements") : t("执行记录缺失", "Execution record missing")}</Badge></div>
    <p className="muted small">{t("保留本次生成时的批准版本。以下是具体落实位置，不代表与无 Action 菜单相比的因果增减；调整事项后需重新生成。", "This preserves the approved versions used for generation. Listed positions show implementation, not causal changes versus a menu without Actions. Regenerate after editing Actions.")}</p>
    {workflow.stale && impacts.length > 0 && <p className="notice">{workflow.repairPendingInspection ? t("上次审核记录，修复后待重新核验。", "Previous review record; verification is required after repair.") : t("以下为上次检验的 Action 执行记录，已过期。", "The Action execution records below are from the previous inspection and are stale.")}{t("不能作为当前菜单的落实证明。", " They do not verify implementation in the current menu.")}</p>}
    {impacts.length ? <div className="action-impacts menu-impact-grid">{impacts.map((impact, index) => {
      const occurrences = impact.occurrences || [];
      const evidence = impact.evidence || [];
      return <article className="menu-impact-card" key={impact.actionId || impact.id || index} aria-label={t("Action 执行：", "Action implementation: ") + tr(impact.title)}>
        <header><span className="menu-impact-number">{String(index + 1).padStart(2, "0")}</span><Badge tone={workflow.stale ? "gray" : impact.status === "applied" ? "green" : "gold"}>{workflow.stale ? t("记录已过期", "Stale record") : impactLabels[impact.status] ? t(...impactLabels[impact.status]) : tr(impact.status)}</Badge></header>
        <h3>{tr(impact.title)}</h3><p className="menu-impact-scope">{impact.targetStall && impact.targetStall !== "全部档口" ? impact.targetStall : t("全部档口", "All stalls")} · {t("批准版本 ", "Approved version ")}{impact.revision ?? t("未记录", "Not recorded")}</p>
        <div className="menu-impact-instruction"><small>{t("排菜要求", "Menu requirement")}</small><p>{tr(impact.instruction) || t("未记录排菜要求", "No menu requirement recorded")}</p></div>
        {direct || impact.direct ? <div className="impact-numbers"><span>{t("本次关联槽位 ", "Linked slots ")}<strong>{impact.selectedEntries ?? occurrences.length}</strong></span></div> : <div className="impact-numbers"><span>{t("基线槽位 ", "Baseline slots ")}<strong>{impact.baselineEntries ?? t("未记录", "Not recorded")}</strong></span><span>{t("本次选用 ", "Selected now ")}<strong>{impact.selectedEntries ?? t("未记录", "Not recorded")}</strong></span><span>{t("变化槽位 ", "Changed slots ")}<strong>{impact.changedEntries ?? t("未记录", "Not recorded")}</strong></span></div>}
        <div className="menu-impact-evidence"><small>{impact.status === "applied" ? t("执行依据", "Implementation evidence") : t("执行说明 / 未完全落实原因", "Implementation notes / Reasons for incomplete application")}</small>{evidence.length ? evidence.slice(0, 2).map((item, i) => <p key={i}>{tr(readable(item))}</p>) : <p>{t("未提供可核验的执行说明，需人工复核。", "No verifiable implementation notes were provided. Human review is required.")}</p>}
          {evidence.length > 2 && <details><summary>{t("其余周次执行说明 · ", "Other weeks' implementation notes · ")}{evidence.length - 2}</summary>{evidence.slice(2).map((item, i) => <p key={i}>{tr(readable(item))}</p>)}</details>}
        </div>
        {occurrences.length ? <><ImpactOccurrences entries={occurrences.slice(0, 3)} dates={dates} dishes={dishes} />{occurrences.length > 3 && <details><summary>{t("查看其余关联位置 · ", "View other linked positions · ")}{occurrences.length - 3}</summary><ImpactOccurrences entries={occurrences.slice(3)} dates={dates} dishes={dishes} /></details>}</> : <p className="source">{t("暂无可定位到具体菜品的关联记录，不能据此确认事项已落实。", "No records link this Action to specific dishes, so implementation cannot be confirmed.")}</p>}
        <footer>{t("来源 Action：", "Source Action: ")}{impact.actionId || impact.id || t("未记录", "Not recorded")}</footer>
      </article>;
    })}</div> : <div className="menu-impact-empty"><ListChecks size={23} /><div><strong>{hasImpactRecord ? t("此菜单生成时未纳入排菜 Action", "No menu Actions were included when this menu was generated") : t("此历史菜单未记录 Action 执行情况", "This historical menu has no Action execution record")}</strong><p>{hasImpactRecord ? t("这是此菜单生成时的记录，不代表当前没有已批准事项。当前清单见页面上方“排菜 Action”；新增或调整要求需重新生成才会纳入。", "This is the generation-time record, not the current approval list. See Menu Actions above for the current list. Regenerate to include new or edited requirements.") : t("缺少记录不代表没有批准事项，也不能确认其已落实；重新生成后可查看执行依据。", "Missing records do not mean there were no approved Actions or verify implementation. Regenerate to view execution evidence.")}</p></div></div>}
  </section>;
}

function ReviewDetails({ plan, workflow, score, direct, demo, onClose, aiStatus, busy, onRepair, repairState, conflictView, setConflictView }) {
  const { t, tr, locale } = useI18n();
  const ruleInfo = workflow.sourceRuleInfo;
  const catalogInfo = workflow.catalogInfo;
  const inspectorHeading = !workflow.inspector?.verdict ? t("尚未完成 AI 检验", "AI inspection not yet complete") : workflow.stale ? t("上次检验结论已过期", "Previous inspection is stale") : workflow.inspector.verdict === "pass" ? (demo ? t("模拟", "Demo") : "AI") + t(" 检验通过 · 待人工审核", " inspection passed · Awaiting human review") : t("需要调整与复核", "Adjustment and review required");
  return <Modal title={t("菜单评分与检验详情", "Menu score and inspection details")} wide onClose={onClose}>
    <div className="menu-review-details">
      <p className="notice">{workflow.stale ? t("检验结果已过期，请重新检验后再判断当前菜单。", "Inspection results are stale. Reinspect before assessing the current menu.") : t("评分用于辅助改进，达到 80 分不等于审核通过；阻断冲突、未知食品标签和未解决要求仍须核实。", "Scores support improvement; reaching 80 is not approval. Blocking conflicts, unknown food labels and unresolved requirements still need verification.")}</p>
      <h3>{t("评分构成", "Score breakdown")}</h3>
      {score ? <><p>{tr(score.summary)}</p><div className="menu-score-dimensions">{(score.dimensions || []).map((dimension) => <article key={dimension.key}><header><strong>{tr(dimension.label)}</strong><span>{dimension.earned} / {dimension.weight}</span></header><div className="menu-score-track" aria-hidden="true"><i style={{ width: (dimension.weight > 0 ? Math.max(0, Math.min(100, dimension.earned / dimension.weight * 100)) : 0) + "%" }} /></div><p>{tr(dimension.detail)}</p></article>)}</div><p className="source">{t("评分版本：", "Score version: ")}{score.version} · {t("目标 " + score.target + " 分 · 阻断 " + (score.blockers ?? 0) + " 项 · 待核验 " + (score.unknownCount ?? 0) + " 项", "Target " + score.target + " points · " + (score.blockers ?? 0) + " blockers · " + (score.unknownCount ?? 0) + " to verify")}</p></> : <p className="muted">{t("此记录尚无服务端评分。可重新检验获取评分，页面不会补算或保底分数。", "This record has no server score. Reinspect to obtain one; the page does not invent or guarantee scores.")}</p>}
      <h3>{t("本地规则校验", "Local rule validation")}</h3>
      <div className="detail-meta"><Badge tone="red">{t((plan.validation?.errors || 0) + " 项冲突", (plan.validation?.errors || 0) + " conflicts")}</Badge><Badge tone="gold">{t((plan.validation?.warnings || 0) + " 项待核验", (plan.validation?.warnings || 0) + " to verify")}</Badge><span>{t("标签完整率 ", "Label coverage ")}{plan.validation?.labelCoverage ?? t("未记录", "Not recorded")}% · {t("槽位变化率 ", "Slot change rate ")}{plan.validation?.changeRate == null ? t("无可比基线", "No comparable baseline") : plan.validation.changeRate + "%"}</span></div>
      <MenuConflictTable plan={plan} workflow={workflow} aiStatus={aiStatus} busy={busy} onRepair={onRepair} repairState={repairState} viewState={conflictView} onViewChange={setConflictView} />
      <h3>{t("排菜员与检验员", "Planner and inspector")}</h3>
      <div className="role-results"><div><span className="role-label">{t("01 / 排菜员", "01 / Planner")}</span><h3>{direct ? t("GPT 直接编排", "Direct GPT planning") : t("规划与执行", "Planning and execution")}</h3>{workflow.planner?.model && <p className="source">{t("模型：", "Model: ")}{workflow.planner.model}</p>}<p>{tr(workflow.planner?.summary) || t("未返回规划摘要", "No planning summary returned")}</p></div><div><span className="role-label">{t("02 / 检验员", "02 / Inspector")}</span><h3>{inspectorHeading}</h3>{workflow.inspector?.model && <p className="source">{t("模型：", "Model: ")}{workflow.inspector.model}</p>}<p>{tr(workflow.inspector?.summary) || t("尚无检验结论", "No inspection conclusion yet")}</p></div></div>
      {!!workflow.planner?.unresolved?.length && <><h3>{t("未解决要求 · ", "Unresolved requirements · ")}{workflow.planner.unresolved.length}</h3>{workflow.planner.unresolved.map((item, index) => <p className="summary-item" key={index}>{tr(typeof item === "string" ? item : item.reason)}<small className="source">{t("Action：", "Action: ")}{item.actionId || t("未关联", "Not linked")}</small></p>)}</>}
      <p className="muted small">{t("AI 检验发现已与本地冲突合并展示于上方列表；仍以本地校验和人工审核为准。", "AI findings and local conflicts are combined above. Local validation and human review remain authoritative.")}</p>
      <h3>{t("数据来源与运行信息", "Data sources and run details")}</h3>
      <p className="source">{t("菜单范围：", "Menu scope: ")}{plan.scope === "all" ? t("全部档口", "All stalls") : t("历史单档口 · ", "Historical single stall · ") + plan.stall} · {t("生成或保存不代表人工审核通过。", "Generation or saving does not imply human approval.")}</p>
      {catalogInfo && <section className="menu-catalog-detail"><h3>{t("菜库入库与档口来源", "Catalog import and stall sources")}</h3><p className="source">{catalogInfo.file || t("本地菜单库", "Local dish catalog")}{catalogInfo.sha256 ? t(" · 版本指纹 ", " · Version fingerprint ") + catalogInfo.sha256.slice(0, 12) : ""}</p><p className="small">{t("原始条目 ", "Source rows ")}{catalogInfo.stats?.sourceRows ?? t("未记录", "Not recorded")} · {t("去重后 ", "Unique dishes ")}{catalogInfo.stats?.uniqueDishes ?? t("未记录", "Not recorded")} · {t("合并重复 ", "Duplicates merged ")}{catalogInfo.stats?.duplicates ?? 0} · {t("隔离异常 ", "Rejected rows ")}{catalogInfo.stats?.rejected ?? 0}</p><p className="small">{t("每个档口从自己的候选菜中独立编排；源库未覆盖的档口保留可追溯的补充菜库。异常或未匹配条目不作为已验证候选。", "Each stall plans from its own candidates. Stalls absent from the source catalog use traceable supplemental sources. Invalid or unmatched rows are not verified candidates.")}</p><div className="menu-catalog-groups">{(catalogInfo.groups || []).map((group) => <div key={group.stall}><strong>{group.stall}</strong><Badge tone={group.origin === "primary" ? "green" : "gold"}>{group.origin === "primary" ? t("原始菜单库", "Source catalog") : t("补充来源", "Supplemental source")}</Badge><span>{t(group.candidates + " 道可选", group.candidates + " candidates")}{group.unresolved ? t(" · " + group.unresolved + " 项待核实", " · " + group.unresolved + " to verify") : ""}</span></div>)}</div>{!!catalogInfo.warnings?.length && <details><summary>{t("菜库入库待核实项 · ", "Catalog import checks · ")}{catalogInfo.warnings.length}</summary>{catalogInfo.warnings.map((warning, index) => <p className="source" key={index}>{tr(readable(warning))}</p>)}</details>}</section>}
      {workflow.source && <p className="source">{t("生成来源：", "Generation source: ")}{tr(workflow.source)}</p>}
      {ruleInfo && <p className="source">{t("规则来源：", "Rule source: ")}{ruleInfo.file || t("本地规则文件", "Local rule file")} · {ruleInfo.ruleCount ?? t("未记录", "Not recorded")}{t(" 条规则", " rules")}{ruleInfo.sha256 ? t(" · 版本指纹 ", " · Version fingerprint ") + ruleInfo.sha256.slice(0, 12) : ""}</p>}
      <p className="source">{t("运行 ", "Run ")}{workflow.runId} · {workflow.inspectedAt ? new Date(workflow.inspectedAt).toLocaleString(locale) : t("尚无检验时间", "No inspection time recorded")}</p>
      <p className="notice">{t("本地规则约束不可被 Action 覆盖。检验结果供辅助审查，最终菜单仍需运营人员审核；生成或保存草案不代表发布。", "Actions cannot override local rules. Inspection assists review; operations must approve the final menu. Generating or saving a draft does not publish it.")}</p>
      {!!plan.fixedStaples?.length && <details className="action-evidence"><summary>{t("固定主食 · 沿用源文件", "Fixed staples · From source files")}</summary>{plan.fixedStaples.filter((item) => plan.meals.includes(item.meal)).map((item, index) => <p key={index}><strong>{item.stall} · {t(item.meal)}</strong>：{item.text}<small className="source">{item.source?.file} · {item.source?.sheet} · {item.source?.cell}</small></p>)}</details>}
    </div>
  </Modal>;
}

export default function MenuWorkflow({ plan, setPlan, aiStatus, run, busy, dishes = [], detailsOpen = false, onDetailsChange, onRepairBusyChange }) {
  const { t, tr, locale } = useI18n();
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
      if (!result?.plan?.entries || !result.plan.validation || !["repaired", "unchanged"].includes(result.repair?.status)) throw new Error(t("修复结果不完整，未替换原菜单", "The repair result is incomplete; the original menu was not replaced"));
      if (result.repair.status === "repaired" && (!result.plan.workflow?.stale || !result.plan.workflow?.repairPendingInspection)) throw new Error(t("修复结果缺少重新检验标记，未替换原菜单", "The repair result lacks a reinspection marker; the original menu was not replaced"));
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
  return <section className="workflow-section menu-result-review" aria-label={t("菜单评分与 Action 执行", "Menu score and Action implementation")}>
    <section className={"menu-score-hero " + tone} aria-label={t("菜单质量评分", "Menu quality score")}>
      <div className="menu-score-value" aria-label={score ? t("菜单评分 " + score.value + " 分" + (stale ? "，已过期" : ""), "Menu score " + score.value + " points" + (stale ? ", stale" : "")) : stale ? t("菜单评分已失效", "Menu score is invalid") : t("菜单尚未评分", "Menu not yet scored")}><strong>{score ? score.value : "—"}</strong><span>/ 100</span><small>{stale ? score ? t("上次评分 · 已过期", "Previous score · Stale") : t("评分已失效", "Score invalid") : demo ? t("模拟检验评分", "Demo inspection score") : t("菜单质量评分", "Menu quality score")}</small></div>
      <div className="menu-score-copy"><div className="menu-score-eyebrow"><Target size={15} />{t("质量目标 " + (score?.target ?? 80) + " 分", "Quality target: " + (score?.target ?? 80) + " points")}<Badge tone={stale ? "gray" : score?.targetMet ? "green" : "gold"}>{stale ? t("待重新评定", "Reassessment needed") : !score ? t("尚未评分", "Not scored") : score.targetMet ? t("达到目标", "Target met") : t("仍需优化", "Improvement needed")}</Badge></div><h2>{stale ? t("菜单或依据已更新，请重新检验", "Menu or source data changed; reinspect") : tr(score?.label) || t("菜单已生成，等待质量复核", "Menu generated; awaiting quality review")}</h2><p>{stale ? score ? t("此分值来自上次检验，不能代表当前菜单质量。", "This score is from the previous inspection and does not represent the current menu.") : t("评分已失效，待重新检验。", "The score is invalid; reinspection is required.") : tr(score?.summary) || t("此记录尚无质量分数，可重新检验后查看。", "No quality score is available. Reinspect to view one.")}</p><div className="menu-score-status"><Badge tone={blocked || stale ? "gold" : "blue"}>{t(...(stale ? workflowLabels.stale : workflowLabels[workflow.status] || workflowLabels.needs_review))}</Badge><span>{stale ? t("历史评分不再作为当前菜单的审核依据。", "Historical scores no longer support review of the current menu.") : blocked ? t("存在阻断，不能以分值代替冲突处理。", "Blockers remain; the score cannot replace conflict resolution.") : t("达到目标不等于审核通过，最终仍需人工确认。", "Meeting the target is not approval. Human confirmation is still required.")}</span></div></div>
      <button className="menu-score-details" disabled={busy} onClick={() => onDetailsChange?.(true)}><ClipboardCheck size={16} />{t("查看评分与冲突详情", "View score and conflict details")}<ArrowUpRight size={15} /></button>
    </section>
    {stale && !!workflow.staleReasons?.length && <p className="notice">{tr(workflow.staleReasons.join("；"))}</p>}
    {demo && <p className="notice">{t("模拟测试 · 使用示例改善事项，不调用 Azure AI，不代表真实员工反馈或正式审核。", "Demo test · Uses sample Actions without calling Azure AI; not real employee feedback or formal approval.")}</p>}
    <ActionImpacts workflow={{ ...workflow, stale }} plan={plan} dishes={new Map(dishes.map((dish) => [dish.id, dish]))} direct={direct} />
    <div className="menu-review-toolbar"><p className="source">{direct ? t("GPT 直接编排", "Direct GPT planning") : t("规划与执行", "Planning and execution")} · {workflow.inspectedAt ? t("最近检验 ", "Last inspected ") + new Date(workflow.inspectedAt).toLocaleString(locale) : t("尚无检验时间", "No inspection time recorded")}</p><div className="actions">{workflow.runId && <button disabled={busy} onClick={() => run(async () => { setTrace(await diningApi.plans.run(workflow.runId)); return t("已读取本次排菜留痕", "Menu run trace loaded"); })}><Fingerprint size={15} />{t("查看运行留痕", "View run trace")}</button>}<button disabled={busy || (!demo && !aiStatus?.configured)} onClick={() => run(async () => { setPlan(await diningApi.plans.inspect({ ...plan, demo })); setRepairState(null); return t("检验员已完成重新检验，请查看报告", "Reinspection is complete. View the report."); })}><Sparkles size={15} />{demo ? t("重新模拟检验", "Rerun demo inspection") : t("重新 AI 检验", "Rerun AI inspection")}</button></div></div>
    {detailsOpen && <ReviewDetails plan={plan} workflow={{ ...workflow, stale }} score={score} direct={direct} demo={demo} onClose={() => onDetailsChange?.(false)} aiStatus={aiStatus} busy={busy} onRepair={repairIssue} repairState={repairState} conflictView={conflictView} setConflictView={setConflictView} />}
    {trace && <Modal title={t("排菜运行留痕", "Menu run trace")} wide onClose={() => setTrace(null)}><p className="muted small">{t("展开查看审核数据。界面可切换语言，反馈、菜单、规则、Prompt 与审核记录均保留原文。", "Expand to view audit data. Interface labels follow your language setting; feedback, menus, rules, prompts and audit records remain in their original language.")}</p><div className="detail-meta"><Badge>{tr(trace.status || workflow.status)}</Badge><span>{trace.id || workflow.runId}</span></div><p className="source">{t("创建：", "Created: ")}{trace.createdAt ? new Date(trace.createdAt).toLocaleString(locale) : t("时间未记录", "Time not recorded")}</p>{[["排菜范围", "Planning scope", trace.input], ["Action 快照", "Action snapshot", trace.snapshots?.actions], ["规则快照", "Rule snapshot", trace.snapshots?.rules], ["排菜决策", "Planning decisions", trace.planner || trace.workflow?.planner], ["检验结果", "Inspection results", trace.workflow?.inspector || trace.inspector]].map(([label, english, value]) => <TraceSection key={label} label={label} english={english} value={value} />)}</Modal>}
  </section>;
}
