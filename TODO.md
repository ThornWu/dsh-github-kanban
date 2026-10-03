# dsh-github-kanban — 路线图

> 本文件自 2026-10-03 起是**路线图与待办清单**。此前它曾是逐任务的执行日志,历史原文可 `git show f6ad528:TODO.md` 查看;踩坑记录与 dsh API 差异沉淀在 `notes/dev-notes.md`,历轮审查结论在 `review/`(未跟踪的内部目录,公开交付不必带上)。版本变化看 [CHANGELOG.md](CHANGELOG.md)。

## 产品定位

dsh(DeepSeek Harness)Web UI 的 **GitHub Projects v2 只读看板面板**:项目切换、Status 选项序分列、卡片三要素(标题/负责人/标签)、30s 轮询。当前为只读 Alpha,写回与工具化在路线图中。

### 两处历史描述纠偏(以实现为准)

1. **面板入口是左栏「Global panels」+ 主区页面**(0.3.1 起,`sidebar.panellist` + `main` 座位,跨会话全局面板)。0.1.0–0.3.0 期间曾是右栏 tab(`sidebar.right.pane.tab`),已废弃——旧文档/旧提交里提到「右栏 tab」均指废弃形态。
2. **dsh 已验证版本是两个**:0.2.0-rc.1(装载/座位链路首验)与 0.2.0-rc.2(数据链路真机验收,2026-10-01,「四修三重启」见 dev-notes 差异 11)。不是单一版本;其余版本待验证。

## 当前状态(2026-10-03)

- 只读核心链路完成(0.1.0 → 0.7.0):项目列表(viewer 用户级 + 仓库级合并去重、closed 过滤)、分列、卡片三要素、轮询(不可见暂停/节流)、宿主 TTL 缓存与并发去重、localStorage 乐观首屏、瞬态连接自动重试。
- **遗留未闭环**:有卡项目的真机核对(列序、标题、负责人、标签、计数与 GitHub 网页端一致)——Phase 1.4 唯一未勾项,当时验收所用的项目均无卡片。
- **进行中**:整改轮(2026-10-03 起):可靠性修复 + 测试体系 + 文档与分发准备。快照默认关闭、请求超时、单仓来源级警告、首载恢复入口等目标行为见 README「排障」与 CHANGELOG「Unreleased」。

## P0 — Alpha 收尾(当前优先)

- [ ] **有卡项目真机核对**:≥2 个项目、≥1 个有卡,核对列序/标题/负责人/标签/计数;顺带记录真机刷新窗口证据(GitHub 侧改动 → 面板 30s 内跟上)。
- [ ] **整改轮验收**:可靠性修复(快照身份隔离、超时与取消、来源级警告、恢复入口、重试上限语义)逐项过行为用例。
- [ ] **干净 checkout 安装验证**:按 README「开发与测试」的步骤在全新目录走通安装(不依赖作者机器的隐含文件)。
- [ ] **发布决定(待所有者,阻塞项)**:许可证(MIT / Apache-2.0 等候选对比见 `notes/remediation/phase4.md`)、包名与 `@local/` 前缀去留、是否公开/npm publish、bugs 与 homepage 真实地址(当前为占位)。**没有 LICENSE 之前不对外发布。**

## P1 — 双向写回(读写联动)

- [ ] **移列写回**:拖卡到新列 → `updateProjectV2ItemFieldValue`;乐观更新 + 失败回滚 + toast。
- [ ] **卡片操作**:新建草稿卡(`addProjectV2ItemById`)、归档;列内拖动排序(`updateProjectV2ItemPosition`)。
- [ ] **冲突处理**:写回前后版本校验(UpdatedAt),冲突时以 GitHub 为准重拉并提示。

完成标志:全流程双向——面板拖卡网页端变化;网页端改,面板 30s 内同步。

## P1.5 — Agent 工具化(核心增值)

- [ ] **工具暴露**:Remote 服务同时注册为模型工具(参考官方 `dsh-experimental-tool-agent-team` 的注册方式):`gh_board_view` / `gh_card_create` / `gh_card_move`。
- [ ] **角色编排联动**:与外部 agent 角色资产协作——派单建卡、交付移列;联动改动走对应仓库的 PR 式流程。
- [ ] **使用文档**:工具说明写进相关角色的 skill 引用。

完成标志:对编排角色说一句话,看板出现对应卡片;交付后卡片自动移列。

## P2 — 可选增强(默认不做,点名才做)

- [ ] webhook receiver(公网隧道)+ 实时推送,替代轮询(注意:org 级 `projects_v2_item` webhook 需要公网 receiver,本机场景默认用轮询)。
- [ ] 迭代(Iteration)字段视图、多视图(view)切换。
- [ ] 看板大视图(`shell.overlay` 全屏模式)。

## 常守规则(从执行日志沿袭)

1. **隐私红线**:GitHub token 只走宿主环境变量 `GITHUB_TOKEN`,永不进 git/日志/配置/浏览器;错误文案脱敏。
2. **官方包零改动**:dsh 官方包只读参考;所有产出放本仓库。
3. **零依赖、无构建**:不新增 npm 运行时依赖;浏览器半边单文件交付是平台约束。
4. **dsh 是 rc**:适配层集中管理,升级按 `notes/dev-notes.md` 的核对清单逐项核对。

## 参考实现定位(通用方法)

dsh 官方包是第一手参考(源码只读)。**定位方法**:找到本机 dsh 的全局安装目录,其 `node_modules` 内的 `@deepseek-ai` 命名空间即全部官方包。例如 dsh 经 nvm 管理的 Node 全局安装时:

```sh
npm root -g
# 官方包命名空间:<全局包根>/@deepseek-ai/dsh/node_modules/@deepseek-ai/<包名>
```

| 参考对象 | 包名 | 学什么 |
| --- | --- | --- |
| 团队面板(client UI 插件) | `dsh-experimental-client-ui-agent-team` | client.js 完整写法:`window.__ModuleLoader__.load()`、React 组件、槽位注册 |
| host + client 组合 bundle | `dsh-experimental-agent-team-profile` | cordis.patch.yml 如何同时挂 host 服务与 client UI(含 config 传参) |
| Remote 服务模式 | `dsh-plugin-manager` | `@Remote` 装饰器:宿主方法暴露给浏览器 |
| 定时器 | `cordis-plugin-timer` | 轮询调度 |

与调研结论不符时以实际源码为准,差异记录进 `notes/dev-notes.md`。

## 挂起 / 待所有者决策

- [ ] GitHub token 的提供与 scope 收敛(只读,按 README「配置」)。
- [ ] 许可证、包名、公开与否、远端仓库与 bugs 入口(同 P0 发布决定)。
