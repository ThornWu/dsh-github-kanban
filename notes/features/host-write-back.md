# 0.9.0 宿主半边:读 + 状态写回(HOST 线程证据)

日期:2026-10-03。分支 fe/thornwu-kanban-board-ui(基于 main a8b459f)。
负责范围(独占):`lib/index.js`、`test/service.test.mjs`、`test/cache.test.mjs`、本文档。
未动:lib/client.js(CLIENT 线程并行改写中)、scripts/smoke-load.mjs、test/{pure,contract,pack,syntax}.test.mjs、test/react/、test/helpers/、package.json、README/CHANGELOG/TODO/SECURITY、notes/features/docs.md。

## 任务 A:看板载荷扩展(只增不改)

查询(`BOARD_PROJECT_FIELDS`,viewer/repository 两入口共享片段,一处改两处生效):

- Status 单选字段选项补 `color`:`options { id name color }`(ProjectV2FieldOptionColor 枚举,如 GREEN/RED,无 # 前缀);
- users 节点补 `avatarUrl(size: 40)`:`nodes { login avatarUrl(size: 40) }`;
- labels 节点的 `color`(6 位 hex)0.8.0 已在查询与投影中,本任务仅补测试确认;
- **三路来源**:labels/assignees 挂在 item 级 `fieldValues`,与 content 的 DraftIssue/Issue/PullRequest 三路片段正交,一处补齐即三路同享,无须逐路改写(查询契约有测试钉住)。

投影(契约注释同步写进 `mapBoard` JSDoc,客户端 coerce 透传依赖此形状稳定):

- `board.projectNodeId: string` —— 项目全局 node id,与 `board.project.id` 同源;moveCard 的 mutation `input.projectId` 即取自它,两端同源不另发元数据查询;
- `board.statusFieldId: string|null` —— Status 字段全局 id;无 Status 字段**或字段 id 不可用(空串)**时 null,moveCard 据此给 `not_supported`,读路径行为不变;
- 每列新增 `color: string|null`(键恒在场:选项缺 color 或兜底列为 null);`optionId` 既有口径不变(选项列 string、兜底列 null),契约注释补记为 `string|null`;
- 卡片新增 `assigneeDetails: Array<{ login: string, avatarUrl: string|null }>`,与既有 `assignees: string[]` **同序同过滤**(login 为空者两边都剔除);avatarUrl 缺失补 null(键恒在场);既有 `assignees` 不动;
- `labels` 的 color 随节点透传(既有口径:非字符串时键值为 undefined,JSON 序列化后即缺席),不改。

实现取舍:`extractStatusField` 的选项对象**仅当来源携带可用 color 时才输出该键**(条件展开,不落 undefined 键)。原因:`test/pure.test.mjs`(冻结)S3.1 extractStatusField 用例对输出做 `deepEqual({id,name,options:[{id,name}]})`,无 color 输入时多一个 `color: null` 键即红。wire 面的形状稳定由 `mapBoard` 兜底保证:列的 `color` 与卡片的 `avatarUrl` 键恒在场(null 占位),客户端透传面不受内部辅助函数的条件键影响。

## 任务 B:写回 mutation moveCard

方法签名(参数数量契约,二轮 P1 教训):`async moveCard(request)` —— 恰 1 个简单标识符形参,不用默认参数/rest;wire 字段名 = `request`。REMOTE_METHODS 增为 `["status","listProjects","getBoard","moveCard"]`,原型标记 `moveCard → { method, invocation: { kind: "direct" } }` 与 protocol `mark()` 产出逐字段一致(测试钉住)。

- request:`{ repo?: string, projectNumber: number, itemId: string, optionId: string }`;
- 成功:`{ ok: true }` —— 刻意**无 value 键**:网关拆包 `raw.ok === true && "value" in raw ? raw.value : raw`,无 value 键原样透传,成立;
- 失败:`{ ok: false, error: { code, message, transient? } }`,message 经 sanitizeError 不含 token,任何路径不 throw;
- 形状校验(零网络早退):projectNumber 与 getBoard 同口径(Number 强转后须正整数,"7" 可过)、repo 若提供须 owner/name、itemId/optionId 须非空字符串 → 否则 `bad_request`(transient:false);
- 路径:凭据快照(方法入口 `credentialSnapshot()`,与 getBoard 内部快照同一同步段,值恒一致)→ `getBoard` 同键缓存解析 projectNodeId/statusFieldId(**刻意不 noCache**:TTL 命中不重拉;过期元数据导致的失配由 option_missing/item_missing 兜住并提示刷新)→ mutation;
- mutation:`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }`,variables = `{ input: { projectId, itemId, fieldId: statusFieldId, value: { singleSelectOptionId: optionId } } }`;
- **缓存纪律**:写回不进任何缓存、不参与 in-flight 去重,每次调用独立真发;读阶段经 this.getBoard 复用既有缓存语义(指纹隔离/单调写不受影响)。cache.test.mjs 两条用例钉住:连续两次调用 mutation 真发两次(读阶段 TTL 内只读一次);并发两个写回各自真发(读阶段仍按既有去重合并)。

### 错误码全集(README 排障表同源,未发明新码)

| code | 触发 | transient |
| --- | --- | --- |
| bad_request | 请求形状非法(缺/错 projectNumber、itemId、optionId、repo 格式) | false |
| not_supported | statusFieldId 为 null(项目无可用 Status 字段,看板「全部」列),不发 mutation | false |
| forbidden | HTTP 403,或 graphql_error 消息含 FORBIDDEN / Resource not accessible(无项目写权限) | false |
| option_missing | 422/无法校验且 GraphQL errors 文本含 option(目标列选项已不存在) | false |
| item_missing | 同上,文本含 item(卡片 item 已不存在) | false |
| write_failed | GitHub 拒绝写入且文本判不准(含 HTTP 422 无 errors 文本可判) | false |
| timeout | 既有超时分类(请求/响应体阶段,含读链路透传) | **true** |
| token_missing | 凭据快照为 null(经读链路透传,不打网络) | 不携带 |
| 读链路码原样透传 | project_not_found / network_error / http_error / graphql_error / shape_error / all_sources_failed / env_error | 不虚构 |

实现要点:

- `ghGraphQL` 的 http_error 信封新增 `status: response.status`(**只增不改**,读链路不读它);moveCard 据此把 403/422 映射为 forbidden/write_failed,不必解析消息文本;
- 文本判别 `classifyWriteFailure` 为 best-effort,option 先于 item(同一消息提两者按 option 计),判不准统一 write_failed;message 已脱敏;
- moveCard 生成的错误全部显式带 transient(false/true);读链路透传错误不加 transient 字段,不虚构恢复语义。

## 测试证据(先红后绿)

- 新增 17 条用例:service.test.mjs +15(载荷扩展 4:载荷投影/无 Status 字段/卡片 assigneeDetails 与 labels color/查询契约;moveCard 11:成功含变量五元组与快照 Authorization/凭据同刻/403 forbidden/GraphQL FORBIDDEN/422 分类四例/not_supported/bad_request 九形/timeout transient/token_missing/project_not_found 透传/wire 契约),cache.test.mjs +2(不缓存不去重/并发不合并)。实现前分别跑红(4 红、13 红),实现后全绿。
- **载荷扩展导致的既有断言改写:0 条。** 全部为加性键,既有用例(service/cache/pure/smoke 的属性级断言)无一需要改写;`test/pure.test.mjs` 的两处 deepEqual(assignees/labels 空数组、extractStatusField 输出)按上文条件键设计天然兼容。
- 线程内终值(独立跑):service 36/36、cache 25/25、pure 23/23(冻结,绿)、syntax 1/1、contract 14/16、react 22/24、pack 1/1、smoke 223/227。

## 冲突与取舍(需主线收口)

1. **contract.test.mjs:355(冻结,本线程改红了)**:该用例把宿主 Remote 标记 deepEqual 钉死为恰好 `["status","listProjects","getBoard"]`;而 dsh 网关源码(`dsh-api-gateway/lib/index.js` resolveSrcDescriptor → `remoteMethods(original)`)证实 moveCard 必须进该标记才能被 SRC 回退发现,两者不可兼得。经所有者决策:按规格实现(moveCard 进标记),该行变红,由主线把期望数组加入 `"moveCard"`(一行)。smoke 侧对应检查用的是 `.every`/`.some`,4 方法天然通过,无此问题。
2. **CLIENT 线程并行改动撞冻结断言(非本线程文件,只报告)**:lib/client.js 在本线程工作期间被 CLIENT 线程改写(moveCard 进浏览器清单、theme 进 prefs、GitHub 风格渲染),与冻结测试的 4 处冲突:contract.test.mjs:158(清单 3 方法 deepEqual → 实际 4)、smoke「远程清单声明 3 个 direct 方法」(descriptors.length===3)、smoke「偏好:写回仅含 {savedAt,selectedKey}」与 react 同名用例(theme 键)、smoke「看板:卡片含 @login」与 react 渲染用例(@login 文本 → 头像渲染)、smoke R05 刷新按钮数(工具栏多了主题按钮)。连同第 1 条,建议主线统一收口冻结断言。
3. VERSION 恒为 0.8.0(主线统一 bump,lib/index.js VERSION 与 package.json 同步三处含 smoke 版本断言)。
4. moveCard 读阶段复用 getBoard 缓存意味着写回用的元数据可能落后 TTL 至多 15s:取舍依据是 Status 字段定义(字段 id/选项 id)在会话内极少变化,而每次写回前强拉看板会让拖拽延迟翻倍;失配路径(选项被删/卡片被删)有对口错误码与 README 处置指引。
