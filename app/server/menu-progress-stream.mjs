import { PassThrough } from "node:stream";
import { publicData } from "./public-data.mjs";

// Flush business milestones, not unfinished JSON tokens. Detaching a browser
// does not abandon paid work: checkpoints and the completed run stay readable.
export async function streamMenuProgress(reply, generate, { drainTimeoutMs = 30000 } = {}) {
  const stream = new PassThrough();
  let opened = false;
  let detached = false;
  let heartbeat;
  let runId;
  const detach = () => { detached = true; clearInterval(heartbeat); };
  reply.raw.once("close", detach);
  stream.on("error", detach);
  async function emit(event, { signal } = {}) {
    signal?.throwIfAborted();
    if (event.runId) runId = event.runId;
    if (detached) return;
    if (!opened) {
      opened = true;
      reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
      reply.header("Cache-Control", "no-store, no-transform");
      reply.header("X-Accel-Buffering", "no");
      reply.send(stream);
      heartbeat = setInterval(() => {
        if (!detached && !stream.destroyed && stream.writableLength === 0)
          stream.write(JSON.stringify({ type: "heartbeat", runId }) + "\n");
      }, 15000);
      heartbeat.unref();
    }
    if (stream.destroyed) return;
    const ready = stream.write(JSON.stringify(publicData(event)) + "\n");
    if (!ready) {
      const drained = new Promise(resolve => {
        // A connected browser/proxy that stops reading must not indefinitely
        // block later AI weeks or hold the workflow's exclusive lock.
        const timeout = setTimeout(() => { detach(); stream.destroy(); reply.raw.destroy(); done(); }, drainTimeoutMs);
        timeout.unref();
        const done = () => { clearTimeout(timeout); stream.off("drain", done); stream.off("close", done); reply.raw.off("close", done); signal?.removeEventListener("abort", done); resolve(); };
        stream.once("drain", done); stream.once("close", done); reply.raw.once("close", done);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
      // The cancellation frame is terminal: queue it for the reader, but do
      // not hold the generation lock waiting for a slow browser to drain it.
      // The bounded drain cleanup above remains active after the lock releases.
      if (event.type !== "error" || event.code !== "GENERATION_CANCELLED") await drained;
    }
    signal?.throwIfAborted();
    await new Promise(resolve => setImmediate(resolve));
  }
  try {
    const plan = await generate(emit);
    await emit({ type: "completed", runId: plan.workflow.runId, plan });
  } catch (error) {
    if (!opened) throw error;
    await emit({ type: "error", error: error.message || "菜单生成失败，请查看恢复记录", runId: error.runId || runId,
      ...Object.fromEntries(["code", "week", "stall", "day", "meal", "slot"].filter(key =>
        ["string", "number"].includes(typeof error.diagnostics?.[key])).map(key => [key, error.diagnostics[key]])),
      ...(error.code === "GENERATION_CANCELLED" ? { code: error.code } : {}),
    });
  } finally {
    clearInterval(heartbeat);
    if (!stream.destroyed) stream.end();
    reply.raw.off("close", detach);
  }
  // Do not return Fastify's thenable reply here. The caller releases the
  // business lock before waiting for a slow client's final socket drain.
}
