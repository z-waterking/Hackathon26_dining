import { test, expect } from "@playwright/test";
import Papa from "papaparse";

const START = "2026-09-14";
const STALL = "青禾素食";

function fixturePlan({ direct = true } = {}) {
  const entries = Array.from({ length: 30 }, (_, index) => {
    const week = Math.floor(index / 5) + 1;
    const day = index % 5 + 1;
    const date = new Date(`${START}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
    return { week, day, date: date.toISOString().slice(0, 10), meal: "午餐", stall: STALL, slot: 0, dishId: "D-DIRECT-1" };
  });
  const plan = { scope: "all", stall: "全部档口", stalls: [STALL], start: START, seed: 1, count: 1, meals: ["午餐"], entries, createdAt: "2026-09-09T08:00:00Z", validation: { errors: 0, warnings: 1, labelCoverage: 70, changeRate: null, issues: [{ level: "warning", text: "过敏原标签待人工核验", stall: STALL }] } };
  if (direct) plan.workflow = {
    runId: "RUN-DIRECT-UI", generationMode: "gpt-direct", source: "gpt-direct / Azure GPT 排菜员与独立检验员",
    status: "needs_review", stale: false, requiresHumanApproval: true, inspectedAt: "2026-09-09T08:05:00Z",
    score: { value: 86, target: 80, targetMet: true, version: "menu-score-v1", label: "菜单质量达到目标", blockers: 0, unknownCount: 1, summary: "整体编排可执行，部分食品标签需要运营补充核实。", dimensions: [{ key: "rules", label: "规则符合度", earned: 46, weight: 50, detail: "仍有标签缺失，不将未知视作满足。" }, { key: "actions", label: "Action 落实", earned: 10, weight: 15, detail: "一项要求部分落实，保留关联菜品位置。" }, { key: "coverage", label: "菜单完整性", earned: 30, weight: 35, detail: "六周菜位齐备，来源可追溯。" }] },
    sourceRuleInfo: { file: "本地排菜规则.xlsx", sha256: "0123456789abcdef", ruleCount: 12 },
    catalogInfo: { file: "第一轮+第二轮纯菜单库.xlsx", sha256: "catalog12345fixture", groups: [{ stall: STALL, origin: "primary", candidates: 12, unresolved: 0 }, { stall: "补充档口", origin: "supplement", candidates: 4, unresolved: 1 }], stats: { sourceRows: 18, uniqueDishes: 16, duplicates: 1, rejected: 1 }, warnings: ["异常价格条目已隔离"] },
    planner: { summary: "根据源规则与已批准事项，直接选择六周菜单菜品。", model: "fixture-gpt-planner", unresolved: [{ actionId: "A-DIRECT-1", reason: "标签不完整，需人工确认过敏原。" }] },
    inspector: { verdict: "revise", summary: "菜品选择可追溯，过敏原仍待运营核实。", model: "fixture-gpt-inspector", findings: [{ severity: "warning", text: "未知标签不能视为已满足规则", actionIds: ["A-DIRECT-1"], ruleIds: ["RULE-DIRECT-1"] }] },
    actionImpacts: [{ actionId: "A-DIRECT-1", title: "增加已核验不辣素菜", revision: 2, targetStall: STALL, instruction: "在现有菜库中选择已核验不辣素菜", status: "partial", selectedEntries: 30, direct: true, evidence: ["本次所选菜品具有已核验不辣标签；过敏原数据需另行确认。"], occurrences: [{ week: 1, day: 1, meal: "午餐", stall: STALL, slot: 0, dishId: "D-DIRECT-1" }] }],
  };
  return plan;
}

function partialFixture(week) {
  const { workflow: _workflow, validation: _validation, ...plan } = fixturePlan();
  return { ...plan, entries: plan.entries.filter((entry) => entry.week <= week),
    partial: true, completedWeeks: week, generationMode: "gpt-direct" };
}

function progressiveRoute(route) {
  return { fulfill: (options) => {
    if (options.status && options.status >= 400 || !options.json) return route.fulfill(options);
    return route.fulfill({ contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "completed", runId: "RUN-DIRECT-UI", plan: options.json })}\n` });
  } };
}

// Native ReadableStream permits deterministic delivery of individual network
// chunks. It exercises the production HTTP reader without a model or database.
async function installMenuStream(page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const streams = [];
    window.__menuTestStreams = streams;
    window.fetch = (input, options) => {
      const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
      if (!/^\/api\/plans\/(generate|resume)-stream$/.test(path)) return originalFetch(input, options);
      if (window.__menuTestNextResponse) {
        const response = window.__menuTestNextResponse;
        delete window.__menuTestNextResponse;
        return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status, headers: { "Content-Type": "application/json" } }));
      }
      let controller;
      const body = new ReadableStream({ start(value) { controller = value; } });
      streams.push({ path, input: JSON.parse(options.body), controller });
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
    };
  });
}

async function emitMenuEvent(page, event, { stream = 0, close = false } = {}) {
  await page.evaluate(({ event, stream, close }) => {
    const controller = window.__menuTestStreams[stream].controller;
    const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    // Split across arbitrary bytes, including UTF-8 and JSON token boundaries.
    for (let offset = 0; offset < bytes.length; offset += 131) controller.enqueue(bytes.slice(offset, offset + 131));
    if (close) controller.close();
  }, { event, stream, close });
}

// All API requests are intercepted. These tests do not call a model or a database.
async function prepare(page, { configured = true, onGenerate, recoverable = [], onResume, onResult, savedPlans = [] } = {}) {
  const state = {
    dishes: [{ id: "D-DIRECT-1", name: "清炒时蔬", stall: STALL, active: true, priceText: "8", sources: [] }],
    feedback: [], actions: [{ id: "A-DIRECT-1", feedbackIds: ["F-DIRECT-1"], status: "approved", enabled: true, targetStall: STALL, menuInstruction: "选择已核验不辣素菜" }, { id: "A-DIRECT-PENDING", feedbackIds: ["F-DIRECT-2"], status: "pending", enabled: true, menuInstruction: "尚未批准的事项" }],
    plans: savedPlans, rules: [{ stall: STALL, text: "使用已核验标签；未知过敏原必须人工核实。", source: { file: "本地排菜规则.xlsx", sheet: "规则", row: 2 } }],
    imports: [], report: { workbooks: 1, sheets: 1 }, initialized: {}, aiStatus: { configured, model: "fixture-gpt-planner" },
  };
  const requests = [];
  const saves = [];
  const resumes = [];
  const results = [];
  const recoveryReads = [];
  const unexpected = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/data") return route.fulfill({ json: state });
    if (request.method() === "GET" && pathname === "/api/feedback/insights") return route.fulfill({ json: { total: 0, month: "", keywords: [] } });
    if (request.method() === "GET" && pathname === "/api/menu-runs") {
      recoveryReads.push(new URL(request.url()).search);
      return route.fulfill({ json: recoverable });
    }
    if (request.method() === "POST" && pathname === "/api/plans/resume-stream") {
      resumes.push(request.postDataJSON());
      if (onResume) return onResume(progressiveRoute(route), resumes.length);
      return progressiveRoute(route).fulfill({ json: fixturePlan() });
    }
    if (request.method() === "GET" && /^\/api\/menu-runs\/[^/]+\/result$/.test(pathname)) {
      results.push(pathname);
      if (onResult) return onResult(route, results.length);
      return route.fulfill({ json: fixturePlan() });
    }
    if (request.method() === "POST" && ["/api/plans/generate", "/api/plans/generate-stream"].includes(pathname)) {
      requests.push(request.postDataJSON());
      const response = pathname.endsWith("-stream") ? progressiveRoute(route) : route;
      if (onGenerate) return onGenerate(response, requests.length);
      return response.fulfill({ json: fixturePlan({ direct: request.postDataJSON().useAi }) });
    }
    if (request.method() === "POST" && pathname === "/api/plans") {
      const plan = { ...request.postDataJSON(), id: "PLAN-DIRECT-SAVED" };
      saves.push(plan);
      return route.fulfill({ json: plan });
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected API request in isolated direct-menu test" } });
  });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /六周菜单/ }).click();
  await page.getByLabel("起始周一").fill(START);
  return { requests, saves, resumes, results, recoveryReads, unexpected, errors };
}

test("menu defaults to direct GPT with page-local waiting and genuine action execution records", async ({ page }, testInfo) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { requests, saves, unexpected, errors } = await prepare(page, { onGenerate: async (route) => { await pending; return route.fulfill({ json: fixturePlan() }); } });
  const aiCheckbox = page.getByRole("checkbox", { name: "启用 AI 排菜员与检验员" });
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await expect(aiCheckbox).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "模拟排菜测试（不调用 AI）", exact: true })).toHaveCount(0);
  await expect(page.locator(".ai-planner-controls")).toContainText("菜品库已完成本地入库，从数据库按档口取菜");
  await expect(page.getByRole("region", { name: "排菜 Action", exact: true })).toContainText("当前可用于排菜 1 项");
  await trigger.click();
  const waiting = page.getByRole("region", { name: "正在生成六周菜单", exact: true });
  await expect(waiting).toBeVisible();
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(waiting.getByRole("status")).toContainText("人工审核与保存");
  await expect(waiting).toContainText("可切换到其他页面继续操作");
  expect(await waiting.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ scope: "all", start: START, useAi: true, demo: false });
  await waiting.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("direct-menu-wait.png") });
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("button", { name: /反馈中心/ }).click();
  await expect(waiting).toBeHidden();
  await expect(page.getByLabel("上传旧表 Excel", { exact: true })).toBeEnabled();
  await page.getByLabel("搜索反馈").fill("清淡");
  finish();
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "反馈中心", exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索反馈")).toBeFocused();
  await navigation.getByRole("button", { name: /六周菜单/ }).click();
  const workflow = page.locator(".workflow-section");
  await expect(page.getByLabel("菜单评分 86 分", { exact: true })).toBeVisible();
  await expect(page.locator(".menu-score-hero")).toContainText("达到目标不等于审核通过");
  expect(await page.locator(".menu-score-hero").evaluate((hero) => Boolean(hero.compareDocumentPosition(document.querySelector(".planner-metrics")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(workflow.getByRole("heading", { name: "GPT 直接编排" })).toHaveCount(0);
  await expect(workflow).not.toContainText("未知标签不能视为已满足规则");
  await workflow.getByRole("button", { name: "查看评分与冲突详情" }).click();
  const review = page.getByRole("dialog", { name: "菜单评分与检验详情" });
  await expect(review.getByRole("heading", { name: "GPT 直接编排" })).toBeVisible();
  await expect(review).toContainText("模型：fixture-gpt-planner");
  await expect(review).toContainText("模型：fixture-gpt-inspector");
  await expect(review).toContainText("本地排菜规则.xlsx · 12 条规则");
  await expect(review).toContainText("版本指纹 0123456789ab");
  await expect(review).toContainText("未知标签不能视为已满足规则");
  await expect(review).toContainText("1 项待核验");
  await expect(review).toContainText("过敏原标签待人工核验");
  await expect(review).toContainText("第一轮+第二轮纯菜单库.xlsx");
  await expect(review).toContainText("合并重复 1");
  await expect(review.locator(".menu-catalog-groups")).toContainText("补充来源");
  await expect(review.locator(".menu-catalog-groups")).toContainText("12 道可选");
  await review.getByRole("button", { name: "关闭", exact: true }).click();
  const impacts = page.locator(".action-impacts");
  await expect(impacts).toContainText("本次关联槽位 30");
  await expect(impacts).toContainText("部分落实");
  await expect(impacts).not.toContainText("基线槽位");
  await expect(impacts).not.toContainText("变化槽位");
  await expect(impacts).toContainText("第 1 周 · 2026-09-14 · 周一 · 午餐");
  await expect(impacts).toContainText("清炒时蔬");
  const toastDismiss = page.getByRole("button", { name: "关闭通知", exact: true });
  if (await toastDismiss.isVisible()) await toastDismiss.click();
  await workflow.screenshot({ path: testInfo.outputPath("direct-menu-workflow.png") });
  expect(saves).toHaveLength(0);
  await page.getByRole("button", { name: "保存整份草案" }).click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(trigger).toBeEnabled();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("low scores remain below target and conflicts are visible only after opening review details", async ({ page }, testInfo) => {
  const plan = fixturePlan();
  plan.workflow.score = { ...plan.workflow.score, value: 63, targetMet: false, blockers: 1, label: "需要优化后复核", summary: "本地硬规则存在未解决要求。" };
  plan.workflow.score.dimensions = plan.workflow.score.dimensions.map((dimension) => dimension.key === "rules" ? { ...dimension, earned: 23, detail: "固定菜存在缺失，必须处理冲突。" } : dimension);
  plan.workflow.status = "blocked";
  plan.validation.errors = 1;
  plan.validation.issues.push({ level: "error", text: "固定菜缺失：隔离测试冲突", stall: STALL, date: START, meal: "午餐" });
  const { requests, saves, errors, unexpected } = await prepare(page, { onGenerate: (route) => route.fulfill({ json: plan }) });
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  const hero = page.getByRole("region", { name: "菜单质量评分", exact: true });
  await expect(page.getByLabel("菜单评分 63 分", { exact: true })).toBeVisible();
  await expect(hero).toContainText("仍需优化");
  await expect(hero).toContainText("检验存在阻断");
  await expect(page.getByText("固定菜缺失：隔离测试冲突", { exact: true })).toHaveCount(0);
  await hero.getByRole("button", { name: "查看评分与冲突详情" }).click();
  const dialog = page.getByRole("dialog", { name: "菜单评分与检验详情" });
  await expect(dialog).toContainText("固定菜缺失：隔离测试冲突");
  await expect(dialog).toContainText("规则符合度");
  await expect(dialog).toContainText("Action 落实");
  await expect(dialog).toContainText("未知标签不能视为已满足规则");
  await dialog.screenshot({ path: testInfo.outputPath("menu-score-details.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByText("固定菜缺失：隔离测试冲突", { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("stale scores and Action evidence cannot imply current compliance", async ({ page }) => {
  const plan = fixturePlan();
  plan.workflow.stale = true;
  plan.workflow.status = "stale";
  plan.workflow.staleReasons = ["菜品已更换，需重新检验"];
  const { errors, unexpected } = await prepare(page, { onGenerate: (route) => route.fulfill({ json: plan }) });
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  const hero = page.getByRole("region", { name: "菜单质量评分", exact: true });
  await expect(page.getByLabel("菜单评分 86 分，已过期", { exact: true })).toBeVisible();
  await expect(hero).toContainText("待重新评定");
  await expect(hero).not.toContainText("达到目标");
  await expect(page.locator(".menu-impact-section")).toContainText("不能作为当前菜单的落实证明");
  await expect(page.locator(".menu-impact-card")).toContainText("记录已过期");
  await hero.getByRole("button", { name: "查看评分与冲突详情" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "上次检验结论已过期", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("legacy results without a server score do not invent a passing score or approved Action", async ({ page }) => {
  const plan = fixturePlan();
  delete plan.workflow.score;
  plan.workflow.actionImpacts = [];
  const { errors, unexpected } = await prepare(page, { onGenerate: (route) => route.fulfill({ json: plan }) });
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  await expect(page.getByLabel("菜单尚未评分", { exact: true })).toBeVisible();
  await expect(page.locator(".menu-score-value strong")).toHaveText("—");
  await expect(page.locator(".menu-impact-section")).toContainText("此菜单生成时未纳入排菜 Action");
  await expect(page.locator(".menu-impact-card")).toHaveCount(0);
  await page.getByRole("button", { name: "查看评分与冲突详情" }).click();
  await expect(page.getByRole("dialog")).toContainText("页面不会补算或保底分数");
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("a historical single-stall result preserves its scope and treats missing review evidence as unknown", async ({ page }) => {
  const plan = fixturePlan();
  plan.scope = "single";
  plan.stall = STALL;
  delete plan.workflow.score;
  delete plan.workflow.actionImpacts;
  delete plan.workflow.inspector;
  delete plan.workflow.inspectedAt;
  const { requests, resumes, results, saves, errors, unexpected } = await prepare(page, {
    configured: false,
    recoverable: [{ id: "MR-HISTORICAL-SINGLE", createdAt: "2026-09-09T08:00:00Z", status: "completed", completedWeeks: 6, resumable: false, canUseSavedResult: true }],
    onResult: (route) => route.fulfill({ json: plan }),
  });
  await page.getByRole("button", { name: "恢复生成记录", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "查看已生成菜单" }).click();
  await expect(page.getByLabel("菜单尚未评分", { exact: true })).toBeVisible();
  await expect(page.locator(".planner-metrics")).toContainText("历史单档口草案");
  await expect(page.locator(".menu-impact-empty")).toContainText("此历史菜单未记录 Action 执行情况");
  await expect(page.locator(".menu-impact-empty")).not.toContainText("此菜单生成时未纳入排菜 Action");
  await expect(page.getByRole("button", { name: "重新 AI 检验", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "查看评分与冲突详情", exact: true }).click();
  const review = page.getByRole("dialog", { name: "菜单评分与检验详情" });
  await expect(review).toContainText("菜单范围：历史单档口 · " + STALL);
  await expect(review.getByRole("heading", { name: "尚未完成 AI 检验", exact: true })).toBeVisible();
  await expect(review).toContainText("生成或保存不代表人工审核通过");
  expect(results).toEqual(["/api/menu-runs/MR-HISTORICAL-SINGLE/result"]);
  expect(requests).toHaveLength(0);
  expect(resumes).toHaveLength(0);
  expect(saves).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("missing AI configuration requires an explicit local-only choice instead of silently falling back", async ({ page }) => {
  const { requests, unexpected, errors } = await prepare(page, { configured: false });
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  const aiCheckbox = page.getByRole("checkbox", { name: "启用 AI 排菜员与检验员" });
  await expect(aiCheckbox).toBeChecked();
  await expect(trigger).toBeDisabled();
  await expect(page.locator(".ai-planner-controls").getByRole("alert")).toContainText("不会自动降级");
  expect(requests).toHaveLength(0);
  await aiCheckbox.uncheck();
  await expect(trigger).toBeEnabled();
  await expect(page.locator(".ai-planner-controls")).toContainText("已关闭 AI：仅生成本地规则草案");
  await trigger.click();
  await expect(page.getByText("本地规则草案 · 未经 GPT 生成或检验，仍需人工审核。", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ useAi: false, demo: false });
  await expect(page.locator(".workflow-section")).toHaveCount(0);
  await expect(page.locator(".menu-score-hero")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("a failed direct GPT request keeps the existing menu and does not synthesize a fallback", async ({ page }) => {
  const { requests, saves, unexpected, errors } = await prepare(page, { onGenerate: (route, count) => count === 1 ? route.fulfill({ json: fixturePlan() }) : route.fulfill({ status: 502, json: { error: "GPT 排菜失败，模型服务超时" } }) });
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await trigger.click();
  await expect(page.getByRole("region", { name: "菜单质量评分", exact: true })).toBeVisible();
  await expect(trigger).toBeEnabled();
  const before = await page.locator(".plan-week").allTextContents();
  await trigger.click();
  await expect(page.locator(".menu-generation-error")).toContainText("未生成替代菜单，已有草案保持不变");
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  await expect(trigger).toBeEnabled();
  expect(await page.locator(".plan-week").allTextContents()).toEqual(before);
  expect(requests).toHaveLength(2);
  expect(requests.every((input) => input.useAi && !input.demo)).toBe(true);
  expect(saves).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("fixed staples stay under the correct meal and export separately from hot dishes for all six weeks", async ({ page }, testInfo) => {
  const plan = fixturePlan();
  plan.meals = ["午餐", "晚餐"];
  plan.entries = plan.entries.flatMap((entry) => [entry, { ...entry, meal: "晚餐" }]);
  plan.fixedStaples = [
    { stall: STALL, meal: "午餐", text: "米饭、杂粮饭", source: { file: "本地排菜规则.xlsx", sheet: "规则", cell: "C11" } },
    { stall: STALL, meal: "晚餐", text: "花卷、红薯", source: { file: "本地排菜规则.xlsx", sheet: "规则", cell: "C34" } },
  ];
  const { requests, saves, unexpected, errors } = await prepare(page, { onGenerate: (route) => route.fulfill({ json: plan }) });
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  const allStaples = page.locator(".plan-week .fixed-staple-menu");
  await expect(allStaples).toHaveCount(30);
  await expect(allStaples).toHaveText(Array(30).fill("固定主食：米饭、杂粮饭"));
  await page.getByRole("tab", { name: "第1周", exact: true }).click();
  const menu = page.getByRole("region", { name: "第1周菜单", exact: true });
  await expect(menu.locator(".fixed-staple-menu")).toHaveCount(5);
  await expect(menu).not.toContainText("花卷、红薯");
  await expect(menu.locator(".menu-item")).toHaveCount(5);
  await menu.screenshot({ path: testInfo.outputPath("direct-menu-lunch-staples.png") });
  await page.getByRole("button", { name: "晚餐", exact: true }).click();
  await expect(menu.locator(".fixed-staple-menu")).toHaveText(Array(5).fill("固定主食：花卷、红薯"));
  await expect(menu).not.toContainText("米饭、杂粮饭");
  await menu.screenshot({ path: testInfo.outputPath("direct-menu-dinner-staples.png") });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出六周菜单", exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = Papa.parse(Buffer.concat(chunks).toString("utf8"), { header: true, skipEmptyLines: true });
  expect(exported.errors).toEqual([]);
  expect(exported.data).toHaveLength(24);
  for (const staple of plan.fixedStaples) {
    const rows = exported.data.filter((row) => row.档口 === `${STALL}（固定主食）` && row.餐次 === staple.meal);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.周次)).toEqual(["第1周", "第2周", "第3周", "第4周", "第5周", "第6周"]);
    for (const row of rows) for (const day of ["周一", "周二", "周三", "周四", "周五"]) expect(row[day]).toBe(staple.text);
  }
  const hotRows = exported.data.filter((row) => row.档口 === STALL);
  expect(hotRows).toHaveLength(12);
  for (const row of hotRows) expect(row.周一).toBe("清炒时蔬（¥8）");
  expect(requests).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("failed generation resumes only its saved remaining weeks with local waiting and no duplicate writes", async ({ page }, testInfo) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const recoveryRun = { id: "MR-RESUME-3", createdAt: "2026-09-09T08:00:00Z", status: "failed", stage: "planning", currentWeek: 3, completedWeeks: 2, resumable: true, canUseSavedResult: false,
    error: { code: "MENU_SLOT_INVALID", message: "第 3 周菜品引用需修复", week: 3, stall: STALL, day: 2, meal: "午餐", slot: 0 } };
  const { requests, resumes, saves, recoveryReads, unexpected, errors } = await prepare(page, {
    recoverable: [recoveryRun],
    onGenerate: (route) => route.fulfill({ status: 502, json: { error: recoveryRun.error.message, runId: recoveryRun.id, code: recoveryRun.error.code } }),
    onResume: async (route) => { await pending; return route.fulfill({ json: fixturePlan() }); },
  });
  expect(recoveryReads).toHaveLength(0);
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await trigger.click();
  await expect(page.locator(".menu-generation-error")).toContainText("生成记录：MR-RESUME-3");
  await expect.poll(() => recoveryReads.length).toBe(1);
  await expect(trigger).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".menu-generation-error").getByRole("button", { name: "恢复生成记录" }).click();
  const dialog = page.getByRole("dialog", { name: "恢复生成记录" });
  await expect(dialog).toContainText("已完成 2 / 6 周");
  await expect(dialog).toContainText("第 3 周菜品引用需修复");
  await expect(dialog).toContainText(`第 3 周 · ${STALL} · 第 2 天 · 午餐 · 菜位 1`);
  await dialog.screenshot({ path: testInfo.outputPath("menu-resume-record.png") });
  await dialog.getByRole("button", { name: "继续生成剩余周次" }).click();
  await expect(dialog).toHaveCount(0);
  const waiting = page.getByRole("region", { name: "正在生成六周菜单", exact: true });
  await expect(waiting).toContainText("已完成 2 / 6 周");
  await expect(trigger).toBeDisabled();
  await page.getByRole("button", { name: "恢复生成记录", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "继续生成剩余周次" })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("button", { name: /反馈中心/ }).click();
  await expect(waiting).toBeHidden();
  await expect(page.getByLabel("上传旧表 Excel", { exact: true })).toBeEnabled();
  await page.getByLabel("搜索反馈").fill("恢复期间可操作");
  finish();
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  await expect(page.getByLabel("搜索反馈")).toBeFocused();
  await navigation.getByRole("button", { name: /六周菜单/ }).click();
  await expect(page.getByRole("region", { name: "菜单质量评分", exact: true })).toBeVisible();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await expect(page.locator(".menu-generation-error")).toHaveCount(0);
  expect(resumes).toEqual([{ runId: recoveryRun.id }]);
  expect(requests).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(recoveryReads.every((query) => query === "?recoverable=true")).toBe(true);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("completed GPT results can be recovered without configured AI, regeneration or automatic saving", async ({ page }) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { requests, resumes, saves, results, recoveryReads, unexpected, errors } = await prepare(page, {
    configured: false,
    recoverable: [{ id: "MR-COMPLETE", createdAt: "2026-09-09T08:00:00Z", status: "completed", stage: "completed", currentWeek: 6, completedWeeks: 6, resumable: false, canUseSavedResult: true }],
    onResult: async (route) => { await pending; return route.fulfill({ json: fixturePlan() }); },
  });
  expect(recoveryReads).toHaveLength(0);
  await page.getByRole("button", { name: "恢复生成记录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "恢复生成记录" });
  await expect(dialog).toContainText("已完成 6 / 6 周");
  await expect(dialog.getByRole("button", { name: "继续生成剩余周次" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "查看已生成菜单" }).click();
  await expect(dialog.getByRole("button", { name: "读取结果中…" })).toBeDisabled();
  finish();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "菜单质量评分", exact: true })).toBeVisible();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  expect(results).toEqual(["/api/menu-runs/MR-COMPLETE/result"]);
  expect(requests).toHaveLength(0);
  expect(resumes).toHaveLength(0);
  expect(saves).toHaveLength(0);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("failed resume keeps the recovery ID and prior menu without an automatic restart", async ({ page }) => {
  const { requests, resumes, saves, unexpected, errors } = await prepare(page, {
    recoverable: [{ id: "MR-RESUME-FAIL", createdAt: "2026-09-09T08:00:00Z", status: "failed", stage: "inspecting", currentWeek: 6, completedWeeks: 6, resumable: true, canUseSavedResult: false, error: { message: "检验服务超时" } }],
    onResume: (route) => route.fulfill({ status: 502, json: { error: "检验服务暂不可用", code: "AI_TIMEOUT" } }),
  });
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  const before = await page.locator(".plan-week").allTextContents();
  await page.getByRole("button", { name: "恢复生成记录", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "继续生成剩余周次" }).click();
  await expect(page.locator(".menu-generation-error")).toContainText("检验服务暂不可用");
  await expect(page.locator(".menu-generation-error")).toContainText("MR-RESUME-FAIL");
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  expect(await page.locator(".plan-week").allTextContents()).toEqual(before);
  expect(resumes).toEqual([{ runId: "MR-RESUME-FAIL" }]);
  expect(requests).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("weekly streaming displays each completed week immediately without future placeholders or page blocking", async ({ page }, testInfo) => {
  await installMenuStream(page);
  const { requests, saves, unexpected, errors } = await prepare(page, { savedPlans: [{ ...fixturePlan(), id: "PLAN-PRIOR", countEntries: 30 }] });
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await trigger.click();
  await expect.poll(() => page.evaluate(() => window.__menuTestStreams.length)).toBe(1);
  await emitMenuEvent(page, { type: "started", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: 0, currentWeek: 1 });
  await expect(page.locator(".plan-week")).toHaveCount(0);
  await expect(page.locator(".menu-generation-wait")).toContainText("正在生成第 1 周菜单");
  await emitMenuEvent(page, { type: "week", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: 1, currentWeek: 1, plan: partialFixture(1) });
  const firstWeek = page.getByRole("region", { name: "第1周菜单", exact: true });
  await expect(firstWeek).toBeVisible();
  await expect(firstWeek.locator(".menu-item")).toHaveCount(5);
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "第2周", exact: true })).toHaveCount(0);
  await expect(page.locator(".menu-generation-wait")).toContainText("正在生成第 2 周菜单");
  await expect(page.getByRole("button", { name: "保存整份草案" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出六周菜单", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新 AI 检验" })).toHaveCount(0);
  await expect(firstWeek.locator(".menu-item").first()).toBeDisabled();
  await expect(page.locator(".workflow-section")).toHaveCount(0);
  await expect(page.locator(".menu-score-hero")).toHaveCount(0);
  await expect(page.getByText("本地规则草案 · 未经 GPT 生成或检验，仍需人工审核。", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /草案记录/ }).click();
  const historyDialog = page.getByRole("dialog", { name: "已保存草案" });
  await expect(historyDialog.locator(".history-list button")).toBeDisabled();
  await historyDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".plan-week")).toHaveCount(1);
  const initial = await firstWeek.textContent();
  await page.locator(".menu-generation-wait").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("menu-stream-first-week.png") });
  await emitMenuEvent(page, { type: "week", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: 2, currentWeek: 2, plan: partialFixture(2) });
  await expect(page.locator(".plan-week")).toHaveCount(2);
  expect(await firstWeek.textContent()).toBe(initial);
  await expect(page.getByRole("region", { name: "第2周菜单", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "第3周", exact: true })).toHaveCount(0);
  await expect(page.locator(".menu-generation-wait")).toContainText("正在生成第 3 周菜单");
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("button", { name: /反馈中心/ }).click();
  await page.getByLabel("搜索反馈").fill("继续查看反馈");
  await emitMenuEvent(page, { type: "week", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: 3, currentWeek: 3, plan: partialFixture(3) });
  await expect(page.getByLabel("搜索反馈")).toBeFocused();
  await expect(page.getByLabel("上传旧表 Excel", { exact: true })).toBeEnabled();
  await expect(page.locator(".menu-generation-wait")).toBeHidden();
  await navigation.getByRole("button", { name: /六周菜单/ }).click();
  await expect(page.locator(".plan-week")).toHaveCount(3);
  for (const week of [4, 5, 6]) await emitMenuEvent(page, { type: "week", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: week, currentWeek: week, plan: partialFixture(week) });
  await emitMenuEvent(page, { type: "inspecting", runId: "MR-STREAM", totalWeeks: 6, completedWeeks: 6, plan: partialFixture(6) });
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await expect(page.locator(".menu-generation-wait")).toContainText("检验员正在复核");
  await expect(page.getByRole("button", { name: "保存整份草案" })).toBeDisabled();
  await emitMenuEvent(page, { type: "completed", runId: "MR-STREAM", plan: fixturePlan() }, { close: true });
  await expect(page.locator(".menu-generation-wait")).toHaveCount(0);
  await expect(page.locator(".menu-partial-notice")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "菜单质量评分", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存整份草案" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "导出六周菜单", exact: true })).toBeEnabled();
  expect(saves).toHaveLength(0);
  await page.getByRole("button", { name: "保存整份草案" }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].partial).not.toBe(true);
  expect(saves[0].entries).toHaveLength(30);
  expect(requests).toHaveLength(0);
  expect(await page.evaluate(() => window.__menuTestStreams.map(({ path, input }) => ({ path, input })))).toEqual([{ path: "/api/plans/generate-stream", input: expect.objectContaining({ useAi: true, demo: false, scope: "all" }) }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("a streamed failure retains generated weeks while preserving the previously saved draft", async ({ page }) => {
  await installMenuStream(page);
  const { saves, unexpected, errors } = await prepare(page);
  const trigger = page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true });
  await trigger.click();
  await expect.poll(() => page.evaluate(() => window.__menuTestStreams.length)).toBe(1);
  await emitMenuEvent(page, { type: "completed", runId: "MR-OLD", plan: fixturePlan() }, { close: true });
  await page.getByRole("button", { name: "保存整份草案" }).click();
  await expect.poll(() => saves.length).toBe(1);
  const savedEntries = structuredClone(saves[0].entries);
  const oldMenu = await page.locator(".plan-week").allTextContents();
  await trigger.click();
  await expect.poll(() => page.evaluate(() => window.__menuTestStreams.length)).toBe(2);
  await expect(page.getByRole("button", { name: "查看评分与冲突详情", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重新 AI 检验", exact: true })).toBeDisabled();
  await emitMenuEvent(page, { type: "started", runId: "MR-PARTIAL-FAIL", totalWeeks: 6, completedWeeks: 0, currentWeek: 1 }, { stream: 1 });
  await emitMenuEvent(page, { type: "week", runId: "MR-PARTIAL-FAIL", totalWeeks: 6, completedWeeks: 1, currentWeek: 1, plan: partialFixture(1) }, { stream: 1 });
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await emitMenuEvent(page, { type: "error", runId: "MR-PARTIAL-FAIL", error: "第 2 周模型服务暂不可用", code: "AI_TIMEOUT", week: 2 }, { stream: 1, close: true });
  await expect(page.locator(".menu-generation-error")).toContainText("已保留下方完成的 1 周菜单");
  await expect(page.locator(".menu-generation-error")).toContainText("MR-PARTIAL-FAIL");
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "保存整份草案" })).toBeDisabled();
  await expect(page.locator(".plan-week .menu-item").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回此前草案" })).toBeEnabled();
  expect(saves).toHaveLength(1);
  expect(saves[0].entries).toEqual(savedEntries);
  await page.getByRole("button", { name: "返回此前草案" }).click();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  expect(await page.locator(".plan-week").allTextContents()).toEqual(oldMenu);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("resume immediately displays the checkpoint and appends only completed remaining weeks", async ({ page }) => {
  await installMenuStream(page);
  const recoveryRun = { id: "MR-STREAM-RESUME", createdAt: "2026-09-09T08:00:00Z", status: "failed", stage: "planning", completedWeeks: 2, currentWeek: 3, resumable: true, canUseSavedResult: false };
  const recoverable = [recoveryRun];
  const { saves, unexpected, errors } = await prepare(page, { recoverable });
  await page.getByRole("button", { name: "恢复生成记录", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "继续生成剩余周次" }).click();
  await expect.poll(() => page.evaluate(() => window.__menuTestStreams.length)).toBe(1);
  expect(await page.evaluate(() => window.__menuTestStreams[0].input)).toEqual({ runId: recoveryRun.id });
  await emitMenuEvent(page, { type: "started", runId: "MR-STREAM-CHILD", totalWeeks: 6, completedWeeks: 2, currentWeek: 3, plan: partialFixture(2) });
  await expect(page.locator(".plan-week")).toHaveCount(2);
  await expect(page.locator(".menu-generation-wait")).toContainText("正在生成第 3 周菜单");
  const firstTwo = await page.locator(".plan-week").allTextContents();
  await emitMenuEvent(page, { type: "week", runId: "MR-STREAM-CHILD", totalWeeks: 6, completedWeeks: 3, currentWeek: 3, plan: partialFixture(3) });
  await expect(page.locator(".plan-week")).toHaveCount(3);
  expect((await page.locator(".plan-week").allTextContents()).slice(0, 2)).toEqual(firstTwo);
  await emitMenuEvent(page, { type: "error", runId: "MR-STREAM-CHILD", error: "第 4 周校验未通过", code: "MENU_DISH_REFERENCE", week: 4 }, { close: true });
  await expect(page.locator(".menu-generation-error")).toContainText("MR-STREAM-CHILD");
  await expect(page.locator(".menu-generation-error")).toContainText("已保留下方完成的 3 周菜单");
  await expect(page.locator(".plan-week")).toHaveCount(3);
  await expect(page.getByRole("tab", { name: "第4周", exact: true })).toHaveCount(0);
  recoverable.splice(0, 1, { ...recoveryRun, id: "MR-STREAM-CHILD", completedWeeks: 3, currentWeek: 4 });
  const preserved = await page.locator(".plan-week").allTextContents();
  await page.evaluate(() => { window.__menuTestNextResponse = { status: 409, body: { error: "规则已调整，暂不能继续该记录" } }; });
  await page.locator(".menu-generation-error").getByRole("button", { name: "恢复生成记录" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "继续生成剩余周次" }).click();
  await expect(page.locator(".menu-generation-error")).toContainText("规则已调整");
  await expect(page.locator(".menu-generation-error")).toContainText("已保留下方完成的 3 周菜单");
  expect(await page.locator(".plan-week").allTextContents()).toEqual(preserved);
  await expect(page.getByRole("button", { name: "保存整份草案" })).toBeDisabled();
  expect(saves).toHaveLength(0);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
