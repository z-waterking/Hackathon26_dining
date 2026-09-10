// Test-only model response: select explicit indexes from the request catalog.
// No network, production fallback or local generation algorithm is involved.
// excludeIds uses S0:0 local aliases. D0-style flattened aliases remain test-only compatibility.
export function directWeeklyResponse({ input }, { excludeIds = [], includeReviews = true } = {}) {
  let offset = 0;
  const menus = Object.fromEntries(input.layout.map((layout) => {
    const catalog = input.dishCatalog[layout.key];
    const indexes = catalog.flatMap((dish, index) => !excludeIds.includes(`${layout.key}:${dish[0]}`) && !excludeIds.includes(`D${offset + index}`) ? [dish[0]] : []);
    offset += catalog.length;
    const count = 5 * input.meals.length * layout.priceRules.length;
    return [layout.key, Array.from({ length: count }, (_, offset) =>
      layout.manualRequired || !indexes.length ? -1 : indexes[(offset + input.week - 1) % indexes.length])];
  }));
  const actionReviews = includeReviews ? input.approvedActions.map((action) => {
    const layout = input.layout.find((item) => ["全部档口", item.stall].includes(action.targetStall) && !item.manualRequired);
    return { actionId: action.id, status: layout ? "applied" : "not_applied", note: layout ? "本周按批准事项选择实际菜品，仍需人工复核" : "无可执行菜品槽位",
      evidence: layout ? [{ stallIndex: layout.stallIndex, day: 1, mealIndex: 0, slot: 0 }] : [] };
  }) : [];
  return { summary: `第 ${input.week} 周直接选择测试菜品`, menus, actionReviews, warnings: [] };
}
