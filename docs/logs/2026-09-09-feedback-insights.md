# 2026-09-09 首页反馈统计与外置词云数据

## 修改内容

- 新增 `GET /api/feedback/insights?month=`，供反馈中心四个仪表卡读取本地数据。月份为空或省略时覆盖全部真实月份；`YYYY-MM` 仅统计指定月。无效月份、重复月份或不支持的过滤参数返回 400。
- 输出 `month`、`total`、`keywords: [{text,count}]`、`byType`、`byStatus`、`byMonth: [{month,total,byType}]` 及 `undated`。按月趋势保留实际数据月份；无法确定月份的旧记录计入 `undated`，不伪造日期。分类保留源记录值，由页面统一展示“批评”等图例。
- 排除 `demo`、`summaryRecord`、`quarantined`。词云复用月报的餐饮词表与菜品/档口词典，优先最长完整词，同一反馈重复出现同词只计一次，按频率返回前 40 词。
- 将共享词频逻辑提取为纯读取辅助函数，保持现有 `GET/POST /api/feedback/summary` 月报响应及缓存口径不变。
- 新接口只读取反馈与菜库，不调用模型，不创建缓存、审计或用量记录，不返回原文、回复、身份字段或内部配置。
- README 的“总览与处理工作区”说明改为 AI 跳转横幅、四卡仪表板、反馈台账的单页布局；说明 Action 集中管理、外置词云和新增只读接口。保留启动、旧表上传转换、新表展示与月报功能说明。

## 验证

执行：

```powershell
node --test tests/dashboard-insights.test.mjs tests/monthly-keywords.test.mjs tests/feedback-workflow.test.mjs
```

在 `app` 目录运行，13 项全部通过。其中新增 6 项覆盖跨月、逐条去重、同月报告一致、空集、排除演示/汇总/隔离、旧数据缺省、无效过滤、GET 不调用 AI/不写库及不返回隐私/内部配置。前端构建与端到端页面验证由首页集成流程统一执行。

`npx oxlint --deny-warnings server/feedback-ai.mjs server/app.mjs tests/dashboard-insights.test.mjs` 通过。
