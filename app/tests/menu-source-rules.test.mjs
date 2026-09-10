import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { loadMenuSourceRules, parseMenuSourceRules, syncMenuSourceRules } from "../server/menu-source-rules.mjs";
import { createRepository } from "../server/data/repository.mjs";
import { createMemoryAdapter } from "../server/data/memory-adapter.mjs";

const FILE = "餐厅排菜规则+示例.xlsx";
const source = { file: FILE, sha256: "a".repeat(64) };

function workbookFixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("排菜规则-寻味列车&五味坊&一锅烟火");
  sheet.getCell("A1").value = "第一周午菜单";
  sheet.mergeCells("A1:G1");
  sheet.getCell("A2").value = "档口名称";
  sheet.getCell("B2").value = "排菜规则";
  sheet.getCell("A3").value = "寻味列车";
  sheet.getCell("B3").value = "每天三道 8 元大荤菜\n同餐次至少 60% 不辣";
  sheet.mergeCells("A3:A11");
  sheet.mergeCells("B3:B11");
  sheet.getCell("C11").value = "米饭 0.5   馒头 0.4";
  sheet.getCell("A12").value = "五味坊";
  sheet.getCell("B12").value = { richText: [{ text: "从寻味列车" }, { text: "选择菜品" }] };
  sheet.getCell("A20").value = "铁锅炖";
  sheet.getCell("B20").value = "一锅烟火菜库选四道菜";
  sheet.getCell("C24").value = "米饭0.5  贴饼子2";
  sheet.getCell("A25").value = "第一周晚菜单";
  sheet.mergeCells("A25:G25");
  sheet.getCell("A26").value = "寻味列车";
  sheet.getCell("B26").value = "和午餐排菜规则相同";
  sheet.getCell("C34").value = "米饭 0.5   馒头 0.4";
  sheet.getCell("A35").value = "铁锅炖";
  sheet.getCell("B35").value = "和午餐排菜规则相同";
  sheet.getCell("C39").value = "米饭0.5  贴饼子2";
  const others = workbook.addWorksheet("排菜规则-蒸心食意&宽窄巷子&老广老北");
  others.getCell("A1").value = "第一周午餐周菜单";
  others.getCell("A3").value = "蒸心食意";
  others.getCell("B3").value = "每天一道蒸蔬菜";
  for (const row of [14, 49]) {
    others.getCell(`A${row}`).value = "宽窄巷子";
    others.getCell(`B${row}`).value = "此档口固定出品，保持不变，复制样例即可";
    others.mergeCells(`A${row}:A${row + 1}`);
    others.mergeCells(`B${row}:B${row + 1}`);
    others.getCell(`C${row}`).value = "骨汤麻辣烫";
    others.getCell(`D${row}`).value = "4元/100g";
    others.getCell(`C${row + 1}`).value = "老式麻辣烫";
    others.getCell(`D${row + 1}`).value = "4元/100g";
  }
  others.getCell("A20").value = "老广老北";
  others.getCell("B20").value = "预留人工上传入口";
  others.getCell("A29").value = "第一周晚餐周菜单";
  others.getCell("A30").value = "百变厨房";
  others.getCell("B30").value = "预留人工上传入口";
  const quantity = workbook.addWorksheet("排菜规则-量味厨房");
  quantity.getCell("A2").value = "品类";
  quantity.getCell("B2").value = "排菜规则";
  quantity.getCell("A3").value = "素菜";
  quantity.mergeCells("B3:B8");
  const fourth = workbook.addWorksheet("排菜规则-历史说明");
  fourth.getCell("A3").value = "历史档口";
  fourth.getCell("B3").value = "不应该读取第四张规则表";
  return workbook;
}

async function fileFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dining-menu-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workbook = workbookFixture();
  const path = join(root, FILE);
  await workbook.xlsx.writeFile(path);
  return { root, path, workbook };
}

function repository(t, wrap = (adapter) => adapter) {
  const store = createRepository(wrap(createMemoryAdapter()), () => ({
    rules: [{ stall: "旧规则", text: "保留至同步成功" }],
    dishes: [{ id: "D1", name: "现有菜品" }], feedback: [],
  }));
  store.put("settings", "current", { plannerPrompt: "人工维护的 Prompt", version: 7 });
  t.after(() => store.close());
  return store;
}

test("extracts B masters only, tracks meal headings and preserves exact source stall names", () => {
  const loaded = parseMenuSourceRules(workbookFixture(), source);
  assert.equal(loaded.rules.length, 10);
  assert.deepEqual(loaded.rules.map((rule) => rule.source.cell), ["B3", "B12", "B20", "B26", "B35", "B3", "B14", "B20", "B30", "B49"]);
  assert.deepEqual(loaded.rules.map((rule) => rule.meal), ["午餐", "午餐", "午餐", "晚餐", "晚餐", "午餐", "午餐", "午餐", "晚餐", "晚餐"]);
  assert.equal(loaded.rules[2].stall, "铁锅炖");
  assert.equal(loaded.rules[1].text, "从寻味列车选择菜品");
  assert.equal(loaded.rules[0].source.fileSha256, source.sha256);
  assert.equal(loaded.rules[0].source.row, 3);
  assert.ok(loaded.rules.some((rule) => rule.stall === "老广老北" && rule.text === "预留人工上传入口"));
  assert.ok(!loaded.rules.some((rule) => rule.stall === "历史档口"));
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /量味厨房.*未提供有效排菜规则/);
});

test("keeps fixed staple text separate, with the four source coordinates and meals", () => {
  const loaded = parseMenuSourceRules(workbookFixture(), source);
  assert.deepEqual(loaded.fixedStaples.map(({ stall, meal, source }) => [stall, meal, source.cell]), [
    ["寻味列车", "午餐", "C11"], ["寻味列车", "晚餐", "C34"],
    ["一锅烟火", "午餐", "C24"], ["一锅烟火", "晚餐", "C39"],
  ]);
  assert.equal(loaded.fixedStaples[0].text, "米饭 0.5   馒头 0.4");
  assert.equal(loaded.fixedStaples[2].source.fileSha256, source.sha256);
  assert.ok(!loaded.rules.some((rule) => rule.text.includes("米饭")));
});

test("fixed dishes come from the rule sheet's four cells with explicit prices and units, never breakfast rows", () => {
  const workbook = workbookFixture();
  const breakfast = workbook.addWorksheet("六周菜单");
  breakfast.getCell("C14").value = "油条";
  breakfast.getCell("D14").value = "2元/份";
  breakfast.getCell("C15").value = "水煎包";
  breakfast.getCell("D15").value = "3元/份";
  const loaded = parseMenuSourceRules(workbook, source);
  assert.equal(loaded.fixedDishes.length, 4);
  assert.deepEqual(loaded.fixedDishes.map(({ stall, meal, name, price, unit, source }) =>
    [stall, meal, name, price, unit, source.cell, source.priceCell]), [
    ["宽窄巷子", "午餐", "骨汤麻辣烫", 4, "100g", "C14", "D14"],
    ["宽窄巷子", "午餐", "老式麻辣烫", 4, "100g", "C15", "D15"],
    ["宽窄巷子", "晚餐", "骨汤麻辣烫", 4, "100g", "C49", "D49"],
    ["宽窄巷子", "晚餐", "老式麻辣烫", 4, "100g", "C50", "D50"],
  ]);
  assert.ok(loaded.fixedDishes.every((dish) => dish.source.file === FILE && dish.source.fileSha256 === source.sha256 && dish.priceText === "4元/100g"));
  assert.ok(!loaded.fixedDishes.some((dish) => /油条|水煎包/.test(dish.name)));
  assert.equal(loaded.fixedStaples.length, 4);
});

test("missing or shifted fixed-dish cells stay unavailable instead of guessing a menu or serving unit", () => {
  const workbook = workbookFixture();
  const sheet = workbook.worksheets[1];
  sheet.getCell("C15").value = null;
  sheet.getCell("D14").value = 4;
  sheet.getCell("A49").value = "其他档口";
  const loaded = parseMenuSourceRules(workbook, source);
  assert.deepEqual(loaded.fixedDishes, []);
  assert.ok(loaded.warnings.some((warning) => warning.includes("C14:D14 缺少名称或明确价格单位")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("C15:D15 缺少名称或明确价格单位")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("A49:D50 与预期不符")));
});

test("does not infer missing meal headings or fabricate missing staple content", () => {
  const workbook = workbookFixture();
  const sheet = workbook.worksheets[0];
  sheet.getCell("A1").value = null;
  sheet.getCell("C11").value = null;
  sheet.getCell("A12").value = null;
  const loaded = parseMenuSourceRules(workbook, source);
  assert.equal(loaded.rules[0].meal, "待确认");
  assert.equal(loaded.rules[1].stall, "续行");
  assert.equal(loaded.rules[3].meal, "晚餐");
  assert.equal(loaded.fixedStaples.length, 3);
  assert.ok(loaded.warnings.some((warning) => warning.includes("C11 为空")));
});

test("reads the actual bytes once, supplies full SHA256 and leaves source unchanged", async (t) => {
  const { root, path } = await fileFixture(t);
  const before = await readFile(path);
  const loaded = await loadMenuSourceRules(root);
  assert.equal(loaded.rules.length, 10);
  assert.equal(loaded.fixedDishes.length, 4);
  assert.equal(loaded.source.sha256, createHash("sha256").update(before).digest("hex"));
  assert.deepEqual(await readFile(path), before);
});

test("syncs atomically only on content change, with audit, without modifying settings or dishes", async (t) => {
  const { root, path, workbook } = await fileFixture(t);
  const store = repository(t);
  const settings = store.all("settings");
  const dishes = store.all("dishes");
  const first = await syncMenuSourceRules(store, root);
  assert.equal(first.changed, true);
  assert.deepEqual(store.get("meta", "rules"), first.rules);
  assert.deepEqual(store.get("meta", "menu-fixed-staples"), first.fixedStaples);
  assert.deepEqual(store.get("meta", "menu-fixed-dishes"), first.fixedDishes);
  assert.equal(store.get("meta", "menu-rule-source").fixedDishCount, 4);
  assert.equal(store.all("audit").length, 1);
  assert.equal(store.all("audit")[0].kind, "menu.rules_synced");
  const unchanged = await syncMenuSourceRules(store, root);
  assert.equal(unchanged.changed, false);
  assert.equal(store.all("audit").length, 1);
  workbook.worksheets[0].getCell("B3").value = "调整后的真实排菜规则";
  await workbook.xlsx.writeFile(path);
  const changed = await syncMenuSourceRules(store, root);
  assert.equal(changed.changed, true);
  assert.notEqual(changed.source.sha256, first.source.sha256);
  assert.equal(store.get("meta", "rules")[0].text, "调整后的真实排菜规则");
  assert.equal(store.all("audit").length, 2);
  assert.deepEqual(store.all("settings"), settings);
  assert.deepEqual(store.all("dishes"), dishes);
});

test("rolls back every meta change when the audit write fails", async (t) => {
  const { root } = await fileFixture(t);
  const store = repository(t, (adapter) => ({ ...adapter, put(collection, id, value) {
    if (collection === "audit") throw new Error("audit write failed");
    return adapter.put(collection, id, value);
  } }));
  const before = store.all("meta");
  await assert.rejects(syncMenuSourceRules(store, root), /audit write failed/);
  assert.deepEqual(store.all("meta"), before);
  assert.equal(store.all("audit").length, 0);
});

test("missing or empty source never erases previous rules", async (t) => {
  const { root, path } = await fileFixture(t);
  const store = repository(t);
  const before = store.all("meta");
  await assert.rejects(syncMenuSourceRules(store, join(root, "not-present")), /ENOENT/);
  const empty = new ExcelJS.Workbook();
  empty.addWorksheet("排菜规则").getCell("B2").value = "排菜规则";
  await empty.xlsx.writeFile(path);
  await assert.rejects(syncMenuSourceRules(store, root), /未找到有效排菜规则/);
  assert.deepEqual(store.all("meta"), before);
  assert.equal(store.all("audit").length, 0);
});
