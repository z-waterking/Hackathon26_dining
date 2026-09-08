import { useState } from "react";
import {
  CalendarDays,
  CheckCheck,
  Shuffle,
  Save,
  ShieldAlert,
  Store,
  Pencil,
  History,
} from "lucide-react";
import { Badge, Empty, ExportButton, Field, Metric, Modal } from "./shared";
import { downloadCsv, request } from "./api";
import { menuRows } from "./menu-export";
import { AiAvailability } from "./FeedbackWorkflow";
import MenuWorkflow from "./MenuWorkflow";

export default function Menus({ data, run, busy }) {
  const [start, setStart] = useState("2026-09-07");
  const [seed, setSeed] = useState(1);
  const [count, setCount] = useState(4);
  const [meals, setMeals] = useState(["午餐", "晚餐"]);
  const [plan, setPlan] = useState(null);
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
  const [useAi, setUseAi] = useState(false);
  const [demo, setDemo] = useState(false);
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
  const visibleWeeks = week === "all" ? [1, 2, 3, 4, 5, 6] : [week];
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
    setWeek("all");
    setStallFilter("");
    setMeal(next.meals[0]);
  }
  async function generate() {
    const next = await request("/plans/generate", {
      scope: "all",
      start,
      seed,
      count,
      meals,
      demo,
      useAi: !demo && useAi && !!data.aiStatus?.configured,
    });
    showPlan(next);
    return `${demo ? "模拟测试：" : ""}已一次生成 ${next.stalls.length} 个档口的完整六周菜单`;
  }
  function exportPlan() {
    downloadCsv(
      `六周菜单-${plan.stall}-${plan.start}.csv`,
      menuRows(plan, data.dishes),
    );
  }
  function beginEdit(index) {
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
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </Field>
        <button
          className="primary"
          disabled={busy || !meals.length}
          onClick={() => run(generate)}
        >
          <Shuffle size={16} />
          一次生成全部档口六周菜单
        </button>
      </section>
      <div className="ai-planner-controls">
        <label className="check">
          <input type="checkbox" checked={!demo && useAi && !!data.aiStatus?.configured} disabled={busy || demo || !data.aiStatus?.configured} onChange={(event) => setUseAi(event.target.checked)} />
          启用 AI 排菜员与检验员
        </label>
        <label className="check"><input type="checkbox" checked={demo} disabled={busy} onChange={(event) => setDemo(event.target.checked)} />模拟排菜测试（不调用 AI）</label>
        <p className="muted small">{demo ? "仅使用已批准的示例事项测试真实规则排菜和影响记录；角色结果由本地模拟器提供。" : "按原始排菜规则与已批准 Action 生成六周菜单，再由检验员检查执行情况。"}{(data.actions || []).filter((action) => action.feedbackIds?.length && Boolean(action.demo) === demo && action.status === "approved" && action.enabled && action.menuInstruction).length} 项已批准排菜要求可用。</p>
        <AiAvailability status={data.aiStatus} />
      </div>
      {plan ? (
        <>
          <MenuWorkflow plan={plan} setPlan={setPlan} aiStatus={data.aiStatus} run={run} busy={busy} />
          <div className="metrics planner-metrics">
            <Metric
              label="排菜周期"
              value="6 周"
              detail={`${plan.start} 至 ${plan.entries.at(-1).date} · 30个工作日`}
              icon={CalendarDays}
              color="blue"
            />
            <Metric
              label="覆盖档口"
              value={`${planStalls.length} 个`}
              detail={
                plan.scope === "all"
                  ? "全部档口 · 一份完整草案"
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
              value={`${plan.validation.warnings} / ${plan.validation.errors}`}
              detail="不代表审核通过"
              icon={ShieldAlert}
              color="gold"
            />
          </div>
          <div className="notice planner-notice">
            <span>
              <strong>待审核草案</strong> · 标签完整率{" "}
              {plan.validation.labelCoverage}% ·
              开餐范围、食品标签及共享例外待确认
            </span>
            <button className="text-button" onClick={() => setIssues(true)}>
              查看校验报告
            </button>
          </div>
          <section className="work-section">
            <div className="section-heading">
              <h2>
                {plan.stall} <Badge>六周草案</Badge>
              </h2>
              <div className="actions">
                <ExportButton onClick={exportPlan}>导出六周菜单</ExportButton>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setPlan(await request("/plans", plan));
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
                  完整六周
                </button>
                {[1, 2, 3, 4, 5, 6].map((value) => (
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
                                      disabled={busy}
                                      onClick={() =>
                                        run(async () => {
                                          setRecipes(
                                            dish
                                              ? await request(
                                                  `/recipes/${dish.id}`,
                                                )
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
              disabled={busy || !replacement}
              onClick={() =>
                run(async () => {
                  const entries = plan.entries.map((entry, index) =>
                    index === editing
                      ? { ...entry, dishId: replacement }
                      : entry,
                  );
                  setPlan(await request("/plans/check", { ...plan, entries }));
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
      {issues && (
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
          <div className="issue-list">
            {plan.validation.issues.map((issue, index) => (
              <div key={index}>
                <Badge tone={issue.level === "error" ? "red" : "gold"}>
                  {issue.level === "error" ? "冲突" : "待核验"}
                </Badge>
                <span>
                  <small>
                    {issue.stall || plan.stall} · {issue.date} {issue.meal}
                  </small>
                  {issue.text}
                </span>
              </div>
            ))}
          </div>
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
                  onClick={() =>
                    run(async () => {
                      showPlan(await request(`/plans/${item.id}`));
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
      {rules && (
        <Modal title="原始排菜规则" onClose={() => setRules(false)} wide>
          <p className="notice">
            原文与会议笔记存在冲突，未核验条件不会自动判为通过。专用档口的菜数与价格优先于通用菜数。全部档口按所选餐次编排，实际开餐范围需复核。
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
