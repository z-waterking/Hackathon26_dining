import Papa from "papaparse";

export function downloadCsv(name, rows) {
  const blob = new Blob(
    ["\uFEFF" + Papa.unparse(rows, { escapeFormulae: true })],
    { type: "text/csv;charset=utf-8;" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const money = (value) =>
  Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
