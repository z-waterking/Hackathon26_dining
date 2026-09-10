import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const CATALOG_FILE = "第一轮+第二轮纯菜单库.xlsx";
const hash = value => createHash("sha256").update(value).digest("hex");
const clean = value => String(value ?? "").replace(/[​-‏﻿]/g, "").trim();
const nameKey = value => clean(value).replace(/\s/g, "");
const identity = dish => JSON.stringify([dish.stall, nameKey(dish.name), dish.price, dish.unit]);
const text = cell => clean(cell?.text);
const mappings = [
  ["寻味列车+五味坊", 3, [["寻味列车", "B", "C"], ["寻味列车", "E", "F"], ["五味坊", "B", "C"], ["五味坊", "E", "F"]]],
  ["一锅烟火", 3, [["一锅烟火", "B", "C"]]],
  ["T1-2F量味厨房", 2, [["量味厨房", "B", "C", "热菜", "100g"], ["量味厨房", "F", "G", "凉菜", "100g"], ["量味厨房", "J", "K", "主食杂粮", "100g"]]],
  ["T1-3F档口", 3, [["饺好运", "B", "C"], ["南粉北面", "F", "G"], ["蒸心食意", "J", "K"], ["百变厨房", "N", "O"], ["老广老北", "R", "S"]]],
  ["早餐菜单", 2, [["早餐", "B", "C"], ["早餐", "E", "F"], ["早餐", "H", "I"]]],
  ["北京小院+南洋烟火", 2, [["北京小院", "A", "B"], ["南洋烟火", "A", "B"], ["北京小院", "C", "D"], ["南洋烟火", "C", "D"],
    ["北京小院", "E", "F"], ["南洋烟火", "G", "H"], ["南洋烟火", "I", "J"], ["北京小院", "K", "L"], ["南洋烟火", "K", "L"]]],
];

export function parseStallCatalog(workbook, source) {
  const missingSheets = mappings.map(([name]) => name).filter(name => !workbook.getWorksheet(name));
  if (missingSheets.length) throw new Error(`原始菜单库缺少必要工作表：${missingSheets.join("、")}；未切换为其他来源`);
  const records = new Map();
  const warnings = [];
  const rejected = [];
  let sourceRows = 0;
  const coveredStalls = [];
  for (const [sheetName, firstRow, columns] of mappings) {
    const sheet = workbook.getWorksheet(sheetName);
    for (const [stall, nameCol, priceCol, category = "", forcedUnit] of columns) {
      if (!coveredStalls.includes(stall)) coveredStalls.push(stall);
      for (let row = firstRow; row <= sheet.rowCount; row++) {
        const name = text(sheet.getCell(`${nameCol}${row}`));
        const priceText = text(sheet.getCell(`${priceCol}${row}`));
        if (!name && !priceText) continue;
        sourceRows++;
        const price = priceText.match(/^(\d+(?:\.\d+)?)(?:元)?(?:\s*[/／]\s*(100g|100克|斤|个|份|位))?$/i);
        const provenance = { file: source.file, sheet: sheetName, row, nameCell: `${nameCol}${row}`, priceCell: `${priceCol}${row}` };
        if (!name || name.length >= 70 || !price || /^(名称|菜名|售价|产品名称|菜单)$/.test(name)) {
          rejected.push({ ...provenance, reason: "名称或价格格式需人工确认" }); continue;
        }
        const unit = forcedUnit || (/^(100g|100克)$/i.test(price[2] || "") ? "100g" : price[2] || "份");
        const record = { stall, name, price: Number(price[1]), unit, category, priceText: forcedUnit ? `${price[1]}/${unit}` : priceText, sources: [provenance] };
        const key = identity(record);
        if (records.has(key)) records.get(key).sources.push(provenance); else records.set(key, record);
      }
    }
  }
  const emptyStalls = coveredStalls.filter(stall => ![...records.values()].some(record => record.stall === stall));
  if (emptyStalls.length) throw new Error(`原始菜单库中以下档口没有可解析菜品，请核对表格格式：${emptyStalls.join("、")}`);
  return { version: "stall-catalog-v1", source, coveredStalls, records: [...records.values()], warnings, rejected,
    stats: { sourceRows, uniqueDishes: records.size, duplicates: sourceRows - rejected.length - records.size, rejected: rejected.length } };
}

export async function loadStallCatalog(root) {
  const bytes = await readFile(resolve(root, CATALOG_FILE));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return parseStallCatalog(book, { file: CATALOG_FILE, sha256: hash(bytes) });
}

export function prepareStallCatalog(loaded, dishes) {
  const byIdentity = new Map();
  for (const dish of dishes) {
    const key = identity(dish);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(dish);
  }
  const groups = new Map([...new Set([...dishes.map(d => d.stall), ...loaded.coveredStalls])].map(stall => [stall,
    { stall, origin: loaded.coveredStalls.includes(stall) ? "primary" : "supplement", candidateIds: [], records: [], unresolved: [] }]));
  for (const sourceDish of loaded.records) {
    const group = groups.get(sourceDish.stall);
    const matches = byIdentity.get(identity(sourceDish)) || [];
    const active = matches.find(dish => dish.active && dish.category !== "主食杂粮");
    group.records.push({ ...sourceDish, dishIds: matches.map(d => d.id), candidateId: active?.id || null });
    if (active && sourceDish.category !== "主食杂粮") group.candidateIds.push(active.id);
    if (!matches.length) group.unresolved.push({ name: sourceDish.name, price: sourceDish.price, unit: sourceDish.unit, reason: "源表菜品未匹配当前菜库，未擅自改动已有记录" });
  }
  for (const group of groups.values()) {
    if (group.origin === "supplement") {
      const candidates = dishes.filter(d => d.stall === group.stall && d.active && d.category !== "主食杂粮");
      group.candidateIds = candidates.map(d => d.id);
      group.records = candidates.map(d => ({ name: d.name, price: d.price, unit: d.unit, sources: d.sources || [], candidateId: d.id }));
    }
    group.candidateIds = [...new Set(group.candidateIds)];
  }
  const result = { ...loaded, records: undefined, groups: [...groups.values()],
    warnings: [...loaded.warnings, ...[...groups.values()].filter(g => g.origin === "supplement").map(g => `${g.stall}未在指定纯菜单库中，沿用现有已导入来源的独立候选池`)] };
  return { ...result, fingerprint: hash(JSON.stringify(result)) };
}
