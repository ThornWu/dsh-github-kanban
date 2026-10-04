/**
 * S3.1 纯函数测试:映射、缺失值、未知状态、项目去重及路由的纯逻辑面。
 *
 * 直驱入口(参照 smoke 5q/5r/5s 范式,phase2 交接 §6):
 *   - 宿主侧:lib/index.js 导出的纯函数(mapBoard / extractStatusField /
 *     statusFieldHint / normalizeRepos)直接 import;
 *   - 浏览器侧:mod.internals 暴露的状态机/视图推导/coerce/选择键(projectKey /
 *     selectTarget / boardTransition / viewBoardState / coerce* / isTransientFailure),
 *     不经 React。
 * 「项目去重及路由」的业务合并行为在 S3.2(service.test.mjs)覆盖,这里钉住其
 * 纯函数构件:projectKey 键规则与 selectTarget 延续优先级。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as host from "../lib/index.js";
import { loadClient, createMemoryStorage } from "./helpers/load-client.mjs";
import { jsonEqual } from "./helpers/assertions.mjs";

const { mod } = loadClient({ globals: { localStorage: createMemoryStorage() } });
const internals = mod.internals;
const { BOARD_PHASES: P, boardTransition, initialBoardState, viewBoardState, projectKey, selectTarget } = internals;

// ── 选择键与延续优先级(路由/去重的纯函数构件) ─────────────────────────────

test("S3.1 projectKey:用户级项目键为 #N,仓库级为 owner/name#N(跨 owner 同编号不撞)", () => {
  assert.equal(projectKey({ number: 7 }), "#7");
  assert.equal(projectKey({ number: 7, repo: "octocat/alpha" }), "octocat/alpha#7");
  assert.notEqual(projectKey({ number: 7, repo: "octocat/alpha" }), projectKey({ number: 7, repo: "octocat/beta" }));
  assert.notEqual(projectKey({ number: 7, repo: "octocat/alpha" }), projectKey({ number: 7 }));
});

test("S3.1 selectTarget 延续优先级:当前选择 → 持久化偏好 → 列表第一项 → null", () => {
  const projects = [
    { id: "p7", number: 7, title: "Alpha" },
    { id: "p9", number: 9, title: "Beta" },
    { id: "p11", number: 11, title: "Gamma", repo: "octocat/alpha" },
  ];
  assert.equal(selectTarget(projects, "#9", null)?.number, 9); // 当前选择优先
  assert.equal(selectTarget(projects, null, "octocat/alpha#11")?.number, 11); // 偏好次之
  assert.equal(selectTarget(projects, "#9", "octocat/alpha#11")?.number, 9); // 选择 > 偏好
  assert.equal(selectTarget(projects, null, null)?.number, 7); // 回退第一项
  assert.equal(selectTarget(projects, "#404", "#404")?.number, 7, "双失配仍回退列表第一项(宽容语义)");
  assert.equal(selectTarget([], null, null), null);
});

// ── 状态机:转换语义(每事件逐个验证;与 smoke 5q 互补,聚焦边界) ────────────

test("S3.1 boardTransition:FAILED 保留既有数据(错误态可带旧列表回工具栏)", () => {
  let state = boardTransition(initialBoardState(), { type: "START" });
  state = boardTransition(state, { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p7", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#7" });
  state = boardTransition(state, { type: "FAILED", stage: "board", code: "http_error", text: "x", transient: false });
  assert.equal(state.phase, P.ERROR);
  assert.equal(state.projects.length, 1, "列表保留");
  assert.equal(state.selected, "#7", "选择保留");
  assert.equal(state.boardInFlight, false, "在途标记复位");
  assert.deepEqual(Object.keys(state.error).sort(), ["code", "stage", "text", "transient"]);
});

test("S3.1 boardTransition:LIST_OK 空列表清空选择与看板(不残留上一个项目的投影)", () => {
  let state = boardTransition(initialBoardState(), { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p7", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#7" });
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [] }, key: "#7", totalCount: 3 });
  state = boardTransition(state, { type: "START" });
  state = boardTransition(state, { type: "LIST_OK", projects: [], warnings: [] });
  assert.equal(state.phase, P.READY);
  assert.equal(state.selected, null);
  assert.equal(state.board, undefined);
  assert.equal(state.totalCount, undefined);
  assert.equal(state.retryCount, 0, "空列表 = 完整启动成功,预算归零");
});

test("S3.1 boardTransition:非空 LIST_OK 保持 loading 等看板,警告随事件进 payload", () => {
  let state = boardTransition(initialBoardState(), { type: "START" });
  state = boardTransition(state, { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p7", number: 7, title: "Alpha" }], warnings: [{ source: "viewer", code: "graphql_error", message: "x" }] });
  assert.equal(state.phase, P.LOADING, "非空列表保持 loading 等看板");
  assert.ok(Array.isArray(state.warnings) && state.warnings.length === 1, "警告随事件进出");
});

test("S3.1 boardTransition:BOARD_START 清错误但不动 phase(错误期轮询重试不假装 loading)", () => {
  let state = boardTransition(initialBoardState(), { type: "FAILED", stage: "board", code: "remote_timeout", text: "x", transient: true });
  state = boardTransition(state, { type: "BOARD_START" });
  assert.equal(state.phase, P.ERROR);
  assert.equal(state.error, null);
  assert.equal(state.boardInFlight, true);
});

test("S3.1 boardTransition:未知事件类型返回原引用(转换封闭,不产生新状态)", () => {
  const state = boardTransition(initialBoardState(), { type: "TOKEN_KNOWN" });
  assert.equal(boardTransition(state, { type: "SOMETHING_ELSE" }), state);
});

// ── 视图推导:渲染决策矩阵 ───────────────────────────────────────────────────

test("S3.1 viewBoardState:tokenConfigured 三态驱动 引导/工具栏 显隐", () => {
  const idleUnknown = viewBoardState(initialBoardState());
  assert.equal(idleUnknown.showGuide, false, "undefined ≠ false:未确认前不进引导");
  assert.equal(idleUnknown.showToolbar, true, "未确认前工具栏在场");
  const guide = viewBoardState(boardTransition(initialBoardState(), { type: "TOKEN_GUIDE" }));
  assert.equal(guide.showGuide, true);
  assert.equal(guide.showToolbar, false);
  const known = viewBoardState(boardTransition(initialBoardState(), { type: "TOKEN_KNOWN" }));
  assert.equal(known.showGuide, false);
  assert.equal(known.showToolbar, true);
});

test("S3.1 viewBoardState:警告按 code 分流(failedSources vs truncatedSources)", () => {
  let state = boardTransition(initialBoardState(), { type: "TOKEN_KNOWN" });
  state = boardTransition(state, {
    type: "LIST_OK",
    projects: [{ id: "p7", number: 7, title: "Alpha" }],
    warnings: [
      { source: "octocat/bad", code: "graphql_error", message: "x" },
      { source: "octocat/gone", code: "repo_missing", message: "y" },
      { source: "viewer", code: "projects_truncated", message: "z" },
    ],
  });
  const view = viewBoardState(state);
  assert.deepEqual(view.failedSources, ["octocat/bad", "octocat/gone"]);
  assert.deepEqual(view.truncatedSources, ["viewer"]);
});

test("S3.1 viewBoardState:看板只在属于当前选择时上屏(boardMatchesSelection 门控)", () => {
  let state = boardTransition(initialBoardState(), { type: "START" });
  state = boardTransition(state, { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p7", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#9" }); // 切走
  state = boardTransition(state, { type: "BOARD_START" }); // 新请求在途
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [{ items: [{}] }] }, key: "#7", totalCount: 1 }); // 旧看板迟到
  const view = viewBoardState(state);
  assert.equal(view.boardMatchesSelection, false, "旧键不冒充当前项目");
  assert.equal(view.visibleCount, 1);
});

test("S3.1 viewBoardState:总数口径 —— 服务端总数缺席退回可见合计,不假称", () => {
  let state = boardTransition(initialBoardState(), { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p7", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#7" });
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [{ items: [] }, { items: [] }] }, key: "#7", totalCount: undefined });
  let view = viewBoardState(state);
  assert.equal(view.totalDisplay, 0);
  assert.equal(view.truncated, false);
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [{ items: [] }] }, key: "#7", totalCount: 5 });
  view = viewBoardState(state);
  assert.equal(view.totalDisplay, 5);
  assert.equal(view.truncated, true, "总数 > 可见 → 截断口径");
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [] }, key: "#7", totalCount: undefined, incomplete: true });
  view = viewBoardState(state);
  assert.equal(view.incomplete, true);
  assert.equal(view.truncated, true, "incomplete 单独即触发不完整提示");
});

// ── 契约校验纯函数:畸形响应矩阵(S2.4 行为在阶段 3 体系内的独立复证) ────────

test("S3.1 coerceStatus:缺 tokenConfigured 布尔 → shape_error;失败信封原样透传", () => {
  assert.equal(internals.coerceStatus({ ok: true, status: {} }).error?.code, "shape_error");
  assert.equal(internals.coerceStatus({ ok: true }).error?.code, "shape_error");
  assert.equal(internals.coerceStatus({ ok: true, status: null }).error?.code, "shape_error");
  const failure = { ok: false, error: { code: "http_error", message: "x" } };
  assert.equal(internals.coerceStatus(failure), failure, "失败信封透传不改写");
  assert.equal(internals.coerceStatus({ ok: true, status: { tokenConfigured: false } }).ok, true);
});

test("S3.1 coerceProjectsResult:条目缺正整数 number → shape_error;warnings 规整为字符串字段", () => {
  assert.equal(internals.coerceProjectsResult({ ok: true, projects: [{ id: "p", number: 0, title: "x" }] }).error?.code, "shape_error");
  assert.equal(internals.coerceProjectsResult({ ok: true, projects: [{ id: "p", number: 1.5, title: "x" }] }).error?.code, "shape_error");
  assert.equal(internals.coerceProjectsResult({ ok: true, projects: [null] }).error?.code, "shape_error");
  const coerced = internals.coerceProjectsResult({
    ok: true,
    projects: [{ id: "p1", number: 7, title: "Alpha" }],
    warnings: [null, { source: 42, code: "repo_missing", message: undefined }, "junk"],
  });
  assert.equal(coerced.ok, true);
  jsonEqual(coerced.warnings, [{ source: "42", code: "repo_missing", message: "" }], "坏警告过滤、字段字符串化");
});

test("S3.1 coerceBoardResult:列缺 items → shape_error;合法形状(空列数组)放行", () => {
  assert.equal(internals.coerceBoardResult({ ok: true, board: { columns: [{}] } }).error?.code, "shape_error");
  assert.equal(internals.coerceBoardResult({ ok: true, board: { columns: [null] } }).error?.code, "shape_error");
  const ok = internals.coerceBoardResult({ ok: true, board: { columns: [] } });
  assert.equal(ok.ok, true);
});

test("S3.1 isTransientFailure 分类:连接类可自愈 vs 永久失败", () => {
  const transientCodes = ["gateway/internal", "remote_timeout", "timeout"];
  for (const code of transientCodes) {
    assert.equal(internals.isTransientFailure({ ok: false, error: { code, message: "x" } }), true, code);
  }
  assert.equal(internals.isTransientFailure({ ok: false, error: { code: "http_error", message: "Failed to fetch?" } }), true, "message 含 Failed to fetch 视为连接未就绪");
  for (const code of ["http_error", "graphql_error", "shape_error", "token_missing", "all_sources_failed", "input_invalid"]) {
    assert.equal(internals.isTransientFailure({ ok: false, error: { code, message: "x" } }), false, code);
  }
  assert.equal(internals.isTransientFailure({ ok: true }), false);
  assert.equal(internals.isTransientFailure(undefined), false);
});

// ── 宿主纯函数:映射、缺失值、未知状态 ───────────────────────────────────────

const statusOptions = [
  { id: "opt_todo", name: "Todo" },
  { id: "opt_doing", name: "In Progress" },
  { id: "opt_done", name: "Done" },
];
const project = { id: "p1", number: 7, title: "Alpha", statusField: { id: "f", name: "Status", options: statusOptions } };

test("S3.1 mapBoard:列序 = Status 选项序,空列保留,未知 optionId 落未分列", () => {
  const mapped = host.mapBoard({
    project,
    itemNodes: [
      { id: "i1", content: { title: "已知状态" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "opt_doing", field: { name: "Status" } }] } },
      { id: "i2", content: { title: "未知状态" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "opt_unknown", field: { name: "Status" } }] } },
    ],
  });
  const names = mapped.board.columns.map((column) => column.name || column.fallback);
  assert.deepEqual(names, ["Todo", "In Progress", "Done", "unfiled"]);
  assert.equal(mapped.board.columns[2].items.length, 0, "空列保留");
  assert.equal(mapped.board.columns[1].items[0].id, "i1");
  assert.equal(mapped.board.columns[3].items[0].id, "i2", "未知 optionId → 未分列兜底");
});

test("S3.1 mapBoard 缺失值矩阵:content null / 无标题 / 无 fieldValues / 非对象项", () => {
  const mapped = host.mapBoard({
    project,
    itemNodes: [
      { id: "i1", content: null, fieldValues: { nodes: [] } }, // content 缺失(权限缺口真机形态)
      { id: "i2", content: {}, fieldValues: undefined }, // 标题缺失 + fieldValues 缺失
      null,
      "junk",
      42,
    ],
  });
  const unfiled = mapped.board.columns.find((column) => column.fallback === "unfiled");
  assert.equal(mapped.ok, true, "畸形项不抛");
  assert.equal(unfiled.items.length, 2, "非对象项被过滤,两个坏卡落兜底列");
  assert.equal(unfiled.items[0].untitled, true);
  assert.equal(unfiled.items[0].title, "");
  assert.deepEqual(unfiled.items[0].assignees, []);
  assert.deepEqual(unfiled.items[0].labels, []);
});

test("S3.1 mapBoard 未知状态(无 Status 字段):单列「全部」,全部卡归入", () => {
  const mapped = host.mapBoard({
    project: { ...project, statusField: null },
    itemNodes: [{ id: "i1", content: { title: "x" }, fieldValues: { nodes: [] } }],
  });
  assert.equal(mapped.board.hasStatusField, false);
  assert.equal(mapped.board.columns.length, 1);
  assert.equal(mapped.board.columns[0].fallback, "all");
  assert.equal(mapped.board.columns[0].items.length, 1);
});

test("S3.1 mapBoard:Status 字段存在但选项为空 → 0 个选项列,卡全部落未分列(口径钉住)", () => {
  const mapped = host.mapBoard({
    project: { ...project, statusField: { id: "f", name: "Status", options: [] } },
    itemNodes: [{ id: "i1", content: { title: "x" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "o1", field: { name: "Status" } }] } }],
  });
  assert.equal(mapped.board.hasStatusField, true);
  const unfiled = mapped.board.columns.find((column) => column.fallback === "unfiled");
  assert.ok(unfiled !== undefined, "有卡的兜底列在场");
  assert.equal(unfiled.items.length, 1);
});

test("S3.1 mapBoard:字段值坏项(非对象/缺 __typename)跳过,不影响其余字段提取", () => {
  const mapped = host.mapBoard({
    project,
    itemNodes: [
      {
        id: "i1",
        content: { title: "t" },
        fieldValues: {
          nodes: [
            null,
            "junk",
            { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "opt_todo", field: { name: "Status" } },
            { __typename: "ProjectV2ItemFieldUserValue", field: { name: "Assignees" }, users: { nodes: "not-array" } },
            { __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { nodes: [{ name: "L1" }, null, { name: "" }] } },
          ],
        },
      },
    ],
  });
  const cardItem = mapped.board.columns[0].items[0];
  assert.equal(cardItem.statusOptionId, "opt_todo");
  assert.deepEqual(cardItem.assignees, [], "users.nodes 非数组 → 空负责人,不抛");
  assert.deepEqual(cardItem.labels.map((label) => label.name), ["L1"], "坏标签项过滤");
});

test("S3.1 extractStatusField:命名匹配 + options 必须是数组;坏选项过滤、字段字符串化", () => {
  const found = host.extractStatusField([
    { id: "x", name: "State", options: [] }, // 其他单选字段
    { id: "f", name: "Status", options: [{ id: 1, name: "Todo" }, null, "junk"] },
  ]);
  assert.deepEqual(found, { id: "f", name: "Status", options: [{ id: "1", name: "Todo" }] });
  assert.equal(host.extractStatusField([{ id: "f", name: "Status" }]), null, "缺 options 数组不算 Status");
  assert.equal(host.extractStatusField("junk"), null);
});

test("S3.1 statusFieldHint 三口径 + 已找到为 null", () => {
  assert.equal(host.statusFieldHint([], false), "not_found");
  assert.equal(host.statusFieldHint([{ name: "Priority", options: [{ id: "o", name: "P1" }] }], false), "possibly_renamed");
  assert.equal(host.statusFieldHint(Array.from({ length: 40 }, (_, index) => ({ name: `f${index}` })), false), "fields_truncated");
  assert.equal(host.statusFieldHint([{ name: "Status", options: [] }], true), null);
});

test("S3.1 normalizeRepos:owner/name 解析、坏条目过滤、空白容忍", () => {
  assert.deepEqual(host.normalizeRepos(["octocat/hello-world", "  octocat/Spoon-Knife  "]), [
    { owner: "octocat", name: "hello-world", label: "octocat/hello-world" },
    { owner: "octocat", name: "Spoon-Knife", label: "octocat/Spoon-Knife" },
  ]);
  assert.deepEqual(host.normalizeRepos(["bad repo!!", "no-slash", "", null, 42, ["x"]]), []);
  assert.deepEqual(host.normalizeRepos(undefined), []);
  assert.deepEqual(host.normalizeRepos("octocat/hello-world"), []);
});

// ── 0.9.0 主题:归一 / 初始解析 / 默认检测链 / 枚举色与标签 pill ──────────────

const { normalizeTheme, hostThemeMarker, detectDefaultTheme, hostThemeHint, computedBackgroundLuminance, statusColorHex, labelPillStyle } = internals;

test("0.9.0 normalizeTheme:合法值放行,非法值(含大小写变体/非字符串)一律 null", () => {
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("Light"), null, "大小写敏感:非法值忽略");
  assert.equal(normalizeTheme("banana"), null);
  assert.equal(normalizeTheme(undefined), null);
  assert.equal(normalizeTheme(null), null);
  assert.equal(normalizeTheme(true), null);
});

test("0.9.0 hostThemeMarker:dsh 标记体系(body[data-ds-dark-theme] / html[data-ds-theme-source])判定,双缺席 = 非 dsh 环境 null", () => {
  const docLike = (bodyAttrs, htmlAttrs) => ({
    body: { hasAttribute: (name) => bodyAttrs.includes(name) },
    documentElement: { hasAttribute: (name) => htmlAttrs.includes(name) },
  });
  assert.equal(hostThemeMarker(docLike(["data-ds-dark-theme"], ["data-ds-theme-source"])), "dark", "暗标记在场 = dark");
  assert.equal(hostThemeMarker(docLike([], ["data-ds-theme-source"])), "light", "来源标记在场而无暗标记 = light");
  assert.equal(hostThemeMarker(docLike([], [])), null, "双缺席 = 非 dsh 环境,交回退链");
  assert.equal(hostThemeMarker(null), null, "无 document 沙箱安全");
});

test("0.9.0 detectDefaultTheme:宿主属性/类名线索 → 背景 luminance → matchMedia → 兜底暗色", () => {
  const fakeDoc = (attributes) => ({
    documentElement: { getAttribute: (name) => attributes.html?.[name] },
    body: { getAttribute: (name) => attributes.body?.[name] },
  });
  assert.equal(detectDefaultTheme({ document: fakeDoc({ html: { "data-theme": "dark" } }) }), "dark", "data-theme 命中");
  assert.equal(detectDefaultTheme({ document: fakeDoc({ body: { "data-color-mode": "light" } }) }), "light", "body 的 data 属性命中");
  assert.equal(detectDefaultTheme({ document: fakeDoc({ html: { class: "app theme-dark" } }) }), "dark", "class 词元命中");
  assert.equal(detectDefaultTheme({ document: fakeDoc({}) }), "dark", "无线索 → 兜底暗色");
  assert.equal(
    detectDefaultTheme({ document: fakeDoc({}), surfaceLuminance: () => 0.06 }),
    "dark",
    "深底 luminance → dark",
  );
  assert.equal(
    detectDefaultTheme({ document: fakeDoc({}), surfaceLuminance: () => 0.95 }),
    "light",
    "亮底 luminance → light",
  );
  assert.equal(
    detectDefaultTheme({ surfaceLuminance: () => 0.95, matchMedia: () => ({ matches: true }) }),
    "light",
    "宿主线索优先于系统偏好",
  );
  assert.equal(detectDefaultTheme({ matchMedia: () => { throw new Error("not implemented"); } }), "dark", "matchMedia 抛错按缺席处理 → 兜底暗色");
  assert.equal(detectDefaultTheme(undefined), "dark", "无 env 同样兜底");
});

test("0.9.0 hostThemeHint / computedBackgroundLuminance:纯函数矩阵(不含 DOM)", () => {
  assert.equal(hostThemeHint({ documentElement: null, body: undefined }), null);
  assert.equal(hostThemeHint({ documentElement: { getAttribute: () => "dark" } }), "dark");
  assert.equal(hostThemeHint({ documentElement: { getAttribute: (name) => (name === "class" ? "mode-night" : undefined) } }), null, "class 词元必须含 dark/light 字面,night 不算");
  const luminance = computedBackgroundLuminance({ backgroundColor: "rgb(13, 17, 23)" });
  assert.ok(luminance !== null && luminance < 0.5, `GitHub 暗色画布 #0d1117 判暗:${luminance}`);
  assert.ok(computedBackgroundLuminance({ backgroundColor: "rgb(246, 248, 250)" }) > 0.5, "浅色画布 #f6f8fa 判亮");
  assert.equal(computedBackgroundLuminance({ backgroundColor: "rgba(0, 0, 0, 0)" }), null, "全透明不可判定");
  assert.equal(computedBackgroundLuminance({ backgroundColor: "" }), null);
  assert.equal(computedBackgroundLuminance(undefined), null);
});

test("0.9.0 statusColorHex:枚举色两套 hex,大小写不敏感,未知/缺席回退灰", () => {
  assert.equal(statusColorHex("BLUE", "light"), "#0969da");
  assert.equal(statusColorHex("blue", "dark"), "#4493f8", "大小写不敏感 + 主题分支");
  assert.equal(statusColorHex("MAGENTA", "light"), "#6e7781", "未知枚举回退灰");
  assert.equal(statusColorHex(null, "dark"), "#8b949e", "缺席(兜底列)同样回退灰");
});

test("0.9.0 labelPillStyle:合法 hex 给 fg+半透明底,非法/缺席退化 undefined", () => {
  const light = labelPillStyle("ff8800", "light");
  assert.equal(light.backgroundColor, "rgba(255, 136, 0, 0.2)");
  assert.ok(light.color.startsWith("rgb(") && light.color.includes("158"), "浅色主题前景压暗(0.62x)");
  const dark = labelPillStyle("ff8800", "dark");
  assert.equal(dark.backgroundColor, "rgba(255, 136, 0, 0.18)");
  assert.ok(dark.color.startsWith("rgb("), "暗色主题前景微亮");
  assert.equal(labelPillStyle(undefined, "light"), undefined, "color 缺席(旧宿主)→ 主题默认 pill");
  assert.equal(labelPillStyle("#ff8800", "light"), undefined, "带 # 的形状不算合法 hex");
  assert.equal(labelPillStyle("zzzzzz", "dark"), undefined);
});

// ── 0.9.0 拖拽写回:状态机新事件(MOVE_START/OK/FAILED)+ 乐观纯函数 + pending 守卫 ──

const { moveCardInBoard, dragDisabledReason } = internals;

/** 两列样例看板(Todo o1 有卡 a1/a2,Done o2 空)。 */
const moveBoard = () => ({
  project: { id: "p1", number: 7, title: "Alpha" },
  hasStatusField: true,
  columns: [
    { optionId: "o1", color: "GRAY", name: "Todo", items: [{ id: "a1", title: "甲", assignees: [], labels: [], statusOptionId: "o1" }, { id: "a2", title: "乙", assignees: [], labels: [], statusOptionId: "o1" }] },
    { optionId: "o2", color: "GREEN", name: "Done", items: [] },
  ],
});

const moveReadyState = (board = moveBoard()) => {
  let state = boardTransition(initialBoardState("light"), { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p1", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#7" });
  return boardTransition(state, { type: "BOARD_OK", board, key: "#7", totalCount: 2 });
};

test("0.9.0 moveCardInBoard:移到目标列末尾,原看板不被改写(快照回滚的依据)", () => {
  const board = moveBoard();
  const moved = moveCardInBoard(board, "a1", "o2");
  assert.equal(moved.columns[1].items[0]?.id, "a1", "卡落在目标列");
  assert.equal(moved.columns[0].items.map((item) => item.id).join(","), "a2", "源列移除该卡");
  assert.deepEqual(board.columns[0].items.map((item) => item.id), ["a1", "a2"], "入参看板保持原样(纯函数)");
  assert.deepEqual(moved.columns.map((column) => column.optionId), ["o1", "o2"], "列序不变");
});

test("0.9.0 moveCardInBoard:找不到卡/目标列、同列、形状不完整 → 原引用返回(无乐观可做)", () => {
  const board = moveBoard();
  assert.equal(moveCardInBoard(board, "ghost", "o2"), board);
  assert.equal(moveCardInBoard(board, "a1", "o_ghost"), board);
  assert.equal(moveCardInBoard(board, "a1", "o1"), board, "同列 = 列内排序不支持,原引用");
  assert.equal(moveCardInBoard(undefined, "a1", "o2"), undefined);
  const shapeless = {};
  assert.equal(moveCardInBoard(shapeless, "a1", "o2"), shapeless, "缺 columns 的形状原样返回");
  assert.equal(moveCardInBoard(board, "", "o2"), board);
  assert.equal(moveCardInBoard(board, "a1", null), board);
});

test("0.9.0 boardTransition MOVE_START:建立 pendingMove(含拖拽前快照)+ 乐观上板", () => {
  const board = moveBoard();
  const state = boardTransition(moveReadyState(board), { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  assert.equal(state.pendingMove?.itemId, "a1");
  assert.equal(state.pendingMove?.fromOptionId, "o1");
  assert.equal(state.pendingMove?.toOptionId, "o2");
  assert.equal(state.pendingMove?.snapshot, board, "快照 = 拖拽前看板(同引用)");
  assert.equal(state.board.columns[1].items[0]?.id, "a1", "乐观上板");
  assert.equal(state.moveError, null, "发起即清上一次失败提示");
});

test("0.9.0 boardTransition MOVE_START 守卫矩阵:二次拖拽/同列/找不到卡/目标列都是原引用", () => {
  const board = moveBoard();
  const base = moveReadyState(board);
  const started = boardTransition(base, { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  assert.equal(boardTransition(started, { type: "MOVE_START", itemId: "a2", fromOptionId: "o1", toOptionId: "o2" }), started, "pending 在场:第二次拖拽忽略");
  assert.equal(boardTransition(base, { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o1" }), base, "同列(列内排序)拒绝");
  assert.equal(boardTransition(base, { type: "MOVE_START", itemId: "ghost", fromOptionId: "o1", toOptionId: "o2" }), base, "卡不存在拒绝");
  assert.equal(boardTransition(base, { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o_ghost" }), base, "目标列不存在拒绝");
  const emptyState = initialBoardState();
  assert.equal(boardTransition(emptyState, { type: "MOVE_START", itemId: "a1", fromOptionId: null, toOptionId: "o2" }), emptyState, "无看板拒绝(空态下原引用)");
});

test("0.9.0 boardTransition MOVE_OK:清 pending 保乐观态;MOVE_FAILED:回滚快照 + moveError", () => {
  const board = moveBoard();
  let state = boardTransition(moveReadyState(board), { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  const optimistic = state.board;
  state = boardTransition(state, { type: "MOVE_OK" });
  assert.equal(state.pendingMove, null, "成功:pending 清空");
  assert.equal(state.board, optimistic, "成功:乐观态维持(权威覆盖交给 BOARD_OK)");
  assert.equal(state.moveError, null);

  const failing = boardTransition(moveReadyState(board), { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  const rolledBack = boardTransition(failing, { type: "MOVE_FAILED", code: "forbidden", message: "403" });
  assert.equal(rolledBack.board, board, "失败:回滚到拖拽前快照(同引用)");
  assert.equal(rolledBack.pendingMove, null);
  jsonEqual(rolledBack.moveError, { code: "forbidden", message: "403" }, "moveError 记录 code+message(跨 realm 用 jsonEqual)");
  assert.equal(boardTransition(moveReadyState(), { type: "MOVE_FAILED", code: "x", message: "y" }).moveError, null, "无 pending 时 MOVE_FAILED 不动状态");
});

test("0.9.0 boardTransition 权威收口:BOARD_OK/BOARD_START/FAILED/空列表 LIST_OK 作废 pending 与 moveError", () => {
  const board = moveBoard();
  const started = (state) => boardTransition(state, { type: "MOVE_START", itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  let state = started(moveReadyState(board));
  state = boardTransition(state, { type: "BOARD_START" });
  assert.equal(state.pendingMove, null, "BOARD_START(reload/切换)作废 pending:完成即权威态");
  state = started(moveReadyState(board));
  state = boardTransition(state, { type: "BOARD_OK", board: moveBoard(), key: "#7", totalCount: 2 });
  assert.equal(state.pendingMove, null, "BOARD_OK 权威上账同时作废 pending");
  state = started(moveReadyState(board));
  state = boardTransition(state, { type: "FAILED", stage: "board", code: "http_error", text: "x", transient: false });
  assert.equal(state.pendingMove, null, "FAILED(错误态看板区退位)作废 pending");
  state = boardTransition(started(moveReadyState(board)), { type: "START" });
  assert.equal(state.moveError, null, "START(整链重开)清 moveError");
});

test("0.9.0 boardTransition THEME_SET:合法值切换,非法值原引用;initialBoardState(theme) 兜底暗色", () => {
  const light = boardTransition(initialBoardState("dark"), { type: "THEME_SET", theme: "light" });
  assert.equal(light.theme, "light");
  assert.equal(boardTransition(light, { type: "THEME_SET", theme: "nonsense" }), light, "非法主题原引用返回");
  assert.equal(initialBoardState().theme, "dark", "缺席 → 兜底暗色");
  assert.equal(initialBoardState("light").theme, "light");
  assert.equal(initialBoardState("banana").theme, "dark", "非法初值同样兜底");
});

// ── 0.9.0 载荷扩展透传:coerceBoard 字段缺席允许、在场须形状正确 ────────────────

test("0.9.0 coerceBoard:projectNodeId/statusFieldId/列 color/labels color/头像明细 全部透传", () => {
  const rich = internals.coerceBoardResult({
    ok: true,
    board: {
      project: { number: 7 },
      hasStatusField: true,
      projectNodeId: "PV_node",
      statusFieldId: "SF_node",
      columns: [
        { optionId: "o1", color: "BLUE", name: "Todo", items: [{ id: "a1", title: "卡", assignees: ["octocat"], assigneeDetails: [{ login: "octocat", avatarUrl: "https://example.com/a.png" }], labels: [{ name: "P1", color: "ff8800" }], statusOptionId: "o1" }] },
        { optionId: null, color: null, name: "", fallback: "unfiled", items: [{ id: "a2", title: "兜底卡" }] },
      ],
    },
  });
  assert.equal(rich.ok, true, "合法扩展形状原样放行");
  assert.equal(rich.board.projectNodeId, "PV_node");
  assert.equal(rich.board.columns[0].color, "BLUE");
  assert.equal(rich.board.columns[0].items[0].assigneeDetails[0].avatarUrl, "https://example.com/a.png");
  assert.equal(rich.board.columns[1].optionId, null, "兜底列 optionId null 放行");
  // 旧宿主形状(扩展字段全缺席)不受影响
  const legacy = internals.coerceBoardResult({ ok: true, board: { columns: [{ name: "Todo", items: [{ id: "a1", title: "卡", assignees: ["octocat"], labels: [{ name: "P1" }] }] }] } });
  assert.equal(legacy.ok, true, "扩展字段缺席允许(旧宿主输出照常)");
});

test("0.9.0 coerceBoard:在场但形状错误 → shape_error(可观测,不静默纠正)", () => {
  const cases = [
    { board: { columns: [], projectNodeId: 42 }, label: "projectNodeId 非字符串" },
    { board: { columns: [], statusFieldId: 42 }, label: "statusFieldId 非字符串" },
    { board: { columns: [{ optionId: 42, name: "Todo", items: [] }] }, label: "列 optionId 非字符串" },
    { board: { columns: [{ optionId: null, name: "Todo", items: [] }] }, label: "列 optionId null 允许", ok: true },
    { board: { columns: [{ color: 42, name: "Todo", items: [] }] }, label: "列 color 非字符串" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assignees: "octocat" }] }] }, label: "assignees 非数组" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assignees: [42] }] }] }, label: "assignee 条目畸形" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assignees: [{ login: 42 }] }] }] }, label: "assignee.login 非字符串" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assignees: [{ avatarUrl: 42 }] }] }] }, label: "assignee.avatarUrl 非字符串" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assigneeDetails: "x" }] }] }, label: "assigneeDetails 非数组" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", assigneeDetails: [null] }] }] }, label: "assigneeDetails 条目非对象" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", labels: "x" }] }] }, label: "labels 非数组" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", labels: [null] }] }] }, label: "label 条目非对象" },
    { board: { columns: [{ name: "Todo", items: [{ id: "a1", labels: [{ color: 42 }] }] }] }, label: "label.color 非字符串" },
  ];
  for (const item of cases) {
    const outcome = internals.coerceBoardResult({ ok: true, ...item });
    if (item.ok === true) assert.equal(outcome.ok, true, item.label);
    else assert.equal(outcome.error?.code, "shape_error", `${item.label} → shape_error(${JSON.stringify(outcome.error?.message ?? "")})`);
  }
});

test("0.9.0 dragDisabledReason:pending/无 Status 字段/fallback 列给词典键,正常列 null", () => {
  const board = moveBoard();
  const columns = board.columns;
  assert.equal(dragDisabledReason(board, columns[0], null), null, "正常列可拖");
  assert.equal(dragDisabledReason(board, columns[0], { itemId: "a1" }), "dragHintPending", "移动在途不可拖");
  assert.equal(dragDisabledReason({ ...board, hasStatusField: false }, columns[0], null), "dragHintNoStatus", "无 Status 字段不可拖");
  assert.equal(dragDisabledReason(board, { optionId: null, fallback: "unfiled", items: [] }, null), "dragHintFallback", "兜底列不可拖");
  assert.equal(dragDisabledReason(board, undefined, null), "dragHintFallback");
});

test("0.9.0 控制器 pending 守卫:移动在途时轮询 tick 跳过(与 inFlight 同型),settle 后恢复", async () => {
  let moveCalls = 0;
  let boardCalls = 0;
  let releaseMove;
  const gate = new Promise((resolve) => {
    releaseMove = resolve;
  });
  const api = {
    status: async () => ({ ok: true, status: { tokenConfigured: true } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => {
      boardCalls += 1;
      return { ok: true, board: moveBoard(), totalCount: 2 };
    },
    moveCard: async () => {
      moveCalls += 1;
      return gate.then(() => ({ ok: true }));
    },
  };
  const registered = [];
  const controller = internals.createBoardController({
    getApi: () => api,
    t: (key) => key,
    polling: {
      intervalMs: 30_000,
      setInterval: (callback, ms) => {
        registered.push(callback);
        return () => registered.pop();
      },
      isVisible: () => true,
    },
    delay: () => Promise.resolve(),
    scheduleRetry: () => () => {},
    initialTheme: "light",
  });
  const settle = async (rounds = 6) => {
    for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  controller.start();
  await settle();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(boardCalls, 1, "初拉一次");
  controller.requestMove({ itemId: "a1", fromOptionId: "o1", toOptionId: "o2" });
  await settle(2);
  assert.equal(moveCalls, 1, "写回在途");
  registered[0](); // 轮询 tick:pending 在场 → 跳过(不得叠发 getBoard)
  await settle(2);
  assert.equal(boardCalls, 1, "pending 期间轮询跳过");
  assert.equal(controller.getSnapshot().pendingMove?.itemId, "a1", "乐观态不受 tick 影响");
  releaseMove();
  await settle(2);
  assert.equal(controller.getSnapshot().pendingMove, null, "写回成功,pending 清空");
  registered[0](); // 下一轮 tick:恢复轮询
  await settle(2);
  assert.equal(boardCalls, 2, "移动 settle 后轮询恢复");
  controller.dispose();
});
