# 0.8.0 整改计划（历史索引）

2026-10-03 的整改已随提交 `a8b459f` 合入。当前待办统一维护在 [TODO](TODO.md)，结果与证据见 [整改摘要](notes/remediation-report.md)。

| 阶段 | 范围 | 记录 |
| --- | --- | --- |
| S0 | 基线与范围核对 | 整改摘要 |
| S1 | 隐私、超时、局部失败、恢复、缓存 | [阶段 1](notes/remediation/phase1.md) |
| S2 | 分页、控制器、状态与契约 | [阶段 2](notes/remediation/phase2.md) |
| S3 | 行为测试与 CI | [阶段 3](notes/remediation/phase3.md) |
| S4 | 文档、许可证与分发 | [阶段 4](notes/remediation/phase4.md) |
| S5 | 真机验收与发布准备 | TODO 的 Alpha 验收与发布准备 |

验收分别报告源码、自动化、真实环境和发布状态。测试通过不等于真机通过，候选包核验不等于已发布。

原 45 项任务、验收矩阵和执行过程：`git show a8b459f:REMEDIATION_PLAN.md`。其中工作区、许可证及阶段性测试数量属于当时快照，不再作为当前状态。
