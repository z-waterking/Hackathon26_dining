import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { DEFAULT_PROMPT_TEXTS, getEffectiveRules, getPromptConfig, savePromptConfig } from "../server/prompt-config.mjs";

const source = (row) => ({ file: "排菜规则.xlsx", sheet: "排菜规则（寻味列车）", row, cell: `B${row}`, fileSha256: "a".repeat(64) });
const seed = () => ({ feedback: [], dishes: [], rules: [
  { stall: "寻味列车", text: "同餐菜单不得出现同名菜品", meal: "午餐", source: source(3) },
  { stall: "续行", text: "根据已排菜单合理轮换菜品", meal: "晚餐", source: source(4) },
] });
function repository(t, decorate = (adapter) => adapter) {
  const store = createRepository(decorate(createMemoryAdapter()), seed);
  t.after(() => store.close());
  return store;
}
function saveInput(config, changes = {}) {
  const { updatedAt: _updatedAt, sourceChanged: _sourceChanged, ...values } = config;
  return { ...values, ...changes };
}

test("loading default prompts is read-only and preserves source rule IDs, continuation scopes and meals", (t) => {
  const store = repository(t);
  const before = store.all("meta");
  const config = getPromptConfig(store);
  assert.equal(config.version, 0);
  assert.equal(config.updatedAt, null);
  assert.equal(config.sourceChanged, false);
  assert.match(config.baseFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(config.actionGenerationText, DEFAULT_PROMPT_TEXTS.actionGenerationText);
  assert.equal(config.menuSystemText, DEFAULT_PROMPT_TEXTS.menuSystemText);
  assert.equal(config.approvedActionText, DEFAULT_PROMPT_TEXTS.approvedActionText);
  assert.deepEqual(config.rules.map(({ stall, meal }) => [stall, meal]), [["寻味列车", "午餐"], ["寻味列车", "晚餐"]]);
  const raw = seed().rules[0];
  const legacyId = `R-${createHash("sha256").update(JSON.stringify([raw.source.file, raw.source.sheet, raw.source.row, raw.text])).digest("hex").slice(0, 16)}`;
  assert.equal(config.rules[0].id, legacyId);
  assert.ok(config.rules.every((rule) => rule.origin === "source" && !Object.hasOwn(rule, "originalText")));
  assert.deepEqual(getPromptConfig(store), config);
  assert.deepEqual(store.all("meta"), before);
  assert.deepEqual(store.all("settings"), []);
  assert.deepEqual(store.all("audit"), []);
  config.rules[0].source.row = 900;
  assert.equal(getPromptConfig(store).rules[0].source.row, 3);
});

test("legacy custom prompt defaults are preserved without initializing or updating settings", (t) => {
  const store = repository(t);
  const settings = { version: 7, feedbackPrompt: "自定义反馈归纳与行动规则", plannerPrompt: "自定义排菜指导和业务偏好", operatorNotes: "动态运营补充" };
  store.put("settings", "current", settings);
  const config = getPromptConfig(store);
  assert.ok(config.actionGenerationText.startsWith(settings.feedbackPrompt));
  assert.ok(config.menuSystemText.startsWith(settings.plannerPrompt));
  assert.ok(!config.actionGenerationText.includes(settings.operatorNotes));
  assert.deepEqual(store.get("settings", "current"), settings);
});

test("save persists all three prompts and effective overrides atomically without overwriting source or settings", (t) => {
  const store = repository(t);
  const config = getPromptConfig(store);
  const rules = config.rules.map((rule, index) => ({ ...rule, text: index ? rule.text : "同餐同名菜品应合并处理并安排其他候选", enabled: index === 0 }));
  const next = savePromptConfig(store, saveInput(config, {
    actionGenerationText: "新的反馈生成运营行动规则提示词",
    menuSystemText: "新的排菜系统指令，逐条遵守当前规则",
    approvedActionText: "新的已批准行动执行说明与证据要求", rules,
  }));
  assert.equal(next.version, 1);
  assert.equal(next.sourceChanged, false);
  assert.match(next.updatedAt, /^\d{4}-/);
  assert.equal(next.rules[0].id, config.rules[0].id);
  assert.deepEqual(next.rules[0].source, config.rules[0].source);
  assert.equal(next.rules[0].origin, "override");
  assert.equal(next.rules[0].originalText, config.rules[0].text);
  assert.equal(next.rules[1].origin, "override");
  assert.deepEqual(getPromptConfig(store), next);
  assert.deepEqual(getEffectiveRules(store), [next.rules[0]]);
  assert.deepEqual(store.get("meta", "rules"), seed().rules);
  assert.deepEqual(store.all("settings"), []);
  assert.equal(store.get("meta", "prompt-config:version-1").actionGenerationText, next.actionGenerationText);
  const event = store.all("audit")[0];
  assert.equal(event.kind, "prompt.config.updated");
  assert.equal(event.previousVersion, 0);
  assert.equal(event.enabledRuleCount, 1);
  assert.deepEqual(event.changedPrompts, ["actionGenerationText", "menuSystemText", "approvedActionText"]);
  assert.equal(JSON.stringify(event).includes(next.menuSystemText), false);
});

test("no-op saves retain the version and do not write audit or configuration records", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  assert.deepEqual(savePromptConfig(store, saveInput(initial)), initial);
  assert.equal(store.get("meta", "prompt-config:current"), null);
  assert.equal(store.all("audit").length, 0);
  const saved = savePromptConfig(store, saveInput(initial, { menuSystemText: initial.menuSystemText + "\n额外运营要求：优先丰富菜品选择。" }));
  assert.deepEqual(savePromptConfig(store, saveInput(saved)), saved);
  assert.equal(store.all("audit").length, 1);
  assert.equal(store.get("meta", "prompt-config:version-2"), null);
});

test("stale saves cannot overwrite a newer configuration or reuse an old source fingerprint", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const saved = savePromptConfig(store, saveInput(initial, { approvedActionText: initial.approvedActionText + "\n新增执行检查。" }));
  assert.throws(() => savePromptConfig(store, saveInput(initial)), (error) => error.statusCode === 409);
  assert.equal(getPromptConfig(store).version, 1);
  store.put("meta", "menu-rule-source", { file: "排菜规则.xlsx", sha256: "b".repeat(64) });
  assert.throws(() => savePromptConfig(store, saveInput(saved)), (error) => error.statusCode === 409);
  const refreshed = getPromptConfig(store);
  assert.notEqual(refreshed.baseFingerprint, saved.baseFingerprint);
  assert.equal(refreshed.sourceChanged, true);
  assert.deepEqual(refreshed.rules, saved.rules);
  assert.equal(store.all("audit").length, 1);
});

test("initial source or legacy default changes invalidate the first editor snapshot", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  store.put("meta", "rules", [{ ...seed().rules[0], text: "来源文件中的新规则，必须读取最新内容" }]);
  assert.throws(() => savePromptConfig(store, saveInput(initial)), (error) => error.statusCode === 409);
  const refreshed = getPromptConfig(store);
  store.put("settings", "current", { version: 2, feedbackPrompt: "刚刚由另一处保存的反馈规则" });
  assert.throws(() => savePromptConfig(store, saveInput(refreshed)), (error) => error.statusCode === 409);
  assert.equal(store.get("meta", "prompt-config:current"), null);
  assert.equal(store.all("audit").length, 0);
});

test("new operator rules receive server-owned IDs and provenance; removal and scope edits take effect", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const saved = savePromptConfig(store, saveInput(initial, { rules: [
    { ...initial.rules[0], stall: "全部档口", meal: "全部餐次" },
    { id: "new-ui-rule", stall: "南粉北面", text: "本周增加不同主料候选的轮换", enabled: true },
  ] }));
  assert.equal(saved.rules.length, 2);
  assert.equal(saved.rules[0].stall, "全部档口");
  assert.equal(saved.rules[0].meal, "全部餐次");
  assert.match(saved.rules[1].id, /^R-operator-/);
  assert.notEqual(saved.rules[1].id, "new-ui-rule");
  assert.deepEqual(saved.rules[1].source, { kind: "operator", label: "运营规则" });
  assert.equal(saved.rules[1].origin, "operator");
  assert.equal(Object.hasOwn(saved.rules[1], "originalText"), false);
  assert.equal(saved.rules[1].meal, "全部餐次");
  assert.deepEqual(getEffectiveRules(store), saved.rules);
  assert.deepEqual(store.get("meta", "rules"), seed().rules);
});

test("existing provenance cannot be forged and a source-free update retains it", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const tampered = structuredClone(initial.rules);
  tampered[0].source.row = 99;
  assert.throws(() => savePromptConfig(store, saveInput(initial, { rules: tampered })), /不能修改或伪造来源/);
  tampered[0].source = null;
  assert.throws(() => savePromptConfig(store, saveInput(initial, { rules: tampered })), /不能修改或伪造来源/);
  const rules = initial.rules.map(({ source: _source, ...rule }) => ({ ...rule, text: `${rule.text}，并记录依据` }));
  const saved = savePromptConfig(store, saveInput(initial, { rules }));
  assert.deepEqual(saved.rules[0].source, initial.rules[0].source);
});

test("unknown IDs, duplicate IDs and invented new-rule file sources are rejected without writes", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  assert.throws(() => savePromptConfig(store, saveInput(initial, { rules: [initial.rules[0], initial.rules[0]] })), /ID 重复/);
  assert.throws(() => savePromptConfig(store, saveInput(initial, { rules: [{ ...initial.rules[0], id: "unknown" }] })), /ID 已失效/);
  assert.throws(() => savePromptConfig(store, saveInput(initial, { rules: [{ ...initial.rules[0], id: "new-invented" }] })), /新增规则不能指定文件来源/);
  assert.equal(store.get("meta", "prompt-config:current"), null);
  assert.equal(store.all("audit").length, 0);
});

test("strict bounded validation rejects malformed, empty or entirely disabled configurations", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  for (const changed of [
    { actionGenerationText: "  " }, { menuSystemText: "a".repeat(24001) }, { approvedActionText: "short" },
    { version: -1 }, { baseFingerprint: "old" }, { operatorNotes: "unexpected" },
    { rules: [] }, { rules: initial.rules.map((rule) => ({ ...rule, enabled: false })) },
    { rules: [{ ...initial.rules[0], text: " " }] }, { rules: [{ ...initial.rules[0], enabled: "yes" }] },
    { rules: [{ ...initial.rules[0], unexpected: true }] }, { rules: Array.from({ length: 301 }, () => initial.rules[0]) },
  ]) assert.throws(() => savePromptConfig(store, saveInput(initial, changed)));
  assert.equal(store.get("meta", "prompt-config:current"), null);
  assert.equal(store.all("audit").length, 0);
});

test("configuration and immutable history roll back together if audit persistence fails", (t) => {
  const store = repository(t, (adapter) => ({ ...adapter, put(collection, id, value) {
    if (collection === "audit") throw new Error("audit write failed");
    return adapter.put(collection, id, value);
  } }));
  const initial = getPromptConfig(store);
  const before = store.all("meta");
  assert.throws(() => savePromptConfig(store, saveInput(initial, { menuSystemText: initial.menuSystemText + "\n需要人工核对。" })), /audit write failed/);
  assert.deepEqual(store.all("meta"), before);
  assert.deepEqual(store.all("audit"), []);
  assert.deepEqual(getPromptConfig(store), initial);
});

test("read-only rule origins and original text are recalculated, never trusted or persisted", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const saved = savePromptConfig(store, saveInput(initial, { rules: [
    { ...initial.rules[0], text: "运营调整：同餐候选应增加变化", origin: "source", originalText: "伪造文件原文" },
    { ...initial.rules[1], origin: "operator", originalText: "伪造历史来源" },
    { stall: "全部档口", text: "运营新增的候选轮换规则", enabled: true, origin: "source", originalText: "伪造原文" },
  ] }));
  assert.equal(saved.rules[0].origin, "override");
  assert.equal(saved.rules[0].originalText, initial.rules[0].text);
  assert.equal(saved.rules[1].origin, "source");
  assert.equal(Object.hasOwn(saved.rules[1], "originalText"), false);
  assert.equal(saved.rules[2].origin, "operator");
  assert.equal(Object.hasOwn(saved.rules[2], "originalText"), false);
  assert.ok(store.get("meta", "prompt-config:current").rules.every((rule) => !Object.hasOwn(rule, "origin") && !Object.hasOwn(rule, "originalText")));
  const noOp = savePromptConfig(store, saveInput(saved, { rules: saved.rules.map((rule) => ({ ...rule, origin: "source", originalText: "客户端伪造但正文没变" })) }));
  assert.deepEqual(noOp, saved);
  assert.equal(store.all("audit").length, 1);
});

test("source refresh traces overrides by sheet position despite changed legacy IDs and preserves edits", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const saved = savePromptConfig(store, saveInput(initial, { rules: initial.rules.map((rule, index) => index ? rule : { ...rule, text: "运营调整：同餐菜品按类别丰富选择" }) }));
  const updatedSources = seed().rules.map((rule) => ({ ...rule, text: `${rule.text}，源文件新版本要求`,
    source: { ...rule.source, fileSha256: "b".repeat(64) } }));
  store.put("meta", "rules", updatedSources);
  const view = getPromptConfig(store);
  assert.equal(view.sourceChanged, true);
  assert.equal(view.rules[0].id, saved.rules[0].id);
  assert.equal(view.rules[0].text, saved.rules[0].text);
  assert.equal(view.rules[0].originalText, updatedSources[0].text);
  assert.equal(view.rules[0].origin, "override");
  assert.equal(view.rules[1].origin, "override");
  assert.equal(view.rules[1].originalText, updatedSources[1].text);
  assert.deepEqual(getEffectiveRules(store), view.rules);
  assert.throws(() => savePromptConfig(store, saveInput(saved)), (error) => error.statusCode === 409);
  const confirmed = savePromptConfig(store, saveInput(view));
  assert.equal(confirmed.version, 2);
  assert.equal(confirmed.sourceChanged, false);
  assert.deepEqual(confirmed.rules, view.rules);
  assert.equal(store.all("audit").at(-1).sourceChanged, true);
  assert.equal(store.all("audit").at(-1).rulesChanged, false);
  assert.deepEqual(savePromptConfig(store, saveInput(confirmed)), confirmed);
  assert.equal(store.all("audit").length, 2);
});

test("restoring source text removes override label and disappearing sources never fabricate original text", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const saved = savePromptConfig(store, saveInput(initial, { rules: initial.rules.map((rule, index) => index ? rule : { ...rule, text: "运营调整菜单候选规则" }) }));
  const restored = savePromptConfig(store, saveInput(saved, { rules: saved.rules.map((rule, index) => index ? rule : { ...rule, text: initial.rules[0].text }) }));
  assert.equal(restored.rules[0].origin, "source");
  assert.equal(Object.hasOwn(restored.rules[0], "originalText"), false);
  store.put("meta", "rules", [seed().rules[1]]);
  const missing = getPromptConfig(store);
  assert.equal(missing.sourceChanged, true);
  assert.equal(missing.rules[0].origin, "override");
  assert.equal(Object.hasOwn(missing.rules[0], "originalText"), false);
});

test("a pre-baseline configuration is read without falsely reporting a source change", (t) => {
  const store = repository(t);
  const initial = getPromptConfig(store);
  const { version: _version, baseFingerprint: _base, ...texts } = saveInput(initial);
  store.put("meta", "prompt-config:current", { ...texts, version: 1, updatedAt: "2026-09-10T01:00:00Z", sourceFingerprint: initial.baseFingerprint });
  const before = store.all("meta");
  assert.equal(getPromptConfig(store).sourceChanged, false);
  assert.deepEqual(store.all("meta"), before);
});
