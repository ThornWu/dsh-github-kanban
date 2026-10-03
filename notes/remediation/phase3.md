# 阶段 3 整改记录:测试与 CI(S3.1–S3.7)

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线 HEAD `f6ad528`(工作区含阶段 1/2 的 lib/scripts 改动与阶段 4 的文档改动,本阶段在其上继续,未回退、未触碰他人独占文件)。

本阶段独占的新增/改动文件:

- `test/`(新建测试体系:helpers + 6 个套件文件 + react/ 子目录,92 用例)
- `.github/workflows/ci.yml`(CI 配置)
- `package.json`(scripts + devDependencies)
- `package-lock.json`(npm install 落盘,可复现安装)
- 本文件

**`scripts/smoke-load.mjs` 本阶段零改动**(204/204 基线原样保持,见 §5「smoke 未迁移」的决策说明)。禁止触碰清单(lib/、README 等前序阶段产物、git commit/push、真实 token/网络)全程遵守:服务与缓存测试全部注入 fetch/env 替身,React/dsh 测试用 jsdom + 网关信封替身,无一次真实 GitHub 调用。

## 0. 运行命令与结果(本地,Node v24.18.0,darwin 27.2.0 arm64)

```
npm test              # lint + smoke + unit + react + pack:check
  ├─ lint(node --check lib/index.js && node --check lib/client.js)  通过
  ├─ test:smoke   node scripts/smoke-load.mjs                       204/204 通过
  ├─ test:unit    node --test test/{pure,service,cache,contract,syntax}.test.mjs   74/74 通过
  ├─ test:react   node --test test/react/*.test.mjs                 17/17 通过
  └─ pack:check   npm pack --dry-run + 内容断言(test/pack.test.mjs) 1/1 通过
npm run test:strict   # --unhandled-rejections=strict 全量:
  ├─ node --unhandled-rejections=strict scripts/smoke-load.mjs     204/204 通过
  └─ node --unhandled-rejections=strict --test test/**(92 用例)    92/92 通过
```

合计:**296 项检查全部通过**(smoke 204 + 新体系 92);严格模式下同样全绿(迟到 Promise 无未处理拒绝;strict 标志向 test runner 子进程的传播已用探针用例验证 —— 未处理拒绝会使运行 exit 1)。

CI(`.github/workflows/ci.yml`)**未触发远端** —— 上述为本地同等命令通过,不能声称远端 CI 通过。CI 内容:Node 矩阵 [20, 22, 24] × `npm ci`(锁文件安装)+ `npm test` + `npm run test:strict`,独立 package job 跑 `pack:check`;只用公开 actions(checkout@v4 / setup-node@v4),`permissions: contents: read`,无任何 token/secrets 引用。

## 1. 测试体系选型(轻量优先的依据)

| 选择 | 理由 |
| --- | --- |
| **node:test**(Node 内置 runner) | 零新增依赖即得标准 runner(隔离进程、TAP、--test-name-pattern);不用 vitest/jest/mocha —— 本包运行时零依赖、浏览器单文件交付,引入测试框架全家桶与交付形态不成比例。devDependencies 只有 3 个(见下)。 |
| **react@18.3.1 + react-dom@18.3.1**(精确锁定) | R06 要求真实 React;版本**必须等于宿主注入版本**(核验见 §2)。精确锁定(pinned),不随 ^ 漂移。 |
| **jsdom@29.1.1**(精确锁定) | react-dom/client 需要真实 DOM(事件、style 注入、localStorage、可见性)。jsdom 是 react-dom 兼容性最稳的选择;不用 happy-dom/linkedom(rc 期兼容风险)也不用自制 DOM(重蹈「自制替身」覆辙)。29.1.1 的 engines `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0` 恰好覆盖 CI 矩阵(30.x 要 ≥22.22,会破坏 Node 20 格点,故取 29)。 |
| **自写虚拟时钟**(test/helpers/clock.mjs,~70 行) | 替代 sinon 假定时器。**作用面刻意最小化**:只替换 lib/client.js 沙箱里的 setTimeout 系与 ctx.timeout/ctx.interval 替身,React/react-dom/Node 本体的定时器全部真实 —— R06 点名要真实的部分(hook 语义、effect cleanup、卸载)不经过任何替身;被替换的只有时间维度(4s 自愈轮/30s 轮询/10-20s deadline),等价 jest.useFakeTimers 的作用面且更窄(不碰 Date/performance)。 |
| **vm.runInNewContext 装载 lib/client.js** | 忠实还原浏览器装载形态(window.__ModuleLoader__.load + factory(require("react"))),require 返回**真实 react 实例**(与 dsh 平台 seed「同一 React」的语义一致);smoke 的 mini-React 只留在 smoke 内部。 |
| **react-dom/client createRoot + React.act** | 真实调度、真实事件(jsdom dispatchEvent,非自制事件系统)、真实 effect 生命周期。act 来自 `react`(18.3 新 API,无 react-dom/test-utils 弃用警告)。 |
| 装配走**真实 apply(ctx) 链** | React 测试不是「直接 render 组件 + 假 props」,而是 mountRemote → scoped fiber 取面 → createBoardApi(信封拆包/deadline)→ 座位注册 → inject props → createRoot 渲染;face 替身只模拟网关 transport(返回 {ok:true,value} 信封)。替身边界收窄到 transport 与 timer 两个宿主服务。 |

已知跨 realm 细节:vm 沙箱产生的对象原型属另一 realm,`deepStrictEqual` 会拒内容相等的结构 —— jsonEqual(JSON 归一后严格比较,helpers/assertions.mjs)解决,不影响断言强度。

## 2. React 版本核验依据(测试所用 = 宿主注入版本)

**结论:测试用 React 18.3.1 = dsh 宿主实际注入的版本。** 核验链(只读,2026-10-03):

1. 宿主插件 `require("react")` 是平台 seed 词:dsh-cordis-client-runner/lib/client.js 第 29 行 `let react = require("react")`,dsh-client-modules 的 require 先查 seed 表 —— 即插件拿到的是**壳层同一实例**,版本由前端 bundle 决定;
2. dsh CLI 0.2.0-rc.2 的 web 前端由 `@deepseek-ai/dsh-web-frontend` 提供(devDeps `react ^18.2.0` / `@types/react ~18.3.1`,vite + @vitejs/plugin-react 构建);
3. 实际下发的 dist(`…@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-*.js`)内 bundled React 版本串为 **`"18.3.1"`**(grep `version:"18…"` 仅命中 18.3.1;`^18.2.0` 的解析结果);
4. 佐证:dsh-client-ui-brand-official 等 UI 包 devDeps 同为 `react ^18.2.0` + `@types/react ~18.3.1`(18.3.x 类型)。

因此 devDependencies 锁 `react@18.3.1` + `react-dom@18.3.1`(react-dom 的 version 与 react 同步)。宿主升级 dsh 时:重跑第 3 步 grep,若版本变动,同步改这两个 devDependency 并重跑 `npm run test:react`。

## 3. 任务映射表(S3.1–S3.7)

| 任务 | 状态 | 实现位置(均为本轮新建) | 用例数 | 结果 |
| --- | --- | --- | --- | --- |
| S3.1 纯函数测试 | 完成 | test/pure.test.mjs(projectKey/selectTarget/boardTransition/viewBoardState/coerce*/isTransientFailure 直驱 internals;mapBoard/extractStatusField/statusFieldHint/normalizeRepos 直驱宿主导出) | 23 | 通过 |
| S3.2 服务测试 | 完成 | test/service.test.mjs(GithubKanbanService,注入 fetchImpl/env/repos/requestTimeoutMs) | 21 | 通过 |
| S3.3 缓存测试 | 完成 | test/cache.test.mjs(cache.now 注入时钟) | 15 | 通过 |
| S3.4 React 测试(R06) | 完成 | test/react/board-lifecycle.test.mjs(9)+ test/react/prefs-retry.test.mjs(8);环境: test/helpers/react-panel.mjs + clock.mjs + load-client.mjs + fixtures.mjs | 17 | 通过 |
| S3.5 dsh 契约验证 | 完成 | test/contract.test.mjs(替身层全量;真实宿主项归阶段 5,见 §6) | 14 | 通过 |
| S3.6 标准命令及 CI | 完成 | package.json scripts(lint/test/test:smoke/test:unit/test:react/test:strict/pack:check);.github/workflows/ci.yml;test/syntax.test.mjs + test/pack.test.mjs | 1+1 | 通过 |
| S3.7 行为矩阵 | 完成 | 12 行逐行映射见 §4 | — | 10 行有自动化,2 行部分归阶段 5 |

各套件覆盖要点:

- **S3.1**:选择键跨 owner 不撞、selectTarget 四级优先级;状态机 11 类事件的边界语义(FAILED 保留数据/空列表清投影/BOARD_START 不动 phase/未知事件封闭);视图推导(tokenConfigured 三态、警告按 code 分流、boardMatchesSelection 门控、totalCount 双口径);coerce 三函数畸形矩阵 + warnings 规整;isTransientFailure 全 code 分类;宿主 mapBoard 缺失值/未知状态/坏字段值矩阵、Status 选项空数组口径、extractStatusField/statusFieldHint/normalizeRepos。
- **S3.2**:分页(列表 30/页游标拉全、看板 50×4 拉满)、排序与 closed 过滤、跨 owner 同编号三路路由 + 同 id 多仓去重、单仓 GraphQL 错/仓库缺席局部失败、HTTP 401 权限错误(信封无凭据)、全来源失败 all_sources_failed(点名来源)、畸形响应(nodes 非数组→shape_error、pageInfo 缺席保守取首页、projectV2 null→project_not_found、fields 缺席→单列+hint)、完整性(incomplete 不假称全量、contentMissing/fieldValuesTruncated 自诊断)、超时(悬挂 fetch abort、响应体悬挂分阶段文案、in-flight 出队后可恢复)、网络错误脱敏、token 只进 Authorization 头。
- **S3.3**:projects 60s / board 15s TTL、noCache 双路强拉、默认 maxBoards=8 的 LRU(写入序、读不续命)、缓存键含 repo、并发 in-flight 去重(强刷独立键)、失败不缓存(板+列表)、token 指纹轮换失效(且指纹不进任何返回值)、强刷竞态单调写(板+列表,先发起的慢请求不覆盖后发起强刷)。
- **S3.4(核心,R06 兑现)**:见 §4 矩阵行展开;关键场景 —— 首载失败→刷新按钮整链 noCache 恢复;ctx.remote 缺席→面板错误态非挂死;两项目正常渲染(列序/空列/负责人/标签/计数);快速切换慢响应不覆盖+加载期旧板退位;卸载(轮询注册释放、迟到回包无渲染、错误态自愈定时器取消);页面后台跳过轮询/回前台恢复(真实 defaultIsVisible);gateway/internal 两次后自愈;偏好延续/仅存选择键/旧 snapshot/v1 清理不上屏/30 天到期/时钟前漂/失配不落盘/畸形 JSON;**status 成功+列表持续瞬态失败的 15 轮封顶 + 手动刷新重置后再封顶(真实定时器语义,虚拟时钟推进)**;**StrictMode 双挂载(effect cleanup 真实执行)后状态收敛、轮询注册恰好 1 个**。
- **S3.5**:注册形态({id,factory}/零副作用/包名一致/inject 恰好四服务/死锁红线)、双座位属性、zh/en 逐键对照、远程清单 3 direct 方法对照 registry 客户端规则(端点段字符/strict/codec)、scoped fiber 双名恰好一次、信封 {ok,value} 拆包(成功拆/失败透传/垃圾→shape_error)、有界等待 deadline 到期+迟到回包不改结果、服务缺席三态(remote 缺失/面缺方法/$mount 抛错)、重连(载波失败→boardApi→控制器自愈,不经 React)、宿主 apply 发布服务+v1 标记冻结+日志无凭据。
- **S3.6**:七个标准命令;CI 无 token、npm ci 锁定安装、Node 20/22/24 矩阵 + strict 步骤 + 独立 package job;pack:check 断言分发清单恰为 5 文件(README/cordis.patch.yml/lib×2/package.json),test//scripts//notes/ 等开发产物不混入,client.js 以完整源(>30KB)交付。

## 4. S3.7 行为矩阵逐行映射(计划 §6 表格)

| # | 场景 | 自动化证据(用例) | 真实环境记录 |
| --- | --- | --- | --- |
| 1 | 缺 token、无效 token、权限不足 | 缺 token→引导视图:react「样式/引导」用例 + smoke 5b + contract(S3.5 服务缺席系列) + pure(coerceStatus);无效 token(HTTP 401)→http_error:service「HTTP 401」;权限不足→graphql_error 警告+contentMissing 提示:service「FORBIDDEN」「contentMissing」;凭据不泄漏:service「token 只进 Authorization 头」「401 信封」+ smoke 4/4b/4c/4g;恢复路径:react「首载失败→刷新恢复」 | 真实 PAT 三态归阶段 5(S5.5) |
| 2 | 单仓失败 / 全来源失败 | service「局部失败」「全来源失败」;UI 侧:react 服务缺席 + smoke 4l/5k | — |
| 3 | 请求悬挂、响应体悬挂 | service「悬挂 fetch abort」「响应体悬挂」「取消与恢复」;客户端 deadline:contract「有界等待」(20s 到期/迟到忽略);smoke 4i/4j/5p | 真实网关链路的取消效果归阶段 5 |
| 4 | status 成功、列表持续瞬态失败 | **react「重试上限」(真实 React+真实定时器语义)**:15 轮封顶后推进 60s 零新请求;手动刷新重置后再封顶;smoke 5c1f2/5r 场景 3 为同语义替身侧 | — |
| 5 | 无快照首次加载失败 | react「首载失败」(错误态+按钮在场+noCache 整链重拉恢复);smoke 5i | — |
| 6 | 快速切换、响应倒序 | react「快速切换」(慢响应拦截→切回→放行,旧响应不覆盖;加载期旧板退位);smoke 5c3/5m | — |
| 7 | 同 origin 换身份 | react「偏好延续/仅存选择键」「旧 snapshot/v1 清理不上屏」;缓存身份隔离:cache「token 轮换」;smoke 5c1c/4n;结构保证:本地只存选择键,业务数据无持久化路径 | 真浏览器双身份实测归阶段 5(可选) |
| 8 | 项目关闭、删除、权限变化 | 关闭过滤:service「排序与 closed 过滤」;删除后选择失配→占位提示:smoke 5c4 + pure(selectTarget 失配);列表可恢复:react「首载失败→刷新」(刷新=列表+看板整链) | — |
| 9 | 超过读取上限或字段截断 | service「分页拉满上限→incomplete」「contentMissing/fieldValuesTruncated」;列表 projects_truncated:smoke 4(S2.5 场景 4)+ 5t;渲染口径(不假称全量):smoke 5t + pure「总数口径」 | — |
| 10 | 页面后台、恢复前台、卸载 | 后台/前台:react「可见性」(真实 defaultIsVisible + 真实 interval 注册);卸载:react「卸载清理」×2(轮询释放/迟到回包/自愈定时器取消/零遗留调度);smoke 5f/5n 为替身侧 | 真浏览器 tab 后台策略归阶段 5 |
| 11 | 宿主重启、网络中断后恢复 | 替身侧:react「重连」(gateway/internal×2→自愈,无错误残留)+ contract「重连」(boardApi→控制器链);分类依据:pure「isTransientFailure」 | **真实宿主重启归阶段 5(S5.5)**:真网关重启窗口、真 ctx.timeout/interval 存在性 |
| 12 | 有卡项目与至少两个项目切换 | react「正常渲染」(两项目、列序=Status 选项序、空列、@负责人、标签、总数口径、切换重拉);数据真实性 | **内容与 GitHub 实际一致归阶段 5(S5.3:≥2 项目、≥1 有卡,核对列序/标题/负责人/标签/计数)** |

小结:12 行中 10 行已有自动化证据;第 1/11 行的「真实凭据/真实宿主」半边与第 12 行的「数据与真实来源一致」必须真机,列为阶段 5 待验收(S5.3/S5.5)。

## 5. smoke-load.mjs 未迁移的决策说明

计划允许「把生命周期用例迁到真实 React 环境时同步删改替身用例」;本阶段选择**不迁移、不删改**(smoke 保持 204/204):

1. smoke 的职责按计划 §6 保留(包声明与加载契约检查),其 mini-React 用例同时是快速回归网(零依赖、~2s)——真实 React 套件是行为权威,替身套件是廉价哨兵,重复成本低(无维护双份产品代码,只有测试双份)。
2. R06 的验收要点是「不得再以自制 hook 模拟**证明**真实 React 行为」——新体系的 S3.4 已用真实 React 覆盖生命周期证明;保留替身用例不构成「以替身证明」,且两者断言口径一致时可互为漂移告警。
3. 避免 smoke 变动波及其他阶段的交接基线(阶段 1/2 的记录都以 204 用例为锚)。

若后续要收敛重复:候选删除清单为 smoke 5c3/5c1c/5c1c2/5c1f2/5i/5m/5n/5o(均有 S3.4 真实 React 等价),删除时应保持 ≥204 的验收口径不被破坏(需以新增用例补齐数量或修订口径)。

## 6. 替身与真实宿主边界(S3.5 的明确划分)

**用替身(本阶段已自动化)**:dsh 装载器行为(window.__ModuleLoader__/require seed)、slots/locale/remote 服务本身、网关 transport(信封形状 {ok,value})、timer Service(ctx.timeout/ctx.interval —— 虚拟时钟,形状对齐 cordis「返回 dispose 函数」契约)、DOM(jsdom)。

**需真实宿主,列为阶段 5 待验收**:

1. dsh-client-modules 真装载器对 `internals` 导出键的无害性(phase2 §5 已源码核验,留真机复核);
2. dsh-api-gateway 真编解码与 SRC 描述符生成(手写清单被真 registry 接受);
3. cordis scoped fiber 的服务等待语义($mount 自装服务时序);
4. 真实 timer Service 的 ctx.timeout/ctx.interval 存在性与返回形状(阶段 1 的遗留待验项);
5. 真浏览器里的座位渲染、事件与面板卸载(dsh-client-ui-layout keyed 卸载);
6. 真实网络中断/宿主重启窗口的恢复路径;真实 PAT 的三态行为。

## 7. 已知限制与移交

1. **CI 未在远端运行**:workflow 已就位且本地同等命令通过;首次推送后观察一次 Actions 运行(预期 Node 20/22/24 × test + strict + package 共 4 个 job)。
2. **测试用时**:react 套件 ~4s(重试上限用例占大头,虚拟时钟推进 15×2 轮);unit+cache+contract+syntax ~0.5s;smoke ~1.5s;pack:check ~1s;全套 `npm test` ~7s(本地实测)。
3. **devDependencies 的 Node 面**:react/react-dom 无 Node 版本要求;jsdom 29.1.1 要求 `^20.19.0 || ^22.13.0 || >=24.0.0` —— **开发/测试需 Node ≥20.19**(包运行时 engines >=18 不受影响,lib/ 不依赖 jsdom)。此差异建议阶段 4 agent 在 README「开发测试入口」补一句(该文件不在本阶段权限内)。
4. 阶段 1 遗留真机项(ctx.timeout 存在性等,phase1.md §7)与阶段 2 遗留真机项(phase2.md §5)不变,统一归阶段 5。
5. test/pack.test.mjs 断言 client.js 以完整源交付(>30KB);若未来 client.js 显著瘦身,阈值需同步调整(目前 ~70KB)。
