import { publicData, publicMenuRun } from "../public-data.mjs";
import { getActionSummary } from "../action-summary.mjs";
import { feedbackInsights, monthlySummary } from "../feedback-ai.mjs";
import { convertedBatchRows } from "../bootstrap.mjs";
import { attachMenuWorkflow, menuRecoveryRecords, completedMenuResult } from "../menu-workflow.mjs";
import { getSettings } from "../settings.mjs";
import { validateMenu } from "../menus.mjs";
import { aggregateTransactions, demoTransactions } from "../domain.mjs";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute, basename } from "node:path";
import { promptAdminView } from "../prompt-admin.mjs";
import { promptHistory, promptHistoryVersion } from "../prompt-config.mjs";
import { englishNameSummary } from "../catalog-english.mjs";

// Public read models live here, independent of Fastify handlers. Both the
// workspace snapshot and resource endpoints share the same projections.
export function createQueryService(repository, { ai, root } = {}) {
  const required = (collection, id) => {
    const record = repository.get(collection, id);
    if (!record) throw new Error("记录不存在");
    return record;
  };
  const queries = {
    dishes: () => publicData(repository.all("dishes")),
    catalogEnglish: () => publicData(englishNameSummary(repository)),
    feedback: () => publicData(repository.all("feedback")),
    actions: () => publicData(repository.all("actions")),
    plans: () => publicData(repository.all("plans").map(({ entries = [], ...plan }) => ({ ...plan, countEntries: entries.length }))),
    imports: () => publicData(repository.all("imports").slice(-20).reverse()),
    materials: () => publicData(repository.get("meta", "inventory")),
    audit: () => publicData(repository.all("audit").slice(-100).reverse()),
    aiStatus: () => publicData(ai.status()),
    promptConfig: () => promptAdminView(repository),
    promptHistory: (query) => promptHistory(repository, query),
    promptHistoryVersion: (version) => promptHistoryVersion(repository, version),
    menuRun: (id) => publicMenuRun(required("menuRuns", id)),
    menuRuns: () => publicData(menuRecoveryRecords(repository, getSettings(repository))),
    menuRunResult: (id) => publicData(completedMenuResult(repository, id, getSettings(repository))),
    actionSummary: (scope) => publicData(getActionSummary(repository, scope)),
    insights: (scope) => publicData(feedbackInsights(repository, scope)),
    monthlySummary: (month) => publicData(monthlySummary(repository, month)),
    convertedRows: (id) => publicData(convertedBatchRows(repository, id, root)),
    importDownload: (id, format) => {
      const batch = required("imports", id);
      const path = format === "xlsx" ? batch.xlsxPath : batch.csvPath;
      const artifactRoot = resolve(root || resolve(import.meta.dirname, "../../.."), "app/data/conversions");
      const within = path ? relative(artifactRoot, resolve(path)) : "..";
      if (!path || within.startsWith("..") || isAbsolute(within) || !existsSync(path))
        throw new Error("此批次未生成可下载文件，请重新转换");
      return { path, filename: basename(path), contentType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8" };
    },
    recipes: (id) => {
      const dish = required("dishes", id);
      // A display-name correction must not detach imported recipe evidence or
      // attach the recipe of an unrelated newly named dish.
      const sourceName = dish.sourceName || dish.name;
      return publicData((repository.get("meta", "recipes") || []).filter((recipe) => recipe.name.replace(/\s/g, "") === sourceName.replace(/\s/g, "")));
    },
    plan: (id) => {
      const item = required("plans", id);
      return publicData(attachMenuWorkflow(repository, { ...item, validation: validateMenu(item, repository.all("dishes")) }, item.workflow, getSettings(repository)));
    },
    analytics: (filter) => {
      const demo = filter.demo === "true";
      return publicData({ ...aggregateTransactions(demo ? demoTransactions(repository.all("dishes")) : repository.all("transactions"), filter), demo });
    },
  };
  queries.workspace = () => ({
    dishes: queries.dishes(), feedback: queries.feedback(), plans: queries.plans(), actions: queries.actions(), imports: queries.imports(),
    report: publicData(repository.get("meta", "report")), rules: publicData(repository.get("meta", "rules")),
    initialized: publicData(repository.get("meta", "initialized")), aiStatus: queries.aiStatus(),
  });
  return Object.freeze(queries);
}
