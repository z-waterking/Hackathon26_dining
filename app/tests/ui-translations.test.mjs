import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";
import { createUiTranslator } from "../server/ui-translations.mjs";
import { createApp } from "../server/app.mjs";
import { createDiningApi } from "../src/api/dining.js";
import { getPromptConfig } from "../server/prompt-config.mjs";
import { approvedMenuActions, sourceRules } from "../server/menu-workflow.mjs";
import { LANGUAGE_KEY, normalizeLanguage, readLanguage, persistLanguage, translate } from "../src/i18n-text.js";

function setup(t) {
  const store = createStore(":memory:", () => ({ feedback: [{ id: "F1", content: "原始反馈保留中文" }], dishes: [{ id: "D1", name: "红烧肉", stall: "寻味列车" }], rules: [] }));
  store.put("actions", "A1", { id: "A1", title: "增加清淡菜", status: "approved" });
  t.after(() => store.close());
  return store;
}
test("language storage is bounded, resilient and never changes canonical values", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readLanguage(storage), "zh");
  assert.equal(persistLanguage(storage, "en"), "en");
  assert.equal(values.get(LANGUAGE_KEY), "en");
  assert.equal(readLanguage(storage), "en");
  assert.equal(normalizeLanguage("<script>"), "zh");
  assert.equal(readLanguage({ getItem() { throw Error("blocked"); } }), "zh");
  assert.doesNotThrow(() => persistLanguage({ setItem() { throw Error("blocked"); } }, "en"));
  assert.equal(translate("zh", "午餐", "Lunch"), "午餐");
  assert.equal(translate("en", "午餐"), "Lunch");
  assert.equal(translate("en", "红烧肉"), "红烧肉");
});
test("English translations cache by exact source without touching business records", async t => {
  const store = setup(t);
  const before = Object.fromEntries(COLLECTIONS.filter(key => key !== "meta").map(key => [key, store.all(key)]));
  const planning = { config: getPromptConfig(store), rules: sourceRules(store), actions: approvedMenuActions(store) };
  const calls = [];
  const service = createUiTranslator(store, { respond: async request => { calls.push(request); return { data: { translations: request.input.texts.map(item => ({ id: item.id, english: "Add mild dishes" })) } }; } });
  const first = await service.translate({ texts: ["增加清淡菜", "增加清淡菜", "Already English"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "ui_translation");
  assert.deepEqual(calls[0].input.texts, [{ id: 0, text: "增加清淡菜" }]);
  assert.deepEqual(first.translations.map(item => item.english), ["Add mild dishes", "Add mild dishes", "Already English"]);
  await service.translate({ texts: ["增加清淡菜"] });
  assert.equal(calls.length, 1);
  await service.translate({ texts: ["增加清淡菜并减少油盐"] });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, store.all(key)])), before);
  assert.deepEqual({ config: getPromptConfig(store), rules: sourceRules(store), actions: approvedMenuActions(store) }, planning);
});
test("concurrent translation reads share persisted results rather than duplicate calls", async t => {
  const store = setup(t);
  let calls = 0;
  const service = createUiTranslator(store, { respond: async () => { calls++; return { data: { translations: [{ id: 0, english: "Mild dishes" }] } }; } });
  await Promise.all([service.translate({ texts: ["清淡菜"] }), service.translate({ texts: ["清淡菜"] })]);
  assert.equal(calls, 1);
});
test("invalid or failed translations do not persist partial cache or expose upstream errors", async t => {
  const store = setup(t);
  const before = store.all("meta");
  const invalid = createUiTranslator(store, { respond: async () => ({ data: { translations: [{ id: 0, english: "First" }, { id: 0, english: "Duplicate" }] } }) });
  await assert.rejects(invalid.translate({ texts: ["第一条", "第二条"] }), /invalid references/);
  assert.deepEqual(store.all("meta"), before);
  const failing = createUiTranslator(store, { respond() { throw Error("private upstream error"); } });
  await assert.rejects(failing.translate({ texts: ["失败请求"] }), error => error.statusCode === 502 && !error.message.includes("private"));
  assert.deepEqual(store.all("meta"), before);
});
test("translation request limits reject before invoking the model", async t => {
  const store = setup(t);
  let calls = 0;
  const service = createUiTranslator(store, { respond() { calls++; } });
  for (const input of [{ texts: [] }, { texts: ["中文"], model: "forged" }, { texts: Array(41).fill("中文") }, { texts: ["中".repeat(30000), "文".repeat(11000)] }])
    await assert.rejects(service.translate(input));
  assert.equal(calls, 0);
});
test("legacy translation API only reads prepared cache and never starts AI", async t => {
  const store = setup(t);
  await createUiTranslator(store, { respond: async () => ({ data: { translations: [{ id: 0, english: "Action details" }] } }) }).translate({ texts: ["行动详情"] });
  let calls = 0;
  const app = createApp(store, undefined, { prepareEnglish: true, ai: { status: () => ({ configured: true }), respond: async () => { calls++; throw new Error("must not call"); } } });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/ui-translations", payload: { texts: ["行动详情"] } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { translations: [{ source: "行动详情", english: "Action details" }] });
  const missing = await app.inject({ method: "POST", url: "/api/ui-translations", payload: { texts: ["尚未翻译的说明"] } });
  assert.deepEqual(missing.json(), { translations: [] });
  assert.equal(calls, 0);
  const unsafe = await app.inject({ method: "POST", url: "/api/ui-translations", headers: { origin: "https://unexpected.example" }, payload: { texts: ["行动详情"] } });
  assert.equal(unsafe.statusCode, 403);
});
test("English display translation uses the unified API transport", async () => {
  const calls = [];
  const api = createDiningApi({ baseUrl: "https://example.test/api", fetchImpl: async (url, input) => { calls.push({ url, ...input }); return Response.json({ translations: [] }); } });
  await api.translations.english(["行动详情"]);
  assert.equal(calls[0].url, "https://example.test/api/ui-translations");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { texts: ["行动详情"] });
});
