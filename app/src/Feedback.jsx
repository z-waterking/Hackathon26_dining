import { useDeferredValue, useEffect, useRef, useState } from "react";
import {
  Plus,
  Search,
  FileText,
  ArrowUpRight,
  FileInput,
} from "lucide-react";
import {
  Badge,
  Empty,
  ExportButton,
  Field,
  ImportButton,
  Modal,
  Pagination,
} from "./shared";
import { downloadCsv } from "./api";
import { diningApi } from "./api/dining";
import { ConversionReport, FeedbackResponse, MonthlyInsights } from "./FeedbackWorkflow";
import ConvertedFeedbackTable from "./ConvertedFeedbackTable";
import FeedbackOverview from "./FeedbackOverview";
import { useI18n, I18nVisibility } from "./i18n";
import "./feedback-dashboard.css";

export default function Feedback({ data, run, busy, onNavigate }) {
  const { t, tr, locale } = useI18n();
  const [month, setMonth] = useState("");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [create, setCreate] = useState(false);
  const [summary, setSummary] = useState(false);
  const [showSummaries, setShowSummaries] = useState(false);
  const [conversion, setConversion] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const [batchChoice, setBatchChoice] = useState(null);
  const [demo, setDemo] = useState(false);
  const [insights, setInsights] = useState(null);
  const [insightsRetry, setInsightsRetry] = useState(0);
  const uploadReference = useRef(null);
  const ledgerReference = useRef(null);
  const insightsCurrent = insights?.month === month && insights?.feedback === data.feedback && insights?.retry === insightsRetry;
  useEffect(() => {
    let ignore = false;
    diningApi.feedback.insights(month).then((result) => {
      if (!ignore) setInsights({ month, feedback: data.feedback, retry: insightsRetry, result });
    }).catch((error) => {
      if (!ignore) setInsights({ month, feedback: data.feedback, retry: insightsRetry, error: error.message });
    });
    return () => { ignore = true; };
  }, [month, data.feedback, insightsRetry]);
  const latestUpload = (data.imports || []).find((batch) => batch.uploaded);
  const displayedBatch = batchChoice === "hidden" ? null : batchChoice || latestUpload;
  const currentFeedback = selected && (data.feedback.find((item) => item.id === selected.id) || selected);
  const monthly = data.feedback.filter(
    (item) => !item.demo && !item.quarantined && (!month || item.date?.startsWith(month)),
  );
  const individual = monthly.filter((item) => !item.summaryRecord);
  const listRecords = data.feedback.filter((item) => !item.quarantined && !!item.demo === demo && (!month || item.date?.startsWith(month)));
  const items = listRecords
    .filter(
      (item) =>
        Boolean(item.summaryRecord) === showSummaries &&
        (!status || item.status === status) &&
        (!type || (type === "投诉" ? ["投诉", "批评"].includes(item.type) : item.type === type)) &&
        `${item.content} ${item.restaurant} ${item.owner} ${item.id}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((left, right) => (right.date || "").localeCompare(left.date || ""));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 12)));
  const categories = Object.entries(
    individual.reduce(
      (result, item) => ({
        ...result,
        [item.category]: (result[item.category] || 0) + 1,
      }),
      {},
    ),
  ).sort((left, right) => right[1] - left[1]);
  const exportRows = (rows) =>
    rows.map((item) => ({
      编号: item.id,
      日期: item.date,
      餐厅: item.restaurant,
      渠道: item.channel,
      类型: item.type,
      分类: item.category,
      内容: item.content,
      状态: item.status,
      负责人: item.owner,
      疑似重复: item.duplicatePossible ? "待核验" : "",
      跟进: item.events.map((event) => event.text).join("\n"),
    }));
  const showLedger = (value) => {
    setStatus(value); setDemo(false); setQuery(""); setType(""); setShowSummaries(false); setPage(1);
    ledgerReference.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const importOriginal = (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    setImportError("");
    run(async () => {
      let result;
      try { result = await diningApi.feedback.importOriginal(file); }
      catch (error) { setImportError(error.message); throw error; }
      setConversion(result); setBatchChoice(result); setImportOpen(false);
      setMonth(""); setQuery(""); setType(""); setStatus(""); setShowSummaries(false); setPage(1); setDemo(false);
      ledgerReference.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return t(`原始文件转换完成，新增 ${result.inserted} 条，重复 ${result.skipped} 条`, `Original file converted: ${result.inserted} added, ${result.skipped} duplicates`);
    });
  };
  return (
    <div className="feedback-dashboard">
      <div className="page-heading">
        <div>
          <span className="eyebrow">FEEDBACK / INTELLIGENCE</span>
          <h1>{t("反馈中心", "Feedback")}</h1>
          <p>{t("从反馈中看见趋势，让每一次改善都有依据。", "Spot feedback trends and ground every improvement in evidence.")}</p>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={() => { setImportError(""); setImportOpen(true); }}><FileInput size={17} />{t("导入原始文件并转换", "Import and convert original file")}</button>
          <button className="primary" onClick={() => setCreate(true)}>
            <Plus size={17} />
            {t("录入反馈", "Add feedback")}
          </button>
        </div>
      </div>
      <FeedbackOverview records={individual} month={month} onNavigate={onNavigate} onStatus={showLedger}
        insights={insightsCurrent ? insights.result : null} insightsLoading={!insightsCurrent}
        insightsError={insightsCurrent ? insights.error : ""} onRetryInsights={() => setInsightsRetry((value) => value + 1)}
        toolbar={<div className="fd-dashboard-toolbar"><div><h2>{t("反馈洞察", "Feedback insights")}</h2><p>{t("仅统计真实单条反馈 · 不含示例、月汇总与隔离记录", "Real individual feedback only · Excludes demos, monthly summaries and quarantined records")}</p></div><div className="actions"><label className="fd-period-filter">{t("统计月份", "Month")}<input type="month" aria-label={t("反馈月份", "Feedback month")} value={month} onChange={(event) => { setMonth(event.target.value); setPage(1); }} /></label>{month ? <button className="text-button" onClick={() => { setMonth(""); setPage(1); }}>{t("全部月份", "All months")}</button> : <Badge>{t("全部月份", "All months")}</Badge>}<button onClick={() => setSummary(true)}><FileText size={15} />{t("月度汇总", "Monthly summary")}</button></div></div>} />
      <section className="work-section fd-ledger" ref={ledgerReference} aria-label={t("反馈台账", "Feedback records")}>
        <div className="section-heading">
          <h2>
            {t("反馈台账", "Feedback records")} <span>{items.length}</span>{demo && <Badge tone="gold">{t("示例反馈", "Demo feedback")}</Badge>}
          </h2>
          <div className="actions">
            <label className={`button file-button ${busy ? "disabled" : ""}`}>
              <FileInput size={16} />
              {t("上传旧表 Excel", "Upload legacy Excel")}
              <input ref={uploadReference} type="file" accept=".xlsx" aria-label={t("上传旧表 Excel", "Upload legacy Excel")} disabled={busy} onChange={importOriginal} />
            </label>
            <ImportButton
              disabled={busy}
              onFile={(file) =>
                run(async () => {
                  const result = await diningApi.feedback.importCsv(await file.text());
                  return t(`导入 ${result.inserted} 条，跳过 ${result.skipped} 条`, `Imported ${result.inserted} records; skipped ${result.skipped}`);
                })
              }
            />
            <ExportButton
              onClick={() => downloadCsv("反馈台账.csv", exportRows(items))}
            />
          </div>
        </div>
        <p className="upload-guidance">{t("上传旧表自动转换、入库；在台账中查看原文、回复与处理进度。", "Upload a legacy table to convert and save it. Review original feedback, replies and progress in the records below.")}</p>
        {conversion && (
          <div className="notice import-result" role="status">
            <strong>{t("已按新餐厅反馈记录表格式转换", "Converted to the restaurant feedback record format")}</strong>
            <span>{conversion.source} · {t(`新增 ${conversion.inserted} 条 · 匹配 ${conversion.merged || 0} 条 · 重复 ${conversion.skipped} 条`, `Added ${conversion.inserted} · Matched ${conversion.merged || 0} · Duplicates ${conversion.skipped}`)}</span>
            <ReportDetails label={t("转换报告与下载", "Conversion report and downloads")} batch={conversion} />
          </div>
        )}
        {!!data.imports?.length && <details className="import-history"><summary>{t("最近转换批次", "Recent conversion batches")} · {data.imports.length}</summary>{data.imports.slice(0, 5).map((batch) => <ReportDetails key={batch.id} label={<>{batch.source} · {new Date(batch.at).toLocaleString(locale)} · {t(`新增 ${batch.inserted} 条 / 重复 ${batch.skipped} 条`, `Added ${batch.inserted} / Duplicates ${batch.skipped}`)}</>} batch={batch}><button onClick={() => setBatchChoice(batch)}>{t("查看新表", "View converted table")}</button></ReportDetails>)}</details>}
        {displayedBatch && <><div className="converted-controls"><button className="text-button" onClick={() => setBatchChoice("hidden")}>{t("收起新表", "Hide converted table")}</button></div><ConvertedFeedbackTable key={displayedBatch.id} batch={displayedBatch} feedback={data.feedback} onFollowUp={setSelected} busy={busy} /></>}
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label={t("搜索反馈", "Search feedback")}
              placeholder={t("搜索内容、餐厅、负责人", "Search content, restaurant or owner")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <select
            aria-label={t("处理状态", "Handling status")}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("全部状态", "All statuses")}</option>
            {["未处理", "跟进中", "已完成"].map((value) => (
              <option key={value} value={value}>{t(value)}</option>
            ))}
          </select>
          <select
            aria-label={t("反馈类型", "Feedback type")}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("全部类型", "All types")}</option>
            {["建议", "投诉", "表扬", "询问"].map((value) => (
              <option key={value} value={value}>{value === "投诉" ? t("批评 / 投诉", "Criticism / Complaint") : t(value)}</option>
            ))}
          </select>
          <label className="check"><input type="checkbox" aria-label={t("示例反馈", "Demo feedback")} checked={demo} onChange={(event) => { setDemo(event.target.checked); setPage(1); }} />{t("示例反馈", "Demo feedback")}</label>
          <label className="check">
            <input
              type="checkbox"
              checked={showSummaries}
              onChange={(event) => {
                setShowSummaries(event.target.checked);
                setPage(1);
              }}
            />
            {t("月汇总记录", "Monthly summary records")}
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("反馈 / 来源", "Feedback / Source")}</th>
                <th>{t("餐厅", "Restaurant")}</th>
                <th>{t("反馈内容", "Feedback content")}</th>
                <th>{t("类型", "Type")}</th>
                <th>{t("当前状态", "Current status")}</th>
                <th>{t("负责人", "Owner")}</th>
                <th>{t("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items
                .slice((currentPage - 1) * 12, currentPage * 12)
                .map((item) => (
                  <tr key={item.id}>
                    <td className="nowrap">
                      <strong>{item.date || t("日期待核验", "Date unverified")}</strong>
                      <small>
                        {tr(item.channel)} · {item.originalId || t("未编号", "No number")}
                      </small>
                    </td>
                    <td className="restaurant-cell">{item.restaurant}</td>
                    <td className="content-cell">
                      <div className="clamp">{item.content}</div>
                      {item.demo && <Badge tone="gold">{t("示例", "Demo")}</Badge>}
                      {item.duplicatePossible && (
                        <small className="warning-text">
                          {t("疑似跨表重复 · 待核验", "Possible cross-table duplicate · Needs verification")}
                        </small>
                      )}
                    </td>
                    <td>
                      <Badge>{item.type}</Badge>
                    </td>
                    <td>
                      <Badge>{t(item.status)}</Badge>
                    </td>
                    <td>
                      {item.owner || <span className="muted">{t("未分配", "Unassigned")}</span>}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(item)}
                      >
                        {t("跟进", "Follow up")}
                        <ArrowUpRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty text={t("当前筛选下暂无反馈", "No feedback matches the current filters")} />}
        <Pagination page={currentPage} setPage={setPage} count={items.length} />
      </section>
      {importOpen && <Modal title={t("导入原始文件并转换", "Import and convert original file")} onClose={() => setImportOpen(false)} busy={busy}>
        <p>{t("选择 Forms 导出的原始餐饮反馈 Excel，系统会自动转换为新餐厅反馈记录表，保存到本地并展示转换结果。", "Choose the original dining feedback Excel exported from Forms. It will be converted to the new feedback format, saved locally and displayed here.")}</p>
        <div className="notice">{t("仅需上传旧表，无需上传目标模板。支持 .xlsx，最大 10 MB；重复导入不会覆盖已有回复和处理记录。", "Upload only the legacy table; no target template is needed. Supports .xlsx up to 10 MB. Reimporting preserves existing replies and handling records.")}</div>
        <p className="muted small">{t("目标格式包含：反馈来源、序号、餐厅、日期、反馈内容、反馈跟进、反馈类别、问题分类、回复记录、备注。", "Columns: source, number, restaurant, date, feedback content, follow-up, feedback type, issue category, replies and notes.")}</p>
        {importError && <p role="alert" className="notice import-error">{tr(importError)}</p>}
        <label className={`button primary file-button ${busy ? "disabled" : ""}`}><FileInput size={17} />{busy ? t("正在上传并转换…", "Uploading and converting…") : t("选择原始 Excel 并转换", "Choose original Excel and convert")}<input type="file" accept=".xlsx" aria-label={t("选择原始 Excel 并转换", "Choose original Excel and convert")} disabled={busy} onChange={importOriginal} /></label>
      </Modal>}
      {create && (
        <Modal title={t("录入反馈", "Add feedback")} onClose={() => setCreate(false)} busy={busy}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              run(async () => {
                const result = await diningApi.feedback.create(input);
                setCreate(false);
                return result.merged ? t("已追加到现有线程", "Added to the existing thread") : t("反馈已入库", "Feedback saved");
              });
            }}
          >
            <div className="form-grid">
              <Field label={t("餐厅 / 档口", "Restaurant / Stall")}>
                <input
                  name="restaurant"
                  required
                  list="stall-list"
                  placeholder={t("选择或输入餐厅", "Choose or enter a restaurant")}
                />
              </Field>
              <Field label={t("反馈日期", "Feedback date")}>
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={new Date().toLocaleDateString("en-CA")}
                />
              </Field>
              <Field label={t("渠道", "Channel")}>
                <select name="channel">
                  {["手工", "口头", "微信群", "二维码", "邮件"].map((value) => (
                    <option key={value} value={value}>{t(value)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("反馈类型", "Feedback type")}>
                <select name="type">
                  {["建议", "投诉", "表扬", "询问"].map((value) => (
                    <option key={value} value={value}>{t(value)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("问题分类", "Issue category")}>
                <select name="category">
                  {["口味", "种类", "服务", "卫生", "份量", "价格", "其他"].map(
                    (value) => (
                      <option key={value} value={value}>{t(value)}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label={t("负责人", "Owner")}>
                <input name="owner" placeholder={t("待分配", "Unassigned")} />
              </Field>
            </div>
            <Field label={t("反馈内容", "Feedback content")}>
              <textarea
                name="content"
                required
                minLength={2}
                maxLength={10000}
                rows={5}
              />
            </Field>
            <Field label={t("线程标识（可选）", "Thread ID (optional)")}>
              <input name="threadId" placeholder={t("邮件 conversationId", "Email conversationId")} />
            </Field>
            <footer className="form-footer">
              <button type="button" onClick={() => setCreate(false)}>
                {t("取消", "Cancel")}
              </button>
              <button className="primary" disabled={busy}>
                {t("保存反馈", "Save feedback")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal title={t("反馈跟进", "Feedback follow-up")} onClose={() => setSelected(null)} busy={busy} wide>
          <div className="detail-meta">
            <Badge>{currentFeedback.type}</Badge>
            <Badge>{t(currentFeedback.status)}</Badge>
            <span>
              {selected.restaurant} · {selected.date}
            </span>
          </div>
          <p className="feedback-full">{selected.content}</p>
          <FeedbackResponse
            key={selected.id}
            feedback={currentFeedback}
            actions={(data.actions || []).filter((action) => action.feedbackIds?.includes(selected.id))}
            aiStatus={data.aiStatus}
            run={run}
            busy={busy}
            onNavigate={onNavigate}
          />
          <h3>{t("处理记录", "Handling history")}</h3>
          {!currentFeedback.events.length && <p className="muted">{t("暂无处理记录", "No handling history yet")}</p>}
          <div className="timeline">
            {currentFeedback.events.map((event, index) => (
              <div key={index}>
                <small>
                  {event.at
                    ? new Date(event.at).toLocaleString(locale)
                    : t("历史记录 · 时间待核验", "Historical record · Time unverified")}{" "}
                  · {tr(event.kind)}
                </small>
                <p>{event.kind === "线程补充" ? event.text : tr(event.text)}</p>
              </div>
            ))}
          </div>
          <details>
            <summary>{t(`来源证据（${selected.sources.length}）`, `Source evidence (${selected.sources.length})`)}</summary>
            {selected.sources.map((source, index) => (
              <p key={index} className="source">
                {source.file} / {source.sheet} / {t("行", "Row")}{source.row}
              </p>
            ))}
          </details>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              run(async () => {
                await diningApi.feedback.update(selected.id, input);
                setSelected(null);
                return t("进度与跟进记录已保存", "Progress and follow-up saved");
              });
            }}
          >
            <div className="form-grid">
              <Field label={t("处理状态", "Handling status")}>
                <select name="status" defaultValue={selected.status}>
                  {["未处理", "跟进中", "已完成"].map((value) => (
                    <option key={value} value={value}>{t(value)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("负责人", "Owner")}>
                <input name="owner" defaultValue={selected.owner} />
              </Field>
            </div>
            <Field label={t("本次处理说明", "Follow-up note")}>
              <textarea name="note" required minLength={2} rows={3} />
            </Field>
            <footer className="form-footer">
              <button className="primary" disabled={busy}>
                {t("保存跟进", "Save follow-up")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {summary && (
        <Modal
          title={t(`${month || "全部月份"} 反馈汇总`, `${month || "All months"} feedback summary`)}
          onClose={() => setSummary(false)}
          wide
        >
          <Field label={t("月报月份", "Report month")}><input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1); }} /></Field>
          <div className="summary-stats">
            <strong>{individual.length}</strong>
            <span>
              {t(`单条来源记录 · 另有 ${monthly.filter((item) => item.summaryRecord).length} 条月汇总`, `individual source records · Plus ${monthly.filter((item) => item.summaryRecord).length} monthly summaries`)}
            </span>
          </div>
          <p className="notice">
            {t(`本地规则汇总 · 当前处理状态快照 · ${individual.filter((item) => item.duplicatePossible).length} 条疑似重复待核验`, `Local summary · Current status snapshot · ${individual.filter((item) => item.duplicatePossible).length} possible duplicates to verify`)}
          </p>
          <MonthlyInsights month={month} feedback={data.feedback} aiStatus={data.aiStatus} run={run} busy={busy} />
          <h3>{t("问题分类", "Issue categories")}</h3>
          {categories.map(([category, count]) => (
            <div className="bar-row" key={category}>
              <span>{tr(category)}</span>
              <div>
                <i
                  style={{
                    width: `${(count / Math.max(1, individual.length)) * 100}%`,
                  }}
                />
              </div>
              <strong>{count}</strong>
            </div>
          ))}
          <h3>{t("未完成投诉", "Unresolved complaints")}</h3>
          {individual
            .filter((item) => item.type === "投诉" && item.status !== "已完成")
            .slice(0, 8)
            .map((item) => (
              <p className="summary-item" key={item.id}>
                {item.date} · {item.restaurant}
                <br />
                {item.content}
              </p>
            ))}
          <footer className="form-footer">
            <ExportButton
              onClick={() =>
                downloadCsv(`反馈汇总-${month}.csv`, exportRows(monthly))
              }
            />
          </footer>
        </Modal>
      )}
    </div>
  );
}

function ReportDetails({ label, batch, children }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{label}</summary>{children}<I18nVisibility active={open}><ConversionReport batch={batch} /></I18nVisibility></details>;
}
