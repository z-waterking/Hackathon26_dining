import { useEffect, useState } from "react";
import {
  Banknote,
  CreditCard,
  TrendingUp,
  Link2,
  FileDown,
  FlaskConical,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import { Badge, Empty, ExportButton, ImportButton, Metric } from "./shared";
import { downloadCsv, money } from "./api";
import { diningApi } from "./api/dining";

export default function Analytics({ data, run, busy }) {
  const [demo, setDemo] = useState(false);
  const [start, setStart] = useState("2026-08-01");
  const [end, setEnd] = useState("2026-08-31");
  const [period, setPeriod] = useState("月");
  const [stall, setStall] = useState("");
  const [unit, setUnit] = useState("份");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const queryKey = JSON.stringify([demo, start, end, stall, revision]);
  const report = result?.key === queryKey ? result.data : null;
  useEffect(() => {
    let ignore = false;
    const params = {
      demo: String(demo),
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(stall ? { stall } : {}),
    };
    diningApi.analytics.get(params)
      .then((next) => {
        if (!ignore) {
          setResult({ key: queryKey, data: next });
          setError("");
        }
      })
      .catch((failure) => {
        if (!ignore) setError(failure.message);
      });
    return () => {
      ignore = true;
    };
  }, [demo, start, end, stall, queryKey]);
  function selectPeriod(value) {
    setPeriod(value);
    if (value === "周") {
      setStart("2026-08-24");
      setEnd("2026-08-28");
    }
    if (value === "月") {
      setStart("2026-08-01");
      setEnd("2026-08-31");
    }
    if (value === "季度") {
      setStart("2026-07-01");
      setEnd("2026-09-30");
    }
  }
  const ranking = report?.ranking.filter((item) => item.unit === unit) || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">INSIGHTS / 04</span>
          <h1>消费分析</h1>
          <p>从真实交易出发，看清每一餐的选择。</p>
        </div>
        <div className="actions">
          <button
            onClick={() =>
              downloadCsv("POS导入模板.csv", [
                {
                  transactionId: "SAMPLE-001",
                  lineId: "1",
                  time: "2026-08-24T12:30",
                  stall: "寻味列车",
                  dishId: "",
                  dishName: "奥尔良鸡腿",
                  quantity: 1,
                  amount: 8,
                  status: "sale",
                  unit: "份",
                },
              ])
            }
          >
            <FileDown size={16} />
            CSV 模板
          </button>
          <ImportButton
            disabled={busy || demo}
            onFile={(file) =>
              run(async () => {
                const result = await diningApi.analytics.importCsv(await file.text());
                setRevision((value) => value + 1);
                return `导入 ${result.inserted} 行，跳过 ${result.skipped} 行，未映射 ${result.unmapped} 行`;
              })
            }
          />
        </div>
      </div>
      <div className="analysis-toolbar">
        <div className="segmented">
          {["周", "月", "季度"].map((value) => (
            <button
              key={value}
              className={period === value ? "active" : ""}
              onClick={() => selectPeriod(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <input
          aria-label="消费开始日期"
          type="date"
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
            setPeriod("");
          }}
        />
        <span className="muted">至</span>
        <input
          aria-label="消费结束日期"
          type="date"
          value={end}
          onChange={(event) => {
            setEnd(event.target.value);
            setPeriod("");
          }}
        />
        <select
          aria-label="消费档口"
          value={stall}
          onChange={(event) => setStall(event.target.value)}
        >
          <option value="">全部档口</option>
          {[...new Set(data.dishes.map((dish) => dish.stall))].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <label className="check demo-toggle">
          <FlaskConical size={16} />
          <input
            type="checkbox"
            checked={demo}
            onChange={(event) => setDemo(event.target.checked)}
          />
          演示数据
        </label>
      </div>
      {demo && (
        <p className="notice">
          演示模式 ·
          模拟交易仅用于界面演示，不写入真实数据库，不代表实际销售表现。
        </p>
      )}
      {error ? (
        <p role="alert" className="notice">
          {error}
        </p>
      ) : !report ? (
        <Empty text="正在读取交易数据" />
      ) : (
        <>
          <div className="metrics">
            <Metric
              label="净消费金额"
              value={`¥ ${money(report.revenue)}`}
              detail="销售金额减退款金额"
              icon={Banknote}
            />
            <Metric
              label="销售交易笔数"
              value={report.sales}
              detail="按交易号去重 · 非就餐人数"
              icon={CreditCard}
              color="blue"
            />
            <Metric
              label="平均每笔净额"
              value={`¥ ${money(report.average)}`}
              detail="净金额 / 销售交易笔数"
              icon={TrendingUp}
              color="gold"
            />
            <Metric
              label="菜品映射覆盖率"
              value={`${report.coverage}%`}
              detail={`${report.unmapped} 行未映射明细`}
              icon={Link2}
              color="red"
            />
          </div>
          {!report.rows ? (
            <div className="no-pos">
              <Empty text="当前期间暂无真实 POS 交易" />
              <p>待接入供应商明细 · 菜品销量与就餐人数暂不可计算</p>
            </div>
          ) : (
            <>
              <div className="chart-grid">
                <section className="work-section">
                  <div className="section-heading">
                    <h2>每日净消费</h2>
                    <Badge>{demo ? "模拟数据" : "导入交易"}</Badge>
                  </div>
                  <div className="chart-box">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={report.trend}
                        margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          vertical={false}
                          stroke="#e5eae5"
                          strokeDasharray="3 3"
                        />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(value) => value.slice(5)}
                          tick={{ fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          width={45}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          formatter={(value) => [`¥ ${money(value)}`, "净金额"]}
                        />
                        <Area
                          type="monotone"
                          dataKey="revenue"
                          stroke="#347e65"
                          fill="#e1eee5"
                          strokeWidth={2}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </section>
                <section className="work-section">
                  <div className="section-heading">
                    <h2>档口净收入</h2>
                  </div>
                  <div className="chart-box">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={report.stalls.slice(0, 7)}
                        layout="vertical"
                        margin={{ top: 10, right: 22, bottom: 0, left: 0 }}
                      >
                        <XAxis type="number" hide />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={82}
                          tick={{ fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          formatter={(value) => [`¥ ${money(value)}`, "净收入"]}
                        />
                        <Bar
                          dataKey="revenue"
                          fill="#91b7a2"
                          radius={[0, 3, 3, 0]}
                          maxBarSize={20}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>
              <section className="work-section">
                <div className="section-heading">
                  <h2>
                    菜品净销量排行 <span>同单位比较</span>
                  </h2>
                  <div className="actions">
                    <select
                      aria-label="销量计价单位"
                      value={unit}
                      onChange={(event) => setUnit(event.target.value)}
                    >
                      {["份", "个", "斤", "100g"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                    <ExportButton
                      onClick={() =>
                        downloadCsv(
                          `${demo ? "模拟-" : ""}菜品排行.csv`,
                          ranking.map((item) => ({
                            菜名: item.name,
                            档口: item.stall,
                            单位: item.unit,
                            净数量: item.quantity,
                            净金额: item.revenue,
                          })),
                        )
                      }
                    />
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>排名</th>
                        <th>菜品</th>
                        <th>档口</th>
                        <th>净销量</th>
                        <th>净消费额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranking.slice(0, 30).map((item, index) => (
                        <tr key={item.id}>
                          <td>
                            <span className={`rank ${index < 3 ? "top" : ""}`}>
                              {String(index + 1).padStart(2, "0")}
                            </span>
                          </td>
                          <td>
                            <strong>{item.name}</strong>
                          </td>
                          <td>{item.stall}</td>
                          <td>
                            {Number(item.quantity.toFixed(3))} {item.unit}
                          </td>
                          <td>¥ {money(item.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!ranking.length && (
                  <Empty text="当前单位下没有已映射菜品明细" />
                )}
                <p className="small muted spaced">
                  排名依据净售出数量，未按上架天数、可售时长或备货量校正，不等同偏好或满意度。
                </p>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
