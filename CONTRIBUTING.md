# 贡献指南

安装与配置见 [README](README.md)，维护契约见 [开发笔记](notes/dev-notes.md)。

## 范围与约束

- 当前为只读 Alpha。写回、拖拽及 Agent 工具需先确定需求和权限设计。
- 不新增运行时依赖。浏览器 `lib/client.js` 由 dsh 直接加载，不能使用相对模块导入或未经处理的 TS/JSX；保留单文件交付。
- dsh 适配逻辑集中在宿主与浏览器各自的适配层；官方包只作只读参考。
- 不提交 token、含凭据的日志、个人环境绝对路径或无关产物。

## 测试

开发/测试需 Node ≥20.19；插件运行时下限仍为 Node 18。

```sh
npm ci
npm test
npm run test:strict
```

`npm test` 是提交前的完整检查。`node scripts/smoke-load.mjs` 是无需依赖的快速冒烟，不能代替完整测试。

改行为需带测试；修 bug 先写能复现失败的用例。纯函数、服务和缓存用例位于 `test/*.test.mjs`，组件生命周期用例位于 `test/react/`。真实 dsh 或 GitHub 链路改动还需记录真机版本、场景与结果；未验证时明确标注。

## 提交与文档

小步提交，说明问题、改动和验证结果。用户可见行为同步 README 与 CHANGELOG，未完成工作只记在 TODO。历史报告只保留结论、证据入口与未解决项，不复制代码或整段测试输出。

反馈问题时附 dsh/Node 版本、错误码与脱敏复现步骤。安全问题按 [SECURITY](SECURITY.md) 私下报告。
