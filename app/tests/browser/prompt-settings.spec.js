import { test, expect } from "@playwright/test";

const originalAction = "分析真实反馈，生成包含证据与可执行措施的改善 Action。";
const originalMenu = "按档口菜库与已启用规则安排六周菜单，并核对已批准 Action。";
const originalApproved = "把已批准且启用的排菜 Action 注入生成要求，保留可核验证据。";

async function isolate(page, { sourceChanged = false, historyCount = 1, baseAvailable = true } = {}) {
  const logs = { reads: [], writes: [], restores: [], unexpected: [], errors: [] };
  const control = { failSave: false, failGet: false, failHistory: false, failSnapshot: false, failRestore: false };
  let record = {
    version: 1, baseFingerprint: "base-fixture-1", updatedAt: "2026-09-10T02:00:00Z", sourceChanged,
    actionGenerationText: originalAction, menuSystemText: originalMenu, approvedActionText: originalApproved,
    rules: Array.from({ length: 12 }, (_, index) => ({
      id: `R-${String(index + 1).padStart(3, "0")}`, stall: index % 2 ? "寻味列车" : "全部档口",
      text: `规则 ${index + 1}：菜品搭配应兼顾清淡与多样性。`, enabled: true, meal: "午餐",
      origin: sourceChanged && index === 0 ? "override" : "source",
      ...(sourceChanged && index === 0 ? { originalText: "来源最新原文：适量增加清淡菜。" } : {}),
      source: { file: "排菜规则.xlsx", sheet: "规则列表", row: index + 2, cell: `B${index + 2}` },
    })),
    localConstraintsText: "固定价位槽位、候选菜库归属与人工菜单供给由程序校验。",
    approvedActions: [{ id: "A-approved", title: "增加清淡素菜", targetStall: "寻味列车", description: "依据员工反馈增加素菜选择。", menuInstruction: "午餐至少保留一种不辣素菜。", enabled: true, status: "approved" }],
    previews: {
      actionGeneration: "服务端完整 Action 指令 · 已保存版本 1",
      menuSystem: "服务端全局排菜组合 · 已保存版本 1",
      approvedActions: "服务端注入：午餐至少保留一种不辣素菜。",
      menuByStall: [
        { stall: "寻味列车", text: "服务端寻味列车实际指令 · 已保存版本 1", execution: "仅在有可行候选时发送排菜模型请求" },
        { stall: "宽窄巷子", text: "服务端宽窄巷子规则组合", execution: "固定出品来源，不发送排菜模型请求" },
      ],
    },
  };
  record.version = historyCount;
  const base = { ...structuredClone(record), version: 0, operation: "base", updatedAt: "2026-09-10T01:00:00Z", fingerprint: "fixed-base-fingerprint" };
  record.base = baseAvailable ? { version: 0, capturedAt: base.updatedAt, fingerprint: base.fingerprint, origin: "source-defaults", isCurrent: false } : null;
  const historical = Array.from({ length: historyCount }, (_, index) => ({ ...structuredClone(record), version: index + 1, previousVersion: index, operation: "confirm",
    fingerprint: `history-fingerprint-${index + 1}`, changedPrompts: ["menuSystemText"], rulesChanged: index % 2 === 0 }));
  historical.unshift(base);
  const summary = item => ({ version: item.version, previousVersion: item.previousVersion ?? null, updatedAt: item.updatedAt, operation: item.operation,
    fingerprint: item.fingerprint, changedPrompts: item.changedPrompts || [], rulesChanged: Boolean(item.rulesChanged), ruleCount: item.rules.length, enabledRuleCount: item.rules.filter(rule => rule.enabled !== false).length });
  const finalMenu = input => [`服务端保存后的全局排菜组合：${input.menuSystemText}`, ...input.rules.filter(rule => rule.enabled !== false).map(rule => rule.text), input.approvedActionText, "午餐至少保留一种不辣素菜。"].join("\n");
  const data = { dishes: [], feedback: [], actions: [], plans: [], imports: [], rules: [], report: { workbooks: 16, sheets: 69, formulaErrors: 0 }, initialized: {}, aiStatus: { configured: false } };
  page.on("pageerror", (error) => logs.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (request.method() === "GET") {
      logs.reads.push(pathname);
      if (pathname === "/api/data") return route.fulfill({ json: data });
      if (pathname === "/api/feedback/insights") return route.fulfill({ json: { total: 0, keywords: [], month: "" } });
      if (pathname === "/api/prompt-config") {
        if (control.failGet) return route.fulfill({ status: 503, json: { error: "配置读取暂时失败" } });
        return route.fulfill({ json: record });
      }
      if (pathname === "/api/prompt-config/history") {
        if (control.failHistory) return route.fulfill({ status: 503, json: { error: "历史读取暂时失败" } });
        const currentPage = Number(searchParams.get("page") || 1);
        const size = Number(searchParams.get("pageSize") || 10);
        const sorted = [...historical].sort((a, b) => b.version - a.version);
        return route.fulfill({ json: { items: sorted.slice((currentPage - 1) * size, currentPage * size).map(summary), total: sorted.length, page: currentPage, pageSize: size } });
      }
      if (pathname.startsWith("/api/prompt-config/history/")) {
        if (control.failSnapshot) return route.fulfill({ status: 503, json: { error: "快照读取暂时失败" } });
        const item = historical.find(value => value.version === Number(pathname.split("/").at(-1)));
        return route.fulfill({ json: { ...summary(item), actionGenerationText: item.actionGenerationText, menuSystemText: item.menuSystemText, approvedActionText: item.approvedActionText, rules: item.rules } });
      }
    }
    if (pathname === "/api/prompt-config" && request.method() === "PUT") {
      const input = request.postDataJSON();
      logs.writes.push(input);
      if (control.failSave) return route.fulfill({ status: 409, json: { error: "配置版本已更新，请重新加载后再保存" } });
      if (input.version !== record.version || input.baseFingerprint !== record.baseFingerprint) return route.fulfill({ status: 409, json: { error: "版本冲突" } });
      record = { ...record, ...input, sourceChanged: false, version: record.version + 1, baseFingerprint: `base-fixture-${record.version + 1}`, updatedAt: "2026-09-10T03:00:00Z",
        rules: input.rules.map((rule) => rule.id.startsWith("new-") ? { ...rule, id: `R-saved-${rule.id}`, source: { kind: "operator", label: "人工维护" } } : rule),
        base: { ...record.base, isCurrent: false },
        previews: { ...record.previews, actionGeneration: `服务端保存后的完整指令：${input.actionGenerationText}`, menuSystem: finalMenu(input) },
      };
      historical.push({ ...structuredClone(record), operation: "confirm", previousVersion: input.version, fingerprint: `history-fingerprint-${record.version}`,
        changedPrompts: ["actionGenerationText", "menuSystemText", "approvedActionText"], rulesChanged: true });
      return route.fulfill({ json: record });
    }
    if (pathname === "/api/prompt-config/restore-base" && request.method() === "POST") {
      const input = request.postDataJSON();
      logs.restores.push(input);
      if (control.failRestore) return route.fulfill({ status: 409, json: { error: "复原版本冲突，请重新加载" } });
      const previousVersion = record.version;
      record = { ...record, actionGenerationText: base.actionGenerationText, menuSystemText: base.menuSystemText, approvedActionText: base.approvedActionText,
        rules: structuredClone(base.rules), version: previousVersion + 1, baseFingerprint: `base-fixture-${previousVersion + 1}`, sourceChanged: false,
        updatedAt: "2026-09-10T04:00:00Z", base: { ...record.base, isCurrent: true }, previews: { ...record.previews, menuSystem: finalMenu(base) } };
      historical.push({ ...structuredClone(record), operation: "restore-base", previousVersion, fingerprint: `history-fingerprint-${record.version}`, changedPrompts: Object.keys({ actionGenerationText: 1, menuSystemText: 1, approvedActionText: 1 }), rulesChanged: true });
      return route.fulfill({ json: record });
    }
    logs.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 501, json: { error: "测试禁止非预期 API 请求" } });
  });
  return { logs, control, saved: () => record, historical: () => structuredClone(historical) };
}

async function openPrompts(page) {
  await page.goto("/#prompts");
  await expect(page.getByRole("heading", { name: "Prompt 与规则", exact: true })).toBeVisible();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(originalAction);
}

test("edits all prompts and paged rules, preserves drafts across navigation, and saves authoritative previews", async ({ page }) => {
  const { logs, saved } = await isolate(page);
  await openPrompts(page);
  const save = page.getByRole("button", { name: "确认修改并生效", exact: true });
  await expect(save).toBeDisabled();
  const updatedAction = "按真实反馈生成改善事项，必须列明证据与下一步行动。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(updatedAction);
  await page.getByText("查看实际组合的 Action System Prompt", { exact: false }).click();
  await expect(page.getByLabel("查看实际组合的 Action System Prompt")).toHaveText("服务端完整 Action 指令 · 已保存版本 1");
  await expect(page.getByRole("tabpanel", { name: /反馈 → Action/ }).getByText("当前未确认修改尚未进入预览", { exact: false })).toBeVisible();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /反馈中心/ }).click();
  await expect(page.getByRole("main").getByText(/服务端完整 Action 指令/)).not.toBeVisible();
  await page.getByRole("button", { name: "Prompt 与规则", exact: true }).click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(updatedAction);
  expect(logs.writes).toEqual([]);

  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  await page.getByLabel("规则内容 R-001", { exact: true }).fill("已修改第一条：每餐增加一种清淡蔬菜。");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByLabel("规则内容 R-011", { exact: true }).fill("已修改第十一条：优先安排时令食材。");
  await page.getByLabel("启用规则 R-011", { exact: true }).uncheck();
  await page.getByLabel("搜索排菜规则").fill("已修改第一条");
  await expect(page.getByLabel("规则内容 R-001", { exact: true })).toHaveValue("已修改第一条：每餐增加一种清淡蔬菜。");
  await page.getByLabel("规则档口 R-001", { exact: true }).fill("寻味列车、宽窄巷子");
  await page.getByLabel("搜索排菜规则").fill("规则 3：");
  await page.getByRole("button", { name: "删除规则 R-003", exact: true }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel(/^规则内容 new-/).fill("新增规则：排菜应注明需要人工核验的食材信息。");
  await page.getByText("查看程序执行的固定校验", { exact: false }).click();
  await expect(page.getByLabel("程序执行的固定校验")).toContainText("候选菜库归属");

  await page.getByRole("tab", { name: /排菜最终 Prompt/ }).click();
  const menuPanel = page.getByRole("tabpanel", { name: /排菜最终 Prompt/ });
  await expect(menuPanel.getByRole("combobox")).toHaveCount(0);
  await expect(menuPanel.getByText("实际调用档口", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("排菜 System Prompt 预览档口")).toHaveCount(0);
  const updatedMenu = "遵守档口菜库与全部启用规则，生成六周菜单并解释未满足的 Action。";
  await page.getByLabel("排菜业务 Prompt", { exact: true }).fill(updatedMenu);
  const finalPreviewToggle = menuPanel.locator("summary").filter({ hasText: "最终 Prompt 预览" });
  await expect(finalPreviewToggle).toHaveCount(1);
  await expect(finalPreviewToggle.locator("..")).toHaveAttribute("open", "");
  for (const part of ["排菜指令", "自动加入的规则", "已批准 Action", "输出格式与固定校验"]) {
    await expect(menuPanel.getByText(part, { exact: true })).toBeVisible();
  }
  const finalPreview = menuPanel.locator('pre[aria-label="最终 Prompt 预览"]');
  await expect(finalPreview).toHaveCount(1);
  await expect(finalPreview).toHaveText("服务端全局排菜组合 · 已保存版本 1");
  await expect(finalPreview).not.toContainText(updatedMenu);
  await expect(finalPreview).not.toContainText("已修改第一条");
  await expect(finalPreview).not.toContainText("服务端寻味列车实际指令");
  await expect(finalPreview).not.toContainText("服务端宽窄巷子规则组合");
  await expect(menuPanel.getByText("当前未确认修改尚未进入预览", { exact: false })).toBeVisible();

  await page.getByRole("tab", { name: /已批准 Action Prompt/ }).click();
  const updatedApproved = "加入已批准的排菜要求，逐项提供菜单中可核验的证据。";
  await page.getByLabel("已批准 Action 注入 Prompt", { exact: true }).fill(updatedApproved);
  await expect(page.getByRole("heading", { name: "可注入排菜的已批准 Action" })).toBeVisible();
  await expect(page.getByText("午餐至少保留一种不辣素菜。", { exact: false }).last()).toBeVisible();
  await save.click();
  await expect(page.getByText("与已确认版本一致", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(logs.writes).toHaveLength(1);
  const input = logs.writes[0];
  expect(input).toMatchObject({ actionGenerationText: updatedAction, menuSystemText: updatedMenu, approvedActionText: updatedApproved, version: 1, baseFingerprint: "base-fixture-1" });
  expect(input.rules).toHaveLength(12);
  expect(input.rules.find((rule) => rule.id === "R-001")).toMatchObject({ text: "已修改第一条：每餐增加一种清淡蔬菜。", stall: "寻味列车、宽窄巷子", meal: "午餐", source: { file: "排菜规则.xlsx", row: 2 } });
  expect(input.rules.find((rule) => rule.id === "R-011")).toMatchObject({ enabled: false, text: "已修改第十一条：优先安排时令食材。" });
  expect(input.rules.some((rule) => rule.id === "R-003")).toBe(false);
  expect(input.rules.some((rule) => rule.id.startsWith("new-"))).toBe(true);
  await page.getByRole("tab", { name: /排菜最终 Prompt/ }).click();
  await expect(finalPreview).toContainText(`服务端保存后的全局排菜组合：${updatedMenu}`);
  await expect(finalPreview).toContainText("已修改第一条：每餐增加一种清淡蔬菜。");
  await expect(finalPreview).not.toContainText("已修改第十一条");
  await expect(finalPreview).not.toContainText("服务端寻味列车实际指令");
  await page.getByRole("tab", { name: /反馈 → Action/ }).click();
  await expect(page.getByLabel("查看实际组合的 Action System Prompt")).toHaveText(`服务端保存后的完整指令：${updatedAction}`);
  await page.reload();
  await expect(page).toHaveURL(/#prompts$/);
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(updatedAction);
  expect(saved().version).toBe(2);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("version conflicts retain drafts and reloading only discards them after confirmation", async ({ page }) => {
  const { logs, control, saved } = await isolate(page);
  await openPrompts(page);
  const draftText = "待保存修改：增加证据关联并明确运营负责人。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(draftText);
  control.failSave = true;
  await page.getByRole("button", { name: "确认修改并生效", exact: true }).click();
  await expect(page.locator(".prompt-error")).toContainText("配置版本已更新");
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draftText);
  expect(saved().actionGenerationText).toBe(originalAction);
  const reload = page.getByRole("button", { name: "重新加载已保存的 Prompt 与规则" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await reload.click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draftText);
  await expect(page.getByText("有未确认修改 · 尚未生效", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await reload.click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(originalAction);
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeDisabled();
  expect(logs.writes).toHaveLength(1);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("changed source rules show original text and can be acknowledged without a local edit", async ({ page }) => {
  const { logs, saved } = await isolate(page, { sourceChanged: true });
  await openPrompts(page);
  await expect(page.getByText("源规则文件已变化，请核对运营覆盖与原文后保存确认。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  await expect(page.getByText(/运营调整 · 排菜规则/)).toBeVisible();
  await page.getByText("查看来源规则原文", { exact: true }).click();
  await expect(page.getByText("来源最新原文：适量增加清淡菜。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认修改并生效", exact: true }).click();
  await expect(page.getByText("源规则文件已变化，请核对运营覆盖与原文后保存确认。", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeDisabled();
  expect(logs.writes).toHaveLength(1);
  expect(logs.writes[0].rules[0]).not.toHaveProperty("origin");
  expect(logs.writes[0].rules[0]).not.toHaveProperty("originalText");
  expect(saved().version).toBe(2);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("failed refresh retains unsaved edits and validation prevents saving unusable drafts", async ({ page }) => {
  const { logs, control } = await isolate(page);
  await openPrompts(page);
  await page.getByLabel("反馈 → Action 业务 Prompt").fill("短");
  await page.getByRole("button", { name: "确认修改并生效", exact: true }).click();
  await expect(page.locator(".prompt-error")).toContainText("10 至 24,000");
  expect(logs.writes).toHaveLength(0);
  const draftText = "待保存草稿：保持反馈证据与措施之间的明确关联。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(draftText);
  control.failGet = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重新加载已保存的 Prompt 与规则" }).click();
  await expect(page.locator(".prompt-error")).toContainText("配置读取暂时失败");
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draftText);
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByRole("button", { name: "确认修改并生效", exact: true }).click();
  await expect(page.locator(".prompt-error")).toContainText("规则的适用档口和内容不能为空");
  await expect(page.getByLabel(/^规则内容 new-/)).toBeVisible();
  expect(logs.writes).toHaveLength(0);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("server configuration renders read-only without model calls and remains usable on narrow screens", async ({ page }) => {
  const writes = [];
  const errors = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") writes.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#prompts");
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).not.toHaveValue("");
  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  await expect(page.locator(".prompt-rules-table tbody tr").first()).toBeVisible();
  await page.getByRole("tab", { name: /排菜最终 Prompt/ }).click();
  await expect(page.getByLabel("排菜业务 Prompt", { exact: true })).toContainText("规则执行顺序");
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeDisabled();
  const menuPanel = page.getByRole("tabpanel", { name: /排菜最终 Prompt/ });
  await expect(menuPanel.getByRole("combobox")).toHaveCount(0);
  await expect(menuPanel.locator(".prompt-saved-preview")).toHaveAttribute("open", "");
  for (const part of ["排菜指令", "自动加入的规则", "已批准 Action", "输出格式与固定校验"]) {
    await expect(menuPanel.getByText(part, { exact: true })).toBeVisible();
  }
  await expect(menuPanel.locator('pre[aria-label="最终 Prompt 预览"]')).not.toHaveText("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("confirming rule edits updates the final prompt immediately while unconfirmed edits remain isolated", async ({ page }) => {
  const { logs, saved } = await isolate(page);
  await openPrompts(page);
  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  const revised = "确认后新规则：每周至少提供两次清淡菌菇菜。";
  await page.getByLabel("规则内容 R-001", { exact: true }).fill(revised);
  await page.getByRole("tab", { name: /排菜最终 Prompt/ }).click();
  const preview = page.getByLabel("最终 Prompt 预览", { exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).not.toContainText(revised);
  expect(logs.writes).toHaveLength(0);
  expect(saved().rules[0].text).not.toBe(revised);
  await page.getByRole("tab", { name: /全部排菜规则/ }).click();
  await page.getByRole("button", { name: "确认全部规则与 Prompt", exact: true }).click();
  await expect(page.locator(".prompt-confirmed-note")).toContainText("版本 2 已确认并生效");
  await page.getByRole("button", { name: "查看排菜最终 Prompt", exact: true }).click();
  await expect(preview).toContainText(revised);
  await expect(page.getByLabel("排菜业务 Prompt", { exact: true })).not.toHaveValue(new RegExp(revised));
  await page.getByRole("tab", { name: /确认历史/ }).click();
  await page.getByRole("button", { name: "查看版本 2", exact: true }).click();
  await expect(page.getByRole("region", { name: "历史只读快照" })).toContainText(revised);
  expect(logs.writes).toHaveLength(1);
  expect(logs.unexpected).toEqual([]);
});

test("restoring fixed base requires confirmation, discards drafts and creates history without changing Actions", async ({ page }) => {
  const { logs, historical, saved } = await isolate(page);
  await openPrompts(page);
  const changed = "人工确认的反馈指令：证据必须可定位且由运营核对。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(changed);
  await page.getByRole("button", { name: "确认修改并生效", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认修改并生效", exact: true })).toBeDisabled();
  const actions = structuredClone(saved().approvedActions);
  const draft = "未确认的临时草稿：复原前应弹出警告并允许取消。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(draft);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("三个 Prompt 与全部排菜规则"); expect(dialog.message()).toContain("Action 不会改变"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "复原到 Base", exact: true }).click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draft);
  expect(logs.restores).toHaveLength(0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "复原到 Base", exact: true }).click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(originalAction);
  await expect(page.locator(".prompt-confirmed-note")).toContainText("版本 3");
  expect(logs.restores).toEqual([{ version: 2, baseFingerprint: "base-fixture-2" }]);
  expect(saved().approvedActions).toEqual(actions);
  expect(historical().map(item => item.version)).toEqual([0, 1, 2, 3]);
  expect(historical().at(-1).operation).toBe("restore-base");
  await page.getByRole("tab", { name: /确认历史/ }).click();
  await page.getByRole("button", { name: "查看版本 2", exact: true }).click();
  await expect(page.getByRole("region", { name: "历史只读快照" })).toContainText(changed);
  await page.getByRole("button", { name: "查看 Base", exact: true }).click();
  await expect(page.getByRole("region", { name: "历史只读快照" })).toContainText("Base · 版本 0");
  await expect(page.getByLabel("历史 反馈 → Action Prompt", { exact: true })).toHaveText(originalAction);
  expect(logs.unexpected).toEqual([]);
});

test("history paginates and read failures preserve the draft and previously opened snapshot", async ({ page }) => {
  const { logs, control } = await isolate(page, { historyCount: 14 });
  await openPrompts(page);
  const draft = "未确认的完整草稿：读取历史失败也必须保留这段内容。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(draft);
  await page.getByRole("tab", { name: /确认历史/ }).click();
  const panel = page.getByRole("tabpanel", { name: /确认历史/ });
  await expect(panel.locator("tbody tr")).toHaveCount(10);
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(5);
  await panel.getByRole("button", { name: "查看版本 0", exact: true }).click();
  await expect(panel.getByRole("region", { name: "历史只读快照" })).toContainText("Base · 版本 0");
  await expect(panel.getByRole("region", { name: "历史只读快照" }).locator("textarea,input")).toHaveCount(0);
  control.failSnapshot = true;
  await panel.getByRole("button", { name: "查看版本 1", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("快照读取暂时失败");
  await expect(panel.getByRole("region", { name: "历史只读快照" })).toContainText("Base · 版本 0");
  control.failHistory = true;
  await panel.getByRole("button", { name: "刷新历史", exact: true }).click();
  await expect(panel.getByText("历史读取暂时失败", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: /反馈 → Action/ }).click();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draft);
  expect(logs.writes).toHaveLength(0);
  expect(logs.restores).toHaveLength(0);
  expect(logs.unexpected).toEqual([]);
});

test("English confirmation, base and history labels preserve source-language prompt content", async ({ page }) => {
  const { logs } = await isolate(page);
  await openPrompts(page);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm & apply", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore base", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Final menu prompt/ }).click();
  await expect(page.getByLabel("Menu business prompt", { exact: true })).toHaveValue(originalMenu);
  await expect(page.getByLabel("Final prompt preview", { exact: true })).toHaveText("服务端全局排菜组合 · 已保存版本 1");
  await page.getByRole("button", { name: "View base", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: /Confirmation history/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Read-only history snapshot" })).toContainText(originalAction);
  await expect(page.getByRole("region", { name: "Read-only history snapshot" })).toContainText("Base · Version 0");
  expect(logs.writes).toHaveLength(0);
  expect(logs.unexpected).toEqual([]);
  expect(logs.errors).toEqual([]);
});

test("base restore conflicts preserve drafts and a missing base cannot be restored", async ({ page }) => {
  const { logs, control } = await isolate(page);
  await openPrompts(page);
  const draft = "复原失败时需要保留的草稿：不得覆盖当前输入。";
  await page.getByLabel("反馈 → Action 业务 Prompt").fill(draft);
  control.failRestore = true;
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "复原到 Base", exact: true }).click();
  await expect(page.locator(".prompt-error")).toContainText("复原版本冲突");
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(draft);
  await expect(page.getByText("有未确认修改 · 尚未生效", { exact: true })).toBeVisible();
  expect(logs.restores).toHaveLength(1);
  expect(logs.writes).toHaveLength(0);
  expect(logs.unexpected).toEqual([]);
  await page.unroute("**/api/**");
  await isolate(page, { baseAvailable: false });
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await expect(page.getByLabel("反馈 → Action 业务 Prompt")).toHaveValue(originalAction);
  await expect(page.getByRole("button", { name: "复原到 Base", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "查看 Base", exact: true })).toHaveCount(0);
});
