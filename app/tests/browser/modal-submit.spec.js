import { test, expect } from "@playwright/test";

const TITLE = "核验午餐清淡菜供应";
const SECOND_TITLE = "检查窗口补菜登记";
const EDITED_TITLE = "试行午餐清淡蔬菜轮换";
const DESCRIPTION = "核验菜库与供应能力，记录午餐清淡菜供应情况。";
const EDITED_DESCRIPTION = "核对本周菜库后试行轮换，由窗口每日登记供应并在周末复盘。";
const REASON = "已核实候选菜品和窗口供应能力，记录本次试行依据。";
const WRITE_ERROR = "模拟保存失败，请保留输入后重试。";
const RELOAD_ERROR = "模拟工作空间刷新失败。";
const operations = [
  { name: "save changes", button: "保存调整", status: undefined, badge: "待审批" },
  { name: "approve", button: "批准 / Approve", status: "approved", badge: "已批准" },
  { name: "reject", button: "拒绝", status: "rejected", badge: "已拒绝" },
];

function card(page, title) {
  return page.locator("article.action-card").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
}

// Complete API interception: held PATCH requests only mutate this local object.
// Unexpected API calls fail here and never reach a model or real business store.
async function fixture(page) {
  const feedback = [{ id: "F-MODAL", content: "午餐希望增加清淡蔬菜，并及时补充供应。", date: "2026-09-10", restaurant: "青禾素食", type: "建议", category: "菜品", status: "未处理", channel: "邮件", demo: false, sources: [], events: [], replies: [] }];
  const common = { description: DESCRIPTION, targetStall: "青禾素食", menuInstruction: "午餐保留一种已核验的不辣素菜。", kind: "menu", status: "pending", priority: "medium", enabled: true, revision: 1, source: "aggregate", demo: false, history: [], feedbackIds: [feedback[0].id], evidence: [{ feedbackId: feedback[0].id, quote: feedback[0].content }] };
  const state = { dishes: [], feedback, actions: [{ ...common, id: "A-MODAL-1", title: TITLE }, { ...common, id: "A-MODAL-2", title: SECOND_TITLE }], plans: [], imports: [], rules: [], report: { workbooks: 1, sheets: 1, formulaErrors: 0 }, initialized: {}, uiTranslations: [], aiStatus: { configured: true, model: "isolated-modal-fixture" } };
  const logs = { writes: [], saved: [], unexpected: [], errors: [], dataLoads: 0 };
  const control = { failNextReload: false };
  const pending = [];
  const pendingGeneration = [];
  page.on("pageerror", error => logs.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("dining-ui-language", "zh"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/data") {
      logs.dataLoads++;
      if (control.failNextReload) {
        control.failNextReload = false;
        return route.fulfill({ status: 503, json: { error: RELOAD_ERROR } });
      }
      return route.fulfill({ json: state });
    }
    if (request.method() === "GET" && pathname === "/api/actions/summary") return route.fulfill({ json: { sourceCount: feedback.length, actions: state.actions, analysis: null, uiTranslations: [] } });
    if (request.method() === "GET" && pathname === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: feedback.length, keywords: [] } });
    if (request.method() === "POST" && pathname === "/api/actions/summarize") {
      const input = request.postDataJSON();
      logs.writes.push({ operation: "generate", input });
      await new Promise(resolve => pendingGeneration.push(resolve));
      return route.fulfill({ json: { sourceCount: feedback.length, actions: state.actions, analysis: null, uiTranslations: [] } });
    }
    if (request.method() === "PATCH" && pathname.startsWith("/api/actions/")) {
      const id = decodeURIComponent(pathname.split("/").at(-1));
      const index = state.actions.findIndex(action => action.id === id);
      if (index >= 0) {
        const input = request.postDataJSON();
        logs.writes.push({ id, input });
        const outcome = await new Promise(resolve => pending.push({ id, resolve }));
        if (outcome === "failure") return route.fulfill({ status: 503, json: { error: WRITE_ERROR } });
        const previous = state.actions[index];
        const next = { ...previous, ...input, revision: previous.revision + 1, history: [...previous.history, { at: "2026-09-10T04:30:00Z", reason: input.reason, status: input.status || previous.status, revision: previous.revision + 1 }] };
        state.actions[index] = next;
        logs.saved.push({ id, input });
        return route.fulfill({ json: next });
      }
    }
    logs.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected request in isolated modal submission test" } });
  });
  await page.goto("/#actions");
  await expect(page.getByRole("heading", { name: "Action 事项", level: 1, exact: true })).toBeVisible();
  await expect(page.locator("article.action-card")).toHaveCount(2);
  return {
    state, logs, control,
    release(outcome = "success") {
      const request = pending.shift();
      expect(request, "A held Action PATCH must exist before releasing it").toBeTruthy();
      request.resolve(outcome);
    },
    releaseGeneration() {
      const resolve = pendingGeneration.shift();
      expect(resolve, "A held Action generation request must exist before releasing it").toBeTruthy();
      resolve();
    },
  };
}

async function openAndEdit(page) {
  await card(page, TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: TITLE, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Action 标题", { exact: true }).fill(EDITED_TITLE);
  await dialog.getByLabel("改善说明", { exact: true }).fill(EDITED_DESCRIPTION);
  await dialog.getByLabel("调整 / 审批理由", { exact: true }).fill(REASON);
  return dialog;
}

async function expectPending(page, dialog, logs, expectedWrites) {
  await expect.poll(() => logs.writes.length).toBe(expectedWrites);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByLabel("Action 标题", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("改善说明", { exact: true })).toBeDisabled();
  for (const button of await dialog.locator(".action-footer button").all()) await expect(button).toBeDisabled();
  // Keyboard submission and disabled native clicks cannot duplicate an in-flight write.
  await page.keyboard.press("Enter");
  await dialog.locator(".action-footer").evaluate(footer => footer.querySelectorAll("button").forEach(button => button.click()));
  expect(logs.writes).toHaveLength(expectedWrites);
}

function expectClean(logs) {
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
}

for (const operation of operations) {
  test(`Action ${operation.name} keeps the pending dialog locked and closes it only after a successful write`, async ({ page }) => {
    const data = await fixture(page);
    const dialog = await openAndEdit(page);
    const submit = dialog.getByRole("button", { name: operation.button, exact: true });
    await expect(submit).toBeEnabled();
    // Two native clicks in one browser task exercise the synchronous write lock.
    await submit.evaluate(button => { button.click(); button.click(); });
    await expectPending(page, dialog, data.logs, 1);
    expect(data.logs.saved).toHaveLength(0);
    expect(data.state.actions[0]).toMatchObject({ title: TITLE, status: "pending", revision: 1 });
    data.release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card(page, EDITED_TITLE)).toContainText(EDITED_DESCRIPTION);
    await expect(card(page, EDITED_TITLE)).toContainText(operation.badge);
    await expect(card(page, EDITED_TITLE)).toContainText("版本 2");
    expect(data.logs.writes).toHaveLength(1);
    expect(data.logs.saved).toHaveLength(1);
    expect(data.logs.writes[0].input).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION, reason: REASON });
    expect(data.logs.writes[0].input.status).toBe(operation.status);
    expectClean(data.logs);
  });

  test(`Action ${operation.name} failure retains the dialog and exact draft for one explicit retry`, async ({ page }) => {
    const data = await fixture(page);
    const dialog = await openAndEdit(page);
    await dialog.getByRole("button", { name: operation.button, exact: true }).click();
    await expectPending(page, dialog, data.logs, 1);
    data.release("failure");
    await expect(dialog.getByRole("alert")).toContainText(WRITE_ERROR);
    await expect(dialog).toHaveAttribute("aria-busy", "false");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Action 标题", { exact: true })).toHaveValue(EDITED_TITLE);
    await expect(dialog.getByLabel("改善说明", { exact: true })).toHaveValue(EDITED_DESCRIPTION);
    await expect(dialog.getByLabel("调整 / 审批理由", { exact: true })).toHaveValue(REASON);
    await expect(dialog.getByRole("button", { name: operation.button, exact: true })).toBeEnabled();
    expect(data.logs.saved).toHaveLength(0);
    expect(data.state.actions[0]).toMatchObject({ title: TITLE, status: "pending", revision: 1 });
    await dialog.getByRole("button", { name: operation.button, exact: true }).click();
    await expectPending(page, dialog, data.logs, 2);
    expect(data.logs.writes[1]).toEqual(data.logs.writes[0]);
    data.release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card(page, EDITED_TITLE)).toContainText(operation.badge);
    expect(data.logs.writes).toHaveLength(2);
    expect(data.logs.saved).toHaveLength(1);
    expectClean(data.logs);
  });
}

test("invalid Action fields keep the dialog open and cannot save, approve, or reject", async ({ page }) => {
  const data = await fixture(page);
  const dialog = await openAndEdit(page);
  await dialog.getByLabel("影响档口", { exact: true }).fill("");
  expect(await dialog.locator("form").evaluate(form => form.checkValidity())).toBe(false);
  for (const operation of operations) {
    const button = dialog.getByRole("button", { name: operation.button, exact: true });
    if (await button.isEnabled()) await button.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Action 标题", { exact: true })).toHaveValue(EDITED_TITLE);
    expect(data.logs.writes).toEqual([]);
  }
  await dialog.getByLabel("影响档口", { exact: true }).press("Enter");
  expect(data.logs.writes).toEqual([]);
  expect(data.logs.saved).toEqual([]);
  expectClean(data.logs);
});

test("successful Action write still closes the dialog when workspace refresh fails and is not presented as a failed save", async ({ page }) => {
  const data = await fixture(page);
  const dialog = await openAndEdit(page);
  await dialog.getByRole("button", { name: "保存调整", exact: true }).click();
  await expectPending(page, dialog, data.logs, 1);
  data.control.failNextReload = true;
  data.release();
  await expect.poll(() => data.logs.dataLoads).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Action 事项", level: 1, exact: true })).toBeVisible();
  await expect(page.getByText(RELOAD_ERROR, { exact: false }).first()).toBeVisible();
  expect(data.state.actions[0]).toMatchObject({ title: EDITED_TITLE, description: EDITED_DESCRIPTION, revision: 2 });
  expect(data.logs.saved).toHaveLength(1);
  await expect(page.locator(".toast")).toContainText("已保存");
  await expect(page.locator(".toast")).not.toContainText("保存失败");
  expect(data.logs.writes).toHaveLength(1);
  expectClean(data.logs);
});

test("pending Action submission disables close and Escape until completion", async ({ page }) => {
  const data = await fixture(page);
  const first = await openAndEdit(page);
  await first.getByRole("button", { name: "保存调整", exact: true }).click();
  await expectPending(page, first, data.logs, 1);
  const close = first.getByRole("button", { name: "关闭", exact: true });
  await expect(close).toBeDisabled();
  await close.evaluate(button => button.click());
  await page.keyboard.press("Escape");
  await expect(first).toBeVisible();
  await expect(first.getByLabel("Action 标题", { exact: true })).toHaveValue(EDITED_TITLE);
  expect(data.logs.writes).toHaveLength(1);
  data.release();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card(page, SECOND_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const second = page.getByRole("dialog", { name: SECOND_TITLE, exact: true });
  await expect(second).toBeVisible();
  await expect(second.getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
  await expect(second.getByRole("button", { name: "保存调整", exact: true })).toBeEnabled();
  await expect(second.getByLabel("Action 标题", { exact: true })).toHaveValue(SECOND_TITLE);
  expect(data.state.actions[0]).toMatchObject({ title: EDITED_TITLE, revision: 2 });
  expect(data.state.actions[1]).toMatchObject({ title: SECOND_TITLE, revision: 1 });
  expect(data.logs.writes).toHaveLength(1);
  expectClean(data.logs);
});

test("background Action generation permits viewing and dismissing cards without locking other pages", async ({ page }) => {
  const data = await fixture(page);
  await page.getByRole("button", { name: "AI 生成改善事项", exact: true }).click();
  await expect.poll(() => data.logs.writes.length).toBe(1);
  expect(data.logs.writes[0]).toMatchObject({ operation: "generate" });
  await card(page, TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const first = page.getByRole("dialog", { name: TITLE, exact: true });
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("aria-busy", "false");
  for (const button of await first.locator(".action-footer button").all()) await expect(button).toBeDisabled();
  await expect(first.getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
  await first.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card(page, SECOND_TITLE).getByRole("button", { name: "查看与审批", exact: true }).click();
  const second = page.getByRole("dialog", { name: SECOND_TITLE, exact: true });
  await expect(second).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: /反馈中心/ }).click();
  await expect(page.getByRole("heading", { name: "反馈中心", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "录入反馈", exact: true })).toBeEnabled();
  expect(data.logs.writes).toHaveLength(1);
  data.releaseGeneration();
  await expect.poll(() => data.logs.dataLoads).toBe(2);
  await page.getByRole("navigation").getByRole("button", { name: /Action 事项/ }).click();
  await expect(page.getByRole("button", { name: "AI 生成改善事项", exact: true })).toBeEnabled();
  expect(data.logs.writes).toHaveLength(1);
  expect(data.logs.saved).toHaveLength(0);
  expectClean(data.logs);
});
