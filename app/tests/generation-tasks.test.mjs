import test from "node:test";
import assert from "node:assert/strict";
import { cancellationError, createGenerationTasks, generationId, generationRequest } from "../server/generation-tasks.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const cancelled = error => error?.code === "GENERATION_CANCELLED" && error.statusCode === 409;
const duplicate = error => error?.code === "GENERATION_ALREADY_EXISTS" && error.statusCode === 409;
const full = error => error?.statusCode === 503;

test("generation identifiers accept only bounded safe characters and request extraction preserves business input", () => {
  for (const id of ["abcdefgh", "ABC_0123-xyz", "a".repeat(100)]) assert.equal(generationId(id), id);
  for (const id of [undefined, null, 123, "short", "a".repeat(101), "has spaces", "slash/path", "中文不能作标识", "query?key", "dot.name"])
    assert.throws(() => generationId(id), /生成任务ID无效/);
  const nested = Object.freeze({ scope: "all", source: "保留原文" });
  const body = Object.freeze({ generationId: "request-id-001", force: true, nested });
  const request = generationRequest(body);
  assert.deepEqual(request, { id: "request-id-001", input: { force: true, nested } });
  assert.equal(request.input.nested, nested);
  assert.notEqual(request.input, body);
  assert.deepEqual(generationRequest(), { id: undefined, input: {} });
  assert.deepEqual(generationRequest({ force: false }), { id: undefined, input: { force: false } });
  for (const invalid of [null, [], "invalid", 2]) assert.throws(() => generationRequest(invalid), /生成请求无效/);
});

test("legacy anonymous work receives no signal and does not consume registry capacity", async () => {
  const tasks = createGenerationTasks({ maxEntries: 1 });
  tasks.cancel("reserved-slot");
  const value = { original: true };
  assert.equal(await tasks.run(undefined, signal => { assert.equal(signal, undefined); return value; }), value);
  assert.equal(await tasks.run(undefined, async () => 7), 7);
  const error = new Error("legacy failure");
  await assert.rejects(tasks.run(undefined, () => { throw error; }), candidate => candidate === error);
  assert.deepEqual(tasks.cancel("reserved-slot"), { id: "reserved-slot", status: "cancelled", cancelled: true });
});

test("same-tick duplicate starts invoke one action and cancellation aborts its controller once", async () => {
  const tasks = createGenerationTasks();
  const gate = deferred();
  let signal;
  let starts = 0;
  let aborts = 0;
  const running = tasks.run("same-tick-task", next => {
    starts++; signal = next;
    signal.addEventListener("abort", () => aborts++);
    return gate.promise;
  });
  await assert.rejects(tasks.run("same-tick-task", () => { starts++; }), duplicate);
  assert.equal(starts, 1);
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(tasks.cancel("same-tick-task"), { id: "same-tick-task", status: "cancelling", cancelled: true });
  assert.deepEqual(tasks.cancel("same-tick-task"), { id: "same-tick-task", status: "cancelling", cancelled: true });
  assert.equal(aborts, 1);
  assert.equal(signal.aborted, true);
  assert.ok(cancelled(signal.reason));
  gate.resolve("late output");
  await assert.rejects(running, cancelled);
  assert.deepEqual(tasks.cancel("same-tick-task"), { id: "same-tick-task", status: "cancelled", cancelled: true });
  await assert.rejects(tasks.run("same-tick-task", () => { starts++; }), cancelled);
  assert.equal(starts, 1);
});

test("completion wins only after settlement while cancellation between resolve and continuation discards the result", async () => {
  const tasks = createGenerationTasks();
  const gate = deferred();
  const result = tasks.run("microtask-race", () => gate.promise);
  gate.resolve("not yet delivered");
  assert.equal(tasks.cancel("microtask-race").status, "cancelling");
  await assert.rejects(result, cancelled);
  assert.equal(tasks.cancel("microtask-race").status, "cancelled");
  const value = { result: "completed" };
  assert.equal(await tasks.run("completed-task", async () => value), value);
  assert.deepEqual(tasks.cancel("completed-task"), { id: "completed-task", status: "completed", cancelled: false });
  await assert.rejects(tasks.run("completed-task", () => "duplicate"), duplicate);
});

test("terminal failure and explicit cancellation errors retain accurate terminal state", async () => {
  const tasks = createGenerationTasks();
  const error = new Error("ordinary failure");
  await assert.rejects(tasks.run("ordinary-fail", () => { throw error; }), candidate => candidate === error);
  assert.deepEqual(tasks.cancel("ordinary-fail"), { id: "ordinary-fail", status: "failed", cancelled: false });
  await assert.rejects(tasks.run("ordinary-fail", () => "duplicate"), duplicate);
  const stopped = Object.assign(cancellationError(), { runId: "MR-preserved", diagnostics: { week: 3 } });
  await assert.rejects(tasks.run("explicit-stop", () => { throw stopped; }), candidate => candidate === stopped);
  assert.deepEqual(tasks.cancel("explicit-stop"), { id: "explicit-stop", status: "cancelled", cancelled: true });
});

test("early cancel tombstones reject late starts until their exact retention boundary without extending on repeat cancel", async () => {
  let time = 0;
  const tasks = createGenerationTasks({ now: () => time, retentionMs: 100, maxEntries: 1 });
  assert.deepEqual(tasks.cancel("early-cancel-id"), { id: "early-cancel-id", status: "cancelled", cancelled: true });
  time = 99;
  assert.equal(tasks.cancel("early-cancel-id").status, "cancelled");
  let calls = 0;
  await assert.rejects(tasks.run("early-cancel-id", () => { calls++; }), cancelled);
  await assert.rejects(tasks.run("capacity-denied", () => { calls++; }), full);
  assert.equal(calls, 0);
  time = 100;
  assert.equal(await tasks.run("early-cancel-id", () => { calls++; return "fresh after expiry"; }), "fresh after expiry");
  assert.equal(calls, 1);
});

test("retention starts at completion rather than request start and expired terminal entries release capacity", async () => {
  let time = 0;
  const tasks = createGenerationTasks({ now: () => time, retentionMs: 100, maxEntries: 1 });
  const gate = deferred();
  const running = tasks.run("long-running-id", () => gate.promise);
  time = 1000;
  await assert.rejects(tasks.run("still-no-room", () => "must not run"), full);
  gate.resolve("done");
  await running;
  time = 1099;
  await assert.rejects(tasks.run("still-no-room", () => "must not run"), full);
  assert.deepEqual(tasks.cancel("long-running-id"), { id: "long-running-id", status: "completed", cancelled: false });
  time = 1100;
  assert.equal(await tasks.run("still-no-room", () => "new task"), "new task");
});

test("capacity pressure never evicts a running or cancelling controller and known cancellations work when full", async () => {
  let time = 0;
  const tasks = createGenerationTasks({ now: () => time, retentionMs: 10, maxEntries: 1 });
  const gate = deferred();
  let signal;
  const running = tasks.run("preserve-active", next => { signal = next; return gate.promise; });
  time = 1000;
  assert.throws(() => tasks.cancel("new-tombstone"), full);
  await assert.rejects(tasks.run("new-generation", () => "must not run"), full);
  assert.equal(signal.aborted, false);
  assert.equal(tasks.cancel("preserve-active").status, "cancelling");
  assert.equal(signal.aborted, true);
  time = 2000;
  assert.throws(() => tasks.cancel("new-tombstone"), full);
  await assert.rejects(tasks.run("new-generation", () => "must not run"), full);
  assert.equal(tasks.cancel("preserve-active").status, "cancelling");
  gate.resolve("late result");
  await assert.rejects(running, cancelled);
  time = 2010;
  assert.deepEqual(tasks.cancel("new-tombstone"), { id: "new-tombstone", status: "cancelled", cancelled: true });
});

test("unrelated cancellation and capacity checks never abort other active task signals", async () => {
  const tasks = createGenerationTasks({ maxEntries: 3 });
  const first = deferred();
  const second = deferred();
  let signalA;
  let signalB;
  const runningA = tasks.run("isolation-task-a", signal => { signalA = signal; return first.promise; });
  const runningB = tasks.run("isolation-task-b", signal => { signalB = signal; return second.promise; });
  tasks.cancel("isolation-early");
  assert.throws(() => tasks.cancel("isolation-full"), full);
  assert.equal(signalA.aborted, false);
  assert.equal(signalB.aborted, false);
  tasks.cancel("isolation-task-a");
  assert.equal(signalA.aborted, true);
  assert.equal(signalB.aborted, false);
  first.resolve("discard");
  second.resolve("retained");
  await assert.rejects(runningA, cancelled);
  assert.equal(await runningB, "retained");
});

test("every rejected action value leaves a failed terminal record instead of an orphaned running task", async () => {
  const tasks = createGenerationTasks();
  for (const [index, value] of [null, undefined, "string failure", 3].entries()) {
    const id = `rejected-value-${index}`;
    let rejected = false;
    try { await tasks.run(id, () => Promise.reject(value)); }
    catch { rejected = true; }
    assert.equal(rejected, true);
    assert.deepEqual(tasks.cancel(id), { id, status: "failed", cancelled: false });
    await assert.rejects(tasks.run(id, () => "duplicate"), duplicate);
  }
});

test("explicit cancellation takes precedence over a late generic rejection and returns the standard cancellation error", async () => {
  const tasks = createGenerationTasks();
  const gate = deferred();
  const running = tasks.run("abort-reject-race", () => gate.promise);
  tasks.cancel("abort-reject-race");
  gate.reject(new Error("late transport failure"));
  await assert.rejects(running, cancelled);
  assert.deepEqual(tasks.cancel("abort-reject-race"), { id: "abort-reject-race", status: "cancelled", cancelled: true });
});

test("cancellation preserves an existing menu cancellation error and its recovery diagnostics", async () => {
  const tasks = createGenerationTasks();
  const gate = deferred();
  const running = tasks.run("abort-metadata-id", () => gate.promise);
  tasks.cancel("abort-metadata-id");
  const stopped = Object.assign(cancellationError(), { runId: "MR-checkpoint", diagnostics: { week: 3, completedWeeks: 2 } });
  gate.reject(stopped);
  await assert.rejects(running, candidate => candidate === stopped && candidate.runId === "MR-checkpoint" && candidate.diagnostics.completedWeeks === 2);
});
