import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const MENU_TITLE = "午餐增加清淡素菜轮换";
const SECOND_MENU_TITLE = "晚餐安排不同主食轮换";
const SERVICE_TITLE = "高峰期补菜响应登记";
const INSTRUCTION = "午餐每天保留一道不辣素菜，仅从现有菜库选择，并检查六周轮换频次。";

function action(id, values = {}) {
  return {
    id, source: "aggregate", kind: "menu", title: MENU_TITLE,
    description: "依据员工反馈核验现有菜库，安排清淡菜轮换并记录供应情况。",
    targetStall: "一层中餐", menuInstruction: INSTRUCTION,
    priority: "medium", status: "pending", enabled: true, demo: false,
    feedbackIds: ["F-MENU-PANEL"], evidence: [], revision: 1, history: [],
    ...values,
  };
}

// Intercept every API call before navigation. Even accidental generation calls
// receive a fixture error, so these tests never contact AI or business storage.
async function isolate(page, actions = [], { allowUpdates = false } = {}) {
  const feedback = [{
    id: "F-MENU-PANEL", content: "希望午餐有不辣素菜，晚餐主食更丰富。",
    date: "2026-09-01", restaurant: "一层中餐", type: "建议", category: "菜品",
    status: "未处理", demo: false, sources: [], events: [], replies: [],
  }];
  const state = {
    dishes: [], feedback, actions, plans: [], imports: [], rules: [],
    report: { workbooks: 0, sheets: 0, formulaErrors: 0 }, initialized: {},
    aiStatus: { configured: true, model: "menu-panel-fixture-no-network" },
  };
  const reads = [];
  const writes = [];
  const unexpected = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET") {
      reads.push(pathname);
      if (pathname === "/api/data") return route.fulfill({ json: state });
      if (pathname === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: feedback.length, keywords: [] } });
      if (pathname === "/api/actions/summary") return route.fulfill({ json: { sourceCount: feedback.length, actions: state.actions.filter(item => !item.demo), analysis: null } });
    } else {
      let input;
      try { input = request.postDataJSON(); } catch { input = request.postData(); }
      writes.push({ method: request.method(), pathname, input });
      if (allowUpdates && request.method() === "PATCH" && pathname.startsWith("/api/actions/")) {
        const id = decodeURIComponent(pathname.split("/").at(-1));
        const index = state.actions.findIndex(item => item.id === id);
        if (index >= 0) {
          const input = request.postDataJSON();
          const previous = state.actions[index];
          const next = { ...previous, ...input, revision: previous.revision + 1 };
          next.history = [...previous.history, { at: "2026-09-09T04:30:00Z", reason: input.reason, revision: next.revision, status: next.status }];
          state.actions[index] = next;
          return route.fulfill({ json: next });
        }
      }
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected API request in isolated menu Action panel test" } });
  });
  return { state, reads, writes, unexpected, errors };
}

function panelFor(page) {
  return page.getByRole("region", { name: "排菜 Action", exact: true });
}

function cardFor(panel, title) {
  return panel.getByRole("article").filter({ has: panel.page().getByRole("heading", { level: 3, name: title, exact: true }) });
}

async function expectCount(panel, label, count) {
  const metric = panel.locator("dl > div").filter({ has: panel.page().getByText(label, { exact: true }) });
  await expect(metric.locator("dd")).toHaveText(`${count}项`);
}

async function enterMenus(page) {
  await page.goto("/#menus");
  await expect(page.getByRole("heading", { level: 1, name: "全部档口六周菜单", exact: true })).toBeVisible();
  const panel = panelFor(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2, name: "排菜 Action", exact: true })).toBeVisible();
  return panel;
}

async function returnToMenus(page) {
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: /六周菜单/ }).click();
  await expect(page).toHaveURL(new RegExp("/#menus$"));
  await expect(panelFor(page)).toBeVisible();
}

async function manageAction(page, title) {
  await panelFor(page).getByRole("button", { name: "管理 Action 事项", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("/#actions$"));
  await expect(page.getByRole("heading", { level: 1, name: "Action 事项", exact: true })).toBeVisible();
  const card = page.locator("article.action-card").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
  await card.getByRole("button", { name: "查看与审批", exact: true }).click();
  return page.getByRole("dialog", { name: title, exact: true });
}

function expectIsolated(log, writeCount = 0) {
  expect(log.reads).toContain("/api/data");
  expect(log.writes).toHaveLength(writeCount);
  expect(log.unexpected).toEqual([]);
  expect(log.errors).toEqual([]);
}

test("entering six-week menus always shows the Action panel before generation, even with no actions or plan", async ({ page }) => {
  const log = await isolate(page);
  const panel = await enterMenus(page);
  await expect(panel.getByText("当前可用于排菜 0 项", { exact: true })).toBeVisible();
  await expectCount(panel, "可用于排菜", 0);
  await expect(panel.getByRole("article")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "管理 Action 事项", exact: true })).toBeEnabled();
  const generator = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await expect(generator).toBeVisible();
  const panelBounds = await panel.boundingBox();
  const generatorBounds = await generator.boundingBox();
  expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(generatorBounds.y);
  await expect(page.locator(".plan-week")).toHaveCount(0);
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  expect(log.reads).not.toContain("/api/actions/summary");
  expectIsolated(log);
});

test("approved service items are separate from two pending menu requirements", async ({ page }, testInfo) => {
  const log = await isolate(page, [
    action("A-SERVICE", { title: SERVICE_TITLE, kind: "service", status: "approved", menuInstruction: "" }),
    action("A-MENU-1"),
    action("A-MENU-2", { title: SECOND_MENU_TITLE, targetStall: "二层面食", menuInstruction: "晚餐轮换面食与杂粮主食，不突破已有档口规则。" }),
  ]);
  const panel = await enterMenus(page);
  await expectCount(panel, "已批准总数", 1);
  await expectCount(panel, "可用于排菜", 0);
  await expectCount(panel, "待审批", 2);
  await expectCount(panel, "服务及其他改善", 1);
  await expect(panel.getByText("当前可用于排菜 0 项", { exact: true })).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(2);
  for (const title of [MENU_TITLE, SECOND_MENU_TITLE]) {
    const card = cardFor(panel, title);
    await expect(card.getByRole("heading", { level: 3, name: title, exact: true })).toBeVisible();
    await expect(card.getByText("待审批", { exact: true })).toBeVisible();
    await expect(card).toContainText("尚未批准");
  }
  await expect(cardFor(panel, MENU_TITLE)).toContainText(INSTRUCTION);
  await expect(cardFor(panel, SECOND_MENU_TITLE)).toContainText("二层面食");
  await expect(cardFor(panel, SERVICE_TITLE)).toHaveCount(0);
  await expect(panel).toContainText("不用于选菜");
  await panel.locator("summary").filter({ hasText: "查看已批准的服务及其他改善" }).click();
  await expect(panel.getByText(SERVICE_TITLE, { exact: true })).toBeVisible();
  if (testInfo.project.name === "desktop") {
    const directory = resolve("data/qa/2026-09-09-menu-actions-panel");
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, "desktop.png"), fullPage: true });
  }
  expectIsolated(log);
});

test("availability requires approved enabled menu instructions and feedback, with visible exclusion reasons", async ({ page }) => {
  const log = await isolate(page, [
    action("A-READY", { status: "approved" }),
    action("A-DISABLED", { title: "暂缓晚餐轮换", status: "approved", enabled: false }),
    action("A-REJECTED", { title: "暂不采用的加餐建议", status: "rejected" }),
    action("A-EMPTY", { title: "尚待补充具体排菜要求", status: "approved", menuInstruction: "   " }),
    action("A-NO-FEEDBACK", { title: "待核对反馈来源的菜单事项", status: "approved", feedbackIds: [] }),
    action("A-DEMO", { title: "历史演示菜单事项不可见", status: "approved", demo: true }),
  ]);
  const panel = await enterMenus(page);
  await expectCount(panel, "已批准总数", 4);
  await expectCount(panel, "可用于排菜", 1);
  await expect(panel.getByRole("article")).toHaveCount(5);
  await expect(cardFor(panel, MENU_TITLE)).toContainText("已批准并启用");
  await expect(cardFor(panel, "暂缓晚餐轮换")).toContainText("已停用");
  await expect(cardFor(panel, "暂缓晚餐轮换")).toContainText("此事项未启用");
  await expect(cardFor(panel, "暂不采用的加餐建议")).toContainText("已拒绝，不参与排菜");
  await expect(cardFor(panel, "尚待补充具体排菜要求")).toContainText("尚未填写排菜要求");
  await expect(cardFor(panel, "待核对反馈来源的菜单事项")).toContainText("缺少反馈关联");
  await expect(panel).not.toContainText("历史演示菜单事项不可见");
  await page.getByRole("checkbox", { name: "启用 AI 排菜员与检验员", exact: true }).uncheck();
  await expect(panel).toContainText("当前选择本地规则生成");
  await expect(panel).toContainText("以下 Action 不参与本次排菜");
  await expectCount(panel, "可用于排菜", 1);
  await expect(cardFor(panel, MENU_TITLE)).toBeVisible();
  expectIsolated(log);
});

test("manage navigation and Action approval refresh the existing menu panel without generating", async ({ page }) => {
  const log = await isolate(page, [action("A-MENU-EDIT")], { allowUpdates: true });
  const panel = await enterMenus(page);
  await expectCount(panel, "可用于排菜", 0);
  const initialReads = log.reads.filter(path => path === "/api/data").length;
  const dialog = await manageAction(page, MENU_TITLE);
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill("已确认清淡素菜供应能力，批准下次排菜采用。");
  await dialog.getByRole("button", { name: "批准 / Approve", exact: true }).click();
  await expect(dialog).toContainText("已批准");
  await expect(dialog.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await returnToMenus(page);
  await expectCount(panel, "可用于排菜", 1);
  await expectCount(panel, "待审批", 0);
  await expect(cardFor(panel, MENU_TITLE)).toContainText("已批准并启用");
  expect(log.reads.filter(path => path === "/api/data").length).toBeGreaterThan(initialReads);
  expect(log.state.actions[0]).toMatchObject({ status: "approved", enabled: true, revision: 2 });

  const reopened = await manageAction(page, MENU_TITLE);
  await reopened.getByRole("checkbox", { name: /启用此事项/ }).uncheck();
  await reopened.getByRole("button", { name: "保存调整", exact: true }).click();
  await expect(reopened).toContainText("已停用");
  await expect(reopened.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await reopened.getByRole("button", { name: "关闭", exact: true }).click();
  await returnToMenus(page);
  await expectCount(panel, "可用于排菜", 0);
  await expect(cardFor(panel, MENU_TITLE)).toContainText("已停用");
  await expect(page.locator(".plan-week")).toHaveCount(0);
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  expect(log.writes).toEqual([
    expect.objectContaining({ method: "PATCH", pathname: "/api/actions/A-MENU-EDIT", input: expect.objectContaining({ status: "approved", enabled: true }) }),
    expect.objectContaining({ method: "PATCH", pathname: "/api/actions/A-MENU-EDIT", input: expect.objectContaining({ enabled: false }) }),
  ]);
  expectIsolated(log, 2);
});

test("reload retains menus and the Action panel, and long requirements remain reachable without horizontal overflow", async ({ page }) => {
  const longTitle = "清淡素菜轮换要求-" + "MENU_REQUIREMENT_".repeat(5);
  const longInstruction = INSTRUCTION.repeat(8) + "验收时记录实际执行结果。";
  const log = await isolate(page, [
    action("A-LONG", { title: longTitle, menuInstruction: longInstruction, status: "approved" }),
    ...Array.from({ length: 5 }, (_, index) => action(`A-LIST-${index}`, { title: `第 ${index + 1} 项菜单轮换要求` })),
  ]);
  await enterMenus(page);
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/#menus$"));
  await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: /六周菜单/ })).toHaveAttribute("aria-current", "page");
  const panel = panelFor(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(6);
  await expectCount(panel, "可用于排菜", 1);
  await expect(cardFor(panel, longTitle)).toContainText(longInstruction);
  const list = panel.getByRole("region", { name: "排菜 Action 清单", exact: true });
  await expect(list).toHaveAttribute("tabindex", "0");
  const bounds = await list.boundingBox();
  expect(bounds.height).toBeLessThanOrEqual(345);
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const last = cardFor(panel, "第 5 项菜单轮换要求");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const lastBounds = await last.boundingBox();
  const listBounds = await list.boundingBox();
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(listBounds.y + listBounds.height + 1);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(panel.getByRole("button", { name: "管理 Action 事项", exact: true })).toBeVisible();
  expectIsolated(log);
});
