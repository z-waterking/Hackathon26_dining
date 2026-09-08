import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertFeedback, importConvertedFeedback, loadFeedbackWorkbook, TARGET_HEADERS, FEEDBACK_UPLOAD_LIMITS, feedbackDate } from "../server/feedback-converter.mjs";
import { feedbackSchema } from "../server/domain.mjs";
import { createStore } from "../server/store.mjs";

const SOURCE_HEADERS = [
  "ID", "Start time", "Completion time", "Email", "Name", "Language", "Last modified time", "我要",
  "您要表扬的餐厅是？", "表扬Alias", "该餐厅哪一点您希望继续保持或发扬光大？",
  "您要提建议的餐厅是？", "建议Alias", "请留下您宝贵的意见。",
  "您要投诉的餐厅是？您可以联系相应餐厅经理第一时间为您解决问题。", "投诉Alias",
  "本次体验发生的日期是？", "本次体验发生的时间段是？",
  "请留下您要投诉的问题。若有相关图片或视频，请发送至bjwfdc@microsoft.com.",
  "询问Alias", "请留下您想了解的问题。",
];

async function fixture(t, mutate) {
  const directory = await mkdtemp(join(tmpdir(), "dining-converter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "forms.xlsx");
  const templatePath = join(directory, "template.xlsx");
  const source = new ExcelJS.Workbook();
  const sheet = source.addWorksheet("反馈问卷");
  sheet.addRow(SOURCE_HEADERS);
  const add = (id, type, restaurant, content, column, date = new Date("2026-07-15T05:00:00Z")) => {
    const values = [];
    values[1] = id; values[3] = date; values[8] = type; values[column] = content;
    if (restaurant) values[{ 11: 9, 14: 12, 19: 15 }[column]] = restaurant;
    values[4] = "private@example.test";
    values[5] = "Private Identity";
    const row = sheet.addRow(values);
    row.getCell(3).numFmt = "yyyy-mm-dd hh:mm";
    return row;
  };
  add(1, "表扬", "餐厅甲", "米饭软硬适中", 11);
  add(2, "建议", "餐厅乙", "少放盐\n增加蔬菜", 14);
  const complaint = add(3, "投诉 (我们将在1个工作日之内与您取得联系)", "餐厅甲", "排队时间太长", 19);
  complaint.getCell(17).value = "2026-07-14";
  complaint.getCell(18).value = "午餐";
  add(4, "询问 (我们将在1个工作日之内与您取得联系)", "", "何时提供低糖饮品", 21, "August 6, 2026 11:55 AM");
  add(5, "建议", "餐厅乙", "ID", 14);
  add(6, "建议", "餐厅乙", "增加豆类菜品", 14, "2026-02-30");
  add(7, "未知分支", "餐厅乙", "意见内容", 14);
  add(8, "建议", "餐厅乙", "=SUM(A1:A2)", 14);
  const template = new ExcelJS.Workbook();
  const historical = template.addWorksheet("2026.7反馈");
  historical.addRow(TARGET_HEADERS);
  historical.getColumn(5).width = 64;
  historical.addRow(["二维码", 2, "餐厅乙", "2026-07-15", "少放盐\n增加蔬菜", "已通知后厨", "口味", "建议", "将在下周试行", "运营备注"]);
  historical.addRow(["二维码", 2, "餐厅乙", "2026-07-15", "另一个不同的正文", "不应匹配", "建议", "种类", "不应带入"]);
  historical.addRow(["二维码"]);
  if (mutate) mutate(source, template);
  await source.xlsx.writeFile(sourcePath);
  await template.xlsx.writeFile(templatePath);
  return { sourcePath, templatePath, outputDirectory: join(directory, "converted") };
}

test("converts four branches, preserves source meaning, historical reply and ten-column output", async (t) => {
  const options = await fixture(t);
  const before = await readFile(options.sourcePath);
  const converted = await convertFeedback(options);
  assert.equal(converted.report.sourceRows, 8);
  assert.equal(converted.report.convertedRows, 5);
  assert.equal(converted.report.skippedRows, 3);
  assert.equal(converted.report.matchedHistoricalRows, 1);
  assert.equal(converted.report.quarantinedRows, 0, "other workbooks' first ten rows are not presumed tests");
  for (const row of converted.rows) {
    assert.equal(feedbackSchema.safeParse(row).success, true);
    assert.deepEqual(Object.keys(row.targetRow), TARGET_HEADERS);
    assert.ok(row.provenance.source.row >= 2);
  }
  const suggestion = converted.rows.find((row) => row.originalId === "2");
  assert.equal(suggestion.type, "建议");
  assert.equal(suggestion.category, "口味");
  assert.equal(suggestion.content, "少放盐\n增加蔬菜");
  assert.equal(suggestion.reply, "将在下周试行");
  assert.equal(suggestion.targetRow.反馈跟进, "已通知后厨");
  assert.equal(suggestion.sources.length, 2);
  assert.equal(converted.rows.find((row) => row.type === "询问").restaurant, "待确认");
  assert.match(converted.rows.find((row) => row.type === "投诉").notes, /2026-07-14.*午餐/);
  assert.ok(converted.csv.includes("'=SUM(A1:A2)"));
  assert.ok(!converted.csv.includes("private@example.test"));
  assert.ok(!JSON.stringify(converted).includes("Private Identity"));
  assert.deepEqual(await readFile(options.sourcePath), before);
  const resultBook = new ExcelJS.Workbook();
  await resultBook.xlsx.readFile(converted.xlsxPath);
  assert.deepEqual(resultBook.worksheets.map((sheet) => sheet.name), ["2026.8反馈", "2026.7反馈"]);
  assert.deepEqual(resultBook.worksheets[0].getRow(1).values.slice(1), TARGET_HEADERS);
  assert.equal(resultBook.worksheets[1].getColumn(5).width, 64);
  assert.ok(resultBook.worksheets[0].getCell(2, 4).value instanceof Date);
  assert.equal(resultBook.worksheets.reduce((count, sheet) => count + sheet.rowCount - 1, 0), 5);
});

test("idempotent import preserves replies, assignments and status and keeps ID conflicts separate", async (t) => {
  const converted = await convertFeedback(await fixture(t));
  const seed = { feedback: [], dishes: [], recipes: [], rules: [], inventory: [], report: {} };
  const store = createStore(":memory:", () => seed);
  t.after(() => store.close());
  const historical = { ...converted.rows[0], id: "existing-feedback", conversionKey: undefined, targetRow: undefined, provenance: undefined, status: "已完成", reply: "人工最终回复", owner: "运营甲", events: [{ text: "人工事件" }] };
  store.put("feedback", historical.id, historical);
  const first = importConvertedFeedback(store, converted);
  assert.equal(first.inserted, 4);
  assert.equal(first.merged, 1);
  const updated = store.get("feedback", historical.id);
  assert.equal(updated.reply, "人工最终回复");
  assert.equal(updated.status, "已完成");
  assert.equal(updated.owner, "运营甲");
  assert.deepEqual(updated.events, historical.events);
  const second = importConvertedFeedback(store, converted);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 5);
  assert.equal(second.total, 5);
  const conflict = structuredClone(converted.rows[0]);
  conflict.id = "different-source-content";
  conflict.conversionKey = "different-content-key";
  conflict.content = "同一编号后来修改的正文";
  const third = importConvertedFeedback(store, { rows: [conflict] });
  assert.equal(third.inserted, 1);
  assert.equal(third.conflicts, 1);
  assert.equal(store.get("feedback", conflict.id).duplicatePossible, true);
});

test("reads prefixed OOXML produced by Forms without modifying the original", async (t) => {
  const options = await fixture(t);
  const zip = await JSZip.loadAsync(await readFile(options.sourcePath));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!name.startsWith("xl/") || !name.endsWith(".xml")) continue;
    let xml = await entry.async("string");
    if (!xml.includes('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')) continue;
    xml = xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    xml = xml.replace(/(<\/?)([A-Za-z][\w]*)(?=[\s>])/g, "$1x:$2");
    zip.file(name, xml);
  }
  zip.file("docProps/core.xml", '<coreProperties xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><lastModifiedBy>Test</lastModifiedBy></coreProperties>');
  await writeFile(options.sourcePath, await zip.generateAsync({ type: "nodebuffer" }));
  const converted = await convertFeedback(options);
  assert.equal(converted.rows.length, 5);
});

test("missing target columns fail instead of silently mapping wrong fields", async (t) => {
  const options = await fixture(t, (_, template) => { template.worksheets[0].getCell(1, 9).value = "其他列"; });
  await assert.rejects(convertFeedback(options), /十列表头/);
});

test("date parser validates dates and retains month-only precision", () => {
  assert.equal(feedbackDate("匿名 July 2, 2026 12:33 PM"), "2026-07-02");
  assert.equal(feedbackDate("2026-02-30"), "");
  assert.equal(feedbackDate("2026/9/8"), "2026-09-08");
  assert.equal(feedbackDate("7月整月", "2026-07"), "2026-07");
});

test("actual source reconciles all 149 rows without logging feedback text", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const converted = await convertFeedback({ sourcePath: join(root, "微软BJW园区餐饮反馈(1-149).xlsx"), templatePath: join(root, "新餐厅反馈记录表-from 202607 2.xlsx") });
  assert.equal(converted.report.sourceRows, 149);
  assert.equal(converted.report.convertedRows, 139);
  assert.equal(converted.report.quarantinedRows, 10);
  assert.equal(converted.report.skippedRows, 0);
  assert.equal(converted.report.matchedHistoricalRows, 88);
  assert.equal(new Set(converted.rows.map((row) => row.id)).size, 139);
  assert.ok(converted.rows.every((row) => feedbackSchema.safeParse(row).success));
});

test("upload can use the built-in ten-column format without a template file", async (t) => {
  const options = await fixture(t);
  const converted = await convertFeedback({ sourcePath: options.sourcePath, outputDirectory: options.outputDirectory });
  assert.equal(converted.rows.length, 5);
  assert.equal(converted.report.historicalRows, 0);
  assert.equal(converted.report.matchedHistoricalRows, 0);
  assert.equal(converted.report.templateKind, "builtin");
  assert.equal(converted.report.templateFile, "内置十列反馈格式 v1");
  assert.equal(converted.report.templateSha256, undefined);
  assert.equal(converted.report.templatePath, undefined);
  for (const row of converted.rows) {
    assert.deepEqual(row.provenance.template, { kind: "builtin", name: "内置十列反馈格式 v1", version: 1 });
    assert.equal(row.provenance.source.path, resolve(options.sourcePath));
    assert.equal(row.sources[0].path, resolve(options.sourcePath));
    assert.equal(row.category, "待分类");
    assert.equal(row.reply, "");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(converted.xlsxPath);
  assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), TARGET_HEADERS);
  assert.equal(workbook.worksheets[0].getColumn(5).width, 70);
  const missing = await convertFeedback({ sourcePath: options.sourcePath, templatePath: join(options.outputDirectory, "does-not-exist.xlsx") });
  assert.equal(missing.report.templateKind, "builtin");
  assert.equal(missing.rows.length, 5);
});

test("recognized May pilot batch stays quarantined under arbitrary upload names", async (t) => {
  const options = await fixture(t, (source) => {
    source.removeWorksheet(source.worksheets[0].id);
    const sheet = source.addWorksheet("用户重命名后的问卷");
    sheet.addRow(SOURCE_HEADERS);
    for (let id = 1; id <= 11; id++) {
      const cells = [];
      cells[1] = id; cells[3] = new Date("2026-05-28T12:00:00Z"); cells[8] = "建议";
      cells[12] = "餐厅甲"; cells[14] = `试填样例 ${id}`;
      const row = sheet.addRow(cells);
      row.getCell(3).numFmt = "yyyy-mm-dd";
    }
  });
  const converted = await convertFeedback({ sourcePath: options.sourcePath });
  assert.equal(converted.report.sourceFile, "forms.xlsx");
  assert.equal(converted.report.sourceRows, 11);
  assert.equal(converted.report.quarantinedRows, 10);
  assert.equal(converted.report.convertedRows, 1);
  assert.equal(converted.rows[0].originalId, "11");
});

test("rejects oversized, non-ZIP and incomplete XLSX uploads", async (t) => {
  const options = await fixture(t);
  await writeFile(options.sourcePath, Buffer.alloc(FEEDBACK_UPLOAD_LIMITS.compressedBytes + 1));
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /10 MiB/);
  await writeFile(options.sourcePath, "this is not an Excel workbook");
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /不是有效的 XLSX ZIP/);
  const zip = new JSZip();
  zip.file("plain-text.txt", "No workbook parts");
  await writeFile(options.sourcePath, await zip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /缺少工作簿部件/);
});

test("rejects unsafe XML declarations in any member including UTF-16", async (t) => {
  const options = await fixture(t);
  const original = await readFile(options.sourcePath);
  for (const [entry, payload] of [
    ["docProps/core.xml", '<!DOCTYPE properties [<!ENTITY x "value">]><properties>&x;</properties>'],
    ["xl/worksheets/sheet1.xml", '<!ENTITY x SYSTEM "file:///not-accessed"><worksheet/>'],
    ["_rels/.rels", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<!DOCTYPE Relationships><Relationships/>', "utf16le")])],
  ]) {
    const zip = await JSZip.loadAsync(original);
    zip.file(entry, payload);
    await writeFile(options.sourcePath, await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /DTD 或实体声明/);
  }
});

test("rejects ZIP traversal and member-count excess before workbook parsing", async (t) => {
  const options = await fixture(t);
  const original = await readFile(options.sourcePath);
  const traversal = await JSZip.loadAsync(original);
  traversal.file("../outside.xml", "<x/>");
  await writeFile(options.sourcePath, await traversal.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /成员路径无效/);
  const crowded = await JSZip.loadAsync(original);
  for (let i = 0; i <= FEEDBACK_UPLOAD_LIMITS.entries; i++) crowded.file(`extra/${i}.txt`, "");
  await writeFile(options.sourcePath, await crowded.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /成员数量超过/);
});

function centralOffsets(buffer) {
  const footer = buffer.length - 22;
  const entries = [];
  let cursor = buffer.readUInt32LE(footer + 16);
  while (cursor < footer) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({ cursor, name });
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  return entries;
}

test("rejects declared ZIP expansion limits and dishonest smaller member sizes", async (t) => {
  const options = await fixture(t);
  const zip = await JSZip.loadAsync(await readFile(options.sourcePath));
  const original = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const members = centralOffsets(original).filter((entry) => entry.name.endsWith(".xml"));
  const oversized = Buffer.from(original);
  oversized.writeUInt32LE(FEEDBACK_UPLOAD_LIMITS.entryBytes + 1, members[0].cursor + 24);
  await writeFile(options.sourcePath, oversized);
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /解压大小超过安全上限/);
  const cumulative = Buffer.from(original);
  for (const member of members.slice(0, 3)) cumulative.writeUInt32LE(24 * 1024 * 1024, member.cursor + 24);
  await writeFile(options.sourcePath, cumulative);
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /解压大小超过安全上限/);
  const dishonest = Buffer.from(original);
  dishonest.writeUInt32LE(1, members[0].cursor + 24);
  await writeFile(options.sourcePath, dishonest);
  await assert.rejects(loadFeedbackWorkbook(options.sourcePath), /解压失败|解压大小不一致/);
});
