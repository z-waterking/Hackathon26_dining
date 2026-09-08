import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

test("API persists feedback, merges threads, atomically imports POS and rejects invalid input", async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "dining-test-"));
  const filename = resolve(temporary, "test.sqlite");
  let store = createStore(filename, () => ({
    feedback: [],
    dishes: [],
    recipes: [],
    rules: [],
    inventory: [],
    report: {},
  }));
  const app = createApp(store, resolve(temporary, "no-dist"));
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = async (path, body, method = "POST") => {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const input = {
      content: "希望增加素食选择",
      restaurant: "员工餐厅",
      date: "2026-09-05",
      channel: "邮件",
      type: "建议",
      threadId: "thread-1",
    };
    const created = await call("/api/feedback", input);
    assert.equal(created.status, 201);
    const id = created.data.item.id;
    assert.equal(
      (
        await call(
          `/api/feedback/${id}`,
          { status: "已完成", owner: "运营", note: "已现场确认" },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/api/feedback", {
          ...input,
          content: "问题仍存在，请继续跟进",
        })
      ).data.merged,
      true,
    );
    assert.equal(store.get("feedback", id).status, "跟进中");
    assert.equal(store.all("feedback").length, 1);
    assert.equal(
      (await call("/api/feedback", { ...input, date: "2026-02-30" })).status,
      400,
    );
    const csv =
      "transactionId,lineId,time,stall,dishName,quantity,amount,status,unit\nT1,1,2026-09-05T12:30,测试档口,未映射菜,1,12,sale,份";
    assert.equal((await call("/api/pos/import", { csv })).data.inserted, 1);
    assert.equal((await call("/api/pos/import", { csv })).data.skipped, 1);
    assert.equal(
      (
        await call("/api/pos/import", {
          csv: `${csv}\nT2,1,2026-09-05T12:30,测试档口,菜,1,12,sale,份\nT1,1,2026-09-05T12:30,测试档口,菜,1,19,sale,份`,
        })
      ).status,
      400,
    );
    assert.equal(store.all("transactions").length, 1);
    const totals = await (await fetch(base + "/api/pos")).json();
    assert.equal(totals.revenue, 12);
    assert.equal(totals.ranking.length, 0);
    assert.equal(totals.unmapped, 1);
    const rejected = await fetch(base + "/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify(input),
    });
    assert.equal(rejected.status, 403);
    store.close();
    store = createStore(filename, () => {
      throw new Error("Must not reinitialize");
    });
    assert.equal(store.all("feedback").length, 1);
    assert.equal(store.all("transactions").length, 1);
  } finally {
    await app.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
