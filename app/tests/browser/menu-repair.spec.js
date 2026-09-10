import { test, expect } from "@playwright/test";

const STALL = "南粉北面";
const START = "2026-09-14";
function fixturePlan() {
  const entries = Array.from({ length: 30 }, (_, index) => {
    const week = Math.floor(index / 5) + 1;
    const day = index % 5 + 1;
    const date = new Date(START + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
    return { week, day, date: date.toISOString().slice(0, 10), meal: "午餐", stall: STALL, slot: 0, dishId: "D-ORIGINAL" };
  });
  const issues = Array.from({ length: 12 }, (_, index) => ({ level: "error", code: "REPEAT", stall: STALL, date: entries[index].date, meal: "午餐", text: "待优化重复菜品-" + (index + 1) }));
  issues.push({ level: "warning", code: "LABELS", stall: STALL, date: START, meal: "午餐", text: "食品辣度与过敏原标签待人工核验" },
    { level: "error", code: "MISSING", stall: "百变厨房", date: START, meal: "午餐", text: "人工菜单尚未上传完整，预留槽位待补" },
    { level: "error", code: "FIXED_SOURCE", stall: "宽窄巷子", date: START, meal: "午餐", text: "缺少此餐次可信的固定出品来源" });
  return { scope: "all", stall: "全部档口", stalls: [STALL], start: START, count: 1, seed: 1, meals: ["午餐"], entries,
    validation: { errors: 14, warnings: 1, issues, labelCoverage: 70, changeRate: null },
    workflow: { runId: "MR-REPAIR-FIXTURE", generationMode: "gpt-direct", status: "blocked", stale: false, requiresHumanApproval: true,
      score: { value: 69, target: 80, targetMet: false, label: "仍需复核", summary: "存在可定位的菜单冲突", dimensions: [], blockers: 14, unknownCount: 1 },
      planner: { summary: "来自数据库菜品候选", unresolved: [] },
      inspector: { verdict: "revise", summary: "请处理明细冲突", findings: [{ severity: "warning", text: "AI 汇总发现需要人工确认，未提供结构化位置", actionIds: [], ruleIds: [] }] },
      actionImpacts: [{ actionId: "A-REPAIR", title: "轮换已核验面食", revision: 1, targetStall: STALL, instruction: "午餐减少重复面食", status: "partial", selectedEntries: 1, evidence: ["原方案仍有重复待改进"], occurrences: [entries[0]], direct: true }],
      inspectedAt: "2026-09-09T01:00:00Z" } };
}

async function prepare(page, { onRepair } = {}) {
  const original = fixturePlan();
  const data = { dishes: [{ id: "D-ORIGINAL", name: "原菜单面食", stall: STALL, active: true, priceText: "12", sources: [] },
    { id: "D-REPAIRED", name: "调整后的面食", stall: STALL, active: true, priceText: "12", sources: [] }],
    feedback: [], actions: [], plans: [], rules: [], imports: [], report: { workbooks: 0, sheets: 0 }, initialized: {},
    aiStatus: { configured: true, model: "isolated-ui-repair-fixture" } };
  const repairs = [];
  const saves = [];
  const inspections = [];
  const unexpected = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/data") return route.fulfill({ json: data });
    if (request.method() === "GET" && pathname === "/api/feedback/insights") return route.fulfill({ json: { total: 0, keywords: [] } });
    if (pathname === "/api/plans/generate-stream") return route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ type: "completed", runId: original.workflow.runId, plan: original }) + "\n" });
    if (pathname === "/api/plans/repair" && request.method() === "POST") {
      repairs.push(request.postDataJSON());
      if (onRepair) return onRepair(route, repairs.length);
      return route.fulfill({ json: { plan: original, repair: { status: "unchanged", changedEntries: 0, summary: "未找到更优且满足约束的候选" } } });
    }
    if (pathname === "/api/plans/inspect" && request.method() === "POST") {
      const plan = request.postDataJSON();
      inspections.push(plan);
      return route.fulfill({ json: { ...plan, workflow: { ...plan.workflow, stale: false, repairPendingInspection: false, score: { ...plan.workflow.score, value: 75, targetMet: false } } } });
    }
    if (pathname === "/api/plans" && request.method() === "POST") { saves.push(request.postDataJSON()); return route.fulfill({ json: request.postDataJSON() }); }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected isolated repair request" } });
  });
  await page.goto("/#menus");
  await page.getByRole("button", { name: "一次生成全部档口六周菜单", exact: true }).click();
  await page.getByRole("button", { name: "查看评分与冲突详情", exact: true }).click();
  return { original, repairs, saves, inspections, unexpected, errors };
}

test("conflicts combine local and AI findings with ten-row pagination and explicit manual-only cases", async ({ page }, testInfo) => {
  const { repairs, unexpected, errors } = await prepare(page);
  const section = page.getByRole("region", { name: "菜单冲突与核验列表", exact: true });
  const table = section.getByRole("table", { name: "冲突详情", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText(["档口", "日期", "餐次", "冲突", "核验", "操作"]);
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await page.getByRole("dialog").screenshot({ path: testInfo.outputPath("menu-conflicts-details.png") });
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(6);
  const ai = table.getByRole("row").filter({ hasText: "AI 汇总发现需要人工确认" });
  await expect(ai).toContainText("全局 / 未定位");
  await expect(ai.getByRole("button", { name: "AI 修复", exact: true })).toHaveCount(0);
  for (const text of ["食品辣度与过敏原", "人工菜单尚未上传", "缺少此餐次可信"]) {
    const row = table.getByRole("row").filter({ hasText: text });
    await expect(row.getByRole("button", { name: "AI 修复", exact: true })).toHaveCount(0);
    await expect(row).toContainText("人工");
  }
  await page.getByLabel("冲突档口", { exact: true }).selectOption(STALL);
  await page.getByLabel("冲突级别", { exact: true }).selectOption("warning");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("食品辣度与过敏原");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("region", { name: "菜单评分与 Action 执行", exact: true }).screenshot({ path: testInfo.outputPath("menu-score-action-overview.png") });
  await page.getByRole("button", { name: "查看评分与冲突详情", exact: true }).click();
  await expect(page.getByLabel("冲突档口", { exact: true })).toHaveValue(STALL);
  await expect(page.getByLabel("冲突级别", { exact: true })).toHaveValue("warning");
  expect(repairs).toHaveLength(0);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("repair waits locally, preserves old entries, keeps unresolved rows and requires fresh AI inspection before save", async ({ page }) => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const repaired = fixturePlan();
  repaired.entries[0] = { ...repaired.entries[0], dishId: "D-REPAIRED" };
  repaired.workflow = { ...repaired.workflow, stale: true, score: null, repairPendingInspection: true, staleReasons: ["局部修复后，原 AI 检验与评分待复核"] };
  const { original, repairs, saves, inspections, errors, unexpected } = await prepare(page, { onRepair: async route => { await pending; return route.fulfill({ json: { plan: repaired, repair: { status: "repaired", changedEntries: 1, summary: "已调整该日期午餐候选，其余要求待核验" } } }); } });
  await page.getByLabel("冲突档口", { exact: true }).selectOption(STALL);
  await page.getByLabel("冲突级别", { exact: true }).selectOption("error");
  await page.getByRole("table", { name: "冲突详情", exact: true }).getByRole("button", { name: "AI 修复", exact: true }).first().click();
  await expect(page.locator(".menu-repair-wait")).toContainText(STALL + " · " + START + " · 午餐");
  await expect(page.getByRole("table", { name: "冲突详情", exact: true }).getByRole("button", { name: "AI 修复", exact: true }).first()).toBeDisabled();
  await expect.poll(() => repairs.length).toBe(1);
  expect(repairs[0].issue).toEqual({ code: "REPEAT", stall: STALL, date: START, meal: "午餐", text: "待优化重复菜品-1" });
  expect(repairs[0].plan.entries).toEqual(original.entries);
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存整份草案", exact: true })).toBeDisabled();
  await expect(page.locator(".plan-week").first()).not.toContainText("调整后的面食");
  await page.getByRole("navigation").getByRole("button", { name: /反馈中心/ }).click();
  await page.getByLabel("搜索反馈", { exact: true }).fill("修复等待时可继续操作");
  finish();
  await expect(page.getByLabel("搜索反馈", { exact: true })).toBeFocused();
  await page.getByRole("navigation").getByRole("button", { name: /六周菜单/ }).click();
  await expect(page.locator(".plan-week").first()).toContainText("调整后的面食");
  await expect(page.getByRole("button", { name: "保存整份草案", exact: true })).toBeDisabled();
  await expect(page.locator(".menu-score-hero")).toContainText("评分已失效，待重新检验");
  await expect(page.locator(".menu-score-value strong")).toHaveText("—");
  await expect(page.locator(".menu-score-hero")).not.toContainText("此分值来自上次检验");
  await expect(page.locator(".menu-impact-section")).toContainText("上次审核记录，修复后待重新核验");
  await page.getByRole("button", { name: "查看评分与冲突详情", exact: true }).click();
  await expect(page.getByLabel("冲突档口", { exact: true })).toHaveValue(STALL);
  await expect(page.getByLabel("冲突级别", { exact: true })).toHaveValue("error");
  await expect(page.getByRole("table", { name: "冲突详情", exact: true })).toContainText("待优化重复菜品-1");
  await expect(page.locator(".menu-repair-result")).toContainText("旧 AI 检验与评分已失效");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "重新 AI 检验", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存整份草案", exact: true })).toBeEnabled();
  expect(inspections).toHaveLength(1);
  expect(saves).toHaveLength(0);
  expect(repairs).toHaveLength(1);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("repair failure or unchanged result preserves menu, filtering and unresolved conflict evidence", async ({ page }) => {
  const original = fixturePlan();
  const { repairs, saves, errors, unexpected } = await prepare(page, { onRepair: (route, count) => count === 1
    ? route.fulfill({ status: 502, json: { error: "隔离测试：模型暂不可用" } })
    : route.fulfill({ json: { plan: original, repair: { status: "unchanged", changedEntries: 0, summary: "没有更合适的候选，需人工处理" } } }) });
  await page.getByLabel("冲突档口", { exact: true }).selectOption(STALL);
  await page.getByLabel("冲突级别", { exact: true }).selectOption("error");
  const trigger = page.getByRole("table", { name: "冲突详情", exact: true }).getByRole("button", { name: "AI 修复", exact: true }).first();
  await trigger.click();
  await expect(page.locator(".menu-repair-error")).toContainText("原菜单保持不变");
  await expect(page.getByLabel("冲突档口", { exact: true })).toHaveValue(STALL);
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.locator(".menu-repair-result")).toContainText("不能视为已解决");
  await expect(page.getByRole("table", { name: "冲突详情", exact: true })).toContainText("待优化重复菜品-1");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".plan-week").first()).not.toContainText("调整后的面食");
  await expect(page.locator(".menu-score-hero")).not.toContainText("上次评分 · 已过期");
  expect(repairs).toHaveLength(2);
  expect(saves).toHaveLength(0);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
