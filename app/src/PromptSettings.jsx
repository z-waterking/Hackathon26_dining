import { useEffect, useId, useRef, useState } from "react";
import { Check, FileText, LoaderCircle, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { diningApi } from "./api/dining";
import { Empty, Pagination } from "./shared";
import "./prompt-settings.css";

const sections = [
  { id: "action", name: "反馈 → Action", number: "01" },
  { id: "rules", name: "全部排菜规则", number: "02" },
  { id: "menu", name: "排菜 System Prompt", number: "03" },
  { id: "approved", name: "已批准 Action Prompt", number: "04" },
];
const pageSize = 10;
const menuPreviewParts = [
  { title: "排菜指令", source: "上方编辑内容" },
  { title: "自动加入的规则", source: "全部已启用规则" },
  { title: "已批准 Action", source: "应用指令与批准事项" },
  { title: "输出格式与固定校验", source: "系统补充 · 只读" },
];

function editableValues(record) {
  return {
    actionGenerationText: record.actionGenerationText,
    menuSystemText: record.menuSystemText,
    approvedActionText: record.approvedActionText,
    rules: record.rules.map((rule) => ({ ...rule })),
  };
}

function sourceLabel(source) {
  if (!source) return "手动维护";
  if (typeof source === "string") return source;
  return source.label || [source.file, source.sheet, source.row ? `第 ${source.row} 行` : "", source.cell].filter(Boolean).join(" · ") || "资料规则";
}

function SavedPreview({ label, text, dirty, version, parts, description }) {
  return <details className="prompt-saved-preview">
    <summary><FileText size={15} aria-hidden="true" />{label}<span>已保存版本 {version}</span></summary>
    <p>下方为服务端组合的已保存内容。{dirty && "当前未保存修改尚未进入预览。"}{description || (!dirty && "实际调用时还会附带当次反馈、菜库、日期等任务数据。")}</p>
    {parts && <ol className="prompt-preview-parts" aria-label="Prompt 组成">{parts.map((part) => <li key={part.title}><strong>{part.title}</strong><span>{part.source}</span></li>)}</ol>}
    <pre aria-label={label}>{text || "当前没有可注入的内容。"}</pre>
  </details>;
}

export default function PromptSettings({ data, run, busy }) {
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [section, setSection] = useState("action");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [query, setQuery] = useState("");
  const [stallFilter, setStallFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState("");
  const [page, setPage] = useState(1);
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

  const locked = busy || saving || loading;
  const reload = () => {
    if (dirty && !window.confirm("有尚未保存的 Prompt 或规则修改。重新加载将放弃这些修改，是否继续？")) return;
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
      setError("三项 Prompt 均需填写 10 至 24,000 个字符。");
      return;
    }
    if (draft.rules.length > 300 || !draft.rules.some((rule) => rule.enabled !== false)) {
      setError("最多可保存 300 条规则，且至少需要保留一条已启用规则。");
      setSection("rules");
      return;
    }
    const incompleteRule = draft.rules.find((rule) => !rule.stall.trim() || !rule.text.trim());
    if (incompleteRule) {
      setError("规则的适用档口和内容不能为空，请补充或删除空白规则。");
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
          setRecord(next);
          setDraft(editableValues(next));
          dirtyRef.current = false;
          setStale(false);
          return "Prompt 与规则已保存，将用于下一次生成";
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
    && (!search || `${rule.stall} ${rule.text} ${sourceLabel(rule.source)}`.toLocaleLowerCase().includes(search)));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleRules.length / pageSize)));
  const stallOptions = [...new Set([...(data.dishes || []).map((dish) => dish.stall), ...rules.map((rule) => rule.stall)])].filter(Boolean).sort();
  const approvedActions = record?.approvedActions || [];
  const preview = (key, label) => <SavedPreview label={label} text={record.previews?.[key]} dirty={dirty} version={record.version} />;

  return <div className="prompt-settings">
    <header className="page-heading prompt-page-heading">
      <div><span className="eyebrow">PROMPTS & RULES</span><h1>Prompt 与规则</h1><p>统一维护生成指令与排菜要求，保存后参与下一次生成。</p></div>
      <div className="actions">
        <button onClick={reload} disabled={locked} aria-label="重新加载已保存的 Prompt 与规则"><RefreshCw size={16} />重新加载</button>
        <button className="primary" onClick={save} disabled={locked || (!dirty && !record?.sourceChanged)}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{saving ? "保存中…" : "保存并生效"}</button>
      </div>
    </header>
    {error && <p className="notice prompt-error" role="alert">{error}{draft && " 当前草稿已保留。"}</p>}
    {stale && <p className="notice" role="status">工作空间已有更新，当前草稿仍保留。保存可能需要处理版本冲突；可重新加载最新配置与已批准 Action。</p>}
    {record?.sourceChanged && <p className="notice" role="status">源规则文件已变化，请核对运营覆盖与原文后保存确认。</p>}
    {!record ? <div className="loading">{loading ? <><LoaderCircle className="spin" size={20} />正在读取 Prompt 与规则</> : "配置未加载，请点击重新加载。"}</div> : <>
      <div className="prompt-state-bar" role="status">
        <span className={dirty ? "prompt-dirty" : "prompt-saved"}>{dirty ? <span className="prompt-state-dot" /> : <Check size={14} />}{dirty ? "有未保存修改" : "与已保存版本一致"}</span>
        <span>版本 {record.version}{record.updatedAt ? ` · 保存于 ${new Date(record.updatedAt).toLocaleString("zh-CN")}` : " · 默认配置"}</span>
        {loading && <span><LoaderCircle size={13} className="spin" />正在刷新</span>}
      </div>
      <p className="prompt-scope-note">此处编辑的是 AI 业务规则与指令；菜库归属、价位槽位及本地程序校验仍由系统执行，文本编辑不会绕过校验。保存不会追溯改写旧菜单；已开始的生成使用原配置快照，恢复历史生成需匹配原版本。</p>
      <p className="prompt-access-note">请勿填入密钥等机密；此页沿用应用现有访问权限。</p>
      <div className="prompt-section-tabs" role="tablist" aria-label="Prompt 与规则分类">{sections.map((item, index) => <button
        key={item.id} id={`${pageId}-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id} aria-controls={`${pageId}-panel-${item.id}`}
        tabIndex={section === item.id ? 0 : -1} className={section === item.id ? "active" : ""}
        onClick={() => setSection(item.id)} onKeyDown={(event) => changeTab(event, index)}
      ><span>{item.number}</span>{item.name}{item.id === "rules" && <small>{rules.length}</small>}</button>)}</div>

      <section className="prompt-panel" id={`${pageId}-panel-action`} aria-labelledby={`${pageId}-tab-action`} role="tabpanel" hidden={section !== "action"}>
        <div className="prompt-panel-heading"><h2>从反馈生成 Action</h2><p>规定如何理解反馈、归纳问题与提出可执行的改善事项。</p></div>
        <label className="prompt-editor"><span>反馈 → Action 业务 Prompt</span><textarea aria-label="反馈 → Action 业务 Prompt" rows={14} spellCheck={false} disabled={locked} value={draft.actionGenerationText} onChange={(event) => updateText("actionGenerationText", event.target.value)} /></label>
        {preview("actionGeneration", "查看实际组合的 Action System Prompt")}
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-rules`} aria-labelledby={`${pageId}-tab-rules`} role="tabpanel" hidden={section !== "rules"}>
        <div className="prompt-panel-heading prompt-rules-heading"><div><h2>全部排菜规则</h2><p>共 {rules.length} 条，已启用 {rules.filter((rule) => rule.enabled !== false).length} 条。启用规则将列入排菜 System Prompt；禁用规则保留在清单中。</p></div><button onClick={addRule} disabled={locked || rules.length >= 300}><Plus size={16} />添加规则</button></div>
        <div className="filters prompt-rule-filters">
          <label className="search"><Search size={16} aria-hidden="true" /><input aria-label="搜索排菜规则" placeholder="搜索档口、规则或来源" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
          <select aria-label="按档口筛选规则" value={stallFilter} onChange={(event) => { setStallFilter(event.target.value); setPage(1); }}><option value="">所有适用档口</option>{[...new Set(rules.map((rule) => rule.stall))].filter(Boolean).sort().map((stall) => <option key={stall}>{stall}</option>)}</select>
          <select aria-label="按启用状态筛选规则" value={enabledFilter} onChange={(event) => { setEnabledFilter(event.target.value); setPage(1); }}><option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option></select>
        </div>
        <div className="table-scroll prompt-rules-table"><table><thead><tr><th>启用</th><th>适用档口</th><th>规则内容与来源</th><th>操作</th></tr></thead><tbody>{visibleRules.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((rule) => <tr key={rule.id} className={rule.enabled === false ? "prompt-rule-disabled" : ""}>
          <td><input type="checkbox" aria-label={`启用规则 ${rule.id}`} checked={rule.enabled !== false} disabled={locked} onChange={(event) => updateRule(rule.id, "enabled", event.target.checked)} /></td>
          <td><input aria-label={`规则档口 ${rule.id}`} list={`${pageId}-stalls`} value={rule.stall} disabled={locked} onChange={(event) => updateRule(rule.id, "stall", event.target.value)} /></td>
          <td><textarea aria-label={`规则内容 ${rule.id}`} rows={3} value={rule.text} disabled={locked} onChange={(event) => updateRule(rule.id, "text", event.target.value)} /><small>{rule.origin === "override" ? "运营调整 · " : rule.origin === "source" ? "来源原文 · " : ""}{sourceLabel(rule.source)}{rule.meal ? ` · ${rule.meal}` : ""}</small>{rule.origin === "override" && rule.originalText && <details className="prompt-rule-original"><summary>查看来源规则原文</summary><p>{rule.originalText}</p></details>}</td>
          <td><button className="icon-button prompt-remove-rule" aria-label={`删除规则 ${rule.id}`} title="删除规则，保存后生效" disabled={locked} onClick={() => setDraft((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Trash2 size={16} /></button></td>
        </tr>)}</tbody></table>{!visibleRules.length && <Empty text={rules.length ? "当前筛选条件下没有规则" : "暂无规则，可添加新的排菜要求"} />}</div>
        <Pagination page={currentPage} setPage={setPage} count={visibleRules.length} size={pageSize} />
        <p className="prompt-rules-footnote">筛选和翻页不会丢失修改；顶部「保存并生效」会保存全部规则与三项 Prompt。</p>
        {record.localConstraintsText && <details className="prompt-saved-preview"><summary>查看程序执行的固定校验 <span>只读</span></summary><p>以下约束由程序与菜库执行，不随上方业务规则文本修改。</p><pre aria-label="程序执行的固定校验">{record.localConstraintsText}</pre></details>}
        <datalist id={`${pageId}-stalls`}><option>全部档口</option>{stallOptions.filter((stall) => stall !== "全部档口").map((stall) => <option key={stall}>{stall}</option>)}</datalist>
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-menu`} aria-labelledby={`${pageId}-tab-menu`} role="tabpanel" hidden={section !== "menu"}>
        <div className="prompt-panel-heading"><h2>排菜时的 System Prompt</h2><p>这里只编辑排菜指令。规则与已批准 Action 由系统自动加入，可在下方查看组合后的完整内容。</p></div>
        <label className="prompt-editor"><span>排菜业务 Prompt</span><textarea aria-label="排菜业务 Prompt" rows={17} spellCheck={false} disabled={locked} value={draft.menuSystemText} onChange={(event) => updateText("menuSystemText", event.target.value)} /></label>
        <SavedPreview label="最终 Prompt 预览" text={record.previews?.menuSystem} dirty={dirty} version={record.version} parts={menuPreviewParts}
          description="这里汇总全部可参与排菜的 Action；实际调用会按当前档口筛选，并附带当次菜库、日期及历史菜单。" />
      </section>

      <section className="prompt-panel" id={`${pageId}-panel-approved`} aria-labelledby={`${pageId}-tab-approved`} role="tabpanel" hidden={section !== "approved"}>
        <div className="prompt-panel-heading"><h2>添加已批准 Action 的 Prompt</h2><p>定义已确定的改善事项如何参与排菜。仅符合条件的已批准、已启用排菜 Action 会作为当次要求注入。</p></div>
        <label className="prompt-editor"><span>已批准 Action 注入 Prompt</span><textarea aria-label="已批准 Action 注入 Prompt" rows={10} spellCheck={false} disabled={locked} value={draft.approvedActionText} onChange={(event) => updateText("approvedActionText", event.target.value)} /></label>
        {preview("approvedActions", "查看已批准 Action 的实际注入内容")}
        <div className="prompt-approved-heading"><h3>可注入排菜的已批准 Action</h3><span>{approvedActions.length} 项 · 只读</span></div>
        <p className="prompt-approved-note">以下为最近读取的已批准且符合排菜条件的事项；具体排菜要求与审批状态在「Action 事项」中维护，实际参与内容以上方注入预览为准。</p>
        {!approvedActions.length ? <Empty text="当前没有已批准的 Action" /> : <ul className="prompt-approved-list">{approvedActions.map((action, index) => <li key={action.id || index}>
          <div><h3>{action.title || "未命名改善事项"}</h3><span>{action.targetStall || "全部档口"}{action.enabled === false ? " · 已停用" : ""}</span></div>
          {action.description && <p>{action.description}</p>}
          <p className="prompt-approved-instruction"><strong>{action.menuInstruction ? "排菜要求" : "运营事项"}</strong>{action.menuInstruction || "服务与流程改善由运营跟进，不注入选菜要求。"}</p>
        </li>)}</ul>}
      </section>
    </>}
  </div>;
}
