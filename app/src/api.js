import Papa from "papaparse";

export async function request(path, body, method = "POST") {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

export async function uploadFeedback(file) {
  if (!/\.xlsx$/i.test(file.name)) throw new Error("请选择 Excel .xlsx 文件");
  if (!file.size) throw new Error("不能上传空文件");
  if (file.size > 10 * 1024 * 1024) throw new Error("Excel 文件不能超过 10 MB");
  const response = await fetch("/api/feedback/upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "上传失败");
  return result;
}

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
