import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, sep } from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { TARGET_HEADERS } from "../server/feedback-converter.mjs";

async function sourceWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("旧问卷");
  sheet.addRow(["ID", "Completion time", "我要", "您要表扬的餐厅", "该餐厅哪一点值得表扬",
    "您要提建议的餐厅", "请留下您宝贵的意见", "您要投诉的餐厅", "请留下您要投诉的问题", "请留下您想了解的问题"]);
  sheet.addRow([151, "2026-09-08", "建议", "", "", "测试餐厅", "希望早餐增加无糖豆浆"]);
  sheet.addRow([152, "2026-09-09", "表扬", "测试餐厅", "服务态度很好"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "dining-upload-"));
  const filename = resolve(root, "test.sqlite");
  const store = createStore(filename, () => ({ feedback: [], dishes: [], rules: [], recipes: [], inventory: [], report: {} }));
  const app = createApp(store, resolve(root, "no-dist"), { root });
  t.after(async () => {
    await app.close(); store.close();
    const within = relative(resolve(tmpdir()), root);
    assert.ok(within.startsWith("dining-upload-") && !within.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const upload = (bytes, filename = "本月原始问卷.xlsx", extraHeaders = {}) => app.inject({
    method: "POST", url: "/api/feedback/upload",
    headers: { host: "127.0.0.1", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(filename), ...extraHeaders }, payload: bytes,
  });
  const get = (url) => app.inject({ method: "GET", url, headers: { host: "127.0.0.1" } });
  return { root, filename, store, app, upload, get };
}

test("upload arbitrary old workbook, show ten-column converted rows, save and reimport without losing replies", async (t) => {
  const { root, store, app, upload, get } = await fixture(t);
  const bytes = await sourceWorkbook();
  const response = await upload(bytes);
  assert.equal(response.statusCode, 201, response.body);
  const batch = response.json();
  assert.equal(batch.source, "本月原始问卷.xlsx");
  assert.equal(batch.uploaded, true);
  assert.equal(batch.inserted, 2);
  assert.equal(batch.report.convertedRows, 2);
  assert.equal(batch.report.templateFile, "内置十列反馈格式 v1");
  assert.deepEqual(await readFile(batch.sourceArchivePath), bytes);
  assert.ok(relative(resolve(root, "app/data/uploads"), batch.sourceArchivePath).endsWith("本月原始问卷.xlsx"));
  const converted = (await get(`/api/imports/${batch.id}/rows`)).json();
  assert.deepEqual(converted.headers, TARGET_HEADERS);
  assert.equal(converted.total, 2);
  assert.deepEqual(Object.keys(converted.rows[0].targetRow), TARGET_HEADERS);
  assert.equal(converted.rows[0].targetRow.餐厅, "测试餐厅");
  assert.equal(converted.rows[0].targetRow.反馈内容, "希望早餐增加无糖豆浆");
  const feedbackId = converted.rows[0].feedbackId;
  assert.ok(store.get("feedback", feedbackId));
  const reply = await app.inject({ method: "POST", url: `/api/feedback/${feedbackId}/reply`,
    headers: { host: "127.0.0.1", "content-type": "application/json" }, payload: { text: "已记录，交厨师长评估" } });
  assert.equal(reply.statusCode, 200);
  const repeated = await upload(bytes, "重新导出的问卷.xlsx");
  assert.equal(repeated.statusCode, 201);
  assert.equal(repeated.json().inserted, 0);
  assert.equal(store.all("feedback").length, 2);
  const latestRows = (await get(`/api/imports/${repeated.json().id}/rows`)).json();
  assert.equal(latestRows.rows[0].feedbackId, feedbackId);
  assert.equal(latestRows.rows[0].targetRow.回复记录, "已记录，交厨师长评估");
  const download = await get(`/api/imports/${batch.id}/download?format=xlsx`);
  assert.equal(download.statusCode, 200);
  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(download.rawPayload);
  assert.deepEqual(saved.worksheets[0].getRow(1).values.slice(1), TARGET_HEADERS);
  assert.equal(store.all("audit").filter((row) => row.kind === "feedback.uploaded_converted").length, 2);
  assert.equal(store.get("meta", "converted-feedback-source"), null, "uploads do not trigger a fixed-root import on restart");
});

test("upload rejects invalid names, unrelated formats, oversized data and foreign origins without importing", async (t) => {
  const { root, store, upload, get } = await fixture(t);
  const valid = await sourceWorkbook();
  assert.equal((await upload(valid, "../outside.xlsx")).statusCode, 400);
  assert.equal((await upload(valid, "old.xls")).statusCode, 400);
  assert.equal((await upload(Buffer.from("not an xlsx"))).statusCode, 400);
  assert.equal((await upload(Buffer.alloc(0))).statusCode, 400);
  assert.equal((await upload(valid, "ok.xlsx", { origin: "https://foreign.example" })).statusCode, 403);
  assert.equal((await upload(valid, "ok.xlsx", { "content-type": "text/plain" })).statusCode, 415);
  assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode, 413);
  const malformed = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);
  assert.equal((await upload(malformed)).statusCode, 400);
  assert.equal(store.all("feedback").length, 0);
  assert.equal(store.all("imports").length, 0);
  assert.equal((await readdir(resolve(root, "app/data/uploads"))).length, 0);
  assert.equal((await get("/api/imports/no-such-batch/rows")).statusCode, 400);
});
