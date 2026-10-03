# 第三轮整改(浏览器半边):CLIENTFIX 记录

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,工作区未提交(含并行 HOSTFIX agent
的宿主半边改动,见 round3-host.md;本文只覆盖浏览器半边的 1×P2)。

审查结论(PR #3,036413f→79fe587):**P2 看板轮询会掩盖项目列表刷新失败**
(lib/client.js:882-887)。修复 + 回归测试。

独占改动文件(本轮):

- `lib/client.js`(boardTransition 的 BOARD_START / BOARD_OK / FAILED 三转换按 error.stage
  门控;syncPolling 与转换表注释同步)
- `scripts/smoke-load.mjs`(R3 回归:5r 场景 8/9 控制器直驱 + 5r2 转换层门控,共 +14 检查)
- `test/react/board-lifecycle.test.mjs`(R3 节 4 用例)
- 本文件

未触碰:lib/index.js、test/cache.test.mjs、test/service.test.mjs(HOSTFIX 独占);
pure/pack/syntax/contract 测试、package.json、helpers(本轮无需改动)。

## 0. 结果一览

| 项 | 级别 | 状态 | 红证据(修复前必失败) | 修复位置 |
| --- | --- | --- | --- | --- |
| 轮询的看板成功掩盖链级失败 | P2 | 已修 | react 3 用例红 + smoke 6 检查红(§1) | boardTransition:BOARD_OK 门控 |

测试数字:`npm test` 全绿 —— smoke **227**(基线 213,+14 为本轮)、unit 84(基线 81,
+3 来自并行 HOSTFIX 的 cache 测试,非本人改动)、react **24**(基线 20,+4 为本轮)、
pack 1;合计 **336**。`npm run test:strict` 同全绿(smoke 227 + node --test 109,
`--unhandled-rejections=strict` 下无未处理拒绝,exit 0)。**既有用例零改写**(§5)。

## 1. 缺陷机理与复现(红)

### 1.1 机理(已核实)

`syncPolling` 的 30s 回调只做 `loadBoard(target)`(重拉当前看板),注册条件是
`tokenConfigured === true && projects.length > 0` —— 不看 phase,错误期保持注册。场景:

1. 面板健康(projects 非空、看板在场);
2. 用户点「刷新」→ 整链 `bootstrap({noCache:true})` → **listProjects 瞬态外 503**
   → `FAILED(stage:"list")` → error 态,但 `state.projects` 仍是旧列表(START 保留数据);
3. 30s 到,轮询照常触发 → `getBoard` 成功 → **两步掩盖**:
   - `BOARD_START` 先把 `error` 置 null(phase 仍 error,错误文案先行消失);
   - `BOARD_OK` 无条件 `phase: ready + error: null` → 列表刷新失败从 UI 彻底消失。

列表停在旧数据,用户以为一切正常 —— 看板成功把列表级失败「部分成功化」。

**第二个入口(审查未点名,同一缺陷)**:错误期工具栏常驻(R05),旧列表非空时切换器
在场;用户在 list 级错误期切换项目 → `select()` → 同样走 `loadBoard` → 同样被
`BOARD_OK` 翻 ready。门控做在转换函数里可以同时覆盖两个入口。

**掩盖的第二变体(修 BOARD_OK 时必须一并堵)**:list 级错误期轮询的 `getBoard`
失败 → `FAILED(stage:"board")` **顶替**根因错误(stage 变 board)→ 下一轮看板成功
就能「合法」清错 —— 列表级失败从另一条路被掩盖。

### 1.2 红(修复前实跑)

react(`node --test test/react/board-lifecycle.test.mjs`,R3 节 4 用例中 3 红 1 绿):

- 「R3 掩盖:刷新后 list 503,轮询的看板成功不得清错/翻 ready」红于
  `afterTick.includes("读取失败")` —— 推进 30s 虚拟时钟、`getBoard` 确实成功
  (`boardCalls.length === 2`)后面板文本已是健康看板,错误消失(掩盖实锤);
- 「R3 掩盖(切换路径)」红于同型断言(切换器入口);
- 「R3 根因优先」红于 `after.includes("503")` —— 错误文案已被顶替成看板 401;
- 「R3 保留路径(board 级错误期的轮询成功仍恢复)」绿 —— 旧实现本就允许该路径,
  该用例是防门控误伤的守卫,新旧实现都必须绿。

smoke(把 lib/client.js 临时还原到 79fe587 重跑,再复原;226 中恰好红 6,无误伤):
控制器直驱 2 条 —— tick 成功后快照 `phase=ready`(掩盖)、tick 失败后
`stage="board", text=…401…`(顶替);转换层 4 条 —— `FAILED(list)→BOARD_OK` 得
`phase=ready`、`FAILED(list)→BOARD_START` 得 `error=null`、`FAILED(list)→FAILED(board)`
得 `stage="board"`、`FAILED(status)→BOARD_OK` 得 `phase=ready`。其余 220 条
(含 R2 全部、轮询超时恢复 5l、错误态工具栏 5g)不受影响。

## 2. 方案论证

任务给出两个候选:a) `BOARD_OK` 按 error.stage 门控;b) list 级错误期轮询回调改跑整链
`runBootstrap()`。**选 a,并对同一规则补齐 BOARD_START / FAILED(board) 两处**
(只门控 BOARD_OK 会留下 §1.1 的两步掩盖与顶替变体,b 不覆盖切换器入口)。

选 a 弃 b 的理由:

1. **缺陷本质是「单看板成功被提升为全局成功」,修在提升点(纯转换函数)是唯一事实源**。
   轮询、错误期切换、未来任何新的 loadBoard 调用点,都被同一门控覆盖;b 只改轮询回调,
   切换器入口照样掩盖。
2. **b 与 syncRetry 语义打架**:瞬态 list 错误已有 4s×15 整链自愈(R04),轮询再跑整链
   纯属叠加油耗;非瞬态错误 R04 明确决策「达上限停止、别空转」(retryCount 15 封顶),
   b 等于给非瞬态错误开一条永不封顶的 30s 整链重试车道,违背该记录在案的取舍。
3. **b 有叠发风险**:轮询触发的整链与在途的自愈整链并发(inFlight 只看板请求,不管链),
   要满足「不得叠发」需再引入链级在途守卫,diff 与推理面都变大;a 不改任何请求模式
   (节奏仍单一 interval + inFlight 节流),天然满足「无界请求/叠发」约束。
4. **恢复路径语义**:任务明言错误保持到「整链成功或用户手动刷新」。a 之下这两个入口
   原样工作(整链 START 先清错进 loading;手动 reload 同理),board 级错误的轮询恢复
   按审查结论保留 —— 不需要 b 提供第三条恢复路径。

status 级纳入门控的理由:看板成功同样证明不了 status 健康,与 list/bootstrap 同属
「链级」;smoke 转换层检查单独钉住该 stage。

**BOARD_START 的门控形态是「只清 board 级错误」而非「一律不清」**,原因有二:
一是 board 级错误本就是看板请求自己的失败,新请求在途、旧失败文案让位是既有口径
(pure.test.mjs S3.1 钉住 `FAILED(board)→BOARD_START→error:null`,该文件本轮禁改,
见 §5);二是链级错误若在发起时被清,BOARD_OK 的门控就再也看不到它(先清后判 =
门控失效),所以链级错误必须原样保留到链级事件(START/LIST_OK/TOKEN_GUIDE/完整
BOARD_OK)才有清错点。

## 3. 修复(lib/client.js boardTransition)

三个转换,规则一句话:**链级(status/list/bootstrap)错误在场时,看板请求的生命周期
事件(发起/成功/失败)动不了全局 phase/error;board 级错误不受影响。**

```js
case "FAILED": {
  // 根因优先:链级错误在场时,board 级失败不顶替(否则下一轮看板成功就能「合法」清错)
  if (state.phase === ERROR && state.error !== null && state.error.stage !== "board" && event.stage === "board") {
    return { ...state, boardInFlight: false };
  }
  /* …原样… */
}
case "BOARD_START": {
  const chainErrorActive = state.phase === ERROR && state.error !== null && state.error.stage !== "board";
  return { ...state, boardInFlight: true, ...(chainErrorActive ? {} : { error: null }) }; // 只清 board 级
}
case "BOARD_OK": {
  const accounting = { board, boardKey, totalCount, incomplete, boardInFlight: false };
  if (state.phase === ERROR && state.error !== null && state.error.stage !== "board") {
    return { ...state, ...accounting }; // 看板数据照常上账,phase/error 保持 —— 不掩盖
  }
  return { ...state, phase: READY, error: null, ...accounting };
}
```

要点:

- **看板数据照常上账**(任务候选 a 的原文口径):它是当前选中项目的真实回包,链恢复后
  无需重复等待;错误期看板区本就不上屏(viewBoardState 的 `showBoardArea` 排除 error
  phase),数据在场不影响渲染 —— `viewBoardState()` 与渲染分支**无需配合改动**
  (错误优先级仍最高,react 用例断言错误期无 AlphaColumn/BetaColumn)。
- **整链恢复不经门控**:链总是从 START(清错进 loading)走到 BOARD_OK,此时 phase 是
  loading 不是 error,走正常 ready 分支;smoke「链内(loading 期)BOARD_OK 照常进
  ready」钉住这一点。
- **重试预算不受影响**:门控不触碰 BOOTSTRAP_DONE/RETRY_TICK/RETRY_RESET;错误期轮询
  成功不归零预算(只有完整链成功才归零,R04 语义原样)。
- **请求模式零变化**:轮询注册条件、30s 节奏、inFlight 节流、可见性跳过全部不动 ——
  「不得引入无界请求或叠发」由构造满足。

## 4. 绿(修复后)

- react 24/24:R3 三用例转绿(错误在两个 tick 后仍可见、手动刷新整链恢复、切换器不
  清错、根因不被 401 顶替),保留路径用例保持绿;
- smoke 227/227:5r 场景 8(健康→list 503→tick 成功不清错且数据上账→tick 失败不
  顶替→手动刷新恢复)、场景 9(board 级错误轮询恢复保留)、5r2 转换层 7 检查
  (list/status/board/loading 四种在场态 × 三事件);
- `npm test` 全绿(smoke 227 + unit 84 + react 24 + pack 1 = 336;unit 的 +3 是并行
  HOSTFIX 的 cache 测试),`npm run test:strict` 全绿(exit 0)。

## 5. 用例变化说明

**既有用例零改写、零删除。** 新增:react 4(R3 节)、smoke 14(场景 8×5、场景 9×2、
5r2×7)。唯一接近冲突的既有用例是 pure.test.mjs S3.1「BOARD_START 清错误但不动
phase」—— 它驱动的是 `FAILED(stage:"board")`,与本轮保留的 board 级让位口径一致,
按 stage 门控后不经修改转绿(该文件本轮禁改,门控形态也因它收窄为「只清 board 级」,
见 §2)。

## 6. 相邻发现(只报告,未修)

1. **链级错误期的轮询仍每 30s 拉一次不可展示的看板**:单 interval、可见性门控、
   inFlight 节流,有界但零收益(链恢复时整链会重拉看板,期间上账的数据用不上)。
   可考虑链级错误期停轮(syncPolling 条件加 stage 判断,链恢复的 START 会自动重注册);
   本轮保留是为了让审查点名的复现场景(轮询 tick → getBoard 成功 → 错误仍在)以
   同机制红→绿,并把「停轮」作为独立行为变化留给下轮论证。
2. **轮询在途期间刷新按钮被禁用**(`disabled: boardInFlight`,round2 §7.2 的既有项):
   链级错误期一次轮询看板请求会把用户唯一的恢复入口(手动刷新)禁用至多 20s(deadline),
   而该请求的结局无论如何都清不了错 —— 与发现 1 同根,停轮即可一并消除。
3. **loading 期轮询与链内看板请求的窄窗并发**:轮询在链尚未走到 loadBoard 时 tick,
   可能与链自己的看板请求并发一次(≤2,loadSeq 收口,后发者胜)。修复前后行为一致,
   非本轮引入。
4. round2 §7.1(dispatch 在 disposed 检查前落状态)与 §7.3(call() 参数展开的潜在
   误用点)仍然成立,未在本轮处理。
