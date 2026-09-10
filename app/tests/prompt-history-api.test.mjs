import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { initializePromptBase } from "../server/prompt-config.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";

const snapshot = store => Object.fromEntries(COLLECTIONS.map(name => [name, store.all(name)]));
const payload = (record, changes = {}) => ({ version: record.version, baseFingerprint: record.baseFingerprint,
  actionGenerationText: record.actionGenerationText, menuSystemText: record.menuSystemText,
  approvedActionText: record.approvedActionText, rules: structuredClone(record.rules), ...changes });

function setup(t) {
  const store = createStore(":memory:", () => ({ dishes: [], feedback: [], recipes: [], inventory: [], report: {},
    rules: [{ stall: "全部档口", meal: "午餐", text: "BASE_MENU_RULE：同餐不得重复同名菜品",
      source: { file: "rules-fixture.xlsx", sheet: "rules", row: 3 } }] }));
  store.put("actions", "A-APPROVED", { id: "A-APPROVED", title: "已批准运营要求", targetStall: "全部档口",
    status: "approved", enabled: true, kind: "menu", menuInstruction: "保留中文原菜名，合理轮换菜品", revision: 1 });
  initializePromptBase(store);
  const app = createApp(store, resolve(tmpdir(), "no-prompt-history-dist"), { ai: {
    status: () => ({ configured: true, model: "no-network-fixture" }),
    respond: () => { throw new Error("Prompt management must not call AI"); },
  } });
  t.after(async () => { await app.close(); store.close(); });
  const get = url => app.inject({ url, headers: { host: "localhost" } });
  const send = (method, url, body, headers = {}) => app.inject({ method, url,
    headers: { host: "localhost", "content-type": "application/json", ...headers }, payload: body });
  return { store, app, get, send };
}

test("confirm immediately assembles edited rules, Base restore appends history without changing actions", async t => {
  const { store, get, send } = setup(t);
  const beforeRead = snapshot(store);
  const originalRules = structuredClone(store.get("meta", "rules"));
  const initial = (await get("/api/prompt-config")).json();
  const base = (await get("/api/prompt-config/history/0")).json();
  assert.equal(initial.base.version, 0);
  assert.equal(initial.base.isCurrent, true);
  assert.equal(base.operation, "base");
  assert.deepEqual(snapshot(store), beforeRead);
  const edited = "CONFIRMED_RULE：每餐优先丰富蔬菜轮换，需要核实标签";
  const result = await send("PUT", "/api/prompt-config", payload(initial, {
    menuSystemText: initial.menuSystemText + "\nCONFIRMED_INSTRUCTION：按本次规则安排菜单。",
    rules: initial.rules.map(rule => ({ ...rule, text: edited })),
  }));
  assert.equal(result.statusCode, 200);
  const confirmed = result.json();
  assert.equal(confirmed.version, 1);
  assert.equal(confirmed.base.isCurrent, false);
  assert.ok(confirmed.previews.menuSystem.includes(edited));
  assert.ok(confirmed.previews.menuSystem.includes("CONFIRMED_INSTRUCTION"));
  const savedVersion = store.get("meta", "prompt-config:version-1");
  const restoredResponse = await send("POST", "/api/prompt-config/restore-base", { version: confirmed.version, baseFingerprint: confirmed.baseFingerprint });
  assert.equal(restoredResponse.statusCode, 200);
  const restored = restoredResponse.json();
  assert.equal(restored.version, 2);
  assert.equal(restored.base.isCurrent, true);
  assert.equal(restored.menuSystemText, base.menuSystemText);
  assert.ok(restored.previews.menuSystem.includes("BASE_MENU_RULE"));
  assert.ok(!restored.previews.menuSystem.includes(edited));
  assert.deepEqual(store.get("meta", "prompt-config:version-1"), savedVersion);
  assert.deepEqual(store.all("actions"), beforeRead.actions);
  assert.deepEqual(store.get("meta", "rules"), originalRules);
  const readBefore = snapshot(store);
  const list = (await get("/api/prompt-config/history?page=1&pageSize=2")).json();
  assert.equal(list.total, 3);
  assert.deepEqual(list.items.map(item => [item.version, item.operation]), [[2, "restore-base"], [1, "confirm"]]);
  assert.ok(list.items.every(item => !Object.hasOwn(item, "menuSystemText")));
  const secondPage = (await get("/api/prompt-config/history?page=2&pageSize=2")).json();
  assert.deepEqual(secondPage.items.map(item => item.version), [0]);
  const firstHistory = (await get("/api/prompt-config/history/1")).json();
  assert.equal(firstHistory.rules[0].text, edited);
  assert.ok(firstHistory.menuSystemText.includes("CONFIRMED_INSTRUCTION"));
  assert.deepEqual(snapshot(store), readBefore);
  assert.equal(store.all("aiUsage").length, 0);
});

test("stale Base restore and malformed history requests do not write anything", async t => {
  const { store, get, send } = setup(t);
  const first = (await get("/api/prompt-config")).json();
  await send("PUT", "/api/prompt-config", payload(first, { menuSystemText: first.menuSystemText + "\nNEW_VERSION：保留既有运营决定。" }));
  const before = snapshot(store);
  const stale = await send("POST", "/api/prompt-config/restore-base", { version: first.version, baseFingerprint: first.baseFingerprint });
  assert.equal(stale.statusCode, 409);
  for (const query of ["page=0", "page=1.5", "pageSize=0", "pageSize=51", "page=1&unknown=1"])
    assert.equal((await get(`/api/prompt-config/history?${query}`)).statusCode, 400);
  for (const version of ["-1", "01", "1.5", "NaN", "9007199254740992"])
    assert.equal((await get(`/api/prompt-config/history/${version}`)).statusCode, 400);
  assert.equal((await get("/api/prompt-config/history/999")).statusCode, 404);
  for (const body of [{}, { version: 1, baseFingerprint: first.baseFingerprint, rules: [] },
    { version: -1, baseFingerprint: first.baseFingerprint }, { version: 1, baseFingerprint: "invalid" }])
    assert.equal((await send("POST", "/api/prompt-config/restore-base", body)).statusCode, 400);
  assert.equal((await send("POST", "/api/prompt-config/restore-base", { version: 1, baseFingerprint: first.baseFingerprint }, { origin: "https://untrusted.invalid" })).statusCode, 403);
  assert.deepEqual(snapshot(store), before);
});
