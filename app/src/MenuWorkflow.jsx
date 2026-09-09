import { useState } from "react";
import { ClipboardCheck, Fingerprint, Sparkles } from "lucide-react";
import { Badge, Empty, Modal } from "./shared";
import { readable } from "./ui-text";
import { diningApi } from "./api/dining";

const impactLabels = { applied: "已应用", partial: "部分应用", not_applied: "未应用" };
const workflowLabels = { needs_review: "待人工审核", blocked: "检验未通过", stale: "需重新检验" };

export default function MenuWorkflow({ plan, setPlan, aiStatus, run, busy }) {
  const [trace, setTrace] = useState(null);
  const workflow = plan.workflow;
  if (!workflow) return null;
  const demo = Boolean(plan.demo || workflow.demo || workflow.mode === "demo");
  return (
    <section className="work-section workflow-section">
      <div className="section-heading"><h2><ClipboardCheck size={18} /> 排菜员与检验员 <Badge tone={workflow.status === "blocked" || workflow.stale ? "gold" : "blue"}>{workflowLabels[workflow.status] || workflow.status}</Badge></h2><div className="actions">
        {workflow.runId && <button disabled={busy} onClick={() => run(async () => { setTrace(await diningApi.plans.run(workflow.runId)); return "已读取本次排菜留痕"; })}><Fingerprint size={15} />查看运行留痕</button>}
        <button disabled={busy || (!demo && !aiStatus?.configured)} onClick={() => run(async () => { setPlan(await diningApi.plans.inspect({ ...plan, demo })); return "检验员已完成重新检验，请查看报告"; })}><Sparkles size={15} />{demo ? "重新模拟检验" : "重新 AI 检验"}</button>
      </div></div>
      <p className="muted small">运行 {workflow.runId} · {workflow.inspectedAt ? new Date(workflow.inspectedAt).toLocaleString("zh-CN") : "尚无检验时间"}</p>
      {demo && <p className="notice">模拟测试 · 使用示例改善事项，不调用 Azure AI，不代表真实员工反馈或正式审核。</p>}
      {workflow.stale && <p className="notice">菜单或输入已调整，原检验结果已过期。{(workflow.staleReasons || []).join("；")}</p>}
      <div className="role-results">
        <div><span className="role-label">01 / 排菜员</span><h3>规划与执行</h3><p>{workflow.planner?.summary || "未返回规划摘要"}</p>{!!workflow.planner?.unresolved?.length && <details><summary>未解决项 · {workflow.planner.unresolved.length}</summary>{workflow.planner.unresolved.map((item, index) => <p className="summary-item" key={index}>{item.reason}<small className="source">Action：{item.actionId || "未关联"}</small></p>)}</details>}</div>
        <div><span className="role-label">02 / 检验员</span><h3>{workflow.inspector?.verdict === "pass" ? `${demo ? "模拟" : "AI"} 检验通过 · 待人工审核` : "需要调整与复核"}</h3><p>{workflow.inspector?.summary || "尚无检验结论"}</p></div>
      </div>
      {!!workflow.inspector?.findings?.length && <div className="issue-list">{workflow.inspector.findings.map((finding, index) => <div key={index}><Badge tone={finding.severity === "error" ? "red" : "gold"}>{finding.severity === "error" ? "冲突" : "待核验"}</Badge><span>{finding.text}{!!finding.actionIds?.length && <small>关联 Action：{finding.actionIds.join("、")}</small>}{!!finding.ruleIds?.length && <small>依据规则：{finding.ruleIds.join("、")}</small>}</span></div>)}</div>}
      <h3>反馈 Action 对菜单的影响</h3>
      {workflow.actionImpacts?.length ? <div className="action-impacts">{workflow.actionImpacts.map((impact) => <details key={impact.actionId}><summary><span><strong>{impact.title}</strong><small>{impact.targetStall || "全部档口"} · Action 版本 {impact.revision}</small></span><Badge tone={impact.status === "applied" ? "green" : "gold"}>{impactLabels[impact.status] || impact.status}</Badge></summary><p>{impact.instruction}</p><div className="impact-numbers"><span>基线槽位 <strong>{impact.baselineEntries ?? 0}</strong></span><span>本次选用 <strong>{impact.selectedEntries ?? 0}</strong></span><span>变化槽位 <strong>{impact.changedEntries ?? 0}</strong></span></div>{(impact.evidence || []).map((evidence, index) => <p className="source" key={index}>{readable(evidence)}</p>)}<p className="source">来源 Action：{impact.actionId} · 可在“Action 事项”调整后重新生成。</p></details>)}</div> : <p className="muted small">本次运行没有已批准且启用的反馈 Action。</p>}
      <p className="notice">检验结果供辅助审查，最终菜单仍需运营人员审核；此处保留生成时的改善事项与执行依据。</p>
      {trace && <Modal title="排菜运行留痕" wide onClose={() => setTrace(null)}><div className="detail-meta"><Badge>{trace.status || workflow.status}</Badge><span>{trace.id || workflow.runId}</span></div><p className="source">创建：{trace.createdAt ? new Date(trace.createdAt).toLocaleString("zh-CN") : "时间未记录"}</p>{[ ["排菜范围", trace.input], ["Action 快照", trace.snapshots?.actions], ["规则快照", trace.snapshots?.rules], ["排菜决策", trace.planner || trace.workflow?.planner], ["检验结果", trace.workflow?.inspector || trace.inspector] ].map(([label, value]) => <details key={label}><summary>{label}</summary>{value ? <pre className="trace-json">{JSON.stringify(value, null, 2)}</pre> : <Empty text="未记录此项" />}</details>)}</Modal>}
    </section>
  );
}
