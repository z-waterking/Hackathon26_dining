import test from "node:test";
import assert from "node:assert/strict";
import { publicData, publicMenuRun } from "../server/public-data.mjs";

test("operator responses retain business actions and recursively exclude internal instructions", () => {
  const record = { id: "A1", title: "增加菜品轮换", menuInstruction: "增加青菜轮换",
    feedbackIds: ["F1", "F2"], history: [{ revision: 2, rawPrompt: "internal-only",
      previous: { title: "菜品轮换", promptVersion: 3, operatorNotes: "internal-only" } }],
    settings: { plannerPrompt: "internal-only" }, nested: { inspectorInput: {}, apiKey: "secret" } };
  const clean = publicData(record);
  assert.equal(clean.menuInstruction, record.menuInstruction);
  assert.deepEqual(clean.history, [{ revision: 2, previous: { title: "菜品轮换" } }]);
  assert.deepEqual(clean.feedbackIds, ["F1", "F2"]);
  assert.equal(JSON.stringify(clean).includes("internal-only"), false);
  assert.equal(record.settings.plannerPrompt, "internal-only", "server snapshot is unchanged");
});

test("public menu trace omits model inputs and raw failure details", () => {
  const trace = publicMenuRun({ id: "MR1", status: "failed", error: "upstream echoed internal-only",
    input: { scope: "all" }, plannerInput: { instructions: "internal-only" }, inspectorInput: {},
    snapshots: { actions: [{ id: "A1", revision: 2 }], rules: [], prompts: { planner: "internal-only" }, settings: {} } });
  assert.equal(trace.snapshots.actions[0].revision, 2);
  assert.equal(JSON.stringify(trace).includes("internal-only"), false);
  assert.match(trace.error, /本次运行失败/);
  assert.equal(trace.plannerInput, undefined);
  assert.equal(trace.snapshots.settings, undefined);
});
