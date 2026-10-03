# dsh-github-kanban

[dsh(DeepSeek Harness,npm `@deepseek-ai/dsh`)](https://www.npmjs.com/package/@deepseek-ai/dsh) Web UI 的 **GitHub Projects(Projects v2)只读看板面板**。在 dsh web 左栏「Global panels」打开「GitHub 看板」,主区即可浏览你的 Projects v2 看板:按 Status 单选字段的选项序分列,卡片显示标题、负责人、标签,定时轮询保持数据新鲜。

一个 npm 包同时提供两半:

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主半边 | `lib/index.js` | GraphQL 客户端(读 GitHub Projects v2)、字段映射、TTL 缓存,经 `@Remote` 暴露 `ctx.remote.githubKanban` 服务(`status` / `listProjects` / `getBoard`) |
| 浏览器半边 | `lib/client.js` | 看板 UI(React),注册左栏面板入口与主区页面,轮询刷新 |

两半通过 `cordis.patch.yml` 一行 insert 挂载。零运行时依赖(不新增任何 npm 包),无构建流程(浏览器半边单文件直接交付)。

> **状态:只读 Alpha。** 本项目处于 0.x 阶段,只做「读」;写回 GitHub 的能力在路线图中(见文末)。安装、配置与排障见下文。

## 能力与限制

**当前支持**

- 项目切换器:列出 **viewer(你)名下** 的 Projects v2,外加 **配置的仓库**(`repos`)link 的项目;两者按项目 id 去重(同 id 保留带仓库归属的版本,切换器中以 `owner/name` 标注来源);已关闭(closed)的项目被过滤。
- 看板分列:列 = 项目内名为 `Status` 的单选字段的选项顺序;空列保留;没有该字段时退化为单列「全部」并给出原因提示(未创建 / 疑似改名 / 字段数超限)。
- 卡片三要素:标题(Issue / PR 带原文链接)、负责人(Assignees)、标签(Labels)。
- 刷新:30 秒轮询(页面不可见时暂停,上一轮未返回时不叠发);「刷新」按钮绕过缓存强制重拉。
- 稳健性:所有 GitHub 请求具备应用层超时(默认 15s,可配);单个配置仓库不存在 / 无权限 / 查询失败时跳过该来源,面板顶部以来源级警告提示,不影响其余项目;错误信息脱敏,不含 token。
- 恢复:token 已配置时,项目切换器与「刷新」按钮在任何状态(含首载失败、空列表)常驻可用。

**明确不支持(勿期望)**

- **双向写回**:面板上改任何东西都不会写回 GitHub。移列、改字段、建卡、归档、排序均未实现。
- **拖拽卡片**:看板不可拖动。
- **Agent 工具**:尚未把看板暴露为模型可调用的工具(路线图 P1.5)。
- **webhook / 实时推送**:只有轮询,没有事件推送。
- 迭代(Iteration)字段视图、多视图(view)切换、全屏大视图。
- 浏览 org 名下全部项目:只读 viewer 名下 + 指定仓库 link 进来的项目。

**数据上限(超出会有提示,不会假称全量)**

| 项 | 上限 | 超出行为 |
| --- | --- | --- |
| 单板条目(items) | 200 | 显示「已加载 x / y 张」,看板可能不完整 |
| 项目列表 | 300 | 截断 |
| 字段定义单页 | 40 | Status 字段可能未加载,给出提示 |
| 每卡字段值 / 标签 / 负责人 | 30 / 20 / 10 | 截断 |

## 兼容版本

| 依赖 | 已验证 | 待验证 |
| --- | --- | --- |
| dsh(DeepSeek Harness) | 0.2.0-rc.1(装载/座位链路首验)、0.2.0-rc.2(数据链路真机验收,2026-10-01) | 其他版本。dsh 处于 rc 阶段,插件 API 可能 breaking;升级 dsh 后若面板异常,见「排障」 |
| Node.js | 24.x(开发与自检环境) | 18–23。运行下限为 18(宿主半边用全局 `fetch`),更低版本无法拉取 GitHub。开发/测试(Node 测试体系)需 ≥ 20.19,见「开发与测试」 |
| 浏览器 | dsh web 自带前端(真机) | 未做独立浏览器矩阵。需要支持 React 18 级别语法;`localStorage` 可用性是可选的(缺失自动降级,仅失去「上次选中项目」的记忆) |

## 安装

本插件以本地链接方式装进 dsh 的 web profile(与官方实验插件的装法一致)。假设仓库位于 `<repo>`(下同):

1. 在 profile 的 `package.json` 里声明依赖(通常在 `~/.dsh/profiles/web/package.json`;`link:` 指向你本机的仓库路径,便于改代码即时生效):

   ```jsonc
   {
     "dependencies": {
       "@local/thorn-github-kanban": "link:<repo>"
     }
   }
   ```

2. 在同一文件的 `dsh.profile.bundles` 数组加一行(与其他 bundle 并列):

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@local/thorn-github-kanban"
         ]
       }
     }
   }
   ```

3. 在 profile 目录执行包管理器安装(pnpm workspace 的 profile 用 `pnpm install`),然后**完全退出并重启** `dsh web`。

4. 打开 dsh web,左栏「Global panels」应出现看板入口;点击后主区渲染面板。若未配置 token,面板会显示配置引导——这同时说明插件已正确装载。

干净 checkout 的安装验证步骤见「开发与测试」。

## 配置

### GitHub token(必需)

- 在**启动 dsh 的环境**里设置环境变量 `GITHUB_TOKEN`;dsh 启动时读取,改完需要重启 dsh web。
- 推荐 **fine-grained PAT**,最小权限:
  - 账号级 **Projects: Read-only**(读你的项目与字段);
  - 相关仓库的只读访问(Repository permissions 至少 **Issues: Read-only**、**Pull requests: Read-only**——卡片标题与链接需要它们;缺了会出现满屏「(无标题)」,面板会给出对应提示)。
- classic PAT 也可用,但授权面更大,不推荐。
- token **只**存在宿主进程内存里:不进配置文件、不进 git、不进日志、不传给浏览器;错误信息中的 token 值会被替换为 `[redacted]`。

### 仓库级项目(可选,`cordis.patch.yml`)

默认 `repos` 为空(只看 viewer 名下项目)。要并入某些仓库 link 的 Projects v2,编辑 `cordis.patch.yml`:

```yaml
- insert:
    - id: thorn-github-kanban
      name: '@local/thorn-github-kanban'
      config:
        repos:
          - octocat/hello-world
          - octocat/another-repo
```

- 每项必须是 `owner/name` 格式(允许字母、数字、`.`、`-`、`_`);**格式不符的条目被静默跳过**,配置后可在面板里验证预期来源是否出现。
- 仓库不存在或无权限:该来源缺席,其余来源不受影响。
- 改动后重启 dsh web 生效。配置里**永远不放 token**。

### 缓存与超时(可选)

`config.cache` 与 `config.requestTimeoutMs` 可覆盖宿主默认值(一般无需调整):

```yaml
        cache:
          projectsTtlMs: 60000   # 项目列表缓存(默认 60s)
          boardTtlMs: 15000      # 看板缓存(默认 15s,刻意 < 轮询周期 30s,保证轮询拿到新数据)
          maxBoards: 8           # 看板缓存容量:LRU 按写入序淘汰最旧(默认 8 块)
        requestTimeoutMs: 15000  # 单次 GitHub 请求(建连+响应体读取)应用层超时,默认 15s
```

token 轮换(环境变量换值重启)后,旧 token 写入的缓存自动失效,不会串数据。

## 权限说明

- 本插件对 GitHub **只读**:GraphQL 查询仅限 `viewer` / `repository` 下的 Projects v2 读取,不存在任何 mutation。
- token 通过环境变量进入宿主进程,浏览器半边只见到「是否已配置」的布尔值与脱敏后的错误文案。
- 浏览器侧的 `localStorage` 只保存「上次选中的项目」一个键(不含任何看板业务数据,更不含凭据);无 `localStorage` 的环境自动降级。

## 排障

先看面板顶部的状态/错误文案——所有失败都是结构化的 `[错误码] 说明`,不是堆栈。

| 现象 | 原因与处理 |
| --- | --- |
| 显示「尚未配置 GitHub 访问令牌」 | 按 `GITHUB_TOKEN` 引导设置并**重启 dsh web**(变量在启动时读取) |
| `[token_missing]` 突然出现 | 宿主进程环境变化;重启 dsh web |
| `[http_error]` / `[graphql_error]` | GitHub 侧拒绝:检查 PAT 是否过期、是否有目标项目/仓库的读权限;`graphql_error` 文案已脱敏 |
| 卡片满屏「(无标题)」 | PAT 缺 Issues / Pull requests 读权限(字段值能返回但卡片内容为空);按面板提示补权限,下轮刷新生效 |
| `[project_not_found]` | 项目已删除、关闭或失去权限;用切换器换一个项目 |
| `[gateway/internal]` / `Failed to fetch` | dsh 连接/服务未就绪(常见于 dsh 刚启动或重启)。**瞬态失败会自动重试**:装载链内退避重试,错误态下每 4s 重试、15 轮上限后停止等手动操作;「刷新」按钮任何时候可以手动恢复 |
| `[timeout]` / `[remote_timeout]` | 请求超过应用层期限:前者是宿主侧 GitHub 请求超时(默认 15s,`config.requestTimeoutMs` 可调),后者是浏览器到宿主的远程调用超时。两者都归入瞬态失败,会自动重试;持续出现时查网络延迟与 GitHub 状态 |
| 单个配置仓库的项目没出现 | 该仓不存在/无权限(PAT 没覆盖到它),或 `owner/name` 格式写错(格式错的条目会被跳过);查询失败的来源会在面板顶部显示一行来源级警告 |
| 看板数据不完整 | 检查「已加载 x / y 张」提示:x < y 说明超出单次拉取上限(200) |
| dsh 升级后面板打不开 | dsh rc 版 API 可能 breaking。看浏览器控制台中 `[dsh-github-kanban]` 前缀的契约报错,对照仓库内开发记录(`notes/dev-notes.md` 的「升级 dsh 核对清单」)更新适配层 |

**本地存储行为**:浏览器 `localStorage` 只保存「上次选中的项目」一个键(30 天到期,不含任何看板业务数据与凭据)。0.5.0–0.7.0 曾把整板看板快照写入键 `@local/thorn-github-kanban/snapshot/v1`,**0.8.0 起该能力已移除**(隐私优先:业务数据不再离开宿主内存);旧键在面板首次加载时自动清理。从旧版本升级后如想立即手动清理,可在浏览器控制台执行 `localStorage.removeItem("@local/thorn-github-kanban/snapshot/v1")`。

## 升级与卸载

**升级**:仓库内 `git pull`(或更新你的 fork),profile 用 `link:` 协议时无需重装依赖;重启 dsh web。版本间变化看 [CHANGELOG.md](CHANGELOG.md)。0.8.0 起浏览器本地仅存项目选择偏好;旧版本的整板快照键会在升级后首次打开面板时自动清理,无需处理。

**卸载**:删除 profile `package.json` 中 `dependencies` 的 `@local/thorn-github-kanban` 行与 `dsh.profile.bundles` 里的同名行 → `pnpm install` → 重启 dsh web。可选:按「排障」一节清理浏览器 `localStorage` 中本插件的本地键。

## 开发与测试

- **零依赖、无构建**:宿主半边是 ESM;浏览器半边被 dsh 按文件字节直接当 `<script>` 提供(不打包、不转译),因此浏览器代码的适配层与组件必须同处 `lib/client.js` 一个文件——这是平台约束,不是风格选择。
- **静态自检**(零依赖,只用 node 内置模块,只需 Node ≥ 18):

  ```sh
  node scripts/smoke-load.mjs
  ```

  覆盖:包声明 → 注册零副作用 → 座位/文案/远程面契约 → token 红线 → GraphQL 查询纯度 → 字段映射 → 面板数据流(mini-React 替身)。它**不能**替代真机:React 与 dsh 服务都是替身。真机验证 = 装进 profile 重启 dsh web。

- **标准测试命令**(`node:test` 体系;**开发/测试需 Node ≥ 20.19**——jsdom 29 的运行约束,插件运行时仍只需 Node ≥ 18):

  ```sh
  npm ci               # 按 package-lock.json 安装测试依赖(react/react-dom/jsdom,仅 devDependencies,不进分发包)
  npm test             # lint(语法)+ smoke(204)+ unit/契约(74)+ 真实 React 组件(17)+ 分发内容检查
  npm run test:strict  # 严格模式全量(任何未处理的 Promise 拒绝都会使测试失败)
  ```

  组件生命周期用例运行在**真实 React 18.3.1 + jsdom** 上(与 dsh 宿主前端注入的 React 同版本),覆盖首载失败恢复、重试上限、快速切换、卸载清理、偏好隐私、StrictMode 双挂载等;smoke 的 mini-React 替身套件保留为零依赖快速回归网。CI(`.github/workflows/ci.yml`,Node 20/22/24 矩阵,零 token)运行同一组命令。

- **干净 checkout 安装验证**(不需要作者机器上的任何隐含文件):

  1. `git clone` 本仓库到全新目录,`cd` 进入;
  2. `node scripts/smoke-load.mjs` 全绿(证明源码、配置与声明自洽,只需 Node ≥ 18,无需安装依赖);
  3. 按「安装」一节把该目录链接进你的 dsh web profile;
  4. 重启 dsh web:左栏出现「GitHub 看板」入口即装载成功;配置 `GITHUB_TOKEN` 后应能拉到你的项目列表;
  5. 不设 token 也应看到配置引导视图(而非报错堆栈)——这是链路健康的另一个信号。

- **代码结构**:`lib/index.js`(宿主:GraphQL、映射、缓存、Remote 面)/ `lib/client.js`(浏览器:UI、轮询、dsh 适配层)/ `cordis.patch.yml`(挂载与 config)/ `scripts/smoke-load.mjs`(自检)。开发记录与 dsh API 差异见 `notes/dev-notes.md`。
- 分发内容 = `package.json` 的 `files` 字段(`lib/` 两文件、`cordis.patch.yml`、本 README)。`notes/`、`scripts/` 不进分发包。若未来引入构建流程(目前刻意没有),需补「干净 checkout 重建分发物」的验证。

## 路线图

详见 [TODO.md](TODO.md)。概要:Alpha 收尾(可靠性与安装验收)→ 双向写回(移列/建卡/排序/冲突处理)→ Agent 工具化(人与模型共用同一服务)→ webhook、多视图等增强。双向写回开始前,只读链路的可靠性与验收要先闭环。

## 许可证

**待定(发布阻塞项)**:本项目尚未选定许可证,由所有者决定后添加 `LICENSE`。在此之前,默认无任何使用/再分发授权。候选(供所有者参考):MIT(宽松、生态默认)或 Apache-2.0(宽松 + 明确专利授权);对比细节见仓库内 `notes/remediation/phase4.md`。

## 反馈与安全

- 一般问题:通过仓库 issue 反馈(地址见 `package.json` 的 `bugs` 字段;公开仓库建立前为占位)。提问模板与开发贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题(尤其涉及 token):**不要**在 issue、评论或截图中粘贴任何 token、环境变量导出命令或含凭据的日志——走私密渠道,见 [SECURITY.md](SECURITY.md)。
