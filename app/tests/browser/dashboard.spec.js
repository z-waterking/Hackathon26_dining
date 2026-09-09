import { test, expect } from "@playwright/test";

test("feedback home has four dashboards, a real word cloud and one Action entry", async ({ page }, testInfo) => {
  const errors = [];
  const mutations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() !== "GET" && /actions|analyze|summary/.test(request.url())) mutations.push(request.url()); });
  const data = await (await page.request.get("/api/data")).json();
  const actual = data.feedback.filter((item) => !item.demo && !item.summaryRecord && !item.quarantined);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "反馈中心", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "反馈视图" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "处理工作区", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "反馈台账", exact: true })).toHaveCount(0);
  await expect(page.getByText("从反馈到改善事项", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "加载示例 Action", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "汇总反馈生成改善事项", exact: true })).toHaveCount(0);
  const grid = page.locator(".fd-dashboard-grid");
  await expect(grid.locator(":scope > section")).toHaveCount(4);
  await expect(page.getByLabel("反馈月份")).toHaveValue("");
  await expect(grid.locator(".fd-types-card")).toContainText(String(actual.length));
  const cloud = grid.locator(".fd-cloud-card svg[role='img']");
  await expect(cloud).toBeVisible();
  await expect(cloud.locator("text").first()).toBeVisible();
  const boxes = await grid.locator(":scope > section").evaluateAll((cards) => cards.map((card) => { const r = card.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  expect(Math.max(...boxes.map((box) => box.height)) - Math.min(...boxes.map((box) => box.height))).toBeLessThan(2);
  if (testInfo.project.name === "desktop") {
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
    expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(2);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  } else expect(boxes.every((box, index) => !index || box.y > boxes[index - 1].y)).toBeTruthy();
  await expect(page.getByRole("region", { name: "反馈台账", exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("feedback-home.png"), fullPage: true });
  expect(mutations).toEqual([]);
  await page.locator(".fd-hero").getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Action 事项", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "汇总反馈生成改善事项", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "加载示例 Action", exact: true })).toBeVisible();
  await expect(page.getByLabel("排菜员 Prompt")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("dashboard type trends, external cloud and empty month share the selected real scope", async ({ page }, testInfo) => {
  const data = await (await page.request.get("/api/data")).json();
  const make = (id, type, date, extra = {}) => ({ id, type, date, restaurant: "测试档口", status: "未处理", content: "希望素菜清淡少油", summaryRecord: false, sources: [], events: [], ...extra });
  const records = [make("F1", "投诉", "2026-08-01"), make("F2", "批评", "2026-08"),
    make("F3", "建议", "2026-08-08"), make("F4", "建议", "2026-08-20"),
    make("F5", "表扬", "2026-08-11", { status: "已完成" }), make("F6", "询问", "2026-08-27"),
    make("F7", "建议", "2026-07-01"), make("F8", "建议", "2026-07-02"),
    make("sample", "投诉", "2026-08-01", { demo: true }),
    make("summary", "投诉", "2026-08", { summaryRecord: true }),
    make("quarantine", "投诉", "2026-08-01", { quarantined: true })];
  const words = ["清淡", "素菜", "少油", "出餐速度", "蔬菜", "口味", "午餐", "菜单", "选择", "价格", "营养", "品种", "保温", "份量", "轮换", "低盐"].map((text, index) => ({ text, count: Math.max(1, 8 - Math.floor(index / 2)) }));
  await page.route("**/api/data", (route) => route.fulfill({ json: { ...data, feedback: records, imports: [] } }));
  await page.route("**/api/feedback/insights?*", (route) => {
    const month = new URL(route.request().url()).searchParams.get("month");
    const selected = records.filter((item) => !item.demo && !item.summaryRecord && !item.quarantined && (!month || item.date.startsWith(month)));
    return route.fulfill({ json: { month, total: selected.length, keywords: selected.length ? words : [] } });
  });
  await page.goto("/");
  const grid = page.locator(".fd-dashboard-grid");
  const distribution = grid.locator(".fd-types-card");
  await expect(distribution).toContainText("8");
  await expect(distribution).toContainText("批评");
  await expect(grid.locator(".fd-trend-card")).toContainText("建议");
  await expect(grid.locator(".fd-trend-card")).toContainText("表扬");
  await page.getByLabel("示例反馈", { exact: true }).check();
  await expect(distribution).toContainText("8");
  await page.getByLabel("示例反馈", { exact: true }).uncheck();
  await page.getByLabel("反馈月份").fill("2026-08");
  await expect(distribution).toContainText("6");
  const cloud = grid.locator(".fd-cloud-card svg[role='img']");
  await expect(cloud).toBeVisible();
  await expect(cloud.locator("text").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await grid.screenshot({ path: testInfo.outputPath("four-dashboards.png") });
  const cloudGeometry = await cloud.evaluate((svg) => {
    const bounds = svg.getBoundingClientRect();
    return { bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      words: [...svg.querySelectorAll("text")].filter((text) => text.textContent.trim()).map((text) => { const r = text.getBoundingClientRect(); return { text: text.textContent, size: Number.parseFloat(getComputedStyle(text).fontSize), left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }) };
  });
  expect(cloudGeometry.words.length).toBeGreaterThan(6);
  expect(new Set(cloudGeometry.words.map((word) => word.size)).size).toBeGreaterThan(2);
  for (const [index, word] of cloudGeometry.words.entries()) {
    expect(word.left).toBeGreaterThanOrEqual(cloudGeometry.bounds.left - 1);
    expect(word.right).toBeLessThanOrEqual(cloudGeometry.bounds.right + 1);
    expect(word.top).toBeGreaterThanOrEqual(cloudGeometry.bounds.top - 1);
    expect(word.bottom).toBeLessThanOrEqual(cloudGeometry.bounds.bottom + 1);
    for (const other of cloudGeometry.words.slice(index + 1))
      expect(word.left >= other.right - 1 || word.right <= other.left + 1 || word.top >= other.bottom - 1 || word.bottom <= other.top + 1, `${word.text} overlaps ${other.text}`).toBeTruthy();
  }
  await page.getByLabel("反馈月份").fill("2025-01");
  await expect(distribution).toContainText("0");
  await expect(grid.locator(".fd-cloud-card svg text")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "反馈台账", exact: true })).toContainText("当前筛选下暂无反馈");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("approved demo action affects simulated menu and can be reinspected without Azure calls", async ({ page }, testInfo) => {
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (/azure\.com|openai\.com/i.test(request.url())) externalRequests.push(request.url()); });
  const before = await (await page.request.get("/api/data")).json();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  const seedResponse = page.waitForResponse((response) => response.url().endsWith("/api/demo/actions"));
  await page.getByRole("button", { name: "加载示例 Action", exact: true }).click();
  const seeded = await (await seedResponse).json();
  const preset = seeded.actions.find((action) => action.id === "A-demo-aggregate-prefer");
  expect(preset).toBeTruthy();
  const actionCard = page.locator(".action-card").filter({ hasText: preset.title });
  await actionCard.locator("summary").first().click();
  await expect(actionCard.getByLabel("排菜调整要求")).toHaveValue(preset.menuInstruction);
  const approvalResponse = page.waitForResponse((response) => response.url().endsWith(`/api/actions/${preset.id}`) && response.request().method() === "PATCH");
  await actionCard.getByRole("button", { name: "批准 / Approve" }).click();
  const approved = await (await approvalResponse).json();
  expect(approved.status).toBe("approved");
  expect(approved.menuInstruction).toBe(preset.menuInstruction);
  await expect(actionCard).toContainText("已批准");
  await page.getByRole("navigation").getByRole("button", { name: /六周菜单/ }).click();
  await page.getByRole("checkbox", { name: "模拟排菜测试（不调用 AI）", exact: true }).check();
  const generatedResponse = page.waitForResponse((response) => response.url().endsWith("/api/plans/generate"));
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  const response = await generatedResponse;
  expect(response.request().postDataJSON()).toMatchObject({ demo: true, useAi: false });
  expect(response.ok()).toBeTruthy();
  const plan = await response.json();
  expect(plan.demo || plan.workflow.demo || plan.workflow.mode === "demo").toBeTruthy();
  const impact = plan.workflow.actionImpacts.find((item) => item.actionId === preset.id);
  expect(impact).toBeTruthy();
  expect(impact.revision).toBe(approved.revision);
  expect(impact.evidence.length).toBeGreaterThan(0);
  await expect(page.locator(".workflow-section")).toContainText("不调用 Azure AI");
  const impactCard = page.locator(".action-impacts > details").filter({ hasText: preset.title });
  await impactCard.locator("summary").click();
  await expect(impactCard).toContainText("本次选用");
  await expect(impactCard).toContainText("变化槽位");
  await page.screenshot({ path: testInfo.outputPath("demo-menu-action-impact.png") });
  const inspectedResponse = page.waitForResponse((response) => response.url().endsWith("/api/plans/inspect"));
  await page.getByRole("button", { name: "重新模拟检验", exact: true }).click();
  const inspected = await inspectedResponse;
  expect(inspected.request().postDataJSON().demo).toBe(true);
  expect(inspected.ok()).toBeTruthy();
  const checked = await inspected.json();
  expect(checked.workflow.inspectedAt).toBeTruthy();
  expect(checked.workflow.actionImpacts.some((item) => item.actionId === preset.id)).toBeTruthy();
  await expect(page.locator('.toast[role="status"]')).toContainText("检验员已完成重新检验");
  const after = await (await page.request.get("/api/data")).json();
  expect(after.aiStatus.calls).toBe(before.aiStatus.calls);
  expect(after.aiStatus.inputTokens).toBe(before.aiStatus.inputTokens);
  expect(after.aiStatus.outputTokens).toBe(before.aiStatus.outputTokens);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
