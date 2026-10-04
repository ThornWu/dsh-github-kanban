# 阶段 2：结构整理

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- 宿主复用查询字段与 `pageAll`；浏览器分为适配、数据 API、状态机/控制器和视图。
- `boardTransition` 管业务转换，`viewBoardState` 推导显示；响应校验将畸形结果转为 `shape_error`。
- 加入数据截断提示、兜底文案国际化和版本一致性检查。
- 保留单文件交付，未引入通用框架或运行时依赖。

回归入口：`test/pure.test.mjs`、`test/contract.test.mjs`、smoke。wire 参数数量缺口随后由二轮修复；新增查询字段和真实装载行为仍需真机核验。

完整原始记录：`git show a8b459f:notes/remediation/phase2.md`。
