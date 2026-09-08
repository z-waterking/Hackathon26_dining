import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, basename, relative, isAbsolute } from "node:path";
import { createStore } from "./store.mjs";
import { readMaterials } from "./importer.mjs";
import { convertFeedback, importConvertedFeedback, TARGET_HEADERS } from "./feedback-converter.mjs";
import { getSettings, audit } from "./settings.mjs";

export const projectRoot = resolve(import.meta.dirname, "../..");
export const conversionPaths = (root = projectRoot) => ({
  sourcePath: resolve(root, "微软BJW园区餐饮反馈(1-149).xlsx"),
  templatePath: resolve(root, "新餐厅反馈记录表-from 202607 2.xlsx"),
  outputDirectory: resolve(root, "app/data/conversions"),
});
const signature = (paths) => createHash("sha256").update(readFileSync(paths.sourcePath))
  .update(existsSync(paths.templatePath) ? readFileSync(paths.templatePath) : "builtin-feedback-format-v1").digest("hex");

export async function convertAndImport(store, { root = projectRoot, importRows = true, conversionImpl = convertFeedback, sourcePath, uploaded = false } = {}) {
  const paths = { ...conversionPaths(root), ...(sourcePath ? { sourcePath } : {}) };
  if (!existsSync(paths.sourcePath))
    throw new Error("找不到旧格式反馈表，请在反馈中心上传 Excel");
  const conversion = await conversionImpl(paths);
  const sourceSignature = signature(paths);
  const batch = { id: `I-${randomUUID()}`, at: new Date().toISOString(), sourceSignature, imported: importRows,
    source: basename(paths.sourcePath), sourceArchivePath: paths.sourcePath, uploaded,
    template: conversion.report.templateFile || (existsSync(paths.templatePath) ? basename(paths.templatePath) : "内置十列反馈格式 v1"),
    report: conversion.report, outputPath: conversion.outputPath || null, csvPath: conversion.csvPath || null, xlsxPath: conversion.xlsxPath || null };
  store.atomic(() => {
    // Import rows, their batch linkage and the audit record commit together.
    const result = importRows ? importConvertedFeedback({ ...store, atomic: (action) => action() }, conversion) : { inserted: 0, skipped: 0 };
    Object.assign(batch, result);
    const byKey = new Map(store.all("feedback").map((item) => [item.conversionKey, item.id]));
    batch.rowRefs = conversion.rows.map((item) => ({ conversionKey: item.conversionKey, feedbackId: byKey.get(item.conversionKey) || null }));
    store.put("imports", batch.id, batch);
    if (importRows && !uploaded) store.put("meta", "converted-feedback-source", { signature: sourceSignature, batchId: batch.id, at: batch.at });
    audit(store, uploaded ? "feedback.uploaded_converted" : importRows ? "feedback.converted_imported" : "feedback.converted", batch.id, { ...result, source: batch.source });
  });
  return batch;
}

export const MAX_FEEDBACK_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function uploadAndImport(store, { bytes, filename, root = projectRoot, conversionImpl } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("请选择非空的旧格式 Excel 文件");
  if (bytes.length > MAX_FEEDBACK_UPLOAD_BYTES) throw Object.assign(new Error("Excel 文件不能超过10MB"), { statusCode: 413 });
  if (typeof filename !== "string" || filename.length > 160 || !/\.xlsx$/i.test(filename) ||
    /[<>:"/\\|?*]/.test(filename) || [...filename].some((character) => character.charCodeAt(0) < 32) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename))
    throw new Error("请选择有效的 .xlsx 文件，文件名不能包含路径或特殊控制字符");
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new Error("文件不是有效的 Excel .xlsx 工作簿");
  const archiveDirectory = resolve(root, "app/data/uploads", randomUUID());
  const sourcePath = resolve(archiveDirectory, filename);
  await mkdir(archiveDirectory, { recursive: true });
  await writeFile(sourcePath, bytes, { flag: "wx" });
  try {
    return await convertAndImport(store, { root, sourcePath, uploaded: true, conversionImpl });
  } catch (error) {
    // These paths are created exclusively by this request; no source on the
    // user's machine is deleted. Invalid upload bytes are not retained.
    await unlink(sourcePath);
    await rmdir(archiveDirectory);
    throw error;
  }
}

export function convertedBatchRows(store, id, root = projectRoot) {
  const batch = store.get("imports", id);
  if (!batch) throw new Error("转换批次不存在");
  const outputRoot = resolve(root, "app/data/conversions");
  const filePath = batch.outputPath;
  const within = filePath ? relative(outputRoot, resolve(filePath)) : "..";
  if (!filePath || within.startsWith("..") || isAbsolute(within) || !existsSync(filePath))
    throw new Error("此批次没有可查看的转换结果，请重新上传旧表");
  const conversion = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(conversion.rows)) throw new Error("转换结果格式无效");
  const current = store.all("feedback");
  const byKey = new Map(current.map((item) => [item.conversionKey, item]));
  const refs = new Map((batch.rowRefs || []).map((item) => [item.conversionKey, item.feedbackId]));
  const byId = new Map(current.map((item) => [item.id, item]));
  const rows = conversion.rows.map((row) => {
    const item = byId.get(refs.get(row.conversionKey)) || byKey.get(row.conversionKey);
    // Keep the original conversion snapshot on disk, but show the current
    // saved reply and handling notes in the operating table.
    const targetRow = { ...row.targetRow };
    if (item) {
      targetRow.反馈跟进 = (item.events || []).filter((event) => !["创建", "保存回复", "历史回复"].includes(event.kind))
        .map((event) => event.text).filter(Boolean).join("\n") || targetRow.反馈跟进;
      targetRow.回复记录 = item.reply || targetRow.回复记录;
    }
    return { feedbackId: item?.id || null, targetRow: Object.fromEntries(TARGET_HEADERS.map((header) => [header, targetRow[header] || ""])) };
  });
  return { id: batch.id, source: batch.source, headers: TARGET_HEADERS, rows, total: rows.length };
}

export async function initializeLocalStore({ filename = process.env.DINING_DB || resolve(projectRoot, "app/data/dining.sqlite"), root = projectRoot } = {}) {
  const store = createStore(filename, () => {
    if (!existsSync(resolve(root, "materials/inspection/inventory.json")))
      throw new Error("首次运行请执行根目录 .\\tools\\Start-Dining.ps1，以解析资料并初始化数据库");
    return readMaterials(resolve(root, "materials/inspection"));
  });
  try {
    getSettings(store);
    // Questionnaire imports are initiated by uploading the old workbook in
    // the UI. Restarting the app does not silently re-import a fixed file.
    return store;
  } catch (error) { store.close(); throw error; }
}
