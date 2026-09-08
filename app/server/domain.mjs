import { z } from "zod";
import Papa from "papaparse";

export const statuses = ["未处理", "跟进中", "已完成"];
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((text) => {
    const date = new Date(`${text}T00:00:00Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === text
    );
  }, "无效日期");
export const feedbackSchema = z.object({
  content: z.string().trim().min(2).max(10000),
  restaurant: z.string().trim().min(1).max(100),
  date: dateSchema,
  channel: z.enum(["手工", "口头", "微信群", "二维码", "邮件"]),
  type: z.enum(["建议", "投诉", "表扬", "询问"]),
  category: z.string().trim().max(50).default("待分类"),
  threadId: z.string().trim().max(200).default(""),
  owner: z.string().trim().max(100).default(""),
});
export const feedbackUpdateSchema = z.object({
  status: z.enum(statuses),
  owner: z.string().trim().max(100),
  note: z.string().trim().min(2).max(5000),
});
export const dishUpdateSchema = z.object({
  spicy: z.enum(["未知", "辣", "不辣"]),
  vegetarian: z.enum(["未知", "素食", "非素食"]),
  mainIngredient: z.string().trim().max(100),
  method: z.string().trim().max(50),
  active: z.boolean(),
  calories: z.number().min(0).max(900).nullable(),
  allergens: z.string().trim().max(500),
  labelSource: z.string().trim().min(2, "请填写标签核验依据").max(500),
});
export const planOptionsSchema = z.object({
  stall: z.string().min(1).max(100),
  start: dateSchema.refine(
    (text) => new Date(`${text}T00:00:00Z`).getUTCDay() === 1,
    "六周菜单必须从周一开始",
  ),
  seed: z.number().int().min(1).max(1000000).default(1),
  count: z.number().int().min(1).max(12).default(4),
  meals: z
    .array(z.enum(["早餐", "午餐", "晚餐"]))
    .min(1)
    .max(3)
    .refine((meals) => new Set(meals).size === meals.length, "餐次不得重复"),
});
const canonical = (dish) => dish.name.replace(/\s/g, "");
const strictStalls = [
  "寻味列车",
  "五味坊",
  "一锅烟火",
  "蒸心食意",
  "南粉北面",
  "饺好运",
];

export function slotPrices(stall, count) {
  if (stall === "寻味列车") return [8, 8, 8, 6, 6, 6, 5, 4];
  if (stall === "五味坊") return [8, 8, 5, 4];
  if (stall === "一锅烟火") return [">=30", "*", "*", "*"];
  if (stall === "蒸心食意")
    return ["10-25", "10-25", "10-25", "10-25", "<10", "<10", "<10"];
  if (["饺好运", "南粉北面"].includes(stall)) return ["*", "*", "*", "*"];
  if (stall === "宽窄巷子") return ["*", "*"];
  return Array(count).fill("*");
}

function fitsPrice(dish, slot) {
  if (slot === "*") return true;
  if (dish.unit !== "份") return false;
  if (slot === ">=30") return dish.price >= 30;
  if (slot === "10-25") return dish.price >= 10 && dish.price <= 25;
  if (slot === "<10") return dish.price < 10;
  return dish.price === slot;
}

export function generatePlan(allDishes, rawOptions, _feedback = [], selectionPolicy = []) {
  const options = planOptionsSchema.parse(rawOptions);
  const pool = allDishes.filter(
    (dish) =>
      dish.stall === options.stall &&
      dish.active &&
      dish.category !== "主食杂粮",
  );
  const slots = slotPrices(options.stall, options.count);
  const entries = [];
  let randomState = options.seed;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const usage = new Map();
  // Only the workflow's validated decisions affect selection. Raw feedback is
  // deliberately ignored: a complaint is not an approved operating instruction.
  const policyByDish = new Map(selectionPolicy.map((item) => [item.dishId, item]));
  for (let week = 0; week < 6; week++)
    for (let day = 0; day < 5; day++) {
      const date = new Date(`${options.start}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + week * 7 + day);
      const dateText = date.toISOString().slice(0, 10);
      for (const meal of options.meals) {
        const picked = [];
        for (const [slot, priceRule] of slots.entries()) {
          const candidates = pool
            .filter((dish) => {
              if (
                policyByDish.get(dish.id)?.kind === "exclude" ||
                !fitsPrice(dish, priceRule) ||
                picked.some((item) => canonical(item) === canonical(dish))
              )
                return false;
              if (
                strictStalls.includes(options.stall) &&
                entries.some(
                  (entry) =>
                    entry.nameKey === canonical(dish) &&
                    (entry.date === dateText ||
                      (entry.meal === meal &&
                        (date - new Date(`${entry.date}T00:00:00Z`)) /
                          86400000 <=
                          2)),
                )
              )
                return false;
              return true;
            })
            .map((dish) => {
              const policy = policyByDish.get(dish.id);
              const preference = policy?.kind === "prefer" ? -1 : policy?.kind === "avoid" ? 1 : 0;
              let score =
                (usage.get(canonical(dish)) || 0) * 5 +
                random() + preference * Math.min(3, Math.max(1, policy?.weight || 1)) * 40;
              if (
                ["饺好运", "南粉北面"].includes(options.stall) &&
                slot === 0 &&
                dish.vegetarian === "素食"
              )
                score -= 1000;
              if (priceRule === 4 && dish.spicy === "不辣") score -= 50;
              if (
                dish.mainIngredient &&
                picked.some(
                  (item) => item.mainIngredient === dish.mainIngredient,
                )
              )
                score += 20;
              return { dish, score };
            })
            .sort((left, right) => left.score - right.score);
          const dish = candidates[0]?.dish;
          if (dish) {
            picked.push(dish);
            usage.set(canonical(dish), (usage.get(canonical(dish)) || 0) + 1);
          }
          entries.push({
            date: dateText,
            week: week + 1,
            day: day + 1,
            meal,
            slot,
            dishId: dish?.id || "",
            nameKey: dish ? canonical(dish) : "",
            priceRule,
          });
        }
      }
    }
  const plan = { ...options, entries, createdAt: new Date().toISOString() };
  return { ...plan, validation: validatePlan(plan, allDishes) };
}

export function validatePlan(plan, allDishes, previous = null) {
  const byId = new Map(allDishes.map((dish) => [dish.id, dish]));
  const issues = [];
  const add = (level, code, text, date = "", meal = "") =>
    issues.push({ level, code, text, date, meal });
  if (!strictStalls.includes(plan.stall) && plan.stall !== "宽窄巷子")
    add(
      "warning",
      "MANUAL",
      "该档口缺少完整自动排菜规则，当前为通用草案，需人工确认。",
    );
  if (plan.stall === "五味坊")
    add(
      "warning",
      "RULE_CONFLICT",
      "五味坊与寻味列车是否共享菜品存在规则冲突，当前为独立草案。",
    );
  add(
    "warning",
    "CROSS_STALL",
    "当前为单档口草案，尚未通过同餐次跨档口重复检查。",
  );
  const groups = new Map();
  for (const entry of plan.entries) {
    const groupKey = `${entry.date}|${entry.meal}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }
  const seen = [];
  for (const entries of groups.values()) {
    const { date, meal } = entries[0];
    const dishes = entries
      .map((entry) => byId.get(entry.dishId))
      .filter(Boolean);
    if (dishes.length < entries.length)
      add("error", "MISSING", "候选菜不足，存在未排菜槽位。", date, meal);
    if (new Set(dishes.map(canonical)).size !== dishes.length)
      add("error", "DUPLICATE", "同餐次存在同名菜重复。", date, meal);
    for (const entry of entries) {
      const dish = byId.get(entry.dishId);
      if (!dish) continue;
      if (!dish.active || dish.stall !== plan.stall)
        add(
          "error",
          "POOL",
          `${dish.name} 已停用或不属于当前档口。`,
          date,
          meal,
        );
      if (!fitsPrice(dish, entry.priceRule))
        add(
          "error",
          "PRICE",
          `${dish.name} 不符合槽位价格要求 ${entry.priceRule}。`,
          date,
          meal,
        );
      if (
        strictStalls.includes(plan.stall) &&
        seen.some(
          (prior) =>
            prior.name === canonical(dish) &&
            (prior.date === date ||
              (prior.meal === meal &&
                (new Date(date) - new Date(prior.date)) / 86400000 <= 2)),
        )
      )
        add(
          "error",
          "REPEAT",
          `${dish.name} 在同日或近两天同餐次重复。`,
          date,
          meal,
        );
    }
    if (strictStalls.includes(plan.stall)) {
      if (
        dishes.some(
          (dish) =>
            dish.spicy === "未知" ||
            dish.vegetarian === "未知" ||
            !dish.mainIngredient ||
            !dish.method,
        )
      )
        add(
          "warning",
          "LABELS",
          "部分菜品辣度、素食性、主料或工艺待核验。",
          date,
          meal,
        );
      if (
        ["饺好运", "南粉北面"].includes(plan.stall) &&
        !dishes.some((dish) => dish.vegetarian === "素食")
      )
        add(
          dishes.some((dish) => dish.vegetarian === "未知")
            ? "warning"
            : "error",
          "VEGETARIAN",
          "未确认至少1道素食。",
          date,
          meal,
        );
      if (["寻味列车", "五味坊", "一锅烟火"].includes(plan.stall)) {
        const unknown = dishes.some((dish) => dish.spicy === "未知");
        if (
          dishes.filter((dish) => dish.spicy === "不辣").length <
          Math.ceil(entries.length * 0.6)
        )
          add(
            unknown ? "warning" : "error",
            "MILD",
            "不辣菜品未确认达到60%。",
            date,
            meal,
          );
        if (!dishes.some((dish) => dish.spicy === "辣"))
          add(
            unknown ? "warning" : "error",
            "SPICY",
            "未确认至少1道辣菜。",
            date,
            meal,
          );
        if (dishes.some((dish) => dish.price === 4 && dish.spicy === "辣"))
          add("error", "MILD_PRICE", "4元菜品不得为辣菜。", date, meal);
      }
      if (plan.stall === "寻味列车")
        for (const price of [8, 6]) {
          const group = dishes.filter((dish) => dish.price === price);
          if (
            !group.some((dish) => dish.spicy === "辣") ||
            !group.some((dish) => dish.spicy === "不辣")
          )
            add(
              group.some((dish) => dish.spicy === "未知") ? "warning" : "error",
              "GROUP_SPICE",
              `${price}元组需要同时有辣菜和不辣菜。`,
              date,
              meal,
            );
        }
      if (
        plan.stall === "一锅烟火" &&
        (dishes.filter((dish) => dish.method === "炖").length < 2 ||
          !dishes.some((dish) => dish.method === "炒"))
      )
        add(
          dishes.some((dish) => !dish.method) ? "warning" : "error",
          "METHOD",
          "需要至少2道炖菜和1道炒菜。",
          date,
          meal,
        );
      if (plan.stall === "蒸心食意") {
        if (
          dishes.filter((dish) => dish.spicy === "辣" && dish.price >= 10)
            .length > 1
        )
          add("error", "STEAM_SPICE", "荤菜辣菜超过1道。", date, meal);
        if (
          dishes.filter(
            (dish) => dish.vegetarian === "素食" && dish.method === "蒸",
          ).length !== 1
        )
          add(
            "warning",
            "STEAM_VEG",
            "需人工确认恰好1道蒸蔬菜及4道荤菜。",
            date,
            meal,
          );
      }
      const mainGroup = dishes.filter(
        (dish) =>
          plan.stall === "一锅烟火" ||
          (plan.stall === "蒸心食意" ? dish.price >= 10 : dish.price === 8),
      );
      const mains = mainGroup
        .map((dish) => dish.mainIngredient)
        .filter(Boolean);
      if (new Set(mains).size < mains.length)
        add("error", "MAIN", "同组主料重复。", date, meal);
    }
    for (const dish of dishes) seen.push({ name: canonical(dish), date, meal });
  }
  const priorEntries = previous?.stall === plan.stall ? previous.entries : null;
  const comparable =
    priorEntries &&
    priorEntries.length === plan.entries.length &&
    plan.entries.every(
      (entry, index) =>
        entry.week === priorEntries[index].week &&
        entry.day === priorEntries[index].day &&
        entry.meal === priorEntries[index].meal &&
        entry.slot === priorEntries[index].slot,
    );
  const changeRate = comparable
    ? Math.round(
        (plan.entries.filter(
          (entry, index) => entry.nameKey !== priorEntries[index].nameKey,
        ).length /
          plan.entries.length) *
          100,
      )
    : null;
  return {
    issues,
    errors: issues.filter((issue) => issue.level === "error").length,
    warnings: issues.filter((issue) => issue.level === "warning").length,
    changeRate,
    labelCoverage: Math.round(
      (plan.entries.filter((entry) => {
        const dish = byId.get(entry.dishId);
        return (
          dish &&
          dish.spicy !== "未知" &&
          dish.vegetarian !== "未知" &&
          dish.mainIngredient &&
          dish.method
        );
      }).length /
        plan.entries.length) *
        100,
    ),
  };
}

export function parseCsv(text) {
  const result = Papa.parse(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  if (result.errors.length)
    throw new Error(`CSV格式错误：${result.errors[0].message}`);
  if (!result.data.length || result.data.length > 10000)
    throw new Error("CSV需包含1至10000行");
  return result.data;
}

const decimal = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().finite(),
);
export const transactionSchema = z
  .object({
    transactionId: z.string().trim().min(1).max(100),
    lineId: z.string().trim().min(1).max(100),
    time: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
      .refine(
        (text) =>
          dateSchema.safeParse(text.slice(0, 10)).success &&
          Number(text.slice(11, 13)) < 24 &&
          Number(text.slice(14, 16)) < 60 &&
          (text.length === 16 || Number(text.slice(17, 19)) < 60),
        "时间无效，使用北京时间",
      ),
    stall: z.string().trim().min(1).max(100),
    dishId: z.string().trim().max(100).default(""),
    dishName: z.string().trim().max(200).default(""),
    quantity: decimal,
    amount: decimal.refine(
      (number) => Math.abs(number * 100 - Math.round(number * 100)) < 0.000001,
      "金额最多两位小数",
    ),
    status: z.enum(["sale", "refund", "void"]),
    unit: z.enum(["份", "个", "斤", "100g"]).default("份"),
  })
  .refine(
    (item) =>
      Math.abs(item.amount) <= 1000000 && Math.abs(item.quantity) <= 100000,
    "交易值过大",
  )
  .refine(
    (item) =>
      item.status === "void" ||
      (item.status === "sale"
        ? item.amount >= 0 && item.quantity > 0
        : item.amount <= 0 && item.quantity < 0),
    "销售数量为正，退款数量及金额为负",
  );

export function aggregateTransactions(
  transactions,
  { start = "", end = "", stall = "" } = {},
) {
  const selected = transactions.filter(
    (item) =>
      item.status !== "void" &&
      (!start || item.time.slice(0, 10) >= start) &&
      (!end || item.time.slice(0, 10) <= end) &&
      (!stall || item.stall === stall),
  );
  const totalCents = selected.reduce(
    (total, item) => total + Math.round(item.amount * 100),
    0,
  );
  const sales = new Set(
    selected
      .filter((item) => item.status === "sale")
      .map((item) => item.transactionId),
  );
  const byDay = new Map();
  const byDish = new Map();
  const byStall = new Map();
  for (const item of selected) {
    const date = item.time.slice(0, 10);
    byDay.set(date, (byDay.get(date) || 0) + Math.round(item.amount * 100));
    byStall.set(
      item.stall,
      (byStall.get(item.stall) || 0) + Math.round(item.amount * 100),
    );
    if (item.dishId) {
      const id = `${item.dishId}|${item.unit}`;
      const group = byDish.get(id) || {
        id,
        name: item.dishName,
        stall: item.stall,
        unit: item.unit,
        quantity: 0,
        cents: 0,
      };
      group.quantity += item.quantity;
      group.cents += Math.round(item.amount * 100);
      byDish.set(id, group);
    }
  }
  return {
    revenue: totalCents / 100,
    sales: sales.size,
    average: sales.size ? totalCents / 100 / sales.size : 0,
    rows: selected.length,
    unmapped: selected.filter((item) => !item.dishId).length,
    coverage: selected.length
      ? Math.round(
          (selected.filter((item) => item.dishId).length / selected.length) *
            100,
        )
      : 0,
    trend: [...byDay]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, cents]) => ({ date, revenue: cents / 100 })),
    stalls: [...byStall]
      .map(([name, cents]) => ({ name, revenue: cents / 100 }))
      .sort((left, right) => right.revenue - left.revenue),
    ranking: [...byDish.values()]
      .map(({ cents, ...item }) => ({ ...item, revenue: cents / 100 }))
      .sort((left, right) => right.quantity - left.quantity),
  };
}

export function demoTransactions(dishes) {
  return Array.from({ length: 180 }, (_, index) => {
    const dish = dishes.filter((item) => item.unit === "份" && item.price > 0)[
      (index * 7) % 100
    ];
    return {
      transactionId: `DEMO-${index}`,
      lineId: "1",
      time: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:30`,
      dishId: dish.id,
      dishName: dish.name,
      stall: dish.stall,
      unit: dish.unit,
      quantity: (index % 4) + 1,
      amount: dish.price * ((index % 4) + 1),
      status: "sale",
    };
  });
}
