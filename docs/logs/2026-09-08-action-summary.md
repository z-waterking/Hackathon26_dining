# 2026-09-08 全部反馈聚合行动模块

## 改动范围

- 新增 `app/server/action-summary.mjs`，将选定范围内的全部单条反馈交给一次聚合分析，归纳最多六个共性事项；不要求每条反馈都产生行动，零项行动是有效结果。默认范围为所有月份的真实反馈，也支持指定月份和演示数据范围。
- 模块导出 `getActionSummary(store, { month: '', demo: false })` 和 `summarizeActions(store, ai, { month: '', demo: false, force: false })`。接口返回分析摘要、输入数量、现有相关事项；后者另返回 `reused`。运营读取结果不包含内部 prompt 文本。
- 主服务负责 API 接入与独立 Action 界面。本模块未修改反馈界面、`feedback-ai.mjs`、`app.mjs` 或现有回复功能。

## 数据与审批

- 排除 `summaryRecord` 与 `quarantined` 记录，严格按 `Boolean(record.demo)` 匹配演示/真实范围。缓存和事项标识也带 demo 范围，避免交叉引用。全部月份分析不会预先按月拆成多次请求。
- 每个事项包含 `feedbackIds`、代表性 `evidence`、`sourceKey`、标题、描述、档口、优先级和排菜指令。关联反馈 ID 必须属于本次完整输入；每条证据必须逐字包含于其反馈正文，不接受改写或虚构的引用。
- 增加 `kind: menu | service | other`。只有 menu 事项可填写排菜要求且不能为空；服务/其他事项要求 `menuInstruction` 为空，防止把排队、清洁等运营动作混进排菜 prompt。档口必须是现有档口或“全部档口”。
- 新事项固定创建为 `pending`、`enabled: true`、`revision: 1`、`source: aggregate`，AI 不决定批准或执行。
- 同主题事项优先复用模型输入中真实提供的 `sourceKey`，并按规范化标题及目标档口兜底去重。初始稳定标识不随人工改标题变化，月度/全部范围重复分析不会另造一份相同事项。
- 复用已有事项只补充新的反馈依据与审计历史，保留人工标题、操作描述、档口、排菜要求、状态、启用情况和修订号。一次响应中的重复主题也合并为同一事项。

## 缓存、输入边界与审计

- `meta` 缓存键为 `action-summary:<real|demo>:<all|YYYY-MM>`。来源指纹覆盖本次全部反馈、回复/跟进状态及允许档口。相同输入和内部配置版本复用摘要；人工调整事项本身不会触发自动重写。
- 超过 1000 条记录或完整输入超过 150000 字符时，在调用 AI 前明确报错，要求缩小范围，不静默截断资料。
- 等待 AI 期间重新核验全部反馈、档口、内部配置版本及已有事项快照；任一变化拒绝保存过时结果。业务写入放在 SQLite 事务内。
- 每次成功分析保留 `action-summary-run:<id>` 历史快照及 `actions.aggregated` 审计事件，可追溯关联事项、来源数量、创建/补充数量和上次分析 ID。不保存内部 prompt 原文。

## 验证

- 合成数据测试覆盖三条跨月反馈聚合成一项、非逐条覆盖、零项结果、空范围不调用 AI、缓存、强制重算不覆盖人工审批/编辑、同主题新增证据跨月复用、演示/真实隔离。
- 验证虚构反馈 ID、非原文证据、不在关联列表的证据、未知档口/复用 key、服务事项混入排菜要求以及超过六项输出均整批拒绝。
- 验证分析中数据/配置/已有事项变化时不写入结果、输入上限调用前拒绝，以及规范化重复标题合并依据。
- 使用模拟 AI 和内存 SQLite，未发起外部模型请求，未读取私有反馈正文。
- `node --test tests/action-summary.test.mjs`：10/10 通过；新增模块和测试的 `oxlint --deny-warnings` 通过。

## 修复：演示聚合事项的来源标记

- 内置 `ensureDemoActions` 创建的四项聚合示例使用 `source: demo`，原列表仅接受 `source: aggregate`，导致示例载入后存在 12 条反馈却看不到对应 Action。
- `aggregateActions` 现对演示范围额外接受有多条 `feedbackIds` 且每条均有 evidence 的 `source: demo` 事项。真实范围仍不接收此来源；仅有单个 `feedbackId` 或单条数组的旧式逐条演示 Action 均排除。
- 此兼容也使这些内置事项作为已有主题传给后续演示聚合，避免重复创建同主题事项。没有改变 API、路由或界面。
- 增加直接调用 `ensureDemoActions` 的内存 SQLite 集成测试：首次加载 4 项/12 条，全部与月份 GET 汇总均可见四项；重复加载不增项；真实记录范围不包含示例、旧单条 Action 不混入。
- 聚合模块测试现为 11/11 通过；对应 lint 通过。
