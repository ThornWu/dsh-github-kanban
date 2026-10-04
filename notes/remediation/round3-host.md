# 第三轮：凭据快照

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- 问题：入口捕获指纹后，produce 微任务才读 token；窗口内轮换会让数据身份与缓存标签不一致。
- 修复：`credentialSnapshot()` 同刻取得 token 与指纹，贯穿 impl → pageAll → ghGraphQL；请求头和错误脱敏使用同一凭据。
- 参数语义：undefined 表示未提供快照，null 表示快照时缺 token，不再读取更新后的环境。

回归：`test/cache.test.mjs` 的 R3host 三项，用微任务窗口轮换验证 getBoard/listProjects 及缺 token 路径。原记录为修复前 3 项失败，修复后全部通过。

不改变 status/启动日志的即时布尔口径；缓存共享引用和去重加入者结果的取舍保持不变。

完整原始记录：`git show a8b459f:notes/remediation/round3-host.md`。
