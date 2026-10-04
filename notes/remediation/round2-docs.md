# 第二轮：文档纠偏

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- CONTRIBUTING 改为要求完整 `npm test`；smoke 仅是无需依赖的快速冒烟。
- SECURITY 按 0.8.0 更新：浏览器仅持久化选择偏好，宿主业务缓存仅在内存并按身份隔离。

后续文档整理进一步明确：私有项目数据不是公开元数据；浏览器仍会接收看板数据，“不持久化”不等于“不离开宿主”。安全报告渠道仍待配置。

完整原始记录：`git show a8b459f:notes/remediation/round2-docs.md`。
