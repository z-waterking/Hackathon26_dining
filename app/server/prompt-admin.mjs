import { getPromptConfig, promptBaseSummary } from "./prompt-config.mjs";
import { defaultSettings } from "./settings.mjs";
import { approvedMenuActions, sourceRules } from "./menu-workflow.mjs";
import { directPrompt, directContext } from "./direct-menu-planner.mjs";
import { readStallCatalog } from "./stored-stall-catalog.mjs";
import { actionGenerationPrompt, approvedActionsPrompt, responseInstructions, LOCAL_CONSTRAINTS_TEXT } from "./prompt-builders.mjs";

// This explicit DTO is only exposed by the requested configuration endpoint.
// Never spread aiConfig, settings, run snapshots, or feedback into the result.
export function promptAdminView(store) {
  const config = getPromptConfig(store);
  const settings = store.get("settings", "current") || defaultSettings;
  const actions = approvedMenuActions(store).map(({ id, title, targetStall, menuInstruction, priority, revision, status, enabled }) =>
    ({ id, title, targetStall, menuInstruction, priority, revision, status, enabled }));
  const catalog = readStallCatalog(store);
  const snapshots = { promptConfig: config, ...(catalog ? { planningMode: "per-stall" } : {}),
    rules: sourceRules(store), sourceRules: sourceRules(store, false),
    actions, dishes: store.all("dishes"), stallCatalog: catalog,
    fixedDishes: store.get("meta", "menu-fixed-dishes") || [] };
  const context = directContext(snapshots, { count: 4 });
  return { ...config, base: promptBaseSummary(store, config), approvedActions: actions, localConstraintsText: LOCAL_CONSTRAINTS_TEXT,
    previews: {
      actionGeneration: responseInstructions(actionGenerationPrompt(config, settings)),
      menuSystem: responseInstructions(directPrompt(snapshots)),
      approvedActions: approvedActionsPrompt(config.approvedActionText, actions),
      menuByStall: (catalog ? context.layout : []).map(item => ({ stall: item.stall,
        text: responseInstructions(directPrompt({ ...snapshots, actions: actions.filter(action => ["全部档口", item.stall].includes(action.targetStall)) })),
        execution: item.manualRequired ? "人工菜单来源，不发送排菜模型请求" : item.fixed ? "固定出品来源，不发送排菜模型请求" : "仅在有可行候选时发送；运行时附带本档候选、历史周次和共享菜单动态输入",
      })),
    },
  };
}
