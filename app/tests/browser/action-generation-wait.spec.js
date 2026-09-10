import { test, expect } from "@playwright/test";

async function prepare(page) {
  const data = await (await page.request.get("/api/data")).json();
  const feedback = { id: "F-WAIT", content: "希望增加清淡素菜", date: "2026-09-09", restaurant: "全部档口", events: [], sources: [], type: "建议" };
  const state = { ...data, feedback: [feedback], actions: [], aiStatus: { configured: true } };
  await page.route("**/api/actions/summary?*", (route) => route.fulfill({ json: { analysis: null, actions: state.actions, sourceCount: 1 } }));
  return { state, feedback };
}

test("generation animation stays on Action page while other pages remain usable", async ({ page }, testInfo) => {
  const { state, feedback } = await prepare(page);
  let finishGeneration;
  let finishRefresh;
  let refreshing = false;
  let generated = false;
  let calls = 0;
  const generation = new Promise((resolve) => { finishGeneration = resolve; });
  const refresh = new Promise((resolve) => { finishRefresh = resolve; });
  await page.route("**/api/data", async (route) => {
    if (generated) { refreshing = true; await refresh; }
    await route.fulfill({ json: state });
  });
  await page.route("**/api/actions/summarize", async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({ month: "", demo: false, force: true });
    await generation;
    state.actions = [{ id: "A-WAIT", source: "aggregate", demo: false, title: "增加清淡素菜", description: "核验菜库，试行增加清淡素菜并收集评价。", targetStall: "全部档口", feedbackIds: [feedback.id], evidence: [{ feedbackId: feedback.id, quote: feedback.content }], status: "pending", revision: 1 }];
    generated = true;
    await route.fulfill({ json: { sourceCount: 1, actions: state.actions, analysis: { sourceCount: 1, summary: "清淡素菜需求", createdAt: new Date().toISOString() } } });
  });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  const trigger = page.getByRole("button", { name: "AI 生成改善事项", exact: true });
  await trigger.click();
  const waiting = page.getByRole("region", { name: "正在生成改善事项", exact: true });
  await expect(waiting).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(waiting).toContainText("1 条真实反馈");
  await expect(waiting.getByRole("status")).toContainText("完成后将自动显示结果");
  await expect(waiting).toContainText("可切换到其他页面继续操作");
  await expect(page.locator(".action-page-heading > button")).toBeDisabled();
  expect(await waiting.locator(".action-wait-ring").first().evaluate((element) => getComputedStyle(element).animationName)).toBe("action-spin");
  await page.keyboard.press("Escape");
  await expect(waiting).toBeVisible();
  expect(calls).toBe(1);
  const bounds = await waiting.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(await waiting.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  await page.screenshot({ path: testInfo.outputPath("action-generation-wait.png") });
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("button", { name: /反馈中心/ }).click();
  await expect(page.getByRole("heading", { name: "反馈中心", exact: true })).toBeVisible();
  await expect(page.locator(".action-generation-wait")).toBeHidden();
  await expect(page.getByLabel("上传旧表 Excel", { exact: true })).toBeEnabled();
  await navigation.getByRole("button", { name: /菜品资料/ }).click();
  await page.getByRole("button", { name: "资料清单", exact: true }).click();
  const materials = page.getByRole("dialog", { name: "资料读取清单" });
  await expect(materials).toBeVisible();
  await materials.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText("资料清单已读取");
  await navigation.getByRole("button", { name: /Action 事项/ }).click();
  await expect(waiting).toBeVisible();
  expect(calls).toBe(1);
  finishGeneration();
  await expect.poll(() => refreshing).toBe(true);
  await expect(waiting).toBeVisible();
  await navigation.getByRole("button", { name: /菜品资料/ }).click();
  await page.getByLabel("搜索菜品").fill("青菜");
  finishRefresh();
  await expect(page.locator(".action-generation-wait")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "菜品资料", exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索菜品")).toBeFocused();
  await expect(page.getByLabel("搜索菜品")).toHaveValue("青菜");
  await navigation.getByRole("button", { name: /Action 事项/ }).click();
  await expect(page.locator(".action-card")).toContainText("增加清淡素菜");
  await expect(trigger).toBeEnabled();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("background failure clears only the local animation and preserves navigation and focus", async ({ page }) => {
  const { state } = await prepare(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/data", (route) => route.fulfill({ json: state }));
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  await page.route("**/api/actions/summarize", async (route) => { await pending; await route.fulfill({ status: 502, json: { error: "Azure AI 请求超时，请稍后重试" } }); });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  await page.getByRole("button", { name: "AI 生成改善事项", exact: true }).click();
  const waiting = page.getByRole("region", { name: "正在生成改善事项" });
  await expect(waiting).toBeVisible();
  expect(await waiting.locator(".action-wait-ring").first().evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.getByRole("navigation").getByRole("button", { name: /反馈中心/ }).click();
  await page.getByLabel("搜索反馈").fill("清淡");
  finish();
  await expect(page.locator(".action-generation-wait")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "反馈中心", exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索反馈")).toBeFocused();
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  await expect(page.locator(".action-module").getByRole("alert")).toContainText("请求超时");
  await expect(page.getByRole("button", { name: "AI 生成改善事项", exact: true })).toBeEnabled();
  expect(await page.locator(".action-card").count()).toBe(0);
});

test("an older foreground refresh cannot overwrite completed background generation", async ({ page }) => {
  const { state, feedback } = await prepare(page);
  let finishGeneration;
  let finishOlderRefresh;
  let holdOlderRefresh = false;
  let olderRefreshStarted = false;
  const generation = new Promise((resolve) => { finishGeneration = resolve; });
  const olderRefresh = new Promise((resolve) => { finishOlderRefresh = resolve; });
  await page.route("**/api/data", async (route) => {
    const snapshot = JSON.stringify(state);
    if (holdOlderRefresh) { holdOlderRefresh = false; olderRefreshStarted = true; await olderRefresh; }
    await route.fulfill({ contentType: "application/json", body: snapshot });
  });
  await page.route("**/api/actions/summarize", async (route) => {
    await generation;
    state.actions = [{ id: "A-CONCURRENT", source: "aggregate", title: "最新生成事项", feedbackIds: [feedback.id], status: "pending" }];
    await route.fulfill({ json: { sourceCount: 1, actions: state.actions, analysis: null } });
  });
  await page.goto("/");
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("button", { name: /Action 事项/ }).click();
  await page.getByRole("button", { name: "AI 生成改善事项", exact: true }).click();
  await expect(page.getByRole("region", { name: "正在生成改善事项" })).toBeVisible();
  await navigation.getByRole("button", { name: /菜品资料/ }).click();
  holdOlderRefresh = true;
  await page.getByRole("button", { name: "资料清单", exact: true }).click();
  await expect.poll(() => olderRefreshStarted).toBe(true);
  await page.getByRole("dialog", { name: "资料读取清单" }).getByRole("button", { name: "关闭", exact: true }).click();
  try {
    finishGeneration();
    await expect(page.locator(".action-generation-wait")).toHaveCount(0);
    await navigation.getByRole("button", { name: /Action 事项/ }).click();
    await expect(page.locator(".action-card")).toContainText("最新生成事项");
    // Background completion must not clear the other page's ongoing write lock.
    await expect(page.getByRole("button", { name: "AI 生成改善事项", exact: true })).toBeDisabled();
    finishOlderRefresh();
    await expect(page.getByRole("button", { name: "AI 生成改善事项", exact: true })).toBeEnabled();
    await expect(page.locator(".action-card")).toContainText("最新生成事项");
  } finally { finishGeneration(); finishOlderRefresh(); }
});
