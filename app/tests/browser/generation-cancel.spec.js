import { test, expect } from "@playwright/test";

const STALL = "青禾素食";
const TITLE = "保留现有清淡素菜轮换要求";
const RUN = "RUN-CANCEL-FIXTURE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function menuPlan(weeks = 6) {
  return { id: "PLAN-CANCEL-SAVED", scope: "all", stall: "全部档口", stalls: [STALL], start: "2026-09-14", seed: 1, count: 1, meals: ["午餐"],
    createdAt: "2026-09-10T01:00:00Z", countEntries: 30,
    entries: Array.from({ length: weeks * 5 }, (_, index) => {
      const week = Math.floor(index / 5) + 1;
      const day = index % 5 + 1;
      const date = new Date("2026-09-14T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
      return { week, day, date: date.toISOString().slice(0, 10), meal: "午餐", stall: STALL, slot: 0, dishId: "D-CANCEL" };
    }), validation: { errors: 0, warnings: 0, labelCoverage: 100, changeRate: null, issues: [] },
    ...(weeks < 6 ? { partial: true, completedWeeks: weeks } : {}),
  };
}

// All business endpoints are intercepted. Only native fixture ReadableStreams
// deliver progress, so cancellation cannot reach a real model or database.
async function isolate(page) {
  const source = { id: "F-CANCEL", content: "希望午餐继续供应不辣素菜。", date: "2026-09-10", restaurant: STALL, type: "建议", category: "菜品", status: "未处理", sources: [], events: [], replies: [] };
  const action = { id: "A-CANCEL", title: TITLE, description: "原始改善事项不可因取消丢失。", menuInstruction: "每天保留一种已核验不辣素菜。", targetStall: STALL, kind: "menu", source: "aggregate", status: "approved", enabled: true, revision: 1, feedbackIds: [source.id], evidence: [], history: [] };
  const savedPlan = menuPlan();
  const state = { dishes: [{ id: "D-CANCEL", name: "清炒时蔬", stall: STALL, active: true, price: 8, priceText: "8", sources: [] }], feedback: [source], actions: [action], plans: [savedPlan], imports: [], rules: [], initialized: {}, report: { workbooks: 0, sheets: 0 }, aiStatus: { configured: true, model: "isolated-cancellation-fixture" } };
  const control = { cancelStatus: "cancelling", cancelFailure: false, holdCancel: false, recoverable: [], analysis: null };
  const log = { actions: [], cancellations: [], unexpected: [], errors: [] };
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__cancelStreams = [];
    window.fetch = (input, options) => {
      const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
      if (!/^\/api\/plans\/(generate|resume)-stream$/.test(path)) return original(input, options);
      let controller;
      const stream = { path, input: JSON.parse(options.body), aborted: false, readerCancelled: false };
      options.signal?.addEventListener("abort", () => { stream.aborted = true; });
      const body = new ReadableStream({ start(value) { controller = value; }, cancel() { stream.readerCancelled = true; } });
      stream.controller = controller;
      window.__cancelStreams.push(stream);
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
    };
  });
  page.on("pageerror", error => log.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/data") return route.fulfill({ json: state });
      if (path === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: 1, keywords: [] } });
      if (path === "/api/actions/summary") return route.fulfill({ json: { sourceCount: 1, actions: state.actions, analysis: control.analysis } });
      if (path === "/api/menu-runs") return route.fulfill({ json: control.recoverable });
      if (path === "/api/plans/PLAN-CANCEL-SAVED") return route.fulfill({ json: savedPlan });
    }
    if (request.method() === "POST" && path === "/api/actions/summarize") {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      log.actions.push({ input: request.postDataJSON(), finish });
      const cancelled = await pending;
      if (!cancelled) control.analysis = { sourceCount: 1, summary: "已完成真实反馈分析。", createdAt: "2026-09-10T02:00:00Z" };
      return route.fulfill(cancelled ? { status: 409, json: { error: "生成已取消", code: "GENERATION_CANCELLED" } } : { json: { sourceCount: 1, actions: state.actions, analysis: control.analysis } });
    }
    if (request.method() === "POST" && /^\/api\/generations\/[^/]+\/cancel$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const record = { id, finish };
      log.cancellations.push(record);
      if (control.holdCancel) await pending;
      return route.fulfill(control.cancelFailure ? { status: 503, json: { error: "取消服务暂不可用" } } : { json: { id, status: control.cancelStatus, cancelled: ["cancelling", "cancelled"].includes(control.cancelStatus) } });
    }
    log.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected cancellation fixture request" } });
  });
  return { state, control, log };
}

async function navigate(page, destination, english = true) {
  const names = english ? { actions: /Action Items/, menus: /Six-week Menus/, feedback: /^Feedback/ } : { actions: /Action 事项/, menus: /六周菜单/, feedback: /反馈中心/ };
  await page.getByRole("navigation", { name: english ? "Main navigation" : "主导航", exact: true }).getByRole("button", { name: names[destination] }).click();
}

async function startActions(page, log) {
  const count = log.actions.length + 1;
  await page.getByRole("button", { name: "Generate improvement actions", exact: true }).click();
  await expect.poll(() => log.actions.length).toBe(count);
  expect(log.actions.at(-1).input.generationId).toMatch(UUID);
  await expect(page.locator(".action-generation-wait")).toBeVisible();
  return log.actions.at(-1);
}

async function streamInput(page, index = 0) {
  await expect.poll(() => page.evaluate(() => window.__cancelStreams.length)).toBe(index + 1);
  return page.evaluate(index => window.__cancelStreams[index].input, index);
}

async function emit(page, event, index = 0) {
  await page.evaluate(({ event, index }) => {
    const controller = window.__cancelStreams[index].controller;
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    if (["error", "completed"].includes(event.type)) controller.close();
  }, { event, index });
}

function expectIsolated(log) {
  expect(log.unexpected).toEqual([]);
  expect(log.errors).toEqual([]);
}

test("Action cancellation waits for server termination, sends once, and preserves existing business content", async ({ page }) => {
  const { state, control, log } = await isolate(page);
  const original = structuredClone(state.actions);
  await page.goto("/#actions");
  await page.getByRole("button", { name: "English", exact: true }).click();
  const active = await startActions(page, log);
  control.holdCancel = true;
  const wait = page.locator(".action-generation-wait");
  await wait.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(wait.getByRole("button", { name: "Cancelling…", exact: true })).toBeDisabled();
  await wait.getByRole("button", { name: "Cancelling…", exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => log.cancellations.length).toBe(1);
  expect(log.cancellations[0].id).toBe(active.input.generationId);
  log.cancellations[0].finish();
  await expect(wait).toContainText("Waiting for confirmation that generation stopped.");
  await expect(page.locator(".action-cancelled")).toHaveCount(0);
  await navigate(page, "feedback");
  await expect(page.getByRole("button", { name: "Add feedback", exact: true })).toBeEnabled();
  await navigate(page, "actions");
  await expect(wait).toBeVisible();
  active.finish(true);
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".action-cancelled")).toHaveText("Action generation cancelled. Existing actions are unchanged.");
  await expect(page.locator(".action-error")).toHaveCount(0);
  await expect(page.locator(".action-card h3")).toHaveText(TITLE);
  await expect(page.getByRole("button", { name: "Generate improvement actions", exact: true })).toBeEnabled();
  expect(state.actions).toEqual(original);
  expectIsolated(log);
});

test("a failed Action cancellation can retry and a completed generation is not reported as cancelled", async ({ page }) => {
  const { control, log } = await isolate(page);
  await page.goto("/#actions");
  await page.getByRole("button", { name: "English", exact: true }).click();
  const active = await startActions(page, log);
  const wait = page.locator(".action-generation-wait");
  control.cancelFailure = true;
  await wait.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(wait.getByRole("alert")).toContainText("Generation is still running; you can retry cancellation.");
  await expect(wait.getByRole("button", { name: "Cancel generation", exact: true })).toBeEnabled();
  expect(log.actions).toHaveLength(1);
  control.cancelFailure = false; control.cancelStatus = "completed";
  await wait.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(wait.getByRole("button", { name: "Waiting for result…", exact: true })).toBeDisabled();
  active.finish(false);
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".action-cancelled, .action-error")).toHaveCount(0);
  await expect(page.locator(".action-analysis")).toBeVisible();
  expect(log.cancellations.map(item => item.id)).toEqual([active.input.generationId, active.input.generationId]);
  expectIsolated(log);
});

test("a late cancel response cannot change the newer Action generation", async ({ page }) => {
  const { control, log } = await isolate(page);
  await page.goto("/#actions");
  await page.getByRole("button", { name: "English", exact: true }).click();
  const first = await startActions(page, log);
  control.holdCancel = true;
  await page.locator(".action-generation-wait").getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect.poll(() => log.cancellations.length).toBe(1);
  first.finish(false);
  await expect(page.locator(".action-generation-wait")).toHaveCount(0);
  const second = await startActions(page, log);
  expect(second.input.generationId).not.toBe(first.input.generationId);
  const oldResponse = page.waitForResponse(response => response.url().endsWith(`/generations/${first.input.generationId}/cancel`));
  log.cancellations[0].finish();
  await oldResponse;
  await expect(page.locator(".action-generation-wait").getByRole("button", { name: "Cancel generation", exact: true })).toBeEnabled();
  second.finish(false);
  await expect(page.locator(".action-generation-wait")).toHaveCount(0);
  await expect(page.locator(".action-cancelled")).toHaveCount(0);
  expectIsolated(log);
});

test("cancelling one generation leaves the other active and menu cancellation retains weeks, saved drafts and resumability", async ({ page }) => {
  const { state, control, log } = await isolate(page);
  const original = structuredClone(state);
  await page.goto("/#menus");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: /^Saved drafts/ }).click();
  await page.getByRole("dialog", { name: "Saved drafts", exact: true }).locator(".history-list button").click();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await page.getByRole("button", { name: "Generate six weeks for all stalls", exact: true }).click();
  const menuInput = await streamInput(page);
  expect(menuInput.generationId).toMatch(UUID);
  await emit(page, { type: "started", runId: RUN, completedWeeks: 0, currentWeek: 1 });
  await emit(page, { type: "week", runId: RUN, completedWeeks: 1, currentWeek: 1, plan: menuPlan(1) });
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await navigate(page, "actions");
  const active = await startActions(page, log);
  expect(active.input.generationId).not.toBe(menuInput.generationId);
  await page.locator(".action-generation-wait").getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect.poll(() => log.cancellations.length).toBe(1);
  expect(log.cancellations[0].id).toBe(active.input.generationId);
  active.finish(true);
  await expect(page.locator(".action-generation-wait")).toHaveCount(0);
  await navigate(page, "menus");
  const wait = page.locator(".menu-generation-wait");
  await expect(wait).toBeVisible();
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await wait.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(wait.getByRole("button", { name: "Cancelling…", exact: true })).toBeDisabled();
  await expect.poll(() => log.cancellations.length).toBe(2);
  expect(log.cancellations[1].id).toBe(menuInput.generationId);
  expect(await page.evaluate(() => ({ aborted: window.__cancelStreams[0].aborted, readerCancelled: window.__cancelStreams[0].readerCancelled }))).toEqual({ aborted: false, readerCancelled: false });
  await emit(page, { type: "week", runId: RUN, completedWeeks: 2, currentWeek: 2, plan: menuPlan(2) });
  await expect(page.locator(".plan-week")).toHaveCount(2);
  control.recoverable = [{ id: RUN, status: "cancelled", resumable: true, completedWeeks: 2, currentWeek: 3, stage: "planning", createdAt: "2026-09-10T02:00:00Z" }];
  await emit(page, { type: "error", runId: RUN, error: "生成已取消", code: "GENERATION_CANCELLED" });
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".menu-generation-cancelled")).toContainText("Completed weeks and existing drafts are retained");
  await expect(page.locator(".menu-generation-error")).toHaveCount(0);
  await expect(page.locator(".plan-week")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Return to previous draft", exact: true })).toBeEnabled();
  await page.locator(".menu-generation-cancelled").getByRole("button", { name: "Recover generation", exact: true }).click();
  await page.getByRole("dialog", { name: "Recover generation", exact: true }).getByRole("button", { name: "Resume remaining weeks", exact: true }).click();
  const resumed = await streamInput(page, 1);
  expect(resumed).toMatchObject({ runId: RUN, generationId: expect.stringMatching(UUID) });
  expect(resumed.generationId).not.toBe(menuInput.generationId);
  await expect(page.locator(".plan-week")).toHaveCount(2);
  await emit(page, { type: "completed", runId: RUN, plan: menuPlan() }, 1);
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await expect(page.locator(".menu-generation-cancelled")).toHaveCount(0);
  expect(state).toEqual(original);
  expectIsolated(log);
});

test("Chinese menu cancellation can retry after a failed request without discarding a completed week", async ({ page }) => {
  const { control, log } = await isolate(page);
  await page.addInitScript(() => Object.defineProperty(window.crypto, "randomUUID", { value: undefined, configurable: true }));
  await page.goto("/#menus");
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  const input = await streamInput(page);
  expect(input.generationId).toMatch(UUID);
  await emit(page, { type: "week", runId: RUN, completedWeeks: 1, currentWeek: 1, plan: menuPlan(1) });
  const wait = page.locator(".menu-generation-wait");
  control.cancelFailure = true;
  await wait.getByRole("button", { name: "取消生成", exact: true }).click();
  await expect(wait.getByRole("alert")).toContainText("生成仍在继续，可重试取消");
  await expect(wait.getByRole("button", { name: "取消生成", exact: true })).toBeEnabled();
  await expect(page.locator(".plan-week")).toHaveCount(1);
  control.cancelFailure = false;
  await wait.getByRole("button", { name: "取消生成", exact: true }).click();
  await expect(wait.getByRole("button", { name: "正在取消…", exact: true })).toBeDisabled();
  await expect.poll(() => log.cancellations.length).toBe(2);
  expect(log.cancellations.map(item => item.id)).toEqual([input.generationId, input.generationId]);
  await emit(page, { type: "error", runId: RUN, error: "生成已取消", code: "GENERATION_CANCELLED" });
  await expect(wait).toHaveCount(0);
  await expect(page.locator(".menu-generation-cancelled")).toContainText("已取消六周菜单生成");
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await expect(page.locator(".menu-generation-error")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expectIsolated(log);
});
