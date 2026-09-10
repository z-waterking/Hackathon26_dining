import { test, expect } from "@playwright/test";

const pages = [
  { id: "feedback", name: "反馈中心", heading: "反馈中心" },
  { id: "actions", name: "Action 事项", heading: "Action 事项" },
  { id: "menus", name: "六周菜单", heading: "全部档口六周菜单" },
  { id: "catalog", name: "菜品资料", heading: "菜品资料" },
  { id: "analytics", name: "消费分析", heading: "消费分析" },
  { id: "prompts", name: "Prompt 与规则", heading: "Prompt 与规则" },
];
const views = Object.fromEntries(pages.map(item => [item.id, item]));

// Every API request is intercepted, including those after reload and in a
// second browser tab. Navigation cannot call a model or write business data.
async function isolate(page) {
  const state = {
    dishes: [], feedback: [], actions: [], plans: [], imports: [], rules: [],
    report: { workbooks: 0, sheets: 0, formulaErrors: 0 }, initialized: {},
    aiStatus: { configured: true, model: "navigation-fixture-no-network" },
  };
  const reads = [];
  const writes = [];
  const unexpected = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 501, json: { error: "Navigation must never write or generate" } });
    }
    reads.push(pathname);
    if (pathname === "/api/data") return route.fulfill({ json: state });
    if (pathname === "/api/prompt-config") return route.fulfill({ json: { version: 1, baseFingerprint: "navigation-fixture", actionGenerationText: "根据反馈生成可执行的改善 Action", menuSystemText: "根据菜库与规则生成全部档口的六周菜单", approvedActionText: "将已批准 Action 作为排菜要求", rules: [], previews: {}, approvedActions: [] } });
    if (pathname === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: 0, keywords: [] } });
    if (pathname === "/api/actions/summary") return route.fulfill({ json: { sourceCount: 0, actions: [], analysis: null } });
    if (pathname === "/api/pos") return route.fulfill({ json: { ranking: [], trend: [], revenue: 0, sales: 0, average: 0, coverage: 0, unmapped: 0, rows: 0 } });
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected navigation read" } });
  });
  return { reads, writes, unexpected, errors };
}

async function expectView(page, id) {
  const expected = views[id];
  await expect(page).toHaveURL(new RegExp("/#" + id + "$"));
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const selected = id === "prompts" ? page.locator(".sidebar-bottom").getByRole("button", { name: expected.name, exact: true }) : nav.getByRole("button", { name: new RegExp(expected.name) });
  await expect(selected).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button")).toHaveCount(5);
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(id === "prompts" ? 0 : 1);
  await expect(page.locator('.sidebar [aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: expected.heading, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator(".topbar")).toContainText(expected.name);
}

async function chooseView(page, id) {
  if (id === "prompts") await page.getByRole("button", { name: "Prompt 与规则", exact: true }).click();
  else await page.getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: new RegExp(views[id].name) }).click();
  await expectView(page, id);
}

function expectReadOnly(log) {
  expect(log.writes).toEqual([]);
  expect(log.unexpected).toEqual([]);
  expect(log.errors).toEqual([]);
  expect(log.reads.some(path => path === "/api/data")).toBe(true);
}

test("all five main pages and the bottom prompt page persist after reload without generating", async ({ page }) => {
  const log = await isolate(page);
  await page.goto("/#feedback");
  for (const { id } of pages) {
    await chooseView(page, id);
    await page.reload();
    await expectView(page, id);
  }
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  await expect(page.locator(".plan-week")).toHaveCount(0);
  expectReadOnly(log);
});

test("direct hash links open each intended page without restoring business forms or auto-generating", async ({ page }) => {
  const log = await isolate(page);
  for (const { id } of pages) {
    await page.goto("/#" + id);
    await expectView(page, id);
  }
  await page.goto("/#feedback");
  const privateQuery = "仅当前表单的反馈查询-不进入导航存储";
  await page.getByLabel("搜索反馈", { exact: true }).fill(privateQuery);
  await page.reload();
  await expectView(page, "feedback");
  await expect(page.getByLabel("搜索反馈", { exact: true })).toHaveValue("");
  expect(page.url()).not.toContain(privateQuery);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(privateQuery);
  expectReadOnly(log);
});

test("browser back and forward update the active navigation page without duplicating history", async ({ page }) => {
  const log = await isolate(page);
  await page.goto("/#feedback");
  await expectView(page, "feedback");
  for (const id of ["menus", "catalog", "actions", "prompts"]) await chooseView(page, id);
  // Selecting the current page should not add a redundant history entry.
  await chooseView(page, "prompts");
  await page.goBack();
  await expectView(page, "actions");
  await page.goBack();
  await expectView(page, "catalog");
  await page.goBack();
  await expectView(page, "menus");
  await page.goBack();
  await expectView(page, "feedback");
  for (const id of ["menus", "catalog", "actions", "prompts"]) {
    await page.goForward();
    await expectView(page, id);
  }
  await page.reload();
  await expectView(page, "prompts");
  expectReadOnly(log);
});

test("unknown empty and malformed hashes safely fall back to feedback", async ({ page }) => {
  const log = await isolate(page);
  for (const path of ["/", "/#", "/#not-a-real-page", "/#%E0%A4%A", "/#menus/unknown"]) {
    await page.goto(path);
    await expectView(page, "feedback");
  }
  await chooseView(page, "menus");
  await page.evaluate(() => { location.hash = "not-a-real-page"; });
  await expectView(page, "feedback");
  await page.reload();
  await expectView(page, "feedback");
  expectReadOnly(log);
});

test("separate browser tabs keep independent navigation after switching and reloading", async ({ page, context }) => {
  const first = await isolate(page);
  await page.goto("/#menus");
  await expectView(page, "menus");
  const secondPage = await context.newPage();
  const second = await isolate(secondPage);
  try {
    await secondPage.goto("/#actions");
    await expectView(secondPage, "actions");
    await chooseView(page, "catalog");
    await secondPage.reload();
    await expectView(secondPage, "actions");
    await chooseView(secondPage, "analytics");
    await page.reload();
    await expectView(page, "catalog");
    await expectView(secondPage, "analytics");
    await secondPage.goBack();
    await expectView(secondPage, "actions");
    await expectView(page, "catalog");
    expectReadOnly(first);
    expectReadOnly(second);
  } finally {
    await secondPage.close();
  }
});
