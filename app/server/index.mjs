import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { initializeLocalStore } from "./bootstrap.mjs";
import { createApp } from "./app.mjs";
import { syncMenuSourceRules } from "./menu-source-rules.mjs";
import { createNetworkAccess } from "./network-access.mjs";
import { createAiClient } from "./ai.mjs";
import { requireStoredStallCatalog } from "./stored-stall-catalog.mjs";
import { initializePromptBase } from "./prompt-config.mjs";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
const networkAccess = createNetworkAccess({ mode: process.env.DINING_NETWORK || "local" });
const store = await initializeLocalStore();
requireStoredStallCatalog(store);
await syncMenuSourceRules(store, resolve(root, ".."));
// Freeze source/default configuration once, independently of saved overrides.
// Reads and previews never create versions or mutate the baseline.
initializePromptBase(store);
const app = createApp(store, undefined, { menuRuleRoot: resolve(root, ".."), networkAccess });
const port = Number(process.env.PORT || 4317);
try {
  // Reserve the configured port first: a duplicate start must not spend tokens.
  await app.listen({ port, host: networkAccess.listenHost });
  // Explicit opt-in only: test the very process that will serve browser requests,
  // not an unrelated shell with different outbound-network permissions.
  if (process.argv.includes("--verify-ai")) {
    const result = await createAiClient(store).respond({
      role: "connectivity", prompt: "这是连接诊断。请仅返回JSON对象，ok为true。", input: { check: "connectivity" },
      schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false },
      maxOutputTokens: 1024,
    });
    if (result.data?.ok !== true) throw new Error("AI 连接诊断返回异常，服务尚未启动");
    console.log(`AI connectivity verified: ${result.model} (input ${result.usage.input_tokens || 0}, output ${result.usage.output_tokens || 0} tokens)`);
  }
  console.log(`Dining workbench: http://127.0.0.1:${port}`);
  for (const hostname of networkAccess.hostnames)
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname))
      console.log(`Company LAN: http://${hostname}:${port}`);
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${port} is in use. Set PORT to another free port.`
      : error.message,
  );
  await app.close();
  store.close();
  process.exitCode = 1;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exitCode = 0;
  });
