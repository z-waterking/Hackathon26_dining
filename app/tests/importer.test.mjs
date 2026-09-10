import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const fixed = data.dishes.filter((item) => item.stall === "宽窄巷子");
  assert.deepEqual(fixed.map(({ name, price, unit }) => [name, price, unit]),
    [["骨汤麻辣烫", 4, "100g"], ["老式麻辣烫", 4, "100g"]]);
  assert.ok(fixed.every((item) => item.category === "固定出品" && item.sources.length === 2));
  assert.deepEqual(fixed.map((item) => item.sources.map(({ cell, priceCell, meal }) => [cell, priceCell, meal])),
    [[["C14", "D14", "午餐"], ["C49", "D49", "晚餐"]], [["C15", "D15", "午餐"], ["C50", "D50", "晚餐"]]]);
  assert.ok(fixed.every((item) => item.sources.every((source) => source.file === "餐厅排菜规则+示例.xlsx" && source.kind === "fixed-menu-rule")));
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

function fixedSourceFixture(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "importer-fixed-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const row = (Row, values) => ({ Row, Cells: Object.entries(values).map(([column, Text]) => ({ Ref: `${column}${Row}`, Text, Type: "s" })) });
  const fixed = { Source: "餐厅排菜规则+示例.xlsx", Sheet: "排菜规则-宽窄巷子", Rows: [
    row(14, { A: "宽窄巷子", B: "此档口固定出品，保持不变，复制样例即可", C: "骨汤麻辣烫", D: "4元/100g" }),
    row(15, { C: "老式麻辣烫", D: "4元/100g" }),
    row(49, { A: "宽窄巷子", B: "此档口固定出品，保持不变，复制样例即可", C: "骨汤麻辣烫", D: "4元/100g" }),
    row(50, { C: "老式麻辣烫", D: "4元/100g" }),
  ] };
  const sheets = [
    { Source: "西岸小馆.xlsx", Sheet: "第二轮六周菜单", Rows: [] },
    { Source: "全球美食汇.xlsx", Sheet: "第二轮六周菜单", Rows: [] },
    { Source: "米悦+阿彩妹.xlsx", Sheet: "Sheet1 (2)", Rows: [] },
    { Source: "去重T1-3F六周早餐菜单.xlsx", Sheet: "六周菜单", Rows: [row(14, { C: "油条", D: "2" }), row(15, { C: "水煎包", D: "2" })] }, fixed,
  ];
  mutate(fixed, sheets);
  const inventory = sheets.map((sheet, index) => ({ Id: `fixture-${index}`, Source: sheet.Source, Sheet: sheet.Sheet, NonemptyRows: sheet.Rows.length, NonemptyCells: 0, Errors: [] }));
  writeFileSync(join(directory, "inventory.json"), JSON.stringify(inventory));
  sheets.forEach((sheet, index) => writeFileSync(join(directory, `fixture-${index}.json`), JSON.stringify(sheet)));
  return directory;
}

test("fresh imports use source fixed output with deterministic IDs and retain both meal sources", (t) => {
  const directory = fixedSourceFixture(t);
  const first = readMaterials(directory);
  const second = readMaterials(directory);
  assert.equal(first.dishes.length, 2);
  assert.deepEqual(first.dishes.map((dish) => dish.id), second.dishes.map((dish) => dish.id));
  assert.equal(new Set(first.dishes.map((dish) => dish.id)).size, 2);
  assert.ok(first.dishes.every((dish) => dish.active && dish.spicy === "未知" && dish.vegetarian === "未知" && dish.labelSource === ""));
  assert.ok(first.dishes.every((dish) => dish.sources.length === 2 && dish.sources.every((source) => source.kind === "fixed-menu-rule")));
  assert.ok(!first.dishes.some((dish) => ["油条", "水煎包"].includes(dish.name)));
});

test("fixed source absent, moved, ambiguous or without units never falls back to breakfast rows", (t) => {
  const mutations = [
    (fixed) => { fixed.Source = "其他规则.xlsx"; },
    (fixed, sheets) => { sheets.push(structuredClone(fixed)); },
    (fixed) => { fixed.Rows[0].Cells.find((cell) => cell.Ref === "A14").Text = "其他档口"; },
    (fixed) => { fixed.Rows[0].Cells.find((cell) => cell.Ref === "B14").Text = "其他说明"; },
    (fixed) => { fixed.Rows[2].Cells.find((cell) => cell.Ref === "D49").Text = "4"; },
    (fixed) => { fixed.Rows.pop(); },
  ];
  for (const mutate of mutations) assert.throws(() => readMaterials(fixedSourceFixture(t, mutate)), /宽窄巷子.*固定出品/);
});
