# 整改交付报告(dsh-github-kanban 只读 Alpha)

执行:REPORT agent(收官,阶段 0 + 阶段 5 准备 + 全局对账 + 终验)。日期:2026-10-03。
结构:按 REMEDIATION_PLAN §9 的 8 节。证据以仓库内可复跑命令与 `notes/remediation/phase1–4.md` 为锚。

## 1. 交付摘要

- **基线**:HEAD `f6ad528`(0.7.0),分支 `fe/thornwu-kanban-global`(领先 origin 12 个提交——均为基线前的既有工作)。
- **最终状态**:同分支、同 HEAD,**全部整改以未提交的工作区改动交付**(未 commit/push,待用户授权)。审查基线与实际基线无差异(S0.1,用户已核对,本轮 git status 复核一致)。
- **改动面**(终验时 `git status`):
  - 修改(跟踪文件):`TODO.md`、`cordis.patch.yml`、`lib/client.js`、`lib/index.js`、`package.json`、`scripts/smoke-load.mjs`;
  - 新增(未跟踪):`README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`.github/workflows/ci.yml`、`test/`(7 套件 + helpers)、`package-lock.json`、`notes/remediation/`(phase1–4 + round2-host/client/docs + 本报告)、`REMEDIATION_PLAN.md`;
  - 用户原有产物 `memory/`、`review/` 原样保留,未动、未提交。
- **版本**:0.7.0 → **0.8.0(提案)**,三处版本源已同步(`package.json`、`lib/index.js` `VERSION`、`package-lock.json`),smoke 版本一致断言通过。**定版与发布时机由所有者决定**(CHANGELOG 已标注)。
- **当前阶段**:阶段 0–4 完成度见 §2 映射表;阶段 5 完成发布准备(S5.1 候选包核验、S5.6 发布说明),真机验收与外部发布待执行。
- **第二轮整改(2026-10-03 审查回执)**:第一轮交付后独立审查不通过(2 P1 + 7 P2,其中 6 项为上轮遗留、3 项新增),三个修复 agent 按先红后绿全部修复,详见 §9;合并终验 `npm test` exit 0(315 项:smoke 213 + unit 81 + react 20 + pack 1)、`npm run test:strict` 0 失败。二轮增量改动:`lib/index.js`、`lib/client.js`、`scripts/smoke-load.mjs`、`test/`(cache/contract/react 用例 + helpers 数量闸)、`CONTRIBUTING.md`、`SECURITY.md`、`notes/remediation/round2-*.md`,仍全部未提交。
- **尚未完成的门槛**:真机验收(S5.2–S5.5,含 phase1–3 遗留真机项)、原审查 agent 独立验收(S5.7)、所有者决定项(许可证、版本定版、公开策略等,见 §8)。

## 2. 任务映射表

45 个任务 ID。状态口径:完成 = 实现 + 自动化证据齐;待验收 = 实现完成但真机/授权环境未执行;待所有者 = 规则上不能替所有者决定。

| ID | 状态 | 实现位置 | 测试/命令 | 剩余工作 |
| --- | --- | --- | --- | --- |
| S0.1 | 完成 | 本报告 §1(HEAD/分支/工作区记录) | `git status` / `git log --oneline -1` | — |
| S0.2 | 完成 | README「能力与限制」;代码核实:viewer+仓库项目(`lib/index.js` listProjectsImpl)、按 id 去重、closed 过滤、Status 选项序分列、负责人/标签(`lib/client.js` Card)、30s 轮询(`POLL_INTERVAL_MS=30000`) | `npm run test:smoke`;`grep -n "POLL_INTERVAL_MS" lib/client.js` | — |
| S0.3 | 完成 | README「数据上限」表;代码核实:`MAX_ITEMS=200`、`MAX_PROJECTS=300`、`FIELDS_PAGE_SIZE=40`、fieldValues/users/labels 单页 30/10/20;Status 字段名硬约束 `STATUS_FIELD_NAME="Status"`(缺失→单列+三档 hint,不猜测替代字段);只读边界(零 mutation,README「权限说明」) | `grep -n "MAX_ITEMS\|MAX_PROJECTS\|FIELDS_PAGE_SIZE\|STATUS_FIELD_NAME" lib/index.js`;test/service「分页拉满上限→incomplete」 | — |
| S0.4 | 完成 | README「兼容版本」:已验证 = dsh 0.2.0-rc.1 + rc.2(2026-10-01 真机,phase4/dev-notes)、Node 24.x(开发自检)、dsh 自带前端;待验证 = dsh 其他 rc、Node 18–23(运行下限 18)、独立浏览器矩阵;开发/测试 Node ≥20.19(jsdom 29 约束,README「开发与测试」已注明) | 见 phase3 §2(React 版本核验链) | 真机版本矩阵归 S5.2 |
| S0.5 | 完成 | 本轮终验全部通过(§4),无失败项需要记为基线缺口;审查基线的 110/110 smoke 在阶段 1 扩到 152、阶段 2 扩到 204(均为全绿) | §4 命令清单 | — |
| S1.1–S1.9 | 完成 | phase1 §1 映射表(lib/client.js 偏好读写 255–299 等;lib/index.js withTimeout/ghGraphQL/dedupe/分来源收集/缓存) | phase1 §1;`npm test` | 真机项见 §5;二轮审查在 S1.3/S1.4/S1.7/S1.9 范围发现 6 处残留缺陷(在途跨身份复用、加入者回退缓存、命中丢来源警告、重挂载/整链刷新旧链回包、空列表隐藏来源),已于第二轮修复(§9.1 #2–#7);三轮审查在 S1.9 再发现 1 处 P1(指纹与实际请求凭据非同刻,轮换微任务窗口内缓存错标身份,已修,§10.1 #1),S1.6 恢复口径的 1 处 P2(看板成功掩盖列表刷新失败)修复落在 S2.3 转换表(§10.1 #2) |
| S2.1–S2.9 | 完成 | phase2 §1 映射表(不拆文件/pageAll/控制器/状态机/coerce/共享查询片段/wire 契约核验) | phase2 §1;`npm test` | 真机项见 §5;S2.6 一轮核验的缺口(客户端调用侧实参数量判定未覆盖,清单加参后调用面未同步)系二轮 P1 新增缺陷,已于第二轮修复(§9.1 #1);三轮审查在 S2.3 转换表发现看板轮询/切换的成功可掩盖链级错误(P2,S1.6 恢复口径),已按 error.stage 门控修复(§10.1 #2) |
| S3.1–S3.6 | 完成 | phase3 §3 映射表(test/{pure,service,cache,contract,syntax}.test.mjs + test/react/ + ci.yml + package.json scripts) | `npm test`(一轮 74+17+1 项;二轮后 smoke 213 + unit 81 + react 20 + pack 1,§9.2) | —;二轮审查发现的替身缺口(smoke/contract 替身不校验实参数量,致参数契约缺陷漏检)已由 strictArgumentFace 同严闸补齐(§9.1 #1) |
| S3.7 | 完成(矩阵 12 行:10 行自动化,2 行的真机半边待验收) | phase3 §4 逐行映射表 | `npm test` | 行 1/11 的真实凭据/真实宿主半边、行 12 数据一致性 → S5.3/S5.5 |
| S4.1 | 完成(截图除外) | README.md(phase4 S4.1;本轮收官校对快照/超时/LRU/警告/恢复入口描述与实现一致,见 §7 第 9 条) | 通读比对 | 面板截图需真机环境,列为发布前可选项(S5.2 时顺手补) |
| S4.2 | 完成 | cordis.patch.yml(repos=[] + 校验注释);README「配置」 | `npm run test:smoke`(读 patch 的断言) | — |
| S4.3 | 完成(元数据) | package.json(description/keywords/engines/homepage/bugs) | `npm pack --dry-run` | 包名/公开/npm publish 待所有者 |
| S4.4 | **待所有者(发布阻塞)** | 未创建 LICENSE(规则:授权决定归所有者);README「许可证」节 + 候选对比(MIT/Apache-2.0)已备 | — | 所有者选定后:LICENSE + package.json license 字段 + README 更新 |
| S4.5 | 完成 | CONTRIBUTING.md / SECURITY.md / CHANGELOG.md | — | 安全报告渠道待所有者提供;二轮审查发现两文档各一处失真(测试要求段诱导跳过测试 / 数据边界仍描述旧快照行为,均为一轮新交付物的新增缺陷),已于第二轮修正(§9.1 #8/#9) |
| S4.6 | 完成 | TODO.md 重写为路线图 | `npm run test:smoke`(读 TODO 的断言) | — |
| S4.7 | 完成 | phase4 S4.7(全历史+分发扫描:零凭据;个人路径/仓名处置清单);phase2 完成夹具脱敏 32 处 | `grep -rn "ThornWu\|thornwu" lib/ scripts/smoke-load.mjs test/`(零命中) | git 历史中的仓名保留(改写需单独授权);dev-notes.md:4 一处路径建议所有者顺手改 |
| S4.8 | 完成 | phase4 S4.8 + 本轮 S5.1 实际 pack 核验(§6) | `npm run pack:check` | — |
| S5.1 | **完成(候选包核验)——真机安装验收与 S5.2 一并执行** | `npm pack` 实际产物核验:5 文件、独立可装载、零个人数据、零运行时依赖(§6) | §6 复跑命令 | 装进真实 dsh profile 的干净安装(README「干净 checkout 安装验证」五步) |
| S5.2 | 待验收 | 可复跑步骤见 §5 | — | 真 dsh |
| S5.3 | 待验收 | 可复跑步骤见 §5 | — | 真 GitHub(授权测试数据) |
| S5.4 | 待验收 | 可复跑步骤见 §5 | — | 真 GitHub |
| S5.5 | 待验收 | 可复跑步骤见 §5 | — | 真 dsh/网络 |
| S5.6 | 完成(准备) | CHANGELOG 0.8.0 条目(修复/新增/变更三段)+ 本报告 §8 发布说明素材(版本/已知限制/升级回退/源码与分发物对应) | `npm pack --dry-run`(shasum 见 §6) | 定版与发布待所有者 |
| S5.7 | 待验收+待授权 | 验收流程 = REMEDIATION_PLAN §10(6 步) | — | 原审查 agent 独立验收 → 用户授权发布 |

统计:**完成 38 / 部分完成(待验收)6(S5.1–S5.5、S5.7)/ 待所有者决定 1(S4.4)**。S3.7 与 S5.1 的「部分」已在行内如实标注。

## 3. 确认缺陷复核(R01–R05 + R06)

修复前后表现、触发条件与回归证据的权威记录在 **phase1 §2**(每项都做过「基线代码跑新用例必红」的机械复现:`git stash push lib/*.js → 跑 smoke → pop`)。此处摘要:

| ID | 修复前(复现) | 修复后 | 回归证据 |
| --- | --- | --- | --- |
| R01 快照无身份隔离 | 旧 client 从不清理 `snapshot/v1`,身份确认前快照业务数据上屏 | 整板快照**移除**;本地仅存 `{savedAt, selectedKey}` 偏好(30 天到期、失配不落盘);旧键首次 bootstrap 无条件清除 | smoke 5c1c 系列;test/react「偏好」组(真实 React) |
| R02 无超时、悬挂 Promise 复用 | 旧代码跑 4i(悬挂 fetch)测试进程挂死(exit 13) | 宿主双阶段超时(建连+响应体,默认 15s,`requestTimeoutMs` 可配)+ abort;客户端 mount/取面/调用 10–20s deadline;迟到回包被消费 | smoke 4i–4k;test/service 超时组;test/contract「有界等待」 |
| R03 单仓错误拖垮整表 | 4l 三场景在旧 host 全失败 | 分来源收集;失败/缺席 → `warnings[]` 来源级警告;全失败 → `all_sources_failed`(绝不 ok+空列表);全超时聚合 `timeout` | smoke 4l/5k;test/service「局部失败/全来源失败」 |
| R04 重试计数过早归零 | 5c1f2(status 成功、列表持续失败)在旧 client 上自动重试不封顶 | 完整启动成功三处才归零;链内 ≤5 退避 + 错误态 4s 自愈轮 15 轮封顶;手动刷新重置预算(重置后再封顶) | smoke 5c1f2/5o;test/react「重试上限」(真实定时器语义) |
| R05 首载失败无恢复入口 | 5i 在旧 client 上按钮数 0、请求数 1 | token 已配置时工具栏常驻;「刷新」= bootstrap({noCache}) 整链重拉列表+看板 | smoke 5i/5j;test/react「首载失败→刷新恢复」 |
| R06 mini-React 不忠实 | 审查记录:effect cleanup 不执行、useCallback/useMemo 不缓存 | **阶段 3 兑现**:test/react 运行在真实 React 18.3.1 + react-dom + jsdom,经真实 apply(ctx) 链装载,StrictMode 双挂载/effect cleanup/卸载均真实;替身套件保留为快速哨兵,不再用于「证明」React 行为 | phase3 §1/§3;`npm run test:react`(17 项) |

R01 的路线取舍(移除而非可选保留)与理由见 phase1 §2 R01 节;恢复快照功能的后续方案已记录(需宿主返回 viewer 身份 + UI 清除入口,另立任务)。

## 4. 自动化结果

环境:Node v24.18.0、npm 11.16.0、darwin 27.2.0 arm64。全部命令于 2026-10-03 在最终工作区实跑:

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 成功(locked 安装,0 vulnerabilities;devDeps 仅 jsdom/react/react-dom) |
| `npm test` | **exit 0**,墙钟 ~6.5s。链路:lint(node --check lib/index.js + lib/client.js)通过 → smoke **204/204** → unit **74/74**(pure 23 + service 21 + cache 15 + contract 14 + syntax 1)→ react **17/17** → pack:check **1/1** |
| `npm run test:strict` | **exit 0**:smoke 204/204(--unhandled-rejections=strict)+ node:test **92/92**(74+17+1) |
| `node --check lib/*.js` | 通过(lint 步骤;另 test/syntax 覆盖 16 个 JS/MJS 源文件) |
| `npm pack --dry-run` | 5 文件(见 §6),版本 0.8.0 |
| 实际 `npm pack` + 解包核验 | 见 §6;tarball 验后已删除 |

合计 **296 项检查全绿**(smoke 204 + node:test 92),严格模式同样全绿。(以上为第一轮终验数字;第二轮整改后的合并终验见 §9.2:315 项全绿;第三轮整改后的合并终验见 §10.2:336 项全绿。)**CI 未在远端运行**:`.github/workflows/ci.yml` 已就位(Node 20/22/24 矩阵 + strict + package job,零 token),本地同等命令通过——按计划 §6 口径,不能报告远端 CI 通过;推送后首跑待观察(phase3 §7)。

日志:无仓库外临时文件依赖;复跑入口即上述命令。smoke 单项失败时的输出自带用例名与上下文(`node scripts/smoke-load.mjs` 直接可读)。

## 5. 真实环境结果

**本轮(含阶段 1–4)未执行任何真实 dsh 宿主 / GitHub token / 真浏览器验收。** 原因:token 只能经授权宿主环境取得(计划 §1.6),真机操作需用户环境与授权;各阶段 agent 均以注入替身完成自动化。以下是待执行清单与可复跑步骤(供用户或原审查 agent 执行):

| 项 | 步骤入口 | 需要什么 | 看什么 |
| --- | --- | --- | --- |
| S5.2 完整启动 | README「干净 checkout 安装验证」五步(clone→smoke 全绿→profile link 两行→重启→面板出现) | dsh 0.2.0-rc.1/rc.2(或其他声明版本,记录版本号) | 左栏出现「GitHub 看板」;不设 token 时显示引导视图而非堆栈 |
| S5.3 数据核对 | 配置 `GITHUB_TOKEN`(授权测试身份,fine-grained PAT)后打开面板 | ≥2 个项目、≥1 个有卡项目 | 列序 = Status 选项序、标题/负责人/标签/计数与 GitHub 实际一致;项目切换正常(TODO 遗留的真机核对项在此闭环) |
| S5.4 刷新窗口 | GitHub 侧改卡片(移列/加标签),等待 ≤30s+缓存窗口 | 同上 | 看板在声明窗口内更新;「刷新」按钮立即绕缓存生效 |
| S5.5 恢复路径 | 断网/重启 dsh web/换无效 token | 同上 | 瞬态错误自动重试(4s×15 轮封顶);恢复网络/重启后自愈或手动刷新恢复;权限错误文案准确且不含 token |
| phase1 遗留真机项 | phase1 §7 | 真 dsh + 真浏览器 | ctx.timeout 在真实 client runner 的存在性与返回形状;AbortController 经真实网关的取消效果;浏览器里面板卸载行为 |
| phase2 遗留真机项 | phase2 §5 | 真 dsh + 真 GitHub | 查询新增的 `pageInfo{hasNextPage}` 字段真 schema 接受性;StrictMode 重挂载;`internals` 导出键在真装载器的无害性(源码已核,复核一行) |
| phase3 遗留真机项 | phase3 §6 六项 | 真 dsh 全链 | 装载器/网关编解码/scoped fiber/timer 服务/座位渲染/真实网络与 PAT 三态 |
| CI 远端首跑 | push 后看 Actions | 远端仓库 | 4 个 job(Node 20/22/24 × test+strict,package)全绿 |
| S5.7 独立验收 | REMEDIATION_PLAN §10 六步流程 | 原审查 agent | 通过/部分通过/不通过 + 阻塞项清单 |

## 6. 兼容性与分发

- **支持版本**(详见 README「兼容版本」,已验证/待验证分列):dsh 0.2.0-rc.1 + rc.2 已验证(2026-10-01 真机,历史验收);Node 运行下限 18(全局 fetch),开发实测 24.x,开发/测试需 ≥20.19(jsdom 29);浏览器 = dsh 自带前端(React 18.3.1 同源),未做独立矩阵。
- **安装路径**:profile `package.json` 双行(dependencies `link:<repo>` + bundles 数组)→ `pnpm install` → 重启 dsh web(README「安装」)。仓库 checkout 本身即完整可安装;tarball/npm 为备选分发。
- **配置变化(0.7.0 → 0.8.0)**:`repos` 默认 `[]`(原三个个人仓库,现只在 README 示例);新增可配置项 `cache.maxBoards`(默认 8)与 `requestTimeoutMs`(默认 15000),README「缓存与超时」有文档。
- **旧快照迁移**:0.8.0 起浏览器只存项目选择偏好(键 `@local/thorn-github-kanban/prefs/v1`,30 天到期);旧 `snapshot/v1` 键首次打开面板自动清理(README「排障」附手动清理命令)。无其他本地状态,无不可逆迁移。
- **回退方式**:profile `link:` 指向的仓库 `git checkout f6ad528`(0.7.0)→ 重启 dsh web;或 profile 依赖指回旧版本目录。浏览器侧无回退障碍(旧版本会重新写 snapshot/v1,属预期)。
- **候选包核验(S5.1,2026-10-03 实跑,复跑命令如下)**:

  ```sh
  TMP=$(mktemp -d) && cd "$TMP" && npm pack <repo> && tar -tzf local-thorn-github-kanban-0.8.0.tgz
  # → package/{lib/client.js, lib/index.js, package.json, README.md, cordis.patch.yml} 恰 5 文件
  ```

  核验结论:内容清单恰为 `files` 声明的 5 文件(lib/client.js 70.3kB、lib/index.js 47.0kB、README 14.2kB、cordis.patch.yml 1.4kB、package.json 2.3kB;tarball 48.5kB,shasum `7bcf9b98…bcc00d`);解包后 `node --check` 两 lib 通过、`lib/index.js` 可独立 import(exports 完整、VERSION=0.8.0)、`lib/client.js` 零 import 语句(单文件浏览器交付成立)、`dependencies` 为空(运行时零依赖);5 个分发文件 grep 个人名/个人路径零命中。test//scripts//notes/ 等开发产物不混入(test/pack.test.mjs 常驻断言)。tarball 验后已删除,未发布。

## 7. 设计偏离与取舍

各阶段权威记录:phase1 §5、phase2 §4、phase3 §1/§5。汇总(编号续前,均为「未按计划建议字面执行,但满足同一验收目标」):

1. **快照移除而非可选保留**(S1.1/R01):「身份确认后才读取」与「乐观首屏」互斥;移除后隐私目标结构性成立(验收条件全部满足)。
2. **不拆宿主文件**(S2.1):分节 + 单一分页助手消除真实漂移点;拆文件需同步扩分发面,收益为负。浏览器半边受单文件平台硬约束。
3. **部分失败 = ready 的 payload** 而非独立 phase(S2.3);**字段值截断只统计不追拉**(S2.5);**projects_truncated 走 warning 通道**(S2.5)。
4. **宿主侧错误文案不做 i18n**(S2.9):宿主无 locale 面;错误以 code 为锚走 README 排障表。兜底列名/无标题卡已改标记 + 浏览器词典。
5. **smoke 替身套件不迁移**(S3.4/S3.5,R06):真实 React 套件为行为权威,替身保留为零依赖哨兵;不再以替身「证明」React 行为。
6. **开发/测试 Node ≥20.19 vs 运行时 ≥18**:jsdom 29 的 engines 约束;lib/ 不依赖 jsdom,README 已分列说明。
7. **`internals` 自检接缝**(S2.2):client 导出多余键供直驱测试;已对照 dsh-client-modules 源码确认装载器只消费 apply/inject,真机无害性留一行复核(S5)。
8. **宿主全部来源超时聚合为 `timeout` code**(S1.4):错误分类对口恢复指引。
9. **本轮收官的偏离**:①快照 README 段未保留 phase4 的「目标行为/免责句」写法,改为既成事实陈述(阶段 1 已移除整板快照,阶段 4 的衔接要求);②CHANGELOG「Unreleased/进行中」改写为 0.8.0 候选条目并标注「提案,定版由所有者决定」;③版本号三处同步 bump 到 0.8.0(smoke 版本断言通过)——phase4 曾建议 0.8.0 或 1.0.0-alpha.1 二选一,取 0.8.0 以延续仓库 minor=功能/patch=修复 惯例,最终定版留给所有者;④smoke 5c1e 夹具中的 `version:"0.7.0"` 顺手更新为 0.8.0(仅 mock 值,无断言依赖)。

## 8. 发布状态与待决清单

**状态分列**(按计划 §9.8):

| 维度 | 状态 |
| --- | --- |
| 许可证 | **未定,发布阻塞**(S4.4;候选 MIT/Apache-2.0 对比在 phase4 S4.4 与 README) |
| 公开内容检查 | 完成:分发 5 文件零凭据/零个人路径/零个人仓名;git 历史含历史仓名(改写需单独授权,默认不做);`memory/`、`review/`、`REMEDIATION_PLAN.md` 未跟踪未提交,公开策略待所有者 |
| CI | 配置就位(零 token),**远端未跑**;本地同等命令全绿 |
| 自动化 | 296 项全绿(§4) |
| 实际发布 | **未执行**(未 commit/push/pack 发布;候选 tarball 已核验并删除) |
| 版本 | 0.8.0 提案已同步三处版本源;定版待所有者 |

**Alpha 发布说明素材(S5.6)**:

- 版本:**0.8.0(提案)**——只读 Alpha;变更全文见 CHANGELOG 0.8.0 条目(修复 R01–R05 / 新增完整性口径+测试体系+CI+文档 / 变更默认 repos 与元数据)。
- 已知限制:只读(无写回/拖卡/Agent 工具/webhook);数据上限(单板 200 / 列表 300 / 字段 40 / 每卡字段值 30、标签 20、负责人 10,超限有提示不假称全量);看板列依赖名为 `Status` 的单选字段(缺失退化为单列+提示);宿主侧错误文案为中文(以错误码为锚);dsh 处于 rc 期,升级 dsh 后异常先查 README 排障。
- 升级步骤:`git pull`(link: 协议无需重装)→ 重启 dsh web;旧 snapshot/v1 自动清理,无需处理。
- 回退步骤:`git checkout f6ad528`(0.7.0)→ 重启 dsh web;浏览器侧无不可逆迁移。
- 候选源码 ↔ 分发物对应:候选源码 = 分支 `fe/thornwu-kanban-global` 当前**未提交工作区**(HEAD f6ad528 + 本轮改动);分发物 = `npm pack` 产物 5 文件(shasum `7bcf9b98…`)。**发布前须先 commit 生成可引用的 commit hash 并重打包核验 shasum**,使源码-分发物对应可审计。

**待所有者决定**(汇总自 phase4 §3 及各阶段,无遗漏核对过一遍):

1. 许可证选择(发布阻塞;S4.4)。
2. 版本定版:0.8.0 提案确认或改号(CHANGELOG 已标注;三处版本源已同步)。
3. 包名 / `@local/` 前缀 / `private` / 是否 npm publish(S4.3)。
4. `homepage`/`bugs` 占位替换(S4.3)。
5. 安全报告渠道(SECURITY.md 待定;S4.5)。
6. git 历史中个人仓名是否 history rewrite(需单独授权,默认不做;S4.7)。
7. `memory/`、`review/`、`REMEDIATION_PLAN.md`、`notes/` 的公开策略(gitignore 或补跟踪;S4.7);若公开,`review/` 内容先自查一遍是否含真实 token 片段(phase4 未读取其内容细节)。
8. 本轮全部改动的 commit/push 授权(当前全部在工作区未提交;push 后触发 CI 首跑)。
9. 低风险提示:公开前顺手核对 dsh 官方包 license 字段(实现参考过其契约;phase4 S4.4);`notes/dev-notes.md:4` 的个人参考路径可顺手改写为通用写法(phase4 S4.7,不在他人所有权内故未代改)。

**遗留门槛(真机验收)入口**:见 §5 表(S5.2–S5.5 + phase1/2/3 遗留真机项 + CI 远端首跑 + S5.7 原审查 agent 验收)。

## 9. 第二轮整改(2026-10-03 审查回执)

本节为 §1–§8 第一轮交付后的补记,不属 REMEDIATION_PLAN §9 的 8 节结构。第一轮交付后独立审查不通过:**2 P1 + 7 P2,其中 6 项为上轮遗留、3 项新增**。三个修复 agent(HOSTFIX / CLIENTFIX / DOCSFIX)按「先红后绿」完成全部 9 项修复;每项的复现序列、红/绿证据与取舍的权威记录在 `notes/remediation/round2-host.md`、`round2-client.md`、`round2-docs.md`,本节只做汇总与交叉引用。

遗留/新增的判定口径(如实说明):**新增** = 缺陷由第一轮改动引入、或存在于第一轮新交付物——第 1 项有基线对照实锤(基线清单 `method("listProjects", [])` 与其 0 实参调用面本自洽,第一轮为 noCache 给清单加 `request` 参数后浏览器调用面未同步;第 8/9 项的两份文档均为第一轮新建,原审查不可能点名);**遗留** = 计划/原审查已点名区域的第一轮修复残留(第 2–7 项,对应 S1.3/S1.4/S1.7/S1.9)。

### 9.1 审查发现 → 修复状态映射(9/9 已修)

| # | 审查发现 | 级别 | 遗留/新增 | 修复位置 | 复现 → 修复证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | Remote 参数数量契约:首载/刷新链以 0 实参调用清单声明 1 参的 listProjects/getBoard——真网关按清单形参数量精确比对,折为非瞬态 `remote_error`,首载全挂(审查锚点 client.js:475,createBoardApi 返回面) | P1 | **新增** | `lib/client.js` createBoardApi 返回面 `request ?? {}`;防漂移闸:`test/helpers/fixtures.mjs` `strictArgumentFace`/`manifestArities`、react-panel/makeCtx 交付面统一过闸、smoke `withArgContract`(+2 自证检查) | round2-client §1.2–§1.4:红 = contract 新用例 ×2(其一逐字重现网关错误)+ 既有 3 用例连带红(替身此前不校验数量);绿 = contract 16/16、全套件同严运行 |
| 2 | 在途请求跨身份复用:身份切换后新调用加入旧身份的在途 Promise;回填取完成时指纹导致缓存错标,后续 TTL 命中继续吐旧身份数据(lib/index.js dedupe) | P1 | 遗留(S1.3 残留) | `lib/index.js` listProjects/getBoard(约 844–902 行):指纹调用发起时捕获一次,去重键纳入指纹(`projects[:force]:<fp>` / `board:<repo#N>[:force]:<fp>`),回填按发起时身份盖章 | round2-host §1:红 = R2host-P1 ×2(fetchCount actual 1 / expected 2,命中吐旧身份数据);绿 = 新身份另起请求、条目按发起时身份盖章 |
| 3 | 去重调用缓存回退(加入者序号):加入在途的调用自带晚序号,可用旧结果把后发起强刷写入缓存的新数据回退 | P2 | 遗留(S1.9 残留) | `lib/index.js`:序号分配从 dedupe 之前移进 produce 首次执行处;加入者 `startSeq=0`,不回填缓存、不触发容量淘汰(listProjects 同型) | round2-host §2:红 = cached「OldCol 的卡」/ expected「NewCol 的卡」;绿 = 缓存为 NewCol 且 call=2(去重语义保留);既有 15 个 S3.3 缓存用例(含强刷竞态)不经修改通过 |
| 4 | 缓存命中丢来源警告(listProjects):缓存只存 `result.projects`,TTL 命中重拼信封时 `warnings[]` 消失 | P2 | 遗留(S1.4/S1.9 残留) | `lib/index.js`:缓存整个成功信封,命中路径原样返回(与 getBoard 同型);getBoard 补核对性用例钉住保真 | round2-host §3:红 = second.warnings `[]` / expected 1 条 `repo_missing`;绿 = 命中警告原样保留;getBoard 核对用例修复前后均绿(防回归闸) |
| 5 | 重挂载接受卸载前响应:StrictMode 双挂载后,卸载前旧链的空列表回包清空新链刚立好的列表/看板/选中 | P2 | 遗留(S1.7 残留) | `lib/client.js` 控制器链代数 epoch(与 loadSeq 正交):`dispose()`/`runBootstrap()` 换代,`bootstrap`/`loadBoard` 两个 await 续体按代作废 | round2-client §2:红 = react「R2 代际」+ smoke 5r 场景 5;绿 = 新链状态不被清空,StrictMode 既有语义保留(1 处断言按有意行为变化改写,见 §9.2) |
| 6 | 整链刷新缺请求顺序保护:reload 换代后旧链迟到回包回退刷新链新状态;看板窗口(新链尚未发起看板请求)仅靠 loadSeq 拦不住 | P2 | 遗留(S1.7 残留) | 与 #5 统一收口:`reload()` → `runBootstrap({noCache:true})` 天然领新代,旧链一切续体按代作废 | round2-client §3:红 = react「R2 链序」+ smoke 5r 场景 6/7;实证口径 = 临时还原守卫语义重跑 smoke,213 中恰好红 3 条(场景 5/6 后半 + 场景 7 窗口),无误伤 |
| 7 | 空列表隐藏失败来源:`showNoProjects` 分支完全不渲染来源警告/截断提示,面板无提示 | P2 | 遗留(S1.4/R03 残留) | `lib/client.js` `GithubKanbanBody`:failedSources/truncatedSources 两警告段落提升为非 error 分支的独立渲染(空列表与看板区共用) | round2-client §4:红 = react「R2 空列表」+ smoke 5j2;绿 = 空态提示 + 来源失败 + 截断三要素在场;既有 5k/5t 不变 |
| 8 | CONTRIBUTING 测试要求段诱导跳过测试:称 smoke 为「唯一自动化入口」、称「无需 npm install/零依赖」,与阶段 3 后的测试体系不符 | P2 | **新增**(一轮新文档失真) | `CONTRIBUTING.md`:`npm ci` + `npm test` 为贡献前置门槛,列出全量体系构成与套件选择指引;smoke 降格为「快速回归网之一」 | round2-docs §1:核验依据 = package.json scripts/devDependencies 与 test/ 目录实际构成(文档类修复,无红绿用例) |
| 9 | SECURITY 数据边界不符:仍声称浏览器本地快照含看板业务数据(0.5.0–0.7.0 旧行为,与 S1.1 移除整板快照后的实际相反) | P2 | **新增**(一轮新文档未同步 S1.1 变更) | `SECURITY.md`「凭据与数据边界」重写:浏览器仅存偏好键(`prefs/v1`,30 天到期);宿主缓存只在进程内存、按 token 指纹隔离 | round2-docs §2:核验依据 = lib/client.js PREFS_KEY/writePrefs/purgeLegacySnapshot 与 lib/index.js §5 缓存实现 |

### 9.2 合并终验数字

三个修复 agent 改动汇合后的最终工作区(2026-10-03,全部未提交):

- `npm test` **exit 0**:lint(`node --check` lib/index.js + lib/client.js 通过)→ smoke **213/213** → unit **81/81**(pure 23 + service 21 + cache 20 + contract 16 + syntax 1)→ react **20/20** → pack:check **1/1**;合计 **315 项全绿**(第一轮 296 + 第二轮 19:smoke +9、cache +5、contract +2、react +3)。
- `npm run test:strict`(`--unhandled-rejections=strict`)**0 失败**(smoke 213 + node:test 102)。
- 既有用例处理(如实):smoke 既有 204 条全部保留、未改写;contract 既有 14 条仅替身过闸、断言零改动;react 既有 17 条中 **1 处断言有意改写**——prefs-retry「StrictMode 双调用」`boardCalls >= 2` 改为 `=== 1`(代际守卫后,卸载的旧链在首个检查点即被作废,不再发起注定作废的看板请求;属有意行为变化,该用例其余断言原样保留,详见 round2-client §5)。

### 9.3 相邻问题与已知取舍(只报告,未修)

以下为修复 agent 过程中报告但**未扩 scope 修复**的问题,原样汇总自 round2-host §5 与 round2-client §7(docs agent 无相邻问题报告)。它们**不计入**上述 9 项、不冒充已修,列为已知取舍/后续候选:

HOSTFIX(round2-host §5,3 条;其中后 2 条与该文档 §2/§3 的取舍记录互见):

1. **指纹捕获与 impl 取 token 之间的微任务窗口**(后续候选):`fp` 在调用时捕获,impl 在 produce 微任务里才读 token;身份恰在该窗口内轮换时结果会以旧指纹入册。后果有界(错标条目不会被当前身份命中,只等 TTL 过期/被覆盖);彻底消除需把 token 快照穿透进 impl,超出本轮最小 diff 边界。
2. **加入者返回值可能旧于缓存**(已知取舍):去重语义固有;缓存单调后由下一轮轮询/刷新自愈。
3. **命中返回共享信封对象引用**(已知取舍):调用方原地改写返回信封会污染缓存;当前唯一调用方(浏览器控制器)只读,与 boards 既有语义一致,未加防御性拷贝。

CLIENTFIX(round2-client §7,4 条):

1. **dispatch() 在 disposed 检查之前就落状态**(后续候选):当前所有调用路径被入口守卫/epoch 拦住、不可达,但守卫顺序反直觉,未来新增 dispatch 调用点是隐患;建议下轮把 disposed 检查提到转换前。
2. **轮询在途期间刷新按钮被禁用**(`disabled: boardInFlight`,已知 UX 取舍):看板在途(含 30s 轮询刷新、宿主悬挂至 20s deadline)时无法手动刷新,按钮最长禁用 20s;属既有取舍,与本轮四项无关。
3. **call() 的形参展开仍是数量契约潜在误用点**(后续候选):已由严格替身闸兜住;若日后在返回面之外新增调用路径,建议把数量校验下沉进 call() 本身。
4. **空列表 + repo_missing 组合的真机可达性**:取决于宿主 listProjectsImpl 的来源合并逻辑,本轮以 fixtures 的 wire 形状为契约,真机可达性归阶段 5 验证。

另有 round2-client §8 的 3 条真机待验(真网关下 `listProjects({})` 接受性、真实 keyed 卸载下的代际守卫表现、严格替身闸与 dsh-api-gateway 升级后的规则同步)并入本报告 §5 真实环境清单跟踪,不属相邻问题。

## 10. 第三轮整改(2026-10-03 PR #3 审查回执)

本节为 §9 之后的补记。第二轮 9 项修复合并后,独立审查(PR #3,基准 036413f→79fe587)结论:**1 P1 + 1 P2**,均为前两轮修复的收口残留;同时复核确认二轮的参数数量、去重回退、缓存命中警告、刷新/卸载代际等修复有效(对应 §9.1 #1/#3/#4/#5–#6)。审查方 315/315 本地复跑通过、远端 CI 8 job 全过、未重做真机验收。两个修复 agent(HOSTFIX / CLIENTFIX)按「先红后绿」完成两项修复;每项的机理、复现序列、红/绿证据与取舍的权威记录在 `notes/remediation/round3-host.md`、`round3-client.md`,本节只做汇总与交叉引用。

### 10.1 审查发现 → 修复状态映射(2/2 已修)

| # | 审查发现 | 级别 | 遗留/新增 | 修复位置 | 复现 → 修复证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 固定了指纹,但未固定实际请求凭据(审查锚点 79fe587 `lib/index.js:857-860`):指纹在调用时捕获,实际 Authorization 要等 produce 微任务执行时才读 env;身份恰在该窗口内轮换时,旧指纹给新凭据取回的数据盖章,后续 TTL 命中跨身份吐数据 | P1 | 遗留(S1.9 二轮残留;round2-host §5.1 留档的相邻问题被本轮审查升级为 P1) | `lib/index.js`:新增 `credentialSnapshot()`(839 行,token 与指纹同刻、由同一 token 值算出);token 快照穿透 listProjectsImpl/getBoardImpl → pageAll → ghGraphQL(Authorization 用快照值);undefined=未快照回退执行时读 env(兼容自检注入面)、null=快照时无 token 按快照早退;sanitizeError 改对准实际发出的凭据脱敏;status()/tokenFingerprint/启动日志按「即时口径自洽」不并入快照链(取舍见 round3-host §3/§5) | round3-host §2–§4:红 = cache 新增「R3host」×3(getBoard/listProjects 轮换窗口各 1——微任务窗口翻转注入 token,fetch 替身记录实际 Authorization 与缓存盖章比对,轮换回 A 后 TTL 命中吐他身份数据;tokenMissing 早退误报 1),修复前 `node --test test/cache.test.mjs` 20 pass / 3 fail;绿 = cache 23/23、全套件全绿,dedupe 键格式/命中校验/LRU 记账未改 |
| 2 | 看板轮询会掩盖项目列表刷新失败(审查锚点 79fe587 `lib/client.js:882-887`):30s 轮询回调只 loadBoard、不看 phase;list 级错误期看板成功经 BOARD_START/BOARD_OK 两步清错翻 ready,列表失败从 UI 消失、列表停在旧数据 | P2 | 遗留(一轮轮询与错误恢复口径的交互残留,一/二轮均未覆盖该转换语义) | `lib/client.js` boardTransition 三转换(BOARD_OK/BOARD_START/FAILED)按 error.stage 门控——链级(status/list/bootstrap)错误在场时,看板生命周期事件动不了全局 phase/error;board 级错误不受影响;看板数据照常上账,重试预算与请求模式零变化。方案论证含审查未点名的切换器入口变体与「FAILED(board) 顶替根因」第二变体(已一并钉住),弃「轮询回调改跑整链」候选的四条理由见 round3-client §2 | round3-client §1/§4:红 = react「R3」节 4 用例中 3 红(轮询掩盖、切换路径掩盖、根因被 board 错误顶替;第 4 用例为 board 级保留路径守卫,新旧实现都必须绿)+ smoke 临时还原 79fe587 重跑、226 中恰好红 6(控制器直驱 2 + 转换层 4,无误伤);绿 = react 24/24、smoke 227/227(5r 场景 8/9 + 5r2 转换层,共 +14 检查) |

### 10.2 合并终验数字

两个修复 agent 改动汇合后的最终工作区(2026-10-03 实跑,全部未提交):

- `npm test` **exit 0**:lint(`node --check` lib/index.js + lib/client.js)通过 → smoke **227/227** → unit **84/84**(pure 23 + service 21 + cache 23 + contract 16 + syntax 1)→ react **24/24** → pack:check **1/1**;合计 **336 项全绿**(第二轮 315 + 第三轮 21:smoke +14、cache +3、react +4)。
- `npm run test:strict`(`--unhandled-rejections=strict`)**0 失败**(smoke 227 + node:test 109)。
- 既有用例处理(如实):**零改写、零删除**——两个 agent 均声明既有 smoke/react/cache 用例不经修改通过;唯一接近冲突的既有用例 pure S3.1「FAILED(board)→BOARD_START 清错误」驱动的是 board 级口径,与门控的保留语义一致,不经修改转绿(该文件本轮禁改,门控形态也因此收窄为「只清 board 级」,见 round3-client §2/§5)。

### 10.3 相邻问题与已知取舍(只报告,未修)

同 §9.3 口径:以下为两个修复 agent 过程中报告但**未扩 scope 修复**的问题,原样汇总自 round3-host §6 与 round3-client §6。它们**不计入**上述 2 项、不冒充已修,列为已知取舍/后续候选:

HOSTFIX(round3-host §6,2 条相邻问题;同节另有 2 条口径说明,非缺陷——浏览器半边不涉及本问题、`apply()` 启动日志时序经分析不视为缺陷):

1. **加入者返回值可能旧于缓存**(R2host §5.2 遗留):去重语义固有;round3 复核仍未变,缓存单调后由下一轮轮询/刷新自愈。
2. **命中返回共享信封对象引用**(R2host §5.3 遗留):调用方(浏览器控制器)只读,未加防御性拷贝;round3 复核仍未变。

CLIENTFIX(round3-client §6,4 条):

1. **链级错误期的轮询仍每 30s 拉一次不可展示的看板**(后续候选):单 interval、可见性门控、inFlight 节流,有界但零收益(链恢复时整链会重拉看板,期间上账的数据用不上);本轮保留是为让审查点名的复现场景(轮询 tick → getBoard 成功 → 错误仍在)以同机制红→绿,「停轮」作为独立行为变化留给下轮论证。
2. **轮询在途期间刷新按钮被禁用**(round2 §7.2 既有项):链级错误期一次轮询看板请求会把用户唯一的恢复入口(手动刷新)禁用至多 20s(deadline),而该请求的结局无论如何清不了错;与发现 1 同根,停轮即可一并消除。
3. **loading 期轮询与链内看板请求的窄窗并发**:轮询在链尚未走到 loadBoard 时 tick,可能与链自己的看板请求并发一次(≤2,loadSeq 收口,后发者胜);修复前后行为一致,非本轮引入。
4. **round2 §7.1(dispatch 在 disposed 检查前落状态)与 §7.3(call() 形参展开的潜在误用点)仍然成立**,未在本轮处理。

---

*本报告为内部整改记录,不入分发包(`files` 不含 `notes/`)。*
