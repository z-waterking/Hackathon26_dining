// Operational API responses expose business records, not internal AI messages.
const internalKeys = new Set([
  "plannerPrompt", "inspectorPrompt", "feedbackPrompt", "operatorNotes",
  "prompts", "prompt", "rawPrompt", "systemPrompt", "promptVersion", "settings",
  "plannerInput", "inspectorInput", "apiKey", "api_key",
]);
export function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([key]) => !internalKeys.has(key)).map(([key, item]) => [key, publicData(item)]));
  return value;
}
export function publicMenuRun(run) {
  return publicData({ id: run.id, status: run.status, stage: run.stage, demo: Boolean(run.demo),
    createdAt: run.createdAt, completedAt: run.completedAt, parentRunId: run.parentRunId,
    input: run.input, snapshots: { actions: run.snapshots?.actions, rules: run.snapshots?.rules },
    planner: run.planner, workflow: run.workflow, error: run.error ? "本次运行失败，请检查业务要求后重试；技术详情仅保留在服务端。" : undefined });
}
