import { useDeferredValue, useState } from "react";
import {
  Plus,
  Search,
  MessageSquare,
  Clock3,
  CheckCircle2,
  AlertCircle,
  FileText,
  ArrowUpRight,
} from "lucide-react";
import {
  Badge,
  Empty,
  ExportButton,
  Field,
  ImportButton,
  Metric,
  Modal,
  Pagination,
} from "./shared";
import { downloadCsv, request } from "./api";

export default function Feedback({ data, run, busy }) {
  const [month, setMonth] = useState("2026-08");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [create, setCreate] = useState(false);
  const [summary, setSummary] = useState(false);
  const [showSummaries, setShowSummaries] = useState(false);
  const monthly = data.feedback.filter(
    (item) => !month || item.date.startsWith(month),
  );
  const individual = monthly.filter((item) => !item.summaryRecord);
  const items = monthly
    .filter(
      (item) =>
        item.summaryRecord === showSummaries &&
        (!status || item.status === status) &&
        (!type || item.type === type) &&
        `${item.content} ${item.restaurant} ${item.owner} ${item.id}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((left, right) => right.date.localeCompare(left.date));
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
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SERVICE / 01</span>
          <h1>反馈中心</h1>
          <p>听见每一份反馈，跟进每一次改善。</p>
        </div>
        <div className="actions">
          <button onClick={() => setSummary(true)}>
            <FileText size={16} />
            月度汇总
          </button>
          <button className="primary" onClick={() => setCreate(true)}>
            <Plus size={17} />
            录入反馈
          </button>
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="本月反馈记录"
          value={individual.length}
          detail={`${month || "全部月份"} · 含待核验重复项`}
          icon={MessageSquare}
          color="blue"
        />
        <Metric
          label="未处理"
          value={individual.filter((item) => item.status === "未处理").length}
          detail="等待首次跟进"
          icon={AlertCircle}
          color="red"
        />
        <Metric
          label="跟进中"
          value={individual.filter((item) => item.status === "跟进中").length}
          detail="历史跟进状态待核验"
          icon={Clock3}
          color="gold"
        />
        <Metric
          label="已完成"
          value={individual.filter((item) => item.status === "已完成").length}
          detail="按当前状态统计"
          icon={CheckCircle2}
        />
      </div>
      <section className="work-section">
        <div className="section-heading">
          <h2>
            反馈台账 <span>{items.length}</span>
          </h2>
          <div className="actions">
            <ImportButton
              disabled={busy}
              onFile={(file) =>
                run(async () => {
                  const result = await request("/feedback/import", {
                    csv: await file.text(),
                  });
                  return `导入 ${result.inserted} 条，跳过 ${result.skipped} 条`;
                })
              }
            />
            <ExportButton
              onClick={() => downloadCsv("反馈台账.csv", exportRows(items))}
            />
          </div>
        </div>
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
          <input
            type="month"
            aria-label="反馈月份"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              setPage(1);
            }}
          />
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
              <option key={value}>{value}</option>
            ))}
          </select>
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
      {create && (
        <Modal title="录入反馈" onClose={() => setCreate(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              run(async () => {
                const result = await request("/feedback", input);
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
        <Modal title="反馈跟进" onClose={() => setSelected(null)}>
          <div className="detail-meta">
            <Badge>{selected.type}</Badge>
            <Badge>{selected.status}</Badge>
            <span>
              {selected.restaurant} · {selected.date}
            </span>
          </div>
          <p className="feedback-full">{selected.content}</p>
          <h3>处理记录</h3>
          {!selected.events.length && <p className="muted">暂无处理记录</p>}
          <div className="timeline">
            {selected.events.map((event, index) => (
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
                await request(`/feedback/${selected.id}`, input, "PATCH");
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
        >
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
    </>
  );
}
