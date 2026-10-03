# 第二轮整改记录:文档修正(DOCSFIX)

日期:2026-10-03。本轮目标:修复审查提出的 2 条 P2 文档问题——CONTRIBUTING.md 测试要求段诱导开发者跳过新增测试(把 smoke 当「唯一自动化入口」)、SECURITY.md 数据边界描述与代码实际行为不符(仍声称浏览器存整板快照)。

本 agent 独占改动文件(未触碰其他任何文件,未 commit/push):

- `CONTRIBUTING.md`
- `SECURITY.md`
- 本文件

## 0. 修正前的现场核验(2026-10-03,本机 Node 24)

```
npm test   # lint 通过 + smoke 204/204 + unit/契约 74/74 + react 17/17 + pack:check 1/1,全绿
node scripts/smoke-load.mjs   # 204/204 通过(未装依赖路径同样可跑)
```

package.json:`scripts.test` = `lint && test:smoke && test:unit && test:react && pack:check`;devDependencies 恰好 3 个(react 18.3.1 / react-dom 18.3.1 / jsdom 29.1.1);`engines.node >= 18`(运行时),开发/测试受 jsdom 29 约束需 Node ≥ 20.19(notes/remediation/phase3.md §3)。

## 1. P2-1:CONTRIBUTING.md 测试要求段(原 19–25 行)

**原文问题**

> - 环境:Node ≥ 18(开发验证于 Node 24),无需 `npm install`(零依赖)。
> - **改了行为就必须带测试**:`scripts/smoke-load.mjs` 是当前唯一自动化入口(零依赖、替身 React)。……

两个失真:(a)「无需 npm install / 零依赖」——阶段 3 已引入 node:test 体系(3 个 devDependencies,Node ≥ 20.19),开发前必须 `npm ci`;(b)「smoke 是当前唯一自动化入口(替身 React)」——照此口径,新增行为只要 smoke 够不着就可以不带测试,且真实 React 18.3.1 套件(test/react/)的存在被抹掉,等于诱导开发者跳过新增测试。

**修正后表述**(要点)

- 「本地开发」代码块改为 `npm ci` + `npm test`;环境行改为「运行时零依赖、Node ≥ 18;开发/测试需 Node ≥ 20.19 + npm ci(与运行时零依赖不冲突)」;smoke 降格为「未装依赖也能跑的快速冒烟」。
- 「测试要求」首条改为:**`npm test` 是贡献前置门槛**,并列出全量体系构成(lint + smoke + `test/*.test.mjs` 单元/契约 + `test/react/` 真实 React + pack:check)。
- 保留「改了行为就必须带测试;修 bug 先红后绿」,并补套件选择指引:纯函数/服务/缓存 → `test/pure|service|cache.test.mjs`;组件生命周期 → `test/react/`(真实 React,不是替身);装载契约 → `test/contract.test.mjs` + smoke。
- smoke 重定位为「快速回归网**之一**,不是唯一自动化入口」;真实 dsh / GitHub 链路全程替身的边界与「真机验证说明附 PR(脱敏)」原样保留。
- 「文档同步 README/CHANGELOG」条原样保留。

**依据(代码位置)**

- `package.json`:`scripts.test` / `test:smoke` / `test:unit` / `test:react` / `pack:check`(全量体系的命令构成);`devDependencies`(react/react-dom/jsdom 三个);`engines.node: ">=18"`。
- `test/` 目录:`pure.test.mjs` / `service.test.mjs` / `cache.test.mjs` / `contract.test.mjs` / `syntax.test.mjs` / `pack.test.mjs` 与 `test/react/`(board-lifecycle / prefs-retry)——套件选择指引的落点。
- `scripts/smoke-load.mjs`:零依赖(只用 node 内置模块)、mini-React 替身,故「未装依赖也能跑」仍成立。
- 参考口径:`README.md`「开发与测试」(npm ci / npm test / Node ≥ 20.19 差异)、`notes/remediation/phase3.md`(测试体系选型与 296 项检查)。

## 2. P2-2:SECURITY.md 数据边界(原「凭据处理模型」节第 3 条)

**原文问题**

> - 浏览器本地快照只含看板业务数据(公开元数据),不含凭据;无 `localStorage` 的环境自动降级。

描述的是 0.5.0–0.7.0 的旧行为。阶段 1(S1.1/R01,2026-10-03)已**移除整板快照**:现在浏览器侧 localStorage 只存项目选择偏好,业务数据不再离开宿主内存。安全文档声称「本地快照含看板业务数据」与实际数据边界相反,会误导用户与审计者对本地留存面的判断。另:宿主侧「内存缓存 + token 指纹隔离」的边界原文完全未提。

**修正后表述**(要点,节名改为「凭据与数据边界」)

- token 两条保留(唯一入口 = 宿主环境变量;错误脱敏含截断边界;浏览器只见布尔),补一句「token 只进宿主发出的 GitHub API 请求头,不出现在任何返回给浏览器的数据里」。
- 浏览器侧:localStorage **只**存项目选择偏好——键 `@local/thorn-github-kanban/prefs/v1`、内容仅 `{ savedAt, selectedKey }`、30 天到期;**不含任何看板业务数据,更不含凭据**;0.5.0–0.7.0 的整板快照键 `snapshot/v1` 已于 0.8.0 移除、首次加载自动清理;无 localStorage 自动降级。
- 宿主侧(新增):缓存(项目列表 TTL、看板 LRU)只存在于进程内存,不落盘、重启即清;条目按 token 指纹隔离(轮换后旧缓存未命中);缓存值只有公开业务元数据,token 永不进缓存键/值;浏览器不直连 GitHub,请求一律由宿主经 GitHub API 代取。
- 「报告安全漏洞」节的**私密渠道待定标注原样保留**(未擅自补任何真实渠道)。

**依据(代码位置)**

- `lib/client.js` §3「本地偏好(0.8.0,S1.1/R01 重设计)」:`PREFS_KEY = "@local/thorn-github-kanban/prefs/v1"`;`writePrefs` 只写 `{ savedAt, selectedKey }`;`PREFS_MAX_AGE_MS = 30 天`;`readPrefs` 到期校验(含时钟前漂防御);`LEGACY_SNAPSHOT_KEY` + `purgeLegacySnapshot()`(bootstrap 首次运行无条件清除旧整板快照);`syncPrefs` 失配键不落盘;读写全 try/catch 静默降级(无 localStorage 环境)。
- `lib/index.js` §5 `GithubKanbanService`:缓存全部为实例内存字段(`projects` 单条 + `boards: Map`,无任何持久化路径,重启即清);`projectsTtlMs` 60s / `boardTtlMs` 15s / `maxBoards` 8 LRU(写入序淘汰);`tokenFingerprint()`(sha256 截断 16 字符)与条目 `fp` 比对隔离,指纹「不进任何返回值、日志或浏览器」。
- `lib/index.js` §2:`readToken()` 唯一入口 `process.env.GITHUB_TOKEN`;`ghGraphQL` 中 token 仅进 `Authorization` 头;`sanitizeError()` 全量替换 `[redacted]` 且处理截断边界残留前缀;`status()` 只回 `tokenConfigured` 布尔。
- `lib/client.js` §1/`createBoardApi`:浏览器经 remote 面调宿主服务,无任何直连 GitHub 的 fetch。
- 参考口径:`README.md`「权限说明」「排障·本地存储行为」(0.8.0 快照移除与旧键清理的用户面描述)、`notes/remediation/phase1.md` §2 R01(设计取舍:隐私优先于首屏提速)。

## 3. 未改动说明

- CONTRIBUTING.md 其余部分(项目状态与边界、提交与 PR、问题反馈)与现状相符,原样保留;「零依赖、无构建」在「项目状态与边界」中的表述本就限定为「不引入任何 npm **运行时**依赖」,仍然成立。
- SECURITY.md 的「支持范围」「报告安全漏洞」「收到含凭据的材料怎么办」三节逐句核对无失真,原样保留。
- README / CHANGELOG / package.json 等其他文件本轮无权限,未触碰。
