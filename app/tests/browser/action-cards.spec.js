import { test, expect } from "@playwright/test";

const MENU_TITLE = "试行清淡素菜轮换并记录售罄情况";
const SERVICE_TITLE = "建立高峰补菜响应与进度登记";
const OPERATIONS_TITLE = "明确价签信息核验与巡检责任";
const REJECTED_TITLE = "评估晚餐窗口提前备菜";
const LONG_DESCRIPTION = "先核验午餐菜单和近两周素菜售罄记录，再在现有菜库中选择不辣、少油的素菜进行两周轮换试行。" +
  "运营每天记录开餐时间、补菜时间、售罄时间及员工反馈，按周检查供应稳定性；如原材料或人员不足，先确认可执行范围再调整。".repeat(5) +
  "验收时对比试行前后的缺菜反馈数量，保留完整的执行依据与复盘结论。";
const LONG_EVIDENCE = "午餐时经常找不到清淡素菜，希望至少有一种不辣的选择，而且在十二点半以后仍能补充供应。" +
  "请在试行后向员工说明哪些菜品已调整、补菜责任人和建议反馈入口。".repeat(4);

// Every API request is intercepted: UI fixtures never call AI or write a database.
async function prepareCards(page) {
  const feedback = [
    { id: "F-CARD-1", content: LONG_EVIDENCE, date: "2026-09-01", restaurant: "一层中餐", type: "建议", category: "菜品", status: "未处理", demo: false, sources: [], events: [], replies: [] },
    { id: "F-CARD-2", content: "高峰期补菜较慢，希望窗口告知预计等待时间。", date: "2026-09-02", restaurant: "一层中餐", type: "批评", category: "服务", status: "跟进中", demo: false, sources: [], events: [], replies: [] },
    { id: "F-CARD-3", content: "部分菜品的价签和供应说明不够清楚，请安排每日检查。", date: "2026-09-03", restaurant: "二层风味", type: "建议", category: "运营", status: "已完成", demo: false, sources: [], events: [], replies: [] },
  ];
  const common = { source: "aggregate", demo: false, enabled: true, revision: 1, history: [] };
  const actions = [
    { ...common, id: "A-CARD-MENU", kind: "menu", title: MENU_TITLE, description: LONG_DESCRIPTION, targetStall: "一层中餐", menuInstruction: "午餐优先轮换不辣素菜，先核验现有菜库和补菜能力。", priority: "high", status: "pending", feedbackIds: [feedback[0].id, feedback[1].id], evidence: feedback.slice(0, 2).map((item) => ({ feedbackId: item.id, quote: item.content })) },
    { ...common, id: "A-CARD-SERVICE", kind: "service", title: SERVICE_TITLE, description: "窗口负责人登记午餐高峰补菜请求，每十五分钟检查未完成事项，试行一周后复盘等待时间。", targetStall: "一层中餐", menuInstruction: "", priority: "medium", status: "pending", feedbackIds: [feedback[1].id], evidence: [{ feedbackId: feedback[1].id, quote: feedback[1].content }] },
    { ...common, id: "A-CARD-OPERATIONS", kind: "other", title: OPERATIONS_TITLE, description: "开餐前由运营按实际在售菜品检查价签，发现缺失及时补齐并登记处理结果。", targetStall: "二层风味", menuInstruction: "", priority: "low", status: "approved", feedbackIds: [feedback[2].id], evidence: [{ feedbackId: feedback[2].id, quote: feedback[2].content }] },
    { ...common, id: "A-CARD-REJECTED", kind: "menu", title: REJECTED_TITLE, description: "先确认晚餐实际客流与员工排班，再评估提前备菜是否合适，尚未确认前保持当前供应安排。", targetStall: "全部档口", menuInstruction: "", priority: "low", status: "rejected", feedbackIds: [feedback[1].id], evidence: [{ feedbackId: feedback[1].id, quote: feedback[1].content }] },
    { ...common, id: "A-CARD-DEMO", demo: true, kind: "menu", title: "历史示例事项不应展示", description: "这条历史演示数据不能出现在真实事项卡片中。", targetStall: "全部档口", priority: "high", status: "pending", feedbackIds: [feedback[0].id], evidence: [] },
  ];
  const state = { dishes: [], feedback, actions, plans: [], imports: [], rules: [], report: { workbooks: 0, sheets: 0 }, initialized: {}, aiStatus: { configured: true, model: "isolated-ui-fixture" } };
  const writes = [];
  const unexpected = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/data") return route.fulfill({ json: state });
    if (request.method() === "GET" && pathname === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: feedback.length, keywords: [] } });
    if (request.method() === "GET" && pathname === "/api/actions/summary") return route.fulfill({ json: { sourceCount: feedback.length, actions: state.actions.filter((item) => !item.demo), analysis: { sourceCount: feedback.length, summary: "从反馈中归纳菜品供应、窗口服务和信息巡检三个改善方向。", createdAt: "2026-09-09T04:00:00Z" } } });
    if (request.method() === "PATCH" && pathname.startsWith("/api/actions/")) {
      const id = decodeURIComponent(pathname.split("/").at(-1));
      const index = state.actions.findIndex((item) => item.id === id);
      if (index >= 0) {
        const input = request.postDataJSON();
        const previous = state.actions[index];
        const next = { ...previous, ...input, revision: previous.revision + 1 };
        next.history = [...previous.history, { at: "2026-09-09T04:30:00Z", reason: input.reason, revision: next.revision, status: next.status }];
        state.actions[index] = next;
        writes.push({ id, input });
        return route.fulfill({ json: next });
      }
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected API request in isolated card test" } });
  });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  await expect(page.getByRole("heading", { name: "Action 事项", exact: true })).toBeVisible();
  await expect(page.locator(".action-card-grid > article.action-card")).toHaveCount(4);
  return { state, writes, unexpected, errors };
}

function cardFor(page, title) {
  return page.locator("article.action-card").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
}

async function expectNoHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("Action cards show real aggregate items, category, priority and a responsive grid", async ({ page }, testInfo) => {
  const { writes, unexpected, errors } = await prepareCards(page);
  const module = page.locator(".action-module");
  const cards = page.locator(".action-card-grid > article.action-card");
  await expect(cards.locator("h3")).toHaveText([MENU_TITLE, SERVICE_TITLE, OPERATIONS_TITLE, REJECTED_TITLE]);
  await expect(cardFor(page, MENU_TITLE)).toContainText("排菜优化");
  await expect(cardFor(page, MENU_TITLE)).toContainText("高优先级");
  await expect(cardFor(page, MENU_TITLE)).toContainText("待审批");
  await expect(cardFor(page, MENU_TITLE)).toContainText("2 条相关反馈");
  await expect(cardFor(page, SERVICE_TITLE)).toContainText("服务改善");
  await expect(cardFor(page, SERVICE_TITLE)).toContainText("中优先级");
  await expect(cardFor(page, OPERATIONS_TITLE)).toContainText("运营提升");
  await expect(cardFor(page, OPERATIONS_TITLE)).toContainText("低优先级");
  await expect(cardFor(page, OPERATIONS_TITLE)).toContainText("已批准");
  await expect(cardFor(page, REJECTED_TITLE)).toContainText("已拒绝");
  await expect(cards.getByRole("button", { name: "查看与审批", exact: true })).toHaveCount(4);
  await expect(module).not.toContainText("示例");
  await expect(module.getByText(/Prompt/)).toHaveCount(0);
  await expect(cards.locator("input, textarea, select")).toHaveCount(0);
  const expectedColumns = page.viewportSize().width < 600 ? 1 : 3;
  expect(await page.locator(".action-card-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length)).toBe(expectedColumns);
  const boxes = await cards.evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, bottom: box.bottom }; }));
  if (expectedColumns === 3) {
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(1);
    expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThan(1);
    expect(boxes[3].y).toBeGreaterThanOrEqual(boxes[0].bottom);
  } else {
    for (let index = 1; index < boxes.length; index++) {
      expect(Math.abs(boxes[index].x - boxes[0].x)).toBeLessThan(1);
      expect(boxes[index].y).toBeGreaterThanOrEqual(boxes[index - 1].bottom);
    }
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("action-cards.png"), fullPage: true });
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("Action card opens by keyboard with complete editable content and linked evidence", async ({ page }, testInfo) => {
  const { unexpected, errors } = await prepareCards(page);
  const trigger = cardFor(page, MENU_TITLE).getByRole("button", { name: "查看与审批", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: MENU_TITLE, exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
  await expect(dialog.getByLabel("Action 标题", { exact: true })).toHaveValue(MENU_TITLE);
  await expect(dialog.getByLabel("改善说明", { exact: true })).toHaveValue(LONG_DESCRIPTION);
  await expect(dialog.getByLabel("排菜调整要求", { exact: true })).toHaveValue("午餐优先轮换不辣素菜，先核验现有菜库和补菜能力。");
  await dialog.locator("summary").filter({ hasText: "查看关联反馈与依据" }).click();
  await expect(dialog.getByText(LONG_EVIDENCE, { exact: true })).toBeVisible();
  await expect(dialog.getByText("高峰期补菜较慢，希望窗口告知预计等待时间。", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("F-CARD-1");
  await expect(dialog).toContainText("F-CARD-2");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("action-card-details.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("Action status filtering changes cards without showing historical demo items", async ({ page }) => {
  const { writes, unexpected, errors } = await prepareCards(page);
  const status = page.getByLabel("Action 审批状态", { exact: true });
  const headings = page.locator(".action-card-grid > article.action-card h3");
  await status.selectOption("pending");
  await expect(headings).toHaveText([MENU_TITLE, SERVICE_TITLE]);
  await status.selectOption("approved");
  await expect(headings).toHaveText([OPERATIONS_TITLE]);
  await status.selectOption("rejected");
  await expect(headings).toHaveText([REJECTED_TITLE]);
  await status.selectOption("");
  await expect(headings).toHaveCount(4);
  await expect(page.locator(".action-module")).not.toContainText("历史示例事项不应展示");
  await expectNoHorizontalOverflow(page);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("Approving a filtered pending card closes its dialog and preserves the approved revision when reopened", async ({ page }) => {
  const { state, writes, unexpected, errors } = await prepareCards(page);
  const status = page.getByLabel("Action 审批状态", { exact: true });
  const headings = page.locator(".action-card-grid > article.action-card h3");
  await status.selectOption("pending");
  await expect(headings).toHaveText([MENU_TITLE, SERVICE_TITLE]);
  await cardFor(page, SERVICE_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: SERVICE_TITLE, exact: true });
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill("高峰登记责任人已确认，批准试行一周并记录补菜等待时间。");
  await dialog.getByRole("button", { name: "批准 / Approve", exact: true }).click();
  await expect(headings).toHaveText([MENU_TITLE]);
  await expect(cardFor(page, SERVICE_TITLE)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.actions.find((item) => item.id === "A-CARD-SERVICE")).toMatchObject({ status: "approved", revision: 2 });
  await status.selectOption("");
  await expect(headings).toHaveText([MENU_TITLE, SERVICE_TITLE, OPERATIONS_TITLE, REJECTED_TITLE]);
  await expect(cardFor(page, SERVICE_TITLE)).toContainText("已批准");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await cardFor(page, SERVICE_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  await expect(dialog).toContainText("已批准");
  await expect(dialog.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await dialog.locator(".audit-details > summary").click();
  await expect(dialog).toContainText("高峰登记责任人已确认，批准试行一周并记录补菜等待时间。");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ id: "A-CARD-SERVICE", input: { status: "approved" } });
  await expectNoHorizontalOverflow(page);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("Action edits, approvals and rejections close the modal and retain saved state on reopening", async ({ page }) => {
  const { state, writes, unexpected, errors } = await prepareCards(page);
  await cardFor(page, MENU_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const updatedTitle = "午餐试行两周清淡素菜轮换";
  const updatedDescription = "先核验当周菜库，由窗口每日记录供应与补菜情况，两周后依据缺菜反馈复盘调整。";
  const instruction = "午餐每天保留一种不辣素菜；仅从已有菜库选择，开餐后检查供应。";
  await dialog.getByLabel("Action 标题", { exact: true }).fill(updatedTitle);
  await dialog.getByLabel("改善说明", { exact: true }).fill(updatedDescription);
  await dialog.getByLabel("排菜调整要求", { exact: true }).fill(instruction);
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill("已与窗口核验现有人员和菜库容量，缩小为可执行的两周试行。");
  await dialog.getByRole("button", { name: "保存调整", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardFor(page, updatedTitle)).toContainText(updatedDescription);
  await cardFor(page, updatedTitle).getByRole("button", { name: "查看与审批", exact: true }).click();
  await expect(dialog).toHaveAccessibleName(updatedTitle);
  await expect(dialog.getByLabel("改善说明", { exact: true })).toHaveValue(updatedDescription);
  await expect(dialog.getByLabel("排菜调整要求", { exact: true })).toHaveValue(instruction);
  expect(writes).toHaveLength(1);
  expect(writes[0].input).toMatchObject({ title: updatedTitle, description: updatedDescription, menuInstruction: instruction });
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill("供应与责任人均已确认，批准试行并在两周后验收。");
  await dialog.getByRole("button", { name: "批准 / Approve", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardFor(page, updatedTitle)).toContainText("已批准");
  expect(state.actions.find((item) => item.id === "A-CARD-MENU")).toMatchObject({ status: "approved", revision: 3, menuInstruction: instruction });
  await cardFor(page, updatedTitle).getByRole("button", { name: "查看与审批", exact: true }).click();
  await expect(dialog).toContainText("已批准");
  await expect(dialog.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await dialog.locator(".audit-details > summary").click();
  await expect(dialog).toContainText("已与窗口核验现有人员和菜库容量，缩小为可执行的两周试行。");
  await expect(dialog).toContainText("供应与责任人均已确认，批准试行并在两周后验收。");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("Action 审批状态", { exact: true }).selectOption("approved");
  await expect(page.locator(".action-card-grid h3")).toHaveText([updatedTitle, OPERATIONS_TITLE]);
  await page.getByLabel("Action 审批状态", { exact: true }).selectOption("pending");
  await expect(page.locator(".action-card-grid h3")).toHaveText([SERVICE_TITLE]);
  await page.getByLabel("Action 审批状态", { exact: true }).selectOption("");
  await cardFor(page, SERVICE_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill("当前登记方案缺少交接责任人，暂不批准，待补齐后重审。");
  await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.actions.find((item) => item.id === "A-CARD-SERVICE").status).toBe("rejected");
  await expect(cardFor(page, SERVICE_TITLE)).toContainText("已拒绝");
  await cardFor(page, SERVICE_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  await expect(dialog).toContainText("已拒绝");
  await expect(dialog.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await dialog.locator(".audit-details > summary").click();
  await expect(dialog).toContainText("当前登记方案缺少交接责任人，暂不批准，待补齐后重审。");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("Action 审批状态", { exact: true }).selectOption("rejected");
  await expect(page.locator(".action-card-grid h3")).toHaveText([SERVICE_TITLE, REJECTED_TITLE]);
  expect(writes).toHaveLength(3);
  expect(writes.map((item) => item.input.status)).toEqual([undefined, "approved", "rejected"]);
  expect(state.actions.find((item) => item.id === "A-CARD-DEMO").revision).toBe(1);
  await expectNoHorizontalOverflow(page);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
