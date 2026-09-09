// The only browser network boundary. Routes, origins and transport errors stay
// outside React views so the backend can move without changing each page.
export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = "ApiError"; this.status = status; }
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
  async function send(path, { method = "GET", query, body, headers, raw = false, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(url(path, query), { method, signal, credentials: "same-origin",
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
        headers: { Accept: "application/json", ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }), ...headers } });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError("无法连接数据服务，请确认服务已启动后重试");
    }
    if (response.status === 204 && response.ok) return null;
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(response.ok ? "数据服务返回格式异常" : `数据服务请求失败（${response.status}）`, response.status); }
    if (!response.ok) throw new ApiError(typeof data?.error === "string" ? data.error : "请求失败", response.status);
    return data;
  }
  return Object.freeze({ url, send });
}
