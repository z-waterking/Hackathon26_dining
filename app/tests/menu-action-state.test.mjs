import test from "node:test";
import assert from "node:assert/strict";
import { isApprovedMenuAction, menuActionState } from "../shared/menu-action-state.mjs";
import { approvedMenuActions } from "../server/menu-workflow.mjs";

const action = (id, values = {}) => ({ id, title: id, kind: "menu", status: "approved", enabled: true,
  feedbackIds: ["F1"], targetStall: "寻味列车", menuInstruction: "在规则允许时增加不辣菜", revision: 1, ...values });

test("approved service is separate from pending menu requirements, including empty states", () => {
  const service = action("洗消抽检", { kind: "service", menuInstruction: "" });
  const pending = action("不辣菜", { status: "pending" });
  const state = menuActionState([service, pending]);
  assert.equal(state.approvedCount, 1);
  assert.equal(state.eligible.length, 0);
  assert.equal(state.pendingCount, 1);
  assert.deepEqual(state.serviceApproved, [service]);
  assert.deepEqual(state.menuItems.map(item => [item.action.id, item.statusLabel]), [["不辣菜", "待审批"]]);
  assert.match(state.menuItems[0].reason, /尚未批准/);
  assert.deepEqual(menuActionState(), { eligible: [], menuItems: [], approvedCount: 0, pendingCount: 0, serviceApproved: [] });
});

test("all exclusion reasons are explicit; demo and missing feedback never become eligible", () => {
  const records = [action("启用"), action("演示", { demo: true }), action("停用", { enabled: false }),
    action("拒绝", { status: "rejected" }), action("无指令", { menuInstruction: "  " }),
    action("无来源", { feedbackIds: [] }), action("未启用", { enabled: undefined }),
    action("旧类别", { kind: "service" })];
  const original = structuredClone(records);
  const state = menuActionState(records);
  assert.deepEqual(state.eligible.map(item => item.id), ["启用", "旧类别"]);
  assert.equal(state.menuItems.some(item => item.action.demo), false);
  const reason = id => state.menuItems.find(item => item.action.id === id).reason;
  assert.match(reason("停用"), /未启用/);
  assert.match(reason("拒绝"), /已拒绝/);
  assert.match(reason("无指令"), /尚未填写排菜要求/);
  assert.match(reason("无来源"), /缺少反馈关联/);
  assert.match(reason("未启用"), /未启用/);
  assert.deepEqual(records, original);
});

test("panel eligibility and server generation use one predicate without changing demo compatibility", () => {
  const records = [action("B"), action("A"), action("D", { demo: true }), action("P", { status: "pending" }),
    action("S", { kind: "service", menuInstruction: "" }), action("M", { feedbackIds: [] })];
  const store = { all: () => records };
  assert.deepEqual(approvedMenuActions(store).map(item => item.id), menuActionState(records).eligible.map(item => item.id).sort());
  assert.deepEqual(approvedMenuActions(store, { demo: true }).map(item => item.id), ["D"]);
  assert.equal(isApprovedMenuAction(records[2]), false);
  assert.equal(isApprovedMenuAction(records[2], { demo: true }), true);
});

test("approval reload recomputes eligibility without mutating the old action snapshot", () => {
  const pending = action("不辣菜", { status: "pending" });
  const old = menuActionState([pending]);
  const approved = { ...pending, status: "approved", revision: 2 };
  const current = menuActionState([approved]);
  assert.equal(old.eligible.length, 0);
  assert.equal(current.eligible.length, 1);
  assert.equal(current.pendingCount, 0);
  assert.equal(pending.status, "pending");
  assert.equal(menuActionState([{ ...approved, enabled: false }]).eligible.length, 0);
});
