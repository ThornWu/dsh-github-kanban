# 贡献指南

感谢你愿意为 dsh-github-kanban 出力。开始前请先读 [README.md](README.md) 了解能力边界与「开发与测试」一节。

## 项目状态与边界

- **只读 Alpha**:本阶段只做「读 GitHub Projects v2」。涉及写回(mutation)、拖拽、Agent 工具的改动请先在 issue 里对齐设计,不要直接提实现。
- **零依赖、无构建**:不引入任何 npm 运行时依赖;浏览器半边(`lib/client.js`)被 dsh 按文件字节直接当 `<script>` 提供,不能打包、不能转译、不能拆文件,`require` 只能命中平台 seed 词或已装载包名——这是平台约束。
- dsh 处于 rc 阶段,插件 API 可能 breaking;适配层(宿主与浏览器各一节)集中管理,升级核对清单在 `notes/dev-notes.md`。

## 本地开发

```sh
git clone <repo>
cd dsh-github-kanban
npm ci                      # 安装测试依赖(react/react-dom/jsdom,仅 devDependencies,不进分发包)
npm test                    # 全量检查:lint + smoke + 单元/契约 + 真实 React 套件 + pack 检查
```

- 环境:插件**运行时**零依赖、Node ≥ 18;**开发/测试**需 Node ≥ 20.19(jsdom 29 的运行约束,开发验证于 Node 24),且测试体系有 3 个 devDependencies,开发前须 `npm ci`(与运行时零依赖不冲突,见 README「开发与测试」)。
- 快速冒烟(未装依赖也能跑,Node ≥ 18 即可):`node scripts/smoke-load.mjs`,约 2 秒,适合改动后的即时反馈。
- 真机联调:按 README「安装」把仓库 `link:` 进你的 dsh web profile,重启 dsh web;`dsh.profile.patchReload: "live"` 的 profile 支持部分热重载,不确定就重启。

## 测试要求

- **`npm test` 是贡献前置门槛**,提交 PR 前应全绿。全量体系 = 语法检查(lint)+ smoke(`scripts/smoke-load.mjs`)+ node:test 单元与契约(`test/*.test.mjs`:纯函数 / 服务 / 缓存 / 契约 / 语法)+ 真实 React 18.3.1 生命周期套件(`test/react/`,jsdom)+ 分发内容检查(pack:check)。
- **改了行为就必须带测试;修 bug 先写红用例再修绿**。按改动面选套件:纯函数 / 服务 / 缓存 → `test/pure.test.mjs` / `test/service.test.mjs` / `test/cache.test.mjs`;组件生命周期 → `test/react/`(真实 React,不是替身);装载契约(wire / 座位 / 文案)→ `test/contract.test.mjs` + smoke。
- smoke 只是**快速回归网之一,不是唯一自动化入口**:它零依赖、用替身 React,验证不了真实 React 行为(归 `test/react/`),真实 dsh 服务与真实 GitHub 链路则整个自动化体系都是替身。涉及后两者的改动,请在 PR 里附真机验证说明(场景 + 观察结果;**脱敏**,见下)。
- 文档同步:改了用户可见行为,同步更新 README(排障/能力表)与 CHANGELOG。

## 提交与 PR

- 小步提交,提交信息写动机(为什么改),不只是改了什么。
- 当前仓库尚无公开远端(见 `package.json` 的 `bugs` 占位)。公开后:fork → 分支 → PR,PR 描述里给出自检输出摘要与真机验证记录。
- 禁止提交:任何 token/凭据、`.env`/`.credentials` 类文件(已在 `.gitignore`)、含个人环境绝对路径的文档改动(用通用写法定位参考实现,见 `notes/dev-notes.md` 的核对清单)。

## 问题反馈

提 issue 前:

1. 读 README「排障」,确认不是已知现象。
2. 附上:面板错误文案(形如 `[错误码] 说明`)、dsh 版本、Node 版本、`cordis.patch.yml` 的 config 段(**先删除你自己的仓库名**,如介意暴露)。
3. **绝不在 issue/评论/截图里出现**:token、`GITHUB_TOKEN=…` 导出命令、环境变量转储、含凭据的日志。安全漏洞走 [SECURITY.md](SECURITY.md) 的私密渠道,不要开公开 issue。
