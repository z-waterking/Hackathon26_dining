import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "./settings.mjs";
import { isValidEnglishName } from "../shared/catalog-english-state.mjs";

const MANUAL_LABEL_SOURCE = "手工录入，待核验";
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const identityFields = ["name", "stall", "price", "unit"];
const labelFields = ["spicy", "vegetarian", "mainIngredient", "method", "calories", "allergens"];
const fields = {
  name: z.string().trim().min(1).max(150),
  stall: z.string().trim().min(1).max(100),
  english: z.string().trim().max(200),
  price: z.number().finite().min(0).max(10000),
  unit: z.string().trim().min(1).max(20),
  category: z.string().trim().max(100),
  spicy: z.enum(["未知", "辣", "不辣"]),
  vegetarian: z.enum(["未知", "素食", "非素食"]),
  mainIngredient: z.string().trim().max(100),
  method: z.string().trim().max(50),
  active: z.boolean(),
  calories: z.number().finite().min(0).max(900).nullable(),
  allergens: z.string().trim().max(500),
  labelSource: z.string().trim().min(2).max(500),
};
const createSchema = z.object({ ...fields, english: fields.english.default(""), category: fields.category.default(""),
  spicy: fields.spicy.default("未知"), vegetarian: fields.vegetarian.default("未知"),
  mainIngredient: fields.mainIngredient.default(""), method: fields.method.default(""),
  active: fields.active.default(true), calories: fields.calories.default(null), allergens: fields.allergens.default(""),
  labelSource: fields.labelSource.default(MANUAL_LABEL_SOURCE),
}).strict();
const updateSchema = z.object({ ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])), expectedRevision: revision.optional() }).strict();
const archiveSchema = z.object({ expectedRevision: revision.optional() }).strict();
const names = { name: "菜品名称", stall: "档口", english: "英文名称", price: "价格", unit: "计价单位", category: "菜品分类",
  spicy: "辣度", vegetarian: "素食标签", mainIngredient: "主料", method: "烹饪方式", active: "启用状态",
  calories: "热量", allergens: "过敏原", labelSource: "标签核验依据", expectedRevision: "数据版本" };
const conflict = (code, message) => Object.assign(new Error(message), { statusCode: 409, code });
const own = (value, field) => Object.prototype.hasOwnProperty.call(value, field);
const normalized = value => String(value || "").replace(/\s/g, "");

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const message = first.code === "unrecognized_keys" ? "请求包含不可修改的字段，请刷新页面后重试"
    : names[first.path[0]] ? `${names[first.path[0]]}格式或取值范围无效，请检查后重试` : "菜品请求格式无效，请检查后重试";
  throw Object.assign(new Error(message), { statusCode: 400, code: "CATALOG_INVALID_INPUT" });
}

function assertAvailable(store) {
  if (store.all("menuRuns").some(run => run.status === "running"))
    throw conflict("CATALOG_GENERATION_RUNNING", "菜单正在生成或检验，暂不能修改菜库；请等待完成或先取消当前生成");
}

function currentDish(store, id) {
  if (typeof id !== "string" || !id.trim()) throw new Error("菜品不存在，请刷新列表后重试");
  const dish = store.get("dishes", id);
  if (!dish) throw Object.assign(new Error("菜品不存在，请刷新列表后重试"), { code: "CATALOG_NOT_FOUND" });
  return dish;
}

function currentRevision(dish) {
  const value = dish.revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw conflict("CATALOG_REVISION_INVALID", "菜品数据版本无效，请联系管理员检查记录");
  return value;
}

function checkRevision(dish, expected) {
  const actual = currentRevision(dish);
  if (expected !== undefined && expected !== actual)
    throw conflict("CATALOG_REVISION_CONFLICT", "菜品已被其他操作修改，请刷新后再保存");
  return actual;
}

function assertStall(store, stall) {
  const mapped = store.get("meta", "preprocessed-stall-catalog")?.groups || [];
  const allowed = new Set([...store.all("dishes").map(dish => dish.stall), ...mapped.map(group => group.stall)].filter(Boolean));
  if (!allowed.has(stall)) throw new Error("请选择现有菜库或已映射的档口，不能创建未知档口");
}

function assertUnique(store, dish) {
  if (store.all("dishes").some(other => !other.deletedAt && other.id !== dish.id &&
    normalized(other.name) === normalized(dish.name) && normalized(other.stall) === normalized(dish.stall) &&
    other.price === dish.price && normalized(other.unit) === normalized(dish.unit)))
    throw conflict("CATALOG_DUPLICATE", "同档口已存在同名、同价、同单位的菜品，请直接调整已有记录");
}

function hasKnownLabels(dish) {
  return ["辣", "不辣"].includes(dish.spicy) || ["素食", "非素食"].includes(dish.vegetarian) ||
    [dish.mainIngredient, dish.method, dish.allergens].some(value => typeof value === "string" && value.trim()) || dish.calories !== null && dish.calories !== undefined;
}

function verifiedEvidence(value) {
  return typeof value === "string" && value.trim().length >= 2 && !/(?:待核验|待确认|未核验|未确认|未知|未验证|未核实|待核实|待验证|pending|unknown|unverified)/i.test(value);
}

function assertLabelEvidence(input, previous, identityChanged = false) {
  const changedLabels = Object.fromEntries(labelFields.filter(field => own(input, field) && (!previous || input[field] !== previous[field])).map(field => [field, input[field]]));
  if (hasKnownLabels(changedLabels) && !verifiedEvidence(input.labelSource))
    throw new Error("填写已知菜品标签时，请同时提供真实的标签核验依据；尚未核验的标签请保留未知");
  if (identityChanged && hasKnownLabels({ ...previous, ...input }) && !verifiedEvidence(input.labelSource))
    throw new Error("菜品名称、档口、价格或单位已调整，请重新确认标签核验依据，或将未核验的标签设为未知");
}

function projectVerification(dish, changes, at, { created = false, identityChanged = false } = {}) {
  const labelsTouched = labelFields.some(field => own(changes, field));
  if (created || identityChanged || labelsTouched || own(changes, "labelSource")) {
    // An identity-only edit must never renew an old verification timestamp.
    // Explicit evidence is required when asserting any known label values.
    delete dish.verifiedAt;
    if ((created || own(changes, "labelSource")) && verifiedEvidence(changes.labelSource) && hasKnownLabels(dish)) dish.verifiedAt = at;
  }
}

const manualEnglishName = (dish, at) => ({ sourceName: dish.name.trim(), origin: "manual",
  status: !dish.english ? "missing" : isValidEnglishName(dish.english) ? "ready" : "needs_review", updatedAt: at });

function projectEnglishName(dish, input, previous, changedFields, at) {
  const nameChanged = changedFields.includes("name");
  const englishChanged = changedFields.includes("english");
  if (!nameChanged && !englishChanged) return;
  if (nameChanged) {
    // English describes the current name, not the immutable recipe/sourceName
    // provenance. Never pair a new Chinese name with an unchanged old label.
    if (typeof previous.english === "string" && previous.english.trim()) {
      const history = Array.isArray(previous.englishHistory) ? previous.englishHistory : [];
      dish.englishHistory = [...history, { sourceName: previous.name, english: previous.english,
        origin: previous.englishName?.origin || "source", changedAt: at }].slice(-20);
    }
    if (!own(input, "english") || !englishChanged) dish.english = "";
  }
  dish.englishName = manualEnglishName(dish, at);
}

export function createDish(store, rawInput) {
  const input = parse(createSchema, rawInput);
  return store.atomic(() => {
    assertAvailable(store);
    assertStall(store, input.stall);
    assertLabelEvidence(input);
    const at = new Date().toISOString();
    const dish = { ...input, id: `D-${randomUUID()}`, origin: "manual", sources: [], revision: 1,
      priceText: `${input.price}/${input.unit}`, createdAt: at, updatedAt: at };
    dish.englishName = manualEnglishName(dish, at);
    assertUnique(store, dish);
    projectVerification(dish, input, at, { created: true });
    store.put("dishes", dish.id, dish);
    audit(store, "dish.created", dish.id, { revision: dish.revision, fields: Object.keys(input) });
    return dish;
  });
}

export function updateDish(store, id, rawInput) {
  const { expectedRevision, ...input } = parse(updateSchema, rawInput);
  if (!Object.keys(input).length) throw new Error("请至少修改一项菜品资料");
  return store.atomic(() => {
    assertAvailable(store);
    const previous = currentDish(store, id);
    if (previous.deletedAt) throw conflict("CATALOG_ARCHIVED", "菜品已删除，请先恢复后再调整");
    const beforeRevision = checkRevision(previous, expectedRevision);
    if (input.stall !== undefined) assertStall(store, input.stall);
    const changedFields = Object.keys(input).filter(field => input[field] !== previous[field]);
    const identityChanged = identityFields.some(field => changedFields.includes(field));
    assertLabelEvidence(input, previous, identityChanged);
    const confirmsUnverifiedLabels = !previous.verifiedAt && verifiedEvidence(input.labelSource) && hasKnownLabels({ ...previous, ...input });
    if (!changedFields.length && !confirmsUnverifiedLabels) return previous;
    const at = new Date().toISOString();
    const dish = { ...previous, ...input, revision: beforeRevision + 1, updatedAt: at };
    if (identityChanged || changedFields.includes("category")) dish.catalogManualOverride = true;
    if (identityChanged) {
      if (!own(previous, "sourceName")) dish.sourceName = previous.name;
      if (!own(previous, "sourceIdentity")) dish.sourceIdentity = Object.fromEntries([...identityFields, "priceText"].filter(field => own(previous, field)).map(field => [field, previous[field]]));
    }
    if (changedFields.includes("price") || changedFields.includes("unit")) dish.priceText = `${dish.price}/${dish.unit}`;
    // Imported historical duplicates must not block label maintenance. Only
    // an operator changing the identity can introduce a new identity conflict.
    if (identityChanged) assertUnique(store, dish);
    projectEnglishName(dish, input, previous, changedFields, at);
    // A full edit form resubmits unchanged labels. English-only maintenance
    // must not approve labels or renew an existing kitchen verification.
    if (!(changedFields.length === 1 && changedFields[0] === "english"))
      projectVerification(dish, input, at, { identityChanged });
    store.put("dishes", id, dish);
    audit(store, "dish.updated", id, { previousRevision: beforeRevision, revision: dish.revision, fields: changedFields });
    return dish;
  });
}

export function archiveDish(store, id, rawInput = {}) {
  const { expectedRevision } = parse(archiveSchema, rawInput);
  return store.atomic(() => {
    assertAvailable(store);
    const previous = currentDish(store, id);
    // Retried deletion is a read of the same tombstone, not another mutation.
    if (previous.deletedAt) return previous;
    const beforeRevision = checkRevision(previous, expectedRevision);
    const at = new Date().toISOString();
    const dish = { ...previous, activeBeforeArchive: previous.active, active: false, deletedAt: at, updatedAt: at, revision: beforeRevision + 1 };
    store.put("dishes", id, dish);
    audit(store, "dish.archived", id, { previousRevision: beforeRevision, revision: dish.revision });
    return dish;
  });
}

export function restoreDish(store, id, rawInput = {}) {
  const { expectedRevision } = parse(archiveSchema, rawInput);
  return store.atomic(() => {
    assertAvailable(store);
    const previous = currentDish(store, id);
    if (!previous.deletedAt) return previous;
    const beforeRevision = checkRevision(previous, expectedRevision);
    const at = new Date().toISOString();
    const dish = { ...previous, active: typeof previous.activeBeforeArchive === "boolean" ? previous.activeBeforeArchive : false, updatedAt: at, revision: beforeRevision + 1 };
    delete dish.deletedAt;
    delete dish.activeBeforeArchive;
    assertStall(store, dish.stall);
    assertUnique(store, dish);
    store.put("dishes", id, dish);
    audit(store, "dish.restored", id, { previousRevision: beforeRevision, revision: dish.revision });
    return dish;
  });
}
