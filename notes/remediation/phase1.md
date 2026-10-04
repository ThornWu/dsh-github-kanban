# 阶段 1：可靠性

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- R01：移除浏览器整板快照，保留带过期时间的选择偏好。
- R02：宿主请求与响应体分别限时并 abort；客户端挂载/取面/调用加 deadline。
- R03：按来源收集项目，局部失败保留成功结果，全部失败明确报错。
- R04/R05：重试预算在完整成功后归零；首载失败和空列表保留恢复入口。
- S1.9：加入缓存容量、身份隔离和单调回填，后续二/三轮进一步修复竞态。

回归入口：`test/service.test.mjs`、`test/cache.test.mjs`、`test/react/prefs-retry.test.mjs`。真实 timer、网络取消与卸载行为待真机验证。

完整原始记录：`git show a8b459f:notes/remediation/phase1.md`。
