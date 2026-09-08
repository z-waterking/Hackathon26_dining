import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readMaterials, parseDate } from "../server/importer.mjs";

test("all material sheets are read and typed records exclude templates", () => {
  const data = readMaterials(
    resolve(import.meta.dirname, "../../materials/inspection"),
  );
  assert.equal(data.report.workbooks, 17);
  assert.equal(data.report.sheets, 72);
  assert.equal(data.report.rows, 22564);
  assert.equal(data.report.formulaErrors, 56);
  assert.ok(data.dishes.length > 1800);
  assert.ok(data.recipes.length > 500);
  assert.ok(
    data.feedback.every((item) => item.content && item.content !== "ID"),
  );
  assert.ok(
    !data.feedback.some((item) =>
      item.sources.some((source) => source.sheet === "2026.9反馈"),
    ),
  );
  assert.equal(data.feedback.length, 146);
  assert.ok(data.feedback.every((item) => item.sources.every((source) => source.file === "新餐厅反馈记录表-from 202607 2.xlsx")));
  assert.equal(data.report.quarantinedFormRows, 0, "raw questionnaire is imported only through the converter");
  assert.ok(data.feedback.every((item) => item.targetRow && typeof item.reply === "string"));
  assert.ok(
    data.feedback.some(
      (item) => item.type === "投诉" && item.content.length > 10,
    ),
  );
  assert.equal(
    new Set(data.dishes.map((item) => item.id)).size,
    data.dishes.length,
  );
  assert.ok(
    data.dishes
      .filter((item) => item.stall === "量味厨房")
      .every((item) => item.unit === "100g"),
  );
  for (const stall of ["米悦拌饭", "阿彩妹", "西岸小馆", "全球美食汇"])
    assert.ok(data.dishes.some((item) => item.stall === stall));
  assert.equal(
    data.dishes.find((item) => item.name === "野菜糯米糍粑").unit,
    "份",
  );
  console.log(
    JSON.stringify({
      ...data.report,
      dishes: data.dishes.length,
      feedback: data.feedback.length,
      recipes: data.recipes.length,
    }),
  );
});

test("dates use source precision without inventing a day", () => {
  assert.equal(parseDate("46237.76"), "2026-08-03");
  assert.equal(parseDate("匿名 July 2, 2026 12:33 PM"), "2026-07-02");
  assert.equal(parseDate("7月整月", "2026-07"), "2026-07");
});
