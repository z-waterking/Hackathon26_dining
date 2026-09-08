import { test, expect } from "@playwright/test";
import Papa from "papaparse";

test("feedback create, follow-up, persist, export and monthly summary", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "反馈中心" })).toBeVisible();
  await page.screenshot({
    path: `test-results/feedback-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "录入反馈", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("餐厅 / 档口").fill("寻味列车");
  await dialog.getByLabel("反馈日期").fill("2026-08-28");
  const content = `浏览器验收-${info.project.name}-${Date.now()}：希望增加清淡菜品`;
  await dialog.getByLabel("反馈内容").fill(content);
  await dialog.getByRole("button", { name: "保存反馈" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("搜索反馈").fill(content);
  await expect(page.getByRole("row").filter({ hasText: content })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "跟进", exact: true }).click();
  await dialog.getByLabel("处理状态").selectOption("已完成");
  await dialog.getByLabel("负责人").fill("验收人员");
  await dialog.getByLabel("本次处理说明").fill("已现场确认改进完成");
  await dialog.getByRole("button", { name: "保存跟进" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByLabel("搜索反馈").fill(content);
  await expect(
    page.getByRole("row").filter({ hasText: content }),
  ).toContainText("已完成");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("反馈台账");
  await page.getByRole("button", { name: "月度汇总", exact: true }).click();
  await expect(dialog).toContainText("本地规则汇总");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("catalog tags, six-week generation, substitution, persistence and navigation", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /菜品资料/ })
    .click();
  await page.getByLabel("菜库档口").selectOption("饺好运");
  await page.getByLabel("搜索菜品").fill("西葫芦鸡蛋水饺");
  await page
    .getByRole("button", { name: "编辑西葫芦鸡蛋水饺", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("辣度", { exact: true }).selectOption("不辣");
  await dialog.getByLabel("素食性").selectOption("素食");
  await dialog.getByLabel("主要食材").fill("西葫芦鸡蛋");
  await dialog.getByLabel("制作工艺").selectOption("煮");
  await dialog
    .getByLabel("标签核验依据")
    .fill("自动化测试标签，仅在隔离测试库");
  await dialog.getByRole("button", { name: "保存资料" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /六周菜单/ })
    .click();
  await expect(page.getByLabel("排菜档口")).toHaveCount(0);
  const library = await (await page.request.get("/api/data")).json();
  const expectedStalls = [...new Set(library.dishes.map((dish) => dish.stall))];
  const dishMap = new Map(library.dishes.map((dish) => [dish.id, dish]));
  const generationRequests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/plans/generate"))
      generationRequests.push(request);
  });
  const generatedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/plans/generate"),
  );
  await page.getByRole("button", { name: "一次生成全部档口六周菜单" }).click();
  const generatedPlan = await (await generatedResponse).json();
  expect(generatedPlan.scope).toBe("all");
  expect(generatedPlan.stalls).toEqual(expectedStalls);
  for (const stall of expectedStalls) {
    const entries = generatedPlan.entries.filter(
      (entry) => entry.stall === stall,
    );
    expect(new Set(entries.map((entry) => entry.date)).size).toBe(30);
    for (const week of [1, 2, 3, 4, 5, 6]) {
      for (const meal of ["午餐", "晚餐"]) {
        expect(
          new Set(
            entries
              .filter((entry) => entry.week === week && entry.meal === meal)
              .map((entry) => entry.day),
          ).size,
        ).toBe(5);
      }
    }
  }
  expect([
    ...new Set(generatedPlan.entries.map((entry) => entry.week)),
  ]).toEqual([1, 2, 3, 4, 5, 6]);
  await expect(
    page.getByText(`${expectedStalls.length} 个`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "完整六周" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await expect(page.locator(".stall-menu-row")).toHaveCount(
    6 * expectedStalls.length,
  );
  await expect(
    page.getByRole("region", { name: "第6周菜单", exact: true }),
  ).toContainText("10-16");
  await page.getByRole("region", { name: "第1周菜单", exact: true }).getByRole("heading").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/all-stalls-${info.project.name}.png`,
  });
  await page.getByRole("tab", { name: "第6周" }).click();
  await expect(page.locator(".plan-week")).toHaveCount(1);
  await expect(page.getByText("10-12", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "完整六周" }).click();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  expect(generationRequests).toHaveLength(1);
  await page.getByRole("button", { name: "查看校验报告" }).click();
  await expect(dialog).toContainText("待核验");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("tab", { name: "第1周" }).click();
  await page.getByLabel("查看档口").selectOption("饺好运");
  await expect(page.locator(".stall-menu-row")).toHaveCount(1);
  expect(generationRequests).toHaveLength(1);
  const exportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出六周菜单" }).click();
  const stream = await (await exportDownload).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = Papa.parse(Buffer.concat(chunks).toString("utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  expect(exported.errors).toEqual([]);
  expect(exported.meta.fields).toEqual([
    "周次",
    "日期",
    "餐次",
    "档口",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
  ]);
  expect(exported.data).toHaveLength(generatedPlan.entries.length / 5);
  expect([...new Set(exported.data.map((row) => row.周次))]).toEqual([
    "第1周",
    "第2周",
    "第3周",
    "第4周",
    "第5周",
    "第6周",
  ]);
  expect([...new Set(exported.data.map((row) => row.餐次))]).toEqual([
    "午餐",
    "晚餐",
  ]);
  expect([...new Set(exported.data.map((row) => row.档口))]).toEqual(
    expectedStalls,
  );
  for (const stall of expectedStalls) {
    for (const week of [1, 2, 3, 4, 5, 6]) {
      for (const meal of generatedPlan.meals) {
        const rows = exported.data.filter(
          (row) =>
            row.档口 === stall &&
            row.周次 === `第${week}周` &&
            row.餐次 === meal,
        );
        const entries = generatedPlan.entries.filter(
          (entry) =>
            entry.stall === stall && entry.week === week && entry.meal === meal,
        );
        for (const entry of entries) {
          const dish = dishMap.get(entry.dishId);
          expect(
            rows[entry.slot][
              ["周一", "周二", "周三", "周四", "周五"][entry.day - 1]
            ],
          ).toBe(dish ? `${dish.name}（¥${dish.priceText}）` : "待补菜");
        }
      }
    }
  }
  await page
    .getByRole("button", { name: "查看饺好运-2026-09-07-0明细", exact: true })
    .click();
  await expect(dialog).toContainText("菜品明细");
  await expect(dialog).toContainText("菜库来源");
  await expect(dialog).toContainText("过敏原");
  await page.screenshot({
    path: `test-results/menu-details-${info.project.name}.png`,
  });
  await dialog.getByRole("button", { name: "更换菜品", exact: true }).click();
  const candidateIds = await dialog
    .getByLabel("替换菜品")
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
  expect(
    candidateIds.every((id) => dishMap.get(id).stall === "饺好运"),
  ).toBeTruthy();
  await dialog
    .getByLabel("替换菜品")
    .selectOption({ label: "牛肉圆葱水饺 · ¥24 · 未知" });
  await dialog.getByRole("button", { name: "确认换菜" }).click();
  await expect(dialog).not.toBeVisible();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/plans") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存整份草案" }).click();
  const savedPlan = await (await savedResponse).json();
  expect(savedPlan.stalls).toEqual(expectedStalls);
  expect(savedPlan.entries).toHaveLength(generatedPlan.entries.length);
  await expect(page.getByRole("status")).toContainText("完整六周草案已保存");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /反馈中心/ })
    .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /六周菜单/ })
    .click();
  await expect(
    page.getByText(`${expectedStalls.length} 个`, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/menu-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /六周菜单/ })
    .click();
  await page.getByRole("button", { name: /草案记录/ }).click();
  await dialog
    .getByRole("button")
    .filter({ hasText: "全部档口" })
    .first()
    .click();
  await expect(
    page.getByText(`${expectedStalls.length} 个`, { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".plan-week")).toHaveCount(6);
  await expect(page.locator(".stall-menu-row")).toHaveCount(
    6 * expectedStalls.length,
  );
  const restored = await (
    await page.request.get(`/api/plans/${savedPlan.id}`)
  ).json();
  expect(restored.entries).toEqual(savedPlan.entries);
  await expect(page.getByRole("tab", { name: "完整六周" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("POS empty state, isolated demo charts, CSV idempotence and invalid-date errors", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /消费分析/ })
    .click();
  await page.getByLabel("消费开始日期").fill("2025-01-01");
  await page.getByLabel("消费结束日期").fill("2025-01-31");
  await expect(page.getByText("当前期间暂无真实 POS 交易")).toBeVisible();
  await page.getByRole("button", { name: "月", exact: true }).click();
  await page.getByRole("checkbox", { name: "演示数据" }).check();
  await expect(
    page.getByText("演示模式 · 模拟交易", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.screenshot({
    path: `test-results/analytics-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("checkbox", { name: "演示数据" }).uncheck();
  const csv = `transactionId,lineId,time,stall,dishName,quantity,amount,status,unit\nE2E-${info.project.name},1,2026-08-24T12:30,寻味列车,奥尔良鸡腿,2,16,sale,份`;
  await page
    .getByLabel("导入 CSV", { exact: true })
    .filter({ visible: true })
    .setInputFiles({
      name: "pos.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await expect(page.getByRole("status")).toContainText("导入 1 行");
  await page
    .getByLabel("导入 CSV", { exact: true })
    .filter({ visible: true })
    .setInputFiles({
      name: "pos.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await expect(page.getByRole("status")).toContainText("跳过 1 行");
  await expect(
    page.getByRole("row").filter({ hasText: "奥尔良鸡腿" }),
  ).toBeVisible();
  await page.getByLabel("消费开始日期").fill("2026-09-01");
  await expect(page.getByRole("alert")).toContainText(
    "起始日期不能晚于结束日期",
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
