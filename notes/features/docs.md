# 0.9.0 文档改动记录（读 + 状态写回 / 主题 / GitHub 风格）

日期：2026-10-03。分支 fe/thornwu-kanban-board-ui（基于 main a8b459f）。

背景：所有者需求——主题切换、GitHub 风格样式、卡片拖拽。拖拽跨列 = 写回更新 Status（`updateProjectV2ItemFieldValue`），产品从只读 Alpha 起步支持"状态写回"；列内排序无公开 mutation，明确不做。本文由 DOCS 线程维护（第一轮 agent 超时后由主线接续完成 CHANGELOG/package.json/本记录；README/SECURITY/TODO 主体为该 agent 产出，主线复核与契约一致）。

## 逐文件改动

1. **README.md**：开头与版本口径去"只读"（0.9.0 Alpha，读 + 状态写回）；「配置」节新增拖拽写回的 PAT 权限段——classic PAT `project` scope（仓库关联项目可能还需 `repo`）；fine-grained PAT 对 user 级项目的写支持按 GitHub 文档现状如实标注（"user 名下 Projects 仅 classic token 可访问"），并给 `forbidden` 的自查路径（先用 GitHub 网页确认同一 token 能改同一张卡）；「能力与限制」表补拖拽行为（乐观更新/失败回滚/「全部」列不可拖）、不支持清单（列内排序/建卡删卡/其他字段/触屏）、主题切换（默认跟随宿主，回退 prefers-color-scheme）、prefs/v1 含 theme；「排障」表补 6 行写回错误码（forbidden/not_supported/option_missing/item_missing/write_failed/bad_request/timeout）。
2. **SECURITY.md**：token 用途从仅读扩为"读查询与状态写回 mutation（目前仅 updateProjectV2ItemFieldValue）"；localStorage UI 偏好描述补 theme 字段；其余边界（内存缓存/指纹隔离/脱敏）不变。
3. **TODO.md**：版本口径更新为 0.9.0；双向写回项的"状态移动"由后续路线图变为已落地（剩余项维持）。
4. **CHANGELOG.md**：新增 0.9.0 段（主题/风格/拖拽写回/不支持清单/权限要求）。
5. **package.json**：仅 description（去"只读"）与 keywords（read-only → drag-and-drop、theme）；version 由主线统一 bump 0.9.0。

## GitHub 权限核对口径

第一轮 DOCS agent 未完成联网核对（超时），主线按保守措辞落地：classic PAT 需 `project` scope 是确定口径；fine-grained PAT 写 Projects（尤其 user 级）支持状态多变，文档不断言，指向"以 GitHub 实际行为为准 + forbidden 自查路径"。若后续确认 GitHub 文档结论，可收紧措辞。

## 留给主线的校对点

- 实现落地后核对：错误码清单与 lib/index.js 注释一致；UI 徽章实际文案（read-only → alpha）；主题检测回退链与 README 描述一致；prefs/v1 实际字段（savedAt/selectedKey/theme）与 SECURITY/README 一致。
- 版本 bump 0.9.0 三处（package.json / lib/index.js VERSION / smoke 断言）由主线统一执行。
