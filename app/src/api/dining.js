import { createHttpClient } from "./http.js";

const idPart = (value) => {
  if (typeof value !== "string" || !value || value === "." || value === "..") throw new Error("记录ID无效");
  return encodeURIComponent(value);
};
export function createDiningApi(options) {
  const http = createHttpClient(options);
  const get = (path, query) => http.send(path, { query });
  const post = (path, body = {}) => http.send(path, { method: "POST", body });
  const patch = (path, body) => http.send(path, { method: "PATCH", body });
  return Object.freeze({
    workspace: { load: () => get("/data") },
    feedback: {
      list: () => get("/feedback"),
      create: (input) => post("/feedback", input),
      update: (id, input) => patch(`/feedback/${idPart(id)}`, input),
      importCsv: (csv) => post("/feedback/import", { csv }),
      insights: (month = "") => get("/feedback/insights", { month }),
      summary: (month) => get("/feedback/summary", { month }),
      summarize: (month) => post("/feedback/summary", { month }),
      draftReply: (id) => post(`/feedback/${idPart(id)}/analyze`),
      saveReply: (id, text) => post(`/feedback/${idPart(id)}/reply`, { text }),
      importOriginal: (file) => {
        if (!file || !/\.xlsx$/i.test(file.name)) throw new Error("请选择 Excel .xlsx 原始文件");
        if (!file.size) throw new Error("不能上传空文件");
        if (file.size > 10 * 1024 * 1024) throw new Error("Excel 文件不能超过 10 MB");
        return http.send("/feedback/upload", { method: "POST", raw: true, body: file,
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } });
      },
    },
    imports: {
      list: () => get("/imports"),
      rows: (id) => get(`/imports/${idPart(id)}/rows`),
      downloadUrl: (id, format = "xlsx") => {
        if (!["xlsx", "csv"].includes(format)) throw new Error("不支持的导出格式");
        return http.url(`/imports/${idPart(id)}/download`, { format });
      },
    },
    actions: {
      list: () => get("/actions"), summary: (scope = {}) => get("/actions/summary", scope),
      summarize: (scope) => post("/actions/summarize", scope),
      update: (id, input) => patch(`/actions/${idPart(id)}`, input), loadDemo: () => post("/demo/actions"),
    },
    catalog: {
      list: () => get("/dishes"), materials: () => get("/materials"),
      recipes: (id) => get(`/recipes/${idPart(id)}`), update: (id, input) => patch(`/dishes/${idPart(id)}`, input),
    },
    plans: {
      list: () => get("/plans"), get: (id) => get(`/plans/${idPart(id)}`),
      generate: (input) => post("/plans/generate", input), save: (plan) => post("/plans", plan),
      check: (plan) => post("/plans/check", plan), inspect: (plan) => post("/plans/inspect", plan),
      run: (id) => get(`/menu-runs/${idPart(id)}`),
    },
    analytics: { get: (scope) => get("/pos", scope), importCsv: (csv) => post("/pos/import", { csv }) },
    system: { health: () => get("/health"), aiStatus: () => get("/ai/status"), audit: () => get("/audit") },
  });
}

// Build-time, public configuration only. No server credentials belong here.
export const diningApi = createDiningApi({ baseUrl: import.meta.env?.VITE_API_BASE_URL || "/api" });
