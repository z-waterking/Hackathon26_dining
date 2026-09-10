import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, Table2 } from "lucide-react";
import { Empty, Pagination } from "./shared";
import { ConversionReport } from "./FeedbackWorkflow";
import { diningApi } from "./api/dining";
import { useI18n } from "./i18n";

export default function ConvertedFeedbackTable({ batch, feedback, onFollowUp, busy }) {
  const { t, tr } = useI18n();
  const [response, setResponse] = useState(null);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const current = response?.retry === retry && response?.feedback === feedback;
  const result = current ? response.result : null;
  const error = current ? response.error : "";
  useEffect(() => {
    let ignore = false;
    diningApi.imports.rows(batch.id).then((result) => { if (!ignore) setResponse({ result, retry, feedback, error: "" }); }).catch((failure) => { if (!ignore) setResponse({ result: null, retry, feedback, error: failure.message }); });
    return () => { ignore = true; };
  }, [batch.id, retry, feedback]);
  const rows = result?.rows || [];
  const selectedPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 12)));
  const feedbackById = new Map(feedback.map((item) => [item.id, item]));
  // Localize the table headers only, never the imported/recorded cell values.
  const cellText = (row, header) => String(row.targetRow?.[header] ?? "");
  return (
    <section className="converted-feedback" aria-label={t("转换后的新表", "Converted feedback table")}>
      <div className="section-heading"><h2><Table2 size={18} />{t("转换后的新表", "Converted feedback table")} <span>{result?.total ?? batch.report?.convertedRows ?? "—"}</span></h2><span className="source">{result?.source || batch.source}</span></div>
      <p className="muted small">{t("旧表已自动映射为新餐厅反馈记录表的 10 列。这里展示本次转换内容，反馈跟进与回复可从每行入口继续处理。", "The old table has been mapped to the 10-column feedback format. Review the converted records here and follow up or reply from each row.")}</p>
      <ConversionReport batch={batch} />
      {!current ? <p className="muted" role="status">{t("正在读取转换后的新表…", "Loading the converted table…")}</p> : error ? <div className="notice" role="alert">{tr(error)}<button onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />{t("重新读取", "Reload")}</button></div> : rows.length ? <>
        <p className="table-scroll-hint">{t("左右滚动可查看全部列；反馈正文完整保留。", "Scroll horizontally to view every column. Feedback text is preserved in full.")}</p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t("新表横向滚动区域", "Converted table horizontal scrolling area")}><table className="converted-table" aria-label={t("转换后的新餐厅反馈记录表", "Converted restaurant feedback records")}><thead><tr>{result.headers.map((header) => <th key={header} scope="col">{t(header)}</th>)}<th scope="col">{t("操作", "Actions")}</th></tr></thead><tbody>{rows.slice((selectedPage - 1) * 12, selectedPage * 12).map((row, index) => <tr key={row.feedbackId || `${selectedPage}-${index}`}>{result.headers.map((header) => <td key={header} className={["反馈内容", "反馈跟进", "回复记录", "备注"].includes(header) ? "converted-long-text" : ""}>{cellText(row, header) || <span className="muted">—</span>}</td>)}<td><button className="text-button" disabled={busy || !feedbackById.has(row.feedbackId)} onClick={() => onFollowUp(feedbackById.get(row.feedbackId))} aria-label={t(`跟进新表反馈 ${row.targetRow?.序号 || index + 1}`, `Follow up converted feedback ${row.targetRow?.序号 || index + 1}`)}>{t("跟进", "Follow up")}<ArrowUpRight size={14} /></button></td></tr>)}</tbody></table></div>
        <Pagination page={selectedPage} setPage={setPage} count={rows.length} />
      </> : <Empty text={t("本批次暂无可展示的转换记录，请查看转换报告中的待核验明细。", "No converted records are available for this batch. Check the conversion report for items requiring verification.")} />}
    </section>
  );
}
