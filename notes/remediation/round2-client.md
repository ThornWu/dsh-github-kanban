# 第二轮整改(浏览器半边):CLIENTFIX 记录

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,工作区未提交(含阶段 1–4 与并行
HOSTFIX agent 的宿主半边改动;本文只覆盖浏览器半边的 1×P1 + 3×P2)。

独占改动文件(本轮):

- `lib/client.js`(createBoardApi 参数契约 / 控制器代际守卫 / 渲染分支来源警告提升)
- `scripts/smoke-load.mjs`(面替身参数数量闸 + R2 回归网:213 用例)
- `test/contract.test.mjs`(参数契约 2 用例;makeCtx 面替身过闸)
- `test/helpers/fixtures.mjs`(strictArgumentFace / manifestArities 共享闸)
- `test/helpers/react-panel.mjs`(mountPanel 面替身过闸)
- `test/react/board-lifecycle.test.mjs`(R2 三用例)
- `test/react/prefs-retry.test.mjs`(1 处断言改写,见 §5)
- 本文件

未触碰:lib/index.js、test/{cache,service,pure,syntax,pack}.test.mjs、package.json、
README(均属并行 agent 或前序阶段;宿主行为以其当前工作区实现为准,只读核验)。

## 0. 结果一览

| 项 | 级别 | 状态 | 红用例(修复前必失败) | 修复位置 |
| --- | --- | --- | --- | --- |
| 1. 首载违反 Remote 参数数量契约 | P1 | 已修 | contract「参数数量」×2(另连带既有 3 用例红,见 §1.3) | lib/client.js createBoardApi 返回面 |
| 2. 重挂载后接受卸载前响应 | P2 | 已修 | react「R2 代际」+ smoke 5r 场景 5 | 控制器 epoch 代际守卫 |
| 3. 整链刷新缺请求顺序保护 | P2 | 已修 | react「R2 链序」+ smoke 5r 场景 6/7 | 同上(reload 领新代) |
| 4. 空列表隐藏失败来源 | P2 | 已修 | react「R2 空列表」+ smoke 5j2 | GithubKanbanBody 渲染分支 |

测试数字(我的独占范围):smoke 204 → **213**;contract 14 → **16**;react 17 → **20**。
`npm test` 全绿(lint + smoke 213 + unit 81 + react 20 + pack 1;unit 里 cache 15→20 的
+5 来自并行 HOSTFIX agent,非本人改动);`npm run test:strict` 同样全绿
(smoke 213 + node --test 102,`--unhandled-rejections=strict` 下迟到 Promise 无未处理拒绝)。

## 1. P1:首载违反 Remote 参数数量契约(lib/client.js createBoardApi)

### 1.1 dsh 源码核验结论(2026-10-03,只读)

对本机 `@deepseek-ai/dsh` 0.2.0-rc.2 内嵌 monorepo 逐条核验(与 phase2.md §S2.6 的
既往记录互补 —— 既往核验集中在**服务端**与清单形状,本轮补上了**客户端调用侧的数量判定**):

| 判定层 | 源码位置 | 规则 | 对本包的结论 |
| --- | --- | --- | --- |
| 客户端调用侧(关键缺口) | `@deepseek-ai/dsh-api-gateway/lib/client.js` `prepareInvocation`(约 1817 行) | `expected = descriptor.parameters.length`(取自**本包 $mount 的清单**);`values.length !== expected && !hasCallerSignal` 即抛 `client api: <endpoint> expected N argument(s), got M`。**精确相等比对,无任何 undefined 宽容**;计数依据是清单形参数量,不是宿主函数的 `fn.length`(调用时宿主函数根本还没参与) | 清单声明 listProjects/getBoard 各 1 参 → 必须以恰好 1 个实参调用;0 实参 → 调用 promise 拒绝 → boardApi 折成非瞬态 `remote_error` → 首载/自动重试(都不带 request)全挂 |
| 客户端 wire 组装 | 同上 `prepareInvocation` 后半 | `if (value !== void 0) args[parameter.wire] = value` —— 显式传 `undefined` 不算错(数量对),但 wire 上**省略该键** | `{}` 是合法且明确的 wire 形状(空对象过 src-json 边界校验) |
| 服务端数量/字段 | `dsh-api-gateway/lib/index.js:1497`(及 types/index.js:1128)`assertExactArguments` | args 必须普通对象;声明的 wire 键须在场,**除非**参数 `source==="json"` 且(`acceptsUndefined===true` 或 `codec.mode==="src-json"`)才允许缺席;拒未知顶层键 | 服务端 SRC 描述符(宿主 mark() 推导)参数恒 src-json → wire 键缺席服务端**本可容忍**;但客户端数量判定在前,轮不到这层宽容 —— 所以修 client 侧数量是唯一正解 |
| 宿主签名推导 | `dsh-api-gateway/lib/index.js` `methodParameterNames`(约 1480 行) | Function.toString 解析参数表,**仅简单标识符**;默认参数/rest/解构 → `gateway/signature-invalid` 直接拒 | 宿主方法不可能靠 `request = {}` 默认参数表达「可选」;「可选参数」在 wire 上不存在数量宽容,这是把 `fn.length` 问题转化为清单形参数量问题的根因 |

结论(已写进 lib/client.js createBoardApi 注释):**客户端按清单形参数量做精确数量
判定,声明 1 参的方法必须恒传恰好 1 个实参;请求缺席补 `{}`**(宿主读
`request?.noCache`,与 `undefined` 同义;`{}` 还能明确上 wire)。

### 1.2 修复

`lib/client.js` createBoardApi 返回面:

```js
status: () => call("status"),
listProjects: (request) => call("listProjects", request ?? {}),
getBoard: (request) => call("getBoard", request ?? {}),
```

(status 恒 0 实参与清单 `method("status", [])` 一致;call() 内部的
`...(args === undefined ? [] : [args])` 保持不变 —— 数量契约的执行点集中在返回面。)

### 1.3 先红后绿证据

红(修复前,`node --test test/contract.test.mjs`):

- 新用例「参数数量:首载与刷新链的 listProjects 调用恒以恰好 1 个实参到达远程面」
  失败:面替身收到的实参计数是 `listProjects:0`;
- 新用例「参数数量:数量替身与真网关同严」失败,失败消息**逐字重现真网关错误**:
  `{"ok":false,"error":{"code":"remote_error","message":"Error: client api: githubKanban/listProjects expected 1 argument(s), got 0"}}`
  —— 即真机首载的实际表现(非瞬态、不自动重试);
- 把面替身过闸(strictArgumentFace)后,**既有 3 用例**也红:「信封拆包」「畸形返回
  shape_error」「重连自愈」—— 它们此前绿恰恰因为替身不校验数量(审查判断成立)。

绿(修复后):contract 16/16;react 全部(见 §6 首次中间运行:修复 P1 后 react 既有
17 用例全绿,R2 三用例仍红 —— 红/绿分层可分离)。

### 1.4 防漂移闸(S2.6 精神:替身至少与真网关同严)

- `test/helpers/fixtures.mjs` 新增 `strictArgumentFace(face, arities)`(数量不符抛与
  网关同文案的错,动态查原 face 现值,缺席方法保持缺席 → remote_missing 路径不变)
  与 `manifestArities(contribution)`(数量口径取自 $mount 清单,与网关客户端计数同源);
- `test/helpers/react-panel.mjs` mountPanel 与 `test/contract.test.mjs` makeCtx 在
  scoped fiber 交付面处统一过闸 —— **全部 react/contract 用例从此都在真网关数量规则
  下运行**,client 侧回退到 0 实参调用时整套先红;
- `scripts/smoke-load.mjs` 同型 `withArgContract`(数量口径取 mountedContributions[0],
  清单缺席时透传),应用于主 apply 的 remoteFaceStub 与 5p applyWithStubs 的面替身,
  并加 2 条自证检查(0 实参必抛 / 恰好 1 实参放行)。

## 2. P2:重挂载后接受卸载前响应(start(),lib/client.js)

### 复现(红)

`test/react/board-lifecycle.test.mjs`「R2 代际:StrictMode 双挂载后,卸载前在途的旧链
列表回包不得清空新链状态」:真实 StrictMode 双挂载(setup → cleanup(dispose) →
setup(start)),第 1 条链的 listProjects 回包被 gate 拦住;第 2 条链立即拿到两项目并
渲染;随后放行第 1 条链的回包(内容为**空列表**)。修复前:第 1 条链在
`await Promise.all` 后只检查 `disposed` —— 已被重挂载翻回 `false` —— 继续走完,
`LIST_OK(projects: [])` 把新链刚立好的列表/看板/选中全部清空,面板回退「暂无项目」。
断言 `after.includes("AlphaColumn")` 失败(actual: false),红于用例第 50 行。
smoke 5r 场景 5(控制器直驱,dispose → start 重挂载 → 放行旧链空列表)同红。

### 修复

控制器引入**链代数 epoch**(与既有 loadSeq 正交):

- `dispose()`:`epoch += 1`(卸载即换代 —— 即便之后重挂载把 disposed 翻回 false,
  卸载前的链也按旧代作废);
- `runBootstrap()`:`const chainEpoch = ++epoch` —— 每轮新链(start 首挂/重挂载、reload、
  自愈轮重试)都领新代,旧链在途结果一律作废;
- `bootstrap(chainEpoch, options)`:两个 await 续体(Promise.all 之后、delay 退避之后)
  检查 `disposed || chainEpoch !== epoch`;末尾 `BOOTSTRAP_DONE`(重试预算归零)同样
  只属于当前链 —— 旧链的成功不得给新链重置预算;
- `runBootstrap` 的异常兜底(catch → FAILED unexpected)同按 chainEpoch 收口;
- `loadBoard()`:发起时捕获 `boardEpoch`,回包判 `boardEpoch !== epoch || seq !== loadSeq`
  双守卫(epoch 管链间,loadSeq 保留管同代内的快速切换先后)。

StrictMode 双挂载语义保持:新链正常工作(渲染新链数据、选中一致、轮询恰好 1 个),
由既有 StrictMode 用例 + 新 R2 用例共同断言。

### 绿

react「R2 代际」通过;smoke 5r 场景 5 两条检查通过;既有 StrictMode 用例通过
(其中 1 处断言按有意行为变化改写,见 §5)。

## 3. P2:整链刷新缺请求顺序保护(reload(),lib/client.js)

### 复现(红)

react「R2 链序:手动刷新整链完成后,首载链迟到的空列表不得回退刷新链的新状态」:
首载链列表被拦(面板读取中,刷新按钮可用)→ 点击刷新 → 新链立即完成(两项目 +
看板渲染)→ 放行首载链的空列表回包。修复前:旧链继续走完,`LIST_OK([])` 回退新链
状态为「暂无项目」,断言失败于用例第 89 行。smoke 5r 场景 6(控制器直驱同型)同红。

另一子场景(看板窗口):reload 已换代但新链尚未发起看板请求时,旧链看板回包到达
—— 此时 loadSeq 未被推进,**仅靠原有发起序号守卫拦不住**(审查判断成立)。smoke
5r 场景 7 钉住:换代后旧链看板不落账(phase 保持 loading、board 为 undefined),新链
列表放行后新链看板上账。(此场景经 UI 不可达:看板在途期间刷新按钮 disabled
(boardInFlight),故用控制器直驱覆盖 —— 见 §7 相邻问题。红的是窗口检查「不落账」;
场景 7 的终态断言在新旧实现下都收敛,单靠终态测不出该窗口。)

**红证据的实证口径**:react 三用例与 contract 两用例均在修复前实跑确认失败(失败
消息分别见 §1.3/§2/§3/§4)。smoke 的 R2 检查因先修后写,以「临时把 epoch 判定还原
为修复前语义(仅禁用代际守卫,渲染修复保留)重跑 smoke」实证:213 中恰好红 3 条 ——
场景 5 后半(重挂载旧链清空新链)、场景 6 后半(刷新旧链回退)、场景 7 窗口(旧链
看板落账),其余 210 条(含 P2-4 的渲染检查)不受影响,无误伤。

### 修复

与第 2 项统一收口:`reload()` → `runBootstrap({noCache:true})` 天然 `++epoch`,
旧链(status/list/board 一切续体)按代作废,不需要 reload 专属逻辑。

### 绿

react「R2 链序」通过;smoke 5r 场景 6/7 四条检查通过;既有「首载失败→刷新恢复」
「快速切换」等用例不经修改全绿(刷新仍带 noCache、切换守卫语义不变)。

## 4. P2:空列表仍隐藏失败来源(渲染分支,lib/client.js)

### 复现(红)

react「R2 空列表:viewer 0 项目 + 来源失败/截断时,『暂无项目』分支也显示来源警告」:
face 返回 `projectsResult([], [repo_missing, projects_truncated 警告])`。修复前渲染文本
只有「viewer 名下没有可显示的 Projects v2 项目。」—— 来源警告两行只在
`view.showBoardArea` 分支渲染,`showNoProjects` 分支完全看不到。断言失败于第 112 行。
smoke 5j2(mini-React 渲染,与 5k 非空列表路径对照)同红。

### 修复

`GithubKanbanBody` 把 failedSources / truncatedSources 两个警告段落**提升为非 error 分支
的独立渲染**(showNoProjects 与 showBoardArea 共用;error 分支不并排 —— 错误文案本身
已点名 stage/code;引导分支不涉及 —— token 未配置时无列表)。`viewBoardState()` 无需
改动:failedSources/truncatedSources 本就无条件从 state.warnings 推导(LIST_OK 空列表
分支保留 warnings),缺的只是渲染位置。看板区原有渲染顺序与文案逐字不变。

### 绿

react「R2 空列表」通过(空态提示 + 「部分项目来源读取失败:octocat/gone」+
「列表可能不完整」三要素在场);smoke 5j2 通过;既有 5k(非空列表警告)、5t(完整性
渲染口径)不变。

## 5. 用例变化说明

- **smoke 204 → 213**(+9):参数闸自证 ×2、5j2 空列表警告 ×1、5r 场景 5/6/7 共 ×6。
  既有 204 条全部保留、未改写。
- **contract 14 → 16**(+2):参数数量 ×2;既有用例仅替身过闸,断言零改动。
- **react 17 → 20**(+3):R2 代际/链序/空列表;另有 **1 处既有断言有意改写**:
  prefs-retry「StrictMode 双调用」中 `boardCalls >= 2` 改为 `boardCalls === 1`。
  原因:代际守卫后,卸载的旧链在首个检查点(status/list 回包后)即被作废,**不再
  发起多余的看板请求** —— 旧实现是「两条链都拉看板、靠结果序号丢弃」,新实现连
  请求都省了。这是本轮有意的行为变化(减少一次注定作废的网络请求),非测试放水:
  该用例其余断言(statusCalls ≥ 2、最终渲染一致、轮询恰好 1 个)原样保留并通过。

## 6. 取舍与边界

1. **数量契约执行点在 createBoardApi 返回面,而非 call() 内部**:清单是数量的唯一
   事实源,返回面是对清单的直接映射;call() 保持 `args===undefined ? 0 参` 的通用形。
   若未来新增带参方法,漏写 `?? {}` 会被三个层面的严格替身(contract/react/smoke)立刻
   打红 —— 防漂移闸即为此设。
2. **epoch 与 loadSeq 并存**:loadSeq 保护同代内看板请求先后(快速切换),epoch 保护
   链与链之间(重挂载/刷新/自愈新一轮)。二者判据不同(请求粒度 vs 链粒度),合并成
   一个计数器会把「切换退位」与「整链作废」两种语义耦死,反而难推理。
3. **dispose 换代 + runBootstrap 换代双保险**:start() 重挂载本身会 runBootstrap 领新代,
   dispose 的 `epoch += 1` 严格说冗余,但让「卸载后一切在途作废」不依赖「重挂载必然
   发起新链」这层隐含推理,守卫各自局部成立。
4. **错误分支不并排来源警告**(第 4 项):错误文案已带 code/stage,再叠来源行会双重
   归因;空列表/看板区两分支共享警告行是「数据可用但降级」语义的正确边界。
5. **替身过闸是全局性的**(react-panel/makeCtx 在交付面处统一包装):这意味着这些
   套件里的每一次 face 调用都在真网关数量规则下运行 —— 升级 dsh 时若网关规则变化,
   先核验 fixtures.mjs 的闸注释与 strictArgumentFace 文案是否需同步(升级清单见
   notes/dev-notes.md)。
6. smoke 的 5c/5e–5p 组件场景仍直接传 boardApi 双打(不经 createBoardApi),数量闸
   在那些场景不生效 —— 数量契约的权威闸在 contract(直驱真实 createBoardApi)与
   react(真实 apply 链);smoke 主 apply 与 5p 亦过闸兜底。

## 7. 相邻问题(只报告,未修)

1. **dispatch() 在 disposed 检查之前就落状态**(`state = boardTransition(state, event)`
   先执行,`if (disposed) return` 在后):当前所有调用路径都被入口守卫或 epoch 拦住,
   不可达;但守卫顺序与直觉相反,未来新增 dispatch 调用点时是隐患。建议下轮把
   disposed 检查提到转换前(或断言不可达)。
2. **轮询在途期间刷新按钮被禁用**(`disabled: boardInFlight`):看板请求在途(含 30s
   轮询刷新)时用户无法手动刷新,极端情况(宿主悬挂至 20s deadline)按钮最长禁用
   20s。属既有 UX 取舍,与本轮四项无关。
3. **`call()` 的 `...(args === undefined ? [] : [args])` 形参展开**仍是数量契约的潜在
   误用点(见 §6.1)—— 已由严格替身闸兜住,但若日后有人在返回面之外新增调用路径,
   建议把数量校验下沉进 call() 本身。
4. 宿主侧(lib/index.js)空列表 + repo_missing 的组合是否真能产生(即 P2-4 场景在真机
   的可达性)取决于宿主 listProjectsImpl 的来源合并逻辑 —— 本轮以 fixtures 的 wire
   形状为契约(宿主 warnings 结构与 coerceProjectsResult 规整一致),真机可达性归
   HOSTFIX/阶段 5 验证。

## 8. 真机待验(并入阶段 5)

- 真网关下首载 `listProjects({})` 的实际接受性(源码已核,留一行真机复核);
- StrictMode/面板切换(真 dsh-client-ui-layout keyed 卸载)下的代际守卫表现;
- 严格替身闸与真实 dsh-api-gateway 升级后的规则同步(见 §6.5)。
