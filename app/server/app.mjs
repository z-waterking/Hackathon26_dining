import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import {
  feedbackSchema,
  feedbackUpdateSchema,
  dishUpdateSchema,
  parseCsv,
  transactionSchema,
  dateSchema,
} from "./domain.mjs";
import { generateMenu, validateMenu, checkMenu } from "./menus.mjs";
import { createAiClient } from "./ai.mjs";
import { getSettings } from "./settings.mjs";
import { analyzeFeedback, saveReply, updateAction, summarizeMonth } from "./feedback-ai.mjs";
import { convertAndImport, uploadAndImport, MAX_FEEDBACK_UPLOAD_BYTES } from "./bootstrap.mjs";
import { runMenuWorkflow, attachMenuWorkflow, reinspectMenuWorkflow, runDemoMenuWorkflow } from "./menu-workflow.mjs";
import { ensureDemoActions } from "./demo-actions.mjs";
import { summarizeActions } from "./action-summary.mjs";
import { publicData } from "./public-data.mjs";
import { createQueryService } from "./data/query-service.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function createApp(
  store,
  dist = resolve(import.meta.dirname, "../dist"),
  options = {},
) {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: false });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FEEDBACK_UPLOAD_BYTES }, (_request, body, done) => done(null, body));
  const ai = options.ai || createAiClient(store);
  getSettings(store);
  const queries = createQueryService(store, { ai, root: options.root });
  app.addHook("preSerialization", async (_request, _reply, payload) => publicData(payload));
  const activeTasks = new Set();
  async function exclusive(key, action) {
    if (activeTasks.has(key)) throw new Error("此任务正在进行，请等待当前请求完成");
    activeTasks.add(key);
    try { return await action(); } finally { activeTasks.delete(key); }
  }
  app.addHook("onRequest", async (request, response) => {
    response.header("X-Content-Type-Options", "nosniff");
    response.header("X-Frame-Options", "DENY");
    response.header("Referrer-Policy", "no-referrer");
    const host = request.hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(host))
      return response.status(403).send({ error: "仅允许本机访问" });
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
        return response.status(403).send({ error: "来源不允许" });
      const uploading = request.method === "POST" && request.url.split("?")[0] === "/api/feedback/upload";
      if (uploading && !request.headers["content-type"]?.startsWith("application/octet-stream"))
        return response.status(415).send({ error: "上传Excel需使用application/octet-stream" });
      if (!uploading && !request.headers["content-type"]?.startsWith("application/json"))
        return response.status(415).send({ error: "需要JSON请求" });
    }
    if (request.url.startsWith("/api"))
      response.header("Cache-Control", "no-store");
  });
  const required = (table, id) => {
    const item = store.get(table, id);
    if (!item) throw new Error("记录不存在");
    return item;
  };
  app.get("/api/health", (_request, response) => response.send({ ok: true }));
  app.get("/api/data", (_request, response) => response.send(queries.workspace()));
  for (const resource of ["feedback", "dishes", "actions", "plans", "imports"])
    app.get(`/api/${resource}`, (_request, response) => response.send(queries[resource]()));
  app.get("/api/materials", (_request, response) => response.send(queries.materials()));
  // Internal model instructions are maintained by the application, not the
  // operational UI. Retire the old prompt editor endpoints entirely.
  app.get("/api/settings", (_request, response) => response.status(404).send({ error: "此入口已停用，请在Action模块管理改善事项" }));
  app.put("/api/settings", (_request, response) => response.status(404).send({ error: "此入口已停用，请在Action模块管理改善事项" }));
  app.get("/api/ai/status", (_request, response) => response.send(queries.aiStatus()));
  app.get("/api/audit", (_request, response) => response.send(queries.audit()));
  app.get("/api/menu-runs/:id", (request, response) => response.send(queries.menuRun(request.params.id)));
  app.get("/api/actions/summary", (request, response) => {
    const scope = z.object({ month: z.string().default(""), demo: z.enum(["true", "false"]).default("false") }).parse(request.query);
    return response.send(queries.actionSummary({ month: scope.month, demo: scope.demo === "true" }));
  });
  app.post("/api/actions/summarize", async (request, response) => {
    const scope = z.object({ month: z.string().default(""), demo: z.boolean().default(false), force: z.boolean().default(false) }).strict().parse(request.body || {});
    return response.send(await exclusive("action-summary", () => summarizeActions(store, ai, scope)));
  });
  app.post("/api/demo/actions", (_request, response) => response.send(ensureDemoActions(store)));
  app.get("/api/imports/:id/rows", (request, response) => response.send(queries.convertedRows(request.params.id)));
  app.get("/api/imports/:id/download", (request, response) => {
    const format = z.enum(["xlsx", "csv"]).default("xlsx").parse(request.query.format);
    const artifact = queries.importDownload(request.params.id, format);
    response.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    response.type(artifact.contentType);
    return response.send(createReadStream(artifact.path));
  });
  app.post("/api/feedback/convert", async (request, response) => {
    const input = z.object({ import: z.boolean().default(true) }).strict().parse(request.body || {});
    const result = await exclusive("conversion", () => convertAndImport(store, { root: options.root, importRows: input.import, conversionImpl: options.conversionImpl }));
    return response.send(result);
  });
  app.post("/api/feedback/upload", { bodyLimit: MAX_FEEDBACK_UPLOAD_BYTES }, async (request, response) => {
    let filename;
    try { filename = decodeURIComponent(request.headers["x-file-name"] || ""); }
    catch { throw new Error("上传文件名编码无效，请重新选择文件"); }
    const result = await exclusive("conversion", () => uploadAndImport(store, { bytes: request.body, filename, root: options.root, conversionImpl: options.conversionImpl }));
    return response.status(201).send(result);
  });
  app.get("/api/feedback/insights", (request, response) => response.send(queries.insights(request.query)));
  app.get("/api/feedback/summary", (request, response) => response.send(queries.monthlySummary(request.query.month)));
  app.post("/api/feedback/summary", async (request, response) => {
    const { month } = z.object({ month: z.string() }).strict().parse(request.body);
    return response.send(await exclusive(`summary-${month}`, () => summarizeMonth(store, ai, month)));
  });
  app.post("/api/feedback/:id/analyze", async (request, response) => {
    const input = z.object({ force: z.boolean().default(false) }).strict().parse(request.body || {});
    return response.send(await exclusive(`feedback-${request.params.id}`, () => analyzeFeedback(store, ai, request.params.id, input)));
  });
  app.post("/api/feedback/:id/reply", (request, response) => response.send(saveReply(store, request.params.id, request.body)));
  app.patch("/api/actions/:id", (request, response) => response.send(updateAction(store, request.params.id, request.body)));
  app.get("/api/recipes/:id", (request, response) => response.send(queries.recipes(request.params.id)));
  app.post("/api/feedback", (request, response) => {
    const input = feedbackSchema.parse(request.body);
    const prior = input.threadId
      ? store
          .all("feedback")
          .find(
            (item) =>
              item.threadId === input.threadId &&
              item.channel === input.channel,
          )
      : null;
    const at = new Date().toISOString();
    if (prior) {
      prior.events.push({ at, text: input.content, kind: "线程补充" });
      if (prior.status === "已完成") {
        prior.status = "跟进中";
        prior.completedAt = null;
      }
      store.put("feedback", prior.id, prior);
      return response.send({ item: prior, merged: true });
    }
    const item = {
      ...input,
      id: `F-${randomUUID()}`,
      status: "未处理",
      events: [{ at, text: "手工录入", kind: "创建" }],
      sources: [],
      originalId: "",
      summaryRecord: false,
      duplicatePossible: false,
      createdAt: at,
    };
    store.put("feedback", item.id, item);
    response.status(201).send({ item, merged: false });
  });
  app.patch("/api/feedback/:id", (request, response) => {
    const input = feedbackUpdateSchema.parse(request.body);
    const item = required("feedback", request.params.id);
    const at = new Date().toISOString();
    item.events.push({
      at,
      kind: `${item.status} → ${input.status}`,
      text: input.note,
      owner: input.owner,
    });
    item.status = input.status;
    item.owner = input.owner;
    item.completedAt =
      input.status === "已完成" ? item.completedAt || at : null;
    store.put("feedback", item.id, item);
    response.send(item);
  });
  app.post("/api/feedback/import", (request, response) => {
    const { csv } = z.object({ csv: z.string().min(1) }).parse(request.body);
    const inputs = parseCsv(csv).map((row, index) => {
      try {
        return feedbackSchema.parse(row);
      } catch {
        throw new Error(`第${index + 2}行反馈字段不完整或日期无效`);
      }
    });
    let inserted = 0;
    store.atomic(() => {
      for (const input of inputs) {
        const id = `F-csv-${hash(JSON.stringify(input))}`;
        if (store.get("feedback", id)) continue;
        store.put("feedback", id, {
          ...input,
          id,
          status: "未处理",
          events: [],
          sources: [{ file: "CSV导入", sheet: "", row: 0 }],
          summaryRecord: false,
          duplicatePossible: true,
        });
        inserted++;
      }
    });
    response.send({ inserted, skipped: inputs.length - inserted });
  });
  app.patch("/api/dishes/:id", (request, response) => {
    const input = dishUpdateSchema.parse(request.body);
    const item = {
      ...required("dishes", request.params.id),
      ...input,
      verifiedAt: new Date().toISOString(),
    };
    store.put("dishes", item.id, item);
    response.send(item);
  });
  app.post("/api/plans/generate", async (request, response) => {
    if (request.body.demo === true)
      return response.send(await exclusive("menu-workflow", () => runDemoMenuWorkflow({ store, input: request.body, settings: getSettings(store) })));
    if (request.body.useAi === true) {
      const result = await exclusive("menu-workflow", () => runMenuWorkflow({ store, ai, input: request.body, settings: getSettings(store) }));
      return response.send(result);
    }
    const dishes = store.all("dishes");
    const plan = generateMenu(dishes, request.body);
    const previous = store
      .all("plans")
      .filter((item) => item.stall === plan.stall)
      .at(-1);
    response.send({
      ...plan,
      validation: validateMenu(plan, dishes, previous),
    });
  });
  function checkedPlan(input) {
    const dishes = store.all("dishes");
    const previous = store
      .all("plans")
      .filter(
        (item) =>
          item.stall === (input.scope === "all" ? "全部档口" : input.stall),
      )
      .at(-1);
    const checked = checkMenu(dishes, input, previous);
    return attachMenuWorkflow(store, checked, input.workflow, getSettings(store));
  }
  app.post("/api/plans/inspect", async (request, response) => {
    const prior = store.get("menuRuns", request.body.workflow?.runId || "");
    if (prior && (request.body.demo === true) !== (prior.demo === true))
      throw new Error("模拟和正式菜单的检验模式不可混用；模拟检验需显式 demo: true");
    const checked = checkedPlan(request.body);
    return response.send(await exclusive("menu-workflow", () => reinspectMenuWorkflow({ store, ai, input: checked, settings: getSettings(store) })));
  });
  app.post("/api/plans/check", (request, response) =>
    response.send(checkedPlan(request.body)),
  );
  app.post("/api/plans", (request, response) => {
    const item = {
      ...checkedPlan(request.body),
      id: `P-${randomUUID()}`,
      status: "待审核草案",
    };
    store.put("plans", item.id, item);
    response.status(201).send(item);
  });
  app.get("/api/plans/:id", (request, response) => response.send(queries.plan(request.params.id)));
  app.post("/api/pos/import", (request, response) => {
    const { csv } = z.object({ csv: z.string().min(1) }).parse(request.body);
    const dishes = store.all("dishes");
    const inputs = parseCsv(csv).map((row, index) => {
      const result = transactionSchema.safeParse(row);
      if (!result.success)
        throw new Error(`第${index + 2}行：${result.error.issues[0].message}`);
      const item = result.data;
      if (item.dishId) {
        const dish = dishes.find((dish) => dish.id === item.dishId);
        if (!dish || dish.stall !== item.stall || dish.unit !== item.unit)
          throw new Error(`第${index + 2}行：菜品ID、档口或单位不匹配`);
        item.dishName = dish.name;
      } else {
        const matches = dishes.filter(
          (dish) =>
            dish.stall === item.stall &&
            dish.name === item.dishName &&
            dish.unit === item.unit,
        );
        if (matches.length === 1) item.dishId = matches[0].id;
      }
      return item;
    });
    let inserted = 0;
    store.atomic(() => {
      for (const item of inputs) {
        const id = hash(JSON.stringify([item.transactionId, item.lineId]));
        const previous = store.get("transactions", id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item))
          throw new Error(
            `交易 ${item.transactionId}/${item.lineId} 已存在且内容冲突，整批未导入`,
          );
        if (!previous) {
          store.put("transactions", id, item);
          inserted++;
        }
      }
    });
    response.send({
      inserted,
      skipped: inputs.length - inserted,
      unmapped: inputs.filter((item) => !item.dishId).length,
    });
  });
  app.get("/api/pos", (request, response) => {
    const filter = z
      .object({
        start: dateSchema.optional(),
        end: dateSchema.optional(),
        stall: z.string().optional(),
        demo: z.enum(["true", "false"]).optional(),
      })
      .parse(request.query);
    if (filter.start && filter.end && filter.start > filter.end)
      throw new Error("起始日期不能晚于结束日期");
    response.send(queries.analytics(filter));
  });
  if (existsSync(dist)) app.register(staticFiles, { root: dist });
  app.setNotFoundHandler((request, response) => {
    if (request.url.startsWith("/api") || !existsSync(dist))
      return response.status(404).send({ error: "接口不存在" });
    return response.sendFile("index.html");
  });
  app.setErrorHandler((error, _request, response) => {
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("；")
        : error.message;
    response
      .status([413, 502, 503].includes(error.statusCode) ? error.statusCode : 400)
      .send({ error: message || "请求失败" });
  });
  return app;
}
