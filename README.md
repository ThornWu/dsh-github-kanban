# dsh-github-kanban

dsh Web UI 的 GitHub Projects v2 看板。在左栏 **Global panels → GitHub 看板** 打开，支持项目切换、按 Status 分列、标题/负责人/标签展示及 30 秒轮询。

当前版本 **0.9.0 Alpha**，MIT 许可。零运行时依赖，无构建步骤。已支持拖拽卡片到其他列写回更新 Status（读 + 状态写回，Alpha）；列内排序、建卡删卡、其他字段编辑、触屏拖拽、Agent 工具及多视图尚未实现。

## 安装

运行时要求 Node ≥18；历史验证环境为 Node 24、dsh 0.2.0-rc.1/rc.2。其他版本未验证，完整真机验收仍见 [待办](TODO.md)。

1. 将仓库放在本地 `<repo>`。
2. 在 dsh web profile 的 `package.json`（通常为 `~/.dsh/profiles/web/package.json`）中合并以下配置，保留原有依赖和 bundles：

   ```jsonc
   {
     "dependencies": {
       "@local/thorn-github-kanban": "link:<repo>"
     },
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

3. 在 profile 目录安装依赖（pnpm profile 执行 `pnpm install`），完全退出并重启 `dsh web`。
4. 打开看板。未配置 token 时应显示配置引导。

## 配置

在启动 dsh 的环境中设置 `GITHUB_TOKEN`，然后重启 dsh web。使用能读取目标 Projects、Issues 和 Pull requests 的 token；fine-grained PAT 按目标资源授予只读权限。token 不放进插件配置、日志或浏览器，详见 [安全策略](SECURITY.md)。

拖拽写回 Status 还需要**项目写权限**：

- classic PAT 需勾选 `project` scope（对 user 和 organization 项目授予读写）；仓库关联项目还可能需要 `repo` scope。
- fine-grained PAT 对项目（尤其 user 级项目）的写支持以 GitHub 当前实际行为为准；GitHub 文档目前注明 user 名下的 Projects 仅 classic token 可访问。若拖拽报 `forbidden`，先用 GitHub 网页确认该 token 能改同一张卡的 Status，再检查 scope 设置。

默认读取 viewer 名下的项目。要加入关联到仓库的项目，修改 `cordis.patch.yml` 的宿主 insert 配置：

```yaml
- insert:
    - id: thorn-github-kanban
      name: '@local/thorn-github-kanban'
      config:
        repos:
          - octocat/hello-world
        cache:
          projectsTtlMs: 60000
          boardTtlMs: 15000
          maxBoards: 8
        requestTimeoutMs: 15000
```

只有 `repos` 按需填写，其余为默认值。仓库名格式为 `owner/name`，格式错误的项会被跳过；改动后重启 dsh。超时分别作用于每次 GitHub 请求的建连和响应体读取，并非整次看板加载的总期限。

## 行为与限制

- 项目来源为 viewer 与配置仓库关联的项目，不会遍历组织全部项目。按项目 id 去重并优先保留仓库来源，过滤 closed 项目。
- 列顺序取名为 `Status` 的单选字段；缺失时显示「全部」并提示原因。
- 看板卡片可拖拽到其他列：先乐观更新，再写回更新该卡 Status；写回失败自动回滚到原列并显示内联错误。「全部」列（项目无 Status 字段）不可拖。
- 写操作仅限移动卡片更新 Status：不支持列内排序、新建/删除卡片、编辑其他字段，也不支持触屏拖拽（HTML5 拖放的浏览器限制）。
- 面板主题**跟随 dsh 宿主深浅色并实时联动**（dsh 设置里切换 Light/Dark，面板即时跟随），无手动切换按钮；非 dsh 环境退回通用检测（宿主线索 → 背景 → `prefers-color-scheme`）。
- 页面后台暂停轮询；请求在途时不叠发轮询。「刷新」重拉项目列表和看板并绕过 TTL，在看板请求期间暂时禁用。
- 单来源失败显示警告，保留其他来源；全部来源失败显示错误。瞬态失败会重试，达到上限后可手动刷新。
- 浏览器只持久化 UI 偏好：项目选择（`prefs/v1`，30 天有效；主题恒跟随 dsh 不落盘）；不持久化项目列表或卡片。宿主缓存留在进程内存中。

| 数据 | 读取上限 |
| --- | --- |
| 每个来源的项目列表 | 300 个 |
| 单个看板条目 | 200 张 |
| 项目字段定义 | 40 个 |
| 每卡字段值 / 标签 / 负责人 | 30 / 20 / 10 个 |

看板条目、字段值和项目来源截断有相应提示；不要据此认为所有嵌套字段均完整。

## 排障

| 现象 | 处理 |
| --- | --- |
| token 引导 / `token_missing` | 检查启动 dsh 的环境变量并重启 |
| `http_error` / `graphql_error` | 检查错误文案、token 有效期及目标资源权限 |
| 卡片无标题或内容不可读 | 检查 Issues / Pull requests 读权限 |
| `project_not_found` | 刷新列表，检查项目是否存在及是否仍有权限 |
| 单仓项目缺席 | 检查仓库格式、关联关系和权限，查看来源警告 |
| 拖拽写回 `forbidden` | token 无项目写权限，非瞬态；检查 PAT scope（见[配置](#配置)），先用 GitHub 网页确认能否改同一张卡的 Status |
| 写回 `not_supported` | 项目无 Status 字段，看板为「全部」列，不提供拖拽写回 |
| 写回 `option_missing` / `item_missing` | Status 选项或卡片已在 GitHub 上不存在；刷新看板后重试 |
| 写回 `write_failed` | GitHub 拒绝了写入，按错误消息处理 |
| 写回 `bad_request` | 请求被 GitHub 拒绝；刷新看板重试，持续出现再上报 |
| 拖拽写回 `timeout` | 瞬态失败，卡片已回滚；重试拖拽或手动刷新 |
| `timeout` / `remote_timeout` / `Failed to fetch` | 检查网络及 dsh 状态；等待自动重试或手动刷新 |
| 数据不完整 | 查看加载数量和截断提示，对照上表 |
| 升级 dsh 后打不开 | 查看控制台契约错误，按 [升级核对清单](notes/dev-notes.md#升级核对清单) 检查适配层 |

自动恢复包括启动链内最多 5 次尝试，以及错误态最多 15 轮重试（每轮间隔 4 秒，另加请求和退避耗时）。看板轮询成功不会清除项目列表加载失败；这类错误需整链刷新恢复。

## 升级与卸载

升级本地仓库后重启 dsh web。0.5–0.7 的旧快照键 `@local/thorn-github-kanban/snapshot/v1` 会在首次打开面板时清除；版本变化见 [CHANGELOG](CHANGELOG.md)。

卸载时删除 profile 中本插件的 dependency 与 bundle，重新安装 profile 依赖并重启。可选清理 localStorage 中的 `@local/thorn-github-kanban/prefs/v1` 和旧快照键。

## 开发

开发/测试使用 Node ≥20.19，已在 Node 24 验证：

```sh
npm ci
npm test
npm run test:strict
```

未安装测试依赖时可运行 `node scripts/smoke-load.mjs` 做快速冒烟。完整测试包含语法、服务/缓存/契约、真实 React + jsdom 生命周期和打包检查；dsh 与 GitHub 链路使用替身，不代替真机验收。

- [贡献指南](CONTRIBUTING.md)：代码约束、测试与提交要求。
- [开发笔记](notes/dev-notes.md)：源码结构、dsh 兼容契约。
- [TODO](TODO.md)：未完成的验收与后续功能。
- [整改摘要](notes/remediation-report.md)：历史修复和证据边界。

一般问题通过所在仓库的 issue 反馈；包内 `homepage` / `bugs` 仍为占位地址。安全问题请私下联系维护者，勿公开凭据。许可证见 [MIT](LICENSE)。
