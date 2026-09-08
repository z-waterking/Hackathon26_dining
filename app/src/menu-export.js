export function menuRows(plan, dishes) {
  const byId = new Map(dishes.map((dish) => [dish.id, dish]));
  const weekdays = ["周一", "周二", "周三", "周四", "周五"];
  const groups = new Map();
  for (const entry of plan.entries) {
    const stall = entry.stall || plan.stall;
    const key = JSON.stringify([entry.week, entry.meal, stall, entry.slot]);
    if (!groups.has(key)) {
      const monday = new Date(`${entry.date}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - entry.day + 1);
      const friday = new Date(monday);
      friday.setUTCDate(friday.getUTCDate() + 4);
      groups.set(key, {
        周次: `第${entry.week}周`,
        日期: `${monday.toISOString().slice(0, 10)} 至 ${friday.toISOString().slice(0, 10)}`,
        餐次: entry.meal,
        档口: stall,
        ...Object.fromEntries(weekdays.map((day) => [day, ""])),
      });
    }
    const dish = byId.get(entry.dishId);
    groups.get(key)[weekdays[entry.day - 1]] = dish
      ? `${dish.name}（¥${dish.priceText ?? dish.price}）`
      : "待补菜";
  }
  const mealOrder = ["早餐", "午餐", "晚餐"];
  return [...groups.values()].sort(
    (left, right) =>
      left.周次.localeCompare(right.周次) ||
      mealOrder.indexOf(left.餐次) - mealOrder.indexOf(right.餐次),
  );
}
