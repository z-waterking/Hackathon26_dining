import { test, expect } from "@playwright/test";

const NAME = "清炒时蔬";
const STALL = "青禾素食";
const OTHER_STALL = "二层风味";
const SOURCE = { file: "原始菜库.xlsx", sheet: "菜品", row: 3 };
const RECORD = { id: "D-CRUD", name: NAME, stall: STALL, english: "Seasonal vegetables", price: 8, priceText: "8元/份", unit: "份", category: "蔬菜", active: true, spicy: "不辣", vegetarian: "素食", mainIngredient: "时令蔬菜", method: "炒", calories: null, allergens: "", labelSource: "厨师已核验配方。", revision: 3, sources: [SOURCE] };

async function isolate(page, { dishOverride = {} } = {}) {
  const state = { dishes: [structuredClone(RECORD), { ...structuredClone(RECORD), id: "D-OTHER", name: "番茄炒蛋", stall: OTHER_STALL, english: "", revision: 1 }], feedback: [], actions: [], plans: [{ id: "P-HISTORY", entries: [{ dishId: RECORD.id }] }], rules: [], imports: [], initialized: {}, report: { formulaErrors: 0 }, aiStatus: { configured: false } };
  Object.assign(state.dishes[0], dishOverride);
  const recipe = { source: SOURCE, cost: 3.5, issues: [], ingredients: [{ name: "时令蔬菜", cookedGrams: 100, rawGrams: 130, pricePerKg: 6 }] };
  const log = { reads: [], writes: [], unexpected: [], errors: [] };
  const control = { fail: false, hold: false };
  page.on("pageerror", error => log.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      log.reads.push(path);
      if (path === "/api/data") return route.fulfill({ json: state });
      if (/^\/api\/recipes\/[^/]+$/.test(path)) return route.fulfill({ json: [recipe] });
    }
    const create = method === "POST" && path === "/api/dishes";
    const restore = method === "POST" && /^\/api\/dishes\/[^/]+\/restore$/.test(path);
    if (create || restore || ["PATCH", "DELETE"].includes(method) && /^\/api\/dishes\/[^/]+$/.test(path)) {
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const input = request.postDataJSON();
      log.writes.push({ method, path, input, release });
      if (control.hold) await pending;
      if (control.fail) return route.fulfill({ status: 409, json: { error: "资料已被其他操作更新，请核对后重试。" } });
      if (create) {
        const dish = { ...input, id: "D-NEW", revision: 1, origin: "manual", sources: [], priceText: `${input.price}元/${input.unit}` };
        state.dishes.push(dish);
        return route.fulfill({ json: dish });
      }
      const index = state.dishes.findIndex(dish => dish.id === path.split("/")[3]);
      const previous = state.dishes[index];
      if (input.expectedRevision !== (previous.revision || 0)) return route.fulfill({ status: 409, json: { error: "菜品版本冲突" } });
      const { expectedRevision: _revision, ...fields } = input;
      const next = method === "PATCH" ? { ...previous, ...fields, priceText: `${fields.price}元/${fields.unit}`, revision: previous.revision + 1 } : { ...previous, deletedAt: restore ? null : "2026-09-10T03:00:00Z", revision: previous.revision + 1 };
      if (method === "PATCH" && ["name", "stall", "price", "unit"].some(key => previous[key] !== next[key])) {
        next.sourceName = previous.sourceName || previous.name;
        next.sourceIdentity = previous.sourceIdentity || { name: previous.name, stall: previous.stall, price: previous.price, unit: previous.unit, priceText: previous.priceText };
      }
      state.dishes[index] = next;
      return route.fulfill({ json: next });
    }
    log.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected catalog fixture request" } });
  });
  await page.goto("/#catalog");
  return { state, recipe, log, control };
}

async function english(page) {
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dish Catalog", exact: true })).toBeVisible();
}

function row(page, name) {
  return page.locator(".work-section tbody tr").filter({ has: page.getByText(name, { exact: true }) });
}

function expectIsolated(log) {
  expect(log.unexpected).toEqual([]);
  expect(log.errors).toEqual([]);
}

test("new dishes use unknown labels and preserve manual Chinese fields while pending submission is locked", async ({ page }) => {
  const { state, log, control } = await isolate(page);
  await english(page);
  await page.getByLabel("Dish archive filter", { exact: true }).selectOption("deleted");
  await page.getByLabel("Search dishes", { exact: true }).fill("不会匹配新增菜品的原筛选");
  await page.getByRole("button", { name: "Add dish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add dish", exact: true });
  await expect(dialog.locator('select[name="spicy"]')).toHaveValue("未知");
  await expect(dialog.locator('select[name="vegetarian"]')).toHaveValue("未知");
  await expect(dialog.getByLabel("Label evidence", { exact: true })).toHaveValue("手工录入，标签待核验");
  await dialog.getByRole("button", { name: "Add dish", exact: true }).click();
  expect(log.writes).toEqual([]);
  await dialog.getByLabel("Dish name", { exact: true }).fill("手工清淡小炒");
  await dialog.getByLabel("Stall", { exact: true }).selectOption(OTHER_STALL);
  await dialog.getByLabel("English name", { exact: true }).fill("Mild stir-fry");
  await dialog.getByLabel("Price (CNY)", { exact: true }).fill("9.5");
  await dialog.getByLabel("Pricing unit", { exact: true }).fill("份");
  await dialog.getByLabel("Dish category", { exact: true }).fill("清淡菜");
  control.hold = true;
  await dialog.getByRole("button", { name: "Add dish", exact: true }).click();
  await expect.poll(() => log.writes.length).toBe(1);
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByLabel("Dish name", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.locator("form").evaluate(form => form.requestSubmit());
  expect(log.writes).toHaveLength(1);
  log.writes[0].release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Dish archive filter", { exact: true })).toHaveValue("current");
  await expect(page.getByLabel("Search dishes", { exact: true })).toHaveValue("手工清淡小炒");
  await expect(page.getByLabel("Catalog stall", { exact: true })).toHaveValue(OTHER_STALL);
  await expect(row(page, "手工清淡小炒")).toBeVisible();
  expect(log.writes[0]).toMatchObject({ method: "POST", path: "/api/dishes", input: { name: "手工清淡小炒", stall: OTHER_STALL, english: "Mild stir-fry", price: 9.5, unit: "份", category: "清淡菜", spicy: "未知", vegetarian: "未知", labelSource: "手工录入，标签待核验", active: true, calories: null } });
  expect(log.writes[0].input).not.toHaveProperty("expectedRevision");
  expect(log.writes[0].input).not.toHaveProperty("sources");
  expect(state.dishes).toHaveLength(3);
  expectIsolated(log);
});

test("editing base fields preserves source recipes and a failed update retains the exact draft for retry", async ({ page }) => {
  const { state, recipe, log, control } = await isolate(page);
  const sourceRecipe = structuredClone(recipe);
  await english(page);
  await page.getByRole("button", { name: `Edit ${NAME}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: NAME, exact: true });
  await expect(dialog.getByRole("heading", { name: "Recipe evidence · 1 versions", exact: true })).toBeVisible();
  await dialog.locator("summary").filter({ hasText: "Catalog sources" }).click();
  await expect(dialog).toContainText(SOURCE.file);
  await dialog.getByLabel("Dish name", { exact: true }).fill("调整后的时蔬");
  await dialog.getByLabel("Stall", { exact: true }).selectOption(OTHER_STALL);
  await dialog.getByLabel("English name", { exact: true }).fill("Updated seasonal vegetables");
  await dialog.getByLabel("Price (CNY)", { exact: true }).fill("10");
  await dialog.getByLabel("Pricing unit", { exact: true }).fill("碗");
  await dialog.getByLabel("Dish category", { exact: true }).fill("时令菜");
  control.fail = true;
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("资料已被其他操作更新，请核对后重试。");
  await expect(dialog.getByLabel("Dish name", { exact: true })).toHaveValue("调整后的时蔬");
  await expect(dialog.getByLabel("Price (CNY)", { exact: true })).toHaveValue("10");
  await expect(dialog.getByRole("button", { name: "Save details", exact: true })).toBeEnabled();
  expect(state.dishes[0]).toEqual(RECORD);
  control.fail = false;
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "调整后的时蔬")).toContainText(OTHER_STALL);
  expect(log.writes).toHaveLength(2);
  expect(log.writes[1].input).toMatchObject({ name: "调整后的时蔬", stall: OTHER_STALL, english: "Updated seasonal vegetables", price: 10, unit: "碗", category: "时令菜", expectedRevision: 3, labelSource: RECORD.labelSource });
  expect(state.dishes[0].sources).toEqual([SOURCE]);
  expect(recipe).toEqual(sourceRecipe);
  expect(log.writes[1].input).not.toHaveProperty("sources");
  expect(log.writes[1].input).not.toHaveProperty("origin");
  await page.getByRole("button", { name: "Edit 调整后的时蔬", exact: true }).click();
  const updated = page.getByRole("dialog", { name: "调整后的时蔬", exact: true });
  await updated.locator("summary").filter({ hasText: "Catalog sources" }).click();
  await expect(updated.locator(".catalog-source-snapshot")).toContainText(NAME);
  await expect(updated.locator(".catalog-source-snapshot")).toContainText(STALL);
  await expect(updated.locator(".catalog-source-snapshot")).toContainText(RECORD.priceText);
  await expect(updated).toContainText("Renaming or moving a dish does not approve its recipe.");
  await updated.getByRole("button", { name: "Close", exact: true }).click();
  expectIsolated(log);
});

test("delete archives after confirmation, retains history and source data, and restores from the deleted filter", async ({ page }) => {
  const { state, recipe, log, control } = await isolate(page);
  const sourcePlans = structuredClone(state.plans);
  const sourceRecipe = structuredClone(recipe);
  await english(page);
  await page.getByRole("button", { name: `Delete ${NAME}`, exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Delete dish", exact: true });
  await expect(dialog).toContainText("historical menus, recipes and source files are retained");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(log.writes).toEqual([]);
  await page.getByRole("button", { name: `Delete ${NAME}`, exact: true }).click();
  control.fail = true;
  await dialog.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.dishes[0]).not.toHaveProperty("deletedAt");
  control.fail = false; control.hold = true;
  await dialog.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect.poll(() => log.writes.length).toBe(2);
  await expect(dialog.getByRole("button", { name: "Confirm delete", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  log.writes[1].release();
  control.hold = false;
  await expect(dialog).toHaveCount(0);
  await expect(row(page, NAME)).toHaveCount(0);
  expect(state.dishes).toHaveLength(2);
  expect(state.dishes[0]).toMatchObject({ deletedAt: expect.any(String), revision: 4, sources: [SOURCE] });
  await page.getByLabel("Dish archive filter", { exact: true }).selectOption("all");
  await expect(row(page, NAME)).toContainText("Deleted · Restorable");
  await expect(page.getByRole("button", { name: `Edit ${NAME}`, exact: true })).toBeDisabled();
  await page.getByLabel("Dish archive filter", { exact: true }).selectOption("deleted");
  await expect(page.locator(".work-section tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: `Restore ${NAME}`, exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Restore dish", exact: true });
  await expect(dialog).toContainText("enabled status");
  await dialog.getByRole("button", { name: "Confirm restore", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, NAME)).toHaveCount(0);
  await page.getByLabel("Dish archive filter", { exact: true }).selectOption("current");
  await expect(row(page, NAME)).toContainText("Available");
  expect(log.writes.map(({ method, input }) => ({ method, expectedRevision: input.expectedRevision }))).toEqual([{ method: "DELETE", expectedRevision: 3 }, { method: "DELETE", expectedRevision: 3 }, { method: "POST", expectedRevision: 4 }]);
  expect(state.plans).toEqual(sourcePlans);
  expect(recipe).toEqual(sourceRecipe);
  expect(state.dishes[0].sources).toEqual([SOURCE]);
  expectIsolated(log);
});

test("Chinese catalog creation validates names and prices without translating business fields", async ({ page }) => {
  const { log } = await isolate(page);
  await page.getByRole("button", { name: "新增菜品", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增菜品", exact: true });
  await dialog.getByLabel("菜品名称", { exact: true }).fill("中文新增菜");
  await dialog.getByLabel("售价（元）", { exact: true }).fill("-1");
  await dialog.getByRole("button", { name: "新增菜品", exact: true }).click();
  expect(log.writes).toEqual([]);
  await dialog.getByLabel("售价（元）", { exact: true }).fill("10001");
  await dialog.getByRole("button", { name: "新增菜品", exact: true }).click();
  expect(log.writes).toEqual([]);
  await dialog.getByLabel("售价（元）", { exact: true }).fill("0");
  await dialog.getByLabel("菜品分类", { exact: true }).fill("服务");
  await expect(dialog.getByLabel("标签核验依据", { exact: true })).toHaveValue("手工录入，标签待核验");
  await dialog.getByRole("button", { name: "新增菜品", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(log.writes[0].input).toMatchObject({ name: "中文新增菜", price: 0, category: "服务", labelSource: "手工录入，标签待核验" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expectIsolated(log);
});

test("an existing unverified dish with empty label evidence can save basic details without asserting verified labels", async ({ page }) => {
  const { state, log } = await isolate(page, { dishOverride: { spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", allergens: "", calories: null, labelSource: "" } });
  await english(page);
  await page.getByRole("button", { name: `Edit ${NAME}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: NAME, exact: true });
  await expect(dialog.getByLabel("Label evidence", { exact: true })).toHaveValue("资料待核验");
  await expect(dialog.locator('select[name="spicy"]')).toHaveValue("未知");
  await expect(dialog.locator('select[name="vegetarian"]')).toHaveValue("未知");
  await dialog.getByLabel("Dish name", { exact: true }).fill("待核验时蔬新名称");
  await dialog.getByLabel("Price (CNY)", { exact: true }).fill("9");
  await dialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "待核验时蔬新名称")).toContainText("Spice level unverified");
  expect(log.writes).toHaveLength(1);
  expect(log.writes[0]).toMatchObject({ method: "PATCH", path: "/api/dishes/D-CRUD", input: { name: "待核验时蔬新名称", price: 9, expectedRevision: 3, labelSource: "资料待核验", spicy: "未知", vegetarian: "未知", mainIngredient: "", method: "", allergens: "", calories: null } });
  expect(log.writes[0].input).not.toHaveProperty("verifiedAt");
  expect(state.dishes[0]).not.toHaveProperty("verifiedAt");
  expectIsolated(log);
});
