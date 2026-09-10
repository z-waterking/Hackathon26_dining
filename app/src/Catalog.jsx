import { useDeferredValue, useId, useRef, useState } from "react";
import {
  Search,
  BookOpen,
  Languages,
  ShieldCheck,
  CircleAlert,
  Pencil,
  FolderOpen,
  Plus,
  Trash2,
  RotateCcw,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import {
  Badge,
  Empty,
  ExportButton,
  Field,
  Metric,
  Modal,
  Pagination,
} from "./shared";
import { downloadCsv } from "./api";
import { diningApi } from "./api/dining";
import { createGenerationId } from "./generation-id";
import { englishNameState } from "../shared/catalog-english-state.mjs";
import { useI18n } from "./i18n";
import { LocalizedInput, localizedFormData } from "./i18n-fields";
import "./catalog.css";

export default function Catalog({ data, run, busy }) {
  const { t, locale } = useI18n();
  const englishHelpId = useId();
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [stall, setStall] = useState("");
  const [missing, setMissing] = useState(false);
  const [archived, setArchived] = useState("current");
  const [englishFilter, setEnglishFilter] = useState("all");
  const [englishRunning, setEnglishRunning] = useState(false);
  const [englishOutcome, setEnglishOutcome] = useState(null);
  const [englishError, setEnglishError] = useState("");
  const [englishCancelState, setEnglishCancelState] = useState("");
  const [englishCancelError, setEnglishCancelError] = useState("");
  const englishInFlight = useRef(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [formError, setFormError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const mutationInFlight = useRef(false);
  const [recipes, setRecipes] = useState([]);
  const [materials, setMaterials] = useState(null);
  const stalls = [...new Set(data.dishes.map((dish) => dish.stall).filter(Boolean))];
  const currentDishes = data.dishes.filter((dish) => !dish.deletedAt);
  const currentStalls = [...new Set(currentDishes.map((dish) => dish.stall))];
  const englishCounts = currentDishes.reduce((counts, dish) => { counts[englishNameState(dish)]++; return counts; }, { ready: 0, missing: 0, needs_review: 0 });
  const catalogBusy = busy || submitting;
  const items = data.dishes.filter(
    (dish) =>
      (archived === "all" || (archived === "deleted" ? Boolean(dish.deletedAt) : !dish.deletedAt)) &&
      (!stall || dish.stall === stall) &&
      (englishFilter === "all" || englishNameState(dish) === englishFilter) &&
      (!missing || dish.spicy === "未知" || dish.vegetarian === "未知") &&
      `${dish.name} ${dish.english}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 12)));
  function englishLabel(dish) {
    const state = englishNameState(dish);
    if (state === "missing") return dish.englishName?.status === "stale" || dish.englishHistory?.some(item => item.sourceName && item.sourceName !== dish.name)
      ? t("名称已改 · 英文待补全", "Name changed · English name needed") : t("英文名缺失", "English name missing");
    if (state === "needs_review") return dish.englishName?.origin === "ai" ? t("AI 译名 · 待复核", "AI name · Review required") : t("英文名待复核", "English name · Review required");
    return dish.englishName?.origin === "manual" ? t("人工维护英文名", "Manually maintained English name") : t("已有来源英文名", "Source English name");
  }
  async function cancelEnglish() {
    const generation = englishInFlight.current;
    if (!generation || generation.finished || generation.cancelPending) return;
    generation.cancelPending = true;
    setEnglishCancelState("cancelling"); setEnglishCancelError("");
    try {
      const result = await diningApi.generations.cancel(generation.id);
      if (englishInFlight.current !== generation || generation.finished) return;
      setEnglishCancelState(result.cancelled ? "cancelling" : "finishing");
    } catch (error) {
      if (englishInFlight.current !== generation || generation.finished) return;
      generation.cancelPending = false;
      setEnglishCancelState(""); setEnglishCancelError(error.message);
    }
  }
  async function prepareEnglish() {
    if (catalogBusy || englishInFlight.current || !englishCounts.missing || !data.aiStatus?.configured) return;
    let id;
    try { id = createGenerationId(); }
    catch { setEnglishError(t("浏览器无法创建安全的生成标识，请使用支持 Web Crypto 的浏览器。", "The browser cannot create a secure generation ID. Use a browser that supports Web Crypto.")); return; }
    const generation = { id, cancelPending: false, finished: false };
    englishInFlight.current = generation;
    setEnglishRunning(true); setEnglishOutcome(null); setEnglishError(""); setEnglishCancelState(""); setEnglishCancelError("");
    try {
      await run(async () => {
        try {
          const result = await diningApi.catalog.prepareEnglish({ generationId: id });
          generation.finished = true;
          setEnglishOutcome({ status: "completed", result });
          return t(`英文名补全已结束，已填入 ${result.filled} 项；AI 译名需人工复核。`, `English-name completion finished: ${result.filled} items filled. AI names require human review.`);
        } catch (error) {
          generation.finished = true;
          if (error.code === "GENERATION_CANCELLED") {
            setEnglishOutcome({ status: "cancelled" });
            return t("已取消英文名补全，已完成批次保留在本地数据库。", "English-name completion cancelled. Completed batches remain in the local database.");
          }
          setEnglishError(error.message);
          setEnglishOutcome({ status: "failed" });
          // A failed later batch may follow successful saved batches. Returning
          // a truthful outcome lets the shared runner refresh those local rows.
          return t("英文名补全未完成，已保存的批次已保留。", "English-name completion did not finish. Saved batches are retained.");
        }
      }, { background: true });
    } finally {
      if (englishInFlight.current === generation) {
        englishInFlight.current = null; setEnglishRunning(false); setEnglishCancelState(""); setEnglishCancelError("");
      }
    }
  }
  function addDish() {
    if (catalogBusy) return;
    setFormError(""); setRecipes([]);
    setSelected({ name: "", stall: stall || stalls[0] || "", english: "", price: "", unit: "份", category: "", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "手工录入，标签待核验", active: true, sources: [] });
  }
  async function saveDish(event) {
    event.preventDefault();
    if (catalogBusy || mutationInFlight.current || !event.currentTarget.reportValidity()) return;
    const fields = Object.fromEntries(localizedFormData(event.currentTarget));
    const input = { ...fields, name: fields.name.trim(), stall: fields.stall, english: fields.english.trim(), category: fields.category.trim(), unit: fields.unit.trim(),
      price: Number(fields.price), active: fields.active === "on", calories: fields.calories === "" ? null : Number(fields.calories) };
    if (!input.name || !input.unit || !stalls.includes(input.stall) || !Number.isFinite(input.price) || input.price < 0 || input.price > 10000) {
      setFormError(t("请填写菜名、已有档口、计价单位与 0–10000 之间的售价。", "Enter a dish name, existing stall, pricing unit, and price between 0 and 10,000.")); return;
    }
    const editing = Boolean(selected.id);
    mutationInFlight.current = true; setSubmitting(true); setFormError("");
    try {
      await run(async () => {
        try {
          if (editing) await diningApi.catalog.update(selected.id, { ...input, expectedRevision: selected.revision || 0 });
          else {
            await diningApi.catalog.create(input);
            setArchived("current"); setStall(input.stall); setQuery(input.name); setMissing(false); setEnglishFilter("all"); setPage(1);
          }
          setSelected(null);
          return editing ? t("菜品资料已保存", "Dish details saved") : t("菜品已新增", "Dish added");
        } catch (error) { setFormError(error.message); throw error; }
      });
    } finally { mutationInFlight.current = false; setSubmitting(false); }
  }
  async function confirmArchive() {
    if (catalogBusy || mutationInFlight.current || !confirmation) return;
    const { dish, restore } = confirmation;
    mutationInFlight.current = true; setSubmitting(true); setConfirmError("");
    try {
      await run(async () => {
        try {
          if (restore) await diningApi.catalog.restore(dish.id, { expectedRevision: dish.revision || 0 });
          else await diningApi.catalog.remove(dish.id, { expectedRevision: dish.revision || 0 });
          setConfirmation(null);
          return restore ? t("菜品已恢复", "Dish restored") : t("菜品已归档，可在已删除列表恢复", "Dish archived. Restore it from the deleted list.");
        } catch (error) { setConfirmError(error.message); throw error; }
      });
    } finally { mutationInFlight.current = false; setSubmitting(false); }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">KNOWLEDGE / 03</span>
          <h1>{t("菜品资料")}</h1>
          <p>{t("菜品与配方资料均读取本地数据库，保留原始文件来源。", "Dishes and recipes are read from the local database, with original source references preserved.")}</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={addDish} disabled={catalogBusy || !stalls.length}><Plus size={16} />{t("新增菜品", "Add dish")}</button>
          <button onClick={prepareEnglish} disabled={catalogBusy || englishRunning || !englishCounts.missing || !data.aiStatus?.configured}>{englishRunning ? <LoaderCircle size={16} className="catalog-english-spinner" /> : <Sparkles size={16} />}{englishRunning ? t("正在补全英文名…", "Completing English names…") : t("补全英文名", "Complete English names")}</button>
          <button
            onClick={() =>
              run(async () => {
                setMaterials(await diningApi.catalog.materials());
                return t("资料清单已读取", "Source inventory loaded");
              })
            }
          >
            <FolderOpen size={16} />
            {t("资料清单", "Source inventory")}
          </button>
          <ExportButton
            onClick={() =>
              downloadCsv(
                "菜品资料.csv",
                items.map((dish) => ({
                  dishId: dish.id,
                  stall: dish.stall,
                  dishName: dish.name,
                  price: dish.price,
                  unit: dish.unit,
                  售价说明: dish.priceText,
                  辣度: dish.spicy,
                  素食: dish.vegetarian,
                  主料: dish.mainIngredient,
                  工艺: dish.method,
                  热量每100g: dish.calories,
                  过敏原: dish.allergens,
                  依据: dish.labelSource,
                })),
              )
            }
          />
        </div>
      </div>
      <div className="metrics">
        <Metric
          label={t("档口售卖项", "Catalog items")}
          value={currentDishes.length.toLocaleString(locale)}
          detail={t(`${currentStalls.length} 个菜库分组`, `${currentStalls.length} catalog groups`)}
          icon={BookOpen}
        />
        <Metric
          label={t("已有英文名称", "English names available")}
          value={englishCounts.ready + englishCounts.needs_review}
          detail={t(`缺失 ${englishCounts.missing} 项 · 英文待复核 ${englishCounts.needs_review} 项`, `${englishCounts.missing} missing · ${englishCounts.needs_review} English names to review`)}
          icon={Languages}
          color="blue"
        />
        <Metric
          label={t("人工维护标签", "Manually maintained labels")}
          value={currentDishes.filter((dish) => dish.verifiedAt).length}
          detail={t("保留核验依据", "Verification evidence retained")}
          icon={ShieldCheck}
          color="gold"
        />
        <Metric
          label={t("源表公式错误", "Source formula errors")}
          value={data.report.formulaErrors}
          detail={t("不作为有效成本", "Excluded from valid cost data")}
          icon={CircleAlert}
          color="red"
        />
      </div>
      <section className="catalog-english-panel" aria-label={t("菜品英文名维护", "Dish English-name maintenance")}>
        <p className="catalog-english-summary">{t(`共 ${currentDishes.length} 项 · 可用英文 ${englishCounts.ready} 项 · 缺失 ${englishCounts.missing} 项 · 英文待复核 ${englishCounts.needs_review} 项`, `${currentDishes.length} items · ${englishCounts.ready} ready English names · ${englishCounts.missing} missing · ${englishCounts.needs_review} English names to review`)}</p>
        <p className="muted small">{t("「补全英文名」仅在点击后为未删除菜品填补缺失英文，可能调用付费 AI；不覆盖已有译名，不更改中文菜名。译名分批保存到本地，后续查看和切换语言不会重复翻译。", "Complete English names explicitly fills missing names for non-deleted dishes and may call paid AI. Existing names and Chinese dish names are not replaced. Names are saved locally in batches; viewing pages or switching language never retranslates them.")}</p>
        <p className="muted small">{t("英文名仅作展示；AI 译名需核对，不作为配方、食材种类或过敏原的核验依据。", "English names are for display only. Review AI names; they are not evidence of recipes, ingredient species, or allergens.")}</p>
        {englishRunning && <div className="catalog-english-wait"><p role="status">{englishCancelState === "cancelling" ? t("正在请求服务端取消，请等待停止确认；已完成批次会保留。", "Requesting server cancellation. Wait for confirmation; completed batches are retained.") : englishCancelState === "finishing" ? t("服务端已结束，正在接收补全结果。", "The server has finished. Waiting for completion results.") : t("正在分批补全英文名，完成后刷新数量。可切换页面或继续调整菜品；已变更的记录由服务端重新核对。", "Completing English names in batches; counts refresh when finished. You can use other pages or edit dishes. The server rechecks changed records.")}</p><button type="button" disabled={Boolean(englishCancelState)} onClick={cancelEnglish}>{englishCancelState === "cancelling" ? t("正在取消…", "Cancelling…") : englishCancelState === "finishing" ? t("等待结果…", "Waiting for result…") : t("取消英文名补全", "Cancel English-name completion")}</button>{englishCancelError && <p role="alert">{englishCancelError}{t("。取消未确认，任务仍在继续，可重试取消。", " Cancellation was not confirmed. The task is still running; retry cancellation.")}</p>}</div>}
        {!englishRunning && englishOutcome?.status === "completed" && <p className="catalog-english-result" role="status">{t(`本次填入 ${englishOutcome.result.filled} 项 · 复用 ${englishOutcome.result.reused} 项 · 新生成 ${englishOutcome.result.generated} 项 · 完成 ${englishOutcome.result.batches} 批`, `${englishOutcome.result.filled} items filled · ${englishOutcome.result.reused} reused · ${englishOutcome.result.generated} generated · ${englishOutcome.result.batches} batches completed`)}</p>}
        {!englishRunning && englishOutcome?.status === "cancelled" && <p className="catalog-english-result" role="status">{t("已取消英文名补全，已完成批次保留在本地数据库。", "English-name completion cancelled. Completed batches remain in the local database.")}</p>}
        {englishError && <p className="catalog-english-error" role="alert">{englishError}{englishOutcome?.status === "failed" && t("。未完成的缺失项可重试补全，已保存批次不会丢失。", " Retry the remaining missing names; saved batches are retained.")}</p>}
      </section>
      <section className="work-section">
        <div className="section-heading">
          <h2>{t("档口菜品库", "Stall dish catalog")}</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={missing}
              onChange={(event) => {
                setMissing(event.target.checked);
                setPage(1);
              }}
            />
            {t("仅看标签待核验", "Unverified labels only")}
          </label>
        </div>
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label={t("搜索菜品", "Search dishes")}
              placeholder={t("搜索菜名或英文名称", "Search dish names or English names")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <select
            value={stall}
            aria-label={t("菜库档口", "Catalog stall")}
            onChange={(event) => {
              setStall(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("全部档口")}</option>
            {stalls.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <select aria-label={t("菜品归档筛选", "Dish archive filter")} value={archived} onChange={(event) => { setArchived(event.target.value); setPage(1); }}>
            <option value="current">{t("未删除菜品", "Current dishes")}</option>
            <option value="all">{t("包含已删除", "Include deleted")}</option>
            <option value="deleted">{t("仅已删除", "Deleted only")}</option>
          </select>
          <select aria-label={t("英文名状态筛选", "English-name status filter")} value={englishFilter} onChange={(event) => { setEnglishFilter(event.target.value); setPage(1); }}>
            <option value="all">{t("全部英文名状态", "All English-name statuses")}</option>
            <option value="missing">{t("英文名缺失", "English name missing")}</option>
            <option value="needs_review">{t("英文待复核", "English review required")}</option>
            <option value="ready">{t("可用英文", "Ready English names")}</option>
          </select>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("菜品名称")}</th>
                <th>{t("所属档口")}</th>
                <th>{t("售价", "Selling price")}</th>
                <th>{t("辣度 / 素食")}</th>
                <th>{t("热量 / 100g")}</th>
                <th>{t("状态")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {items
                .slice((currentPage - 1) * 12, currentPage * 12)
                .map((dish) => (
                  <tr key={dish.id}>
                    <td>
                      <strong>{dish.name}</strong>
                      <small className="english-name">
                        {dish.english || t("英文名称待补充", "English name not provided")}
                      </small>
                      <small className={`catalog-english-state ${englishNameState(dish)}`}>{englishLabel(dish)}</small>
                    </td>
                    <td>{dish.stall}</td>
                    <td className="nowrap">¥ {dish.priceText}</td>
                    <td>
                      <div className="badge-group">
                        <Badge
                          tone={
                            dish.spicy === "未知"
                              ? "gray"
                              : dish.spicy === "辣"
                                ? "red"
                                : "green"
                          }
                        >
                          {dish.spicy === "未知" ? t("辣度待核验", "Spice level unverified") : dish.spicy}
                        </Badge>
                        <Badge>
                          {dish.vegetarian === "未知"
                            ? t("素食待核验", "Vegetarian status unverified")
                            : dish.vegetarian}
                        </Badge>
                      </div>
                    </td>
                    <td>
                      {dish.calories === null ? (
                        <span className="muted">{t("待核验")}</span>
                      ) : (
                        `${dish.calories} kcal`
                      )}
                    </td>
                    <td>
                      <Badge tone={dish.deletedAt ? "gray" : dish.active ? "green" : "red"}>
                        {dish.deletedAt ? t("已删除 · 可恢复", "Deleted · Restorable") : dish.active ? t("可选", "Available") : t("停用", "Disabled")}
                      </Badge>
                    </td>
                    <td className="catalog-row-actions">
                      <button
                        className="icon-button"
                        disabled={catalogBusy || Boolean(dish.deletedAt)}
                        title={t(`编辑${dish.name}`, `Edit ${dish.name}`)}
                        aria-label={t(`编辑${dish.name}`, `Edit ${dish.name}`)}
                        onClick={() =>
                          run(async () => {
                            const evidence = await diningApi.catalog.recipes(dish.id);
                            setFormError("");
                            setRecipes(evidence);
                            setSelected(dish);
                            return t("菜品资料已读取", "Dish information loaded");
                          })
                        }
                      >
                        <Pencil size={15} />
                      </button>
                      <button className="icon-button" disabled={catalogBusy} title={dish.deletedAt ? t(`恢复${dish.name}`, `Restore ${dish.name}`) : t(`删除${dish.name}`, `Delete ${dish.name}`)} aria-label={dish.deletedAt ? t(`恢复${dish.name}`, `Restore ${dish.name}`) : t(`删除${dish.name}`, `Delete ${dish.name}`)} onClick={() => { setConfirmError(""); setConfirmation({ dish, restore: Boolean(dish.deletedAt) }); }}>{dish.deletedAt ? <RotateCcw size={15} /> : <Trash2 size={15} />}</button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty text={t("没有匹配的菜品", "No matching dishes")} />}
        <Pagination page={currentPage} setPage={setPage} count={items.length} />
      </section>
      {selected && (
        <Modal title={selected.id ? selected.name : t("新增菜品", "Add dish")} onClose={() => { if (!mutationInFlight.current) setSelected(null); }} busy={catalogBusy} wide>
          <div className="detail-meta">
            <Badge>{selected.stall}</Badge>
            <span>
              {selected.id ? `¥ ${selected.priceText} · ${selected.id}` : t("手工新增 · 标签需要核验", "Manual entry · Labels require verification")}
            </span>
          </div>
          <form onSubmit={saveDish}>
            {formError && <p className="notice catalog-form-error" role="alert">{formError}</p>}
            <div className="form-grid spaced">
              <Field label={t("菜品名称", "Dish name")}><input name="name" required maxLength={150} defaultValue={selected.name} /></Field>
              <Field label={t("所属档口", "Stall")}><select name="stall" required defaultValue={selected.stall}><option value="" disabled>{t("选择已有档口", "Choose an existing stall")}</option>{stalls.map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>
              <div className="catalog-english-field">
                <Field label={t("英文名称", "English name")}><input name="english" maxLength={200} aria-describedby={englishHelpId} defaultValue={selected.english || ""} /></Field>
                <small id={englishHelpId} className="catalog-english-help">{t("可手动修改。留空不会自动调用 AI；之后可点击「补全英文名」。仅查看或原样保存不会将 AI 译名标为已复核。", "Edit manually if needed. Leaving this blank never calls AI; use Complete English names later. Viewing or saving unchanged text does not approve an AI name.")}</small>
              </div>
              <Field label={t("售价（元）", "Price (CNY)")}><input name="price" type="number" min="0" max="10000" step="0.01" required defaultValue={selected.price ?? ""} /></Field>
              <Field label={t("计价单位", "Pricing unit")}><input name="unit" required maxLength={20} defaultValue={selected.unit || "份"} /></Field>
              <Field label={t("菜品分类", "Dish category")}><input name="category" maxLength={100} defaultValue={selected.category || ""} /></Field>
            </div>
            <div className="form-grid spaced">
              <Field label="辣度">
                <select name="spicy" defaultValue={selected.spicy}>
                  {["未知", "不辣", "辣"].map((value) => (
                    <option key={value} value={value}>{t(value)}</option>
                  ))}
                </select>
              </Field>
              <Field label="素食性">
                <select name="vegetarian" defaultValue={selected.vegetarian}>
                  {["未知", "素食", "非素食"].map((value) => (
                    <option key={value} value={value}>{t(value)}</option>
                  ))}
                </select>
              </Field>
              <Field label="主要食材">
                <input
                  name="mainIngredient"
                  defaultValue={selected.mainIngredient}
                />
              </Field>
              <Field label="制作工艺">
                <select name="method" defaultValue={selected.method}>
                  <option value="">{t("待核验")}</option>
                  {["炒", "炖", "蒸", "煮", "炸", "烤", "凉拌", "其他"].map(
                    (value) => (
                      <option key={value} value={value}>{t(value)}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="热量（kcal / 100g）">
                <input
                  name="calories"
                  type="number"
                  min="0"
                  max="900"
                  step="0.1"
                  defaultValue={selected.calories ?? ""}
                  placeholder={t("待核验")}
                />
              </Field>
              <Field label="过敏原">
                <input
                  name="allergens"
                  defaultValue={selected.allergens}
                  placeholder={t("待核验")}
                />
              </Field>
            </div>
            <Field label="标签核验依据">
              <LocalizedInput
                name="labelSource"
                required
                minLength={2}
                defaultValue={selected.labelSource?.trim() ? selected.labelSource : selected.id ? "资料待核验" : "手工录入，标签待核验"}
                placeholder={t("配方版本、厨师确认或营养数据来源", "Recipe version, chef confirmation, or nutrition source")}
              />
            </Field>
            <label className="check">
              <input
                name="active"
                type="checkbox"
                defaultChecked={selected.active}
              />
              {t("允许纳入排菜候选", "Include in menu candidates")}
            </label>
            <footer className="form-footer">
              <button className="primary" disabled={catalogBusy}>
                {selected.id ? t("保存资料", "Save details") : t("新增菜品", "Add dish")}
              </button>
            </footer>
          </form>
          <h3>{t(`配方证据 · ${recipes.length} 个版本`, `Recipe evidence · ${recipes.length} versions`)}</h3>
          <p className="muted small">
            {t("按原始菜名精确匹配；人工改名或调整档口不代表配方已审核。调料成分不完整时，不能据此确认无过敏原。", "Recipes match the original dish name. Renaming or moving a dish does not approve its recipe. Incomplete seasoning data cannot confirm the absence of allergens.")}
          </p>
          {recipes.map((recipe, index) => (
            <details key={index}>
              <summary>
                {recipe.source.sheet} · {recipe.source.row}{t("行 · 缓存成本", " row · Cached cost")}{" "}
                {recipe.cost === null
                  ? t("无有效值", "No valid value")
                  : `¥${recipe.cost.toFixed(2)}`}
                {recipe.issues.length ? t(" · 含错误", " · Contains errors") : ""}
              </summary>
              <p className="source">{recipe.source.file}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("原料")}</th>
                      <th>{t("熟重 g")}</th>
                      <th>{t("生重 g")}</th>
                      <th>{t("原料单价")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipe.ingredients.map((ingredient, ingredientIndex) => (
                      <tr key={ingredientIndex}>
                        <td>{ingredient.name}</td>
                        <td>{ingredient.cookedGrams ?? t("未知")}</td>
                        <td>
                          {ingredient.rawGrams === null
                            ? t("未知")
                            : ingredient.rawGrams.toFixed(1)}
                        </td>
                        <td>{ingredient.pricePerKg ?? t("未知")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          {!recipes.length && <p className="muted">{t("未找到同名配方证据。", "No matching recipe evidence found.")}</p>}
          <details>
            <summary>{t("菜库来源", "Catalog sources")}</summary>
            {selected.sourceIdentity && <div className="catalog-source-snapshot"><h4>{t("首次来源资料快照", "Original source snapshot")}</h4><p>{selected.sourceIdentity.name || selected.sourceName} · {selected.sourceIdentity.stall}</p><p>{t("原售价：", "Original price: ")}{selected.sourceIdentity.priceText || `${selected.sourceIdentity.price ?? "—"}/${selected.sourceIdentity.unit || ""}`}</p><small>{t("来源快照仅用于追溯，不覆盖当前编辑资料。", "This snapshot supports traceability and does not replace current dish details.")}</small></div>}
            {(selected.sources || []).map((source, index) => (
              <p className="source" key={index}>
                {source.file} / {source.sheet} / {t("行", "Row ")}{source.row}
              </p>
            ))}
          </details>
        </Modal>
      )}
      {confirmation && <Modal title={confirmation.restore ? t("恢复菜品", "Restore dish") : t("删除菜品", "Delete dish")} onClose={() => { if (!mutationInFlight.current) setConfirmation(null); }} busy={catalogBusy}>
        <p><strong>{confirmation.dish.name}</strong> · {confirmation.dish.stall}</p>
        <p className="notice">{confirmation.restore ? t("恢复后菜品将重新显示在菜库中；是否参与后续排菜仍取决于启用状态。历史菜单、配方和来源记录保持不变。", "Restoring returns this dish to the catalog. Eligibility for future menus still depends on its enabled status. Historical menus, recipes and source records remain unchanged.") : t("删除采用可恢复归档：菜品不再参与以后的排菜，但历史菜单、配方和源文件均保留。可在「仅已删除」列表中恢复。", "Deletion is recoverable archival: this dish is excluded from future menu planning, while historical menus, recipes and source files are retained. Restore it from the Deleted only list.")}</p>
        {confirmError && <p className="notice catalog-form-error" role="alert">{confirmError}</p>}
        <footer className="form-footer"><button type="button" disabled={catalogBusy} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</button><button type="button" className="primary" disabled={catalogBusy} onClick={confirmArchive}>{confirmation.restore ? t("确认恢复", "Confirm restore") : t("确认删除", "Confirm delete")}</button></footer>
      </Modal>}
      {materials && (
        <Modal title={t("资料读取清单", "Source inventory")} onClose={() => setMaterials(null)} wide>
          <p className="notice">
            {t(`${new Set(materials.map(item => item.source)).size}个工作簿 · ${materials.length}张工作表 · ${materials.reduce((total, item) => total + item.rows, 0).toLocaleString(locale)}个非空行。行数不是反馈数或菜品数。`, `${new Set(materials.map(item => item.source)).size} workbooks · ${materials.length} worksheets · ${materials.reduce((total, item) => total + item.rows, 0).toLocaleString(locale)} non-empty rows. Row counts are not feedback or dish counts.`)}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("来源")}</th>
                  <th>{t("工作表")}</th>
                  <th>{t("非空行")}</th>
                  <th>{t("错误")}</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((item) => (
                  <tr key={item.id}>
                    <td className="source">{item.source}</td>
                    <td>{item.sheet}</td>
                    <td>{item.rows}</td>
                    <td>{item.errors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
