import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";
import { createSqliteAdapter } from "../server/data/sqlite-adapter.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { getPromptConfig, initializePromptBase, promptHistory, promptHistoryVersion, restorePromptBase, savePromptConfig } from "../server/prompt-config.mjs";
import { promptAdminView } from "../server/prompt-admin.mjs";

const keys = ["actionGenerationText", "menuSystemText", "approvedActionText"];
const seed = () => ({ dishes: [], feedback: [], rules: [
  { id: "R-ONE", stall: "青禾素食", text: "同餐选择真实候选且不得同名重复", enabled: true, meal: "午餐", source: { file: "排菜规则.xlsx", sheet: "规则", row: 3 } },
  { id: "R-TWO", stall: "续行", text: "跨日合理轮换不同菜品", enabled: true, meal: "晚餐", source: { file: "排菜规则.xlsx", sheet: "规则", row: 4 } },
] });
const payload = (config, changes = {}) => ({ version: config.version, baseFingerprint: config.baseFingerprint,
  ...Object.fromEntries(keys.map(key => [key, config[key]])), rules: config.rules, ...changes });
const lock = config => ({ version: config.version, baseFingerprint: config.baseFingerprint });
const content = config => ({ ...Object.fromEntries(keys.map(key => [key, config[key]])), rules: config.rules.map(({ id, stall, text, enabled, source, meal }) => ({ id, stall, text, enabled, source, meal })) });
function setup(t, adapter = createMemoryAdapter(), data = seed) {
  const store = createRepository(adapter, data);
  t.after(() => store.close());
  return store;
}
function confirmed(store, changes = {}) {
  const current = getPromptConfig(store);
  return savePromptConfig(store, payload(current, { menuSystemText: `${current.menuSystemText}\n确认版本 ${current.version + 1}：遵守真实菜库范围。`, ...changes }));
}

test("base captures unoverridden defaults and sources atomically, remains fixed, and does not change the current DTO", t => {
  const store = setup(t);
  store.put("settings", "current", { feedbackPrompt: "初始化前已有反馈指令，应作为最初默认依据", plannerPrompt: "初始化前已有菜单指令，应保留最初默认依据" });
  const initial = getPromptConfig(store);
  const overridden = { version: 4, updatedAt: "2026-09-10T01:00:00Z", ...content(initial), menuSystemText: "已确认人工覆盖文本不可以进入base" };
  overridden.rules[0].text = "人工改写规则也不能进入base";
  store.put("meta", "prompt-config:current", overridden);
  const currentBefore = getPromptConfig(store);
  const base = initializePromptBase(store);
  assert.equal(base.version, 0);
  assert.equal(base.origin, "source-defaults");
  assert.match(base.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(content(base), content(initial));
  assert.deepEqual(getPromptConfig(store), currentBefore);
  assert.deepEqual(store.all("audit"), []);
  store.put("meta", "rules", [{ ...seed().rules[0], text: "稍后刷新原始源规则" }]);
  store.put("settings", "current", { feedbackPrompt: "后改反馈默认设置不该重写base" });
  const beforeSecondInit = store.all("meta");
  assert.deepEqual(initializePromptBase(store), base);
  assert.deepEqual(store.all("meta"), beforeSecondInit);
  assert.deepEqual(promptHistoryVersion(store, 0).rules, base.rules);
  base.rules[0].text = "修改调用方对象不得修改数据库";
  assert.notEqual(promptHistoryVersion(store, 0).rules[0].text, base.rules[0].text);
});

test("read-only history and base summaries never create configuration, audit or baseline records", t => {
  const store = setup(t);
  const before = store.all("meta");
  assert.deepEqual(promptHistory(store), { items: [], total: 0, page: 1, pageSize: 10 });
  assert.throws(() => promptHistoryVersion(store, 0), error => error.statusCode === 404);
  assert.equal(promptAdminView(store).base, null);
  assert.deepEqual(store.all("meta"), before);
  assert.deepEqual(store.all("audit"), []);
  const initial = getPromptConfig(store);
  assert.deepEqual(savePromptConfig(store, payload(initial)), initial);
  assert.deepEqual(store.all("meta"), before, "a no-op save also remains completely read-only");
});

for (const [name, adapter] of [["memory", createMemoryAdapter], ["sqlite", () => createSqliteAdapter(":memory:")]]) {
  test(`${name}: confirms freeze the base and append immutable full versions with accurate summaries`, t => {
    const store = setup(t, adapter());
    const initial = getPromptConfig(store);
    const first = confirmed(store);
    const record1 = store.get("meta", "prompt-config:version-1");
    assert.deepEqual(content(promptHistoryVersion(store, 0)), content(initial));
    assert.deepEqual(content(record1), content(first));
    assert.equal(record1.operation, "confirm");
    assert.deepEqual(record1.changedPrompts, ["menuSystemText"]);
    assert.equal(record1.rulesChanged, false);
    assert.equal(record1.previousVersion, 0);
    const second = savePromptConfig(store, payload(first, { rules: [
      { ...first.rules[0], text: "修改排菜规则，确认之后生效" }, { ...first.rules[1], enabled: false },
      { stall: "全部档口", text: "新增运营规则要求记录真实缺口", enabled: true },
    ] }));
    const detail = promptHistoryVersion(store, 2);
    assert.equal(detail.operation, "confirm");
    assert.equal(detail.previousVersion, 1);
    assert.deepEqual(detail.changedPrompts, []);
    assert.equal(detail.rulesChanged, true);
    assert.equal(detail.ruleCount, 3);
    assert.equal(detail.enabledRuleCount, 2);
    assert.equal(detail.summaryAvailable, true);
    assert.deepEqual(content(detail), content(second));
    assert.deepEqual(store.get("meta", "prompt-config:version-1"), record1);
    assert.equal(store.all("audit").length, 2);
    assert.deepEqual(store.get("meta", "rules"), seed().rules);
    assert.equal(promptAdminView(store).base.isCurrent, false);
    const beforeNoOp = store.all("meta");
    assert.deepEqual(savePromptConfig(store, payload(second)), second);
    assert.deepEqual(store.all("meta"), beforeNoOp);
  });
}

test("history pagination is newest-first with base zero and validates bounded integer parameters", t => {
  const store = setup(t);
  for (let index = 0; index < 4; index++) confirmed(store);
  assert.deepEqual(promptHistory(store, { page: "1", pageSize: "2" }).items.map(item => item.version), [4, 3]);
  assert.deepEqual(promptHistory(store, { page: 2, pageSize: 2 }).items.map(item => item.version), [2, 1]);
  const last = promptHistory(store, { page: 3, pageSize: 2 });
  assert.equal(last.total, 5);
  assert.equal(last.page, 3);
  assert.equal(last.pageSize, 2);
  assert.deepEqual(last.items.map(item => item.version), [0]);
  assert.equal(last.items[0].operation, "base");
  assert.equal(last.items[0].previousVersion, null);
  assert.equal(promptHistory(store, { page: 20 }).items.length, 0);
  for (const query of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 51 }, { page: "1e3" }, { extra: true }])
    assert.throws(() => promptHistory(store, query));
  for (const version of [-1, 1.5, "../current", "1e1", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => promptHistoryVersion(store, version));
  assert.throws(() => promptHistoryVersion(store, 999), error => error.statusCode === 404);
});

test("history and fingerprints retain exact confirmed contents after source, default and Action changes", t => {
  const store = setup(t);
  const initial = getPromptConfig(store);
  confirmed(store, { rules: initial.rules.map((rule, index) => index ? rule : { ...rule, text: "确认时有效的运营规则" }) });
  const before = promptHistoryVersion(store, 1);
  const listBefore = promptHistory(store);
  store.put("meta", "rules", [{ ...seed().rules[0], text: "当前源文件全新文案不可混进历史" }]);
  store.put("settings", "current", { feedbackPrompt: "新的默认设置不可改写既存历史", operatorNotes: "私有设置不可泄露" });
  store.put("actions", "NEW-ACTION", { id: "NEW-ACTION", title: "新的业务行动不可混进历史", approved: true });
  assert.deepEqual(promptHistoryVersion(store, 1), before);
  assert.deepEqual(promptHistory(store), listBefore);
  assert.equal(Object.hasOwn(before.rules[0], "originalText"), false);
  assert.equal(Object.hasOwn(before, "approvedActions"), false);
  assert.equal(Object.hasOwn(before, "previews"), false);
});

test("legacy version 1–4 records stay byte-for-byte unchanged and safe DTOs exclude unrelated record data", t => {
  const store = setup(t);
  const initial = getPromptConfig(store);
  const originals = [];
  for (let version = 1; version <= 4; version++) {
    const record = { version, updatedAt: `2026-09-10T00:0${version}:00Z`, ...content(initial), menuSystemText: `${initial.menuSystemText}\n旧版已确认修改 ${version}`,
      aiConfig: { apiKey: "DO_NOT_EXPOSE_KEY" }, sourceSnapshot: { privateNotes: "DO_NOT_EXPOSE_SOURCE" }, actions: [{ title: "DO_NOT_EXPOSE_ACTION" }] };
    record.rules[0].apiKey = "DO_NOT_EXPOSE_RULE_KEY";
    record.rules[0].source.secret = "DO_NOT_EXPOSE_SOURCE_KEY";
    store.put("meta", `prompt-config:version-${version}`, record);
    originals.push(structuredClone(record));
  }
  store.put("meta", "prompt-config:current", originals.at(-1));
  store.put("audit", "legacy-audit-1", { kind: "prompt.config.updated", targetId: "1", previousVersion: 0, changedPrompts: ["menuSystemText"], rulesChanged: false });
  initializePromptBase(store);
  const first = promptHistoryVersion(store, 1);
  assert.equal(first.operation, "legacy");
  assert.equal(first.summaryAvailable, true);
  assert.deepEqual(first.changedPrompts, ["menuSystemText"]);
  const fourth = promptHistoryVersion(store, "4");
  assert.deepEqual(fourth.changedPrompts, ["menuSystemText"]);
  assert.equal(fourth.summaryAvailable, true);
  const serialized = JSON.stringify({ detail: fourth, history: promptHistory(store) });
  assert.equal(serialized.includes("DO_NOT_EXPOSE"), false);
  restorePromptBase(store, lock(getPromptConfig(store)));
  for (let version = 1; version <= 4; version++) assert.deepEqual(store.get("meta", `prompt-config:version-${version}`), originals[version - 1]);
  assert.equal(getPromptConfig(store).version, 5);
});

test("restore is an optimistic full configuration confirmation, preserves sources and Actions, and keeps prior versions", t => {
  const store = setup(t);
  const initial = getPromptConfig(store);
  const first = confirmed(store, { actionGenerationText: "新的反馈行动归纳指令需要保留历史", approvedActionText: "新的确定行动执行指令需要保留历史",
    rules: [initial.rules[1], { stall: "全部档口", text: "当前运营新规则待恢复base", enabled: true }] });
  const before = promptHistoryVersion(store, 1);
  const action = { id: "ACTION-KEEP", status: "approved", enabled: true, title: "已确认业务行动保持原状" };
  store.put("actions", action.id, action);
  store.put("meta", "rules", [{ ...seed().rules[0], text: "source刷新后也不得被restore覆盖" }]);
  const sourceBefore = store.get("meta", "rules");
  assert.throws(() => restorePromptBase(store, lock(first)), error => error.statusCode === 409);
  const restored = restorePromptBase(store, lock(getPromptConfig(store)));
  assert.equal(restored.version, 2);
  assert.deepEqual(content(restored), content(initial));
  assert.deepEqual(store.get("meta", "rules"), sourceBefore);
  assert.deepEqual(store.get("actions", action.id), action);
  assert.deepEqual(promptHistoryVersion(store, 1), before);
  const second = promptHistoryVersion(store, 2);
  assert.equal(second.operation, "restore-base");
  assert.equal(second.previousVersion, 1);
  assert.deepEqual(second.changedPrompts, keys);
  assert.equal(second.rulesChanged, true);
  assert.equal(second.fingerprint, promptHistoryVersion(store, 0).fingerprint);
  assert.equal(promptAdminView(store).base.isCurrent, true);
  assert.equal(store.all("audit").at(-1).kind, "prompt.config.restored");
  const after = store.all("meta");
  assert.deepEqual(restorePromptBase(store, lock(restored)), restored);
  assert.deepEqual(store.all("meta"), after);
  assert.throws(() => restorePromptBase(store, lock(first)), error => error.statusCode === 409);
});

test("base, current, history and audit are one atomic save and rollback together on failure", t => {
  const adapter = createMemoryAdapter();
  const store = setup(t, { ...adapter, put(collection, id, value) {
    if (collection === "audit") throw new Error("history audit failure");
    return adapter.put(collection, id, value);
  } });
  const before = store.all("meta");
  assert.throws(() => confirmed(store), /history audit failure/);
  assert.deepEqual(store.all("meta"), before);
  assert.equal(store.get("meta", "prompt-config:base"), null);
  assert.deepEqual(store.all("audit"), []);
});

test("restoration rollback keeps previous content and history when auditing fails", t => {
  const adapter = createMemoryAdapter();
  let fail = false;
  const store = setup(t, { ...adapter, put(collection, id, value) {
    if (fail && collection === "audit") throw new Error("restore audit failure");
    return adapter.put(collection, id, value);
  } });
  const saved = confirmed(store);
  const before = store.all("meta");
  const audits = store.all("audit");
  fail = true;
  assert.throws(() => restorePromptBase(store, lock(saved)), /restore audit failure/);
  assert.deepEqual(store.all("meta"), before);
  assert.deepEqual(store.all("audit"), audits);
  assert.deepEqual(getPromptConfig(store), saved);
});

test("an existing immutable version key cannot be overwritten or partially update current and base", t => {
  const store = setup(t);
  const initial = getPromptConfig(store);
  const version1 = { version: 1, ...content(initial), marker: "KEEP_EXISTING_RECORD" };
  store.put("meta", "prompt-config:version-1", version1);
  const before = store.all("meta");
  assert.throws(() => confirmed(store), error => error.statusCode === 409);
  assert.deepEqual(store.all("meta"), before);
  assert.deepEqual(store.get("meta", "prompt-config:version-1"), version1);
});

test("empty source base can be initialized for traceability but cannot restore invalid executable rules", t => {
  const store = setup(t, createMemoryAdapter(), () => ({ feedback: [], dishes: [], rules: [] }));
  const base = initializePromptBase(store);
  assert.deepEqual(base.rules, []);
  assert.equal(promptHistory(store).total, 1);
  const before = store.all("meta");
  assert.throws(() => restorePromptBase(store, lock(getPromptConfig(store))));
  assert.deepEqual(store.all("meta"), before);
  assert.equal(store.get("meta", "prompt-config:current"), null);
});

test("SQLite reopening preserves base, confirmed and restored versions and legacy history without reseeding", t => {
  const directory = mkdtempSync(join(tmpdir(), "dining-prompt-history-"));
  const filename = join(directory, "history.sqlite");
  let store = createRepository(createSqliteAdapter(filename), seed);
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = getPromptConfig(store);
  const legacy = { version: 1, updatedAt: "2026-09-10T00:00:00Z", ...content(initial), menuSystemText: "旧有持久化排菜指令必须保留历史" };
  store.put("meta", "prompt-config:version-1", legacy);
  store.put("meta", "prompt-config:current", legacy);
  const base = initializePromptBase(store);
  const second = confirmed(store);
  const history = promptHistory(store);
  store.close();
  store = null;
  store = createRepository(createSqliteAdapter(filename), () => { throw new Error("must not reseed a persisted repository"); });
  assert.deepEqual(initializePromptBase(store), base);
  assert.deepEqual(store.get("meta", "prompt-config:version-1"), legacy);
  assert.deepEqual(getPromptConfig(store), second);
  assert.deepEqual(promptHistory(store), history);
  const restored = restorePromptBase(store, lock(second));
  assert.equal(restored.version, 3);
  const beforeClose = { meta: store.all("meta"), audit: store.all("audit"), current: getPromptConfig(store), history: promptHistory(store) };
  store.close();
  store = null;
  store = createRepository(createSqliteAdapter(filename), () => { throw new Error("must not reseed after restoration"); });
  assert.deepEqual({ meta: store.all("meta"), audit: store.all("audit"), current: getPromptConfig(store), history: promptHistory(store) }, beforeClose);
  assert.deepEqual(content(getPromptConfig(store)), content(base));
});
