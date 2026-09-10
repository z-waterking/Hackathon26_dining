# 2026-09-10 · Prompt确认联动、固定Base与历史追溯

## 修改范围

- Prompt编辑和规则编辑明确使用“确认修改并生效”，成功采用服务端返回的配置及组合预览；排菜最终Prompt默认展开。未确认草稿不更改已生效预览，不参与生成。
- 三段业务文本与全部规则统一确认；规则页提供就近确认入口。已批准Action继续由Action模块维护，不被本次确认或复原改写。
- 独立不可变Base记录最初源规则和默认业务文本；初始化不写current、不增版本、不覆盖人工编辑。复原到Base有二次确认，实际复原追加新版本而非抹掉中间历史。
- 统一API新增历史分页、完整版本只读快照及Base复原，沿用版本/来源指纹并发校验和SQLite事务。旧version-N原样保留；新确认与复原记内容指纹和变更摘要。
- 历史页面展示时间、版本、操作、变化及三段原文/规则，不将当前批准Action拼到旧快照冒充历史调用。界面中英文、业务原文保留；不新增模型调用。
- 使用OpenAI Docs核对本地Prompt builder与版本管理，维持代码统一拼接后直接传Responses instructions，不引入云端Prompt对象、不更换模型。

## 最初Base的依据

- 修改前只读核对：真实库current完整等于version-4，已有version-1至4均16条规则。库中没有version-0。
- 英文补全前备份`app/data/backups/before-catalog-english-2026-09-10T03-59-50-072Z.sqlite`保有最初v0状态；当前原始meta.rules/settings与备份完全一致。
- 忽略已保存current重建的v0与该备份getPromptConfig(v0)完整一致；其来源指纹又与version-1.sourceFingerprint相符。因此本库可据源规则和默认文本准确冻结最初Base，不把已经编辑过的current当作基线。
- 原有v1/v3分别改菜单Prompt/规则，v2/v4恢复原文，现有业务内容恰好已与最初Base相同；本次不替用户执行复原、不删除任何旧历史。

## 验证与本地启用

- 完整自动测试549/549通过，lint通过，生产构建成功。Prompt设置、语言边界、弹窗和工作台桌面/移动端浏览器回归60/60通过，其中Prompt专用20项覆盖确认联动、未确认隔离、Base二次确认、409草稿保护、分页和只读历史。
- 专用数据库测试验证Base/确认/复原/审计同事务回滚、已有版本不能覆盖、源刷新不改历史、SQLite关闭重开后完整持久。运行时测试验证Base初始化/历史读取不改候选、菜单Prompt哈希、既有菜单或恢复资格；确认和复原预览与下一次逐周逐档请求的instructions一致。所有测试使用隔离库/mock AI，无真实模型调用。
- 确认无运行中的菜单/AI任务后，一致性备份：`app/data/backups/before-prompt-base-2026-09-10T04-18-41-146Z.sqlite`。随后重启本地后端，启用新接口及前端构建`index-C3T8rFhV.js`。
- 启动前后逐表只读比较：仅meta新增`prompt-config:base`；current v4及旧version-1至4、audit、aiUsage、菜品、反馈、Action、菜单等全部原样。冻结Base与重建最初v0内容逐字段完全相同，16条规则；当前最终Prompt未变化。
- 页面及配置/历史/Base详情GET均HTTP 200，历史列表含Base v0和原有v1至v4，共5条；旧4版本均可追溯到原有审计摘要。没有替用户生成测试版本或执行复原。
- 数据库integrity_check为ok；既有只读业务校验通过（历史菜单缺位/失败记录仍作为既有业务提示，不声称已解决）。服务地址`http://127.0.0.1:4317/#prompts`，刷新即可使用。
