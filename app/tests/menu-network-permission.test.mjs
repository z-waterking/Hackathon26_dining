import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createAiClient } from "../server/ai.mjs";
import { createApp } from "../server/app.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";

test("menu generation reports outbound EACCES at week one without retries or business changes", async (t) => {
  const store = createStore(":memory:", () => ({
    feedback: [{ id: "F-existing", content: "午餐希望增加素菜" }],
    dishes: Array.from({ length: 4 }, (_, index) => ({
      id: `D${index}`, name: `测试素菜${index}`, stall: "测试档口", active: true,
      price: 8, unit: "份", spicy: "不辣", vegetarian: "素食",
    })),
    rules: [], recipes: [], inventory: [], report: {},
  }));
  store.put("plans", "P-existing", { id: "P-existing", status: "待审核草案", entries: [] });
  store.put("actions", "A-existing", {
    id: "A-existing", feedbackIds: ["F-existing"], status: "approved", enabled: true,
    title: "增加素菜选择", targetStall: "测试档口", menuInstruction: "午餐优先提供已核验素菜", revision: 1,
  });
  store.put("transactions", "T-existing", { id: "T-existing", amount: 8 });
  store.put("imports", "I-existing", { id: "I-existing", source: "existing.xlsx" });
  store.put("audit", "AU-existing", { id: "AU-existing", kind: "existing.audit" });
  let calls = 0;
  const ai = createAiClient(store, {
    config: { endpoint: "https://test.services.ai.azure.com/openai/v1/responses", apiKey: "private-key",
      model: "gpt-5.6-sol", budgetUsd: 150, inputPrice: null, outputPrice: null, timeoutMs: 1000 },
    fetchImpl: async () => {
      calls++;
      throw new TypeError("private-key", { cause: { code: "EACCES", message: "private-network-details" } });
    },
  });
  const app = createApp(store, undefined, { ai });
  t.after(async () => { await app.close(); store.close(); });
  const businessCollections = COLLECTIONS.filter((name) => !["aiUsage", "menuRuns"].includes(name));
  const businessSnapshot = () => Object.fromEntries(businessCollections.map((name) => [name, store.all(name)]));
  const before = businessSnapshot();

  const response = await app.inject({
    method: "POST", url: "/api/plans/generate",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: { useAi: true, demo: false, scope: "all", start: "2026-09-14", meals: ["午餐"], count: 2, seed: 1 },
  });

  assert.equal(response.statusCode, 502);
  assert.match(response.json().error, /出站连接被本机运行权限阻止（EACCES）/);
  assert.match(response.json().error, /重启后端服务/);
  assert.equal(calls, 1);
  const runs = store.all("menuRuns");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].stage, "failed");
  assert.equal(runs[0].failedStage, "planning");
  assert.equal(runs[0].currentWeek, 1);
  assert.deepEqual(runs[0].plannerBatches, []);
  assert.equal(runs[0].plan, undefined);
  const usage = store.all("aiUsage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, "failed");
  assert.equal(usage[0].errorCode, "EACCES");
  assert.equal(usage[0].httpStatus, undefined);
  assert.deepEqual(businessSnapshot(), before, "Existing plans and every business collection must remain unchanged");
  assert.doesNotMatch(JSON.stringify([response.json(), runs, usage]), /private-key|private-network-details/);
});
