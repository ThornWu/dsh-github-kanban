# 0.8.0 整改摘要

日期：2026-10-03。三轮修复已随 `a8b459f`（PR #3）合入，MIT 已确定。当前源码版本为 0.8.0；完整真机验收和外部分发没有在本次文档整理中核实。待办只维护在 [TODO](../TODO.md)。

## 修复与回归入口

| 范围 | 最终行为 | 测试入口 |
| --- | --- | --- |
| R01 本地快照 | 移除整板持久化，只留选择偏好并清理旧键 | `test/react/prefs-retry.test.mjs` |
| R02 请求悬挂 | 宿主双阶段超时/abort，客户端等待有期限 | `test/service.test.mjs`、`test/contract.test.mjs` |
| R03 来源失败 | 局部失败保留可用项目，全失败明确报错；缓存/空态保留警告 | service、cache、React 套件 |
| R04/R05 恢复 | 重试有上限，手动刷新重置预算并重拉整链 | React prefs-retry、board-lifecycle 套件 |
| R06 生命周期 | 用真实 React + jsdom 验证 cleanup、卸载和 StrictMode | `test/react/` |
| 二轮 RPC/时序 | 请求参数数量匹配清单；刷新和重挂载拒绝旧链响应 | contract、React board-lifecycle 套件 |
| 二/三轮缓存 | 在途按身份去重，仅请求发起者回填；凭据和指纹同刻捕获 | `test/cache.test.mjs` 的 R2host/R3host 用例 |
| 三轮错误优先级 | 看板开始、成功、失败都不掩盖链级错误 | React board-lifecycle、smoke 的 R3 用例 |

## 证据边界

- 三轮最终历史记录：本地 smoke 227、unit 84、React 24、pack 1，共 336 项通过；strict 模式通过。这是当时数量，不作为后续版本固定门槛。
- 原第三轮报告记载审查方观察到远端 CI 8 jobs 通过；本次没有重新查询远端，不能据此宣称当前 HEAD 的 CI 状态。
- 早期 rc.2 联调读到项目列表；整改轮未重新完成真实 dsh/GitHub 验收。有卡项目一致性、刷新窗口和故障恢复仍待验证。
- 分发白名单为 LICENSE、README、package.json、cordis.patch.yml 和两份 lib 文件；是否安装到真实 profile、是否对外发布分别核验。

复跑自动化：`npm ci` → `npm test` → `npm run test:strict`。测试不需要真实 token；dsh transport 和 GitHub 都是替身。

## 保留的取舍

- 浏览器单文件交付；宿主暂不拆文件，内部按适配、查询、映射、缓存分层。
- 去重加入者可能收到早于强刷缓存的结果；命中返回共享对象，当前调用方只读。
- 链级错误期仍有看板轮询，且在途会暂时禁用刷新；优化候选已移入 TODO。
- 当前缓存按 Map 首次插入顺序淘汰，与源码“最近写入”注释不一致；修复及测试仍待处理。

## 历史记录

[阶段 1](remediation/phase1.md) · [阶段 2](remediation/phase2.md) · [阶段 3](remediation/phase3.md) · [阶段 4](remediation/phase4.md)

[二轮宿主](remediation/round2-host.md) · [二轮客户端](remediation/round2-client.md) · [二轮文档](remediation/round2-docs.md) · [三轮宿主](remediation/round3-host.md) · [三轮客户端](remediation/round3-client.md)

各文件保留修复摘要和证据入口。完整原报告：`git show a8b459f:notes/remediation-report.md`；逐轮原文同样可从该提交按路径读取。
