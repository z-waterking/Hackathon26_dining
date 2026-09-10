import { cloneElement, useEffect, useId, useRef } from "react";
import { useI18n } from "./i18n";
import {
  X,
  Download,
  Upload,
  Inbox,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
export function Modal({ title, onClose, children, wide = false, busy = false }) {
  const { t } = useI18n();
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
      aria-busy={busy}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          title={t("关闭")}
          aria-label={t("关闭")}
          disabled={busy}
          onClick={() => { if (!busy) onClose(); }}
        >
          <X size={20} />
        </button>
      </header>
      <div className="modal-body"><fieldset className="modal-controls" disabled={busy}>{children}</fieldset></div>
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
  const { t } = useI18n();
  return (
    <div className="empty">
      <Inbox size={32} />
      <p>{t(text)}</p>
    </div>
  );
}
export function Metric({ label, value, detail, icon: Icon, color = "green" }) {
  const { t } = useI18n();
  return (
    <div className={`metric ${color}`}>
      <div>
        <span>{t(label)}</span>
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
        <small>{t(detail)}</small>
      </div>
      <Icon size={24} />
    </div>
  );
}
export function Field({ label, children }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{t(label)}</span>
      {children.props["aria-label"]
        ? children
        : cloneElement(children, { "aria-labelledby": id })}
    </label>
  );
}
export function ExportButton({ onClick, children = "导出 CSV" }) {
  const { t } = useI18n();
  return (
    <button onClick={onClick}>
      <Download size={16} />
      {t(children)}
    </button>
  );
}
export function ImportButton({ onFile, disabled }) {
  const { t } = useI18n();
  return (
    <label className={`button file-button ${disabled ? "disabled" : ""}`}>
      <Upload size={16} />
      {t("导入 CSV")}
      <input
        aria-label={t("导入 CSV")}
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
  const { t } = useI18n();
  const max = Math.max(1, Math.ceil(count / size));
  return (
    <div className="pagination">
      <span>{t(`共 ${count} 条`, `${count} records`)}</span>
      <button
        className="icon-button"
        title={t("上一页")}
        aria-label={t("上一页")}
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
        title={t("下一页")}
        aria-label={t("下一页")}
        disabled={page >= max}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
