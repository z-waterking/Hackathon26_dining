import { useEffect, useId, useRef, useState } from "react";
import { Check, FileText, History, LoaderCircle, Plus, RefreshCw, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { diningApi } from "./api/dining";
import { Empty, Pagination } from "./shared";
import { I18nVisibility, useI18n } from "./i18n";
import { LocalizedTextarea } from "./i18n-fields";
import "./prompt-settings.css";

const sections = [
  { id: "action", name: "反馈 → Action", en: "Feedback → Actions", number: "01" },
  { id: "rules", name: "全部排菜规则", en: "All menu rules", number: "02" },
  { id: "menu", name: "排菜最终 Prompt", en: "Final menu prompt", number: "03" },
  { id: "approved", name: "已批准 Action Prompt", en: "Approved action prompt", number: "04" },
  { id: "history", name: "确认历史", en: "Confirmation history", number: "05" },
];
const pageSize = 10;
const menuPreviewParts = [
  { title: "排菜指令", en: "Menu instructions", source: "上方编辑内容", sourceEn: "The instructions edited above" },
  { title: "自动加入的规则", en: "Automatically included rules", source: "全部已启用规则", sourceEn: "All enabled rules" },
  { title: "已批准 Action", en: "Approved actions", source: "应用指令与批准事项", sourceEn: "Application instructions and approved actions" },
  { title: "输出格式与固定校验", en: "Output format and fixed validation", source: "系统补充 · 只读", sourceEn: "Added by the system · Read-only" },
];

function editableValues(record) {
  return {
    actionGenerationText: record.actionGenerationText,
    menuSystemText: record.menuSystemText,
    approvedActionText: record.approvedActionText,
    rules: record.rules.map((rule) => ({ ...rule })),
  };
}

function sourceLabel(source, t, tr) {
  if (!source) return t("手动维护", "Manually maintained");
  if (typeof source === "string") return source;
  return (source.label ? tr(source.label) : "") || [source.file, source.sheet, source.row ? t(`第 ${source.row} 行`, `Row ${source.row}`) : "", source.cell].filter(Boolean).join(" · ") || t("资料规则", "Source rule");
}

function RuleOriginal({ text, active }) {
  const { t, tr } = useI18n();
  const [open, setOpen] = useState(false);
  return <details className="prompt-rule-original" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{t("查看来源规则原文", "View original source rule")}</summary><p>{active && open ? tr(text) : text}</p></details>;
}

function SavedPreview({ label, text, dirty, version, parts, description, fixed = false, defaultOpen = false }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  return <details className="prompt-saved-preview" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><FileText size={15} aria-hidden="true" />{fixed ? t("查看程序执行的固定校验", "View fixed program validation") : label}<span>{fixed ? t("只读", "Read-only") : <>{t("已保存版本", "Saved version")} {version}</>}</span></summary>
    <p>{fixed ? t("以下约束由程序与菜库执行，不随上方业务规则文本修改。", "The program and dish catalog enforce these constraints. Editing business rule text does not change them.") : <>{t("下方为服务端组合的已确认内容。", "The confirmed content assembled by the server appears below.")}{dirty && t("当前未确认修改尚未进入预览；请点击「确认修改并生效」。", " Unconfirmed changes are not included. Select “Confirm & apply” to include them.")}{description || (!dirty && t("实际调用时还会附带当次反馈、菜库、日期等任务数据。", " The actual request also includes feedback, the dish catalog, dates, and other task data."))}</>}</p>
    {parts && <ol className="prompt-preview-parts" aria-label={t("Prompt 组成", "Prompt components")}>{parts.map((part) => <li key={part.title}><strong>{t(part.title, part.en)}</strong><span>{t(part.source, part.sourceEn)}</span></li>)}</ol>}
    <pre aria-label={label}>{text || t("当前没有可注入的内容。", "There is currently no content to include.")}</pre>
  </details>;
}

const promptNames = { actionGenerationText: ["反馈 → Action", "Feedback → Actions"], menuSystemText: ["排菜指令", "Menu instructions"], approvedActionText: ["已批准 Action", "Approved actions"] };
function operationLabel(operation, t) {
  return operation === "base" ? "Base" : operation === "restore-base" ? t("复原到 Base", "Restore base")
    : ["confirm", "save"].includes(operation) ? t("确认修改", "Confirmed changes") : t("历史版本", "Legacy version");
}
function changeSummary(item, t) {
  const fields = (item.changedPrompts || []).map(key => promptNames[key] ? t(...promptNames[key]) : key);
  if (item.rulesChanged) fields.push(t("排菜规则", "Menu rules"));
  return fields.join(" · ") || (item.operation === "base" ? t("固定基础快照", "Fixed base snapshot") : t("内容未变化，已记录确认", "Confirmation recorded without content changes"));
}
function HistorySnapshot({ snapshot, onClose }) {
  const { t, locale } = useI18n();
  return <section className="prompt-history-snapshot" aria-label={t("历史只读快照", "Read-only history snapshot")}>
    <div className="prompt-history-snapshot-heading"><div><h3>{snapshot.version === 0 ? t("Base · 版本 0", "Base · Version 0") : t(`版本 ${snapshot.version}`, `Version ${snapshot.version}`)}</h3><p>{operationLabel(snapshot.operation, t)} · {snapshot.version === 0 ? t("冻结于 ", "Captured ") : ""}{snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleString(locale) : t("未记录时间", "Time not recorded")}</p></div><button onClick={onClose}>{t("关闭快照", "Close snapshot")}</button></div>
    <p className="prompt-history-note">{t("这是当时确认的三个 Prompt 与完整规则，只读展示；不会拼入当前 Action，也不会替换当前草稿。", "This read-only snapshot contains the three prompts and complete rules confirmed at that time. It does not include current actions or replace your draft.")}</p>
    <p className="prompt-history-fingerprint">{t("内容指纹", "Content fingerprint")}: {snapshot.fingerprint || "—"}</p>
    {Object.entries(promptNames).map(([key, labels]) => <div className="prompt-history-text" key={key}><h4>{t(...labels)}</h4><pre aria-label={t(`历史 ${labels[0]} Prompt`, `Historical ${labels[1]} prompt`)}>{snapshot[key]}</pre></div>)}
    <h4>{t(`完整规则 · ${snapshot.rules?.length || 0} 条`, `Complete rules · ${snapshot.rules?.length || 0}`)}</h4>
    <ol className="prompt-history-rules">{(snapshot.rules || []).map((rule, index) => <li key={`${rule.id}-${index}`}><div><strong>{rule.stall}</strong><span>{rule.enabled === false ? t("已禁用", "Disabled") : t("已启用", "Enabled")}{rule.meal ? ` · ${t(rule.meal)}` : ""}</span></div><p>{rule.text}</p><small>{rule.id} · {sourceLabel(rule.source, t, value => value)}</small></li>)}</ol>
  </section>;
}

export default function PromptSettings({ data, run, busy }) {
  const { t, tr, locale, language } = useI18n();
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [section, setSection] = useState("action");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [query, setQuery] = useState("");
  const [stallFilter, setStallFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState("");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historySnapshot, setHistorySnapshot] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const snapshotRequest = useRef(0);
  const dirty = Boolean(record && draft && JSON.stringify(draft) !== JSON.stringify(editableValues(record)));
  const dirtyRef = useRef(false);
  const forceReloadRef = useRef(false);
  const pageId = useId();

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    const force = forceReloadRef.current;
    forceReloadRef.current = false;
    if (dirtyRef.current && !force) {
      setStale(true);
      setLoading(false);
      return;
    }
    let ignore = false;
    setLoading(true);
    setError("");
    diningApi.prompts.get().then((next) => {
      if (ignore) return;
      if (dirtyRef.current && !force) { setStale(true); return; }
      setRecord(next);
      setDraft(editableValues(next));
      setStale(false);
    }).catch((failure) => {
      if (!ignore) setError(failure.message);
    }).finally(() => {
      if (!ignore) setLoading(false);
    });
    return () => { ignore = true; };
  }, [data, reloadCounter]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);
  useEffect(() => {
    if (section !== "history") return;
    let ignore = false;
    // This effect synchronizes paged server history without touching the draft.
    // oxlint-disable-next-line react/set-state-in-effect
    setHistoryLoading(true); setHistoryError("");
    diningApi.prompts.history({ page: historyPage, pageSize }).then(next => {
      if (!ignore) setHistory(next);
    }).catch(failure => { if (!ignore) setHistoryError(failure.message); })
      .finally(() => { if (!ignore) setHistoryLoading(false); });
    return () => { ignore = true; };
  }, [section, historyPage, historyRefresh, record?.version]);
  useEffect(() => () => { snapshotRequest.current++; }, []);

  const locked = busy || saving || restoring || loading;
  const adoptConfirmed = next => {
    setRecord(next); setDraft(editableValues(next));
    dirtyRef.current = false; setStale(false); setAppliedVersion(next.version);
    setHistoryPage(1); setHistoryRefresh(value => value + 1);
  };
  const viewHistory = async version => {
    const request = ++snapshotRequest.current;
    setSection("history"); setSnapshotLoading(true); setSnapshotError("");
    try {
      const next = await diningApi.prompts.historyVersion(version);
      if (request === snapshotRequest.current) setHistorySnapshot(next);
    } catch (failure) { if (request === snapshotRequest.current) setSnapshotError(failure.message); }
    finally { if (request === snapshotRequest.current) setSnapshotLoading(false); }
  };
  const restoreBase = async () => {
    if (locked || !record?.base) return;
    if (!window.confirm(t("复原到固定 Base 将一起还原三个 Prompt 与全部排菜规则，丢弃当前未确认草稿；已批准 Action 不会改变。实际内容发生变化时会新增历史，不删除旧历史。是否确认复原并生效？", "Restore the fixed base for all three prompts and every menu rule? Unconfirmed drafts will be discarded. Approved actions will not change. A history entry is added when saved content changes; existing history is not deleted. Confirm restoration and apply?"))) return;
    setRestoring(true); setError("");
    try {
      await run(async () => {
        try {
          const next = await diningApi.prompts.restoreBase({ version: record.version, baseFingerprint: record.baseFingerprint });
          adoptConfirmed(next);
          return t("已复原到 Base 并生效；历史记录已保留", "Base restored and applied. History has been preserved.");
        } catch (failure) { setError(failure.message); throw failure; }
      });
    } finally { setRestoring(false); }
  };
  const reload = () => {
    if (dirty && !window.confirm(t("有尚未保存的 Prompt 或规则修改。重新加载将放弃这些修改，是否继续？", "You have unsaved prompt or rule changes. Reloading will discard them. Continue?"))) return;
    forceReloadRef.current = true;
    setLoading(true);
    setReloadCounter((value) => value + 1);
  };
  const updateText = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const updateRule = (id, key, value) => setDraft((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === id ? { ...rule, [key]: value } : rule) }));
  const addRule = () => {
    setDraft((current) => ({ ...current, rules: [...current.rules, { id: `new-${crypto.randomUUID()}`, stall: "全部档口", text: "", enabled: true, source: null }] }));
    setQuery(""); setStallFilter(""); setEnabledFilter("");
    setPage(Math.ceil((draft.rules.length + 1) / pageSize));
  };
  const save = async () => {
    if (locked || (!dirty && !record.sourceChanged)) return;
    if ([draft.actionGenerationText, draft.menuSystemText, draft.approvedActionText].some((text) => text.trim().length < 10 || text.length > 24000)) {
      setError(t("三项 Prompt 均需填写 10 至 24,000 个字符。", "Each of the three prompts must contain 10 to 24,000 characters."));
      return;
    }
    if (draft.rules.length > 300 || !draft.rules.some((rule) => rule.enabled !== false)) {
      setError(t("最多可保存 300 条规则，且至少需要保留一条已启用规则。", "You can save up to 300 rules, with at least one rule enabled."));
      setSection("rules");
      return;
    }
    const incompleteRule = draft.rules.find((rule) => !rule.stall.trim() || !rule.text.trim());
    if (incompleteRule) {
      setError(t("规则的适用档口和内容不能为空，请补充或删除空白规则。", "Each rule needs a target stall and content. Complete or remove empty rules."));
      setSection("rules");
      setQuery(""); setStallFilter(""); setEnabledFilter("");
      setPage(Math.floor(draft.rules.indexOf(incompleteRule) / pageSize) + 1);
      return;
    }
    setSaving(true); setError("");
    try {
      await run(async () => {
        try {
          const rules = draft.rules.map(({ id, stall, text, enabled, source, meal }) => ({ id, stall, text, enabled, source, ...(meal ? { meal } : {}) }));
          const next = await diningApi.prompts.save({ ...draft, rules, version: record.version, baseFingerprint: record.baseFingerprint });
          adoptConfirmed(next);
          return t("Prompt 与规则已确认并生效，最终预览已更新，将用于下一次生成", "Prompts and rules confirmed and applied. The final preview is updated for the next generation.");
        } catch (failure) {
          setError(failure.message);
          throw failure;
        }
      });
    } finally { setSaving(false); }
  };
  const changeTab = (event, index) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % sections.length;
    else if (event.key === "ArrowLeft") next = (index + sections.length - 1) % sections.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = sections.length - 1;
    else return;
    event.preventDefault();
    setSection(sections[next].id);
    document.getElementById(`${pageId}-tab-${sections[next].id}`)?.focus();
  };

  const rules = draft?.rules || [];
  const search = query.trim().toLocaleLowerCase();
  const visibleRules = rules.filter((rule) => (!stallFilter || rule.stall === stallFilter)
    && (!enabledFilter || (rule.enabled !== false) === (enabledFilter === "enabled"))
    && (!search || `${rule.stall} ${rule.text} ${section === "rules" ? tr(rule.text) : ""} ${sourceLabel(rule.source, t, section === "rules" ? tr : (text) => text)}`.toLocaleLowerCase().includes(search)));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleRules.length / pageSize)));
  const stallOptions = [...new Set([...(data.dishes || []).map((dish) => dish.stall), ...rules.map((rule) => rule.stall)])].filter(Boolean).sort();
  const approvedActions = record?.approvedActions || [];
  const preview = (key, label, active) => <SavedPreview label={label} text={record.previews?.[key]} dirty={dirty} version={record.version} active={active} />;

  return <div className="prompt-settings">
    <header className="page-heading prompt-page-heading">
      <div><span className="eyebrow">PROMPTS & RULES</span><h1>{t("Prompt 与规则", "Prompts & Rules")}</h1><p>{t("编辑后点击「确认修改并生效」，才会更新最终 Prompt 并参与下一次生成。", "After editing, select “Confirm & apply” to update the final prompt for the next generation.")}</p></div>
      <div className="actions">
        <button onClick={reload} disabled={locked} aria-label={t("重新加载已保存的 Prompt 与规则", "Reload saved prompts and rules")}><RefreshCw size={16} />{t("重新加载", "Reload")}</button>
        <button onClick={restoreBase} disabled={locked || !record?.base || (record.base.isCurrent && !dirty)}><RotateCcw size={16} />{restoring ? t("正在复原…", "Restoring…") : t("复原到 Base", "Restore base")}</button>
        <button className="primary" onClick={save} disabled={locked || (!dirty && !record?.sourceChanged)}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{saving ? t("确认中…", "Confirming…") : t("确认修改并生效", "Confirm & apply")}</button>
      </div>
    </header>
    {error && <p className="notice prompt-error" role="alert">{tr(error)}{draft && t(" 当前草稿已保留。", " Your draft has been preserved.")}</p>}
    {stale && <p className="notice" role="status">{t("工作空间已有更新，当前草稿仍保留。保存可能需要处理版本冲突；可重新加载最新配置与已批准 Action。", "The workspace has changed. Your draft is preserved. Saving may require resolving a version conflict; reload to get the latest configuration and approved actions.")}</p>}
    {record?.sourceChanged && <p className="notice" role="status">{t("源规则文件已变化，请核对运营覆盖与原文后保存确认。", "The source rule file has changed. Compare operational overrides with the original text, then save to confirm.")}</p>}
    {appliedVersion !== null && <p className="prompt-confirmed-note" role="status">{t(`版本 ${appliedVersion} 已确认并生效；排菜最终 Prompt 已同步全部启用规则，历史记录已保留。`, `Version ${appliedVersion} is confirmed and applied. The final menu prompt now includes all enabled rules, and history is preserved.`)}<button onClick={() => setSection("menu")}>{t("查看排菜最终 Prompt", "View final menu prompt")}</button></p>}
    {!record ? <div className="loading">{loading ? <><LoaderCircle className="spin" size={20} />{t("正在读取 Prompt 与规则", "Loading prompts and rules")}</> : t("配置未加载，请点击重新加载。", "Configuration could not be loaded. Select Reload to try again.")}</div> : <>
      <div className="prompt-state-bar" role="status">
        <span className={dirty ? "prompt-dirty" : "prompt-saved"}>{dirty ? <span className="prompt-state-dot" /> : <Check size={14} />}{dirty ? t("有未确认修改 · 尚未生效", "Unconfirmed changes · Not applied") : t("与已确认版本一致", "Matches the confirmed version")}</span>
        <span>{t("版本", "Version")} {record.version}{record.updatedAt ? t(` · 保存于 ${new Date(record.updatedAt).toLocaleString(locale)}`, ` · Saved ${new Date(record.updatedAt).toLocaleString(locale)}`) : t(" · 默认配置", " · Default configuration")}</span>
        {loading && <span><LoaderCircle size={13} className="spin" />{t("正在刷新", "Refreshing")}</span>}
      </div>
      {record.base && <div className="prompt-base-note"><span>{t("固定 Base", "Fixed base")} · {record.base.capturedAt ? t("冻结于 ", "Captured ") + new Date(record.base.capturedAt).toLocaleString(locale) : t("初始配置", "Initial configuration")}{record.base.isCurrent ? t(" · 当前内容与 Base 一致", " · Current content matches the base") : ""}</span><button onClick={() => viewHistory(0)} disabled={snapshotLoading}>{t("查看 Base", "View base")}</button></div>}
      <p className="prompt-scope-note">{t("此处编辑的是 AI 业务规则与指令；菜库归属、价位槽位及本地程序校验仍由系统执行，文本编辑不会绕过校验。保存不会追溯改写旧菜单；已开始的生成使用原配置快照，恢复历史生成需匹配原版本。", "This page edits AI business rules and instructions. The system still validates dish ownership, price slots, and other constraints; editing text cannot bypass validation. Saving does not change old menus. Generation already in progress uses its original configuration snapshot, and resuming a historical run requires the matching version.")}</p>
      <p className="prompt-access-note">{t("请勿填入密钥等机密；此页沿用应用现有访问权限。", "Do not enter secrets such as API keys. This page uses the app’s existing access permissions.")}</p>
      {language === "en" && <p className="prompt-access-note">Only interface labels are translated. Prompt and rule content stays in its original language; only confirmed edits change the instructions sent to AI.</p>}
      <div className="prompt-section-tabs" role="tablist" aria-label={t("Prompt 与规则分类", "Prompt and rule categories")}>{sections.map((item, index) => <button
        key={item.id} id={`${pageId}-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id} aria-controls={`${pageId}-panel-${item.id}`}
        tabIndex={section === item.id ? 0 : -1} className={section === item.id ? "active" : ""}
        onClick={() => setSection(item.id)} onKeyDown={(event) => changeTab(event, index)}
      ><span>{item.number}</span>{t(item.name, item.en)}{item.id === "rules" && <small>{rules.length}</small>}</button>)}</div>

      <section className="prompt-panel" id={`${pageId}-panel-action`} aria-labelledby={`${pageId}-tab-action`} role="tabpanel" hidden={section !== "action"}>
        <div className="prompt-panel-heading"><h2>{t("从反馈生成 Action", "Generate actions from feedback")}</h2><p>{t("规定如何理解反馈、归纳问题与提出可执行的改善事项。", "Define how to interpret feedback, summarize issues, and propose actionable improvements.")}</p></div>
        <label className="prompt-editor"><span>{t("反馈 → Action 业务 Prompt", "Feedback-to-action business prompt")}</span><I18nVisibility active={section === "action"}><LocalizedTextarea aria-label={t("反馈 → Action 业务 Prompt", "Feedback-to-action business prompt")} rows={14} spellCheck={false} disabled={locked} value={draft.actionGenerationText} onChange={(event) => updateText("actionGenerationText", event.target.value)} /></I18nVisibility></label>
        {preview("actionGeneration", t("查看实际组合的 Action System Prompt", "View the assembled action system prompt"), section === "action")}
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-rules`} aria-labelledby={`${pageId}-tab-rules`} role="tabpanel" hidden={section !== "rules"}>
        <div className="prompt-panel-heading prompt-rules-heading"><div><h2>{t("全部排菜规则", "All menu rules")}</h2><p>{t(`共 ${rules.length} 条，已启用 ${rules.filter((rule) => rule.enabled !== false).length} 条。启用规则将列入排菜 System Prompt；禁用规则保留在清单中。`, `${rules.length} rules, ${rules.filter((rule) => rule.enabled !== false).length} enabled. Enabled rules are included in the menu system prompt; disabled rules remain in the list.`)}</p></div><button onClick={addRule} disabled={locked || rules.length >= 300}><Plus size={16} />{t("添加规则", "Add rule")}</button></div>
        <div className="filters prompt-rule-filters">
          <label className="search"><Search size={16} aria-hidden="true" /><input aria-label={t("搜索排菜规则", "Search menu rules")} placeholder={t("搜索档口、规则或来源", "Search stalls, rules, or sources")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
          <select aria-label={t("按档口筛选规则", "Filter rules by stall")} value={stallFilter} onChange={(event) => { setStallFilter(event.target.value); setPage(1); }}><option value="">{t("所有适用档口", "All applicable stalls")}</option>{[...new Set(rules.map((rule) => rule.stall))].filter(Boolean).sort().map((stall) => <option key={stall} value={stall}>{stall === "全部档口" ? t("全部档口", "All stalls") : stall}</option>)}</select>
          <select aria-label={t("按启用状态筛选规则", "Filter rules by enabled status")} value={enabledFilter} onChange={(event) => { setEnabledFilter(event.target.value); setPage(1); }}><option value="">{t("全部状态", "All statuses")}</option><option value="enabled">{t("已启用", "Enabled")}</option><option value="disabled">{t("已禁用", "Disabled")}</option></select>
        </div>
        <div className="table-scroll prompt-rules-table"><table><thead><tr><th>{t("启用", "Enabled")}</th><th>{t("适用档口", "Target stall")}</th><th>{t("规则内容与来源", "Rule content and source")}</th><th>{t("操作", "Actions")}</th></tr></thead><tbody>{visibleRules.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((rule) => <tr key={rule.id} className={rule.enabled === false ? "prompt-rule-disabled" : ""}>
          <td><input type="checkbox" aria-label={t(`启用规则 ${rule.id}`, `Enable rule ${rule.id}`)} checked={rule.enabled !== false} disabled={locked} onChange={(event) => updateRule(rule.id, "enabled", event.target.checked)} /></td>
          <td><input aria-label={t(`规则档口 ${rule.id}`, `Rule stall ${rule.id}`)} list={`${pageId}-stalls`} value={rule.stall} disabled={locked} onChange={(event) => updateRule(rule.id, "stall", event.target.value)} /></td>
          <td><I18nVisibility active={section === "rules"}><LocalizedTextarea aria-label={t(`规则内容 ${rule.id}`, `Rule content ${rule.id}`)} rows={3} value={rule.text} disabled={locked} onChange={(event) => updateRule(rule.id, "text", event.target.value)} /></I18nVisibility><small>{rule.origin === "override" ? t("运营调整 · ", "Operational override · ") : rule.origin === "source" ? t("来源原文 · ", "Source text · ") : ""}{sourceLabel(rule.source, t, section === "rules" ? tr : (text) => text)}{rule.meal ? ` · ${t(rule.meal)}` : ""}</small>{rule.origin === "override" && rule.originalText && <RuleOriginal text={rule.originalText} active={section === "rules"} />}</td>
          <td><button className="icon-button prompt-remove-rule" aria-label={t(`删除规则 ${rule.id}`, `Delete rule ${rule.id}`)} title={t("删除规则，保存后生效", "Delete rule; applied when saved")} disabled={locked} onClick={() => setDraft((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Trash2 size={16} /></button></td>
        </tr>)}</tbody></table>{!visibleRules.length && <Empty text={rules.length ? t("当前筛选条件下没有规则", "No rules match the current filters.") : t("暂无规则，可添加新的排菜要求", "No rules yet. Add a new menu requirement.")} />}</div>
        <Pagination page={currentPage} setPage={setPage} count={visibleRules.length} size={pageSize} />
        <div className="prompt-inline-confirm"><p className="prompt-rules-footnote">{t("筛选和翻页不会丢失修改。确认会同时保存全部规则与三项 Prompt，并立即更新排菜最终预览。", "Filtering and paging preserve edits. Confirmation saves all rules and all three prompts and immediately updates the final menu preview.")}</p><button className="primary" onClick={save} disabled={locked || (!dirty && !record.sourceChanged)} aria-label={t("确认全部规则与 Prompt", "Confirm all rules and prompts")}><Check size={15} />{t("确认修改并生效", "Confirm & apply")}</button></div>
        {record.localConstraintsText && <SavedPreview label={t("程序执行的固定校验", "Fixed program validation")} text={record.localConstraintsText} active={section === "rules"} fixed />}
        <datalist id={`${pageId}-stalls`}><option value="全部档口">{t("全部档口", "All stalls")}</option>{stallOptions.filter((stall) => stall !== "全部档口").map((stall) => <option key={stall} value={stall}>{stall}</option>)}</datalist>
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-menu`} aria-labelledby={`${pageId}-tab-menu`} role="tabpanel" hidden={section !== "menu"}>
        <div className="prompt-panel-heading"><h2>{t("排菜最终 Prompt", "Final menu prompt")}</h2><p>{t("下方最终预览为已确认指令、全部启用规则及已批准 Action 的完整组合。业务编辑框仅是其中一部分；修改后必须确认，预览才会更新。", "The final preview combines confirmed instructions, all enabled rules, and approved actions. The business editor is only one component; changes appear in the preview only after confirmation.")}</p></div>
        <label className="prompt-editor"><span>{t("排菜业务 Prompt", "Menu business prompt")}</span><I18nVisibility active={section === "menu"}><LocalizedTextarea aria-label={t("排菜业务 Prompt", "Menu business prompt")} rows={17} spellCheck={false} disabled={locked} value={draft.menuSystemText} onChange={(event) => updateText("menuSystemText", event.target.value)} /></I18nVisibility></label>
        <SavedPreview label={t("最终 Prompt 预览", "Final prompt preview")} text={record.previews?.menuSystem} dirty={dirty} version={record.version} parts={menuPreviewParts} defaultOpen
          description={t("这里汇总全部可参与排菜的 Action；实际调用会按当前档口筛选，并附带当次菜库、日期及历史菜单。", "This includes all eligible menu actions. Each request filters actions for the current stall and adds the dish catalog, dates, and menu history.")} />
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-history`} aria-labelledby={`${pageId}-tab-history`} role="tabpanel" hidden={section !== "history"}>
        <div className="prompt-panel-heading prompt-rules-heading"><div><h2><History size={18} /> {t("每次确认均可追溯", "Every confirmation is traceable")}</h2><p>{t("查看当时确认的完整 Prompt 与规则。复原 Base 若改变已保存内容会新增版本，不删除既有历史。历史仅供查看，不会替换草稿。", "View the full prompts and rules confirmed at each point. Restoring base adds a version when saved content changes, without deleting history. Viewing history never replaces your draft.")}</p></div><button onClick={() => setHistoryRefresh(value => value + 1)} disabled={historyLoading}>{t("刷新历史", "Refresh history")}</button></div>
        {historyError && <p className="notice prompt-error" role="alert">{tr(historyError)}{t(" 当前草稿未改变，可重试刷新历史。", " Your draft is unchanged. Retry refreshing history.")}</p>}
        {historyLoading && <p role="status"><LoaderCircle size={15} className="spin" /> {t("正在读取确认历史", "Loading confirmation history")}</p>}
        {history && <><div className="table-scroll prompt-history-table"><table><thead><tr><th>{t("版本与时间", "Version and time")}</th><th>{t("操作与变更", "Operation and changes")}</th><th>{t("规则", "Rules")}</th><th>{t("操作", "Actions")}</th></tr></thead><tbody>{history.items.map(item => <tr key={item.version}><td><strong>{item.version === 0 ? "Base · v0" : `v${item.version}`}</strong><small>{item.version === 0 ? t("冻结于 ", "Captured ") : ""}{item.updatedAt ? new Date(item.updatedAt).toLocaleString(locale) : "—"}</small></td><td><strong>{operationLabel(item.operation, t)}</strong><small>{changeSummary(item, t)}</small>{item.previousVersion !== null && item.previousVersion !== undefined && <small>{t(`上一版本 v${item.previousVersion}`, `Previous version v${item.previousVersion}`)}</small>}</td><td>{t(`${item.enabledRuleCount ?? 0} / ${item.ruleCount ?? 0} 已启用`, `${item.enabledRuleCount ?? 0} / ${item.ruleCount ?? 0} enabled`)}</td><td><button onClick={() => viewHistory(item.version)} disabled={snapshotLoading} aria-label={t(`查看版本 ${item.version}`, `View version ${item.version}`)}>{t("查看快照", "View snapshot")}</button></td></tr>)}</tbody></table>{!history.items.length && <Empty text={t("暂无确认历史", "No confirmation history yet")} />}</div><Pagination page={history.page} setPage={setHistoryPage} count={history.total} size={history.pageSize} /></>}
        {snapshotLoading && <p role="status">{t("正在读取只读快照", "Loading read-only snapshot")}</p>}
        {snapshotError && <p className="notice prompt-error" role="alert">{tr(snapshotError)}{t(" 当前草稿与已打开快照均已保留。", " Your draft and any open snapshot are preserved.")}</p>}
        {historySnapshot && <HistorySnapshot snapshot={historySnapshot} onClose={() => { snapshotRequest.current++; setSnapshotLoading(false); setHistorySnapshot(null); }} />}
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-approved`} aria-labelledby={`${pageId}-tab-approved`} role="tabpanel" hidden={section !== "approved"}>
        <div className="prompt-panel-heading"><h2>{t("添加已批准 Action 的 Prompt", "Prompt for including approved actions")}</h2><p>{t("定义已确定的改善事项如何参与排菜。仅符合条件的已批准、已启用排菜 Action 会作为当次要求注入。", "Define how approved improvements affect menu planning. Only eligible, approved, and enabled menu actions are included as requirements.")}</p></div>
        <label className="prompt-editor"><span>{t("已批准 Action 注入 Prompt", "Approved action inclusion prompt")}</span><I18nVisibility active={section === "approved"}><LocalizedTextarea aria-label={t("已批准 Action 注入 Prompt", "Approved action inclusion prompt")} rows={10} spellCheck={false} disabled={locked} value={draft.approvedActionText} onChange={(event) => updateText("approvedActionText", event.target.value)} /></I18nVisibility></label>
        {preview("approvedActions", t("查看已批准 Action 的实际注入内容", "View the included approved action content"), section === "approved")}
        <div className="prompt-approved-heading"><h3>{t("可注入排菜的已批准 Action", "Approved actions eligible for menu planning")}</h3><span>{t(`${approvedActions.length} 项 · 只读`, `${approvedActions.length} actions · Read-only`)}</span></div>
        <p className="prompt-approved-note">{t("以下为最近读取的已批准且符合排菜条件的事项；具体排菜要求与审批状态在「Action 事项」中维护，实际参与内容以上方注入预览为准。", "These are the latest loaded approved actions eligible for menu planning. Manage their requirements and approval status on the Actions page. The preview above shows what is actually included.")}</p>
        {!approvedActions.length ? <Empty text={t("当前没有已批准的 Action", "There are currently no approved actions.")} /> : <ul className="prompt-approved-list">{approvedActions.map((action, index) => <li key={action.id || index}>
          <div><h3>{action.title ? (section === "approved" ? tr(action.title) : action.title) : t("未命名改善事项", "Untitled improvement action")}</h3><span>{!action.targetStall || action.targetStall === "全部档口" ? t("全部档口", "All stalls") : action.targetStall}{action.enabled === false ? t(" · 已停用", " · Disabled") : ""}</span></div>
          {action.description && <p>{section === "approved" ? tr(action.description) : action.description}</p>}
          <p className="prompt-approved-instruction"><strong>{action.menuInstruction ? t("排菜要求", "Menu requirement") : t("运营事项", "Operations action")}</strong>{action.menuInstruction ? (section === "approved" ? tr(action.menuInstruction) : action.menuInstruction) : t("服务与流程改善由运营跟进，不注入选菜要求。", "Operations follows up on service and process improvements; these are not included as dish-selection requirements.")}</p>
        </li>)}</ul>}
      </section>
    </>}
  </div>;
}
