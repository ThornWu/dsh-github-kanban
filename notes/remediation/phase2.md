# 阶段 2 整改记录:架构与数据契约(S2.1–S2.9)

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线 HEAD `f6ad528`(工作区含阶段 1 的 lib/scripts 改动与阶段 4 的文档改动,本阶段在其上继续,未回退)。

改动文件(仅限本阶段独占范围):

- `lib/index.js`(宿主半边:职责分层、共享查询片段、统一分页、完整性口径、wire 契约集中、兜底文案标记化)
- `lib/client.js`(浏览器半边:数据控制层抽取 —— 状态机 + 控制器 + 契约校验;组件转纯视图;文案补齐)
- `scripts/smoke-load.mjs`(自检:152 → 204 用例;夹具脱敏)
- 本文件

运行命令(零依赖,只用 node 内置模块):

```
node scripts/smoke-load.mjs                                # 204/204 通过
node --unhandled-rejections=strict scripts/smoke-load.mjs # 同样 204/204(迟到 Promise 无未处理拒绝)
node --check lib/index.js && node --check lib/client.js   # 语法检查通过
```

环境:Node v24.18.0,darwin 27.2.0 arm64。React/dsh 仍为替身(真机验证属阶段 5)。

## 1. 任务映射表

| 任务 | 状态 | 实现位置 | 测试位置(scripts/smoke-load.mjs) |
| --- | --- | --- | --- |
| S2.1 宿主职责区分 | 完成(不拆文件,内部结构分层) | lib/index.js 文件头「职责分层」注释图 + §1–§6 分节;统一分页 `pageAll`(§3) | 既有 4d(分页)、4k–4p、S2.7/S2.5 新块(全走同一分页助手) |
| S2.2 浏览器数据控制集中 | 完成 | lib/client.js §3:`createBoardController`(依赖可注入:delay/scheduleRetry/polling/可见性)+ `selectTarget` 纯函数;§4 组件只订阅快照 + 转交交互 | 5r(控制器直驱 4 场景,不经 React)、既有 5c/5e–5p 全部经组件路径复跑通过 |
| S2.3 状态机 | 完成 | lib/client.js §3:`BOARD_PHASES` + `initialBoardState` + `boardTransition`(显式转换,事件全集见注释)+ `viewBoardState`(视图推导) | 5q(纯函数直驱 11 断言:每个转换事件逐个验证) |
| S2.4 数据契约 | 完成 | 契约文档:宿主侧各函数 JSDoc 返回形状(lib/index.js `boardError` 注释列 code 全集、`listProjectsImpl`/`getBoardImpl`/`mapBoard` 注释);运行时校验:宿主既有(shape_error/absent 区分)+ 客户端新增 `coerceStatus/coerceProjectsResult/coerceBoardResult` | 5s(纯校验 5 断言 + 组件级畸形列表/畸形看板 2 断言:错误态 [shape_error],不崩不静默为空) |
| S2.5 totalCount/fetchedCount 与完整性口径 | 完成 | lib/index.js `getBoardImpl`(incomplete 判定)+ `pageAll`(capped 标记)+ `countFieldValuesTruncated`;lib/client.js `viewBoardState`(truncated 口径)与 boardCapped/fieldValuesTruncated 文案 | 宿主 4 断言(上限无总数/总数自证/字段值截断计数/列表 projects_truncated)+ 渲染 3 断言(5t 场景 1–2) |
| S2.6 Remote 契约集中与核验 | 完成 | lib/index.js §5「Remote wire 契约的唯一集中地」注释块(6 条:标记/绑定/签名/参数校验能力/信封/兼容检查)+ `REMOTE_METHODS` 常量;lib/client.js `remoteContribution` 注释与 `createBoardApi` 信封拆包注释 | wire 契约块 5 断言(标记形状/绑定/参数名/清单规则/业务结果无 value 键);信封拆包由既有 5p 场景 3–4 覆盖 |
| S2.7 消除两套看板查询重复 | 完成 | lib/index.js:`BOARD_PROJECT_FIELDS` / `PROJECT_NODE_FIELDS` 共享片段 + 由片段拼装的 4 个查询常量;`graphqlQueries` 导出供自检 | 查询片段 3 断言(选择集逐字一致 ×2 + pageInfo 在场)+ 路由去重 5 断言(跨 owner 同编号/同项目多仓/三路路由/内容区分/缓存键隔离) |
| S2.8 Status 改名/缺失与 contentMissing 多因 | 完成(行为口径明确 + 文案改写) | 行为:`statusFieldHint` 三口径注释补「不猜测替代字段」;文案:zh/en `contentMissingHint` 重写为多因(权限缺口 + Issue/PR 已删除或不可见),`statusHintRenamed` 补口径说明 | 既有 4e/4f(hint 三口径)+ 5c1d 改写(断言「可能原因」「已被删除」在场,不只 PAT 权限) |
| S2.9 版本统一/注释清理/i18n 遗漏 | 完成 | 版本:`VERSION` 为代码内唯一来源 + smoke 核对与 package.json 一致;注释:panelLede「Phase 2」改为路线图口径、TODO 1.3 引用改为 dev-notes 差异 10;i18n:兜底列名/无标题卡改 `fallback`/`untitled` 标记 + 词典键 columnAll/columnUnfiled/cardUntitled,新增 sourceTruncated/boardCapped/fieldValuesTruncated 键 | 5t(本地化 2 断言 + 版本一致 1 断言)+ mapBoard 标记断言 2 处改写 |

## 2. 逐任务说明(现状判断 → 改动 → 证据)

### S2.1 宿主职责区分 —— 有此问题(分页循环重复),按需整合,不拆文件

现状判断:lib/index.js 原有「请求/分页/映射/缓存/dsh 适配」在文件里已经分节,但**两套分页循环平行存在**(`pageProjectsAll` 与 `getBoardImpl` 内嵌 items 循环,各自实现 hasNextPage/endCursor/上限兜底/缺席判定),且 `getBoardImpl` 单函数混合请求构造、分页、元信息提取、计数、映射五件事 —— 这是真实的维护漂移点,不是想象的结构洁癖。

改动:(a) 抽出唯一分页实现 `pageAll(query, variables, extract, deps, limits)`,返回 `{nodes, parent, firstConnection, capped}` / `absent` / 结构化失败;项目列表与看板 items 共用(列表 maxItems=300/页 30,看板 200/页 50)。(b) 文件头补「职责分层」注释图(§1 适配/§2 请求/§3 查询与分页/§4 组装与纯映射/§5 Remote+缓存/§6 入口),各节边界即职责边界。

**不拆文件的理由**(计划允许「按实际修改需要拆分」+ 交接默认倾向不拆):宿主半边拆成多文件需要同步扩 `files`/`exports` 分发面,而收益只是把同一份纯函数调用换个目录;浏览器半边受单文件硬约束本来就拆不了,两侧不对称反而增加理解成本。分节 + 单一分页助手已消除实际漂移点。

### S2.2 浏览器数据控制集中 —— 有此问题(控制逻辑内嵌组件 hook),抽为可注入控制器

现状判断:整改前 `GithubKanbanBody` 里 bootstrap/loadBoard/轮询/自愈轮全部内嵌在组件的 useState/useEffect/useRef 网络中(12 个 state + 13 个 ref),不经 React 无法测试任何一条数据流分支。

改动:抽出框架无关的 `createBoardController(deps)`,`deps = { getApi, t, polling, getElement, delay, scheduleRetry }` 全部可注入 —— 自检注入即时 delay 与可控 scheduleRetry 后即可直驱(smoke 5r 四场景:完整链/切换退位/15 轮封顶与手动重置/轮询与 dispose 收口,全程无 React)。组件(`GithubKanbanBody`)只做三件事:创建/订阅控制器、从快照 + `viewBoardState` 推导渲染、把 select/reload 转交控制器。自检接缝经模块导出的 `internals` 对象暴露(非公开 API,dsh 装载器只消费 apply/inject,多余导出键原样存档不校验 —— 已对照 dsh-client-modules `materialize()` 源码确认)。

行为保真:阶段 1 的全部语义原样移植 —— 请求序守卫、inFlight 节流、链内退避(≤5 次)、4s 自愈轮 15 轮封顶、手动刷新重置预算 + noCache 整链重拉、偏好只读一次/失配不落盘、卸载收口;既有 5c/5e–5p 用例不经修改全部通过即证据。一处有意增强:`start()` 支持重挂载(对齐旧实现 effect 体里 `disposedRef.current = false` 的 StrictMode 双挂载口径,旧控制器版首稿漏了这点,已修)。

### S2.3 状态机 —— 有此问题(布尔+ref 隐含约束),收敛为单一 phase + 显式转换

现状判断:整改前 phase 与 tokenConfigured/transient/refreshing 多布尔并存,「error 期轮询成功会恢复 ready」「transient 只在 error 有意义」这类约束靠 setState 调用点之间的默契维持。

改动:`phase ∈ {idle, loading, ready, error}` 单一状态机字段 + `boardTransition(state, event)` 纯函数(11 类事件,语义逐条写在注释里)。**部分失败**明确为 ready 的 payload(来源级警告)而非独立 phase —— 数据可用但降级,升级为 error 反而丢数据。活动标记 `boardInFlight`(看板请求在途)不是 phase:轮询刷新期间面板保持 ready,只门控按钮禁用与加载占位。`viewBoardState(snapshot)` 纯函数产出全部渲染决策(showGuide/showToolbar/showError/showNoProjects/showBoardArea/boardMatchesSelection/truncated...),组件零布尔运算。转换函数由 5q 直驱验证(每个事件一个断言,含「RETRY 后 START 计数保留」「未知事件原样返回」)。

### S2.4 数据契约 —— 有此缺口(畸形成功响应可退化为异常/空态),补运行时校验

现状判断:宿主侧对畸形响应已有防线(非数组 nodes → shape_error;repository/project 缺席与结构畸形区分),但**浏览器侧对 `ok:true` 的业务形状零校验**:`list.projects` 为 undefined 时组件 `projects.length` 直接抛异常;`board.columns` 缺失时 Board 组件抛异常 —— 畸形成功响应的表现是崩溃而非可观测错误,与「不能无声退化」都不符。

改动:客户端在结果进状态机前过 `coerceStatus/coerceProjectsResult/coerceBoardResult`:缺 `status.tokenConfigured` 布尔、缺 `projects` 数组、项目条目缺正整数 number、缺 `board.columns`、列缺 `items` 数组 → 一律折成 `shape_error` 结构化失败走错误态(可观测);失败信封原样透传;合法形状放行(totalCount 缺席合法 = 5h 的退回列合计口径)。契约的描述性一面用 JSDoc 落在宿主各返回点(`boardError` 注释列错误 code 全集;listProjects/getBoard/mapBoard 注释列字段形状)。取舍:**没有**引入 schema 库或独立 .d.ts —— 零依赖约束下,「注释契约 + 边界处轻量运行时校验」是本项目的合适重量;两侧字段形状漂移由 smoke 的夹具(与宿主输出同形)兜住。

### S2.5 完整性口径 —— 有此缺口(capped 且无总数时假称全量;字段值截断无声),补三处口径

现状判断与改动:

1. **items 达分页上限**:旧实现在翻页到页数上限(4 页 ×50=200)且 hasNextPage 仍真时直接结束 —— 服务端报了 totalCount(如 500>200)时客户端会展示「已加载 200/500」,可解释;但**服务端 totalCount 畸形/缺席时 totalCount 退回 fetchedCount(=200),客户端显示「共 200 张卡」—— 假称全量**。现在:`pageAll` 返回 `capped`,`getBoardImpl` 在「capped 且总数口径不能自证不完整(未知或不大于已取数)」时显式 `incomplete: true`;客户端 `truncated = (total > visible) || incomplete`,新增 boardCapped 文案(无总数版本的不完整提示)。
2. **字段值达单页上限**:查询原本**不请求** fieldValues/users/labels 的 pageInfo,截断完全无声。现在查询补 `pageInfo { hasNextPage }`(三处连接),`countFieldValuesTruncated` 统计被截断的卡数进 `board.fieldValuesTruncated`,客户端出提示行。取舍:只统计不逐页追拉(按 item 嵌套翻页的成本与收益不成比例),提示「可能缺失」即为可解释。
3. **项目列表达分页上限**:`pageAll` 的 capped 由 `listProjectsImpl` 转成来源级警告 `projects_truncated`(消息含上限值),客户端用独立文案 `sourceTruncated`(「列表可能不完整」)渲染,**不与「读取失败」句式混排**。
4. **字段定义达单页上限(40)**:既有 `statusFieldHint` 的 `fields_truncated` 口径保留,常量化 `FIELDS_PAGE_SIZE`。

口径文档化:totalCount(服务端全量,畸形退回 fetchedCount)/ fetchedCount(实际拉取)的定义与 incomplete 的判定条件写在 `getBoardImpl` JSDoc;测试覆盖四种组合(4 个宿主断言 + 3 个渲染断言)。

### S2.6 Remote 契约集中与核验 —— 集中已完成,本轮做的是**对照 rc.2 源码的逐条核验**

现状判断:标记/绑定/清单/信封在两个半边各自已相对集中,但「透传 codec 的实际校验能力」此前只有推断,没有源码级核验记录。本轮通读本机 dsh 0.2.0-rc.2 官方包源码(`@deepseek-ai/dsh` 内嵌 monorepo:dsh-typert-protocol、dsh-api-gateway、dsh-typert-registry、dsh-client-modules、dsh-cordis-client-runner),核验结论已写进 lib/index.js §5 注释块,要点:

| 契约点 | 核验结论(源码位置) | 本包符合性 |
| --- | --- | --- |
| Remote 标记 | protocol `mark()`:marker 冻结为 `{method, ...(exportName≠method 才带), ...(mode 才带), invocation:冻结}`;直接方法**恰好省略** exportName/mode 两键 | 本包 marker = `{method, invocation:{kind:"direct"}}`,键序/冻结逐字段一致(smoke 断言键序) |
| 服务绑定 | protocol `bindTypertRemote()`:冻结 `{service 自指, serviceKey, namespace}`;gateway `readBinding()` 校验三者;namespace 须匹配 `/^[A-Za-z0-9_$.-]+$/` 且非 `.`/`..` | 一致;smoke 断言冻结 + 段合法 |
| 方法签名 | gateway `methodParameterNames()`:Function.toString 解析,**仅简单标识符**(无解构/默认值/rest);wire 字段名 = 参数名 | status 无参、listProjects/getBoard 单参 `request`,smoke 断言源码解析结果 |
| 参数校验能力(SRC/src-json 的实际能力) | gateway `decode()` → `assertJsonValue()`:**只做 JSON 安全校验**(纯对象/数组/有限数字/字符串/布尔/null,拒循环与非普通原型),无形状校验;`assertExactArguments()` 允许 json 参数缺席(src-json 视为 acceptsUndefined)、拒未知顶层字段 | 因此业务形状契约由本包两端自持:请求侧 request 的字段约定 + 响应侧 coerce(S2.4) |
| 返回信封 | gateway `encodeRpcResult()`(SRC 路径 runtime JSON 编码)→ `{ok:true, value}`;client `invoke()` → `{ok:true, value: result.value}`(result.decode 缺省时不解码)或 `{ok:false, error}` | 客户端按「value 键存在与否」拆包;smoke 断言业务结果不含 value 键(拆包约定成立) |
| 浏览器清单 | registry 客户端 `validateInvocation`:id 仅需非空(**无 # 禁令**,那是宿主侧 registry 的规则);service/namespace/method 段字符校验;codec 必须 strict 且带 typeSymbol+create;gateway client `requireStrictInputs` 强制 strict 但**从不调用 create()** | 本包清单全部满足;smoke 以镜像规则断言 |
| 模块装载 | dsh-client-modules `materialize()` 把 factory 导出对象原样存档,装载只消费 apply/inject | 导出 `internals` 自检接缝安全 |

兼容检查落地:上述规则镜像为 smoke 的「wire 契约(S2.6)」5 断言;升级核对清单维持 notes/dev-notes.md「升级 dsh 时的核对清单」指向。

### S2.7 消除两套看板查询重复 —— 有此问题(约 40 行选择集逐字重复),片段化 + 路由/去重验证

现状判断:`QUERY_BOARD_PAGE` 与 `QUERY_REPO_BOARD_PAGE` 的 projectV2 选择集(约 40 行)逐字重复,改字段必须双写 —— 正是计划点名的「易漂移重复字段定义」。

改动:`BOARD_PROJECT_FIELDS`(看板选择集,含 S2.5 新增的 pageInfo)与 `PROJECT_NODE_FIELDS`(列表节点集)两个片段常量,4 个查询全部由片段拼装(模块加载期字符串模板,无运行时开销);`graphqlQueries` 导出供自检。smoke 用「锚点后平衡选择集逐字比对」断言两入口一致(改单边不过片段会立刻红)。路由与去重验证(计划点名的两个场景,补用例):跨 owner 同编号(viewer#3/alpha#3/beta#3 三条独立条目,键互不碰撞,三路 getBoard 变量/查询各正确,缓存键 `repo#N` 隔离、两块看板同时在册);同一项目 link 多仓(同 id 去重为一条,仓归属 = 配置序靠后 —— 既有语义,现在有测试钉住)。

### S2.8 Status 改名/缺失 + contentMissing 多因 —— 行为已明确,本轮补「口径成文」与「多因文案」

现状判断:行为本身(改名/缺失 → 单列兜底 + 三档 hint)阶段 0/1 已定型且有测试;缺口在 (a) 口径没有成文说「为什么不猜测替代字段」,(b) contentMissing 文案把**所有**原因归因 PAT 权限。

改动:`statusFieldHint` 注释补口径(「列序语义 = Status 选项序不能建立在猜测上」),`statusHintRenamed` 文案补同一句;`contentMissingHint` zh/en 重写为「可能原因:token 缺 Issues/PR 读权限(最常见),或卡片关联的 Issue/PR 已被删除、不可见」+ 权限情形的具体修复指引保留(5c1d 断言「可能原因」「已被删除」「Read-only」三要素在场)。

### S2.9 版本统一/注释清理/i18n 遗漏 —— 三件都有实锤,逐件处理

1. **版本来源**:代码内 `VERSION` 常量本就是唯一来源(UA/status/日志三处消费同一常量),真正的风险是与 package.json 漂移 —— smoke 新增断言 `hostMod.VERSION === pkg.version`(当前 0.7.0 = 0.7.0)。没有改为运行时读 package.json:宿主模块读包文件要么引入断言式 JSON import(Node 版本面收窄)要么 fs 读取(违背「查询串静态、零 IO」的模块气质),收益只是省一行同步维护。
2. **失效注释**:panelLede 的「(Phase 2)」指旧路线图的双向写回,与本次整改的「阶段 2」撞名易误读 → 改「(只读 Alpha,双向写回见路线图)」;「TODO 1.3」引用(阶段 4 已把 TODO.md 重写为路线图,1.3 编号不复存在)→ 改指 notes/dev-notes.md 差异 10。历史决策(Phase 1.2/差异 N 等开发阶段编号)保留原样 —— 它们指向 dev-notes 的既有事实,不是失效信息。
3. **国际化遗漏**:宿主 `mapBoard` 硬编码「全部/未分列/(无标题)」直接进渲染(英文用户看到中文列名)。改为**宿主发标记、浏览器查词典**:列 `{optionId:null, name:"", fallback:"all"|"unfiled"}`,卡 `title:""+untitled:true`;客户端 `columnDisplayName`/`Card` 用新键 columnAll/columnUnfiled/cardUntitled 渲染(zh/en 逐键对照检查保持通过)。取舍(记录为已知限制):宿主侧错误/提示文案(`token_missing` 消息等)仍是中文 —— 宿主半边没有 locale 面(浏览器词典经 ctx.locale 注册,宿主进程无对应服务),给宿主建 i18n 管道超出「轻量方式」边界;错误文案的可读性优先于可译性,排障文档(README 错误码表)以 code 为锚。`board.project.title` 的「(未命名项目)」兜底同理保留宿主侧(UI 不渲染该字段,无用户可见面)。

### 额外交接:smoke 夹具脱敏 —— 完成

阶段 4 agent 移交的 ~15 处个人仓库/登录名(`ThornWu/thornwu-com`、`ThornWu/thorn-agent`、`@ThornWu's …`、`"thornwu"` 登录名)全部替换为中性样例(`octocat/hello-world`、`octocat/Spoon-Knife`、`octocat/gone|bad|ok|alpha|beta`、`@octocat`),行为断言同步改写(如 owner/name 变量断言、`@octocat` 负责人断言),全部通过。lib/ 两文件经 grep 无个人名残留。

## 3. 用例变化说明(152 → 204)

- **152 个基线用例全部保留**(语义不变):其中 5 个**断言改写**(场景与数量不变,写法随契约更新):4 个 mapBoard 相关(「全部/未分列」列名断言 → fallback 标记断言,含新增 1 个 untitled 标记断言)+ 5c1d(contentMissing 断言加严为多因三要素)。改写原因均为 S2.9/S2.8 的**有意契约变更**,旧断言值(硬编码中文列名、单因文案)按设计不复存在。
- **新增 52 个**:S2.6 wire 契约 ×5、S2.7 查询片段 ×3 + 路由去重 ×5、S2.5 宿主完整性 ×4、5q 状态机 ×11、5r 控制器直驱 ×10、5s 契约校验 ×7、5t 渲染口径 ×6(含版本一致)。

## 4. 设计偏离与取舍(汇总)

1. **不拆宿主文件**(S2.1,见上)。
2. **控制器不感知 boardApi 身份变化**:组件经 `getApi()` 每渲染取最新引用,api 替换后续请求自然走新面;但**不会**像旧实现那样在 boardApi prop 身份变化时自动重跑启动链(旧实现 effect deps [boardApi] 的隐含行为,无测试覆盖)。真实 dsh 里 boardApi 在 apply 里创建一次、座位生命周期内身份稳定;若未来需要,在组件加一个 effect 调 `controller.reload()` 即可。
3. **部分失败 = ready 的 payload** 而非独立 phase(S2.3):保数据可用性,警告行点名来源。
4. **字段值截断只统计不追拉**(S2.5):提示「可能缺失」即满足可解释;追拉成本不成比例。
5. **projects_truncated 走 warning 通道**(S2.5)而非独立返回字段:与 repo_missing 同为来源级降级,渲染时按 code 分流到不同文案。
6. **internals 自检接缝**:client 模块导出多余键(`internals`)供 smoke 直驱数据控制层;已核对 dsh-client-modules 装载器只消费 apply/inject、导出对象原样存档,真机装载无影响。若未来删除该接缝,同步删 smoke 引用。
7. **宿主侧用户可见文案不做 i18n**(S2.9,见上):无宿主 locale 面,错误文案以 code 为锚走文档。
8. **incomplete 与 totalCount 双口径并存**:服务端总数可自证不完整时沿用「已加载 X / Y」(信息更足);总数缺席/自相矛盾时才降级到 incomplete 提示 —— 任何路径都不出现「假称全量」。

## 5. 工具限制与真机待验项(移交)

- 本阶段全部依据 dsh 0.2.0-rc.2 官方包**源码静态核验** + 替身测试;未做真实 GitHub 调用、未起真 dsh。
- 真机待验(并入阶段 5):(a) 查询新增的 `fieldValues/users/labels pageInfo{hasNextPage}` 字段真 schema 接受性(静态看是标准 connection 字段,风险低);(b) 控制器在真实 React(含 StrictMode)下的重挂载行为;(c) `internals` 导出键在真装载器的实际无害性(源码已核,留真机复核一行)。
- 阶段 1 遗留的真机项(ctx.timeout 存在性等)不变,见 phase1.md §7。

## 6. 给阶段 3(测试体系)agent 的衔接要点

1. **直驱入口已备好**:`mod.internals` 暴露 `boardTransition / createBoardController / coerce* / viewBoardState / selectTarget / isTransientFailure / projectKey / BOARD_PHASES`。S3.1/S3.2 的纯函数与服务测试应优先直驱这些(不经 React),smoke 5q/5r/5s 是现成范式;换真实 React 环境时组件测试(5c/5e–5p 的场景矩阵)可平移,断言大多与渲染树实现无关(textOf/findAll 已隔离)。
2. **mini-React 的已知差距不变**:effect 重跑间 cleanup 不执行(R06)—— 控制器化之后组件对 effect 语义的依赖已降到「一个订阅 effect + 一个卸载 cleanup」,真实 React 迁移风险比阶段 1 时小;但 5n(卸载)之外的 effect 生命周期用例仍需真实环境背书。
3. **新契约断言的意图**:S2.7 的「选择集逐字比对」与 S2.6 的 wire 规则镜像是**防漂移闸**,重构查询/wire 形状时红 = 预期信号,别为绿而删;S2.5 的 4+3 个完整性用例对应验收矩阵「超过读取上限或字段截断」行。
4. **行为矩阵对照**(计划 §3.7)本轮新增覆盖:「超过读取上限或字段截断」(S2.5 全组)、「单仓失败/全来源失败」既有 + sourceTruncated 分流;其余行(快照隔离/真机恢复等)归阶段 3/5。
5. 夹具已全部中性化(octocat/*);新增用例也沿用该口径。
