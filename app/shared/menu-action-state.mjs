// Shared by the menu page and server planner: a status badge alone does not
// make an Action a menu requirement. Never infer a requirement from its title.
const hasInstruction = action => typeof action.menuInstruction === "string" && Boolean(action.menuInstruction.trim());
const hasFeedback = action => Array.isArray(action.feedbackIds) && action.feedbackIds.length > 0;
export function isApprovedMenuAction(action, { demo = false } = {}) {
  return Boolean(action && (action.demo === true) === demo && hasFeedback(action) &&
    action.status === "approved" && action.enabled === true && hasInstruction(action));
}

export function menuActionState(actions = []) {
  const formal = actions.filter(action => action && action.demo !== true);
  const menuItems = formal.filter(action => action.kind === "menu" || hasInstruction(action)).map(action => {
    if (isApprovedMenuAction(action)) return { action, statusLabel: "可用于排菜", reason: "已批准并启用，将用于下一次 AI 排菜。" };
    const reasons = [];
    if (action.status === "rejected") reasons.push("此事项已拒绝，不参与排菜");
    else if (action.status !== "approved") reasons.push("尚未批准，批准后才可参与排菜");
    if (action.enabled !== true) reasons.push("此事项未启用");
    if (!hasInstruction(action)) reasons.push("尚未填写排菜要求");
    if (!hasFeedback(action)) reasons.push("缺少反馈关联，请在 Action 事项中核对来源");
    const statusLabel = action.status === "rejected" ? "已拒绝" : action.status !== "approved" ? "待审批"
      : action.enabled !== true ? "已停用" : !hasInstruction(action) ? "缺少排菜要求" : "待补反馈关联";
    return { action, statusLabel, reason: reasons.join("；") + "。" };
  });
  const rank = item => isApprovedMenuAction(item.action) ? 0 : item.action.status === "pending" ? 1 : 2;
  menuItems.sort((a, b) => rank(a) - rank(b));
  return {
    eligible: formal.filter(action => isApprovedMenuAction(action)),
    menuItems,
    approvedCount: formal.filter(action => action.status === "approved").length,
    pendingCount: menuItems.filter(item => item.action.status === "pending").length,
    serviceApproved: formal.filter(action => action.status === "approved" && action.kind !== "menu" && !hasInstruction(action)),
  };
}
