# 0.9.0 客户端看板改造记录（主题 / GitHub 风格 / 拖拽写回）

日期：2026-10-03。分支 fe/thornwu-kanban-board-ui。范围：CLIENT 线程独占文件 —— lib/client.js、scripts/smoke-load.mjs、test/pure.test.mjs、test/contract.test.mjs、test/react/、test/helpers/、本文。宿主半边（lib/index.js 的 moveCard 写回、载荷扩展 projectNodeId/statusFieldId/列 color/labels[].color/assigneeDetails）由并行 HOST 线程交付，本文只记录客户端侧的对接与取舍。

## 逐文件改动

1. **lib/client.js**
   - **主题系统**：PANEL_CSS 全量重构为 `--tgk-*` 变量 + `.tgk-root[data-tgk-theme="light|dark"]` 两套值（approximate Primer：light canvas #f6f8fa / card #ffffff / border #d1d9e0 / text #1f2328 / muted #59636e；dark #0d1117 / #151b23 / #3d444d / #e6edf3 / #9198a1）。data 属性挂在面板根节点上，不与宿主主题系统互写。状态机新增 `theme` 字段与 `THEME_SET` 事件（非法值原引用返回）；工具栏新增 `ThemeToggle` 按钮（半明半暗 svg + aria-label 指向切换目标），交互走 `controller.setTheme` → dispatch → `syncPrefs` 落盘。
   - **GitHub 风格看板**：列固定 340px、横向滚动、列间 10px；列体 `--tgk-column` 与画布差异化 + 圆角；列头 = 8px 色点（`column.color` 枚举名 → `statusColorHex` 两套 hex，未知/缺席灰）+ 名称 14px semibold + 计数徽标（muted）；卡片 = 卡底/1px 边框/6px 圆角/12px 内边距，hover 边框加深 + 轻阴影，标题 14px；标签渲染 GitHub 式小 pill（`labelPillStyle`：label hex 半透明底，浅色前景 0.62x 压暗、暗色 1.15x 提亮）；负责人 = 右上 20px 圆形头像（`assigneeDetails[].avatarUrl` 在场 → img loading lazy/alt=login/title=login；否则首字母圆点退化）。phaseBadge「只读」→「alpha」，panelLede 改写回说明（zh/en 同步，保留"数据来自"来源句）。
   - **拖拽写回**：HTML5 原生 DnD（无拖拽库）。卡片 `draggable` + cursor:grab；dragstart 把 `{itemId, fromOptionId}` 记进 Body 的 dragRef（dataTransfer.setData 仅作礼仪性载荷，jsdom/隐私模式缺席不影响逻辑）；列做 drop 目标（dragover preventDefault + `tgk-columnDrop` 高亮，drop/dragLeave 清除）；drop 时目标列 ≠ 源列 → `controller.requestMove`。详见下文设计节。
   - **prefs 扩展**：`{savedAt, selectedKey?, theme?}`。30 天到期、防御性读写、失配不落盘（selectedKey 只认真实存在的项目）全部沿用；theme 是纯 UI 偏好（不描述任何 GitHub 数据，换身份读它不泄漏信息），**不违反 S1.1**——S1.1 清的是整板快照（他人可见业务数据），键与主题都是选择偏好，注释已写明。空项目列表下切换主题也落盘（selectedKey 缺席即省略）。readPrefs 放宽为 savedAt 有效性判定（selectedKey 允许缺席，由调用方把关）。
   - **coerceBoard 放宽**：载荷扩展按「字段缺席允许、在场须形状正确」校验 —— board.projectNodeId/statusFieldId、列 optionId/color：缺席或 null 放行、在场须字符串；item.assignees（兼容 string 与 {login?, avatarUrl?}）、item.assigneeDetails（{login?, avatarUrl?}，avatarUrl 可 null）、item.labels（{name?, color?}）在场须数组且条目形状正确，写歪 → shape_error（可观测失败，不静默纠正）。
   - **remoteContribution**：新增第 4 个 direct 方法 `moveCard`（1 个 request 形参，与 listProjects/getBoard 同一参数数量契约）；`createBoardApi.moveCard(request)` 恒恰好 1 实参。
2. **scripts/smoke-load.mjs**：远程清单 3→4 方法检查；参数数量闸自证扩 moveCard（0 参必抛/1 参放行/boardApi.moveCard 过闸）；宿主标记补 moveCard 在册检查 + 四方法签名检查；5c 负责人断言改头像节点（img alt/login lazy + string 退化为首字母圆点）；5c1c 偏好键补 theme；5i 恢复入口按 tgk-reload 类名计数（主题按钮不计入）；新增 5u 节（alpha 徽章与写回说明句、主题切换翻转+落盘、空列表下主题落盘、0.9.0 internals 纯函数、coerce 透传）。
3. **test/pure.test.mjs**（24→40）：normalizeTheme/resolveInitialTheme/detectDefaultTheme/hostThemeHint/computedBackgroundLuminance/statusColorHex/labelPillStyle 矩阵；moveCardInBoard 纯函数（乐观移动/不改写入参/守卫原引用）；boardTransition 新事件（MOVE_START 建 pending+快照、MOVE_OK 保乐观、MOVE_FAILED 回滚+moveError、权威事件收口 pending、THEME_SET）；dragDisabledReason；coerce 透传与畸形矩阵；控制器 pending 守卫（手动 tick：在途跳过、settle 后恢复）。
4. **test/contract.test.mjs**（15→19）：清单 4 方法；宿主标记 4 方法；moveCard 严格面（恰好 1 实参 + 业务/载波失败信封透传 + 0 实参必抛）；控制器驱动的请求形状逐字段断言（repo 随仓归属透传）；moveCard 悬挂 → remote_timeout + 回滚 + 迟到回包忽略。
5. **test/react/**（24→34）+ **test/helpers/react-panel.mjs**（新增 domStubs 钩子，主题检测桩在渲染前生效）：DnD 成功路径（jsdom Event + Object.defineProperty 打桩 dataTransfer；dragover 高亮、drop 乐观上板、请求形状）、forbidden/timeout 回滚与指引、pending 期间平静窗口 + 快速双拖忽略、reload 作废 pending（迟到 moveCard 结果不回滚权威看板）、不可拖卡片（fallback/无 Status 字段 title 提示 + 同列 drop 不写回）、列头色点 hex；主题切换/持久化/非法存储值忽略/宿主 data-theme 线索优先/兜底暗色。
6. **test/helpers/fixtures.mjs**：无结构性改动（column() 未加 color 参数，色点用例直接用字面量 board，避免动共享夹具）。

## 主题默认检测（取舍）

优先级即顺序，全部只读、不落盘、每次挂载只判一次（resolveInitialTheme：持久化偏好 > 检测）：

1. **dsh 宿主主题**：documentElement/body 的 `data-theme`/`data-color-mode`/`data-color-scheme` 属性与 class 词元（含 "dark"/"light" 字面）→ 命中即回；未命中再看挂载面背景 `getComputedStyle` 亮度（解析不了/全透明视为无线索）。
2. **系统偏好** `matchMedia("(prefers-color-scheme: dark)")`：matches=true → dark；false → light；**matchMedia 缺席/抛错 ≠ 不匹配**（曾因此把"无 matchMedia"误判成 light，pure.test 钉住）。
3. **兜底暗色**：深底宿主里误亮比误暗刺眼；无 DOM 环境（自检沙箱）同落此处。

已知口径：jsdom 无 matchMedia 且背景全透明 → 测试环境默认暗色（需要亮色的用例用 domStubs/种子 prefs 固定）。宿主属性与亮度线索优先于系统偏好（宿主明确说了算）。class 词元只认含 "dark"/"light" 字面的 token（"mode-night" 不算，防误判）。

## 拖拽写回设计（取舍）

- **事件模型**：不引入拖拽库。卡片身份经 React 闭包进 `dragRef`（dragstart 记、drop 消费、dragend 清理），`dataTransfer.setData("text/plain", itemId)` 只在 try/catch 里做礼仪性写入 —— 测试与真机都不依赖它的可读写性。dragover `preventDefault` 才允许 drop（HTML5 规范要求），同时驱动目标列高亮（Body 的 useState，纯视图状态）。
- **状态机事件**：`MOVE_START`（纯守卫：已有 pending/无看板/卡或目标列找不到/同列 → 原引用；否则乐观上板 + 拖拽前看板存进 pendingMove.snapshot）、`MOVE_OK`（清 pending 保乐观态，权威覆盖交给下一轮 BOARD_OK）、`MOVE_FAILED`（board ← snapshot 回滚 + moveError{code,message}，视图按 code 给指引：forbidden → 查 token 写权限；timeout/remote_timeout → 稍后再试；其余 → 通用提示）。回滚依赖 moveCardInBoard 的纯函数性（入参看板不被改写）。
- **pending 守卫**（与 inFlight 同型）：轮询 tick 在 `pendingMove !== null` 时跳过；第二次拖拽（requestMove 入口）忽略；迟到响应用**代数守卫 + pending 核对**双重丢弃 —— reload/切换/权威 BOARD_OK 都会作废 pendingMove（"完成即权威态，pending 作废"），此后 MOVE_OK/MOVE_FAILED 一律不 dispatch，不会回滚权威数据。
- **恰好 1 实参**：`moveCard(request)`，request = `{repo?, projectNumber, itemId, optionId}`（repo 仅仓归属项目携带）；strictArgumentFace 清单经 manifestArities 自动含 moveCard:1，另在 contract 显式补 `{moveCard: 1}` 断言。
- **不可拖卡片**：fallback 列（optionId null）/无 Status 字段/pending 在途 → 不设 draggable、cursor 默认、title 给原因（dragHintFallback/dragHintNoStatus/dragHintPending）；token 未配置时面板在引导视图，看不到卡片，无需处理。同列 drop = 列内排序，明确不支持（drop 处与纯函数双重短路）。
- **无障碍/触屏**：不做拖拽的键盘/触屏替代路径（HTML5 DnD 天然不覆盖），README 已注明；头像 img 带 alt/title、列头色点 aria-hidden、主题按钮 aria-label —— 这是本轮的无障碍边界。

## 测试数字

- smoke：227 → **242**（+15：moveCard 清单/闸/接线 4、5u 节 9、负责人头像拆分 2；改写 4 条旧断言——清单 4 方法、5c 头像、5c1c prefs 键、5i 按钮计数——理由均已写在 check 文案里）
- unit：84 → **121**（pure 24→40 +16；contract 15→19 +4；service/cache 增量来自并行 HOST 线程，不属本线程范围）
- react：24 → **34**（board-lifecycle 16→23 +7 拖拽；prefs-retry 8→11 +3 主题）
- **npm test 与 npm run test:strict 全绿（exit 0）**；总计 336 → 398。

## 留给主线/后续的核对点

- 版本 bump 0.9.0（package.json/lib/index.js VERSION/smoke 版本一致性断言）由主线统一执行——smoke 的 S2.9 版本断言当前仍按 package.json 现值对照，bump 后自然对齐。
- 真机验收（阶段 5 范畴）：宿主主题线索在 dsh web 的真实属性名（当前按 data-theme/data-color-mode/class 词元宽匹配）；DnD 在真机浏览器与 dsh 布局内的 drop 目标命中；moveCard 真实错误码文案与 README 排障表对照。
