// Optional live integration check. Uses an in-memory database and synthetic
// feedback only; does not approve or alter production business records.
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createStore } from "../app/server/store.mjs";
import { createAiClient } from "../app/server/ai.mjs";
import { getSettings } from "../app/server/settings.mjs";
import { analyzeFeedback, updateAction, summarizeMonth } from "../app/server/feedback-ai.mjs";
import { summarizeActions } from "../app/server/action-summary.mjs";
import { runMenuWorkflow } from "../app/server/menu-workflow.mjs";

loadEnvFile(resolve(import.meta.dirname, "../app/.env"));
const dishes = Array.from({ length: 16 }, (_, index) => ({
  id: `demo-dish-${index}`, name: `${index % 2 ? "蒸鸡肉" : "蒸时蔬"}${index + 1}`,
  stall: "测试档口", price: 8, priceText: "8元/份", unit: "份", active: true,
  spicy: "不辣", vegetarian: index % 2 ? "非素食" : "素食",
  mainIngredient: index % 2 ? "鸡肉" : "青菜", method: "蒸", labelSource: "仅合成集成测试标签",
}));
const store = createStore(":memory:", () => ({
  feedback: [{ id: "test-feedback", content: "希望测试档口午餐多一点不辣的素菜选择。", restaurant: "测试档口",
    date: "2026-09-08", type: "建议", category: "口味", status: "未处理", events: [], channel: "手工" },
    { id: "test-feedback-2", content: "测试档口的午餐素食可选品种偏少，建议多安排蒸时蔬。", restaurant: "测试档口",
      date: "2026-09-08", type: "建议", category: "菜品", status: "未处理", events: [], channel: "手工" }],
  dishes, recipes: [], inventory: [], report: {},
  rules: [{ stall: "测试档口", text: "每餐2道菜，从此档口菜库中选择，同餐不重复，优先安排1道已核验的不辣素菜。", source: { file: "合成测试规则", sheet: "规则", row: 1 } }],
}));
const ai = createAiClient(store);
try {
  const analysis = await analyzeFeedback(store, ai, "test-feedback");
  const aggregate = await summarizeActions(store, ai);
  for (const action of aggregate.actions) updateAction(store, action.id, { status: "approved", reason: "合成测试审批，不是生产操作" });
  const summary = await summarizeMonth(store, ai, "2026-09");
  const plan = await runMenuWorkflow({ store, ai, settings: getSettings(store), input: { scope: "all", start: "2026-09-14", meals: ["午餐"], count: 2, seed: 7 } });
  console.log(JSON.stringify({ ok: true, feedbackAnalysis: Boolean(analysis.feedback.aiAnalysis), sourceFeedback: aggregate.sourceCount, actions: aggregate.actions.length,
    monthlySummary: Boolean(summary.aiSummary), menuEntries: plan.entries.length, weeks: new Set(plan.entries.map((item) => item.week)).size,
    plannerDecisions: plan.workflow.planner.decisions.length, inspectorVerdict: plan.workflow.inspector.verdict,
    impacts: plan.workflow.actionImpacts.length, humanApprovalRequired: plan.workflow.requiresHumanApproval,
    calls: ai.status().calls, inputTokens: ai.status().inputTokens, outputTokens: ai.status().outputTokens }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
