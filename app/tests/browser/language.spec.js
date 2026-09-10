import { test, expect } from "@playwright/test";

const STALL = "青禾素食";
const DISH = "清炒时蔬";
const LABEL_SOURCE = "厨师已确认配方与素食标签，依据九月核验记录。";
const CHANNEL = "测试";
const REPLY_DRAFT = "感谢反馈，我们会核验清淡菜供应并记录后续改进。";
const FEEDBACK = "原始反馈：午餐希望增加清淡素菜，保留中文便于核对。";
const THREAD_ORIGINAL = "续帖原文：希望每周能看到清淡素菜的安排。\n补充说明：菜名仍需保留中文用于核对。";
const FOLLOW_UP_NOTE = "已登记供应核验事项，下周复核轮换记录。";
const CONVERTED_ORIGINAL = "旧表原文：请保留这一条原始建议。";
const ACTION_TITLE = "增加清淡蔬菜轮换";
const ACTION_DESCRIPTION = "核验现有供应，试行蔬菜轮换并记录结果。";
const ACTION_INSTRUCTION = "午餐保留一种已核验不辣素菜。";
const ANALYSIS = "从真实反馈整理可执行的菜品供应改进。";
const ACTION_PROMPT = "根据真实反馈与证据提出具体改善事项，不编造执行结果。";
const MENU_PROMPT = "遵守菜库与启用规则，生成可核验的六周菜单。";
const APPROVED_PROMPT = "将已批准事项作为排菜要求，并保留执行证据。";
const RULE = "每餐至少提供一种清淡蔬菜，未知标签保持待核验。";
const SECOND_RULE = "每周核对菜品轮换。";
const RULE_ORIGINAL = "原始规则要求适量增加清淡菜。";
const ACTION_PREVIEW = "反馈生成完整预览，包含固定输出协议。";
const MENU_PREVIEW = "最终菜单完整预览，包含排菜指令、规则、批准事项和输出协议。";
const APPROVED_PREVIEW = "已批准事项完整注入预览。";
const CONSTRAINTS = "固定价位与候选菜库归属由程序校验。";
const KEYWORDS = [{ text: "清淡", count: 7 }, { text: "份量", count: 4 }, { text: "排队", count: 2 }];
const legacyEnglish = new Map([
  ["清淡", "Incorrect cached mild keyword"],
  ["份量", "Incorrect cached portion keyword"],
  ["排队", "Incorrect cached queue keyword"],
  [LABEL_SOURCE, "The chef confirmed the recipe and vegetarian label against the September verification record."],
  [CHANNEL, "Test channel"],
  [REPLY_DRAFT, "Thank you for your feedback. We will check mild-dish availability and record follow-up improvements."],
  [FOLLOW_UP_NOTE, "The supply verification task has been logged. Review rotation records next week."],
  ["线程补充", "Thread addition"],
  ["跟进说明", "Follow-up note"],
  [ACTION_TITLE, "Rotate mild vegetable dishes"],
  [ACTION_DESCRIPTION, "Check current supply, trial a vegetable rotation, and record the results."],
  [ACTION_INSTRUCTION, "Include one verified non-spicy vegetarian dish at lunch."],
  [ANALYSIS, "Identify practical dish-supply improvements from real feedback."],
  [ACTION_PROMPT, "Propose specific improvements supported by real feedback without inventing results."],
  [MENU_PROMPT, "Follow the dish catalog and enabled rules to produce a verifiable six-week menu."],
  [APPROVED_PROMPT, "Include approved actions as menu requirements and retain execution evidence."],
  [RULE, "Offer a mild vegetable dish at every meal and keep unknown labels unverified."],
  [SECOND_RULE, "Check the dish rotation every week."],
  [RULE_ORIGINAL, "The original rule calls for more mild dishes where appropriate."],
  [ACTION_PREVIEW, "Complete feedback-to-action preview, including the fixed output contract."],
  [MENU_PREVIEW, "Complete menu preview with instructions, rules, approved actions, and output requirements."],
  [APPROVED_PREVIEW, "Complete approved-action inclusion preview."],
  [CONSTRAINTS, "The program validates fixed prices and candidate catalog ownership."],
]);
const promptSources = new Set([ACTION_PROMPT, MENU_PROMPT, APPROVED_PROMPT, RULE, SECOND_RULE, RULE_ORIGINAL, ACTION_PREVIEW, MENU_PREVIEW, APPROVED_PREVIEW, CONSTRAINTS]);

function menuFixture() {
  const entries = Array.from({ length: 30 }, (_, index) => {
    const week = Math.floor(index / 5) + 1;
    const day = index % 5 + 1;
    const date = new Date("2026-09-14T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
    return { week, day, date: date.toISOString().slice(0, 10), meal: "午餐", stall: STALL, slot: 0, dishId: "D-LANG" };
  });
  return { id: "P-LANG", scope: "all", stall: "全部档口", stalls: [STALL], start: "2026-09-14", seed: 1, count: 1, meals: ["午餐"], entries, createdAt: "2026-09-10T01:00:00Z", validation: { errors: 0, warnings: 0, labelCoverage: 100, changeRate: null, issues: [] } };
}

// Every API request is intercepted. Obsolete English snapshots intentionally
// remain in fixtures: business text must ignore them and retain its source.
// Navigation and form tests cannot request translations, invoke AI, or change a database.
async function isolate(page) {
  const logs = { translations: [], business: [], unexpected: [], errors: [], materialsReads: 0 };
  const control = { translationsAvailable: true, convertedRows: [], keywords: [] };
  const uiTranslations = (prompts = false) => control.translationsAvailable
    ? [...legacyEnglish].filter(([source]) => promptSources.has(source) === prompts).map(([source, english]) => ({ source, english }))
    : [];
  const feedback = { id: "F-LANG", content: FEEDBACK, date: "2026-09-10", restaurant: STALL, type: "建议", category: "菜品", status: "未处理", channel: CHANNEL, owner: "", demo: false, sources: [], events: [], replies: [], aiAnalysis: { replyDraft: REPLY_DRAFT, summary: ANALYSIS } };
  const action = { id: "A-LANG", title: ACTION_TITLE, description: ACTION_DESCRIPTION, menuInstruction: ACTION_INSTRUCTION, targetStall: STALL, kind: "menu", source: "aggregate", demo: false, enabled: true, revision: 1, status: "approved", priority: "high", feedbackIds: [feedback.id], evidence: [{ feedbackId: feedback.id, quote: FEEDBACK }], history: [] };
  const plan = menuFixture();
  const dish = { id: "D-LANG", name: DISH, stall: STALL, active: true, price: 8, priceText: "8", unit: "份", spicy: "不辣", vegetarian: "素食", mainIngredient: "时令蔬菜", method: "炒", calories: null, labelSource: LABEL_SOURCE, sources: [], notes: "", verification: { status: "verified" } };
  const state = { dishes: [dish], feedback: [feedback], actions: [action], plans: [{ ...plan, entries: undefined, countEntries: 30 }], imports: [], rules: [], report: { workbooks: 1, sheets: 1, formulaErrors: 0 }, initialized: {}, aiStatus: { configured: true, model: "fixture-no-network" } };
  const materials = [
    { id: "M-LANG-1", source: "菜单资料.xlsx", sheet: "菜品", rows: 10, cells: 40, errors: [] },
    { id: "M-LANG-2", source: "菜单资料.xlsx", sheet: "配方", rows: 20, cells: 80, errors: [] },
    { id: "M-LANG-3", source: "来源记录.xlsx", sheet: "汇总", rows: 30, cells: 120, errors: [] },
  ];
  let config = { version: 1, baseFingerprint: "a".repeat(64), sourceChanged: false, updatedAt: "2026-09-10T01:00:00Z", actionGenerationText: ACTION_PROMPT, menuSystemText: MENU_PROMPT, approvedActionText: APPROVED_PROMPT,
    rules: [{ id: "R-LANG", stall: STALL, text: RULE, enabled: true, meal: "午餐", source: { file: "rules.xlsx", sheet: "Rules", row: 2 }, origin: "override", originalText: RULE_ORIGINAL }, { id: "R-LANG-2", stall: STALL, text: SECOND_RULE, enabled: true, meal: "午餐", source: null, origin: "operator" }],
    localConstraintsText: CONSTRAINTS, approvedActions: [action], previews: { actionGeneration: ACTION_PREVIEW, menuSystem: MENU_PREVIEW, approvedActions: APPROVED_PREVIEW, menuByStall: [{ stall: STALL, text: "不应读取的档口预览" }] },
  };
  page.on("pageerror", error => logs.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && pathname === "/api/ui-translations") {
      logs.translations.push(request.postDataJSON());
      logs.unexpected.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 405, json: { error: "Browser-triggered translation is forbidden" } });
    }
    if (request.method() === "GET") {
      if (pathname === "/api/data") return route.fulfill({ json: { ...state, uiTranslations: uiTranslations() } });
      if (pathname === "/api/feedback/insights") return route.fulfill({ json: { month: "", total: 1, keywords: control.keywords, uiTranslations: uiTranslations() } });
      if (pathname === "/api/actions/summary") return route.fulfill({ json: { sourceCount: 1, actions: state.actions, analysis: { sourceCount: 1, summary: ANALYSIS, createdAt: "2026-09-10T01:00:00Z" }, uiTranslations: uiTranslations() } });
      if (pathname === "/api/prompt-config") return route.fulfill({ json: { ...config, uiTranslations: uiTranslations(true) } });
      if (pathname === "/api/pos") return route.fulfill({ json: { ranking: [], trend: [], revenue: 0, sales: 0, average: 0, coverage: 0, unmapped: 0, rows: 0 } });
      if (pathname === "/api/menu-runs") return route.fulfill({ json: [] });
      if (pathname === "/api/plans/P-LANG") return route.fulfill({ json: plan });
      if (pathname === "/api/recipes/D-LANG") return route.fulfill({ json: [] });
      if (pathname === "/api/imports/I-LANG/rows") return route.fulfill({ json: { id: "I-LANG", source: "测试旧表.xlsx", headers: ["反馈来源", "序号", "餐厅", "日期", "反馈内容", "反馈跟进", "反馈类别", "问题分类", "回复记录", "备注"], rows: control.convertedRows, total: control.convertedRows.length, uiTranslations: uiTranslations() } });
      if (pathname === "/api/materials") {
        logs.materialsReads++;
        return route.fulfill({ json: materials });
      }
    }
    if (request.method() !== "GET") {
      const input = request.postDataJSON();
      logs.business.push({ method: request.method(), path: pathname, input });
      if (request.method() === "PATCH" && pathname === "/api/actions/A-LANG") {
        state.actions[0] = { ...state.actions[0], ...input, revision: state.actions[0].revision + 1 };
        return route.fulfill({ json: { ...state.actions[0], uiTranslations: uiTranslations() } });
      }
      if (request.method() === "PUT" && pathname === "/api/prompt-config") {
        config = { ...config, ...input, version: config.version + 1 };
        return route.fulfill({ json: { ...config, uiTranslations: uiTranslations(true) } });
      }
      if (request.method() === "PATCH" && pathname === "/api/dishes/D-LANG") return route.fulfill({ json: { ...dish, ...input } });
      if (request.method() === "POST" && pathname === "/api/feedback/F-LANG/reply") {
        state.feedback[0] = { ...state.feedback[0], reply: input.text, replies: [{ id: "R-LANG", text: input.text, at: "2026-09-10T02:00:00Z" }] };
        return route.fulfill({ json: state.feedback[0] });
      }
    }
    logs.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected language test request" } });
  });
  return { logs, control, state, config: () => config };
}

async function chooseEnglish(page) {
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".translation-status")).toHaveCount(0);
  await expect(page.getByText(/^Translating(?:\b|…|\.\.\.)/)).toHaveCount(0);
  await expect(page.getByText("English version unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Retry translation|Continue translation/ })).toHaveCount(0);
  await expect(page.getByText("English translations are for display. Only edits you save change the prompts sent to AI.", { exact: true })).toHaveCount(0);
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("language switching localizes all six page shells, persists the route, and preserves Chinese business content", async ({ page }) => {
  const { logs } = await isolate(page);
  await page.goto("/#feedback");
  await expect(page.getByRole("heading", { name: "反馈中心", exact: true, level: 1 })).toBeVisible();
  await chooseEnglish(page);
  await expect(page).toHaveURL(/#feedback$/);
  await expect(page.getByRole("heading", { name: "Feedback", exact: true, level: 1 })).toBeVisible();
  if (page.viewportSize().width < 760) {
    const navBounds = await page.getByRole("navigation", { name: "Main navigation" }).locator("button").evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      const label = button.querySelector("span").getBoundingClientRect();
      return { left: box.left, right: box.right, labelLeft: label.left, labelRight: label.right };
    }));
    for (let index = 0; index < navBounds.length; index++) {
      const box = navBounds[index];
      expect(box.labelLeft).toBeGreaterThanOrEqual(box.left);
      expect(box.labelRight).toBeLessThanOrEqual(box.right + 1);
      if (index) expect(box.left).toBeGreaterThanOrEqual(navBounds[index - 1].right - 1);
    }
  }
  await expect(page.getByRole("row").filter({ hasText: FEEDBACK })).toContainText(FEEDBACK);
  await expect(page.getByRole("row").filter({ hasText: FEEDBACK })).toContainText(CHANNEL);
  await expect(page.getByRole("row").filter({ hasText: FEEDBACK })).toContainText("Open");
  expect(await page.evaluate(() => localStorage.getItem("dining-ui-language"))).toBe("en");
  const pages = [
    ["actions", "Action Items", "Actions"],
    ["menus", "Six-week Menus", "Six-week menu for all stalls"],
    ["catalog", "Dish Catalog", "Dish Catalog"],
    ["analytics", "Sales Analytics", "Sales Analytics"],
    ["prompts", "Prompts & Rules", "Prompts & Rules"],
  ];
  for (const [id, name, heading] of pages) {
    const navigation = id === "prompts" ? page.locator(".sidebar-bottom") : page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
    if (id === "actions") {
      await expect(page.locator(".action-card h3")).toHaveText(ACTION_TITLE);
      await expect(page.locator(".action-card")).toContainText(ACTION_DESCRIPTION);
      await expect(page.locator(".action-card")).toContainText("Approved");
      await expect(page.locator(".action-card-evidence blockquote")).toHaveText(FEEDBACK);
    }
    if (id === "menus") {
      await page.getByRole("button", { name: /^Saved drafts/ }).click();
      await page.getByRole("dialog", { name: "Saved drafts" }).locator(".history-list button").click();
      await expect(page.locator(".plan-week")).toHaveCount(6);
      await expect(page.locator(".stall-menu-row").first()).toContainText(STALL);
      await expect(page.locator(".stall-menu-row").first()).toContainText(DISH);
    }
    if (id === "catalog") {
      await expect(page.getByText("Dishes and recipes are read from the local database, with original source references preserved.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Source inventory", exact: true }).click();
      const inventory = page.getByRole("dialog", { name: "Source inventory", exact: true });
      await expect(inventory.locator(".notice")).toHaveText("2 workbooks · 3 worksheets · 60 non-empty rows. Row counts are not feedback or dish counts.");
      await expect(inventory.locator("tbody tr")).toHaveCount(3);
      await expect(inventory.locator("tbody tr td:nth-child(3)")).toHaveText(["10", "20", "30"]);
      await expect(inventory.getByRole("cell", { name: "菜单资料.xlsx", exact: true })).toHaveCount(2);
      expect(logs.materialsReads).toBe(1);
      await noOverflow(page);
      await inventory.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "中文", exact: true }).click();
      await expect(page).toHaveURL(/#catalog$/);
      expect(logs.materialsReads).toBe(1);
      await page.getByRole("button", { name: "资料清单", exact: true }).click();
      const chineseInventory = page.getByRole("dialog", { name: "资料读取清单", exact: true });
      await expect(chineseInventory.locator(".notice")).toHaveText("2个工作簿 · 3张工作表 · 60个非空行。行数不是反馈数或菜品数。");
      await expect(chineseInventory.locator("tbody tr td:nth-child(3)")).toHaveText(["10", "20", "30"]);
      await expect(chineseInventory).not.toContainText(/22,365|22365|16个工作簿|69张工作表/);
      expect(logs.materialsReads).toBe(2);
      await chineseInventory.getByRole("button", { name: "关闭", exact: true }).click();
      await chooseEnglish(page);
    }
    if (id === "prompts") await expect(page.getByLabel("Feedback-to-action business prompt")).toHaveValue(ACTION_PROMPT);
    await noOverflow(page);
  }
  await page.reload();
  await expect(page).toHaveURL(/#prompts$/);
  await expect(page.getByRole("heading", { name: "Prompts & Rules", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Feedback-to-action business prompt")).toHaveValue(ACTION_PROMPT);
  await expect(page.getByText("English translations are for display. Only edits you save change the prompts sent to AI.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page).toHaveURL(/#prompts$/);
  await expect(page.getByRole("heading", { name: "Prompt 与规则", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(ACTION_PROMPT);
  await expect(page.getByText("English translations are for display. Only edits you save change the prompts sent to AI.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("dining-ui-language"))).toBe("zh");
  expect(logs.translations).toEqual([]);
  expect(logs.business).toEqual([]);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("English prompt views ignore legacy translations and preserve source prompts, rules and untouched payloads", async ({ page }) => {
  const { logs, config } = await isolate(page);
  await page.goto("/#prompts");
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(ACTION_PROMPT);
  await chooseEnglish(page);
  await expect(page.getByLabel("Feedback-to-action business prompt")).toHaveValue(ACTION_PROMPT);
  await expect(page.getByLabel("Feedback-to-action business prompt")).toBeEnabled();
  const actionPanel = page.getByRole("tabpanel", { name: /Feedback → Actions/ });
  await actionPanel.locator("summary").filter({ hasText: "View the assembled action system prompt" }).click();
  await expect(actionPanel.locator("pre")).toHaveText(ACTION_PREVIEW);
  await page.getByRole("tab", { name: /Approved action prompt/ }).click();
  await expect(page.getByLabel("Approved action inclusion prompt")).toHaveValue(APPROVED_PROMPT);
  const approvedPanel = page.getByRole("tabpanel", { name: /Approved action prompt/ });
  await approvedPanel.locator("summary").filter({ hasText: "View the included approved action content" }).click();
  await expect(approvedPanel.locator("pre")).toHaveText(APPROVED_PREVIEW);
  await expect(approvedPanel.locator(".prompt-approved-list")).toContainText(ACTION_TITLE);
  await expect(approvedPanel.locator(".prompt-approved-list")).toContainText(ACTION_DESCRIPTION);
  await expect(approvedPanel.locator(".prompt-approved-list")).toContainText(ACTION_INSTRUCTION);
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  expect(logs.translations).toEqual([]);
  await page.getByRole("tab", { name: /Final menu prompt/ }).click();
  await expect(page.getByLabel("Menu business prompt", { exact: true })).toHaveValue(MENU_PROMPT);
  const menuPanel = page.getByRole("tabpanel", { name: /Final menu prompt/ });
  await expect(menuPanel.locator('pre[aria-label="Final prompt preview"]')).toBeVisible();
  await expect(menuPanel.locator('pre[aria-label="Final prompt preview"]')).toHaveText(MENU_PREVIEW);
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: /All menu rules/ }).click();
  await expect(page.getByLabel("Rule content R-LANG", { exact: true })).toHaveValue(RULE);
  await expect(page.getByText(RULE_ORIGINAL, { exact: true })).toBeHidden();
  await page.getByText("View original source rule", { exact: true }).click();
  await expect(page.getByText(RULE_ORIGINAL, { exact: true })).toBeVisible();
  const rulesPanel = page.getByRole("tabpanel", { name: /All menu rules/ });
  await rulesPanel.locator("summary").filter({ hasText: "Fixed program validation" }).click();
  await expect(rulesPanel.locator("pre")).toHaveText(CONSTRAINTS);
  await page.getByLabel("Enable rule R-LANG-2", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Confirm & apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  expect(logs.business).toHaveLength(1);
  expect(logs.business[0]).toMatchObject({ method: "PUT", path: "/api/prompt-config", input: { actionGenerationText: ACTION_PROMPT, menuSystemText: MENU_PROMPT, approvedActionText: APPROVED_PROMPT } });
  expect(logs.business[0].input.rules[0]).toMatchObject({ text: RULE, stall: STALL, meal: "午餐", enabled: true });
  expect(config().rules[1].enabled).toBe(false);
  await page.getByRole("tab", { name: /Final menu prompt/ }).click();
  const menuInput = page.getByLabel("Menu business prompt", { exact: true });
  await expect(menuInput).toHaveValue(MENU_PROMPT);
  await menuInput.fill("An unsaved English instruction that must be discarded on confirmed reload.");
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeEnabled();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Reload saved prompts and rules", exact: true }).click();
  await expect(menuInput).toHaveValue(MENU_PROMPT);
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  expect(logs.business).toHaveLength(1);
  await noOverflow(page);
  expect(logs.translations).toEqual([]);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("English Action, Catalog, and reply editors show editable originals without translation snapshots", async ({ page }) => {
  const { logs, state, control } = await isolate(page);
  control.translationsAvailable = false;
  await page.goto("/#actions");
  await chooseEnglish(page);
  await expect(page.locator(".action-card h3")).toHaveText(ACTION_TITLE);
  await page.getByRole("button", { name: "Review & approve", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: ACTION_TITLE, exact: true });
  await expect(dialog.getByLabel("Action title", { exact: true })).toHaveValue(ACTION_TITLE);
  await expect(dialog.getByLabel("Action title", { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Improvement description", { exact: true })).toHaveValue(ACTION_DESCRIPTION);
  await expect(dialog.getByLabel("Improvement description", { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Menu adjustment instructions", { exact: true })).toHaveValue(ACTION_INSTRUCTION);
  await expect(dialog.getByLabel("Menu adjustment instructions", { exact: true })).toBeEnabled();
  await dialog.locator("summary").filter({ hasText: "View related feedback and evidence" }).click();
  await expect(dialog.getByText(FEEDBACK, { exact: true })).toBeVisible();
  expect(logs.business).toEqual([]);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".action-card")).toContainText("Revision 2");
  expect(logs.business[0].input).toMatchObject({ title: ACTION_TITLE, description: ACTION_DESCRIPTION, menuInstruction: ACTION_INSTRUCTION, targetStall: STALL, priority: "high" });
  await page.getByRole("button", { name: "Review & approve", exact: true }).click();
  dialog = page.getByRole("dialog", { name: ACTION_TITLE, exact: true });
  await expect(dialog.getByLabel("Action title", { exact: true })).toBeEnabled();
  const editedTitle = "Trial a rotating mild vegetable option";
  await dialog.getByLabel("Action title", { exact: true }).fill(editedTitle);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".action-card h3")).toHaveText(editedTitle);
  expect(state.actions[0]).toMatchObject({ title: editedTitle, description: ACTION_DESCRIPTION, menuInstruction: ACTION_INSTRUCTION, targetStall: STALL });
  expect(logs.business).toHaveLength(2);
  expect(logs.translations).toEqual([]);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Dish Catalog/ }).click();
  await page.getByRole("button", { name: `Edit ${DISH}`, exact: true }).click();
  const catalogDialog = page.getByRole("dialog", { name: DISH, exact: true });
  await expect(catalogDialog.getByLabel("Label evidence", { exact: true })).toHaveValue(LABEL_SOURCE);
  await expect(catalogDialog.getByLabel("Label evidence", { exact: true })).toBeEnabled();
  await expect(catalogDialog.getByLabel("Main ingredient", { exact: true })).toHaveValue("时令蔬菜");
  await catalogDialog.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(catalogDialog).toHaveCount(0);
  expect(logs.business).toHaveLength(3);
  expect(logs.business[2]).toMatchObject({ method: "PATCH", path: "/api/dishes/D-LANG", input: { labelSource: LABEL_SOURCE, mainIngredient: "时令蔬菜", spicy: "不辣", vegetarian: "素食", method: "炒", active: true } });
  expect(logs.translations).toEqual([]);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Feedback/ }).click();
  await page.getByRole("row").filter({ hasText: FEEDBACK }).getByRole("button", { name: "Follow up", exact: true }).click();
  const feedbackDialog = page.getByRole("dialog", { name: "Feedback follow-up", exact: true });
  await expect(feedbackDialog.locator(".feedback-full").first()).toHaveText(FEEDBACK);
  await feedbackDialog.getByRole("button", { name: "Use AI reply draft", exact: true }).click();
  await expect(feedbackDialog.getByLabel("Feedback reply", { exact: true })).toHaveValue(REPLY_DRAFT);
  await expect(feedbackDialog.getByLabel("Feedback reply", { exact: true })).toBeEnabled();
  await feedbackDialog.getByRole("button", { name: "Save reply", exact: true }).click();
  await expect(feedbackDialog.getByLabel("Feedback reply", { exact: true })).toHaveValue("");
  expect(logs.business).toHaveLength(4);
  expect(logs.business[3]).toMatchObject({ method: "POST", path: "/api/feedback/F-LANG/reply", input: { text: REPLY_DRAFT } });
  expect(state.feedback[0].reply).toBe(REPLY_DRAFT);
  await feedbackDialog.getByLabel("Feedback reply", { exact: true }).fill("运营手动输入的中文草稿保留原样。");
  await expect(feedbackDialog.getByLabel("Feedback reply", { exact: true })).toHaveValue("运营手动输入的中文草稿保留原样。");
  expect(logs.translations).toEqual([]);
  await noOverflow(page);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("English follow-up timelines and converted rows preserve all source additions and operator notes", async ({ page }) => {
  const { logs, state, control } = await isolate(page);
  state.feedback[0].events = [
    { kind: "线程补充", text: THREAD_ORIGINAL, at: "2026-09-10T02:00:00Z" },
    { kind: "跟进说明", text: FOLLOW_UP_NOTE, at: "2026-09-10T03:00:00Z" },
  ];
  state.imports = [{ id: "I-LANG", source: "测试旧表.xlsx", uploaded: true, report: { sourceRows: 2, convertedRows: 2 } }];
  const sourceFollowUp = `${FEEDBACK}\r\n${FOLLOW_UP_NOTE}\r\n作者续帖：${THREAD_ORIGINAL}`;
  control.convertedRows = [
    { feedbackId: "F-LANG", targetRow: { 反馈来源: "邮件", 序号: "1", 餐厅: STALL, 日期: "2026-09-10", 反馈内容: CONVERTED_ORIGINAL, 反馈跟进: sourceFollowUp, 反馈类别: "建议", 问题分类: "菜品", 回复记录: "", 备注: "" } },
    { feedbackId: null, targetRow: { 反馈来源: "邮件", 序号: "2", 餐厅: STALL, 日期: "2026-09-10", 反馈内容: CONVERTED_ORIGINAL, 反馈跟进: `${CONVERTED_ORIGINAL}\n${FOLLOW_UP_NOTE}`, 反馈类别: "建议", 问题分类: "菜品", 回复记录: "", 备注: "" } },
  ];
  const originalFeedback = structuredClone(state.feedback);
  const originalRows = structuredClone(control.convertedRows);
  await page.goto("/#feedback");
  await chooseEnglish(page);
  const table = page.getByRole("table", { name: "Converted restaurant feedback records", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const firstRow = table.locator("tbody tr").nth(0);
  await expect(firstRow.locator("td").nth(4)).toHaveText(CONVERTED_ORIGINAL);
  await expect(firstRow.locator("td").nth(5)).toHaveText(`${FEEDBACK}\r\n${FOLLOW_UP_NOTE}\r\n作者续帖：${THREAD_ORIGINAL}`);
  expect(await firstRow.locator("td").nth(5).textContent()).toBe(sourceFollowUp);
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(5)).toHaveText(`${CONVERTED_ORIGINAL}\n${FOLLOW_UP_NOTE}`);
  await expect(table).not.toContainText("English version unavailable");
  await firstRow.getByRole("button", { name: "Follow up converted feedback 1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Feedback follow-up", exact: true });
  await expect(dialog.locator(".timeline > div").nth(0).locator("p")).toHaveText(THREAD_ORIGINAL);
  await expect(dialog.locator(".timeline > div").nth(1).locator("p")).toHaveText(FOLLOW_UP_NOTE);
  await expect(dialog.locator(".timeline")).not.toContainText("English version unavailable");
  await noOverflow(page);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator(".converted-table tbody tr").nth(0).locator("td").nth(5)).toHaveText(sourceFollowUp);
  expect(state.feedback).toEqual(originalFeedback);
  expect(control.convertedRows).toEqual(originalRows);
  expect(logs.translations).toEqual([]);
  expect(logs.business).toEqual([]);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("business prompts remain complete and editable without English snapshots and saved edits apply verbatim", async ({ page }) => {
  const { logs, control, config } = await isolate(page);
  control.translationsAvailable = false;
  await page.goto("/#prompts");
  await chooseEnglish(page);
  await expect(page.getByLabel("Feedback-to-action business prompt")).toHaveValue(ACTION_PROMPT);
  await expect(page.getByLabel("Feedback-to-action business prompt")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Retry translation|Continue translation/ })).toHaveCount(0);
  expect(logs.translations).toEqual([]);
  expect(config()).toMatchObject({ actionGenerationText: ACTION_PROMPT, menuSystemText: MENU_PROMPT, approvedActionText: APPROVED_PROMPT });
  const editedPrompt = `${ACTION_PROMPT}\n运营新增要求：保留来源证据并记录下次核验时间。`;
  await page.getByLabel("Feedback-to-action business prompt").fill(editedPrompt);
  await page.getByRole("button", { name: "Confirm & apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  expect(config().actionGenerationText).toBe(editedPrompt);
  expect(logs.business).toHaveLength(1);
  expect(logs.business[0]).toMatchObject({ method: "PUT", path: "/api/prompt-config", input: { actionGenerationText: editedPrompt, menuSystemText: MENU_PROMPT, approvedActionText: APPROVED_PROMPT } });
  await page.getByRole("button", { name: "Reload saved prompts and rules", exact: true }).click();
  await expect(page.getByLabel("Feedback-to-action business prompt")).toHaveValue(editedPrompt);
  await expect(page.getByLabel("Feedback-to-action business prompt")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: /All menu rules/ }).click();
  await expect(page.getByLabel("Rule content R-LANG", { exact: true })).toHaveValue(RULE);
  await expect(page.getByLabel("Rule content R-LANG", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Rule content R-LANG-2", { exact: true })).toHaveValue(SECOND_RULE);
  await expect(page.getByLabel("Rule content R-LANG-2", { exact: true })).toBeEnabled();
  await expect(page.getByText("English version unavailable", { exact: true })).toHaveCount(0);
  expect(logs.translations).toEqual([]);
  expect(logs.business).toHaveLength(1);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
  await noOverflow(page);
});

test("English word-cloud labels and counts preserve Chinese source words despite incorrect cached translations", async ({ page }) => {
  const { logs, state, control } = await isolate(page);
  control.keywords = structuredClone(KEYWORDS);
  const originalFeedback = structuredClone(state.feedback);
  await page.goto("/#feedback");
  await chooseEnglish(page);
  const cloud = page.locator(".feedback-wordcloud-root");
  const image = page.getByRole("img", { name: "Feedback word cloud", exact: true });
  await expect(image).toBeVisible();
  await expect(cloud).toHaveAttribute("aria-busy", "false");
  await expect(image.locator("text")).toHaveCount(KEYWORDS.length);
  const words = await image.locator("text").evaluateAll(elements => elements.map(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("")));
  expect(words.sort()).toEqual(KEYWORDS.map(word => word.text).sort());
  for (const word of KEYWORDS) {
    const countLabel = `${word.text}: ${word.count} feedback records`;
    await expect(image.locator("desc")).toContainText(countLabel);
    await expect(image.locator("text title").filter({ hasText: countLabel })).toHaveCount(1);
    await expect(cloud).not.toContainText(legacyEnglish.get(word.text));
  }
  await expect(cloud).toContainText("Word size reflects feedback count · Hover for counts");
  await expect(cloud).not.toContainText(/English version unavailable|translations have not been prepared|prepared English version|Translating/);
  await noOverflow(page);
  control.translationsAvailable = false;
  await page.reload();
  await expect(image).toBeVisible();
  await expect(cloud).toHaveAttribute("aria-busy", "false");
  await expect(image.locator("text")).toHaveCount(KEYWORDS.length);
  for (const word of KEYWORDS) await expect(image.locator("desc")).toContainText(`${word.text}: ${word.count} feedback records`);
  await expect(cloud).not.toContainText(/English version unavailable|translations have not been prepared|prepared English version|Translating/);
  expect(control.keywords).toEqual(KEYWORDS);
  expect(state.feedback).toEqual(originalFeedback);
  expect(logs.translations).toEqual([]);
  expect(logs.business).toEqual([]);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("business titles and AI keyword badges matching UI dictionary entries retain their original Chinese", async ({ page }) => {
  const { logs, state } = await isolate(page);
  state.actions[0].title = "服务";
  state.dishes[0].name = "口味";
  state.dishes[0].stall = "服务";
  state.feedback[0].aiAnalysis.keywords = ["服务", { text: "口味", count: 2 }];
  const sourceData = structuredClone(state);
  await page.goto("/#actions");
  await chooseEnglish(page);
  await expect(page.locator(".action-card h3")).toHaveText("服务");
  await page.getByRole("button", { name: "Review & approve", exact: true }).click();
  const actionDialog = page.getByRole("dialog", { name: "服务", exact: true });
  await expect(actionDialog.getByRole("heading", { name: "服务", level: 2, exact: true })).toBeVisible();
  await expect(actionDialog.getByLabel("Action title", { exact: true })).toHaveValue("服务");
  await expect(actionDialog.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
  await actionDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /Dish Catalog/ }).click();
  await page.getByRole("button", { name: "Edit 口味", exact: true }).click();
  const catalogDialog = page.getByRole("dialog", { name: "口味", exact: true });
  await expect(catalogDialog.getByRole("heading", { name: "口味", level: 2, exact: true })).toBeVisible();
  await expect(catalogDialog.locator(".detail-meta .badge")).toHaveText("服务");
  await expect(catalogDialog.getByRole("button", { name: "Save details", exact: true })).toBeEnabled();
  await catalogDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Feedback/ }).click();
  await page.getByRole("row").filter({ hasText: FEEDBACK }).getByRole("button", { name: "Follow up", exact: true }).click();
  const feedbackDialog = page.getByRole("dialog", { name: "Feedback follow-up", exact: true });
  await expect(feedbackDialog.getByText("Feedback analysis", { exact: true })).toBeVisible();
  await expect(feedbackDialog.locator(".ai-analysis .badge")).toHaveText(["服务", "口味"]);
  await expect(feedbackDialog.getByRole("button", { name: "Use AI reply draft", exact: true })).toBeVisible();
  await noOverflow(page);
  expect(state).toEqual(sourceData);
  expect(logs.translations).toEqual([]);
  expect(logs.business).toEqual([]);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});
