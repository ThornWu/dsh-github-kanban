# 第二轮整改记录:宿主缓存/去重(HOSTFIX,三项)

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线为当日全绿的工作区(未提交),
`npm test` = smoke 204 + unit 74 + react 17 + pack 1 = 296 全绿(动手前已复跑确认)。

改动文件(仅限本 agent 独占范围):

- `lib/index.js`(GithubKanbanService 的 dedupe/listProjects/getBoard,约 763–902 行)
- `test/cache.test.mjs`(新增「R2host」区块 5 个用例)
- 本文件

方法:先红后绿 —— 每项先在当前代码上写出复现用例、确认失败,再修,修完全绿。
身份轮换用注入 env(`{ GITHUB_TOKEN }` 可变对象)模拟,在途时序用手动放行闸
(`deferred()`)替代 sleep 赌调度,时钟用 `cache.now` 注入冻结。

## 0. 修复总览(三处改动,一个共同结构)

三个问题共享同一处结构病灶:`listProjects`/`getBoard` 在进入 `dedupe()` **之前**就把
所有决策量(序号、指纹)取好,而指纹又在**回填时**重新取。修复后的统一形状:

1. 指纹在**调用发起时**捕获一次(`const fp = this.currentFingerprint()`),命中校验、
   去重键、写入盖章整链用同一个值;
2. 去重键纳入指纹:`projects[:force]:<fp>` / `board:<repo#N>[:force]:<fp>`;
3. 序号 `startSeq` 只在 `dedupe` 的 produce **首次执行**(即真正发起请求)处分配,
   加入既有在途的调用 `startSeq` 保持 0、不回填缓存;
4. `listProjects` 缓存**整个成功信封**(含 `warnings`),命中原样返回。

## 1. P1 在途请求仍能跨身份复用

### 复现序列(修复前红,`test/cache.test.mjs` R2host-P1 两个用例)

用 `deferred()` 闸挂起首个 fetch,精确控制时序:

1. 身份 A(`GITHUB_TOKEN = r2-inflight-A`)调 `listProjects()` → 在途(键 `projects`,无指纹);
2. 在途期间把 `env.GITHUB_TOKEN` 换成身份 B(身份切换);
3. 再调 `listProjects()` → 修复前:dedupe 键仍是 `projects` → **加入旧身份的在途 Promise**;
4. 放行首个请求 → 两个调用都拿到 A 的数据;且回填时 `fp: this.currentFingerprint()`
   取的是**完成时**的指纹(B)→ **A 的数据被打成 B 的标签**;
5. 第三次调用(当前身份 B)→ TTL 命中假 fp → 继续吐 A 的旧身份数据。

修复前实测红(`node --test test/cache.test.mjs`):

- `R2host-P1 在途隔离:listProjects…`:fetchCount actual **1** / expected 2(新身份没另起请求);
- `R2host-P1 在途隔离:getBoard…`:同样 actual 1 / expected 2;
- 命中吐旧身份数据的断言(actual「身份A的项目」/「身份A的卡」)。

### 修复位置

`lib/index.js`:`listProjects`(约 844–868 行)与 `getBoard`(约 877–902 行):

- `const fp = this.currentFingerprint()` 移到方法开头(发起时捕获,整链一致);
- 去重键 `` `projects${force ? ":force" : ""}:${fp}` `` /
  `` `board:${key}${force ? ":force" : ""}:${fp}` ``;
- 回填盖章 `fp`(局部常量),不再在 `.then` 续段里现取 `this.currentFingerprint()`。

### 修复后绿证据

两个 R2host-P1 用例转绿:fetchCount = 2(新身份另起请求)、发起者拿 A 数据、新身份
拿 B 数据、第三次调用命中吐 B 数据(条目按发起时身份盖章)。类注释(§5 缓存边界)
与 `dedupe` JSDoc 同步成文「键必须含指纹」。

### 取舍

- 缓存条目 Map 键(`repo#N`)**不加**指纹 —— 命中校验已按 `fp` 比对,条目键保持稳定
  可让 smoke 既有断言(`boards.has("octocat/alpha#3")` 等)与 LRU 记账不受身份切换
  干扰;同一键下新身份数据靠单调写覆盖旧条目。
- 在途期间轮换后,旧身份在途的**返回值**仍是它发起时身份的数据(不重发)—— 这是
  「发起时身份」语义的自然结果;关键不变量是:新身份不搭车、缓存不被错标。

## 2. P2 去重调用仍可使缓存回退(加入者序号)

### 复现序列(修复前红,写在用例注释里并实测)

force 与非 force 是不同去重键、可同时在途:

1. **t0** 调用 A(普通)发起 `board:#7`,闸住不放行,`startSeq=1`;
2. **t1** 强刷 F(`noCache`)发起 `board:#7:force`,独立在途,`startSeq=2`;
3. **t2** 调用 B(普通)到达:缓存仍空(F 未回填)→ dedupe 命中 A 的在途条目,B 加入,
   但 B 已分到自己的 `startSeq=3`(比 A、F 都晚);
4. **t3** 放行 F → F 回填 `{seq:2, NewCol}`(缓存里是新数据);
5. **t4** 放行 A → 旧结果回包:A 自身被单调守卫挡下(`existing.seq=2 > 1`);
   而 B 的守卫是 `existing.seq(2) <= B.startSeq(3)` → **成立**,B 把 A 的旧结果
   (OldCol)盖进缓存 —— 后发起强刷写入的新数据被回退;
6. **t5** TTL 内读缓存 → 拿到 OldCol。

修复前实测红:`R2host-P2 加入者单调性`:cached actual **'OldCol 的卡'** / expected 'NewCol 的卡'。

### 修复位置

`lib/index.js`:序号分配从 `dedupe()` 之前移进 produce 闭包(真正发起处):

```js
let startSeq = 0;
const result = await this.dedupe(`board:${key}…:${fp}`, () => {
  startSeq = ++this.cache.opSeq;   // 只有首个发起者执行到这里
  return getBoardImpl(request, this.deps);
});
if (result.ok && startSeq > 0) { /* 只有发起者回填 */ }
```

`dedupe` 对加入者只返回既有 Promise、不执行加入者的 produce → 加入者 `startSeq`
保持 0、既不写缓存也不触发容量淘汰。`listProjects` 同型。produce 经
`Promise.resolve().then(produce)` 排队,同 tick 内多个发起者的取号顺序 = 调用顺序
(微任务 FIFO),单调性依据不变。

### 修复后绿证据

用例转绿:缓存里是 `NewCol 的卡`,且 `call === 2`(B 加入在途不另发请求,去重语义
保留)。既有 15 个 S3.3 缓存用例(含两个强刷竞态用例)不经修改全部通过。

### 取舍

- 选择「序号移进 produce」而非「dedupe 返回 `{promise, initiated}`」:前者不动 dedupe
  的函数签名与调用方结构,diff 最小;`startSeq === 0` 即「我是加入者」的判定局部可见。
- 加入者**返回值**仍是它所加入请求的结果(可能比缓存旧)—— 去重的固有语义,本次
  只修「缓存被回退」;返回值新鲜度的代价由加入者自己承担(下一个轮询/刷新自愈)。

## 3. P2 缓存命中仍丢失来源警告(listProjects)

### 复现序列(修复前红)

配置 `repos: ["octocat/gone"]`,fetch 替身对该仓返回 `{ data: { repository: null } }`
(repo_missing 来源警告),viewer 正常返回一个项目:

1. 第一次 `listProjects()` → `{ok, projects, warnings: [{source: "octocat/gone",
   code: "repo_missing", …}]}`(面板提示有仓库失败);
2. 第二次 `listProjects()`(TTL 内)→ 修复前:缓存只存了 `result.projects`,命中路径
   现拼 `{ok: true, projects: hit.value}` → **warnings 消失**,面板不再提示。

修复前实测红:`R2host-P2 命中保真:listProjects…`:second.warnings actual **[]** /
expected `['octocat/gone[repo_missing]']`。

### 修复位置

`lib/index.js` `listProjects`:缓存值从 `result.projects` 改为整个成功信封
`{ value: result, … }`,命中路径 `return hit.value`(与 `getBoard` 命中路径同型)。

### 修复后绿证据(含 getBoard 核对)

- listProjects 用例转绿:第二次调用 warnings 原样保留、projects 保留、`noCache`
  强拉回填的也是整信封;
- **getBoard 核对**(审查点名「顺带核对」):boards 本就存整个 result,新增核对性用例
  `R2host-P2 命中保真:getBoard…` 钉住 totalCount=5 / fetchedCount=1 /
  board.contentMissing=1 / board.fieldValuesTruncated=1 在命中时全保留。该用例在
  **修复前后都是绿的**(核对确认,非复现),作为防回归闸保留。

### 取舍

- 命中返回与首次调用**共享同一信封对象引用**(不再每次拼新对象)—— 与 getBoard
  既有语义一致;浏览器侧对结果只读,不构成实际风险,已知限制记录在案。

## 4. 用例与测试数字

- `test/cache.test.mjs` 新增 5 个用例(R2host 区块):P1 × 2、P2 加入者 × 1、
  P2 命中保真 × 2(其一为 getBoard 核对性用例)。全部手动闸控时序,无真实网络/凭据。
- 最终数字:`npm test` = lint + smoke **204** + unit **79**(74+5)+ react **17** +
  pack **1** = **301 全绿**;`npm run test:strict`(unhandled-rejections=strict)
  = smoke 204 + 97(79+1+17)全绿,0 fail。
- 兼容性核对:仓库内对宿主缓存内部的其他引用只有 `inflight.size`(smoke 763、
  service.test 319)与 `boards` Map 键 `repo#N`(smoke 859/860/1107–1109)—— 本次
  只改**在途去重键**格式,二者均不受影响(smoke 204/204 复跑通过即证据)。

## 5. 相邻问题(只报告,未扩 scope 修)

1. **指纹捕获与 impl 取 token 之间的微任务窗口**:`fp` 在调用时捕获,而
   `listProjectsImpl`/`getBoardImpl` 在 produce 微任务里才读 token。若身份恰在这个
   亚毫秒窗口内轮换,结果会以旧指纹入册(数据实属新身份)。后果有界:错标条目因 fp
   不匹配不会被当前身份命中,只会成为死重等 TTL 过期/被覆盖;只有「token 在窗口内
   翻转又在 TTL 内翻回」这种极端序列才可能错拿。要彻底消除需把 token 快照穿透进
   impl(改 `ghGraphQL` 签名),超出本次最小 diff 边界,留档。
2. **加入者返回值可能旧于缓存**(见 §2 取舍):去重语义固有,缓存单调后由轮询自愈。
3. **命中返回共享引用**(见 §3 取舍):调用方原地改写返回信封会污染缓存;当前唯一
   调用方(浏览器控制器)只读,与 boards 既有语义一致,未加防御性拷贝(拷贝与
   「秒回缓存」的初衷相悖)。
