import test from "node:test";
import assert from "node:assert/strict";
import { sourceText, translate } from "../src/i18n-text.js";
import { hydrateTranslations, cachedTranslation } from "../src/translation-cache.js";
import { normalizeWords } from "../src/wordcloud-layout.js";

test("source text remains verbatim even when it exactly matches translated UI vocabulary", () => {
  for (const source of ["服务", "口味", "午餐", "建议", "未处理", "不辣", "素食", "全部档口", "备注", "  原始中文\n保留分行与空格  ", "Already English", "中英 mixed 123", ""])
    assert.equal(sourceText(source), source);
  assert.equal(translate("en", "服务"), "Service", "Developer-owned UI labels still use the English dictionary");
  assert.equal(translate("en", "保存调整", "Save changes"), "Save changes");
  assert.equal(translate("zh", "保存调整", "Save changes"), "保存调整");
});

test("source text preserves non-string primitives and object identity without coercion or projection", () => {
  const records = Object.freeze([{ title: "中文原始事项", status: "approved", meal: "午餐", quote: "保留反馈原话" }]);
  const record = Object.freeze({ rules: Object.freeze(["规则原文"]), records });
  const symbol = Symbol("source");
  const callable = () => "source";
  for (const value of [null, undefined, true, false, 0, -0, 2.5, NaN, Infinity, 1n, symbol, callable, record, records])
    assert.ok(Object.is(sourceText(value), value));
});

test("prepared English cache cannot change any business source display", () => {
  const sources = [
    "原始行动：核验清淡蔬菜供应",
    "原始规则：同餐不得出现重复菜品",
    "原始Prompt：仅根据已批准事项排菜",
    "原始来源：排菜规则工作簿.xlsx",
    "原始核验说明：厨师已确认配方",
    "服务",
  ];
  const translations = sources.map((source, index) => ({ source, english: `Existing prepared English ${index}` }));
  hydrateTranslations(translations);
  for (const { source, english } of translations) {
    assert.equal(cachedTranslation(source)?.value, english);
    assert.equal(sourceText(source), source);
  }
  hydrateTranslations(translations.map(item => ({ ...item, english: "Replaced English cache value" })));
  for (const source of sources) assert.equal(sourceText(source), source);
});

test("word cloud keeps original Chinese, English, and mixed tokens with their exact counts", () => {
  const input = Object.freeze([
    { text: "服务", count: 5 },
    { text: "口味", count: 3 },
    { text: "Service", count: 2 },
    { text: "清淡 mild", count: 4 },
    { text: "  菜品  ", count: 1 },
  ].map(Object.freeze));
  const before = JSON.stringify(input);
  hydrateTranslations([{ source: "服务", english: "Service" }, { source: "口味", english: "Taste" }, { source: "清淡 mild", english: "Mild" }]);
  const words = normalizeWords(input.map(word => ({ ...word, text: sourceText(word.text) })));
  assert.deepEqual(words, [
    { text: "服务", count: 5 },
    { text: "清淡 mild", count: 4 },
    { text: "口味", count: 3 },
    { text: "Service", count: 2 },
    { text: "  菜品  ", count: 1 },
  ]);
  assert.equal(JSON.stringify(input), before);
});

test("word cloud combines only identical source tokens and never merges Chinese with cached English equivalents", () => {
  hydrateTranslations([{ source: "服务", english: "Service" }, { source: "服务质量", english: "Service" }]);
  const words = normalizeWords([
    { text: "服务", count: 2 }, { text: "服务", count: 3 },
    { text: "服务质量", count: 4 }, { text: "Service", count: 1 },
  ]);
  assert.deepEqual(words, [{ text: "服务", count: 5 }, { text: "服务质量", count: 4 }, { text: "Service", count: 1 }]);
});
