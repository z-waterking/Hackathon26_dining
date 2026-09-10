export const LANGUAGE_KEY = "dining-ui-language";
export const normalizeLanguage = value => value === "en" ? "en" : "zh";
export const languageLocale = language => normalizeLanguage(language) === "en" ? "en-US" : "zh-CN";

// Presentation-only vocabulary. Never use translated values in API payloads,
// stored business records, rule/Prompt text, form values or exported data.
export const englishText = Object.freeze({
  "反馈中心": "Feedback", "Action 事项": "Action Items", "六周菜单": "Six-week Menus",
  "菜品资料": "Dish Catalog", "消费分析": "Sales Analytics", "Prompt 与规则": "Prompts & Rules",
  "未处理": "Open", "跟进中": "In progress", "已完成": "Completed", "待处理": "Pending",
  "投诉": "Complaint", "批评": "Criticism", "建议": "Suggestion", "表扬": "Praise", "询问": "Inquiry",
  "其他": "Other", "其他 / 待分类": "Other / Unclassified", "未分类": "Unclassified", "待分类": "Unclassified",
  "全部": "All", "全部档口": "All stalls", "全部餐次": "All meals", "所有档口": "All stalls",
  "早餐": "Breakfast", "午餐": "Lunch", "晚餐": "Dinner", "周一": "Mon", "周二": "Tue", "周三": "Wed", "周四": "Thu", "周五": "Fri",
  "周": "Week", "月": "Month", "季度": "Quarter", "份": "portion", "个": "item", "斤": "jin (500 g)", "位": "person",
  "未知": "Unknown", "待确认": "To confirm", "待核验": "Needs verification", "辣": "Spicy", "不辣": "Not spicy",
  "素食": "Vegetarian", "非素食": "Non-vegetarian", "荤菜": "Meat dish", "素菜": "Vegetable dish",
  "炒": "Stir-fried", "炖": "Stewed", "蒸": "Steamed", "煮": "Boiled", "炸": "Fried", "烤": "Roasted", "凉拌": "Cold dish",
  "辣度待核验": "Spice level unverified", "素食待核验": "Vegetarian label unverified",
  "可选": "Available", "停用": "Disabled", "已停用": "Disabled", "启用": "Enabled", "已启用": "Enabled",
  "已批准": "Approved", "已拒绝": "Rejected", "待审批": "Pending approval", "待审核": "Awaiting review",
  "待复核": "Needs review", "已保存": "Saved", "保存": "Save", "保存中…": "Saving…", "取消": "Cancel",
  "关闭": "Close", "关闭通知": "Dismiss notification", "重新加载": "Reload", "刷新": "Refresh",
  "暂无记录": "No records yet", "暂无数据": "No data yet", "导出 CSV": "Export CSV", "导入 CSV": "Import CSV",
  "上一页": "Previous page", "下一页": "Next page", "操作": "Actions", "状态": "Status", "详情": "Details",
  "编辑": "Edit", "删除": "Delete", "来源": "Source", "日期": "Date", "档口": "Stall", "餐厅": "Restaurant",
  "优先级": "Priority", "高": "High", "中": "Medium", "低": "Low", "高优先级": "High priority",
  "规则": "Rules", "核验": "Verification", "冲突": "Conflict", "已落实": "Applied", "部分落实": "Partially applied", "未落实": "Not applied",
  "通过": "Passed", "未通过": "Not passed", "不适用": "Not applicable", "未检验": "Not inspected", "已过期": "Outdated",
  "无": "None", "是": "Yes", "否": "No", "真实 AI": "Live AI", "模拟数据": "Demo data", "导入交易": "Imported transactions",
  "进行中": "In progress", "已取消": "Cancelled", "失败": "Failed", "待补菜": "Dish pending", "人工待补": "Manual input needed",
  "反馈来源": "Feedback source", "序号": "No.", "反馈内容": "Feedback", "反馈跟进": "Follow-up", "反馈类别": "Feedback type",
  "问题分类": "Issue category", "回复记录": "Replies", "备注": "Notes", "二维码": "QR code", "邮件": "Email",
  "菜品名称": "Dish name", "所属档口": "Stall", "原售价": "Source price", "辣度 / 素食": "Spice / Vegetarian",
  "热量 / 100g": "Calories / 100 g", "辣度": "Spice level", "素食性": "Vegetarian status", "主要食材": "Main ingredient",
  "制作工艺": "Cooking method", "热量（kcal / 100g）": "Calories (kcal / 100 g)", "过敏原": "Allergens", "标签核验依据": "Label evidence",
  "原料": "Ingredient", "熟重 g": "Cooked weight (g)", "生重 g": "Raw weight (g)", "原料单价": "Ingredient unit price",
  "工作表": "Worksheet", "非空行": "Non-empty rows", "错误": "Errors", "所有月份": "All months", "全部月份": "All months",
  "菜品": "Dish", "净销量": "Net quantity", "净消费额": "Net sales", "排名": "Rank", "净收入": "Net revenue",
  "口味": "Taste", "服务": "Service", "环境": "Environment", "卫生": "Hygiene", "价格": "Price", "份量": "Portion size",
  "种类": "Variety", "手工": "Manual", "口头": "Verbal", "微信群": "WeChat group",
});

export function translate(language, chinese, english) {
  if (normalizeLanguage(language) !== "en" || typeof chinese !== "string") return chinese;
  return english ?? englishText[chinese] ?? chinese;
}

// Content from records, imports and generated business results is not UI copy.
// Keep its language exactly as supplied, regardless of the interface locale.
export const sourceText = value => value;
export function readLanguage(storage) {
  try { return normalizeLanguage(storage?.getItem(LANGUAGE_KEY)); } catch { return "zh"; }
}
export function persistLanguage(storage, value) {
  const language = normalizeLanguage(value);
  try { storage?.setItem(LANGUAGE_KEY, language); } catch { /* Restricted storage must not block switching. */ }
  return language;
}
