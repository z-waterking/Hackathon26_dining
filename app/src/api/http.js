// The only browser network boundary. Routes, origins and transport errors stay
// outside React views so the backend can move without changing each page.
export class ApiError extends Error {
  constructor(message, status = 0, metadata = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    // Preserve only safe diagnostics needed to locate and resume a menu run.
    // Never attach arbitrary response bodies, raw prompts or model attempts.
    for (const key of ["runId", "code", "week", "stall", "day", "meal", "slot"]) {
      if (["string", "number"].includes(typeof metadata[key])) this[key] = metadata[key];
    }
  }
}

function responseError(data, status, fallback = {}) {
  const details = data?.error && typeof data.error === "object" ? data.error : {};
  const message = typeof data?.error === "string" ? data.error : typeof details.message === "string" ? details.message : "请求失败";
  return new ApiError(message, status, { ...fallback, ...data, ...details });
}

export function createHttpClient({ baseUrl = "/api", fetchImpl = (...args) => fetch(...args) } = {}) {
  const base = String(baseUrl || "/api").replace(/\/+$/, "");
  if (!(base.startsWith("/") && !base.startsWith("//") || /^https?:\/\//i.test(base)) || /[?#]/.test(base))
    throw new Error("API base URL must be an HTTP(S) URL or an absolute path without query/hash");
  const url = (path, query = {}) => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) throw new Error("Invalid API path");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
    return `${base}${path}${params.size ? `?${params}` : ""}`;
  };
  async function request(path, { method = "GET", query, body, headers, raw = false, signal } = {}) {
    try {
      return await fetchImpl(url(path, query), { method, signal, credentials: "same-origin",
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
        headers: { Accept: "application/json", ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }), ...headers } });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError("无法连接数据服务，请确认服务已启动后重试");
    }
  }
  async function send(path, options = {}) {
    const response = await request(path, options);
    if (response.status === 204 && response.ok) return null;
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(response.ok ? "数据服务返回格式异常" : `数据服务请求失败（${response.status}）`, response.status); }
    if (!response.ok) throw responseError(data, response.status);
    return data;
  }
  // A stream represents one billable generation request. Never reconnect or
  // automatically repeat the POST when a proxy or the browser disconnects.
  async function stream(path, { onEvent, ...options } = {}) {
    if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
    const response = await request(path, { ...options, headers: { Accept: "application/x-ndjson", ...options.headers } });
    if (!response.ok) {
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError(`数据服务请求失败（${response.status}）`, response.status); }
      throw responseError(data, response.status);
    }
    let runId;
    const failure = (message, code) => new ApiError(message, response.status, { runId, code });
    const incomplete = () => failure("未收到完整的生成结果，请在生成记录中查看已完成周次并继续生成", "MENU_STREAM_INCOMPLETE");
    if (!/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel().catch(() => {});
      throw failure("数据服务返回的生成进度格式异常，请查看生成记录", "MENU_STREAM_INVALID");
    }
    if (!response.body) throw incomplete();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let result;
    let completed = false;
    const types = new Set(["started", "week", "inspecting", "heartbeat", "completed", "error"]);
    async function consume(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch { throw failure("数据服务返回的生成进度格式异常，请查看生成记录", "MENU_STREAM_INVALID"); }
      if (!event || Array.isArray(event) || !types.has(event.type))
        throw failure("数据服务返回了无法识别的生成进度，请查看生成记录", "MENU_STREAM_INVALID");
      if (typeof event.runId === "string" && event.runId) runId = event.runId;
      if (event.type === "completed" && (!event.plan || typeof event.plan !== "object" || Array.isArray(event.plan)))
        throw failure("数据服务未返回完整菜单，请查看生成记录", "MENU_STREAM_INVALID");
      await onEvent?.(event);
      if (event.type === "error") throw responseError({ ...event, runId }, response.status);
      if (event.type === "completed") { result = event.plan; completed = true; }
    }
    try {
      while (!completed) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (error) {
          if (error?.name === "AbortError") {
            const aborted = failure("已停止接收生成进度，可在生成记录中查看已完成周次", "MENU_STREAM_ABORTED");
            aborted.name = "AbortError";
            throw aborted;
          }
          throw incomplete();
        }
        try { pending += decoder.decode(chunk.value, { stream: !chunk.done }); }
        catch { throw failure("数据服务返回的生成进度编码异常，请查看生成记录", "MENU_STREAM_INVALID"); }
        let boundary;
        while (!completed && (boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          await consume(line);
        }
        if (chunk.done) {
          if (!completed && pending.trim()) await consume(pending);
          if (!completed) throw incomplete();
        }
      }
      return result;
    } finally {
      // Includes callback exceptions: release the response instead of leaving
      // a reader locked with an unseen, ongoing generation stream.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return Object.freeze({ url, send, stream });
}
