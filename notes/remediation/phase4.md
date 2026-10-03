# 阶段 4(开源交付准备)执行记录

执行 agent:DOCS agent(S4.1–S4.8)。日期:2026-10-03。分支 `fe/thornwu-kanban-global`,基线 HEAD `f6ad528`(包版本 0.7.0)。与阶段 1(可靠性修复,改 `lib/*.js`、`scripts/`)的 agent 并行,文件所有权互不重叠。

本文档是内部整改记录,不属于分发内容(`files` 字段不含 `notes/`)。

## 0. 交付总览

| 文件 | 动作 | 任务 |
| --- | --- | --- |
| `README.md` | 新建 | S4.1、S4.2(配置文档)、S4.4(许可证标注)、S4.8(干净 checkout 步骤) |
| `CONTRIBUTING.md` | 新建 | S4.5 |
| `SECURITY.md` | 新建 | S4.5 |
| `CHANGELOG.md` | 新建 | S4.5 |
| `notes/remediation/phase4.md` | 新建 | 本文件 |
| `cordis.patch.yml` | 修改 | S4.2 |
| `package.json` | 修改(仅元数据) | S4.3、S4.8 |
| `TODO.md` | 重写 | S4.6 |

验证:改动后 `node scripts/smoke-load.mjs` **110/110 通过**(该脚本读 `TODO.md`、`cordis.patch.yml`,重写后仍全绿);`npm pack --dry-run` 出 5 个文件(见 S4.8)。未创建 LICENSE(见 S4.4)。未 commit/push(待用户授权)。

## 1. 逐任务状态

### S4.1 README.md — 完成

位置:仓库根 `README.md`(中文,与仓库语言一致)。章节:简介与两半架构 → 能力与限制(含「明确不支持」:双向写回/拖卡/Agent 工具/webhook;数据上限表)→ 兼容版本(**已验证/待验证分列**:dsh 0.2.0-rc.1 + 0.2.0-rc.2 已验证、其余待验证;Node 24 已验证、18–23 待验证、下限 18;浏览器只验过 dsh 自带前端)→ 安装(profile 双行 link 法,按本机 `~/.dsh/profiles/web` 实测 pattern 写)→ 配置(`GITHUB_TOKEN`、fine-grained PAT scope、`repos` 格式与校验、`cache` TTL)→ 权限说明(只读、token 不出宿主)→ 排障(错误码表 + 瞬态重试语义 + 快照行为)→ 升级卸载 → 开发与测试(自检入口、干净 checkout 步骤、无构建说明)→ 路线图 → 许可证(待定)→ 反馈安全。

**关于阶段 1 目标行为的写法**:排障节的快照/超时/来源级警告/恢复入口按整改**目标行为**描述,并明确标注「若与手上版本不符,说明整改尚未合入,以 CHANGELOG Unreleased 为准」;当前 0.7.0 基线的快照行为(默认开启、键 `snapshot/v1`)也如实写明,附手动清理命令。**衔接要求:阶段 1 agent 合入后请校对 README 排障节与 CHANGELOG Unreleased 的「进行中」段,把目标行为改为既成事实。**

### S4.2 默认 repos 置空 — 完成

`cordis.patch.yml`:`config.repos` 由三个个人仓库改为 `[]`,文件头注释补齐 config 三项(`repos`/`cache`/token 红线)与 `owner/name` 校验规则(非法条目跳过、缺席仓不拖垮整板),示例改为注释形式的 `octocat/*`。`package.json` 无 repos 类默认配置,无需处理。README「配置」节同步写清格式与校验。

### S4.3 package.json 元数据 — 完成

保留 `private: true`、`@local/` 前缀、`files`/`exports`/`dsh` 段不动(仅 files 增补 README,见 S4.8)。新增:`description` 重写、`keywords`(8 个)、`engines.node: ">=18"`(依据:宿主半边用全局 `fetch`(Node 18 起稳定),数值分隔符/可选链/类字段等语法下限更低;开发实测 Node 24)、`homepage`/`bugs` 用字面量 `<owner>` 占位。**运行版本要求在 README 兼容表中分「已验证/待验证」如实标注**。更名/公开与否未动,见 §3 待决定。

### S4.4 LICENSE — 未创建(按规则,发布阻塞项)

- `LICENSE` 未创建、`package.json` 未写 `license` 字段:许可证是所有者的授权决定。README「许可证」节与本文均标注**待所有者决定,发布阻塞**。
- 候选对比(仅供所有者参考):

| 候选 | 要点 | 适合 |
| --- | --- | --- |
| MIT | 一页纸,宽松,生态默认;无专利条款 | 想最大化被引用/被顺手用的工具类项目 |
| Apache-2.0 | 宽松 + 明确专利授权 + 商标/贡献条款,文本长 | 担心专利风险或未来可能被商业化集成 |
| (不授权/暂缓) | 保持私有 | 若暂不公开,什么都不用做;`private: true` 已表达 |

个人非正式建议:本插件是小型工具、零依赖,MIT 足够;若在意专利条款选 Apache-2.0。
- **依赖与复制资源检查**:运行时零 npm 依赖(`package.json` 无 `dependencies`/`devDependencies`)。代码未逐字复制官方包,但实现**参考**了官方包源码并刻意对齐其 wire 契约:`lib/index.js` 的 Remote 标记(`REMOTE_METHOD_DESCRIPTOR` 键名、描述符形状)与 `@deepseek-ai/dsh-typert-protocol` 逐字段一致;`lib/client.js` 的 remote 清单形状对照 `dsh-typert-registry`。这些是接口契约的事实标准(类似实现同一协议),非著作权意义上的代码复制;dsh 官方包自身的许可证条款未在本机核对过——**若日后公开且引用了官方类型定义的表述,建议所有者顺手核对 dsh 包的 license 字段**(dev-notes 引用过官方 `.d.ts` 的契约描述)。此为低风险提示,不构成阻塞。

### S4.5 CONTRIBUTING / SECURITY / CHANGELOG — 完成

- `CONTRIBUTING.md`:本地开发(零依赖、无构建、单文件约束)、测试要求(改行为必须带用例、smoke 的替身边界、真机验证说明)、提交与 PR 规范(当前无公开远端,写明公开后流程)、issue 反馈要求(先读排障、附版本与 config、**凭据红线**)。
- `SECURITY.md`:支持范围(仅最新版;仅本插件代码)、凭据处理模型、报告渠道(**待所有者提供安全邮箱/私密渠道,当前标注待定**;不开公开 issue)、误泄漏处置(先吊销再清理)。
- `CHANGELOG.md`:从 git log(28 commits)+ dev-notes 梳理出 0.1.0→0.7.0 共 10 个版本的记录(0.1.0 脚手架与 hello 链路、0.2.0 读链路、0.3.0 轮询、0.3.1 全局面板迁移、0.3.2 rc.2 真机四修、0.4.0 仓库级项目与 closed 过滤、0.5.0 提速、0.5.1 contentMissing 诊断、0.6.0 移除调试区、0.7.0 瞬态重试),加 **Unreleased** 段容纳本轮整改(文档/默认配置/元数据 = 已完成;可靠性修复 = 标注「进行中,以最终合入为准」,由阶段 1 agent 落实后改写)。

### S4.6 TODO.md 重写 — 完成

重写为路线图(P0 Alpha 收尾 → P1 双向写回 → P1.5 Agent 工具 → P2 可选增强)。纠偏:①入口统一为「左栏 Global panels + 主区页面」,右栏 tab 标注为 0.1.0–0.3.0 的废弃形态;②dsh 版本明确为 rc.1(装载链路首验)与 rc.2(数据链路真机)两个已验证版本。历史事实保留:Phase 1 完成态、遗留的有卡项目真机核对(原 1.4 唯一未勾项)、验收来源指向 `notes/dev-notes.md`、`git show f6ad528:TODO.md` 与 `review/`(注明未跟踪)。个人绝对路径全部移除,改为「参考实现定位(通用方法)」(`npm root -g` + 命名空间路径,示例用 `~` 泛化写法);个人仓库地址全部移除(角色编排联动改写为「与外部 agent 角色资产协作」)。常守规则(隐私红线/官方包零改动/零依赖无构建/rc 适配)沿袭保留。

### S4.7 脱敏扫描 — 完成(结论如下;只给定位,不复制敏感值)

扫描范围:全部跟踪文件、`git log -p --all` 全量、`npm pack --dry-run` 分发内容。模式:token 形状(`ghp_`/`github_pat_`/`xox`/AKIA/私钥头)、邮箱、个人绝对路径、个人仓库名、IP/端口。

**结论:未发现任何凭据或 token 值**(工作区与全历史均无命中;token 红线执行到位)。发现的非凭据类项:

1. 个人绝对路径 `/Users/thornwu/...`:
   - `TODO.md:13`、`TODO.md:22` — **已随重写消除**;
   - `notes/dev-notes.md:4`($G 参考根)— **不在我的文件所有权内,保留**(内部开发记录;不入分发包)。建议:公开交付时保留亦可,或参照新 TODO 的通用写法改写该行(交后续 agent/所有者)。
2. 个人仓库名(`ThornWu/thorn-agent`、`ThornWu/thornwu-com`、`ThornWu/chaoshan-asr`):
   - `cordis.patch.yml:15-17` — **已消除**(repos 置空);
   - `TODO.md` 多处 — **已随重写消除**;
   - `scripts/smoke-load.mjs:512,536,550,553,571,589-600,939-957`(测试夹具:仓名、`@ThornWu's untitled project` 样例文案)— **属阶段 1 agent 的文件,未动;建议改为中性样例(如 `octocat/hello-world`)**。属虚构测试数据,风险等级低(暴露 owner 身份与仓名),非发布阻塞;
   - **git 历史**中上述文件的历史版本同样含个人仓库名(以及历史版 TODO/cordis.patch.yml 的绝对路径与仓名)。**改写历史被本轮规则禁止**;若所有者认为这些仓名需从历史抹除,须单独授权 history rewrite(filter-repo)并重写全部 commit 哈希——默认不做,仅记录。
3. `TODO.md:7`(旧版)的 `127.0.0.1:3080` — 本机回环地址,非敏感,已随重写消失;历史中留存,无需处理。
4. 分发内容(`npm pack`:lib 两文件 + cordis.patch.yml + README + package.json):**干净**,无凭据、无个人路径、无个人仓名(cordis.patch.yml 已置空)。`homepage`/`bugs` 的 `<owner>` 是显式占位符,不是泄漏。
5. 未跟踪的用户私有产物 `memory/`(journal、lead.md)与 `review/`(5 份审查记录)、`REMEDIATION_PLAN.md`:**未动、未删、未提交**。建议:保持未跟踪;若仓库将公开,可把三者加进 `.gitignore`(`.gitignore` 不在我的所有权内,交后续 agent 或所有者执行);`review/` 中如含真实 token 片段请在公开前自查一遍(本轮未读取其内容细节,仅列目录)。

### S4.8 分发内容检查 — 完成

- `npm pack --dry-run` 实测 5 文件:`package.json`、`README.md`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`。README 由 `files` 显式列入(npm 亦会自动带入)。**构成可安装最小集**:dsh 装载只读 package.json 的 `dsh` 段 + `exports` 指到的两个文件 + patch;`notes/`、`scripts/`、`TODO.md` 等不进包(开发资料留仓库)。
- 实际安装路径是 profile `link:` 整目录软链,dsh 按声明取文件,故仓库 checkout 本身即完整可安装;`npm pack` 集合用于未来可能的 tarball/npm 分发。
- **干净 checkout 安装验证步骤**已写入 README「开发与测试」(clone → smoke 全绿 → profile 两行链接 → 重启 → 面板出现/token 引导)。
- **无构建流程**维持现状:浏览器单文件直接交付是 dsh 平台约束(不打包不转译),引入构建反而与「零依赖」目标冲突,且无收益;README/CONTRIBUTING 已写明此约束。若未来浏览器半边需要拆分或 TS,再评估构建(届时补「干净 checkout 重建分发物」验证)。

## 2. README 行为描述与实现的校对点(交阶段 1/3 agent)

阶段 1 修复合入后,请校对并同步三处(均为我独占文件之外或需联动更新):

1. README「排障」快照段:目标行为(默认关闭/身份隔离/到期校验)与实现对齐后,把「若与此不符说明尚未合入」的免责句收紧为事实陈述;CHANGELOG Unreleased「进行中」段同步改「已完成」。
2. README 排障表的超时/来源级警告行:以阶段 1 最终语义为准(我按 S1.2/S1.4/S1.6 的完成条件写的)。
3. `scripts/smoke-load.mjs` 的个人仓名夹具改为中性样例(见 S4.7 第 2 条)。

## 3. 待所有者决定的事项(清单)

| 事项 | 现状 | 动作 |
| --- | --- | --- |
| **许可证**(发布阻塞) | 无 LICENSE、无 license 字段 | 从 MIT / Apache-2.0(对比见 S4.4)或其他中选定;决定后创建 LICENSE + 补 `package.json` license 字段 + 更新 README「许可证」节 |
| 包名与 `@local/` 前缀 | `@local/thorn-github-kanban`,`private: true` | 公开/npm publish 前决定正式名与 namespace;当前名仅本地链接用 |
| `homepage`/`bugs` 真实地址 | 字面量 `<owner>` 占位 | 公开仓库建立后替换 |
| 安全报告渠道 | SECURITY.md 标注「待定」 | 提供安全邮箱或私密渠道后更新 |
| git 历史中的个人仓名 | 保留(见 S4.7) | 若需抹除须单独授权历史重写;默认不做 |
| `notes/`、`memory/`、`review/`、`REMEDIATION_PLAN.md` 的公开策略 | 均不入分发;后三者未跟踪 | 公开前决定是否 gitignore 或补跟踪 |

## 4. 阶段 5(Alpha 验收)衔接建议

- 验收按 REMEDIATION_PLAN §8 从干净 checkout 走 README 安装步骤(即 S4.8 已写的入口)。
- CHANGELOG Unreleased 需在阶段 1 合入、验收后定版(建议 0.8.0 或直接 1.0.0-alpha.1,由所有者定)。
- 发布前最小门槛:许可证已选 + README 免责句已收紧 + smoke 夹具脱敏完成。
