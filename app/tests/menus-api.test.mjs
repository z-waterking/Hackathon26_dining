import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
import { createStore } from "../server/store.mjs";

test("one API request generates and saves a complete multi-stall draft atomically", async () => {
  const dishes = ["档口甲", "档口乙", "停用档口"].flatMap((stall) =>
    Array.from({ length: 12 }, (_, index) => ({
      id: `${stall}-${index}`,
      name: `${stall}菜${index}`,
      stall,
      price: 8,
      priceText: "8",
      unit: "份",
      active: stall !== "停用档口",
      spicy: "未知",
      vegetarian: "未知",
      mainIngredient: "",
      method: "",
    })),
  );
  const store = createStore(":memory:", () => ({
    dishes,
    feedback: [],
    recipes: [],
    rules: [],
    inventory: [],
    report: {},
  }));
  const app = createApp(store);
  const call = (url, payload) =>
    app.inject({
      method: payload ? "POST" : "GET",
      url,
      headers: {
        host: "127.0.0.1",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      payload,
    });
  try {
    const generated = await call("/api/plans/generate", {
      scope: "all",
      start: "2026-09-07",
      meals: ["午餐", "晚餐"],
      count: 2,
    });
    assert.equal(generated.statusCode, 200);
    const plan = generated.json();
    assert.equal(plan.entries.length, 360);
    assert.equal(store.all("plans").length, 0);
    const invalid = await call("/api/plans", {
      ...plan,
      entries: plan.entries.slice(120),
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(store.all("plans").length, 0);
    const saved = await call("/api/plans", plan);
    assert.equal(saved.statusCode, 201);
    assert.equal(store.all("plans").length, 1);
    const restored = (await call(`/api/plans/${saved.json().id}`)).json();
    assert.deepEqual(restored.entries, plan.entries);
    assert.deepEqual(restored.stalls, ["档口甲", "档口乙", "停用档口"]);
    assert.ok(
      restored.validation.issues.some((issue) => issue.stall === "停用档口"),
    );
    const summary = (await call("/api/data")).json().plans[0];
    assert.equal(summary.countEntries, 360);
    assert.equal(summary.scope, "all");
    assert.equal(summary.entries, undefined);
    const legacy = (
      await call("/api/plans/generate", {
        stall: "档口甲",
        start: "2026-09-07",
        meals: ["午餐"],
        count: 2,
      })
    ).json();
    assert.equal((await call("/api/plans", legacy)).statusCode, 201);
  } finally {
    await app.close();
    store.close();
  }
});
