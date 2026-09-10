import test from "node:test";
import assert from "node:assert/strict";
import { viewIds, viewFromHash, writeViewRoute } from "../src/view-route.js";

test("known business pages and the prompt configuration page restore with a safe feedback default", () => {
  for (const id of viewIds) assert.equal(viewFromHash("#" + id), id);
  for (const hash of [undefined, null, "", "#", "#unknown", "#constructor", "#__proto__", "#%ZZ", "#menus/../../", "menus"])
    assert.equal(viewFromHash(hash), "feedback");
});

function browserAt(href) {
  const calls = [];
  const browser = { location: { href }, history: { state: { existing: "preserve" } } };
  for (const method of ["pushState", "replaceState"]) browser.history[method] = (state, title, url) => {
    calls.push({ method, state, title, url }); browser.location.href = url;
  };
  return { browser, calls };
}

test("navigation persists in the tab URL while preserving path, query and existing history state", () => {
  const { browser, calls } = browserAt("https://dining.example/workbench/?mode=local#feedback");
  assert.equal(writeViewRoute(browser, "menus"), true);
  assert.deepEqual(calls, [{ method: "pushState", state: { existing: "preserve" }, title: "", url: "https://dining.example/workbench/?mode=local#menus" }]);
  assert.equal(viewFromHash(new URL(browser.location.href).hash), "menus");
  assert.equal(writeViewRoute(browser, "menus"), false);
  assert.equal(writeViewRoute(browser, "__proto__"), false);
  assert.equal(calls.length, 1);
});

test("invalid routes normalize without adding history or affecting another browser tab", () => {
  const first = browserAt("http://localhost:4317/#invalid");
  const second = browserAt("http://localhost:4317/#actions");
  writeViewRoute(first.browser, viewFromHash("#invalid"), { replace: true });
  assert.equal(first.calls[0].method, "replaceState");
  assert.equal(first.browser.location.href, "http://localhost:4317/#feedback");
  assert.equal(second.browser.location.href, "http://localhost:4317/#actions");
  assert.equal(second.calls.length, 0);
});
