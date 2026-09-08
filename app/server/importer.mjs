import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const clean = (value) =>
  String(value ?? "")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .trim();
const key = (value) => clean(value).replace(/\s/g, "");
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const columns = (row) =>
  Object.fromEntries(
    row.Cells.map((cell) => [cell.Ref.replace(/\d/g, ""), clean(cell.Text)]),
  );
const valid = (text) => text && !["ID", "/", "#N/A", "#REF!"].includes(text);
const numeric = (text) =>
  text !== "" && Number.isFinite(Number(text)) ? Number(text) : null;

export function parseDate(value, fallback = "") {
  const text = clean(value);
  if (/^\d{5}(\.\d+)?$/.test(text))
    return new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000)
      .toISOString()
      .slice(0, 10);
  const iso = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const english = text.match(
    /(June|July|August|September)\s+(\d{1,2})(?:,?\s+(2026))?/i,
  );
  if (english)
    return `2026-${{ june: "06", july: "07", august: "08", september: "09" }[english[1].toLowerCase()]}-${english[2].padStart(2, "0")}`;
  return fallback;
}

export function readMaterials(directory = resolve("../materials/inspection")) {
  const inventory = JSON.parse(
    readFileSync(resolve(directory, "inventory.json"), "utf8").replace(
      /^\uFEFF/,
      "",
    ),
  );
  const sheets = inventory.map((item) => ({
    ...item,
    ...JSON.parse(
      readFileSync(resolve(directory, `${item.Id}.json`), "utf8").replace(
        /^\uFEFF/,
        "",
      ),
    ),
  }));
  const dishes = new Map();
  const translations = new Map();
  const recipes = [];
  const rules = [];
  const provenance = (sheet, row) => ({
    file: sheet.Source.replaceAll("\\", "/"),
    sheet: sheet.Sheet,
    row,
  });
  for (const sheet of sheets) {
    for (const row of sheet.Rows) {
      const cells = columns(row);
      if (sheet.Source.includes("翻译-") && row.Row > 1 && cells.A && cells.B)
        translations.set(key(cells.A), cells.B);
      if (sheet.Sheet.startsWith("排菜规则") && cells.B && row.Row > 2)
        rules.push({
          stall: cells.A || "续行",
          text: cells.B,
          source: provenance(sheet, row.Row),
        });
    }
    if (
      sheet.Sheet.includes("预估") &&
      sheet.Rows.some((row) => columns(row).C === "原料")
    ) {
      let recipe;
      for (const row of sheet.Rows) {
        const cells = columns(row);
        if (
          cells.A &&
          !["日期", "菜单", "调料", "总计"].includes(cells.A) &&
          numeric(cells.B) > 0 &&
          valid(cells.C)
        ) {
          recipe = {
            name: cells.A,
            ingredients: [],
            source: provenance(sheet, row.Row),
            cost: null,
            issues: [],
          };
          recipes.push(recipe);
        }
        if (recipe && valid(cells.C) && numeric(cells.B) > 0) {
          recipe.ingredients.push({
            name: cells.C,
            cookedGrams: numeric(cells.D ?? ""),
            rawGrams: numeric(cells.G ?? ""),
            pricePerKg: numeric(cells.I ?? ""),
          });
          if (row.Cells.some((cell) => cell.Type === "e"))
            recipe.issues.push(`第${row.Row}行含公式错误`);
        }
        if (recipe && cells.A === "总计") {
          recipe.cost = numeric(cells.K ?? "");
          recipe = null;
        }
      }
    }
  }
  function addDish(stall, name, priceText, sheet, row, category = "") {
    if (!valid(name) || !valid(priceText)) return;
    const price = Number(priceText.match(/^\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(price)) return;
    const id = `D-${hash(`${stall}|${key(name)}|${priceText}`)}`;
    const source = provenance(sheet, row);
    if (dishes.has(id)) {
      dishes.get(id).sources.push(source);
      return;
    }
    dishes.set(id, {
      id,
      stall,
      name: clean(name),
      price,
      priceText,
      unit: /100g/.test(priceText)
        ? "100g"
        : /斤/.test(priceText)
          ? "斤"
          : /\/个/.test(priceText + name)
            ? "个"
            : "份",
      category,
      english: translations.get(key(name)) || "",
      spicy: "未知",
      vegetarian: "未知",
      mainIngredient: "",
      method: "",
      calories: null,
      allergens: "",
      labelSource: "",
      active: name.length < 70,
      sources: [source],
    });
  }
  for (const sheet of sheets.filter(
    (item) => item.Source === "第一轮+第二轮纯菜单库.xlsx",
  )) {
    for (const row of sheet.Rows) {
      const cells = columns(row);
      if (sheet.Sheet === "寻味列车+五味坊" && row.Row > 2)
        for (const stall of ["寻味列车", "五味坊"]) {
          addDish(stall, cells.B, cells.C, sheet, row.Row);
          addDish(stall, cells.E, cells.F, sheet, row.Row);
        }
      if (sheet.Sheet === "一锅烟火" && row.Row > 2)
        addDish("一锅烟火", cells.B, cells.C, sheet, row.Row);
      if (sheet.Sheet === "T1-2F量味厨房" && row.Row > 1)
        for (const [name, price, category] of [
          ["B", "C", "热菜"],
          ["F", "G", "凉菜"],
          ["J", "K", "主食杂粮"],
        ])
          addDish(
            "量味厨房",
            cells[name],
            cells[price] ? `${cells[price]}/100g` : "",
            sheet,
            row.Row,
            category,
          );
      if (sheet.Sheet === "T1-3F档口" && row.Row > 2)
        for (const [stall, name, price] of [
          ["饺好运", "B", "C"],
          ["南粉北面", "F", "G"],
          ["蒸心食意", "J", "K"],
          ["百变厨房", "N", "O"],
          ["老广老北", "R", "S"],
        ])
          addDish(stall, cells[name], cells[price], sheet, row.Row);
      if (sheet.Sheet === "早餐菜单" && row.Row > 1)
        for (const [name, price] of [
          ["B", "C"],
          ["E", "F"],
          ["H", "I"],
        ])
          addDish("早餐", cells[name], cells[price], sheet, row.Row);
      if (sheet.Sheet === "北京小院+南洋烟火" && row.Row > 1)
        for (const [name, price, stalls] of [
          ["A", "B", ["北京小院", "南洋烟火"]],
          ["C", "D", ["北京小院", "南洋烟火"]],
          ["E", "F", ["北京小院"]],
          ["G", "H", ["南洋烟火"]],
          ["I", "J", ["南洋烟火"]],
          ["K", "L", ["北京小院", "南洋烟火"]],
        ])
          for (const stall of stalls)
            addDish(stall, cells[name], cells[price], sheet, row.Row);
    }
  }
  for (const [sheetId, stall] of [
    ["book-12-sheet-001", "西岸小馆"],
    ["book-16-sheet-001", "全球美食汇"],
  ]) {
    const sheet = sheets.find((item) => item.Id === sheetId);
    let category = "";
    for (const row of sheet.Rows) {
      const cells = columns(row);
      if (cells.A && !/第.周|品类/.test(cells.A)) category = cells.A;
      for (const [name, price] of [
        ["B", "C"],
        ["D", "E"],
        ["F", "G"],
        ["H", "I"],
        ["J", "K"],
      ])
        addDish(stall, cells[name], cells[price], sheet, row.Row, category);
    }
  }
  const riceSheet = sheets.find((sheet) => sheet.Id === "book-05-sheet-001");
  let riceStall = "";
  for (const row of riceSheet.Rows.filter((row) => row.Row > 1)) {
    const cells = columns(row);
    if (cells.A) riceStall = cells.A;
    if (cells.B && cells.C) translations.set(key(cells.B), cells.C);
    addDish(riceStall, cells.B, cells.D, riceSheet, row.Row);
  }
  const fixedSheet = sheets.find((sheet) => sheet.Id === "book-01-sheet-002");
  for (const row of fixedSheet.Rows.filter((row) =>
    [14, 15].includes(row.Row),
  )) {
    const cells = columns(row);
    addDish("宽窄巷子", cells.C, cells.D, fixedSheet, row.Row, "固定出品");
  }
  const feedback = [];
  let blankRows = 0;
  let correctedCategories = 0;
  for (const sheet of sheets.filter((sheet) =>
    sheet.Source.startsWith("新餐厅反馈"),
  )) {
    const month = `2026-${sheet.Sheet.match(/\.(\d+)/)[1].padStart(2, "0")}`;
    for (const row of sheet.Rows.filter((row) => row.Row > 1)) {
      const cells = columns(row);
      if (!valid(cells.E)) {
        blankRows++;
        continue;
      }
      let type = cells.G || "待分类";
      let category = cells.H || "待分类";
      if (
        ["建议", "表扬", "投诉", "询问"].includes(category) &&
        !["建议", "表扬", "投诉", "询问"].includes(type)
      ) {
        [type, category] = [category, type];
        correctedCategories++;
      }
      const followup = valid(cells.F) ? cells.F : "";
      feedback.push({
        id: `F-${hash(`${sheet.Id}:${row.Row}`)}`,
        originalId: valid(cells.B) ? cells.B : "",
        channel: cells.A || "其他",
        restaurant: cells.C || "待确认",
        date: parseDate(cells.D, month),
        type,
        category,
        content: cells.E,
        status: followup ? "跟进中" : "未处理",
        owner: "",
        summaryRecord: cells.A === "微信群",
        threadId: "",
        duplicatePossible: false,
        sources: [provenance(sheet, row.Row)],
        events: followup ? [{ at: "", text: followup, kind: "历史跟进" }] : [],
      });
    }
  }
  let merged = 0;
  const forms = sheets.find((sheet) => sheet.Source.startsWith("微软BJW"));
  for (const row of forms.Rows.filter((row) => row.Row > 1)) {
    const cells = columns(row);
    if (Number(cells.A) <= 10) continue;
    const type =
      ["表扬", "建议", "投诉", "询问"].find((item) =>
        cells.H?.startsWith(item),
      ) || "待分类";
    const content = {
      表扬: cells.K,
      建议: cells.N,
      投诉: cells.S,
      询问: cells.U,
    }[type];
    if (!valid(content)) continue;
    const prior = feedback.find(
      (item) => item.channel === "二维码" && item.originalId === cells.A,
    );
    if (prior && key(prior.content) === key(content)) {
      prior.sources.push(provenance(forms, row.Row));
      merged++;
      continue;
    }
    if (prior) prior.duplicatePossible = true;
    feedback.push({
      id: `F-form-${cells.A}`,
      originalId: cells.A,
      channel: "二维码",
      restaurant:
        { 表扬: cells.I, 建议: cells.L, 投诉: cells.O }[type] || "待确认",
      date: parseDate(cells.C),
      type,
      category: "待分类",
      content,
      status: "未处理",
      owner: "",
      summaryRecord: false,
      duplicatePossible: Boolean(prior),
      threadId: "",
      sources: [provenance(forms, row.Row)],
      events: [],
    });
  }
  return {
    dishes: [...dishes.values()],
    feedback,
    recipes,
    rules,
    inventory: inventory.map(
      ({ Id, Source, Sheet, NonemptyRows, NonemptyCells, Errors }) => ({
        id: Id,
        source: Source,
        sheet: Sheet,
        rows: NonemptyRows,
        cells: NonemptyCells,
        errors: Errors,
      }),
    ),
    report: {
      workbooks: new Set(inventory.map((item) => item.Source)).size,
      sheets: sheets.length,
      rows: sheets.reduce((total, sheet) => total + sheet.Rows.length, 0),
      formulaErrors: inventory.reduce(
        (total, sheet) => total + sheet.Errors.length,
        0,
      ),
      blankRows,
      correctedCategories,
      merged,
      quarantinedFormRows: 10,
      files: readdirSync(directory).length,
    },
  };
}
