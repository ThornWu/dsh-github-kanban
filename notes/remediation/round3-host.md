# 第三轮整改记录:凭据快照 —— 指纹与请求凭据同刻一致(HOSTFIX,P1)

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线 HEAD 79fe587(PR #3 审查结论:
P1 固定了指纹,但未固定实际请求凭据)。动手前已复跑 `npm test` 确认基线:
smoke **213** + unit **81** + react **20** + pack **1** = **315 全绿**。

改动文件(仅限本 agent 独占范围):

- `lib/index.js`(§2 sanitizeError/ghGraphQL、§3 pageAll、§4 listProjectsImpl/getBoardImpl、
  §5 credentialSnapshot/listProjects/getBoard)
- `test/cache.test.mjs`(新增「R3host」区块 3 个用例)
- 本文件

方法:先红后绿 —— 先在当前代码上写出复现用例、确认失败,再修,修完全绿。
身份轮换用注入 env(`{ GITHUB_TOKEN }` 可变对象)模拟;本轮**不需要** deferred 闸或
sleep —— `dedupe` 的 produce 挂在 `Promise.resolve().then(...)` 微任务上,「服务方法
同步段结束、微任务尚未执行」本身就是一个确定的翻转窗口(正是 round2-host §5.1 所说
「亚毫秒窗口」的确定性放大)。

## 1. 问题机理(PR #3 审查实锤的 P1)

`listProjects`/`getBoard` 在调用时捕获 `fp = this.currentFingerprint()`(token=A 的
指纹),但 produce 闭包执行 `listProjectsImpl(this.deps)` / `getBoardImpl(request,
this.deps)`,其内部 `ghGraphQL(query, vars, deps)` 在**执行时**才 `readToken(env)`。
指纹标签与实际请求凭据不是同一时刻的值:

```
捕获 fp(A) → [微任务窗口] → produce 执行 → ghGraphQL 读到 token(B) →
用 B 的凭据拉回数据 → 结果以 fp(A) 盖章入缓存 → 后续持 A 的调用命中缓存拿到 B 身份的数据
```

这正是 round2-host.md §5.1 留档的相邻问题被第三轮审查升级为 P1:缓存身份隔离的
前提是「指纹描述实际使用的凭据」,而旧代码里这个描述只在捕获刻为真。

## 2. 复现(红)

`test/cache.test.mjs` 新增 R3host 区块 3 个用例(修复前实测红,`node --test
test/cache.test.mjs` = 20 pass / **3 fail**):

1. **getBoard 轮换窗口**:`service.getBoard(...)` 返回后(同步段已按 A 捕获指纹、
   produce 已排队未执行)立刻把 `env.GITHUB_TOKEN` 换成 B,再 await。fetch 替身记录
   实际收到的 Authorization 并按该身份生成数据。红证据:
   `actual: 'Bearer r3-board-token-B' / expected: 'Bearer r3-board-token-A'`
   —— 请求凭据与盖章指纹分属两刻;且轮换回 A 后 TTL 内命中吐出「身份B的卡」
   (B 凭据的数据被盖上 A 的指纹)。
2. **listProjects 轮换窗口**:同型,`actual: 'Bearer r3-list-token-B'`。
3. **tokenMissing 早退误报**:发起时有 token、微任务窗口内 `delete env.GITHUB_TOKEN`
   → 旧代码在 `listProjectsImpl` 早退里重读环境得到空,误报 `token_missing`
   (`result.ok: false !== true`)。

## 3. 修复(最小 diff)

统一原则:**标签(指纹)必须描述实际使用的凭据** —— 服务方法入口一次取
「凭据快照」`{ token, fp }`(同刻、由同一 token 值算出),token 逐层穿透到真正发
Authorization 的地方;fp 继续担任命中校验/去重键/写入盖章(键格式与 R2host 完全
一致,未动)。

### 穿透路径清单(token 从捕获点到 ghGraphQL 的每一跳)

| 跳 | 位置(lib/index.js 当前行号) | 说明 |
| --- | --- | --- |
| 0 捕获 | `credentialSnapshot()`(839);调用点 listProjects 871 / getBoard 907 | `readToken(deps.env ?? process.env)` + `tokenFingerprint(token)` 同刻同值;`currentFingerprint()` 重构为本 helper(仓库内无其他引用,grep 核实:仅原 848/881 两处自用) |
| 1 闭包带入 | produce 闭包 `listProjectsImpl(this.deps, token)`(884)/ `getBoardImpl(request, this.deps, token)`(916) | token 可能是 null(快照时就没 token)—— **undefined 才表示「未快照」**,null 明确表示「快照时缺失」 |
| 2 impl 入口 | `listProjectsImpl(deps, token)` 445–449:解析 `credential`,tokenMissing 早退按快照判定;`getBoardImpl(request, deps, token)` 554:透传 | 直接调用(自检)不传 token → undefined → 在 impl/ghGraphQL 执行时读 env,维持原行为与「deps.env 仅自检注入,生产回退 process.env」口径 |
| 3 分页循环 | `pageAll(..., token)`(393)第 6 参,viewer 与各仓两路 pageAll 都带 | 翻页多页请求全程同一份凭据(不只在首页) |
| 4 实际请求 | `ghGraphQL(..., token)`(219)226:解析 `credential` → Authorization 头(241) | 唯一读 env 的分支是 `token === undefined` 的回退;解析后局部量定死,函数其余部分不再读环境 |
| 5 错误面 | `sanitizeError(cause, credential)` ×5 处(超时/网络/响应体/graphql_error) | 脱敏对准**实际发出**的凭据:错误面里可能出现的正是本次请求的 token;错误时刻环境里「最新」的 token(轮换后的新值)从未进过这次请求,拿它脱敏反而会漏掉真正要抹的旧值 |

### 配套判断(按「每次调用口径自洽」原则)

- **`status()`(829)不并入快照体系**:它是即时探针(`tokenConfigured` 描述「此刻」,
  结果不缓存、无跨时刻不变量),直接读就是自洽口径;强行驶入快照链反而引入一个
  「快照与返回之间的窗口」的伪问题。
- **`tokenFingerprint()`(§2 纯函数)不动**:输入 token 输出指纹,无时刻概念;
  「同刻」由 credentialSnapshot 的调用点保证。
- **`apply()` 启动日志的 `readToken()`** 同 status():启动时刻的即时口径,不缓存。

## 4. 绿证据

- `node --test test/cache.test.mjs`:23/23(20 旧 + 3 新 R3host);
- `npm test`:lint + smoke **213** + unit **84**(81+3)+ react **20** + pack **1**
  = **318 全绿**(R2host 5 用例与 S3.3 既有 20 用例无回归,语义未变);
- `npm run test:strict`(unhandled-rejections=strict):smoke 213 + 105(84+1+20)
  全绿,0 fail。
- 兼容性核对:smoke-load.mjs 以 3 参调 `ghGraphQL`(477/499/516/532/552/751/775/1368),
  第 4 参缺省回退原行为,213/213 复跑通过即证据;dedupe 键格式、命中校验、单调写
  (`startSeq`)、LRU 记账(`boards` Map 键 `repo#N`)均未改。

## 5. 取舍

- **undefined vs null 的二值语义**:快照链上 undefined=「调用方未快照,执行时读 env」
  (直接调用/自检面),null=「快照时就没有 token」(明确早退,不重读 —— 重读又是
  另一个时刻,正是本 P1 的病灶)。readToken 的返回值域恰好就是 string|null,无需
  新信封。
- **不把 token 放进 deps 传递**:deps 是服务级注入面(fetchImpl/env/repos/超时),
  按调用次的凭据混进去会模糊「deps = 配置面」的边界,且要防共享对象被污染;
  显式尾参把「这是本次调用的凭据」表达成类型可见的事实。
- **快照 token 只穿透到 ghGraphQL/sanitizeError,不进缓存值/日志/返回值**:隐私
  红线不变;缓存里存的仍然只有 fp(单向散列)。
- **sanitizeError 签名改 (error, token)**:属快照穿透的自然收尾(见上表第 5 跳),
  非扩 scope —— 旧行为(env 此刻值脱敏)在回退路径下逐字节等价,快照路径下严格
  更正确(抹的是真正发出的那个凭据)。

## 6. 相邻发现(只报告,未扩 scope 修)

1. **浏览器半边(lib/client.js)不涉及本问题**:凭据只在宿主半边读取,client 经
   remote 面只传业务参数;本轮无需动它(并行 agent 在其范围内工作)。
2. **`apply()` 启动日志口径**:激活日志报「token 已配置与否」读的是 process.env
   此刻值,与服务首请求的快照可能不同刻(启动到首次请求之间轮换)。日志只输出
   布尔不输出值,无泄露面;且「启动时配置了但后来被清空」本就该由 status()/请求
   的即时口径报告,不视为缺陷。
3. **加入者返回值可能旧于缓存**(R2host §5.2 遗留):去重语义固有,未变。
4. **命中返回共享引用**(R2host §5.3 遗留):调用方只读,未加防御性拷贝,未变。
