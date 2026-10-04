# 开发笔记

以下是本仓库当前实现采用的契约。依据为 2026-09-29 至 10-03 对 dsh 0.2.0-rc.1/rc.2 的源码核验和历史联调；不代表对其他版本的保证。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主适配、GraphQL/分页、数据映射、Remote 服务与缓存 |
| `lib/client.js` | 客户端适配、词典、数据 API、状态机/控制器、视图 |
| `cordis.patch.yml` | 插件挂载和宿主配置 |
| `test/`、`scripts/smoke-load.mjs` | 行为测试、装载契约和快速冒烟 |

## dsh 契约

历史“差异”编号保留供源码注释定位；完整原文可用 `git show a8b459f:notes/dev-notes.md` 查看。

- **座位（差异 1–2、6–7）**：当前入口为 `sidebar.panellist`（list：`id`/`order`），内容为 `main`（keyed：`key`）。右栏 tab 已于 0.3.1 移除，不再作为升级检查目标。
- **两套 inject（差异 4）**：package.json 的 `dsh.client.inject` 是包名；浏览器导出的 `inject` 是服务名。
- **单文件交付（差异 5）**：加载器直接提供 client 文件，不做打包/转译；`require` 只解析平台 seed 或已注册包名，不解析相对文件。工厂注册阶段不注入样式。
- **宿主服务（差异 8）**：通过 `ctx.provide` 注册，样式/文案等副作用按 dsh 生命周期管理。
- **Remote（差异 3、9）**：宿主采用 `typertRemote` 绑定和原型方法标记，网关走 SRC 回退；浏览器 `$mount` 手写 strict 清单。当前没有引入 TS 生成器或 zod 运行时依赖。
- **参数与信封（差异 9、11，二轮补充）**：SRC 方法使用简单标识符参数；`status()` 为零参数，`listProjects(request)` / `getBoard(request)` 恒传一个参数，缺省补 `{}`。网关 direct 返回 `{ok, value}` 信封，需先拆包。
- **激活顺序（差异 11）**：入口 inject 不得等待自装的 `remote.githubKanban`，否则 apply 无法运行。挂载后通过 scoped `ctx.inject` 捕获该服务。
- **轮询（差异 10）**：由浏览器控制器驱动，使用客户端 timer 服务；宿主不知道当前选择。页面后台暂停，面板卸载清理定时器。
- **项目路由（差异 12）**：viewer 与仓库关联项目按 id 合并，优先保留仓库来源；同项目关联多个配置仓库时保留配置靠后的来源。仓库关联不代表仓库拥有该项目。查询 `closed` 后本地过滤，不传 `includeArchived`。

## 数据与时序约束

- 凭据和指纹在请求入口同时捕获，分页、请求头和脱敏沿用该快照。在途键含身份，旧响应不得覆盖新缓存。
- 客户端 `epoch` 隔离整链刷新与卸载；`loadSeq` 隔离同链内的项目切换。
- 看板请求只清自己的错误，不能清除 status/list/bootstrap 失败。
- 浏览器只持久化选择偏好，旧整板快照已移除。安全边界见 [SECURITY](../SECURITY.md)。

## 升级核对清单

在实际安装的 dsh 下查找 `node_modules/@deepseek-ai/`，对照这些包的当前源码：

1. `dsh-client-modules`：模块元数据、script 提供、seed 与 require 解析。
2. `dsh-client-ui-sidebar` / `dsh-client-ui-layout`：panellist、main 的注册与卸载。
3. `dsh-typert-protocol` / `dsh-typert-registry`：Remote 标记、绑定与清单结构。
4. `dsh-api-gateway`：SRC 参数解析、实参数量校验、strict codec 要求、direct 信封与 namespace 激活。
5. `cordis` / 客户端 timer：provide、effect、scoped inject、timeout/interval 的返回和清理方式。
6. 更新契约测试中的严格替身，再执行 `npm test` 与 `npm run test:strict`；按 [TODO](../TODO.md) 补真实宿主验收。

## 历史验证边界

2026-10-01 的 rc.2 联调修复了激活死锁、环境回退、信封拆包和无效查询参数，并读到项目列表；当时项目无卡，不能证明卡片与 GitHub 一致。旧性能数字及右栏探索过程保留在 Git 历史中，不作为当前验收结论。
