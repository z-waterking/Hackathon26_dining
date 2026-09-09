import { cloneElement, useEffect, useId, useRef } from "react";
import {
  X,
  Download,
  Upload,
  Inbox,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
export function Modal({ title, onClose, children, wide = false }) {
  const reference = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = reference.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={reference}
      className={wide ? "modal wide" : "modal"}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Badge({ children, tone = "" }) {
  return (
    <span
      className={`badge ${tone || { 已完成: "green", 跟进中: "gold", 未处理: "red", 投诉: "red", 表扬: "green", 建议: "blue", 询问: "gray" }[children] || "gray"}`}
    >
      {children}
    </span>
  );
}
export function Empty({ text = "暂无记录" }) {
  return (
    <div className="empty">
      <Inbox size={32} />
      <p>{text}</p>
    </div>
  );
}
export function Metric({ label, value, detail, icon: Icon, color = "green" }) {
  return (
    <div className={`metric ${color}`}>
      <div>
        <span>{label}</span>
        <strong
          style={{
            fontSize:
              String(value).length > 13
                ? 16
                : String(value).length > 8
                  ? 21
                  : undefined,
          }}
        >
          {value}
        </strong>
        <small>{detail}</small>
      </div>
      <Icon size={24} />
    </div>
  );
}
export function Field({ label, children }) {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {children.props["aria-label"]
        ? children
        : cloneElement(children, { "aria-labelledby": id })}
    </label>
  );
}
export function ExportButton({ onClick, children = "导出 CSV" }) {
  return (
    <button onClick={onClick}>
      <Download size={16} />
      {children}
    </button>
  );
}
export function ImportButton({ onFile, disabled }) {
  return (
    <label className={`button file-button ${disabled ? "disabled" : ""}`}>
      <Upload size={16} />
      导入 CSV
      <input
        aria-label="导入 CSV"
        type="file"
        accept=".csv,text/csv"
        disabled={disabled}
        onChange={async (event) => {
          const file = event.target.files[0];
          event.target.value = "";
          if (file) await onFile(file);
        }}
      />
    </label>
  );
}
export function Pagination({ page, setPage, count, size = 12 }) {
  const max = Math.max(1, Math.ceil(count / size));
  return (
    <div className="pagination">
      <span>共 {count} 条</span>
      <button
        className="icon-button"
        title="上一页"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft size={18} />
      </button>
      <span>
        {page} / {max}
      </span>
      <button
        className="icon-button"
        title="下一页"
        aria-label="下一页"
        disabled={page >= max}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
