import { randomUUID } from "node:crypto";
import { responseInstructions } from "./prompt-builders.mjs";
import { cancellationError } from "./generation-tasks.mjs";

export const defaultEndpoint = "https://41626-me2j04fd-eastus2.services.ai.azure.com/openai/v1/responses";

export function aiConfig(env = process.env) {
  const optionalNumber = (value) => value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  return {
    endpoint: env.AZURE_OPENAI_RESPONSES_ENDPOINT || defaultEndpoint,
    apiKey: env.AZURE_OPENAI_API_KEY || "",
    model: env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.6-sol",
    modelVersion: env.AZURE_OPENAI_MODEL_VERSION || "2026-07-09",
    budgetUsd: optionalNumber(env.AI_MONTHLY_BUDGET_USD) ?? 150,
    inputPrice: optionalNumber(env.AI_INPUT_USD_PER_MILLION),
    outputPrice: optionalNumber(env.AI_OUTPUT_USD_PER_MILLION),
    timeoutMs: Math.min(300000, Math.max(1000, Number(env.AI_TIMEOUT_MS) || 180000)),
  };
}

export function createAiClient(store, { config = aiConfig(), fetchImpl = fetch } = {}) {
  const usageRows = () => store.all("aiUsage");
  const status = () => {
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }).slice(0, 7);
    const records = usageRows().filter((item) => item.month === month);
    const priced = config.inputPrice !== null && config.outputPrice !== null;
    return { configured: Boolean(config.apiKey && config.model), endpoint: config.endpoint, model: config.model,
      modelVersion: config.modelVersion, budgetUsd: config.budgetUsd, month,
      calls: records.length, inputTokens: records.reduce((sum, r) => sum + (r.inputTokens || 0), 0),
      outputTokens: records.reduce((sum, r) => sum + (r.outputTokens || 0), 0),
      estimatedCostUsd: priced ? records.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0) : null,
      costNote: priced ? "按配置单价估算；以 Azure 账单为准" : "未配置单价，150 USD 仅为预算参考；本地记录 token，不声称限制 Azure 账单",
      reason: config.apiKey ? "" : "请在 app/.env 配置 Azure API 密钥后重启服务",
    };
  };
  async function respond({ role, prompt, input, schema, maxOutputTokens, signal }) {
    if (signal?.aborted) throw cancellationError();
    if (!status().configured) throw new Error(status().reason);
    const url = new URL(config.endpoint);
    if (url.protocol !== "https:" || !/\.(services\.ai\.azure\.com|openai\.azure\.com)$/.test(url.hostname) || !url.pathname.endsWith("/openai/v1/responses"))
      throw new Error("Azure endpoint 必须是 HTTPS Responses API 地址");
    const current = status();
    if (current.estimatedCostUsd !== null && current.estimatedCostUsd >= config.budgetUsd)
      throw new Error("本月配置的估算预算已用完，请检查运营用量和 Azure 账单");
    const id = randomUUID();
    const at = new Date().toISOString();
    const record = { id, at, month: current.month, role, model: config.model, status: "running" };
    store.put("aiUsage", id, record);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": config.apiKey },
        // Synchronous Responses requests are cancelled by closing the upstream
        // connection; background-response cancellation endpoints do not apply.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.model, store: false,
          instructions: responseInstructions(prompt),
          input: JSON.stringify(input),
          max_output_tokens: Math.min(maxOutputTokens || (role === "inspector" ? 8000 : role === "planner" ? 10000 : 4000), 16000),
          text: { format: { type: "json_schema", name: `dining_${role.replace(/[^a-zA-Z0-9_]/g, "_")}`, strict: true, schema } },
        }),
      });
      if (!response.ok) {
        record.httpStatus = response.status;
        record.requestId = response.headers.get("x-request-id") || response.headers.get("apim-request-id") || "";
        // Persist only a machine-readable code, never raw gateway messages,
        // request bodies or credentials. Do not automatically retry billable calls.
        const upstream = await response.json().catch(() => null);
        const code = upstream?.error?.code;
        if (typeof code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(code)) record.errorCode = code;
        const hint = response.status === 401 || response.status === 403 ? "请检查密钥和访问权限"
          : response.status === 404 ? "请检查 endpoint 和模型部署名称"
          : response.status === 429 ? "服务配额或速率受限，请稍后重试"
          : response.status === 400 ? "请检查模型支持的参数和结构化输出格式" : "服务暂时不可用，请稍后重试";
        const error = new Error(`Azure AI 请求失败（HTTP ${response.status}），${hint}`);
        error.statusCode = 502;
        throw error;
      }
      const payload = await response.json();
      const usage = payload.usage || {};
      record.inputTokens = usage.input_tokens || 0;
      record.outputTokens = usage.output_tokens || 0;
      record.requestId = payload.id || response.headers.get("x-request-id") || "";
      record.estimatedCostUsd = config.inputPrice !== null && config.outputPrice !== null
        ? (record.inputTokens * config.inputPrice + record.outputTokens * config.outputPrice) / 1000000 : null;
      // Some transports/mocks can finish after abort. Keep reported usage, but
      // never return that late output to the business workflow.
      if (signal?.aborted) throw cancellationError();
      if (payload.status && payload.status !== "completed") {
        const reason = payload.incomplete_details?.reason;
        if (["max_output_tokens", "content_filter"].includes(reason)) record.errorCode = reason;
        throw new Error(reason === "max_output_tokens" ? "AI 未完成输出：达到输出长度限制，请缩小反馈范围后重试；本次未写入业务结果" : "AI 未完成输出，请重试；本次未写入业务结果");
      }
      const content = (payload.output || []).flatMap((item) => item.content || []);
      if (content.some((item) => item.type === "refusal")) throw new Error("AI 未能生成此请求的结果，请人工处理");
      const output = payload.output_text || content.filter((item) => item.type === "output_text").map((item) => item.text).join("");
      let data;
      try { data = JSON.parse(output); } catch { throw new Error("AI 返回的结构化结果无效，请重试；本次未写入业务结果"); }
      store.put("aiUsage", id, { ...record, status: "completed", completedAt: new Date().toISOString() });
      return { data, usage, model: payload.model || config.model, requestId: record.requestId };
    } catch (error) {
      if (signal?.aborted || error.code === "GENERATION_CANCELLED") {
        const cancelled = cancellationError();
        store.put("aiUsage", id, { ...record, status: "cancelled", errorCode: cancelled.code, error: cancelled.message, completedAt: new Date().toISOString() });
        throw cancelled;
      }
      const networkCode = error.cause?.code;
      if (typeof networkCode === "string" && /^[A-Z0-9_]{1,80}$/.test(networkCode)) record.errorCode = networkCode;
      const message = ["EACCES", "EPERM"].includes(networkCode)
        ? `Azure AI 出站连接被本机运行权限阻止（${networkCode}），尚未收到模型响应。请在允许联网的终端重启后端服务；仅刷新页面无效`
        : ["TimeoutError", "AbortError"].includes(error.name) ? "Azure AI 请求超时，请稍后重试" : error.message?.startsWith("AI ") || error.message?.startsWith("Azure AI") ? error.message : "Azure AI 连接失败，请检查网络和服务配置";
      store.put("aiUsage", id, { ...record, status: "failed", error: message, completedAt: new Date().toISOString() });
      throw Object.assign(new Error(message), { statusCode: 502 });
    }
  }
  return { respond, status };
}
