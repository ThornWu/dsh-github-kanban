# 阶段 1 整改记录:隐私与可靠性(S1.1–S1.9 / R01–R05)

日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线 HEAD `f6ad528`(工作区另有其他并行 agent 对 package.json / TODO.md / cordis.patch.yml / 文档的改动,本阶段未触碰)。

改动文件(仅限本阶段独占范围):

- `lib/index.js`(宿主半边)
- `lib/client.js`(浏览器半边)
- `scripts/smoke-load.mjs`(自检体系扩展)
- 本文件

运行命令(零依赖,只用 node 内置模块):

```
node scripts/smoke-load.mjs                    # 152/152 通过
node --unhandled-rejections=strict scripts/smoke-load.mjs   # 同样 152/152(迟到 Promise 无未处理拒绝)
node --check lib/index.js && node --check lib/client.js      # 语法检查通过
```

环境:Node v24.18.0,darwin 27.2.0 arm64。React/dsh 仍为替身(见「已知限制」)。

## 1. 任务映射表

| 任务 | 状态 | 实现位置 | 测试位置(scripts/smoke-load.mjs) |
| --- | --- | --- | --- |
| S1.1 / R01 快照隐私 | 完成 | lib/client.js:255–299(偏好读写+旧键清理)、617–625(bootstrap 清旧快照/读偏好)、721–727(偏好写回) | 5c1c(1256)、5c1c2(1297) |
| S1.2 / R02 宿主超时+取消 | 完成 | lib/index.js:157–181(withTimeout)、189–235(ghGraphQL 建连/响应体双阶段超时+abort) | 4i(702)、4j(728)、4k(742) |
| S1.2 / R02 客户端有界等待 | 完成 | lib/client.js:319–343(withDeadline)、345–390(createBoardApi 三段 deadline)、901–912(apply 的 ctx.timeout 优先/全局回退) | 5p(1779,五场景)、5l(1647) |
| S1.3 / R02 in-flight 清理 | 完成 | lib/index.js:709–720(dedupe settle 后核对身份再出队) | 4k(742) |
| S1.4 / R03 局部失败 | 完成 | lib/index.js:358–366(absent 标记)、388–456(listProjectsImpl 分来源收集+警告+all_sources_failed);UI:lib/client.js:533、658、810–812 | 4l(764,三场景)、5k(1624) |
| S1.5 / R04 重试上限 | 完成 | lib/client.js:611–675(bootstrap 仅完整成功归零;loadBoard 返回结果)、697–701(手动刷新重置预算)、706–719(自愈轮定时器防叠) | 5c1f2(1356,R04 复现)、5o(1746)、5c1f(1339,原场景保留) |
| S1.6 / R05 恢复入口 | 完成 | lib/client.js:779–803(工具栏常驻:错误/空列表也有刷新按钮)、697–701(刷新=整链重拉列表+看板,带 noCache) | 5i(1572)、5j(1604) |
| S1.7 选择/看板一致 | 完成 | lib/client.js:527、577(boardKey 记账)、773、817–825(上屏门控+加载期退位)、549–586(既有请求序守卫保留并加固) | 5m(1677)、既有 5c3(快速切换/响应倒序)保留通过 |
| S1.8 卸载清理 | 完成 | lib/client.js:588–602(卸载兜底:重试定时器+轮询注册)、734–758(轮询注册 ref 收口,防重复注册) | 5n(1711);mini 运行时补 unmount():scripts/smoke-load.mjs:64–67、127–135 |
| S1.9 缓存边界 | 完成 | lib/index.js:146–149(token 指纹)、660–699(cache 配置)、700–703(指纹门控)、723–743(projects 单调写)、745–765(boards LRU+单调写) | 4m(839)、4n(859)、4o(885)、4p(917) |

## 2. 确认缺陷复核(R01–R05)

每一项都验证过「修复前会失败」:方法是把基线 lib 文件 stash 回工作区后跑新测试(命令:`git stash push -q lib/index.js lib/client.js && node scripts/smoke-load.mjs`,验完 `git stash pop`)。

### R01 localStorage 快照无身份隔离 → 移除整板快照,只留选择偏好

- 修复前复现(机械):新用例「隐私:旧 snapshot/v1 被清理」在旧 client 上失败(旧代码从不清理该键);旧代码在身份确认前直接把快照业务数据上屏(bootstrap 乐观首屏),即计划 §2 所述 R01 行为。
- 修复后:localStorage 只写 `{ savedAt, selectedKey }`(一个复合键字符串);旧 `@local/thorn-github-kanban/snapshot/v1` 在首次 bootstrap 无条件清除;偏好 30 天到期校验(含时钟前漂防御);失配选中键不落盘。业务数据(项目列表/卡片/计数)不再有任何本地持久化路径,「同 origin 换身份看到旧身份卡片」在结构上不可能发生。
- 设计取舍(偏离计划的可选快照路线):计划允许「保留可选快照+身份隔离」。本阶段选择直接移除,理由:(a) 浏览器侧身份需要一次真实网络往返才能确认,而「身份确认后才读取」与「快照乐观首屏」互相矛盾——等身份确认时真数据也快到了,快照失去意义;(b) 浏览器半边没有可用的配置面开关本阶段可交付(README/package 均不在本阶段权限内)。若后续要恢复提速,建议按「宿主 status 返回 viewer login + 快照键带 login + 到期 + 清除按钮」另立任务。

### R02 请求无超时、悬挂 Promise 被复用 → 双侧应用层 deadline + abort

- 修复前复现(机械,最直接):把新旧代码各跑一遍新测试——旧代码在 4i(悬挂 fetch)处出现 `Warning: Det unsettled top-level await`,进程 exit 13,套件无法完成;旧 client 在 5p 场景 2(取面悬挂)同样挂死。即:旧实现对悬挂请求的等待是无界的,连测试进程都走不完。
- 修复后(宿主):`ghGraphQL` 建连与 `response.json()` 各自有 `requestTimeoutMs`(默认 15s,可经 `deps.requestTimeoutMs`/`config.requestTimeoutMs` 配置)期限;到期 `AbortController.abort()` 并返回结构化 `timeout` 错误(与 network_error 区分);迟到回包的两个分支都被显式消费(严格 unhandled-rejection 模式验证)。
- 修复后(客户端):mount / 取面各 10s、每次远程调用 20s deadline;到期返回 `remote_timeout` 结构化错误(文案点名阶段与方法);`remote_timeout`/`timeout` 归入瞬态失败分类,自动重试/轮询可恢复(5l 验证超时后下一 tick 恢复)。
- in-flight(S1.3):超时也算 settle,dedupe 出队前核对「自己仍是该键在册条目」;4k 验证悬挂超时后再次调用发出**新**请求且可恢复,条目不残留。

### R03 单仓错误拖垮整表 → 分来源收集

- 修复前复现(机械):4l 三个场景在旧 host 上全部失败(旧代码 `if (!result.ok) return result;` 让单仓 graphql_error 直接失败整表)。
- 修复后:viewer 与各仓独立 absorb;成功来源保留,失败/缺席来源进 `warnings[]`(缺席仓给 `repo_missing`);所有来源失败返回 `all_sources_failed`(含来源与 code 清单),**绝不**返回 `ok:true + 空列表`;全部超时聚合回 `timeout` 保持恢复指引对口。token_missing 保持原语义前置返回(旧用例不变)。UI 在成功态顶部渲染一行来源警告(5k)。

### R04 重试计数过早归零 → 完整启动成功才归零

- 修复前复现(机械):5c1f2(R04 精确场景:status 一直成功、listProjects 一直瞬态失败)在旧 client 上失败——旧代码在 status 成功后立即 `setRetryCount(0)`,自动重试永不停止,「达上限后不再新增请求」断言不成立。
- 修复后:归零只发生在完整启动成功(引导态/空列表/看板拉取成功)三处;错误路径一律不归零。重试语义统一:链内退避重试(≤5 次)+ 错误态 4s 自愈轮(15 轮封顶)共用 `isTransientFailure` 分类(新增 remote_timeout/timeout);自愈轮定时器重调度前先清旧(防叠发);手动「刷新」重置预算(用户明确要求恢复,重新给满一轮,5o 验证重置后仍会封顶而非无限)。

### R05 无快照首载失败无恢复入口 → 工具栏常驻 + 整链刷新

- 修复前复现(机械):5i 在旧 client 上失败且交互直接踩空(旧代码首载失败时 `buttons.length === 0`,与计划 §2 记录的「按钮数 0、请求数 1」一致)。
- 修复后:token 非「未配置」时工具栏(切换器+刷新按钮)在任何 phase 常驻;刷新按钮执行 `reload()` = bootstrap({noCache:true}),重拉项目列表+看板(不只是当前看板),宿主 `listProjects(request)` 增加 noCache 强刷参数(4p 验证绕 TTL)。空项目态同样有刷新入口,项目新增后可拉到(5j)。

## 3. 用例变化说明(相对基线 110 个)

基线 110 个用例中 107 个**原样保留且通过**;3 个重写、1 个恢复原场景并新增变体,均有明确理由:

1. 「快照:选中延续 / 真数据覆盖乐观首屏 / RPC 结果写回 localStorage」(3 个)→ 重写为「偏好:选中延续 / 旧 snapshot/v1 被清理 / 旧快照卡片不上屏 / 写回仅含 savedAt+selectedKey」(4 个)。理由:S1.1 移除了整板快照,旧行为(快照上屏、快照写回)按设计不复存在;选择延续的等价能力由偏好键承接,新用例同时覆盖隐私断言。
2. 「瞬态错误:持续失败显示错误态+自动重试提示」曾被我改写为 R04 变体,已**恢复原文**(status 自身持续失败场景,标签与断言与基线一致),R04 场景另立 5c1f2。理由:两个场景走不同错误分支(status 分支 vs list 分支),都应保留。

新增用例 45 个(合计 152):宿主 4i–4p(超时/响应体悬挂/in-flight/局部失败×3/缓存 LRU/身份隔离/强刷竞态/listProjects 强刷),客户端 5c1c 重写×4+到期×1、5c1f2×3、5i–5p(R05/空态/来源警告/轮询超时恢复/一致性门控/卸载/手动预算/apply 级有界等待×5)。

## 4. 验收矩阵覆盖(计划 §3 中与本阶段相关的行)

| 场景 | 用例 | 结果 |
| --- | --- | --- |
| 请求悬挂 / 响应体悬挂 | 4i、4j、5p 场景 1–3(挂载/取面/调用) | 通过;旧代码挂死 |
| status 成功、列表持续瞬态失败 | 5c1f2(上限后零增长) | 通过;旧代码失败 |
| 无快照首次加载失败 | 5i(按钮在场+整链重拉恢复) | 通过;旧代码按钮数 0 |
| 快速切换 / 响应倒序 | 既有 5c3 + 新 5m(加载期旧板退位) | 通过 |
| 同 origin 换身份 | 5c1c(旧快照清理+不上屏)+ 4n(宿主 token 轮换缓存失效) | 通过 |
| 单仓失败 / 全来源失败 | 4l 三场景 | 通过;旧代码三场景全失败 |

## 5. 设计偏离与取舍(汇总)

1. **快照移除而非可选保留**(见 R01 节)——完成条件以「不展示旧身份卡片、旧键清理、无误导性陈旧展示」验收,移除后天然满足。
2. **ctx.timeout 优先、全局 setTimeout 回退**:与既有 `ctx.interval` 的处理同型。dsh client runner 的 timer Service 是否暴露 `ctx.timeout` 未能在本会话核验(见下「工具限制」),所以做了能力探测而非硬依赖;两种路径都有用例(5p 场景 1–4 走 ctx.timeout,场景 5 走全局回退)。
3. **宿主全部来源超时聚合为 `timeout` code**(而非 all_sources_failed):错误分类对口恢复指引(重试/查网络),单来源信息仍在 message 里。
4. ** boards 缓存 LRU 以写入序为准、读不续命**:口径可预期、实现零额外记账;容量默认 8、可经 `config.cache.maxBoards` 配置。
5. **强刷/普通并发以「发起序号」单调写**(而非时间戳对比):时间戳无法区分「先发起慢回包」与「后发起快回包」的先后,序号可以;4o 验证先发起的慢请求不覆盖后发起强刷的结果。
6. **mini-React 替身补了 unmount()**(记录并逆序执行 effect cleanup、屏蔽卸载后渲染/调度),只为 S1.8 提供可测的卸载路径;effect 重跑间的 cleanup 仍不模拟(真 React 环境是阶段 3 / R06 的范围)。

## 6. 工具限制记录

- 按用户要求,研究框架/SDK 用法应优先用 Mintlify index `context` 工具;**该工具在本会话不可用**。涉及 dsh 契约的判断改为依据仓库内既有结论(文件头注释里的 2026-10-01 真机记录、dsh-api-gateway/dsh-typert-registry 源码摘录)与保守的能力探测写法(ctx.timeout 缺失即回退),未直接读取 `/Users/thornwu/.nvm/.../@deepseek-ai/` 下的参考实现(本轮改动不需要新契约,均为既有契约内的加固)。
- 本阶段未做真实 GitHub 调用、未写入任何真实凭据;所有测试用虚构数据与注入替身。

## 7. 未完成项 / 移交

1. **真机验证未做**(计划 §3.7 的真实环境行:真 dsh + 真 React + 真 GitHub)。特别是:ctx.timeout 在真实 client runner 上的存在性与返回值形状、AbortController 经真实网关链路的取消效果、面板在真实浏览器里的卸载行为。建议阶段 5 验收时一并覆盖。
2. **effect 重跑间 cleanup、真实 React 生命周期**(R06)仍属阶段 3:mini 替身只补了卸载路径。
3. 快照提速功能若要恢复,按 R01 节的方案另立任务(需要宿主返回 viewer 身份 + UI 清除入口)。
4. `README`/`package.json` 的配置说明(requestTimeoutMs、cache.maxBoards)不在本阶段文件权限内,由阶段 4 的 agent 补文档时纳入。
