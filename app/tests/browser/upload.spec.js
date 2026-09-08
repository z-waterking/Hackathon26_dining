import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";

const sourceHeaders = [
  "ID", "Completion time", "我要", "您要表扬的餐厅是？", "该餐厅哪一点您希望继续保持或发扬光大？",
  "您要提建议的餐厅是？", "请留下您宝贵的意见。", "您要投诉的餐厅是？", "请留下您要投诉的问题。", "请留下您想了解的问题。",
];
const targetHeaders = ["反馈来源", "序号", "餐厅", "日期", "反馈内容", "反馈跟进", "反馈类别", "问题分类", "回复记录", "备注"];

test("upload old Excel converts into visible ten-column table, persists and imports idempotently", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const marker = `真实上传-${testInfo.project.name}-${Date.now()}`;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("原始问卷");
  sheet.addRow(sourceHeaders);
  for (let index = 1; index <= 13; index++) {
    const content = [`${marker} 第 ${index} 条：希望增加清淡素菜。`, "请完整保留这段换行后的原始反馈正文。"].join(String.fromCharCode(10));
    sheet.addRow([`${marker}-${index}`, "2026-09-08", "建议", "", "", "寻味列车", content, "", "", ""]);
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const file = { name: `自定义文件名-${marker}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer };
  await page.goto("/");
  await page.getByLabel("搜索反馈").fill("上传前不匹配的关键词");
  await page.getByLabel("反馈月份").fill("2025-01");
  await page.getByLabel("反馈类型", { exact: true }).selectOption("投诉");
  await page.getByLabel("处理状态", { exact: true }).selectOption("已完成");
  const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/feedback/upload"));
  await page.getByLabel("上传旧表 Excel", { exact: true }).setInputFiles(file);
  const first = await (await firstResponse).json();
  expect(first.inserted).toBe(13);
  expect(first.uploaded).toBe(true);
  expect(first.source).toBe(file.name);
  await expect(page.getByLabel("搜索反馈")).toHaveValue("");
  await expect(page.getByLabel("反馈月份")).toHaveValue("");
  await expect(page.getByLabel("反馈类型", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("处理状态", { exact: true })).toHaveValue("");
  const newTable = page.getByRole("region", { name: "转换后的新表", exact: true });
  const table = newTable.getByRole("table", { name: "转换后的新餐厅反馈记录表" });
  await expect(table).toBeVisible();
  expect((await table.getByRole("columnheader").allTextContents()).slice(0, 10)).toEqual(targetHeaders);
  await expect(table.locator("tbody tr")).toHaveCount(12);
  await expect(table).toContainText("请完整保留这段换行后的原始反馈正文。");
  await expect(newTable.getByRole("link", { name: "下载目标格式 XLSX" })).toBeVisible();
  await newTable.getByRole("button", { name: "下一页" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("第 13 条");
  await newTable.getByRole("button", { name: "上一页" }).click();
  await page.screenshot({ path: testInfo.outputPath("uploaded-new-table.png") });
  await newTable.getByRole("button", { name: `跟进新表反馈 ${marker}-1`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("反馈回复").fill("人工回复应在重新上传后保留");
  await dialog.getByRole("button", { name: "保存回复" }).click();
  await expect(dialog).toContainText("已保存回复 · 1");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const reuploadResponse = page.waitForResponse((response) => response.url().endsWith("/api/feedback/upload"));
  await page.getByLabel("上传旧表 Excel", { exact: true }).setInputFiles(file);
  const second = await (await reuploadResponse).json();
  expect(second.inserted).toBe(0);
  expect(second.total).toBe(first.total);
  expect(second.skipped + second.merged).toBe(13);
  const data = await (await page.request.get("/api/data")).json();
  const imported = data.feedback.filter((item) => item.content.startsWith(marker));
  expect(imported).toHaveLength(13);
  expect(imported.find((item) => item.originalId === `${marker}-1`).replies[0].text).toBe("人工回复应在重新上传后保留");
  await page.reload();
  await expect(newTable).toBeVisible();
  await expect(newTable).toContainText(file.name);
  await expect(table.locator("tbody tr")).toHaveCount(12);
  await page.getByRole("button", { name: "收起新表", exact: true }).click();
  await expect(newTable).not.toBeVisible();
  await page.locator(".import-history > summary").click();
  await page.locator(".import-history > details > summary").first().click();
  await page.getByRole("button", { name: "查看新表", exact: true }).first().click();
  await expect(newTable).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
