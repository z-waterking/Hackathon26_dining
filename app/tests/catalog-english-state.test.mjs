import test from "node:test";
import assert from "node:assert/strict";
import { englishNameState, isValidEnglishName } from "../shared/catalog-english-state.mjs";

test("English text validation rejects source-language text, controls, empty or oversized values", () => {
  for (const value of [undefined, null, 42, "", "  ", "中文", "Tofu 豆腐", "123", "---", "Sou\np", `Soup${String.fromCharCode(0)}`, `Soup${String.fromCharCode(127)}`, "a".repeat(201)]) {
    assert.equal(isValidEnglishName(value), false, String(value));
  }
  for (const value of ["Tomato & egg", "Mapo tofu (mild)", "Crème brûlée", " Soup ", "a".repeat(200)]) {
    assert.equal(isValidEnglishName(value), true, value);
  }
});

test("missing names stay missing regardless of old metadata", () => {
  for (const english of [undefined, null, "", "  ", String.fromCharCode(9, 10, 32)]) {
    assert.equal(englishNameState({ name: "冬瓜汤", english, englishName: { sourceName: "旧名", origin: "ai", status: "needs_review" } }), "missing");
  }
});

test("legacy and valid manually maintained names are ready, but invalid and stale records require review", () => {
  const dish = { name: " 冬瓜汤 ", english: "Winter melon soup" };
  assert.equal(englishNameState(dish), "ready");
  assert.equal(englishNameState({ ...dish, englishName: { sourceName: "冬瓜汤", origin: "manual", status: "ready" } }), "ready");
  assert.equal(englishNameState({ ...dish, englishName: { sourceName: "原来的菜名", origin: "source", status: "ready" } }), "needs_review");
  assert.equal(englishNameState({ ...dish, englishName: { sourceName: "冬瓜汤", origin: "manual", status: "needs_review" } }), "needs_review");
  assert.equal(englishNameState({ ...dish, english: "Winter melon 冬瓜", englishName: { origin: "source", status: "ready" } }), "needs_review");
});

test("AI names always require review even with missing or inconsistent legacy status", () => {
  for (const status of [undefined, "ready", "missing", "needs_review"]) {
    assert.equal(englishNameState({ name: "冬瓜汤", english: "Winter melon soup", englishName: { sourceName: "冬瓜汤", origin: "ai", status } }), "needs_review");
  }
});
