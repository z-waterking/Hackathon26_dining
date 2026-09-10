import test from "node:test";
import assert from "node:assert/strict";
import { scoreMenu } from "../server/menu-scoring.mjs";

const inspector = { verdict: "pass", summary: "完成独立检验", findings: [] };
function fixture() {
  const plan = { scope: "all", stall: "全部档口", stalls: ["档口甲", "档口乙"], start: "2026-09-07", count: 2, meals: ["午餐"], entries: [] };
  for (const stall of plan.stalls) for (let week = 1; week <= 6; week++) for (let day = 1; day <= 5; day++) for (let slot = 0; slot < plan.count; slot++) {
    const date = new Date(`${plan.start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
    plan.entries.push({ stall, week, day, slot, meal: "午餐", date: date.toISOString().slice(0, 10), priceRule: "*", dishId: `${stall}-${week}-${day}-${slot}` });
  }
  plan.validation = { issues: [], errors: 0, warnings: 0, labelCoverage: 100 };
  return plan;
}
function issue(plan, code, level = "error", entry = plan.entries[0], text = `${code} 实际检查问题`) {
  plan.validation.issues.push({ code, level, text, stall: entry.stall, date: entry.date, meal: entry.meal });
  plan.validation[level === "error" ? "errors" : "warnings"]++;
}
const score = (plan, options = {}) => scoreMenu(plan, { inspector, ...options });
const dimension = (result, key) => result.dimensions.find(item => item.key === key);

test("complete inspected ideal menu reaches 100 with transparent 100-point dimensions", () => {
  const result = score(fixture());
  assert.equal(result.value, 100);
  assert.equal(result.target, 80);
  assert.equal(result.targetMet, true);
  assert.equal(result.version, "menu-score-v1");
  assert.equal(result.blockers, 0);
  assert.equal(result.dimensions.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(result.dimensions.map(item => item.weight), [30, 25, 20, 15, 10]);
  assert.match(dimension(result, "actions").detail, /N[/]A.*不是行动执行成果/);
  assert.match(result.summary, /仍需人工批准/);
});

test("empty manual slots reduce supply score without treating them as omitted weeks", () => {
  const plan = fixture();
  for (const entry of plan.entries.filter(entry => entry.stall === "档口乙")) entry.dishId = "";
  for (const entry of plan.entries.filter(entry => entry.stall === "档口乙" && entry.slot === 0)) issue(plan, "MISSING", "error", entry);
  plan.validation.labelCoverage = 50;
  issue(plan, "MANUAL_REQUIRED", "warning", { stall: "档口乙", date: "", meal: "" });
  const result = score(plan);
  assert.equal(dimension(result, "completeness").earned, 15);
  assert.equal(result.value, 80);
  assert.equal(result.blockers, 30);
  assert.equal(result.targetMet, true);
  assert.match(result.summary, /不能因达标而发布/);
  assert.match(dimension(result, "completeness").detail, /60[/]120.*人工待补/);
});

test("an entirely empty six-week shell cannot receive a high supply score", () => {
  const plan = fixture();
  for (const entry of plan.entries) entry.dishId = "";
  for (const entry of plan.entries.filter(entry => entry.slot === 0)) issue(plan, "MISSING", "error", entry);
  plan.validation.labelCoverage = 0;
  const result = score(plan);
  assert.equal(dimension(result, "completeness").earned, 0);
  assert.ok(result.value < 80);
  assert.equal(result.targetMet, false);
});

test("validator missing references with nonempty IDs are not counted as supplied", () => {
  const plan = fixture();
  issue(plan, "MISSING");
  assert.equal(dimension(score(plan), "completeness").earned, 29);
});

test("even an unlocated missing-slot error incurs a real penalty", () => {
  const plan = fixture();
  issue(plan, "MISSING", "error", { stall: "未匹配的档口", date: "", meal: "" });
  const result = score(plan);
  assert.equal(dimension(result, "completeness").earned, 29);
  assert.equal(result.blockers, 1);
});

test("repeated issue messages in one service group do not multiply the penalty", () => {
  const plan = fixture();
  issue(plan, "REPEAT");
  const once = score(plan);
  for (let index = 0; index < 1000; index++) issue(plan, "REPEAT");
  const repeated = score(plan);
  assert.equal(repeated.value, once.value);
  assert.equal(dimension(repeated, "rotation").earned, 18);
  assert.equal(repeated.blockers, 1001);
});

test("widespread repetition loses more points than one local conflict", () => {
  const plan = fixture();
  issue(plan, "DUPLICATE");
  const isolated = score(plan);
  for (const entry of plan.entries.filter(entry => entry.slot === 0)) issue(plan, "REPEAT", "error", entry);
  const widespread = score(plan);
  assert.ok(widespread.value < isolated.value);
  assert.equal(dimension(widespread, "rotation").earned, 0);
});

test("unknown labels are not hard violations and uncertainty costs at most ten points", () => {
  const plan = fixture();
  plan.validation.labelCoverage = 0;
  for (const entry of plan.entries.filter(entry => entry.slot === 0)) for (const code of ["LABELS", "MILD", "SPICY", "METHOD", "GROUP_SPICE"]) issue(plan, code, "warning", entry);
  const result = score(plan);
  assert.equal(result.value, 90);
  assert.equal(result.blockers, 0);
  assert.equal(dimension(result, "rules").earned, 25);
  assert.equal(dimension(result, "verifiability").earned, 0);
  assert.equal(result.unknownCount, 300);
  issue(plan, "LABELS", "warning");
  assert.equal(score(plan).unknownCount, 300);
});

test("known nutritional hard failures lose rule points, unlike unknown warnings", () => {
  const warning = fixture();
  issue(warning, "MILD", "warning");
  const failure = fixture();
  issue(failure, "MILD", "error");
  assert.equal(dimension(score(warning), "rules").earned, 25);
  assert.ok(dimension(score(failure), "rules").earned < 25);
  assert.equal(score(failure).blockers, 1);
});

test("approved action execution scores applied, partial and not applied separately", () => {
  const plan = fixture();
  assert.equal(dimension(score(plan, { actionImpacts: [{ actionId: "A1", status: "applied" }] }), "actions").earned, 15);
  assert.equal(dimension(score(plan, { actionImpacts: [{ actionId: "A1", status: "partial" }] }), "actions").earned, 7.5);
  assert.equal(dimension(score(plan, { actionImpacts: [{ actionId: "A1", status: "not_applied" }] }), "actions").earned, 0);
  const mixed = score(plan, { actionImpacts: [{ actionId: "A1", status: "applied" }, { actionId: "A2", status: "partial" }, { actionId: "A3", status: "not_applied" }] });
  assert.equal(dimension(mixed, "actions").earned, 7.5);
  assert.match(dimension(mixed, "actions").detail, /已落实 1，部分落实 1，未落实 1/);
});

test("duplicate and unrecognized action statuses cannot inflate execution", () => {
  const plan = fixture();
  const duplicate = score(plan, { actionImpacts: [{ actionId: "A1", status: "not_applied" }, { actionId: "A1", status: "applied" }] });
  assert.equal(dimension(duplicate, "actions").earned, 0);
  assert.equal(dimension(score(plan, { actionImpacts: [{ actionId: "A1", status: "invented" }] }), "actions").earned, 0);
  assert.equal(dimension(score(plan, { actionImpacts: [{ actionId: "A1", status: "toString" }] }), "actions").earned, 0);
});

test("fixed-source and wrong-pool errors have a real non-dilutable penalty", () => {
  for (const code of ["FIXED_SOURCE", "POOL", "SHARED_MENU", "MANUAL_SOURCE_REQUIRED", "POLICY_EXCLUDED"]) {
    const plan = fixture();
    issue(plan, code);
    const result = score(plan);
    assert.equal(dimension(result, "rules").earned, 15, code);
    assert.equal(result.blockers, 1);
    assert.match(result.summary, /不能因达标而发布/);
  }
});

test("price and newly introduced hard-rule codes are never zero-penalty", () => {
  for (const code of ["PRICE", "NEW_HARD_RULE"]) {
    const plan = fixture();
    issue(plan, code);
    assert.equal(dimension(score(plan), "rules").earned, 20);
  }
});

test("inspector errors add bounded risk without multiplying mirrored local errors", () => {
  const plan = fixture();
  issue(plan, "FIXED_SOURCE");
  const mirrored = score(plan, { inspector: { verdict: "revise", findings: [{ severity: "error", text: "FIXED_SOURCE 实际检查问题" }] } });
  assert.equal(mirrored.value, score(plan).value);
  assert.equal(mirrored.blockers, 2);
  const independent = score(fixture(), { inspector: { verdict: "revise", findings: Array.from({ length: 60 }, (_, i) => ({ severity: "error", text: `独立检验错误 ${i}` })) } });
  assert.equal(dimension(independent, "rules").earned, 20);
  assert.equal(independent.blockers, 60);
});

test("partial or structurally invalid plans are not awarded an effective score", () => {
  const mutations = [
    plan => { plan.entries = plan.entries.filter(entry => entry.week === 1); },
    plan => { plan.entries.pop(); },
    plan => { plan.entries[1] = { ...plan.entries[0] }; },
    plan => { plan.entries[0].date = "2026-09-08"; },
    plan => { plan.entries[0].week = 7; },
    plan => { plan.entries[0].priceRule = "not validated"; },
    plan => { plan.partial = true; },
  ];
  for (const mutate of mutations) {
    const plan = fixture();
    mutate(plan);
    const result = score(plan);
    assert.equal(result.value, null);
    assert.equal(result.targetMet, false);
    assert.ok(result.dimensions.every(item => item.earned === null));
  }
});

test("missing, stale and malformed inspections invalidate scoring", () => {
  assert.equal(score(fixture(), { stale: true }).value, null);
  assert.equal(scoreMenu(fixture()).value, null);
  assert.equal(score(fixture(), { inspector: { verdict: "pass" } }).value, null);
  assert.equal(score(fixture(), { inspector: { verdict: "pass", findings: [{ severity: "error" }] } }).value, null);
  for (const mutate of [plan => { delete plan.validation; }, plan => { plan.validation.errors = 42; }, plan => { delete plan.validation.labelCoverage; }]) {
    const plan = fixture();
    mutate(plan);
    assert.equal(score(plan).value, null);
  }
});

test("client score and workflow assertions are ignored, inputs are not mutated", () => {
  const plan = fixture();
  issue(plan, "FIXED_SOURCE");
  const expected = score(plan);
  plan.score = { value: 100, targetMet: true, blockers: 0 };
  plan.workflow = { score: plan.score, inspector: { verdict: "pass", findings: [] }, actionImpacts: [{ actionId: "A1", status: "applied" }] };
  const before = structuredClone(plan);
  assert.deepEqual(score(plan), expected);
  assert.deepEqual(plan, before);
  assert.equal(scoreMenu(plan).value, null, "client inspector is not an effective review");
});
