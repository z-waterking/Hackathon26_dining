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
import { createGenerationId } from "./generation-id";
import { menuRows } from "./menu-export";
import { AiAvailability } from "./FeedbackWorkflow";
import MenuWorkflow from "./MenuWorkflow";
import MenuConflictTable from "./MenuConflictTable";
import MenuActionsPanel from "./MenuActionsPanel";
import { useI18n } from "./i18n";
import "./menu-progress.css";

function nextMonday() {
  const date = new Date();
  date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function completedWeeks(item) {
  return Math.max(0, Math.min(6, Number(item.completedWeeks) || 0));
}

function runLocation(error, t) {
  if (!error) return "";
  return [error.week && t(`第 ${error.week} 周`, `Week ${error.week}`), error.stall, error.day && t(`第 ${error.day} 天`, `Day ${error.day}`), t(error.meal),
    Number.isInteger(error.slot) && t(`菜位 ${error.slot + 1}`, `Slot ${error.slot + 1}`)].filter(Boolean).join(" · ");
}

export default function Menus({ data, run, busy, onNavigate }) {
  const { t, tr, locale } = useI18n();
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
  const [cancelState, setCancelState] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [failedRunId, setFailedRunId] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [recoverableRuns, setRecoverableRuns] = useState([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [openingResult, setOpeningResult] = useState(false);
  const generationInFlight = useRef(null);
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
  async function cancelGeneration() {
    const generation = generationInFlight.current;
    if (!generation || generation.finished || generation.cancelPending) return;
    generation.cancelPending = true;
    setCancelState("cancelling"); setCancelError("");
    try {
      const result = await diningApi.generations.cancel(generation.id);
      if (generationInFlight.current !== generation || generation.finished) return;
      // Keep the stream open: completed weeks and the terminal cancellation
      // event come from the server, not from a local AbortController.
      setCancelState(result.cancelled ? "cancelling" : "finishing");
    } catch (error) {
      if (generationInFlight.current !== generation || generation.finished) return;
      generation.cancelPending = false;
      setCancelState(""); setCancelError(error.message);
    }
  }
  async function generate(resumeRun = null) {
    if (busy || repairBusy || generationInFlight.current || resultInFlight.current) return;
    if (resumeRun ? !resumeRun.resumable || !data.aiStatus?.configured : aiUnavailable || !meals.length) return;
    let id;
    try { id = createGenerationId(); }
    catch { setGenerationError(t("浏览器无法创建安全的生成标识，请使用支持 Web Crypto 的浏览器。", "The browser cannot create a secure generation ID. Use a browser that supports Web Crypto.")); return; }
    const generation = { id, runId: resumeRun?.id || "", cancelPending: false, finished: false };
    generationInFlight.current = generation;
    setGenerating(true);
    setCancelState(""); setCancelError(""); setCancelled(false);
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
          const input = { scope: "all", start, seed, count, meals, demo: false, useAi, generationId: generation.id };
          const onEvent = (event) => {
            if (generationInFlight.current !== generation || generation.finished) return;
            if (event.runId) generation.runId = event.runId;
            receiveProgress(event);
          };
          const next = resumeRun
            ? await diningApi.plans.resumeProgressive(resumeRun.id, { generationId: generation.id, onEvent })
            : useAi
              ? await diningApi.plans.generateProgressive(input, { onEvent })
              : await diningApi.plans.generate(input);
          generation.finished = true;
          showPlan(next);
          return t(`${resumeRun ? "GPT 已恢复生成：" : useAi ? "GPT 已生成：" : "本地规则草案（未调用 GPT）："}${next.stalls.length} 个档口的完整六周菜单，待人工审核与保存`, `${resumeRun ? "GPT resumed:" : useAi ? "GPT generated:" : "Local-rule draft (no GPT):"} a complete six-week menu for ${next.stalls.length} stalls, awaiting human review and saving`);
        } catch (error) {
          generation.finished = true;
          setFailedRunId(error.runId || generation.runId);
          if (resumeRun || useAi) void refreshRecoverableRuns();
          if (error.code === "GENERATION_CANCELLED") {
            setCancelled(true);
            return t("已取消六周菜单生成；已完成周次与已有草案已保留。", "Six-week menu generation cancelled. Completed weeks and existing drafts are retained.");
          }
          setGenerationError(error.message);
          throw error;
        }
      }, { background: true });
    } finally {
      if (generationInFlight.current === generation) {
        generationInFlight.current = null;
        setGenerating(false); setCancelState(""); setCancelError("");
      }
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
          setCancelled(false);
          setFailedRunId("");
          return t("已恢复此前 GPT 生成的完整六周菜单，未重新调用 AI，仍需人工审核与保存", "The previously generated six-week menu was restored without another AI call. Human review and saving are still required.");
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
          <h1>{t("全部档口六周菜单", "Six-week menu for all stalls")}</h1>
        </div>
        <div className="actions">
          <button onClick={openRecovery}>
            <History size={16} />
            {t("恢复生成记录", "Recover generation")}
          </button>
          <button onClick={() => setRules(true)}>
            <ShieldAlert size={16} />
            {t("排菜规则", "Planning rules")}
          </button>
          <button onClick={() => setHistory(true)}>
            <History size={16} />
            {t("草案记录", "Saved drafts")} <Badge>{data.plans.length}</Badge>
          </button>
        </div>
      </div>
      <MenuActionsPanel actions={data.actions || []} useAi={useAi} onManage={() => onNavigate?.("actions")} />
      <section className="planner-controls">
        <div className="generation-scope">
          <small>{t("生成范围", "Planning scope")}</small>
          <strong>
            <Store size={18} />
            {t(`全部 ${allStalls.length} 个档口`, `All ${allStalls.length} stalls`)}
          </strong>
        </div>
        <Field label={t("起始周一", "Starting Monday")}>
          <input
            aria-label={t("起始周一", "Starting Monday")}
            type="date"
            value={start}
            disabled={menuBusy}
            onChange={(event) => setStart(event.target.value)}
          />
        </Field>
        <Field label={t("餐次", "Meals")}>
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
                {t(name)}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("通用档口菜数", "Default dishes per stall")}>
          <input
            type="number"
            aria-label={t("每餐菜数", "Dishes per meal")}
            value={count}
            disabled={menuBusy}
            min="1"
            max="12"
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </Field>
        <Field label={t("方案种子", "Plan seed")}>
          <input
            type="number"
            aria-label={t("方案种子", "Plan seed")}
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
          {t("一次生成全部档口六周菜单", "Generate six weeks for all stalls")}
        </button>
      </section>
      <div className="ai-planner-controls">
        <label className="check">
          <input type="checkbox" checked={useAi} disabled={menuBusy} onChange={(event) => setUseAi(event.target.checked)} />
          {t("启用 AI 排菜员与检验员", "Enable AI planner and inspector")}
        </label>
        <p className="muted small">{useAi ? t("菜品库已完成本地入库，从数据库按档口取菜，GPT 再分别排菜：每周完成即展示，前面周次输入 AI 后生成下一周，最后统一检验评分。分档口调用比整周一次调用耗时更长；固定与人工规则不由 AI 编造。", "The catalog is stored locally. GPT plans each stall using its database candidates, showing each completed week and using previous weeks to plan the next. The full menu is then inspected and scored. Per-stall calls take longer than a single weekly call; fixed and manual menus are never fabricated.") : t("已关闭 AI：仅生成本地规则草案，不调用 GPT；不代表已完成 AI 排菜或检验。", "AI is off: this creates a local-rule draft without GPT planning or inspection.")}</p>
        <AiAvailability status={data.aiStatus} />
        {aiUnavailable && <p className="notice" role="alert">{t("AI 服务未配置，无法生成真实 GPT 菜单。请先配置服务端；如仅需本地规则草案，可明确关闭 AI。不会自动降级。", "AI is not configured. Configure the server to generate a real GPT menu, or explicitly disable AI for a local-rule draft. There is no automatic fallback.")}</p>}
      </div>
      {generating && <section className="work-section menu-generation-wait" aria-label={t("正在生成六周菜单", "Generating six-week menu")}>
        <div className="section-heading"><h2><LoaderCircle size={18} className="spin" aria-hidden="true" />{progress ? progress.stage === "inspecting" ? t("六周菜单已齐备，检验员正在复核", "All six weeks are ready; inspection is in progress") : t(`GPT 正在生成第 ${progress.currentWeek} 周菜单`, `GPT is generating week ${progress.currentWeek}`) : t("正在生成本地规则草案", "Generating local-rule draft")}</h2>{progress && <Badge tone="blue">{t(`已完成 ${progress.completedWeeks} / 6 周`, `${progress.completedWeeks} / 6 weeks complete`)}</Badge>}</div>
        <p role="status">{progress ? progress.stage === "inspecting" ? t("已完成的六周菜单可先查看，正在汇总规则校验与 Action 执行情况。", "All six weeks can be viewed while rule checks and Action execution are reviewed.") : progress.completedWeeks ? t(`已完成 ${progress.completedWeeks} / 6 周并展示在下方；前面生成的菜单会输入 AI，接着编排下一周。`, `${progress.completedWeeks} / 6 weeks are complete and shown below. Earlier menus are supplied to AI to plan the next week.`) : t("正在读取本地规则与已批准事项，第 1 周完成后会立即展示。", "Reading local rules and approved Actions. Week 1 will appear as soon as it is ready.") : t("正在准备菜单与规则校验报告。", "Preparing the menu and rule-check report.")}{t("完整结果仍需人工审核与保存。", " The complete result still requires human review and saving.")}</p>
        {progress && <ol className="menu-generation-steps" aria-label={t("六周生成进度", "Six-week generation progress")}>{[1, 2, 3, 4, 5, 6].map((value) => <li key={value} className={value <= progress.completedWeeks ? "done" : value === progress.currentWeek && progress.stage !== "inspecting" ? "active" : ""}><span>{t(`第 ${value} 周`, `Week ${value}`)}</span><small>{value <= progress.completedWeeks ? t("已展示", "Shown") : value === progress.currentWeek && progress.stage !== "inspecting" ? t("生成中", "Generating") : t("等待中", "Waiting")}</small></li>)}</ol>}
        <p className="muted small">{t("可切换到其他页面继续操作，生成将在后台继续。请勿重复提交。", "You can use other pages while generation continues in the background. Do not submit again.")}</p>
        <div className="actions"><button type="button" onClick={cancelGeneration} disabled={Boolean(cancelState)}>{cancelState === "cancelling" ? t("正在取消…", "Cancelling…") : cancelState === "finishing" ? t("等待结果…", "Waiting for result…") : t("取消生成", "Cancel generation")}</button>{cancelState && <span className="small" role="status">{cancelState === "cancelling" ? t("正在请求服务端取消；停止确认前生成仍在进行，已完成周次会保留。", "Requesting server cancellation. Generation remains active until stopped; completed weeks are retained.") : t("服务端已结束本次生成，正在接收结果。", "The server has finished this generation. Waiting for the result.")}</span>}</div>
        {cancelError && <p className="notice" role="alert">{tr(cancelError)}{t("。取消请求未成功，生成仍在继续，可重试取消。", " Cancellation was not confirmed. Generation is still running; you can retry cancellation.")}</p>}
      </section>}
      {cancelled && !generating && <div className="notice menu-generation-cancelled" role="status"><p>{t("已取消六周菜单生成；已完成周次与已有草案已保留，可在生成记录中继续。", "Six-week menu generation cancelled. Completed weeks and existing drafts are retained; resume from generation records.")}</p>{failedRunId && <p className="source">{t("生成记录：", "Run: ")}{failedRunId}</p>}<button onClick={openRecovery}>{t("恢复生成记录", "Recover generation")}</button></div>}
      {generationError && <div className="notice menu-generation-error" role="alert"><p>{tr(generationError)}{t("。", ". ")}{isPartial ? t(`已保留下方完成的 ${completedWeeks(plan)} 周菜单；未生成替代菜品，已有草案保持不变。`, `The ${completedWeeks(plan)} completed weeks below are retained. No replacements were generated; the previous draft is unchanged.`) : t("未生成替代菜单，已有草案保持不变。", "No replacement menu was generated. The existing draft is unchanged.")}</p>{failedRunId && <p className="source">{t("生成记录：", "Run: ")}{failedRunId}</p>}<button onClick={openRecovery}>{t("恢复生成记录", "Recover generation")}</button><span className="small">{t("可检查已完成周次，继续生成或取回结果，无需直接重跑六周。", "Review completed weeks, resume generation, or retrieve the result without restarting all six weeks.")}</span></div>}
      {plan ? (
        <>
          {isPartial ? <div className="notice menu-partial-notice" role="note"><span><strong>{t(`逐周预览 · 已完成 ${completedWeeks(plan)} / 6 周`, `Weekly preview · ${completedWeeks(plan)} / 6 weeks complete`)}</strong>{t(" · 仅展示 AI 已生成的周次。六周生成并检验结束前不可编辑、保存或导出。", " · Only completed AI-generated weeks are shown. Editing, saving and export are unavailable until all six weeks are generated and inspected.")}</span>{completePlan && !generating && <button onClick={() => { setPartialPlan(null); setProgress(null); setWeek("all"); setStallFilter(""); }}>{t("返回此前草案", "Return to previous draft")}</button>}</div> : <>{!plan.workflow && <p className="notice">{t("本地规则草案 · 未经 GPT 生成或检验，仍需人工审核。", "Local-rule draft · Not generated or inspected by GPT; human review is required.")}</p>}<MenuWorkflow plan={plan} setPlan={setPlan} aiStatus={data.aiStatus} run={run} busy={menuBusy} dishes={data.dishes} detailsOpen={issues} onDetailsChange={setIssues} onRepairBusyChange={setRepairBusy} /></>}
          <div className="metrics planner-metrics">
            <Metric
              label={t("排菜周期", "Planning period")}
              value={isPartial ? t(`${completedWeeks(plan)} / 6 周`, `${completedWeeks(plan)} / 6 weeks`) : t("6 周", "6 weeks")}
              detail={t(`${plan.start} 至 ${plan.entries.at(-1)?.date || plan.start} · ${isPartial ? `${completedWeeks(plan) * 5}个工作日已生成` : "30个工作日"}`, `${plan.start} to ${plan.entries.at(-1)?.date || plan.start} · ${isPartial ? `${completedWeeks(plan) * 5} workdays generated` : "30 workdays"}`)}
              icon={CalendarDays}
              color="blue"
            />
            <Metric
              label={t("覆盖档口", "Stalls covered")}
              value={t(`${planStalls.length} 个`, `${planStalls.length} stalls`)}
              detail={
                plan.scope === "all"
                  ? isPartial ? t("全部档口 · 逐周预览", "All stalls · Weekly preview") : t("全部档口 · 一份完整草案", "All stalls · One complete draft")
                  : t("历史单档口草案", "Historical single-stall draft")
              }
              icon={Store}
            />
            <Metric
              label={t("已排槽位", "Filled slots")}
              value={`${plan.entries.filter((entry) => entry.dishId).length} / ${plan.entries.length}`}
              detail={t("主食固定内容需另行复核", "Fixed staple items require separate review")}
              icon={CheckCheck}
            />
            <Metric
              label={t("待核验 / 冲突", "Verification / Conflicts")}
              value={isPartial ? t("待检验", "Awaiting inspection") : `${plan.validation.warnings} / ${plan.validation.errors}`}
              detail={isPartial ? t("六周齐备后统一复核", "Reviewed after all six weeks are complete") : t("不代表审核通过", "Not an approval")}
              icon={ShieldAlert}
              color="gold"
            />
          </div>
          {!isPartial && !plan.workflow && <div className="notice planner-notice">
            <span>
              <strong>{t("待审核草案", "Draft awaiting review")}</strong>{t(" · 标签完整率", " · Verified labels ")}{" "}
              {plan.validation.labelCoverage}% ·
              {t("开餐范围、食品标签及共享例外待确认", "Meal service, food labels and sharing exceptions need confirmation")}
            </span>
            <button className="text-button" disabled={menuBusy} onClick={() => setIssues(true)}>
              {t("查看校验报告", "View validation report")}
            </button>
          </div>}
          <section className="work-section">
            <div className="section-heading">
              <h2>
                {plan.stall === "全部档口" ? t("全部档口", "All stalls") : plan.stall} <Badge>{isPartial ? t("逐周预览", "Weekly preview") : t("六周草案", "Six-week draft")}</Badge>
              </h2>
              <div className="actions">
                {!isPartial && <ExportButton onClick={exportPlan}>{t("导出六周菜单", "Export six-week menu")}</ExportButton>}
                <button
                  className="primary"
                  disabled={menuBusy || isPartial || Boolean(plan.workflow?.repairPendingInspection)}
                  title={plan.workflow?.repairPendingInspection ? t("修复后须重新 AI 检验再保存", "Run AI inspection after repair before saving") : undefined}
                  onClick={() =>
                    run(async () => {
                      if (plan.workflow?.repairPendingInspection) throw new Error(t("修复后须重新 AI 检验再保存", "Run AI inspection after repair before saving"));
                      setPlan(await diningApi.plans.save(plan));
                      return t("完整六周草案已保存为新版本", "The complete six-week draft was saved as a new version");
                    })
                  }
                >
                  <Save size={16} />
                  {t("保存整份草案", "Save complete draft")}
                </button>
              </div>
            </div>
            <div className="planner-tabs">
              <div className="tabs" role="tablist" aria-label={t("周次", "Weeks")}>
                <button
                  role="tab"
                  aria-selected={week === "all"}
                  className={week === "all" ? "active" : ""}
                  onClick={() => setWeek("all")}
                >
                  {isPartial ? t("已生成周次", "Generated weeks") : t("完整六周", "All six weeks")}
                </button>
                {availableWeeks.map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={week === value}
                    className={week === value ? "active" : ""}
                    onClick={() => setWeek(value)}
                  >
                    {t(`第${value}周`, `Week ${value}`)}
                  </button>
                ))}
              </div>
              <div className="menu-view-filters">
                <select
                  aria-label={t("查看档口", "View stall")}
                  value={stallFilter}
                  onChange={(event) => setStallFilter(event.target.value)}
                >
                  <option value="">{t("全部档口", "All stalls")}</option>
                  {planStalls.map((stall) => (
                    <option key={stall} value={stall}>{stall}</option>
                  ))}
                </select>
                <div className="segmented">
                  {plan.meals.map((name) => (
                    <button
                      key={name}
                      className={effectiveMeal === name ? "active" : ""}
                      onClick={() => setMeal(name)}
                    >
                      {t(name)}
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
                  aria-label={t(`第${displayWeek}周菜单`, `Week ${displayWeek} menu`)}
                >
                  <h3>
                    {t(`第${displayWeek}周`, `Week ${displayWeek}`)} · {t(effectiveMeal)}
                  </h3>
                  <div className="table-scroll">
                    <table className="all-stall-menu">
                      <thead>
                        <tr>
                          <th>{t("档口", "Stall")}</th>
                          {["一", "二", "三", "四", "五"].map((day, index) => {
                            const date = new Date(`${first.date}T00:00:00Z`);
                            date.setUTCDate(date.getUTCDate() + index);
                            return (
                              <th key={day}>
                                {t(`周${day}`, ["Mon", "Tue", "Wed", "Thu", "Fri"][index])}
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
                                      aria-label={t(`查看${stall}-${entry.date}-${entry.slot}明细`, `View ${stall}-${entry.date}-${entry.slot} details`)}
                                      title={t("查看菜品明细", "View dish details")}
                                      disabled={menuBusy || isPartial}
                                      onClick={() =>
                                        run(async () => {
                                          setRecipes(
                                            dish
                                              ? await diningApi.catalog.recipes(dish.id)
                                              : [],
                                          );
                                          setDetailIndex(index);
                                          return t("已读取菜品明细", "Dish details loaded");
                                        })
                                      }
                                    >
                                      <span>{dish?.name || t("待补菜", "Dish needed")}</span>
                                      {dish && <small>¥{dish.priceText}</small>}
                                    </button>
                                  );
                                })}
                                {(plan.fixedStaples || []).filter(item => item.stall === stall && item.meal === effectiveMeal).map((item, index) => <p className="source fixed-staple-menu" key={`staple-${index}`}>{t("固定主食：", "Fixed staples: ")}{item.text}</p>)}
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
        <Empty text={t("暂无全部档口六周菜单草案", "No six-week draft for all stalls yet")} />
      )}
      {detail && (
        <Modal title={t("菜品明细", "Dish details")} onClose={() => setDetailIndex(null)} wide>
          <div className="detail-meta">
            <Badge>{entryStall(detail)}</Badge>
            <span>
              {detail.date} · {t(`第${detail.week}周`, `Week ${detail.week}`)} · {t(detail.meal)}
            </span>
          </div>
          <h3>{detailDish?.name || t("待补菜", "Dish needed")}</h3>
          {detailDish ? (
            <>
              <p>{detailDish.english}</p>
              <div className="dish-facts">
                <span>{t("售价：", "Price: ")}¥{detailDish.priceText}</span>
                <span>{t("辣度：", "Spice level: ")}{detailDish.spicy}</span>
                <span>{t("素食性：", "Vegetarian: ")}{detailDish.vegetarian}</span>
                <span>{t("主料：", "Main ingredient: ")}{detailDish.mainIngredient || t("待核验", "Needs verification")}</span>
                <span>{t("工艺：", "Method: ")}{detailDish.method || t("待核验", "Needs verification")}</span>
                <span>
                  {t("热量：", "Calories: ")}
                  {detailDish.calories === null
                    ? t("待核验", "Needs verification")
                    : `${detailDish.calories} kcal/100g`}
                </span>
                <span>{t("过敏原：", "Allergens: ")}{detailDish.allergens || t("待核验", "Needs verification")}</span>
                <span>{t("标签依据：", "Label source: ")}{tr(detailDish.labelSource) || t("待核验", "Needs verification")}</span>
              </div>
              <h3>{t("菜库来源", "Catalog source")}</h3>
              {detailDish.sources.map((source, index) => (
                <p className="source" key={index}>
                  {source.file} / {source.sheet} / {t("行", "Row ")}{source.row}
                </p>
              ))}
              <h3>{t(`配方证据 · ${recipes.length}个版本`, `Recipe evidence · ${recipes.length} versions`)}</h3>
              {recipes.map((recipe, index) => (
                <details key={index}>
                  <summary>
                    {recipe.source.sheet} · {t("行", "Row ")}{recipe.source.row}
                  </summary>
                  <p className="source">{recipe.source.file}</p>
                  <p className="small">
                    {t("原料：", "Ingredients: ")}
                    {recipe.ingredients.map((item) => item.name).join("、")}
                  </p>
                  <p className="small">
                    {t("缓存成本：", "Cached cost: ")}
                    {recipe.cost === null
                      ? t("无有效值", "No valid value")
                      : `¥${recipe.cost.toFixed(2)}`}{" "}
                    · {(recipe.issues.length ? tr(recipe.issues.join("；")) : "") || t("原表未重算，待复核", "Source sheet was not recalculated; review required")}
                  </p>
                </details>
              ))}
            </>
          ) : (
            <p className="notice">{t("该槽位候选不足，需补齐菜库或人工换菜。", "This slot has insufficient candidates. Add catalog dishes or replace the dish manually.")}</p>
          )}
          <footer className="form-footer">
            <button className="primary" onClick={() => beginEdit(detailIndex)}>
              <Pencil size={16} />
              {t("更换菜品", "Replace dish")}
            </button>
          </footer>
        </Modal>
      )}
      {editing !== null && (
        <Modal
          title={t(`${editingStall} · 更换菜品`, `${editingStall} · Replace dish`)}
          onClose={() => setEditing(null)}
          busy={busy}
        >
          <Field label={t("筛选候选菜", "Filter candidates")}>
            <input
              aria-label={t("筛选候选菜", "Filter candidates")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("输入菜名", "Enter a dish name")}
            />
          </Field>
          <Field label={t("选择菜品", "Select dish")}>
            <select
              aria-label={t("替换菜品", "Replacement dish")}
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
                  return t("菜品已替换，整份菜单已重新校验，尚未保存", "Dish replaced and the full menu checked again. Changes are not saved yet.");
                })
              }
            >
              {t("确认换菜", "Confirm replacement")}
            </button>
          </footer>
        </Modal>
      )}
      {issues && !isPartial && !plan?.workflow && plan?.validation && (
        <Modal title={t("排菜校验报告", "Menu validation report")} onClose={() => setIssues(false)} wide>
          <div className="detail-meta">
            <Badge tone="red">{t(`${plan.validation.errors}项冲突`, `${plan.validation.errors} conflicts`)}</Badge>
            <Badge tone="gold">{t(`${plan.validation.warnings}项待核验`, `${plan.validation.warnings} verification items`)}</Badge>
            <span>
              {t("槽位变化率：", "Slot change rate: ")}
              {plan.validation.changeRate === null
                ? t("无可比基线", "No comparable baseline")
                : `${plan.validation.changeRate}%`}
            </span>
          </div>
          <MenuConflictTable plan={plan} aiStatus={data.aiStatus} busy={menuBusy} />
        </Modal>
      )}
      {history && (
        <Modal title={t("已保存草案", "Saved drafts")} onClose={() => setHistory(false)} busy={busy}>
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
                      return t("已读取完整草案", "Complete draft loaded");
                    })
                  }
                >
                  <div>
                    <strong>{item.stall === "全部档口" ? t("全部档口", "All stalls") : item.stall}</strong>
                    <small>
                      {item.scope === "all"
                        ? t(`${item.stalls.length}个档口`, `${item.stalls.length} stalls`)
                        : t("历史单档口", "Historical single stall")}{" "}
                      · {item.start} · {t(`${item.countEntries}个槽位`, `${item.countEntries} slots`)} ·{" "}
                      {new Date(item.createdAt).toLocaleString(locale)}
                    </small>
                  </div>
                  <Badge>{t("待审核", "Awaiting review")}</Badge>
                </button>
              ))}
          </div>
          {!data.plans.length && <Empty text={t("暂无已保存草案", "No saved drafts")} />}
        </Modal>
      )}
      {recovery && (
        <Modal title={t("恢复生成记录", "Recover generation")} onClose={() => setRecovery(false)} busy={openingResult} wide>
          <p className="notice">{t("已完成周次会保留。继续生成会调用 GPT 完成剩余周次及检验；查看已生成菜单不会再次调用 AI。恢复结果仍须人工审核与保存。", "Completed weeks are retained. Resume calls GPT for the remaining weeks and inspection; viewing a completed menu does not call AI again. Recovered results still require human review and saving.")}</p>
          <div className="actions menu-recovery-toolbar"><button disabled={recoveryLoading} onClick={refreshRecoverableRuns}>{recoveryLoading ? t("读取中…", "Loading…") : t("刷新记录", "Refresh records")}</button></div>
          {recoveryLoading && <p role="status">{t("正在读取可恢复的生成记录…", "Loading recoverable runs…")}</p>}
          {recoveryError && <p className="notice" role="alert">{tr(recoveryError)}</p>}
          {!data.aiStatus?.configured && <p className="notice">{t("AI 服务未配置，暂不能继续生成；仍可查看已完成结果。", "AI is not configured, so generation cannot resume. Completed results can still be viewed.")}</p>}
          <div className="menu-recovery-list">
            {recoverableRuns.map((item) => <article key={item.id} className="menu-recovery-item" aria-label={t(`生成记录 ${item.id}`, `Generation run ${item.id}`)}>
              <div className="menu-recovery-heading"><strong>{t(`已完成 ${completedWeeks(item)} / 6 周`, `${completedWeeks(item)} / 6 weeks complete`)}</strong><Badge tone={item.canUseSavedResult ? "green" : item.resumable ? "gold" : "gray"}>{item.canUseSavedResult ? t("结果可恢复", "Result available") : item.resumable ? t("可继续生成", "Can resume") : item.status === "running" ? t("生成中", "Generating") : t("暂不可恢复", "Not recoverable yet")}</Badge></div>
              <p className="source">{item.id} · {new Date(item.createdAt).toLocaleString(locale)}</p>
              <p className="small">{item.stage === "inspecting" ? t("检验员复核", "Inspector review") : item.stage === "planning" ? t(`排菜阶段${item.currentWeek ? ` · 第 ${item.currentWeek} 周` : ""}`, `Planning${item.currentWeek ? ` · Week ${item.currentWeek}` : ""}`) : item.canUseSavedResult ? t("生成与检验已结束，尚需人工审核", "Generation and inspection complete; human review is required") : t("保留的生成进度", "Saved generation progress")}</p>
              {item.error?.message && <p className="menu-recovery-failure">{tr(item.error.message)}{runLocation(item.error, t) && <small>{runLocation(item.error, t)}</small>}</p>}
              <div className="actions">
                {item.resumable && <button className="primary" disabled={menuBusy || !data.aiStatus?.configured} onClick={() => generate(item)}>{t("继续生成剩余周次", "Resume remaining weeks")}</button>}
                {item.canUseSavedResult && <button className="primary" disabled={menuBusy} onClick={() => openSavedResult(item)}>{openingResult ? t("读取结果中…", "Loading result…") : t("查看已生成菜单", "View generated menu")}</button>}
              </div>
            </article>)}
          </div>
          {!recoveryLoading && !recoveryError && !recoverableRuns.length && <Empty text={t("暂无可恢复的生成记录", "No recoverable runs")} />}
        </Modal>
      )}
      {rules && (
        <Modal title={t("原始排菜规则", "Original planning rules")} onClose={() => setRules(false)} wide>
          <p className="notice">
            {t("本地文件中的规则作为服务端系统规则依据，已批准并启用的排菜 Action 只能在规则允许的范围内微调。原文与会议笔记存在冲突，未核验条件不会自动判为通过。专用档口的菜数与价格优先于通用菜数；实际开餐范围需复核。", "Local source rules guide the server. Approved and enabled menu Actions may adjust menus only within those rules. Conflicts and unverified conditions require review. Stall-specific dish counts and prices take precedence over defaults; actual meal service must be confirmed.")}
          </p>
          {data.rules.map((rule, index) => (
            <section key={index}>
              <h3>{rule.stall}</h3>
              <p className="rule-text">{tr(rule.text)}</p>
              <p className="source">
                {rule.source.file} · {rule.source.sheet} · {t("行", "Row ")}{rule.source.row}
              </p>
            </section>
          ))}
        </Modal>
      )}
    </>
  );
}
