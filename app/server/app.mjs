import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  feedbackSchema,
  feedbackUpdateSchema,
  dishUpdateSchema,
  parseCsv,
  transactionSchema,
  aggregateTransactions,
  demoTransactions,
  dateSchema,
} from "./domain.mjs";
import { generateMenu, validateMenu, checkMenu } from "./menus.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function createApp(
  store,
  dist = resolve(import.meta.dirname, "../dist"),
) {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024, logger: false });
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
      if (!request.headers["content-type"]?.startsWith("application/json"))
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
  app.get("/api/data", (_request, response) =>
    response.send({
      dishes: store.all("dishes"),
      feedback: store.all("feedback"),
      plans: store.all("plans").map(({ entries, ...plan }) => ({
        ...plan,
        countEntries: entries.length,
      })),
      report: store.get("meta", "report"),
      rules: store.get("meta", "rules"),
      initialized: store.get("meta", "initialized"),
    }),
  );
  app.get("/api/materials", (_request, response) =>
    response.send(store.get("meta", "inventory")),
  );
  app.get("/api/recipes/:id", (request, response) => {
    const dish = required("dishes", request.params.id);
    response.send(
      store
        .get("meta", "recipes")
        .filter(
          (recipe) =>
            recipe.name.replace(/\s/g, "") === dish.name.replace(/\s/g, ""),
        ),
    );
  });
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
  app.post("/api/plans/generate", (request, response) => {
    const dishes = store.all("dishes");
    const plan = generateMenu(dishes, request.body, store.all("feedback"));
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
    return checkMenu(dishes, input, previous);
  }
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
  app.get("/api/plans/:id", (request, response) => {
    const item = required("plans", request.params.id);
    response.send({
      ...item,
      validation: validateMenu(item, store.all("dishes")),
    });
  });
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
    const demo = filter.demo === "true";
    const records = demo
      ? demoTransactions(store.all("dishes"))
      : store.all("transactions");
    response.send({ ...aggregateTransactions(records, filter), demo });
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
      .status(error.statusCode === 413 ? 413 : 400)
      .send({ error: message || "请求失败" });
  });
  return app;
}
