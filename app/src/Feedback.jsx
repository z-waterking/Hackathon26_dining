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
import "./feedback-dashboard.css";

export default function Feedback({ data, run, busy, onNavigate }) {
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
      return `原始文件转换完成，新增 ${result.inserted} 条，重复 ${result.skipped} 条`;
    });
  };
  return (
    <div className="feedback-dashboard">
      <div className="page-heading">
        <div>
          <span className="eyebrow">FEEDBACK / INTELLIGENCE</span>
          <h1>反馈中心</h1>
          <p>从反馈中看见趋势，让每一次改善都有依据。</p>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={() => { setImportError(""); setImportOpen(true); }}><FileInput size={17} />导入原始文件并转换</button>
          <button className="primary" onClick={() => setCreate(true)}>
            <Plus size={17} />
            录入反馈
          </button>
        </div>
      </div>
      <FeedbackOverview records={individual} month={month} onNavigate={onNavigate} onStatus={showLedger}
        insights={insightsCurrent ? insights.result : null} insightsLoading={!insightsCurrent}
        insightsError={insightsCurrent ? insights.error : ""} onRetryInsights={() => setInsightsRetry((value) => value + 1)}
        toolbar={<div className="fd-dashboard-toolbar"><div><h2>反馈洞察</h2><p>仅统计真实单条反馈 · 不含示例、月汇总与隔离记录</p></div><div className="actions"><label className="fd-period-filter">统计月份<input type="month" aria-label="反馈月份" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1); }} /></label>{month ? <button className="text-button" onClick={() => { setMonth(""); setPage(1); }}>全部月份</button> : <Badge>全部月份</Badge>}<button onClick={() => setSummary(true)}><FileText size={15} />月度汇总</button></div></div>} />
      <section className="work-section fd-ledger" ref={ledgerReference} aria-label="反馈台账">
        <div className="section-heading">
          <h2>
            反馈台账 <span>{items.length}</span>{demo && <Badge tone="gold">示例反馈</Badge>}
          </h2>
          <div className="actions">
            <label className={`button file-button ${busy ? "disabled" : ""}`}>
              <FileInput size={16} />
              上传旧表 Excel
              <input ref={uploadReference} type="file" accept=".xlsx" aria-label="上传旧表 Excel" disabled={busy} onChange={importOriginal} />
            </label>
            <ImportButton
              disabled={busy}
              onFile={(file) =>
                run(async () => {
                  const result = await diningApi.feedback.importCsv(await file.text());
                  return `导入 ${result.inserted} 条，跳过 ${result.skipped} 条`;
                })
              }
            />
            <ExportButton
              onClick={() => downloadCsv("反馈台账.csv", exportRows(items))}
            />
          </div>
        </div>
        <p className="upload-guidance">上传旧表自动转换、入库；在台账中查看原文、回复与处理进度。</p>
        {conversion && (
          <div className="notice import-result" role="status">
            <strong>已按新餐厅反馈记录表格式转换</strong>
            <span>{conversion.source} · 新增 {conversion.inserted} 条 · 匹配 {conversion.merged || 0} 条 · 重复 {conversion.skipped} 条</span>
            <details><summary>转换报告与下载</summary><ConversionReport batch={conversion} /></details>
          </div>
        )}
        {!!data.imports?.length && <details className="import-history"><summary>最近转换批次 · {data.imports.length}</summary>{data.imports.slice(0, 5).map((batch) => <details key={batch.id}><summary>{batch.source} · {new Date(batch.at).toLocaleString("zh-CN")} · 新增 {batch.inserted} 条 / 重复 {batch.skipped} 条</summary><button onClick={() => setBatchChoice(batch)}>查看新表</button><ConversionReport batch={batch} /></details>)}</details>}
        {displayedBatch && <><div className="converted-controls"><button className="text-button" onClick={() => setBatchChoice("hidden")}>收起新表</button></div><ConvertedFeedbackTable key={displayedBatch.id} batch={displayedBatch} feedback={data.feedback} onFollowUp={setSelected} busy={busy} /></>}
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="搜索反馈"
              placeholder="搜索内容、餐厅、负责人"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <select
            aria-label="处理状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {["未处理", "跟进中", "已完成"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            aria-label="反馈类型"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部类型</option>
            {["建议", "投诉", "表扬", "询问"].map((value) => (
              <option key={value} value={value}>{value === "投诉" ? "批评 / 投诉" : value}</option>
            ))}
          </select>
          <label className="check"><input type="checkbox" aria-label="示例反馈" checked={demo} onChange={(event) => { setDemo(event.target.checked); setPage(1); }} />示例反馈</label>
          <label className="check">
            <input
              type="checkbox"
              checked={showSummaries}
              onChange={(event) => {
                setShowSummaries(event.target.checked);
                setPage(1);
              }}
            />
            月汇总记录
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>反馈 / 来源</th>
                <th>餐厅</th>
                <th>反馈内容</th>
                <th>类型</th>
                <th>当前状态</th>
                <th>负责人</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items
                .slice((currentPage - 1) * 12, currentPage * 12)
                .map((item) => (
                  <tr key={item.id}>
                    <td className="nowrap">
                      <strong>{item.date || "日期待核验"}</strong>
                      <small>
                        {item.channel} · {item.originalId || "未编号"}
                      </small>
                    </td>
                    <td className="restaurant-cell">{item.restaurant}</td>
                    <td className="content-cell">
                      <div className="clamp">{item.content}</div>
                      {item.demo && <Badge tone="gold">示例</Badge>}
                      {item.duplicatePossible && (
                        <small className="warning-text">
                          疑似跨表重复 · 待核验
                        </small>
                      )}
                    </td>
                    <td>
                      <Badge>{item.type}</Badge>
                    </td>
                    <td>
                      <Badge>{item.status}</Badge>
                    </td>
                    <td>
                      {item.owner || <span className="muted">未分配</span>}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(item)}
                      >
                        跟进
                        <ArrowUpRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty text="当前筛选下暂无反馈" />}
        <Pagination page={currentPage} setPage={setPage} count={items.length} />
      </section>
      {importOpen && <Modal title="导入原始文件并转换" onClose={() => { if (!busy) setImportOpen(false); }}>
        <p>选择 Forms 导出的原始餐饮反馈 Excel，系统会自动转换为新餐厅反馈记录表，保存到本地并展示转换结果。</p>
        <div className="notice">仅需上传旧表，无需上传目标模板。支持 .xlsx，最大 10 MB；重复导入不会覆盖已有回复和处理记录。</div>
        <p className="muted small">目标格式包含：反馈来源、序号、餐厅、日期、反馈内容、反馈跟进、反馈类别、问题分类、回复记录、备注。</p>
        {importError && <p role="alert" className="notice import-error">{importError}</p>}
        <label className={`button primary file-button ${busy ? "disabled" : ""}`}><FileInput size={17} />{busy ? "正在上传并转换…" : "选择原始 Excel 并转换"}<input type="file" accept=".xlsx" aria-label="选择原始 Excel 并转换" disabled={busy} onChange={importOriginal} /></label>
      </Modal>}
      {create && (
        <Modal title="录入反馈" onClose={() => setCreate(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              run(async () => {
                const result = await diningApi.feedback.create(input);
                setCreate(false);
                return result.merged ? "已追加到现有线程" : "反馈已入库";
              });
            }}
          >
            <div className="form-grid">
              <Field label="餐厅 / 档口">
                <input
                  name="restaurant"
                  required
                  list="stall-list"
                  placeholder="选择或输入餐厅"
                />
              </Field>
              <Field label="反馈日期">
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={new Date().toLocaleDateString("en-CA")}
                />
              </Field>
              <Field label="渠道">
                <select name="channel">
                  {["手工", "口头", "微信群", "二维码", "邮件"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="反馈类型">
                <select name="type">
                  {["建议", "投诉", "表扬", "询问"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="问题分类">
                <select name="category">
                  {["口味", "种类", "服务", "卫生", "份量", "价格", "其他"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="负责人">
                <input name="owner" placeholder="待分配" />
              </Field>
            </div>
            <Field label="反馈内容">
              <textarea
                name="content"
                required
                minLength={2}
                maxLength={10000}
                rows={5}
              />
            </Field>
            <Field label="线程标识（可选）">
              <input name="threadId" placeholder="邮件 conversationId" />
            </Field>
            <footer className="form-footer">
              <button type="button" onClick={() => setCreate(false)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存反馈
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal title="反馈跟进" onClose={() => setSelected(null)} wide>
          <div className="detail-meta">
            <Badge>{currentFeedback.type}</Badge>
            <Badge>{currentFeedback.status}</Badge>
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
          <h3>处理记录</h3>
          {!currentFeedback.events.length && <p className="muted">暂无处理记录</p>}
          <div className="timeline">
            {currentFeedback.events.map((event, index) => (
              <div key={index}>
                <small>
                  {event.at
                    ? new Date(event.at).toLocaleString("zh-CN")
                    : "历史记录 · 时间待核验"}{" "}
                  · {event.kind}
                </small>
                <p>{event.text}</p>
              </div>
            ))}
          </div>
          <details>
            <summary>来源证据（{selected.sources.length}）</summary>
            {selected.sources.map((source, index) => (
              <p key={index} className="source">
                {source.file} / {source.sheet} / 行{source.row}
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
                return "进度与跟进记录已保存";
              });
            }}
          >
            <div className="form-grid">
              <Field label="处理状态">
                <select name="status" defaultValue={selected.status}>
                  {["未处理", "跟进中", "已完成"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="负责人">
                <input name="owner" defaultValue={selected.owner} />
              </Field>
            </div>
            <Field label="本次处理说明">
              <textarea name="note" required minLength={2} rows={3} />
            </Field>
            <footer className="form-footer">
              <button className="primary" disabled={busy}>
                保存跟进
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {summary && (
        <Modal
          title={`${month || "全部月份"} 反馈汇总`}
          onClose={() => setSummary(false)}
          wide
        >
          <Field label="月报月份"><input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1); }} /></Field>
          <div className="summary-stats">
            <strong>{individual.length}</strong>
            <span>
              单条来源记录 · 另有{" "}
              {monthly.filter((item) => item.summaryRecord).length} 条月汇总
            </span>
          </div>
          <p className="notice">
            本地规则汇总 · 当前处理状态快照 ·{" "}
            {individual.filter((item) => item.duplicatePossible).length}{" "}
            条疑似重复待核验
          </p>
          <MonthlyInsights month={month} feedback={data.feedback} aiStatus={data.aiStatus} run={run} busy={busy} />
          <h3>问题分类</h3>
          {categories.map(([category, count]) => (
            <div className="bar-row" key={category}>
              <span>{category}</span>
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
          <h3>未完成投诉</h3>
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
