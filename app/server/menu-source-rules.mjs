import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { audit } from "./settings.mjs";

const SOURCE_FILE = "餐厅排菜规则+示例.xlsx";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clean = (value) => String(value ?? "").replace(/[\u200b-\u200f\ufeff]/g, "").trim();

// ExcelJS forwards a merged child's value to its master, including blank
// masters whose .text getter throws. Read values directly and count B masters
// only, so a nine-row merged rule remains one sourced rule, not nine copies.
function cellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value !== "object") return clean(value);
  if (Array.isArray(value.richText)) return clean(value.richText.map((part) => part.text || "").join(""));
  if ("result" in value) return clean(value.result);
  if ("text" in value) return clean(value.text);
  return "";
}

function isOwnCell(cell) {
  return !cell.isMerged || cell.master.address === cell.address;
}

function headingMeal(text) {
  if (!/(菜单|排菜|餐次)/.test(text)) return null;
  if (text.includes("午") && !text.includes("晚")) return "午餐";
  if (text.includes("晚") && !text.includes("午")) return "晚餐";
  return null;
}

export function parseMenuSourceRules(workbook, source) {
  const rules = [];
  const fixedStaples = [];
  const fixedDishes = [];
  const warnings = [];
  const sheets = workbook.worksheets.filter((sheet) => sheet.name.startsWith("排菜规则")).slice(0, 3);
  if (!sheets.length) throw new Error(`${source.file} 未找到排菜规则工作表，未更新本地规则`);
  if (sheets.length < 3) warnings.push(`排菜规则工作表不足 3 张（实际 ${sheets.length} 张），请核对源文件`);
  const provenance = (sheet, row, column) => ({ file: source.file, sheet: sheet.name, row, cell: `${column}${row}`, fileSha256: source.sha256 });
  for (const sheet of sheets) {
    let meal = "待确认";
    const before = rules.length;
    sheet.eachRow((row, number) => {
      const stall = cellText(row.getCell("A"));
      const titleMeal = headingMeal(stall);
      if (titleMeal) { meal = titleMeal; return; }
      const cell = row.getCell("B");
      const text = cellText(cell);
      if (number <= 2 || !isOwnCell(cell) || !text) return;
      rules.push({ stall: stall || "续行", text, meal, source: provenance(sheet, number, "B") });
    });
    if (rules.length === before) warnings.push(`${sheet.name} 的 B 列未提供有效排菜规则，不据此推断额外约束`);
  }
  if (!rules.length) throw new Error(`${source.file} 未找到有效排菜规则，未更新本地规则`);

  const staplesSheet = sheets.find((sheet) => sheet.name.includes("寻味列车") && sheet.name.includes("一锅烟火"));
  if (!staplesSheet) {
    warnings.push("未找到寻味列车与一锅烟火规则工作表，固定主食需要人工核对");
  } else {
    for (const [stall, meal, row] of [
      ["寻味列车", "午餐", 11], ["寻味列车", "晚餐", 34],
      ["一锅烟火", "午餐", 24], ["一锅烟火", "晚餐", 39],
    ]) {
      const cell = staplesSheet.getCell(`C${row}`);
      const text = cellText(cell);
      if (!text) warnings.push(`${stall}${meal}固定主食源单元格 ${staplesSheet.name}!C${row} 为空，需要人工核对`);
      else fixedStaples.push({ stall, meal, text, source: provenance(staplesSheet, row, "C") });
    }
  }
  // These are fixed *dishes*, not the similarly positioned breakfast rows
  // used by the historical importer. Keep them separate from the live catalog:
  // a matching name, price and unit must exist before a planner can select one.
  const fixedSheet = sheets.find((sheet) => sheet.name.includes("宽窄巷子"));
  if (!fixedSheet) {
    warnings.push("未找到宽窄巷子规则工作表，固定菜品名单缺失，不可从早餐示例推断");
  } else {
    for (const [meal, startRow] of [["午餐", 14], ["晚餐", 49]]) {
      if (cellText(fixedSheet.getCell(`A${startRow}`)) !== "宽窄巷子" ||
        !/此档口固定出品/.test(cellText(fixedSheet.getCell(`B${startRow}`)))) {
        warnings.push(`宽窄巷子${meal}固定出品源位置 ${fixedSheet.name}!A${startRow}:D${startRow + 1} 与预期不符，需要人工核对`);
        continue;
      }
      for (const row of [startRow, startRow + 1]) {
        const name = cellText(fixedSheet.getCell(`C${row}`));
        const priceText = cellText(fixedSheet.getCell(`D${row}`));
        const parsed = priceText.match(/^(\d+(?:\.\d+)?)\s*元?\s*[/／]\s*(100g|100克|份|个|斤)$/i);
        if (!name || !parsed) {
          warnings.push(`宽窄巷子${meal}固定菜品源单元格 ${fixedSheet.name}!C${row}:D${row} 缺少名称或明确价格单位，需要人工核对`);
          continue;
        }
        fixedDishes.push({ stall: "宽窄巷子", meal, name, price: Number(parsed[1]),
          unit: /^(100g|100克)$/i.test(parsed[2]) ? "100g" : parsed[2], priceText,
          source: { ...provenance(fixedSheet, row, "C"), priceCell: `D${row}` },
        });
      }
    }
  }
  return { rules, fixedStaples, fixedDishes, source: { file: source.file, sha256: source.sha256 }, warnings };
}

export async function loadMenuSourceRules(root) {
  const bytes = await readFile(resolve(root, SOURCE_FILE));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return parseMenuSourceRules(workbook, { file: SOURCE_FILE, sha256: sha256(bytes) });
}

export async function syncMenuSourceRules(store, root) {
  // Complete all file I/O before the synchronous repository transaction. A
  // missing or invalid workbook never clears the last known source rules.
  const loaded = await loadMenuSourceRules(root);
  const fingerprint = sha256(JSON.stringify(loaded));
  let changed = false;
  store.atomic(() => {
    const previous = store.get("meta", "menu-rule-source");
    if (previous?.fingerprint === fingerprint) return;
    store.put("meta", "rules", loaded.rules);
    store.put("meta", "menu-fixed-staples", loaded.fixedStaples);
    store.put("meta", "menu-fixed-dishes", loaded.fixedDishes);
    store.put("meta", "menu-rule-source", {
      ...loaded.source, fingerprint, ruleCount: loaded.rules.length,
      fixedStapleCount: loaded.fixedStaples.length, fixedDishCount: loaded.fixedDishes.length, warnings: loaded.warnings,
    });
    audit(store, "menu.rules_synced", loaded.source.file, {
      sha256: loaded.source.sha256, fingerprint, previousFingerprint: previous?.fingerprint || null,
      ruleCount: loaded.rules.length, fixedStapleCount: loaded.fixedStaples.length, fixedDishCount: loaded.fixedDishes.length, warnings: loaded.warnings,
    });
    changed = true;
  });
  return { ...loaded, changed };
}
