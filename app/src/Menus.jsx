import { useRef, useState } from "react";
import {
  CalendarDays,
  CheckCheck,
  Shuffle,
  Save,
  ShieldAlert,
  Store,
  Pencil,
  History,
  LoaderCircle,
} from "lucide-react";
import { Badge, Empty, ExportButton, Field, Metric, Modal } from "./shared";
import { downloadCsv } from "./api";
import { diningApi } from "./api/dining";
import { menuRows } from "./menu-export";
import { AiAvailability } from "./FeedbackWorkflow";
import MenuWorkflow from "./MenuWorkflow";
import MenuConflictTable from "./MenuConflictTable";
import MenuActionsPanel from "./MenuActionsPanel";
import "./menu-progress.css";

function nextMonday() {
  const date = new Date();
  date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function completedWeeks(item) {
  return Math.max(0, Math.min(6, Number(item.completedWeeks) || 0));
}

function runLocation(error) {
  if (!error) return "";
  return [error.week && `第 ${error.week} 周`, error.stall, error.day && `第 ${error.day} 天`, error.meal,
    Number.isInteger(error.slot) && `菜位 ${error.slot + 1}`].filter(Boolean).join(" · ");
}

export default function Menus({ data, run, busy, onNavigate }) {
  const [start, setStart] = useState(nextMonday);
  const [seed, setSeed] = useState(1);
  const [count, setCount] = useState(4);
  const [meals, setMeals] = useState(["午餐", "晚餐"]);
  const [completePlan, setPlan] = useState(null);
  const [partialPlan, setPartialPlan] = useState(null);
  const [progress, setProgress] = useState(null);
  const plan = partialPlan || completePlan;
  const isPartial = Boolean(plan?.partial);
  const [week, setWeek] = useState("all");
  const [meal, setMeal] = useState("午餐");
  const [stallFilter, setStallFilter] = useState("");
  const [detailIndex, setDetailIndex] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [editing, setEditing] = useState(null);
  const [replacement, setReplacement] = useState("");
  const [search, setSearch] = useState("");
  const [issues, setIssues] = useState(false);
  const [history, setHistory] = useState(false);
  const [rules, setRules] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [repairBusy, setRepairBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [failedRunId, setFailedRunId] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [recoverableRuns, setRecoverableRuns] = useState([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [openingResult, setOpeningResult] = useState(false);
  const generationInFlight = useRef(false);
  const recoveryInFlight = useRef(null);
  const resultInFlight = useRef(false);
  const menuBusy = busy || generating || openingResult || repairBusy;
  const aiUnavailable = useAi && !data.aiStatus?.configured;
  const allStalls = [...new Set(data.dishes.map((dish) => dish.stall))];
  const planStalls = plan
    ? plan.scope === "all"
      ? plan.stalls
      : [plan.stall]
    : [];
  const visibleStalls = stallFilter
    ? planStalls.filter((stall) => stall === stallFilter)
    : planStalls;
  const dishes = new Map(data.dishes.map((dish) => [dish.id, dish]));
  const entryStall = (entry) => entry.stall || plan.stall;
  const editingStall =
    editing === null ? "" : entryStall(plan.entries[editing]);
  const candidates = data.dishes.filter(
    (dish) =>
      dish.stall === editingStall && dish.active && dish.name.includes(search),
  );
  const effectiveMeal = plan?.meals.includes(meal) ? meal : plan?.meals[0];
  const availableWeeks = isPartial
    ? [...new Set(plan.entries.map((entry) => entry.week))].sort((left, right) => left - right)
    : [1, 2, 3, 4, 5, 6];
  const visibleWeeks = week === "all" ? availableWeeks : availableWeeks.filter((value) => value === week);
  const grouped = new Map();
  for (const [index, entry] of (plan?.entries || []).entries()) {
    const key = JSON.stringify([
      entry.week,
      entry.meal,
      entryStall(entry),
      entry.day,
    ]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ entry, index });
  }
  function showPlan(next) {
    setPlan(next);
    setPartialPlan(null);
    setProgress(null);
    setWeek("all");
    setStallFilter("");
    setMeal(next.meals[0]);
  }
  function receiveProgress(event) {
    if (!["started", "week", "inspecting"].includes(event.type)) return;
    const done = completedWeeks(event);
    setProgress({ runId: event.runId, completedWeeks: done,
      currentWeek: event.type === "week" ? Math.min(6, done + 1) : event.currentWeek || Math.min(6, done + 1),
      stage: event.type === "inspecting" ? "inspecting" : "planning" });
    if (event.plan?.entries?.length) {
      setPartialPlan({ ...event.plan, partial: true, completedWeeks: done });
    }
  }
  async function refreshRecoverableRuns() {
    if (recoveryInFlight.current) return recoveryInFlight.current;
    setRecoveryLoading(true);
    setRecoveryError("");
    const request = diningApi.plans.recoverableRuns().then(setRecoverableRuns).catch((error) => {
      setRecoveryError(error.message);
    }).finally(() => {
      recoveryInFlight.current = null;
      setRecoveryLoading(false);
    });
    recoveryInFlight.current = request;
    return request;
  }
  function openRecovery() {
    setRecovery(true);
    void refreshRecoverableRuns();
  }
  async function generate(resumeRun = null) {
    if (busy || repairBusy || generationInFlight.current || resultInFlight.current) return;
    if (resumeRun ? !resumeRun.resumable || !data.aiStatus?.configured : aiUnavailable || !meals.length) return;
    generationInFlight.current = true;
    setGenerating(true);
    setGenerationError("");
    setFailedRunId("");
    if (!resumeRun || resumeRun.id !== failedRunId) setPartialPlan(null);
    setProgress(resumeRun || useAi ? {
      completedWeeks: resumeRun ? completedWeeks(resumeRun) : 0,
      currentWeek: resumeRun ? Math.min(6, completedWeeks(resumeRun) + 1) : 1,
      stage: "planning",
    } : null);
    setWeek("all");
    setStallFilter("");
    setDetailIndex(null);
    setEditing(null);
    setIssues(false);
    if (resumeRun) setRecovery(false);
    try {
      await run(async () => {
        try {
          const input = { scope: "all", start, seed, count, meals, demo: false, useAi };
          const next = resumeRun
            ? await diningApi.plans.resumeProgressive(resumeRun.id, { onEvent: receiveProgress })
            : useAi
              ? await diningApi.plans.generateProgressive(input, { onEvent: receiveProgress })
              : await diningApi.plans.generate(input);
          showPlan(next);
          return `${resumeRun ? "GPT 已恢复生成：" : useAi ? "GPT 已生成：" : "本地规则草案（未调用 GPT）："}${next.stalls.length} 个档口的完整六周菜单，待人工审核与保存`;
        } catch (error) {
          setGenerationError(error.message);
          setFailedRunId(error.runId || resumeRun?.id || "");
          if (resumeRun || useAi) void refreshRecoverableRuns();
          throw error;
        }
      }, { background: true });
    } finally {
      generationInFlight.current = false;
      setGenerating(false);
    }
  }
  async function openSavedResult(item) {
    if (busy || generationInFlight.current || resultInFlight.current || !item.canUseSavedResult) return;
    resultInFlight.current = true;
    setOpeningResult(true);
    setRecoveryError("");
    try {
      await run(async () => {
        try {
          showPlan(await diningApi.plans.result(item.id));
          setRecovery(false);
          setGenerationError("");
          setFailedRunId("");
          return "已恢复此前 GPT 生成的完整六周菜单，未重新调用 AI，仍需人工审核与保存";
        } catch (error) {
          setRecoveryError(error.message);
          throw error;
        }
      }, { background: true });
    } finally {
      resultInFlight.current = false;
      setOpeningResult(false);
    }
  }
  function exportPlan() {
    if (isPartial) return;
    downloadCsv(
      `六周菜单-${plan.stall}-${plan.start}.csv`,
      menuRows(plan, data.dishes),
    );
  }
  function beginEdit(index) {
    if (isPartial || menuBusy) return;
    setEditing(index);
    setReplacement(plan.entries[index].dishId);
    setSearch("");
    setDetailIndex(null);
  }
  const detail = detailIndex === null ? null : plan.entries[detailIndex];
  const detailDish = detail ? dishes.get(detail.dishId) : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PLANNING / 02</span>
          <h1>全部档口六周菜单</h1>
        </div>
        <div className="actions">
          <button onClick={openRecovery}>
            <History size={16} />
            恢复生成记录
          </button>
          <button onClick={() => setRules(true)}>
            <ShieldAlert size={16} />
            排菜规则
          </button>
          <button onClick={() => setHistory(true)}>
            <History size={16} />
            草案记录 <Badge>{data.plans.length}</Badge>
          </button>
        </div>
      </div>
      <MenuActionsPanel actions={data.actions || []} useAi={useAi} hasPlan={Boolean(plan)} onManage={() => onNavigate?.("actions")} />
      <section className="planner-controls">
        <div className="generation-scope">
          <small>生成范围</small>
          <strong>
            <Store size={18} />
            全部 {allStalls.length} 个档口
          </strong>
        </div>
        <Field label="起始周一">
          <input
            aria-label="起始周一"
            type="date"
            value={start}
            disabled={menuBusy}
            onChange={(event) => setStart(event.target.value)}
          />
        </Field>
        <Field label="餐次">
          <div className="meal-checks">
            {["早餐", "午餐", "晚餐"].map((name) => (
              <label className="check" key={name}>
                <input
                  type="checkbox"
                  checked={meals.includes(name)}
                  disabled={menuBusy}
                  onChange={(event) =>
                    setMeals(
                      event.target.checked
                        ? [...meals, name]
                        : meals.filter((item) => item !== name),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="通用档口菜数">
          <input
            type="number"
            aria-label="每餐菜数"
            value={count}
            disabled={menuBusy}
            min="1"
            max="12"
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </Field>
        <Field label="方案种子">
          <input
            type="number"
            aria-label="方案种子"
            min="1"
            max="1000000"
            value={seed}
            disabled={menuBusy}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </Field>
        <button
          className="primary"
          disabled={menuBusy || !meals.length || aiUnavailable}
          onClick={() => generate()}
        >
          <Shuffle size={16} />
          一次生成全部档口六周菜单
        </button>
      </section>
      <div className="ai-planner-controls">
        <label className="check">
          <input type="checkbox" checked={useAi} disabled={menuBusy} onChange={(event) => setUseAi(event.target.checked)} />
          启用 AI 排菜员与检验员
        </label>
        <p className="muted small">{useAi ? "菜品库已完成本地入库，从数据库按档口取菜，GPT 再分别排菜：每周完成即展示，前面周次输入 AI 后生成下一周，最后统一检验评分。分档口调用比整周一次调用耗时更长；固定与人工规则不由 AI 编造。" : "已关闭 AI：仅生成本地规则草案，不调用 GPT；不代表已完成 AI 排菜或检验。"}</p>
        <AiAvailability status={data.aiStatus} />
        {aiUnavailable && <p className="notice" role="alert">AI 服务未配置，无法生成真实 GPT 菜单。请先配置服务端；如仅需本地规则草案，可明确关闭 AI。不会自动降级。</p>}
      </div>
      {generating && <section className="work-section menu-generation-wait" aria-label="正在生成六周菜单">
        <div className="section-heading"><h2><LoaderCircle size={18} className="spin" aria-hidden="true" />{progress ? progress.stage === "inspecting" ? "六周菜单已齐备，检验员正在复核" : `GPT 正在生成第 ${progress.currentWeek} 周菜单` : "正在生成本地规则草案"}</h2>{progress && <Badge tone="blue">已完成 {progress.completedWeeks} / 6 周</Badge>}</div>
        <p role="status">{progress ? progress.stage === "inspecting" ? "已完成的六周菜单可先查看，正在汇总规则校验与 Action 执行情况。" : progress.completedWeeks ? `已完成 ${progress.completedWeeks} / 6 周并展示在下方；前面生成的菜单会输入 AI，接着编排下一周。` : "正在读取本地规则与已批准事项，第 1 周完成后会立即展示。" : "正在准备菜单与规则校验报告。"}完整结果仍需人工审核与保存。</p>
        {progress && <ol className="menu-generation-steps" aria-label="六周生成进度">{[1, 2, 3, 4, 5, 6].map((value) => <li key={value} className={value <= progress.completedWeeks ? "done" : value === progress.currentWeek && progress.stage !== "inspecting" ? "active" : ""}><span>第 {value} 周</span><small>{value <= progress.completedWeeks ? "已展示" : value === progress.currentWeek && progress.stage !== "inspecting" ? "生成中" : "等待中"}</small></li>)}</ol>}
        <p className="muted small">可切换到其他页面继续操作，生成将在后台继续。请勿重复提交。</p>
      </section>}
      {generationError && <div className="notice menu-generation-error" role="alert"><p>{generationError}。{isPartial ? `已保留下方完成的 ${completedWeeks(plan)} 周菜单；未生成替代菜品，已有草案保持不变。` : "未生成替代菜单，已有草案保持不变。"}</p>{failedRunId && <p className="source">生成记录：{failedRunId}</p>}<button onClick={openRecovery}>恢复生成记录</button><span className="small">可检查已完成周次，继续生成或取回结果，无需直接重跑六周。</span></div>}
      {plan ? (
        <>
          {isPartial ? <div className="notice menu-partial-notice" role="note"><span><strong>逐周预览 · 已完成 {completedWeeks(plan)} / 6 周</strong> · 仅展示 AI 已生成的周次。六周生成并检验结束前不可编辑、保存或导出。</span>{completePlan && !generating && <button onClick={() => { setPartialPlan(null); setProgress(null); setWeek("all"); setStallFilter(""); }}>返回此前草案</button>}</div> : <>{!plan.workflow && <p className="notice">本地规则草案 · 未经 GPT 生成或检验，仍需人工审核。</p>}<MenuWorkflow plan={plan} setPlan={setPlan} aiStatus={data.aiStatus} run={run} busy={menuBusy} dishes={data.dishes} detailsOpen={issues} onDetailsChange={setIssues} onRepairBusyChange={setRepairBusy} /></>}
          <div className="metrics planner-metrics">
            <Metric
              label="排菜周期"
              value={isPartial ? `${completedWeeks(plan)} / 6 周` : "6 周"}
              detail={`${plan.start} 至 ${plan.entries.at(-1)?.date || plan.start} · ${isPartial ? `${completedWeeks(plan) * 5}个工作日已生成` : "30个工作日"}`}
              icon={CalendarDays}
              color="blue"
            />
            <Metric
              label="覆盖档口"
              value={`${planStalls.length} 个`}
              detail={
                plan.scope === "all"
                  ? isPartial ? "全部档口 · 逐周预览" : "全部档口 · 一份完整草案"
                  : "历史单档口草案"
              }
              icon={Store}
            />
            <Metric
              label="已排槽位"
              value={`${plan.entries.filter((entry) => entry.dishId).length} / ${plan.entries.length}`}
              detail="主食固定内容需另行复核"
              icon={CheckCheck}
            />
            <Metric
              label="待核验 / 冲突"
              value={isPartial ? "待检验" : `${plan.validation.warnings} / ${plan.validation.errors}`}
              detail={isPartial ? "六周齐备后统一复核" : "不代表审核通过"}
              icon={ShieldAlert}
              color="gold"
            />
          </div>
          {!isPartial && !plan.workflow && <div className="notice planner-notice">
            <span>
              <strong>待审核草案</strong> · 标签完整率{" "}
              {plan.validation.labelCoverage}% ·
              开餐范围、食品标签及共享例外待确认
            </span>
            <button className="text-button" disabled={menuBusy} onClick={() => setIssues(true)}>
              查看校验报告
            </button>
          </div>}
          <section className="work-section">
            <div className="section-heading">
              <h2>
                {plan.stall} <Badge>{isPartial ? "逐周预览" : "六周草案"}</Badge>
              </h2>
              <div className="actions">
                {!isPartial && <ExportButton onClick={exportPlan}>导出六周菜单</ExportButton>}
                <button
                  className="primary"
                  disabled={menuBusy || isPartial || Boolean(plan.workflow?.repairPendingInspection)}
                  title={plan.workflow?.repairPendingInspection ? "修复后须重新 AI 检验再保存" : undefined}
                  onClick={() =>
                    run(async () => {
                      if (plan.workflow?.repairPendingInspection) throw new Error("修复后须重新 AI 检验再保存");
                      setPlan(await diningApi.plans.save(plan));
                      return "完整六周草案已保存为新版本";
                    })
                  }
                >
                  <Save size={16} />
                  保存整份草案
                </button>
              </div>
            </div>
            <div className="planner-tabs">
              <div className="tabs" role="tablist" aria-label="周次">
                <button
                  role="tab"
                  aria-selected={week === "all"}
                  className={week === "all" ? "active" : ""}
                  onClick={() => setWeek("all")}
                >
                  {isPartial ? "已生成周次" : "完整六周"}
                </button>
                {availableWeeks.map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={week === value}
                    className={week === value ? "active" : ""}
                    onClick={() => setWeek(value)}
                  >
                    第{value}周
                  </button>
                ))}
              </div>
              <div className="menu-view-filters">
                <select
                  aria-label="查看档口"
                  value={stallFilter}
                  onChange={(event) => setStallFilter(event.target.value)}
                >
                  <option value="">全部档口</option>
                  {planStalls.map((stall) => (
                    <option key={stall}>{stall}</option>
                  ))}
                </select>
                <div className="segmented">
                  {plan.meals.map((name) => (
                    <button
                      key={name}
                      className={effectiveMeal === name ? "active" : ""}
                      onClick={() => setMeal(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {visibleWeeks.map((displayWeek) => {
              const first = plan.entries.find(
                (entry) => entry.week === displayWeek,
              );
              return (
                <section
                  className="plan-week"
                  key={displayWeek}
                  aria-label={`第${displayWeek}周菜单`}
                >
                  <h3>
                    第{displayWeek}周 · {effectiveMeal}
                  </h3>
                  <div className="table-scroll">
                    <table className="all-stall-menu">
                      <thead>
                        <tr>
                          <th>档口</th>
                          {["一", "二", "三", "四", "五"].map((day, index) => {
                            const date = new Date(`${first.date}T00:00:00Z`);
                            date.setUTCDate(date.getUTCDate() + index);
                            return (
                              <th key={day}>
                                周{day}
                                <small>{date.toISOString().slice(5, 10)}</small>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleStalls.map((stall) => (
                          <tr key={stall} className="stall-menu-row">
                            <th scope="row">{stall}</th>
                            {[1, 2, 3, 4, 5].map((day) => (
                              <td key={day}>
                                {(
                                  grouped.get(
                                    JSON.stringify([
                                      displayWeek,
                                      effectiveMeal,
                                      stall,
                                      day,
                                    ]),
                                  ) || []
                                ).map(({ entry, index }) => {
                                  const dish = dishes.get(entry.dishId);
                                  return (
                                    <button
                                      key={entry.slot}
                                      className={`menu-item ${!dish ? "missing" : ""}`}
                                      aria-label={`查看${stall}-${entry.date}-${entry.slot}明细`}
                                      title="查看菜品明细"
                                      disabled={menuBusy || isPartial}
                                      onClick={() =>
                                        run(async () => {
                                          setRecipes(
                                            dish
                                              ? await diningApi.catalog.recipes(dish.id)
                                              : [],
                                          );
                                          setDetailIndex(index);
                                          return "已读取菜品明细";
                                        })
                                      }
                                    >
                                      <span>{dish?.name || "待补菜"}</span>
                                      {dish && <small>¥{dish.priceText}</small>}
                                    </button>
                                  );
                                })}
                                {(plan.fixedStaples || []).filter(item => item.stall === stall && item.meal === effectiveMeal).map((item, index) => <p className="source fixed-staple-menu" key={`staple-${index}`}>固定主食：{item.text}</p>)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </section>
        </>
      ) : (
        <Empty text="暂无全部档口六周菜单草案" />
      )}
      {detail && (
        <Modal title="菜品明细" onClose={() => setDetailIndex(null)} wide>
          <div className="detail-meta">
            <Badge>{entryStall(detail)}</Badge>
            <span>
              {detail.date} · 第{detail.week}周 · {detail.meal}
            </span>
          </div>
          <h3>{detailDish?.name || "待补菜"}</h3>
          {detailDish ? (
            <>
              <p>{detailDish.english}</p>
              <div className="dish-facts">
                <span>售价：¥{detailDish.priceText}</span>
                <span>辣度：{detailDish.spicy}</span>
                <span>素食性：{detailDish.vegetarian}</span>
                <span>主料：{detailDish.mainIngredient || "待核验"}</span>
                <span>工艺：{detailDish.method || "待核验"}</span>
                <span>
                  热量：
                  {detailDish.calories === null
                    ? "待核验"
                    : `${detailDish.calories} kcal/100g`}
                </span>
                <span>过敏原：{detailDish.allergens || "待核验"}</span>
                <span>标签依据：{detailDish.labelSource || "待核验"}</span>
              </div>
              <h3>菜库来源</h3>
              {detailDish.sources.map((source, index) => (
                <p className="source" key={index}>
                  {source.file} / {source.sheet} / 行{source.row}
                </p>
              ))}
              <h3>配方证据 · {recipes.length}个版本</h3>
              {recipes.map((recipe, index) => (
                <details key={index}>
                  <summary>
                    {recipe.source.sheet} · 行{recipe.source.row}
                  </summary>
                  <p className="source">{recipe.source.file}</p>
                  <p className="small">
                    原料：
                    {recipe.ingredients.map((item) => item.name).join("、")}
                  </p>
                  <p className="small">
                    缓存成本：
                    {recipe.cost === null
                      ? "无有效值"
                      : `¥${recipe.cost.toFixed(2)}`}{" "}
                    · {recipe.issues.join("；") || "原表未重算，待复核"}
                  </p>
                </details>
              ))}
            </>
          ) : (
            <p className="notice">该槽位候选不足，需补齐菜库或人工换菜。</p>
          )}
          <footer className="form-footer">
            <button className="primary" onClick={() => beginEdit(detailIndex)}>
              <Pencil size={16} />
              更换菜品
            </button>
          </footer>
        </Modal>
      )}
      {editing !== null && (
        <Modal
          title={`${editingStall} · 更换菜品`}
          onClose={() => setEditing(null)}
        >
          <Field label="筛选候选菜">
            <input
              aria-label="筛选候选菜"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="输入菜名"
            />
          </Field>
          <Field label="选择菜品">
            <select
              aria-label="替换菜品"
              size="9"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            >
              {candidates.map((dish) => (
                <option key={dish.id} value={dish.id}>
                  {dish.name} · ¥{dish.priceText} · {dish.spicy}
                </option>
              ))}
            </select>
          </Field>
          <footer className="form-footer">
            <button
              className="primary"
              disabled={menuBusy || !replacement}
              onClick={() =>
                run(async () => {
                  const entries = plan.entries.map((entry, index) =>
                    index === editing
                      ? { ...entry, dishId: replacement }
                      : entry,
                  );
                  setPlan(await diningApi.plans.check({ ...plan, entries }));
                  setEditing(null);
                  return "菜品已替换，整份菜单已重新校验，尚未保存";
                })
              }
            >
              确认换菜
            </button>
          </footer>
        </Modal>
      )}
      {issues && !isPartial && !plan?.workflow && plan?.validation && (
        <Modal title="排菜校验报告" onClose={() => setIssues(false)} wide>
          <div className="detail-meta">
            <Badge tone="red">{plan.validation.errors}项冲突</Badge>
            <Badge tone="gold">{plan.validation.warnings}项待核验</Badge>
            <span>
              槽位变化率：
              {plan.validation.changeRate === null
                ? "无可比基线"
                : `${plan.validation.changeRate}%`}
            </span>
          </div>
          <MenuConflictTable plan={plan} aiStatus={data.aiStatus} busy={menuBusy} />
        </Modal>
      )}
      {history && (
        <Modal title="已保存草案" onClose={() => setHistory(false)}>
          <div className="history-list">
            {data.plans
              .slice()
              .reverse()
              .map((item) => (
                <button
                  key={item.id}
                  disabled={menuBusy}
                  onClick={() =>
                    run(async () => {
                      showPlan(await diningApi.plans.get(item.id));
                      setHistory(false);
                      return "已读取完整草案";
                    })
                  }
                >
                  <div>
                    <strong>{item.stall}</strong>
                    <small>
                      {item.scope === "all"
                        ? `${item.stalls.length}个档口`
                        : "历史单档口"}{" "}
                      · {item.start} · {item.countEntries}个槽位 ·{" "}
                      {new Date(item.createdAt).toLocaleString("zh-CN")}
                    </small>
                  </div>
                  <Badge>待审核</Badge>
                </button>
              ))}
          </div>
          {!data.plans.length && <Empty text="暂无已保存草案" />}
        </Modal>
      )}
      {recovery && (
        <Modal title="恢复生成记录" onClose={() => setRecovery(false)} wide>
          <p className="notice">已完成周次会保留。继续生成会调用 GPT 完成剩余周次及检验；查看已生成菜单不会再次调用 AI。恢复结果仍须人工审核与保存。</p>
          <div className="actions menu-recovery-toolbar"><button disabled={recoveryLoading} onClick={refreshRecoverableRuns}>{recoveryLoading ? "读取中…" : "刷新记录"}</button></div>
          {recoveryLoading && <p role="status">正在读取可恢复的生成记录…</p>}
          {recoveryError && <p className="notice" role="alert">{recoveryError}</p>}
          {!data.aiStatus?.configured && <p className="notice">AI 服务未配置，暂不能继续生成；仍可查看已完成结果。</p>}
          <div className="menu-recovery-list">
            {recoverableRuns.map((item) => <article key={item.id} className="menu-recovery-item" aria-label={`生成记录 ${item.id}`}>
              <div className="menu-recovery-heading"><strong>已完成 {completedWeeks(item)} / 6 周</strong><Badge tone={item.canUseSavedResult ? "green" : item.resumable ? "gold" : "gray"}>{item.canUseSavedResult ? "结果可恢复" : item.resumable ? "可继续生成" : item.status === "running" ? "生成中" : "暂不可恢复"}</Badge></div>
              <p className="source">{item.id} · {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
              <p className="small">{item.stage === "inspecting" ? "检验员复核" : item.stage === "planning" ? `排菜阶段${item.currentWeek ? ` · 第 ${item.currentWeek} 周` : ""}` : item.canUseSavedResult ? "生成与检验已结束，尚需人工审核" : "保留的生成进度"}</p>
              {item.error?.message && <p className="menu-recovery-failure">{item.error.message}{runLocation(item.error) && <small>{runLocation(item.error)}</small>}</p>}
              <div className="actions">
                {item.resumable && <button className="primary" disabled={menuBusy || !data.aiStatus?.configured} onClick={() => generate(item)}>继续生成剩余周次</button>}
                {item.canUseSavedResult && <button className="primary" disabled={menuBusy} onClick={() => openSavedResult(item)}>{openingResult ? "读取结果中…" : "查看已生成菜单"}</button>}
              </div>
            </article>)}
          </div>
          {!recoveryLoading && !recoveryError && !recoverableRuns.length && <Empty text="暂无可恢复的生成记录" />}
        </Modal>
      )}
      {rules && (
        <Modal title="原始排菜规则" onClose={() => setRules(false)} wide>
          <p className="notice">
            本地文件中的规则作为服务端系统规则依据，已批准并启用的排菜 Action 只能在规则允许的范围内微调。原文与会议笔记存在冲突，未核验条件不会自动判为通过。专用档口的菜数与价格优先于通用菜数；实际开餐范围需复核。
          </p>
          {data.rules.map((rule, index) => (
            <section key={index}>
              <h3>{rule.stall}</h3>
              <p className="rule-text">{rule.text}</p>
              <p className="source">
                {rule.source.file} · {rule.source.sheet} · 行{rule.source.row}
              </p>
            </section>
          ))}
        </Modal>
      )}
    </>
  );
}
