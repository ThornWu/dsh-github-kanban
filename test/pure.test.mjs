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
