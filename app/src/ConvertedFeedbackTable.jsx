import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, Table2 } from "lucide-react";
import { Empty, Pagination } from "./shared";
import { ConversionReport } from "./FeedbackWorkflow";
import { diningApi } from "./api/dining";

export default function ConvertedFeedbackTable({ batch, feedback, onFollowUp, busy }) {
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
  return (
    <section className="converted-feedback" aria-label="转换后的新表">
      <div className="section-heading"><h2><Table2 size={18} />转换后的新表 <span>{result?.total ?? batch.report?.convertedRows ?? "—"}</span></h2><span className="source">{result?.source || batch.source}</span></div>
      <p className="muted small">旧表已自动映射为新餐厅反馈记录表的 10 列。这里展示本次转换内容，反馈跟进与回复可从每行入口继续处理。</p>
      <ConversionReport batch={batch} />
      {!current ? <p className="muted" role="status">正在读取转换后的新表…</p> : error ? <div className="notice" role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新读取</button></div> : rows.length ? <>
        <p className="table-scroll-hint">左右滚动可查看全部列；反馈正文完整保留。</p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="新表横向滚动区域"><table className="converted-table" aria-label="转换后的新餐厅反馈记录表"><thead><tr>{result.headers.map((header) => <th key={header} scope="col">{header}</th>)}<th scope="col">操作</th></tr></thead><tbody>{rows.slice((selectedPage - 1) * 12, selectedPage * 12).map((row, index) => <tr key={row.feedbackId || `${selectedPage}-${index}`}>{result.headers.map((header) => <td key={header} className={["反馈内容", "反馈跟进", "回复记录", "备注"].includes(header) ? "converted-long-text" : ""}>{String(row.targetRow?.[header] ?? "") || <span className="muted">—</span>}</td>)}<td><button className="text-button" disabled={busy || !feedbackById.has(row.feedbackId)} onClick={() => onFollowUp(feedbackById.get(row.feedbackId))} aria-label={`跟进新表反馈 ${row.targetRow?.序号 || index + 1}`}>跟进<ArrowUpRight size={14} /></button></td></tr>)}</tbody></table></div>
        <Pagination page={selectedPage} setPage={setPage} count={rows.length} />
      </> : <Empty text="本批次暂无可展示的转换记录，请查看转换报告中的待核验明细。" />}
    </section>
  );
}
