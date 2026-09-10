// Explicit cancellation is separate from a disconnected browser. This registry
// is process-local, like the existing generation locks, and never stores input.
export const cancellationError = () => Object.assign(new Error(
  "生成已取消，已完成的记录保留",
), { code: "GENERATION_CANCELLED", statusCode: 409 });

export function generationId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value))
    throw new Error("生成任务ID无效");
  return value;
}

export function generationRequest(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("生成请求无效");
  const { generationId: id, ...input } = body;
  return { id: id === undefined ? undefined : generationId(id), input };
}

export function createGenerationTasks({ now = Date.now, retentionMs = 3600000, maxEntries = 2000 } = {}) {
  const tasks = new Map();
  function prune() {
    for (const [id, task] of tasks)
      if (task.finishedAt !== undefined && now() - task.finishedAt >= retentionMs) tasks.delete(id);
  }
  function capacity() {
    prune();
    // Never evict an active controller or a recent cancellation tombstone.
    if (tasks.size >= maxEntries) throw Object.assign(new Error("生成任务记录已满，请稍后重试"), { statusCode: 503 });
  }
  async function run(id, action) {
    // Older clients remain supported, but cannot target an anonymous request.
    if (id === undefined) return action(undefined);
    generationId(id);
    prune();
    const prior = tasks.get(id);
    if (prior) {
      if (prior.status === "cancelled" || prior.status === "cancelling") throw cancellationError();
      throw Object.assign(new Error("生成任务ID已使用，请发起新的任务"), { code: "GENERATION_ALREADY_EXISTS", statusCode: 409 });
    }
    capacity();
    const task = { controller: new AbortController(), status: "running" };
    tasks.set(id, task);
    try {
      task.controller.signal.throwIfAborted();
      const result = await action(task.controller.signal);
      task.controller.signal.throwIfAborted();
      task.status = "completed";
      return result;
    } catch (error) {
      task.status = task.controller.signal.aborted || error?.code === "GENERATION_CANCELLED" ? "cancelled" : "failed";
      if (task.status === "cancelled" && error?.code !== "GENERATION_CANCELLED") throw cancellationError();
      throw error;
    } finally {
      task.finishedAt = now();
      delete task.controller;
    }
  }
  function cancel(rawId) {
    const id = generationId(rawId);
    prune();
    let task = tasks.get(id);
    if (!task) {
      // The cancel request can overtake the original POST on another socket.
      capacity();
      task = { status: "cancelled", finishedAt: now() };
      tasks.set(id, task);
    } else if (task.status === "running") {
      task.status = "cancelling";
      task.controller.abort(cancellationError());
    }
    return { id, status: task.status, cancelled: ["cancelling", "cancelled"].includes(task.status) };
  }
  return { run, cancel };
}
