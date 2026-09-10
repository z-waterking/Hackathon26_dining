import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createAiClient } from "../server/ai.mjs";

test("AI diagnostics retain safe status/code, never sensitive response text or automatic retries", async (t) => {
  const store = createStore(":memory:", () => ({ feedback: [], dishes: [] }));
  t.after(() => store.close());
  const config = { endpoint: "https://test.services.ai.azure.com/openai/v1/responses", apiKey: "private-key", model: "gpt-5.6-sol", budgetUsd: 150, inputPrice: null, outputPrice: null, timeoutMs: 1000 };
  let calls = 0;
  const request = { role: "actions", prompt: "test", input: {}, schema: {} };
  const ai = createAiClient(store, { config, fetchImpl: async () => { calls++; return Response.json({ error: { code: "RateLimitReached", message: "private-upstream-content" } }, { status: 429, headers: { "apim-request-id": "safe-trace-id" } }); } });
  await assert.rejects(ai.respond(request), /429.*配额或速率/);
  assert.equal(calls, 1);
  assert.equal(store.all("aiUsage")[0].errorCode, "RateLimitReached");
  assert.equal(store.all("aiUsage")[0].requestId, "safe-trace-id");
  const broken = createAiClient(store, { config, fetchImpl: () => { throw new TypeError("private-key", { cause: { code: "ENOTFOUND", message: "private-upstream-content" } }); } });
  await assert.rejects(broken.respond(request), /连接失败/);
  assert.equal(store.all("aiUsage").at(-1).errorCode, "ENOTFOUND");
  assert.doesNotMatch(JSON.stringify(store.all("aiUsage")), /private-key|private-upstream-content/);
});

test("outbound permission failures identify the server environment without leaking secrets or retrying", async (t) => {
  for (const code of ["EACCES", "EPERM"]) await t.test(code, async () => {
    const store = createStore(":memory:", () => ({ feedback: [], dishes: [] }));
    let calls = 0;
    try {
      const config = { endpoint: "https://test.services.ai.azure.com/openai/v1/responses", apiKey: "private-key", model: "gpt-5.6-sol", budgetUsd: 150, inputPrice: null, outputPrice: null, timeoutMs: 1000 };
      const ai = createAiClient(store, { config, fetchImpl: async () => { calls++; throw new TypeError("private-key", { cause: { code, message: "private-upstream-content" } }); } });
      await assert.rejects(ai.respond({ role: "planner", prompt: "test", input: {}, schema: {} }), error => {
        assert.equal(error.statusCode, 502);
        assert.match(error.message, /出站连接被本机运行权限阻止/);
        assert.match(error.message, /重启后端服务/);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(store.all("aiUsage")[0].errorCode, code);
      assert.equal(store.all("aiUsage")[0].status, "failed");
      assert.equal(store.all("plans").length, 0);
      assert.doesNotMatch(JSON.stringify(store.all("aiUsage")), /private-key|private-upstream-content/);
    } finally { store.close(); }
  });
});
