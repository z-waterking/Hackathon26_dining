import { test, expect } from "@playwright/test";
import { englishNameState } from "../../shared/catalog-english-state.mjs";

const STALL = "青禾素食";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE = { stall: STALL, price: 8, priceText: "8元/份", unit: "份", category: "蔬菜", active: true, spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", calories: null, allergens: "", labelSource: "资料待核验", revision: 1, sources: [] };
const NOW = "2026-09-10T03:00:00Z";
const names = { source: "清炒时蔬", manual: "番茄炒蛋", ai: "香菇青菜", missing: "冬瓜汤", renamed: "清蒸南瓜" };

function summary(state, extra = {}) {
  const dishes = state.dishes.filter(dish => !dish.deletedAt);
  const missing = dishes.filter(dish => englishNameState(dish) === "missing").length;
  const needsReview = dishes.filter(dish => englishNameState(dish) === "needs_review").length;
  return { total: dishes.length, ready: dishes.length - missing - needsReview, missing, needsReview, uniqueMissing: missing, filled: 0, reused: 0, generated: 0, batches: 0, ...extra };
}

// Every business request is isolated. No request reaches a real model,
// production cancellation endpoint, or the persistent local database.
async function isolate(page) {
  const state = { dishes: [
    { ...BASE, id: "D-SOURCE", name: names.source, english: "Seasonal vegetables" },
    { ...BASE, id: "D-MANUAL", name: names.manual, english: "Tomato and egg", englishName: { sourceName: names.manual, origin: "manual", status: "ready", updatedAt: NOW } },
    { ...BASE, id: "D-AI", name: names.ai, english: "Mushrooms and greens", englishName: { sourceName: names.ai, origin: "ai", status: "needs_review", updatedAt: NOW } },
    { ...BASE, id: "D-MISSING", name: names.missing, english: "", englishName: { sourceName: names.missing, status: "missing" } },
    { ...BASE, id: "D-RENAMED", name: names.renamed, english: "", englishName: { sourceName: names.renamed, status: "missing" }, englishHistory: [{ sourceName: "南瓜汤", english: "Pumpkin soup", origin: "source", updatedAt: NOW }] },
    { ...BASE, id: "D-DELETED", name: "已归档菜品", english: "", deletedAt: NOW },
  ], feedback: [], actions: [], plans: [], rules: [], imports: [], initialized: {}, report: { formulaErrors: 0 }, aiStatus: { configured: true, model: "isolated-english-fixture" } };
  const log = { reads: [], writes: [], generations: [], cancellations: [], unexpected: [], errors: [] };
  const control = { cancelFailure: false, holdCancel: false, cancelStatus: "cancelling" };
  page.on("pageerror", error => log.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      log.reads.push(path);
      if (path === "/api/data") return route.fulfill({ json: state });
      if (path === "/api/dishes/english-summary") return route.fulfill({ json: summary(state) });
      if (path === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: 0, keywords: [] } });
      if (/^\/api\/recipes\/[^/]+$/.test(path)) return route.fulfill({ json: [] });
    }
    if (method === "POST" && path === "/api/dishes/prepare-english") {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      log.generations.push({ input: request.postDataJSON(), finish });
      return route.fulfill(await pending);
    }
    if (method === "POST" && /^\/api\/generations\/[^/]+\/cancel$/.test(path)) {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const id = decodeURIComponent(path.split("/")[3]);
      log.cancellations.push({ id, finish });
      if (control.holdCancel) await pending;
      return route.fulfill(control.cancelFailure ? { status: 503, json: { error: "取消服务暂不可用" } } : { json: { id, status: control.cancelStatus, cancelled: ["cancelling", "cancelled"].includes(control.cancelStatus) } });
    }
    const create = method === "POST" && path === "/api/dishes";
    if (create || method === "PATCH" && /^\/api\/dishes\/[^/]+$/.test(path)) {
      const input = request.postDataJSON();
      log.writes.push({ method, path, input });
      const previous = create ? null : state.dishes.find(dish => dish.id === path.split("/")[3]);
      if (previous && input.expectedRevision !== previous.revision) return route.fulfill({ status: 409, json: { error: "菜品版本冲突" } });
      const { expectedRevision: _revision, ...fields } = input;
      const dish = { ...(previous || {}), ...fields, id: previous?.id || `D-NEW-${log.writes.length}`, revision: (previous?.revision || 0) + 1 };
      if (previous && previous.name !== dish.name) {
        dish.englishHistory = [...(previous.englishHistory || []), { sourceName: previous.name, english: previous.english, ...previous.englishName }];
        dish.english = "";
        dish.englishName = { sourceName: dish.name, status: "missing", updatedAt: NOW };
      } else if (!previous || previous.english !== dish.english) {
        dish.englishName = { sourceName: dish.name, origin: "manual", status: dish.english ? "ready" : "missing", updatedAt: NOW };
      }
      if (create) state.dishes.push(dish);
      else state.dishes[state.dishes.indexOf(previous)] = dish;
      return route.fulfill({ json: dish });
    }
    log.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected English-name fixture request" } });
  });
  await page.goto("/#catalog");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dish Catalog", exact: true })).toBeVisible();
  return { state, log, control };
}

function row(page, name) {
  return page.locator(".work-section tbody tr").filter({ has: page.getByText(name, { exact: true }) });
}

function saveBatch(state, id = "D-MISSING", english = "Winter melon soup") {
  const dish = state.dishes.find(item => item.id === id);
  Object.assign(dish, { english, revision: dish.revision + 1, englishName: { sourceName: dish.name, origin: "ai", status: "needs_review", updatedAt: NOW, model: "isolated-english-fixture", requestId: "fixture-batch" } });
}

async function start(page, log) {
  const count = log.generations.length + 1;
  await page.getByRole("button", { name: "Complete English names", exact: true }).click();
  await expect.poll(() => log.generations.length).toBe(count);
  expect(log.generations.at(-1).input.generationId).toMatch(UUID);
  await expect(page.locator(".catalog-english-wait")).toBeVisible();
  return log.generations.at(-1);
}

function expectIsolated(log) {
  expect(log.unexpected).toEqual([]);
  expect(log.errors).toEqual([]);
}

test("opening, reloading and switching UI language never prepare names; statuses and filters use stored records", async ({ page }) => {
  const { log } = await isolate(page);
  const panel = page.getByRole("region", { name: "Dish English-name maintenance", exact: true });
  await expect(panel).toContainText("5 items · 2 ready English names · 2 missing · 1 English names to review");
  await expect(panel).toContainText("may call paid AI");
  await expect(row(page, names.source)).toContainText("Source English name");
  await expect(row(page, names.manual)).toContainText("Manually maintained English name");
  await expect(row(page, names.ai)).toContainText("AI name · Review required");
  await expect(row(page, names.renamed)).toContainText("Name changed · English name needed");
  const filter = page.getByLabel("English-name status filter", { exact: true });
  await filter.selectOption("missing");
  await expect(page.locator(".work-section tbody tr")).toHaveCount(2);
  await expect(row(page, names.missing)).toBeVisible();
  await filter.selectOption("needs_review");
  await expect(page.locator(".work-section tbody tr")).toHaveCount(1);
  await expect(row(page, names.ai)).toBeVisible();
  await filter.selectOption("ready");
  await expect(page.locator(".work-section tbody tr")).toHaveCount(2);
  await filter.selectOption("all");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(row(page, names.source)).toContainText("Seasonal vegetables");
  await expect(row(page, names.ai)).toContainText("AI 译名 · 待复核");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.reload();
  await expect(row(page, names.source)).toContainText("Seasonal vegetables");
  expect(log.generations).toEqual([]);
  expect(log.writes).toEqual([]);
  expectIsolated(log);
});

test("manual creation and editing use CRUD only, while unchanged AI text remains unreviewed", async ({ page }) => {
  const { state, log } = await isolate(page);
  await page.getByRole("button", { name: `Edit ${names.ai}`, exact: true }).click();
  let dialog = page.getByRole("dialog", { name: names.ai, exact: true });
  await expect(dialog).toContainText("Viewing or saving unchanged text does not approve an AI name.");
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, names.ai)).toContainText("AI name · Review required");
  await page.getByRole("button", { name: `Edit ${names.ai}`, exact: true }).click();
  dialog = page.getByRole("dialog", { name: names.ai, exact: true });
  await dialog.getByLabel("English name", { exact: true }).fill("Shiitake mushrooms with greens");
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, names.ai)).toContainText("Manually maintained English name");
  expect(state.dishes.find(dish => dish.id === "D-AI")).toMatchObject({ name: names.ai, english: "Shiitake mushrooms with greens", englishName: { origin: "manual", status: "ready" } });
  await page.getByRole("button", { name: "Add dish", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add dish", exact: true });
  await dialog.getByLabel("Dish name", { exact: true }).fill("新增手工菜");
  await dialog.getByLabel("Price (CNY)", { exact: true }).fill("9");
  await expect(dialog.getByLabel("English name", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Add dish", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "新增手工菜")).toContainText("English name missing");
  expect(log.writes).toHaveLength(3);
  expect(log.generations).toEqual([]);
  expectIsolated(log);
});

test("explicit English preparation is duplicate-safe, permits CRUD and other pages, then displays saved batches", async ({ page }) => {
  const { state, log } = await isolate(page);
  const originalNames = state.dishes.map(dish => dish.name);
  const originalEnglish = state.dishes.slice(0, 3).map(dish => dish.english);
  const generation = await start(page, log);
  const button = page.getByRole("button", { name: "Completing English names…", exact: true });
  await expect(button).toBeDisabled();
  await button.evaluate(element => { element.click(); element.click(); });
  expect(log.generations).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Add dish", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: `Edit ${names.source}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: names.source, exact: true });
  await dialog.getByLabel("Price (CNY)", { exact: true }).fill("10");
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await navigation.getByRole("button", { name: /^Feedback/ }).click();
  await expect(page.getByRole("button", { name: "Add feedback", exact: true })).toBeEnabled();
  await navigation.getByRole("button", { name: /Dish Catalog/ }).click();
  await expect(page.locator(".catalog-english-wait")).toBeVisible();
  saveBatch(state);
  saveBatch(state, "D-RENAMED", "Steamed pumpkin");
  generation.finish({ json: summary(state, { filled: 2, reused: 0, generated: 2, batches: 1 }) });
  await expect(page.locator(".catalog-english-wait")).toHaveCount(0);
  await expect(page.locator(".catalog-english-result")).toHaveText("2 items filled · 0 reused · 2 generated · 1 batches completed");
  await expect(page.locator(".catalog-english-summary")).toHaveText("5 items · 2 ready English names · 0 missing · 3 English names to review");
  await expect(row(page, names.missing)).toContainText("Winter melon soup");
  await expect(page.getByRole("button", { name: "Complete English names", exact: true })).toBeDisabled();
  expect(state.dishes.map(dish => dish.name)).toEqual(originalNames);
  expect(state.dishes.slice(0, 3).map(dish => dish.english)).toEqual(originalEnglish);
  expect(state.dishes.find(dish => dish.id === "D-DELETED").english).toBe("");
  expectIsolated(log);
});

test("English cancellation can retry failures and waits for original termination while retaining saved batches", async ({ page }) => {
  const { state, log, control } = await isolate(page);
  const generation = await start(page, log);
  const wait = page.locator(".catalog-english-wait");
  control.cancelFailure = true;
  await wait.getByRole("button", { name: "Cancel English-name completion", exact: true }).click();
  await expect(wait.getByRole("alert")).toContainText("Cancellation was not confirmed");
  await expect(wait.getByRole("button", { name: "Cancel English-name completion", exact: true })).toBeEnabled();
  control.cancelFailure = false;
  await wait.getByRole("button", { name: "Cancel English-name completion", exact: true }).click();
  await expect.poll(() => log.cancellations.length).toBe(2);
  expect(log.cancellations.every(item => item.id === generation.input.generationId)).toBe(true);
  await expect(wait.getByRole("button", { name: "Cancelling…", exact: true })).toBeDisabled();
  await expect(page.locator(".catalog-english-result")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Completing English names…", exact: true })).toBeDisabled();
  saveBatch(state);
  generation.finish({ status: 409, json: { error: "生成已取消", code: "GENERATION_CANCELLED" } });
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".catalog-english-result")).toHaveText("English-name completion cancelled. Completed batches remain in the local database.");
  await expect(row(page, names.missing)).toContainText("Winter melon soup");
  await expect(page.locator(".catalog-english-summary")).toContainText("1 missing · 2 English names to review");
  await expect(page.getByRole("button", { name: "Complete English names", exact: true })).toBeEnabled();
  await expect(page.locator(".catalog-english-error")).toHaveCount(0);
  expectIsolated(log);
});

test("later-batch failures refresh saved names and allow an explicit retry for the remaining missing name", async ({ page }) => {
  const { state, log } = await isolate(page);
  const first = await start(page, log);
  saveBatch(state);
  first.finish({ status: 502, json: { error: "后续批次暂不可用" } });
  await expect(page.locator(".catalog-english-wait")).toHaveCount(0);
  await expect(page.locator(".catalog-english-error")).toContainText("Retry the remaining missing names; saved batches are retained.");
  await expect(row(page, names.missing)).toContainText("Winter melon soup");
  await expect(row(page, names.renamed)).toContainText("Name changed · English name needed");
  await expect(page.locator(".catalog-english-summary")).toContainText("1 missing · 2 English names to review");
  const second = await start(page, log);
  expect(second.input.generationId).not.toBe(first.input.generationId);
  saveBatch(state, "D-RENAMED", "Steamed pumpkin");
  second.finish({ json: summary(state, { filled: 1, reused: 1, generated: 0, batches: 0 }) });
  await expect(page.locator(".catalog-english-error")).toHaveCount(0);
  await expect(page.locator(".catalog-english-result")).toHaveText("1 items filled · 1 reused · 0 generated · 0 batches completed");
  await expect(row(page, names.renamed)).toContainText("Steamed pumpkin");
  expect(log.generations).toHaveLength(2);
  expectIsolated(log);
});

test("a late cancellation response cannot alter a later English preparation operation", async ({ page }) => {
  const { state, log, control } = await isolate(page);
  const first = await start(page, log);
  control.holdCancel = true;
  await page.getByRole("button", { name: "Cancel English-name completion", exact: true }).click();
  await expect.poll(() => log.cancellations.length).toBe(1);
  saveBatch(state);
  first.finish({ json: summary(state, { filled: 1, generated: 1, batches: 1 }) });
  await expect(page.locator(".catalog-english-wait")).toHaveCount(0);
  const second = await start(page, log);
  const oldResponse = page.waitForResponse(response => response.url().endsWith(`/generations/${first.input.generationId}/cancel`));
  log.cancellations[0].finish();
  await oldResponse;
  await expect(page.getByRole("button", { name: "Cancel English-name completion", exact: true })).toBeEnabled();
  saveBatch(state, "D-RENAMED", "Steamed pumpkin");
  second.finish({ json: summary(state, { filled: 1, generated: 1, batches: 1 }) });
  await expect(page.locator(".catalog-english-wait")).toHaveCount(0);
  await expect(page.locator(".catalog-english-result")).toContainText("1 items filled");
  expectIsolated(log);
});

test("invalid and stale source names require review without overwriting existing text or pretending they are AI output", async ({ page }) => {
  const { state, log } = await isolate(page);
  state.dishes[0].english = "中文 mixed text";
  state.dishes[1].englishName.sourceName = "历史菜名";
  delete state.dishes[2].englishName.status;
  await page.reload();
  await expect(page.locator(".catalog-english-summary")).toContainText("5 items · 0 ready English names · 2 missing · 3 English names to review");
  await expect(row(page, names.source)).toContainText("中文 mixed text");
  await expect(row(page, names.source)).toContainText("English name · Review required");
  await expect(row(page, names.manual)).toContainText("English name · Review required");
  await expect(row(page, names.ai)).toContainText("AI name · Review required");
  await page.getByLabel("English-name status filter", { exact: true }).selectOption("needs_review");
  await expect(page.locator(".work-section tbody tr")).toHaveCount(3);
  expect(log.generations).toEqual([]);
  expect(log.writes).toEqual([]);
  expectIsolated(log);
});
