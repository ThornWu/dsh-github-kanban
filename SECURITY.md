# 安全策略

仅维护最新 Alpha 版本。本策略覆盖插件及其与 dsh 的交互；平台本身的问题请向上游报告。

## 数据边界

- `GITHUB_TOKEN` 仅从宿主环境读取，用于 GitHub 请求头：读查询与状态写回 mutation（目前仅 `updateProjectV2ItemFieldValue`）；不返回浏览器，不写入配置、日志或提交。宿主错误文案对实际请求使用的 token 脱敏。
- 看板数据可能来自私有项目。宿主缓存只在进程内存中，按 token 指纹隔离，重启清空；不保存原始 token 为缓存键或缓存值。
- 浏览器会接收并显示项目与卡片，但 localStorage 只保存 UI 偏好 `@local/thorn-github-kanban/prefs/v1`（`savedAt`、`selectedKey`、`theme`，30 天有效）。选择键可能包含仓库名。
- 0.5–0.7 曾持久化整板快照；0.8.0 起移除，并在首次打开面板时清理旧键 `@local/thorn-github-kanban/snapshot/v1`。

## 报告漏洞

私下联系仓库维护者；专用安全邮箱尚未配置。不要为漏洞开公开 issue，也不要粘贴真实凭据。报告应包含影响、使用测试数据的复现步骤和可选修复建议。

若凭据已泄漏，先在 GitHub 吊销，再清理包含凭据的材料。删除原文不能撤回通知或其他副本。
