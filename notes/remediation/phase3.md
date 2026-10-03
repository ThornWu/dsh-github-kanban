# 阶段 3：测试与 CI

2026-10-03 历史摘要。最终结果见 [整改摘要](../remediation-report.md)，未完成项见 [TODO](../../TODO.md)。

- 使用内置 `node:test`；React/react-dom 18.3.1 与 jsdom 仅为开发依赖。
- 历史核验依据：dsh-web-frontend 下发的 vendor bundle 使用 React 18.3.1；组件、渲染器与测试共用实例。升级 dsh 时重新核对。
- React 套件经真实 `apply(ctx)` 到组件，替身只模拟 dsh/GitHub 边界；覆盖 effect cleanup、卸载、StrictMode 和竞态。
- 虚拟时钟只替换插件可见定时器，不替换 React 调度；mini-React smoke 保留为快速冒烟。
- CI 配置覆盖 Node 20/22/24、strict 模式及打包白名单；远端状态需按提交查询。

复跑：`npm test`、`npm run test:strict`。自动化不能证明真实网关、scoped fiber、timer、座位派发、PAT 权限或 GitHub 数据一致性。

完整原始记录：`git show a8b459f:notes/remediation/phase3.md`。
