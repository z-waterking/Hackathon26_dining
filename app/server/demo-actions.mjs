import { createHash } from "node:crypto";
import { slotPrices } from "./domain.mjs";

const manifestId = "demo-actions-v1";
const groupIds = ["prefer", "avoid", "exclude", "service"];

// Approving/disabling a sample does not change its meaning. Editing its target,
// instruction, priority or local mapping does, and must invalidate the mapping.
export function demoPolicyFingerprint(action) {
  return createHash("sha256").update(JSON.stringify({
    targetStall: action.targetStall, menuInstruction: action.menuInstruction,
    priority: action.priority, demoPolicy: action.demoPolicy,
  })).digest("hex");
}

function fitsAnySlot(dish) {
  return slotPrices(dish.stall, 4).some((slot) => {
    if (slot === "*") return true;
    if (dish.unit !== "份") return false;
    if (slot === ">=30") return dish.price >= 30;
    if (slot === "10-25") return dish.price >= 10 && dish.price <= 25;
    if (slot === "<10") return dish.price < 10;
    return dish.price === slot;
  });
}

function chooseDishes(store) {
  const pools = new Map();
  for (const dish of store.all("dishes")) {
    if (!dish.active || dish.category === "主食杂粮" || !dish.name || !fitsAnySlot(dish)) continue;
    if (!pools.has(dish.stall)) pools.set(dish.stall, []);
    if (!pools.get(dish.stall).some((prior) => prior.name === dish.name)) pools.get(dish.stall).push(dish);
  }
  const ranked = [...pools.values()].sort((a, b) => b.length - a.length);
  const dishes = ranked.flatMap((pool) => [...pool].sort((a, b) => a.id.localeCompare(b.id))).slice(0, 3);
  if (dishes.length < 3) throw new Error("至少需要 3 道可排菜的启用菜品，才能创建聚合行动演示数据");
  return dishes;
}

function buildManifest(store) {
  const [preferred, avoided, excluded] = chooseDishes(store);
  const at = new Date().toISOString();
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const groups = [
    {
      key: "prefer", dish: preferred, priority: "medium",
      title: `[演示] 增加${preferred.name}的轮换机会`,
      description: `聚合 3 条示例反馈，对${preferred.stall}的${preferred.name}增加选用优先级，在价格和轮换规则允许时增加出现次数。以下反馈均为模拟内容，不是实际顾客意见。`,
      instruction: `在${preferred.stall}提高${preferred.name}的选用优先级，在本地价格和轮换规则允许时增加出现次数。`,
      contents: [
        `希望${preferred.stall}的${preferred.name}能多安排几次，方便午餐选择。`,
        `建议下一轮菜单增加${preferred.name}的轮换机会。`,
        `愿意再选${preferred.name}，希望六周菜单里能更常见到。`,
      ],
    },
    {
      key: "avoid", dish: avoided, priority: "medium",
      title: `[演示] 降低${avoided.name}的出现频次`,
      description: `聚合 3 条示例反馈，降低${avoided.stall}的${avoided.name}选用优先级，给其他菜品更多轮换机会。此为模拟需求，不代表该菜品实际质量有问题。`,
      instruction: `在${avoided.stall}降低${avoided.name}的选用优先级，减少六周菜单中的出现次数，但不强制禁用。`,
      contents: [
        `希望${avoided.stall}下一轮少安排一些${avoided.name}，给其他菜留出位置。`,
        `建议减少${avoided.name}的出现次数，让菜单选择更丰富。`,
        `想在六周菜单里看到更多轮换，${avoided.name}可以适当少排。`,
      ],
    },
    {
      key: "exclude", dish: excluded, priority: "high",
      title: `[演示] 暂停${excluded.name}等待运营复核`,
      description: `聚合 3 条示例反馈，本次演示在${excluded.stall}临时停止选择${excluded.name}，用于测试批准行动能否影响菜单。此为模拟需求，没有真实停售结论。`,
      instruction: `本轮六周菜单暂停在${excluded.stall}选择${excluded.name}，等待运营复核后再恢复。`,
      contents: [
        `建议${excluded.stall}本轮暂不安排${excluded.name}，先由运营复核出品方案。`,
        `希望下轮排菜暂缓选择${excluded.name}，等运营确认后再恢复。`,
        `关于${excluded.name}，建议先做出品复核，本轮菜单暂时跳过。`,
      ],
    },
    {
      key: "service", priority: "medium",
      title: "[演示] 优化午高峰排队与取餐引导",
      description: "聚合 3 条示例服务反馈，检查午高峰队列和取餐标识，安排一次现场观察后再提出调整方案；不改变菜品选择。以下均为模拟内容。",
      instruction: "",
      contents: [
        "午高峰希望增加排队方向的指示，减少来回确认的时间。",
        "建议把点餐和取餐的提示标识分开，让第一次来的人容易理解。",
        "希望运营观察一下午间队列，适当调整取餐引导。",
      ],
    },
  ];
  const feedback = [];
  const actions = groups.map((group) => {
    const feedbackIds = group.contents.map((_, index) => `F-demo-${group.key}-${index + 1}`);
    const items = group.contents.map((content, index) => ({
      id: feedbackIds[index], content: `[演示数据，非真实反馈] ${content}`,
      restaurant: group.dish?.stall || "全部档口", date, channel: "手工",
      type: "建议", category: group.key === "service" ? "服务流程" : "菜单轮换",
      status: "未处理", owner: "", reply: "", replies: [], threadId: "", originalId: "",
      summaryRecord: false, duplicatePossible: false, demo: true, source: "demo",
      sources: [{ file: "内置演示数据（非真实反馈）", sheet: "聚合行动演示", row: feedback.length + index + 1 }],
      createdAt: at, updatedAt: at, events: [{ at, kind: "创建演示反馈", text: "仅供测试聚合行动，不计作真实顾客反馈。" }],
      aiAnalysis: { summary: "示例反馈，用于测试多反馈聚合行动与回复流程，未调用 AI。", replyDraft: "感谢您的建议，已记录并提交运营进一步评估。（示例回复草稿，未发送）", keywords: [], demo: true, createdAt: at, model: "local-demo" },
    }));
    feedback.push(...items);
    const action = {
      id: `A-demo-aggregate-${group.key}`, feedbackIds,
      kind: group.key === "service" ? "service" : "menu",
      evidence: items.map((item) => ({ feedbackId: item.id, quote: item.content })),
      title: group.title, description: group.description, targetStall: group.dish?.stall || "全部档口",
      menuInstruction: group.instruction, priority: group.priority,
      status: "pending", enabled: true, revision: 1, demo: true, source: "demo",
      demoPolicy: group.dish ? [{ dishId: group.dish.id, kind: group.key, weight: 3 }] : [],
      createdAt: at, updatedAt: at, approvedAt: null,
      history: [{ at, kind: "创建聚合行动演示", status: "pending", revision: 1, reason: "3 条示例反馈聚合，等待运营手动批准。" }],
    };
    return { ...action, demoPolicyFingerprint: demoPolicyFingerprint(action) };
  });
  return { id: manifestId, version: 1, createdAt: at, feedback, actions };
}

/** Idempotent sample seed. Previously approved or edited rows are never reset. */
export function ensureDemoActions(store) {
  const prior = store.get("meta", manifestId);
  const manifest = prior || buildManifest(store);
  for (const [table, rows] of [["feedback", manifest.feedback], ["actions", manifest.actions]]) {
    for (const row of rows) {
      const existing = store.get(table, row.id);
      if (existing && existing.demo !== true) throw new Error("演示数据 ID 与现有非演示记录冲突，未覆盖任何数据");
    }
  }
  let createdFeedback = 0;
  let createdActions = 0;
  store.atomic(() => {
    if (!prior) store.put("meta", manifestId, manifest);
    for (const item of manifest.feedback) {
      if (store.get("feedback", item.id)) continue;
      store.put("feedback", item.id, item);
      createdFeedback++;
    }
    for (const item of manifest.actions) {
      if (store.get("actions", item.id)) continue;
      store.put("actions", item.id, item);
      createdActions++;
    }
  });
  const actionIds = groupIds.map((key) => `A-demo-aggregate-${key}`);
  const feedbackIds = manifest.feedback.map((item) => item.id);
  return {
    demo: true, createdFeedback, createdActions, actionIds, feedbackIds,
    actions: actionIds.map((id) => store.get("actions", id)),
    feedback: feedbackIds.map((id) => store.get("feedback", id)),
  };
}
