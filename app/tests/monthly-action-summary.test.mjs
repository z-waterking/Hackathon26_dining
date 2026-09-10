import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { COLLECTIONS } from "../server/data/repository.mjs";
import { monthlySummary } from "../server/feedback-ai.mjs";

const record = (id, date, extra = {}) => ({ id, date, content: "建议增加蔬菜轮换", type: "建议", status: "未处理", ...extra });
function setup(t, feedback, actions) {
  const store = createStore(":memory:", () => ({ feedback, dishes: [], rules: [], recipes: [], inventory: [], report: {} }));
  for (const action of actions) store.put("actions", action.id, action);
  t.after(() => store.close());
  return store;
}

test("monthly aggregate Action counts use any matching feedback ID, once per Action per month", t => {
  const store = setup(t, [record("S1", "2026-09-01"), record("S2", "2026-09-02"), record("O1", "2026-10-01")], [
    { id: "cross-month", feedbackIds: ["S1", "S2", "S1", "O1"], status: "approved" },
    { id: "september-only", feedbackIds: ["S1", "S2"], status: "pending" },
    { id: "october-only", feedbackIds: ["O1"], status: "pending" },
    { id: "rejected", feedbackIds: ["S1"], status: "rejected" },
  ]);
  const september = monthlySummary(store, "2026-09");
  assert.equal(september.total, 2);
  assert.equal(september.approvedActions, 1, "multiple matching feedbacks and duplicate IDs do not multiply an Action");
  assert.equal(september.pendingActions, 1);
  const october = monthlySummary(store, "2026-10");
  assert.equal(october.total, 1);
  assert.equal(october.approvedActions, 1, "a cross-month Action also belongs to its other linked month");
  assert.equal(october.pendingActions, 1);
  const empty = monthlySummary(store, "2026-11");
  assert.equal(empty.approvedActions, 0);
  assert.equal(empty.pendingActions, 0);
});

test("monthly Action counts exclude demo Actions and links only to summary, demo or quarantined feedback", t => {
  const store = setup(t, [record("real", "2026-09-01"),
    record("summary", "2026-09", { summaryRecord: true }),
    record("demo", "2026-09-01", { demo: true }),
    record("quarantined", "2026-09-01", { quarantined: true })], [
    { id: "demo-action", feedbackIds: ["real"], feedbackId: "real", status: "approved", demo: true },
    { id: "summary-action", feedbackIds: ["summary"], status: "approved" },
    { id: "demo-feedback-action", feedbackIds: ["demo"], status: "pending" },
    { id: "quarantined-action", feedbackIds: ["quarantined"], status: "pending" },
    { id: "missing-action", feedbackIds: ["not-found"], status: "approved" },
    { id: "mixed-real-action", feedbackIds: ["summary", "demo", "quarantined", "real"], status: "approved", demo: false },
  ]);
  const summary = monthlySummary(store, "2026-09");
  assert.equal(summary.total, 1);
  assert.equal(summary.summaryRecords, 1);
  assert.equal(summary.approvedActions, 1);
  assert.equal(summary.pendingActions, 0);
});

test("legacy feedbackId and mixed-format Action links remain compatible without duplicate counts", t => {
  const store = setup(t, [record("S1", "2026-09-01"), record("O1", "2026-10-01")], [
    { id: "legacy", feedbackId: "S1", status: "approved" },
    { id: "both-fields", feedbackIds: ["S1", "S1"], feedbackId: "S1", status: "approved" },
    { id: "empty-array-legacy", feedbackIds: [], feedbackId: "S1", status: "pending" },
    { id: "mixed-months", feedbackIds: ["O1"], feedbackId: "S1", status: "pending" },
    { id: "no-links", status: "approved" },
    { id: "nonarray", feedbackIds: "S1", status: "approved" },
    { id: "invalid-values", feedbackIds: [null, {}, 1], status: "pending" },
  ]);
  const summary = monthlySummary(store, "2026-09");
  assert.equal(summary.approvedActions, 2);
  assert.equal(summary.pendingActions, 2);
  assert.equal(monthlySummary(store, "2026-10").pendingActions, 1);
});

test("monthly Action counts reflect current approval states without mutating business records", t => {
  const action = { id: "approved", feedbackIds: ["S1"], status: "approved", enabled: false, revision: 7, history: [{ kind: "运营批准" }] };
  const store = setup(t, [record("S1", "2026-09-01")], [action]);
  const snapshot = () => Object.fromEntries(COLLECTIONS.map(collection => [collection, store.all(collection)]));
  const before = snapshot();
  const summary = monthlySummary(store, "2026-09");
  assert.equal(summary.approvedActions, 1, "status totals are not silently narrowed to enabled menu Actions");
  assert.deepEqual(snapshot(), before);
  store.put("actions", action.id, { ...action, status: "pending", revision: 8 });
  const changed = snapshot();
  const updated = monthlySummary(store, "2026-09");
  assert.equal(updated.approvedActions, 0);
  assert.equal(updated.pendingActions, 1);
  assert.deepEqual(snapshot(), changed);
});
