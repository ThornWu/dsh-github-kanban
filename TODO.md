# dsh-github-kanban — 执行 TODO

> **给执行 agent 的说明**:本文件自包含,不依赖外部对话上下文。按 Phase 顺序推进,每个任务有完成标志;执行前先读「执行守则」;标 🔒 的动作必须先征得用户同意。

## 背景与目标(必读)

为 dsh(DeepSeek Harness,本机版本 **0.2.0-rc.1**,`dsh web` 跑在 127.0.0.1:3080)开发一个 Web UI 插件:**GitHub Projects 看板面板**。

- 看板集成 GitHub Projects(Projects v2)数据,支持**切换项目**
- 与 Projects 数据**双向联动**:面板改 → 写回 GitHub;GitHub 改 → 面板更新
- 终极目标(Phase 3):看板同时暴露为 agent 工具,人与 agent 共用——LEAD 派单建卡、fe 交付移列

本仓库是独立产品仓;角色资产(fe/lead 等 preset)在 `/Users/thornwu/Projects/thorn/thorn-agent`,不要在这里重复建设。

## 调研结论(已验证的机制,直接用,不要重新发明)

### dsh / Cordis 侧(全部解剖过官方包,可信)

参考实现(源码只读,严禁改动):

```
$G = /Users/thornwu/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
```

| 参考对象 | 路径 | 学什么 |
|---|---|---|
| 团队面板(client UI 插件) | `$G/dsh-experimental-client-ui-agent-team` | client.js 的完整写法:`window.__ModuleLoader__.load()`、React 组件、槽位注册 |
| 三件套组合 bundle | `$G/dsh-experimental-agent-team-profile` | cordis.patch.yml 怎么同时挂 host 服务 + client UI(含 config 传参) |
| Remote 服务模式 | `$G/dsh-plugin-manager/lib/index.js` | `@Remote` 装饰器:宿主方法暴露给浏览器调 |
| 定时器 | `$G/cordis-plugin-timer` | 轮询调度,不用自写 |

**关键机制**:

- 浏览器端加载:`window.__ModuleLoader__.load({id, factory})`,factory 内可 `require("react")` 与 `@deepseek-ai/dsh-client-ui-primitives` 等官方原语;依赖在 package.json 的 `dsh.client.inject` 声明,`dsh.client.platform: "web"`
- 挂载:`ctx.slots.inject("槽位名", () => ctx.slots.register({name, id, order, locale, inject}, 组件))`
- 客户端服务:`ctx.slots` / `ctx.sessions`(含投影推送,数据变更自动到面板)/ `ctx.uiWorkspace.openSession` / `ctx.locale` / `ctx.effect`
- **本产品用槽位**:`sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`(右栏 tab,主看板);辅助入口 `conversation.session.header.actions`(页头按钮);大视图可选 `shell.overlay`

### GitHub Projects 侧

- 读:GraphQL Projects v2——项目列表、条目(items)、字段(Status 单选列即看板列)、views
- 写:`updateProjectV2ItemFieldValue`(移列)、`addProjectV2ItemById`、`deleteProjectV2Item`、`updateProjectV2ItemPosition`(拖动排序)
- 通知:org 级 webhook 有 `projects_v2_item` 事件,但需要公网 receiver——**本机场景放弃,用 cordis-plugin-timer 轮询(30s)**;GitHub Actions 无 projects_v2 触发器(与我们无关,自建轮询不受限)
- 认证:fine-grained PAT(或 classic,scope 含 repo + project 读写)🔒 由用户提供,**只走环境变量**;变量名以 2026-09-29 用户纠正为准(见 lib/index.js 的 `TOKEN_ENV`)

## 执行守则

1. **官方包零改动**:只读参考;所有产出放本仓库,以 `@local/` 链接方式装入 `~/.dsh/profiles/web`(pattern 与 thorn-agent 的 preset 一致:package.json dependencies + bundles 各加一行,pnpm install 后重启 dsh web)
2. **隐私红线**:GitHub token 永不进 git/日志/明文配置;`.credentials` 类文件加 .gitignore
3. **dsh 是 rc 版**:client 插件 API 可能 breaking;封装一层适配,别把 ModuleLoader/slot 调用散落各处
4. **提交纪律**:小步 commit,信息写动机;不 push 🔒
5. 遇到 API 与调研结论不符(官方包改版),以实际源码为准,把差异记录到 `notes/dev-notes.md`
6. 完成任务勾选 checkbox 并补一行实际结果

## 目标结构

```
dsh-github-kanban/
├── cordis.patch.yml        # 注册 host 服务 + client UI(参考 agent-team-profile)
├── package.json            # dsh.client.inject + exports
├── lib/
│   ├── index.js            # 宿主:GraphQL 客户端、字段映射、timer 轮询、@Remote 服务
│   └── client.js           # 浏览器:看板 UI(React),挂 sidebar.right.pane.tab
├── notes/
│   └── dev-notes.md        # 踩坑与 API 差异记录
├── scripts/
│   └── smoke-load.mjs      # 零依赖加载链路自检(包声明/座位注册/投影渲染)
└── TODO.md                 # 本文件
```

---

## Phase 1 — MVP:只读看板 + 项目切换(P0)

- [x] **1.1 脚手架**:按目标结构建包;通读 `$G/dsh-experimental-client-ui-agent-team/lib/client.js` 与 `agent-team-profile/cordis.patch.yml` 后动工;先做一个"hello 面板"挂上 `sidebar.right.pane.tab` 验证链路
  - 完成标志:dsh web 右栏出现 tab,内容随投影变化
  - 实测(建包完成):
    - 已建:`package.json`(`dsh.client.inject` 包名数组 + `platform: "web"` + `exports["./client"]`)、`cordis.patch.yml`(**一行 insert** 同时挂 host 服务与 client UI)、`lib/index.js`(宿主服务骨架 + 宿主适配层)、`lib/client.js`(hello 面板 + 客户端适配层:座位/tab 类型/文案/样式注入全部收在一节)、`notes/dev-notes.md`、`scripts/smoke-load.mjs`(额外加的零依赖自检,见下)
    - 静态链路验证已过:`node scripts/smoke-load.mjs` **31/31** —— 注册 id 等于包名、load 阶段零副作用、物化时注入带归属的样式、`apply(ctx)` 按 **keyed** 规则注册 1 个 tab 类型 + 2 个座位(key = 类型 id)、宿主半边注册 `githubKanban` 服务骨架且不含网络/凭据面、body 在**两份不同会话投影快照**下读数不同(1→3 会话、模型 glm-5.3→deepseek-v4)
    - **未做/待办**:右栏真机出现 tab —— 1.1 只交付脚手架与静态验证,**装进 `~/.dsh/profiles/web` 并重启 dsh web 属 1.4**;真实 GitHub 数据与 token 属 1.2;面板视觉未过 UE
    - 与调研结论的差异(重要,动 1.2 前先读):`notes/dev-notes.md` —— 关键三条:①`sidebar.right.pane.tab` 是 **keyed** 座位,必须先向 `ctx.sidebarRightTabs` 注册 tab 类型,且 keyed 用 `key` 不是 `id`;②host→浏览器调用需要 typert 生成物(`./typert` + `./remote`)或手写 wire schema,`@Remote` 本身不够;③右栏 tab 的 props 来自标准 props 座位(`useTabInfo`/`useSessions`/`useProjection`),不必依赖 `ctx.sessions`
- [x] **1.2 GitHub 读链路**:token 从环境变量取(缺失时面板给配置引导,不报错堆栈);GraphQL 拉项目列表 → 项目切换器;拉当前项目 items + Status 字段 → 分列渲染(列序 = Status 选项序;卡片显示标题、负责人、标签)
  - 完成标志:能切换 ≥2 个项目(用户的实际 Projects),看板与 GitHub 网页端一致
  - 实测(静态验证完成,真机等 1.4 装 profile):
    - 宿主半边:GraphQL 客户端(全局 fetch,零新增依赖,分页拉到 ≤200 items)、字段映射纯函数(列序 = Status 选项序、空列保留、缺 Status 字段退化单列)、`githubKanban` 远程面 3 方法(status / listProjects / getBoard)
    - token 只走 `GITHUB_TOKEN`(用户纠正,原调研写名弃用):缺失时 status() 报布尔标志、面板出配置引导;错误文案经脱敏(token 值 → [redacted]);永不进日志或返回数据
    - 宿主→浏览器路线(实测决策,见 notes/dev-notes.md 差异 9):生成器装得到但是 monorepo 的 TS 工程分析器,弃;改走「宿主 SRC 回退(typertRemote 绑定 + v1 原型标记) + 浏览器手写 strict 占位清单经 ctx.remote.$mount」,零新增依赖
    - 浏览器半边:token 配置引导(无报错堆栈)、项目切换器(切换重拉)、按 Status 选项序分列、卡片三要素(标题/负责人/标签)、加载/错误/空态齐全,样式仍走带归属的 injectPluginStyles
    - 自检:node scripts/smoke-load.mjs **60/60**(原 31 项重写扩到 58:远程清单、token 红线、GraphQL 纯度、字段映射、面板数据流;审查后 +2 先红后绿用例);真实网络调用不进自检
    - 独立审查(code-reviewer,747d40d):修后可合,无 P0;2 条 P1 已修(888ccec 初始失败被兜底 ready 掩盖成空板 / d24c662 切换项目无请求序守卫);SRC 回退路线经 $G 源码逐处核验成立
    - **未做/待办**:真机看板与 GitHub 网页端一致性比对(需 1.4 + 用户提供 token 🔒);org 名下项目暂不可见(viewer.projectsV2 只覆盖 viewer 名下,遗留项)
- [ ] **1.3 轮询刷新**:cordis-plugin-timer 每 30s 重拉,投影推送更新;面板折叠时降频或暂停
  - 完成标志:网页端改卡片,面板 30s 内跟上
  - 顺带清理(1.2 审查遗留 P2,本轮不修):错误态吞掉工具栏(切换器/刷新按钮不可见,应保留);刷新完成态缺 totalCount 口径显示;mapBoard 对缺字段/畸形节点无守卫;fields(first:40) 截断或 Status 字段被改名时静默退化为「全部」单列、应给提示
- [ ] **1.4 装入 profile**:`@local/thorn-github-kanban` 链接进 `~/.dsh/profiles/web`,重启验证
  - 完成标志:全新启动 dsh web,插件自动生效

## Phase 2 — 双向联动:拖卡写回(P1)

- [ ] **2.1 移列写回**:拖卡到新列 → `updateProjectV2ItemFieldValue`;乐观更新 + 失败回滚 + toast
- [ ] **2.2 卡片操作**:新建草稿卡(`addProjectV2ItemById`)、归档;列内拖动排序(`updateProjectV2ItemPosition`)
- [ ] **2.3 冲突处理**:写回前后版本校验(UpdatedAt),冲突时以 GitHub 为准重拉并提示
  - 完成标志:全流程双向——面板拖卡网页端变化;网页端改,面板 30s 内同步

## Phase 3 — Agent 工具化(核心增值,P1.5)

- [ ] **3.1 工具暴露**:Remote 服务同时注册为模型工具(参考 `$G/dsh-experimental-tool-agent-team` 的注册方式):`gh_board_view` / `gh_card_create` / `gh_card_move`
- [ ] **3.2 LEAD 联动**:与 thorn-agent 仓的 lead preset 协作——派单时建卡、完成时移列;联动改动走 thorn-agent 的 PR 式修改守则
  - 完成标志:对 LEAD 说一句话,看板出现对应卡片;fe 交付后卡片自动移列
- [ ] **3.3 使用文档**:工具说明写进 lead/fe 的 skill 引用(thorn-agent 仓,PR 式)

## Phase 4 — 可选增强(P2,默认不做,用户点名才做)

- [ ] webhook receiver(公网隧道)+ 实时推送,替代轮询
- [ ] 迭代(Iteration)字段视图、多视图(view)切换
- [ ] 看板大视图(shell.overlay 全屏模式)

## 挂起 / 待用户决策

- [ ] GitHub token 提供(Phase 1.2 前置)🔒
- [ ] 用户的 Projects 所在主体(org 还是个人账号)确认——影响 webhook 可用性(轮询不受影响)
- [ ] 完成后是否 push 远端建仓 🔒

---

*执行 agent 从 Phase 1.1 开始。改本文件(勾选、补记)允许,这是主日志。*
