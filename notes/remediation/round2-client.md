# 第二轮：客户端契约与时序

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- `listProjects` / `getBoard` 缺参数时补 `{}`，满足真实网关精确实参数量要求；strictArgumentFace 替身同步约束。
- 增加链 epoch：整链刷新、卸载和重挂载后忽略旧链结果；loadSeq 继续保护同链项目切换。
- 空项目列表也展示来源失败/截断警告。

回归：`test/contract.test.mjs`、`test/react/board-lifecycle.test.mjs` 的 R2 用例及 smoke。原记录确认新增复现用例修复前失败、修复后通过。

遗留候选（见 TODO）：dispatch 卸载守卫顺序、RPC 参数统一入口、轮询在途禁用刷新。真网关参数接受性和真实 keyed 卸载仍需验收。

完整原始记录：`git show a8b459f:notes/remediation/round2-client.md`。
