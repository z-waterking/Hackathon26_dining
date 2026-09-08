import ExcelJS from "exceljs";
import JSZip from "jszip";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const clean = (value) => String(value ?? "").replace(/[\u200b-\u200f\ufeff]/g, "").trim();

export const TARGET_HEADERS = [
  "反馈来源", "序号", "餐厅", "日期", "反馈内容",
  "反馈跟进", "反馈类别", "问题分类", "回复记录", "备注",
];
export const FEEDBACK_UPLOAD_LIMITS = Object.freeze({
  compressedBytes: 10 * 1024 * 1024, entries: 512,
  entryBytes: 32 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
});
const BUILTIN_TEMPLATE_NAME = "内置十列反馈格式 v1";

function invalidWorkbook(message) {
  return new Error(`无效或不安全的 XLSX：${message}`);
}

// Validate advertised sizes before any decompression. ZIP64, encrypted and
// multi-disk containers are unnecessary for a <=10 MiB feedback upload.
function inspectZipDirectory(data) {
  const limits = FEEDBACK_UPLOAD_LIMITS;
  if (data.length > limits.compressedBytes) throw invalidWorkbook("文件超过10 MiB上限");
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw invalidWorkbook("不是有效的 XLSX ZIP 文件");
  let footer = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65557); index--) {
    if (data.readUInt32LE(index) === 0x06054b50 && index + 22 + data.readUInt16LE(index + 20) === data.length) { footer = index; break; }
  }
  if (footer < 0) throw invalidWorkbook("ZIP 目录缺失或已损坏");
  const count = data.readUInt16LE(footer + 10);
  const size = data.readUInt32LE(footer + 12);
  const offset = data.readUInt32LE(footer + 16);
  if (data.readUInt16LE(footer + 4) || data.readUInt16LE(footer + 6) || data.readUInt16LE(footer + 8) !== count || count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    throw invalidWorkbook("不支持多卷、ZIP64 或加密文件");
  if (!count || count > limits.entries) throw invalidWorkbook(`ZIP 成员数量超过${limits.entries}个上限或目录为空`);
  if (offset + size !== footer) throw invalidWorkbook("ZIP 目录范围不正确");
  const entries = new Map();
  let cursor = offset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > footer || data.readUInt32LE(cursor) !== 0x02014b50) throw invalidWorkbook("ZIP 成员目录损坏");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const expandedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const recordLength = 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    if (cursor + recordLength > footer || !nameLength) throw invalidWorkbook("ZIP 成员名称损坏");
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (/^[/\\]|^[a-z]:|\\|\0/i.test(name) || name.split("/").some((part) => part === ".." || part === ".") || entries.has(name))
      throw invalidWorkbook("ZIP 成员路径无效或重复");
    if (flags & 1 || data.readUInt16LE(cursor + 34) || ![0, 8].includes(method)) throw invalidWorkbook("ZIP 成员使用不支持的加密或压缩方式");
    if (expandedSize > limits.entryBytes || expanded + expandedSize > limits.expandedBytes) throw invalidWorkbook("ZIP 解压大小超过安全上限");
    expanded += expandedSize;
    if (localOffset + 30 > offset || data.readUInt32LE(localOffset) !== 0x04034b50) throw invalidWorkbook("ZIP 本地成员范围损坏");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const contentOffset = localOffset + 30 + localNameLength + data.readUInt16LE(localOffset + 28);
    if (contentOffset + compressedSize > offset || data.readUInt16LE(localOffset + 6) !== flags || data.readUInt16LE(localOffset + 8) !== method || data.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name)
      throw invalidWorkbook("ZIP 本地成员与目录不一致");
    entries.set(name, { expandedSize, compressedSize, contentOffset, method });
    cursor += recordLength;
  }
  if (cursor !== footer) throw invalidWorkbook("ZIP 目录包含额外数据");
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"])
    if (!entries.has(required)) throw invalidWorkbook(`缺少工作簿部件 ${required}`);
  return entries;
}

function xmlText(buffer) {
  let encoding = "utf-8";
  if (buffer.length >= 2 && (buffer[0] === 0xff && buffer[1] === 0xfe || buffer[0] === 0x3c && buffer[1] === 0)) encoding = "utf-16le";
  if (buffer.length >= 2 && (buffer[0] === 0xfe && buffer[1] === 0xff || buffer[0] === 0 && buffer[1] === 0x3c)) encoding = "utf-16be";
  const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  if (text.includes("\0") || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw invalidWorkbook("XML 不允许 DTD 或实体声明");
  return text.replace(/(<\?xml[^>]*encoding\s*=\s*["'])[^"']+(["'])/i, "$1UTF-8$2");
}

// Forms exports may use x: tags and an unprefixed core-properties namespace.
// ExcelJS does not read these valid variants. Normalize only an in-memory copy;
// personal document metadata is not needed to map feedback.
export async function loadFeedbackWorkbook(filename) {
  const fileInfo = await stat(filename);
  if (!fileInfo.isFile() || fileInfo.size > FEEDBACK_UPLOAD_LIMITS.compressedBytes) throw invalidWorkbook("必须是10 MiB以内的 XLSX 文件");
  const data = await readFile(filename);
  const metadata = inspectZipDirectory(data);
  const zip = await JSZip.loadAsync(data);
  let expanded = 0;
  // Native zlib caps actual output allocation even if a crafted directory
  // understates a member's expanded size. JSZip receives only checked bytes.
  for (const [name, entry] of Object.entries(zip.files)) {
    const advertised = metadata.get(name);
    if (!advertised) throw invalidWorkbook("ZIP 成员路径解析不一致");
    if (entry.dir) continue;
    const compressed = data.subarray(advertised.contentOffset, advertised.contentOffset + advertised.compressedSize);
    let buffer;
    try {
      buffer = advertised.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(advertised.expandedSize + 1, FEEDBACK_UPLOAD_LIMITS.entryBytes, FEEDBACK_UPLOAD_LIMITS.expandedBytes - expanded)) });
    } catch { throw invalidWorkbook("ZIP 成员解压失败或实际解压大小超过安全上限"); }
    expanded += buffer.length;
    if (buffer.length !== advertised.expandedSize || expanded > FEEDBACK_UPLOAD_LIMITS.expandedBytes) throw invalidWorkbook("ZIP 成员解压大小不一致或超过安全上限");
    zip.file(name, /\.(?:xml|rels)$/i.test(name) ? xmlText(buffer) : buffer);
  }
  zip.remove("docProps/core.xml");
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.startsWith("xl/") || !name.endsWith(".xml")) continue;
    let xml = await entry.async("string");
    const namespace = /xmlns:([A-Za-z_][\w.-]*)=["']http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main["']/g;
    const prefixes = [...xml.matchAll(namespace)].map((match) => match[1]);
    for (const prefix of prefixes) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      xml = xml.replace(new RegExp(`(<\\/?)${escaped}:`, "g"), "$1");
    }
    if (prefixes.length) {
      xml = xml.replace(namespace, 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
      zip.file(name, xml);
    }
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await zip.generateAsync({ type: "nodebuffer" }), {
    ignoreNodes: ["tableParts", "drawing"],
  });
  return { workbook, sha256: hash(data) };
}

const feedbackTypes = ["表扬", "建议", "投诉", "询问"];
const hasValue = (value) => clean(value) && !["ID", "/", "#N/A", "#REF!"].includes(clean(value));
const exactText = (value) => clean(value).replace(/\r\n?/g, "\n");
const identical = (left, right) => exactText(left) === exactText(right);

function cellValue(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (value.error) return value.error;
    if (value.richText) return value.richText.map((part) => part.text).join("");
    if ("result" in value) return value.result ?? "";
    return value.text ?? "";
  }
  return value;
}

function valueAt(row, index) {
  return index ? cellValue(row.getCell(index)) : "";
}

function headersFor(sheet) {
  const entries = [];
  sheet.getRow(1).eachCell((cell, index) => entries.push([clean(cellValue(cell)), index]));
  return new Map(entries);
}

function columnStarting(headers, prefix) {
  return [...headers].find(([name]) => name.startsWith(prefix))?.[1];
}

// Date strings retain the precision that the operator/source actually provided.
export function feedbackDate(value, month = "") {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "" : value.toISOString().slice(0, 10);
  const text = clean(value);
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const result = new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000);
    return Number.isNaN(result.valueOf()) ? "" : result.toISOString().slice(0, 10);
  }
  const day = text.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const validDay = (year, m, d) => {
    const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : "";
  };
  if (day) return validDay(day[1], day[2], day[3]);
  const english = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (english) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    return validDay(english[3], months.indexOf(english[1].toLowerCase()) + 1, english[2]);
  }
  const monthly = text.match(/^(\d{4})[-.](\d{1,2})$/);
  if (monthly && Number(monthly[2]) >= 1 && Number(monthly[2]) <= 12)
    return `${monthly[1]}-${monthly[2].padStart(2, "0")}`;
  return month;
}

function sourceReference(filename, sheet, row, sha256) {
  return { file: basename(filename), path: resolve(filename), sheet, row, sha256 };
}

async function loadTemplate(templatePath) {
  if (templatePath) {
    try {
      const template = await loadFeedbackWorkbook(templatePath);
      return { ...template, reference: { kind: "file", file: basename(templatePath), path: resolve(templatePath), sha256: template.sha256 } };
    } catch (error) {
      // A supplied but malformed workbook must not silently become a blank
      // template; only an absent optional file uses the built-in format.
      if (error.code !== "ENOENT") throw error;
    }
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("反馈记录");
  sheet.columns = TARGET_HEADERS.map((header) => ({
    header, key: header, width: ({ 反馈内容: 70, 反馈跟进: 50, 回复记录: 45, 备注: 36 }[header] || 18),
  }));
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF225E55" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  return { workbook, reference: { kind: "builtin", name: BUILTIN_TEMPLATE_NAME, version: 1 } };
}

function extractHistorical(workbook, filename, sha256) {
  const records = [];
  let recognized = 0;
  for (const sheet of workbook.worksheets) {
    const headers = headersFor(sheet);
    if (!TARGET_HEADERS.every((header) => headers.has(header))) continue;
    recognized++;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const targetRow = Object.fromEntries(TARGET_HEADERS.map((header) => [header, clean(valueAt(row, headers.get(header)))]));
      if (!hasValue(targetRow.反馈内容)) return;
      if (!feedbackTypes.includes(targetRow.反馈类别) && feedbackTypes.includes(targetRow.问题分类))
        [targetRow.反馈类别, targetRow.问题分类] = [targetRow.问题分类, targetRow.反馈类别];
      targetRow.问题分类 = hasValue(targetRow.问题分类) ? targetRow.问题分类 : "待分类";
      targetRow.反馈跟进 = hasValue(targetRow.反馈跟进) ? targetRow.反馈跟进 : "";
      targetRow.回复记录 = hasValue(targetRow.回复记录) ? targetRow.回复记录 : "";
      targetRow.日期 = feedbackDate(valueAt(row, headers.get("日期")));
      records.push({ targetRow, source: sourceReference(filename, sheet.name, rowNumber, sha256) });
    });
  }
  if (!recognized) throw new Error(`目标工作簿缺少必需的十列表头：${TARGET_HEADERS.join("、")}`);
  return records;
}

function csvCell(value) {
  let text = String(value ?? "");
  // CSV opened by Excel must not execute user-submitted feedback as a formula.
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function targetWorkbookBuffer(rows, templateWorkbook) {
  const output = new ExcelJS.Workbook();
  output.creator = "Dining Workbench";
  const templateSheet = templateWorkbook.worksheets.find((sheet) => TARGET_HEADERS.every((header) => headersFor(sheet).has(header)));
  const headers = headersFor(templateSheet);
  const months = [...new Set(rows.map((row) => row.date.slice(0, 7)))].sort().reverse();
  for (const month of months.length ? months : [""]) {
    const sheet = output.addWorksheet(month ? `${month.slice(0, 4)}.${Number(month.slice(5))}反馈` : "反馈记录", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = TARGET_HEADERS.map((header) => ({
      header, key: header, width: templateSheet.getColumn(headers.get(header)).width || ({ 反馈内容: 70, 反馈跟进: 50, 回复记录: 45, 备注: 36 }[header] || 18),
    }));
    sheet.getRow(1).height = templateSheet.getRow(1).height || 30;
    TARGET_HEADERS.forEach((header, index) => {
      const original = templateSheet.getCell(1, headers.get(header));
      const cell = sheet.getCell(1, index + 1);
      cell.style = JSON.parse(JSON.stringify(original.style || {}));
      cell.alignment = { ...cell.alignment, vertical: "middle", wrapText: true };
    });
    for (const item of rows.filter((row) => row.date.startsWith(month))) {
      const row = sheet.addRow({ ...item.targetRow, 日期: new Date(`${item.date}T00:00:00Z`) });
      row.getCell(4).numFmt = "yyyy-mm-dd";
      row.alignment = { vertical: "top", wrapText: true };
      row.font = { name: "Microsoft YaHei", size: 10 };
      const lines = Math.max(...TARGET_HEADERS.map((header, index) => {
        const width = sheet.getColumn(index + 1).width;
        return String(item.targetRow[header] || "").split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length * 2 / width)), 0);
      }));
      row.height = Math.max(32, Math.min(409, lines * 15 + 8));
    }
    sheet.autoFilter = { from: "A1", to: { row: sheet.rowCount, column: TARGET_HEADERS.length } };
  }
  return output.xlsx.writeBuffer();
}

/**
 * Convert the Forms questionnaire into the supplied ten-column feedback format.
 * No AI guesses: missing category/restaurant stays pending confirmation. Original
 * content is preserved; any known historical operator classification is reused.
 */
export async function convertFeedback({ sourcePath, templatePath, outputDirectory } = {}) {
  if (!sourcePath) throw new Error("必须提供源问卷路径");
  const [source, template] = await Promise.all([loadFeedbackWorkbook(sourcePath), loadTemplate(templatePath)]);
  const historical = template.reference.kind === "file" ? extractHistorical(template.workbook, templatePath, template.sha256) : [];
  const rows = [];
  const report = {
    version: 1, sourceFile: basename(sourcePath), sourcePath: resolve(sourcePath),
    templateFile: template.reference.file || template.reference.name, templateKind: template.reference.kind,
    sourceSha256: source.sha256,
    ...(template.reference.kind === "file" ? { templatePath: template.reference.path, templateSha256: template.sha256 } : {}),
    sourceRows: 0, convertedRows: 0, matchedHistoricalRows: 0,
    quarantinedRows: 0, skippedRows: 0, duplicateRows: 0,
    historicalRows: historical.length, issues: [], mapping: {},
  };
  let recognized = 0;
  const seen = new Set();
  for (const sheet of source.workbook.worksheets) {
    const headers = headersFor(sheet);
    if (!headers.has("ID") || !headers.has("我要")) continue;
    const branches = {
      表扬: { restaurant: columnStarting(headers, "您要表扬的餐厅"), content: columnStarting(headers, "该餐厅哪一点") },
      建议: { restaurant: columnStarting(headers, "您要提建议的餐厅"), content: columnStarting(headers, "请留下您宝贵的意见") },
      投诉: { restaurant: columnStarting(headers, "您要投诉的餐厅"), content: columnStarting(headers, "请留下您要投诉的问题") },
      询问: { restaurant: null, content: columnStarting(headers, "请留下您想了解的问题") },
    };
    if (!headers.has("Completion time") || Object.values(branches).some((branch) => !branch.content))
      throw new Error(`源工作表 ${sheet.name} 缺少完成时间或反馈分支正文列`);
    recognized++;
    report.mapping = {
      反馈来源: "二维码（Forms问卷）", 序号: "ID", 日期: "Completion time",
      反馈类别: "我要（表扬/建议/投诉/询问）",
      餐厅: "对应类型的餐厅列；询问无餐厅字段，保留待确认",
      反馈内容: Object.fromEntries(Object.entries(branches).map(([type, branch]) => [type, [...headers].find(([, index]) => index === branch.content)?.[0]])),
      反馈跟进: "模板中同一来源ID且正文一致的已有跟进，或空白",
      问题分类: "模板中同一来源ID且正文一致的已有分类，或待分类",
      回复记录: "模板中同一来源ID且正文一致的已有回复，或空白",
      备注: "原反馈时间/餐次（若有）；不自动推断处理结果",
    };
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const originalId = clean(valueAt(row, headers.get("ID")));
      const rawType = clean(valueAt(row, headers.get("我要")));
      if (!originalId && !rawType) return;
      report.sourceRows++;
      const type = feedbackTypes.find((item) => rawType.startsWith(item));
      const date = feedbackDate(valueAt(row, headers.get("Completion time")));
      const issue = (reason, quarantine = false) => {
        report[quarantine ? "quarantinedRows" : "skippedRows"]++;
        report.issues.push({ sheet: sheet.name, row: rowNumber, originalId, reason });
      };
      if (!type) return issue("无法识别反馈类型");
      // Recognized Forms structure + date + ID identify the existing May pilot
      // batch even after upload renaming; row position/filename alone do not.
      if (/^2026-05-/.test(date) && /^(?:[1-9]|10)$/.test(originalId)) {
        issue("既有已核验试填批次：2026年5月问卷ID 1–10，待运营确认后再导入", true);
        return;
      }
      const branch = branches[type];
      const rawContent = String(valueAt(row, branch.content));
      const content = clean(rawContent);
      if (!originalId) return issue("缺少来源ID");
      if (!hasValue(content) || content.length < 2 || content.length > 10000) return issue("正文为空、占位值或超出允许长度");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return issue("完成日期缺失或无效");
      const matched = historical.filter(({ targetRow }) => targetRow.反馈来源 === "二维码" && targetRow.序号 === originalId && identical(targetRow.反馈内容, content));
      const prior = matched[0]?.targetRow;
      if (prior) report.matchedHistoricalRows++;
      const sourceRestaurant = clean(valueAt(row, branch.restaurant));
      const restaurant = (hasValue(sourceRestaurant) ? sourceRestaurant : "") || prior?.餐厅 || "待确认";
      if (restaurant.length > 100) return issue("餐厅名称超出100字符，需要人工确认");
      const experienceDate = clean(valueAt(row, headers.get("本次体验发生的日期是？")));
      const experiencePeriod = clean(valueAt(row, headers.get("本次体验发生的时间段是？")));
      const notes = [prior?.备注, experienceDate && hasValue(experienceDate) ? `原反馈体验日期：${experienceDate}` : "", experiencePeriod && hasValue(experiencePeriod) ? `原反馈时间段：${experiencePeriod}` : ""].filter(Boolean).join("；");
      const targetRow = {
        反馈来源: "二维码", 序号: originalId, 餐厅: restaurant, 日期: date, 反馈内容: content,
        反馈跟进: prior?.反馈跟进 || "", 反馈类别: type, 问题分类: prior?.问题分类 || "待分类",
        回复记录: prior?.回复记录 || "", 备注: notes,
      };
      const conversionKey = hash(`forms-feedback-v1|${originalId}|${exactText(content)}`);
      if (seen.has(conversionKey)) { report.duplicateRows++; return; }
      seen.add(conversionKey);
      const reference = sourceReference(sourcePath, sheet.name, rowNumber, source.sha256);
      rows.push({
        id: `F-converted-${conversionKey.slice(0, 20)}`, conversionKey, originalId,
        channel: "二维码", restaurant, date, type, category: targetRow.问题分类, content,
        status: targetRow.反馈跟进 || targetRow.回复记录 ? "跟进中" : "未处理",
        owner: "", threadId: "", summaryRecord: false, duplicatePossible: false,
        reply: targetRow.回复记录, notes, targetRow,
        sources: [reference, ...matched.map((match) => match.source)],
        provenance: { version: 1, source: reference, template: template.reference, rawType, rawContent, experienceDate, experiencePeriod, contentColumn: sheet.getColumn(branch.content).letter },
        events: [
          ...(targetRow.反馈跟进 ? [{ at: "", text: targetRow.反馈跟进, kind: "历史跟进" }] : []),
          ...(targetRow.回复记录 ? [{ at: "", text: targetRow.回复记录, kind: "历史回复" }] : []),
        ],
      });
    });
  }
  if (!recognized) throw new Error("源工作簿没有可识别的 Forms 问卷表头（ID、我要）");
  report.convertedRows = rows.length;
  const csv = `\uFEFF${[TARGET_HEADERS, ...rows.map((item) => TARGET_HEADERS.map((header) => item.targetRow[header]))].map((values) => values.map(csvCell).join(",")).join("\r\n")}\r\n`;
  const conversion = { rows, report, csv };
  if (outputDirectory) {
    const directory = resolve(outputDirectory);
    await mkdir(directory, { recursive: true });
    const prefix = `feedback-converted-${source.sha256.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    conversion.outputPath = join(directory, `${prefix}.json`);
    conversion.csvPath = join(directory, `${prefix}.csv`);
    conversion.xlsxPath = join(directory, `${prefix}.xlsx`);
    await writeFile(conversion.outputPath, JSON.stringify({ rows, report }, null, 2), { encoding: "utf8", flag: "wx" });
    await writeFile(conversion.csvPath, csv, { encoding: "utf8", flag: "wx" });
    await writeFile(conversion.xlsxPath, await targetWorkbookBuffer(rows, template.workbook), { flag: "wx" });
  }
  return conversion;
}

/** Preserve human-owned workflow fields when the same source is imported again. */
export function importConvertedFeedback(store, conversion) {
  if (!Array.isArray(conversion?.rows)) throw new Error("转换结果缺少 rows");
  const apply = () => {
    const existing = store.all("feedback");
    const result = { inserted: 0, skipped: 0, merged: 0, conflicts: 0, total: existing.length };
    for (const item of conversion.rows) {
      const prior = existing.find((candidate) => candidate.conversionKey === item.conversionKey || (candidate.channel === "二维码" && clean(candidate.originalId) === item.originalId && identical(candidate.content, item.content)));
      if (prior) {
        const sourceKey = (source) => `${source.path || source.file}|${source.sheet}|${source.row}|${source.sha256 || ""}`;
        const sources = [...new Map([...(prior.sources || []), ...item.sources].map((source) => [sourceKey(source), source])).values()];
        const updated = { ...prior, sources, conversionKey: item.conversionKey, targetRow: prior.targetRow || item.targetRow, provenance: prior.provenance || item.provenance };
        if (JSON.stringify(updated) !== JSON.stringify(prior)) {
          store.put("feedback", prior.id, updated);
          existing[existing.indexOf(prior)] = updated;
          result.merged++;
        } else result.skipped++;
        continue;
      }
      const idCollision = store.get("feedback", item.id);
      if (idCollision) { result.conflicts++; continue; }
      const sameSource = existing.some((candidate) => candidate.channel === "二维码" && clean(candidate.originalId) === item.originalId);
      const record = { ...item, duplicatePossible: sameSource };
      store.put("feedback", record.id, record);
      existing.push(record);
      result.inserted++;
      if (sameSource) result.conflicts++;
    }
    result.total = existing.length;
    return result;
  };
  return store.atomic ? store.atomic(apply) : apply();
}
