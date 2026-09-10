import test from "node:test";
import assert from "node:assert/strict";

test("cache reads and hydration are synchronous and never request translations or schedule work", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw Error("Browser translation requests are forbidden"); });
  const timer = t.mock.method(globalThis, "setTimeout", () => { throw Error("Translation queue timers are forbidden"); });
  const cache = await import("../src/translation-cache.js?test=read-only");
  assert.equal(cache.cachedTranslation("尚未准备的说明"), undefined);
  assert.equal(cache.translationRevision(), 0);
  cache.hydrateTranslations([{ source: "中文说明", english: "Prepared English explanation" }]);
  assert.deepEqual(cache.cachedTranslation("中文说明"), { status: "ready", value: "Prepared English explanation" });
  for (let index = 0; index < 250; index++) assert.equal(cache.cachedTranslation("未准备的说明" + index), undefined);
  for (const removed of ["requestTranslation", "retryTranslations", "continueTranslations", "setTranslationEnabled", "translationStatus", "TRANSLATION_ALLOWANCE"]) assert.equal(cache[removed], undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(timer.mock.callCount(), 0);
});

test("workspace and dedicated Prompt translations merge by exact source and overwrite only matching entries", async () => {
  const cache = await import("../src/translation-cache.js?test=merge");
  cache.hydrateTranslations([{ source: "反馈摘要", english: "Feedback summary" }]);
  cache.hydrateTranslations([{ source: "排菜指令", english: "Menu instructions" }]);
  cache.hydrateTranslations([]);
  cache.hydrateTranslations([{ source: "反馈摘要", english: "Updated feedback summary" }]);
  assert.equal(cache.cachedTranslation("反馈摘要").value, "Updated feedback summary");
  assert.equal(cache.cachedTranslation("排菜指令").value, "Menu instructions");
  assert.equal(cache.cachedTranslation("排菜指令已修改"), undefined, "edited source cannot reuse a stale translation");
  cache.hydrateTranslations([{ source: "  原文\n", english: "  Preserved translation\n" }]);
  assert.equal(cache.cachedTranslation("  原文\n").value, "  Preserved translation\n");
  assert.equal(cache.cachedTranslation("原文"), undefined, "source spacing is significant");
});

test("hydration ignores malformed and empty values and does not mutate source or expose writable cache entries", async () => {
  const cache = await import("../src/translation-cache.js?test=validation");
  const source = Object.freeze([{ source: "已准备", english: "Prepared" }].map(Object.freeze));
  cache.hydrateTranslations(source);
  for (const malformed of [undefined, null, {}, "invalid"]) cache.hydrateTranslations(malformed);
  cache.hydrateTranslations([null, {}, { source: 1, english: "Invalid" }, { source: "", english: "Invalid" }, { source: "未准备", english: 1 }, { source: "已准备", english: "   " }, { source: "未准备", english: "" }]);
  assert.equal(cache.cachedTranslation("未准备"), undefined);
  assert.equal(cache.cachedTranslation("已准备").value, "Prepared");
  assert.equal(cache.translationRevision(), 1);
  assert.deepEqual(source, [{ source: "已准备", english: "Prepared" }]);
  assert.throws(() => { cache.cachedTranslation("已准备").value = "Accidental edit"; }, TypeError);
});

test("one hydration notifies subscribers only once and repeated API or Workbench hydration is a no-op", async () => {
  const cache = await import("../src/translation-cache.js?test=subscription");
  const snapshots = [];
  const unsubscribe = cache.subscribeTranslations(() => snapshots.push([cache.translationRevision(), cache.cachedTranslation("甲").value, cache.cachedTranslation("乙").value]));
  const translations = [{ source: "甲", english: "First" }, { source: "乙", english: "Second" }];
  cache.hydrateTranslations(translations);
  cache.hydrateTranslations(translations);
  cache.hydrateTranslations([...translations].reverse());
  assert.deepEqual(snapshots, [[1, "First", "Second"]]);
  cache.hydrateTranslations([{ source: "甲", english: "New first" }, { source: "乙", english: "New second" }]);
  assert.deepEqual(snapshots[1], [2, "New first", "New second"]);
  unsubscribe();
  cache.hydrateTranslations([{ source: "甲", english: "Third version" }]);
  assert.equal(snapshots.length, 2);
  assert.equal(cache.translationRevision(), 3);
});

test("long display text is split without dropping source characters", async () => {
  const { translationParts } = await import("../src/translation-cache.js?test=parts");
  const text = "规则中文".repeat(301) + "\n" + "后续规则".repeat(1500);
  const parts = translationParts(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(part => part.length <= 2001));
});

test("Chinese detection and source splitting use the exact pre-generation helpers", async () => {
  const cache = await import("../src/translation-cache.js?test=shared");
  const shared = await import("../shared/translation-text.mjs");
  assert.equal(cache.translationParts, shared.translationParts);
  assert.equal(cache.hasChinese, shared.hasChinese);
  assert.equal(cache.hasChinese("Mixed 中文"), true);
  for (const value of ["English text", "123", "", null, undefined]) assert.equal(cache.hasChinese(value), false);
  const source = "规则".repeat(2500);
  cache.hydrateTranslations(cache.translationParts(source).map((part, index) => ({ source: part, english: "English segment " + index })));
  assert.ok(cache.translationParts(source).every(part => cache.cachedTranslation(part)?.status === "ready"));
});
