import { lazy, startTransition, Suspense, useEffect, useState } from "react";
import {
  MessageSquare,
  CalendarDays,
  BookOpen,
  ChartNoAxesCombined,
  UtensilsCrossed,
  Database,
  CircleCheck,
  X,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import Feedback from "./Feedback";
import Catalog from "./Catalog";
import Menus from "./Menus";
import { request } from "./api";
import "./workbench.css";

const Analytics = lazy(() => import("./Analytics"));
const navigation = [
  { id: "feedback", name: "反馈中心", icon: MessageSquare },
  { id: "menus", name: "六周菜单", icon: CalendarDays },
  { id: "catalog", name: "菜品资料", icon: BookOpen },
  { id: "analytics", name: "消费分析", icon: ChartNoAxesCombined },
];
export default function Workbench() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("feedback");
  const [visited, setVisited] = useState(["feedback"]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function reload() {
    try {
      const next = await request("/data");
      startTransition(() => setData(next));
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  }
  useEffect(() => {
    let ignore = false;
    request("/data")
      .then((next) => {
        if (!ignore) setData(next);
      })
      .catch((failure) => {
        if (!ignore) setError(failure.message);
      });
    return () => {
      ignore = true;
    };
  }, []);
  async function run(action) {
    if (busy) return;
    setBusy(true);
    try {
      const message = await action();
      await reload();
      setToast({ text: message || "已保存", error: false });
    } catch (failure) {
      setToast({ text: failure.message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const views = {
    feedback: Feedback,
    menus: Menus,
    catalog: Catalog,
    analytics: Analytics,
  };
  const selectView = (id) => {
    setView(id);
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            selectView("feedback");
          }}
        >
          <span className="brand-icon">
            <UtensilsCrossed size={23} />
          </span>
          <span>
            <strong>餐叙</strong>
            <small>DINING OPERATIONS</small>
          </span>
        </a>
        <div className="workspace-label">BJW 园区餐饮</div>
        <nav aria-label="主导航">
          {navigation.map(({ id, name, icon: Icon }, index) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => selectView(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{name}</span>
              <small>0{index + 1}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="small-label">MATERIAL LIBRARY</div>
          <strong>{data?.report.workbooks || "16"} 份工作簿</strong>
          <p>{data?.report.sheets || "69"} 张工作表 · 本地资料</p>
          <div className="local-status">
            <span />
            本地工作空间 <Database size={14} />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span>BJW</span>
            <i>/</i>
            {navigation.find((item) => item.id === view).name}
          </div>
          <div className="topbar-right">
            <span>
              <CircleCheck size={14} /> 本地初版
            </span>
            <div className="avatar" title="本地可信操作人员">
              运营
            </div>
          </div>
        </header>
        <main>
          {error ? (
            <div className="error-panel">
              <h2>数据加载失败</h2>
              <p>{error}</p>
              <button onClick={reload}>
                <RefreshCw size={16} />
                重新加载
              </button>
            </div>
          ) : !data ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              正在读取本地资料
            </div>
          ) : (
            visited.map((id) => {
              const View = views[id];
              return (
                <div key={id} hidden={view !== id}>
                  <Suspense
                    fallback={<div className="loading">正在加载工作视图</div>}
                  >
                    <View data={data} run={run} busy={busy} />
                  </Suspense>
                </div>
              );
            })
          )}
        </main>
        <footer className="workspace-footer">
          <span>餐叙 / BJW Dining</span>
          <span>资料驱动 · 人工复核 · 可追溯</span>
        </footer>
      </div>
      {data && (
        <datalist id="stall-list">
          {[...new Set(data.dishes.map((item) => item.stall))].map((stall) => (
            <option key={stall}>{stall}</option>
          ))}
        </datalist>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <span>{toast.text}</span>
          <button
            className="icon-button"
            title="关闭通知"
            aria-label="关闭通知"
            onClick={() => setToast(null)}
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
