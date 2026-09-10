import { createHttpClient } from "./http.js";

const idPart = (value) => {
  if (typeof value !== "string" || !value || value === "." || value === "..") throw new Error("记录ID无效");
  return encodeURIComponent(value);
};
const versionPart = (value) => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Prompt版本无效");
  return text;
};
export function createDiningApi(options) {
  const http = createHttpClient(options);
  const get = (path, query) => http.send(path, { query });
  const post = (path, body = {}) => http.send(path, { method: "POST", body });
  const patch = (path, body) => http.send(path, { method: "PATCH", body });
  return Object.freeze({
    workspace: { load: () => get("/data") },
    translations: { english: (texts) => post("/ui-translations", { texts }) },
    generations: { cancel: (id) => post(`/generations/${idPart(id)}/cancel`) },
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
      create: (input) => post("/dishes", input),
      remove: (id, input = {}) => http.send(`/dishes/${idPart(id)}`, { method: "DELETE", body: input }),
      restore: (id, input = {}) => post(`/dishes/${idPart(id)}/restore`, input),
      englishSummary: () => get("/dishes/english-summary"),
      prepareEnglish: (input = {}) => post("/dishes/prepare-english", input),
    },
    plans: {
      list: () => get("/plans"), get: (id) => get(`/plans/${idPart(id)}`),
      generate: (input) => post("/plans/generate", input), save: (plan) => post("/plans", plan),
      generateProgressive: (input, options = {}) => http.stream("/plans/generate-stream", { ...options, method: "POST", body: input }),
      check: (plan) => post("/plans/check", plan), inspect: (plan) => post("/plans/inspect", plan),
      repair: (input) => post("/plans/repair", input),
      run: (id) => get(`/menu-runs/${idPart(id)}`),
      recoverableRuns: () => get("/menu-runs", { recoverable: true }),
      resume: (id, { generationId } = {}) => { idPart(id); return post("/plans/resume", { runId: id, generationId }); },
      resumeProgressive: (id, { generationId, ...options } = {}) => { idPart(id); return http.stream("/plans/resume-stream", { ...options, method: "POST", body: { runId: id, generationId } }); },
      result: (id) => get(`/menu-runs/${idPart(id)}/result`),
    },
    analytics: { get: (scope) => get("/pos", scope), importCsv: (csv) => post("/pos/import", { csv }) },
    prompts: {
      get: () => get("/prompt-config"), save: (input) => http.send("/prompt-config", { method: "PUT", body: input }),
      history: (query = {}) => get("/prompt-config/history", query),
      historyVersion: (version) => get(`/prompt-config/history/${versionPart(version)}`),
      restoreBase: (input) => post("/prompt-config/restore-base", input),
    },
    system: { health: () => get("/health"), aiStatus: () => get("/ai/status"), audit: () => get("/audit") },
  });
}

// Build-time, public configuration only. No server credentials belong here.
export const diningApi = createDiningApi({ baseUrl: import.meta.env?.VITE_API_BASE_URL || "/api" });
