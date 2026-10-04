# 第三轮：错误优先级

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- 问题：列表刷新失败后，轮询或项目切换的看板响应可清除/顶替链级错误，误报恢复。
- 修复：`BOARD_START`、`BOARD_OK`、`FAILED` 按 error.stage 门控；看板数据可更新，但不能清除 status/list/bootstrap 错误。看板级错误仍可由轮询恢复。
- 回归：`test/react/board-lifecycle.test.mjs` 的 R3 用例和 smoke，覆盖看板开始、成功、失败及整链恢复。原记录确认新增场景先红后绿。

未修：链级错误期间仍轮询不可展示的数据、在途禁用刷新，以及 loading 期与整链看板请求的窄窗并发。维护候选统一见 TODO。

完整原始记录：`git show a8b459f:notes/remediation/round3-client.md`。
