/**
 * S3.2 服务测试:分页、局部失败、权限错误、畸形响应、超时及取消。
 *
 * 对象:lib/index.js 的 GithubKanbanService(宿主服务)。依赖全注入
 * (fetchImpl/env/repos/cache/requestTimeoutMs),不真实联网、不用真实 token。
 * 每个用例独立 new 一个服务实例,fetch 替身按请求体(query/variables)分发响应,
 * 夹具形状与 QUERY_* 选择集逐字段同形(helpers/fixtures.mjs)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as host from "../lib/index.js";
import { fetchResponding, viewerProjectsPage, repoProjectsPage, projectNode, viewerBoardPage, repoBoardPage, boardItemNode } from "./helpers/fixtures.mjs";

const ENV = { GITHUB_TOKEN: "test-token-not-real" };

/** 记录请求并可编程响应的服务测试台。behavior(body) 返回 fixtures 形状或 { errors } / { status }。 */
const makeService = (behavior, deps = {}) => {
  const calls = [];
  const service = new host.GithubKanbanService({
    env: ENV,
    ...deps,
    fetchImpl: fetchResponding(async (body, url, init) => {
      calls.push({ body, url, init });
      return behavior(body, calls.length);
    }),
  });
  return { service, calls };
};

const isViewerList = (body) => body.variables?.owner === undefined && String(body.query).includes("projectsV2");
const isRepoList = (body) => body.variables?.owner !== undefined && String(body.query).includes("projectsV2");
const isBoard = (body) => String(body.query).includes("projectV2(number:");

// ── status ──────────────────────────────────────────────────────────────────

test("S3.2 status:token 配置布尔 + 合法仓库计数(坏格式条目不计入)", async () => {
  const { service } = makeService(() => viewerProjectsPage([]), { repos: ["octocat/alpha", "bad!!", "octocat/beta"] });
  const result = await service.status();
  assert.equal(result.ok, true);
  assert.equal(result.status.tokenConfigured, true);
  assert.equal(result.status.repos, 2);
  assert.ok(!("value" in result), "业务结果不带 value 键(网关信封拆包约定,S2.6)");
});

test("S3.2 status/listProjects/getBoard:token 缺失统一返回 token_missing,不发网络请求", async () => {
  const { service, calls } = makeService(() => viewerProjectsPage([]), { env: {} });
  const status = await service.status();
  assert.equal(status.status.tokenConfigured, false);
  const list = await service.listProjects();
  assert.equal(list.ok, false);
  assert.equal(list.error.code, "token_missing");
  const board = await service.getBoard({ projectNumber: 7 });
  assert.equal(board.ok, false);
  assert.equal(board.error.code, "token_missing");
  assert.equal(calls.length, 0, "token 缺失是全局前置条件,不打 GitHub");
});

// ── 分页 ────────────────────────────────────────────────────────────────────

test("S3.2 listProjects 分页:>30 项目按 pageInfo 游标拉全,capped 不误报", async () => {
  const page1 = Array.from({ length: 30 }, (_, index) => projectNode({ id: `p${index}`, number: index + 1, title: `P${index + 1}` }));
  const page2 = Array.from({ length: 5 }, (_, index) => projectNode({ id: `p${index + 30}`, number: index + 31, title: `P${index + 31}` }));
  const { service, calls } = makeService((body, callIndex) => viewerProjectsPage(callIndex === 1 ? page1 : page2, callIndex === 1 ? { hasNextPage: true, endCursor: "cursor-1" } : {}));
  const result = await service.listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.projects.length, 35, "两页合并");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.variables.after, "cursor-1", "第二页带游标");
  assert.equal(result.warnings, undefined, "第二页 hasNextPage=false → 未触上限");
});

test("S3.2 getBoard 分页:items 按 50/页翻满 4 页,totalCount 取服务端口径", async () => {
  const itemsOf = (page) => Array.from({ length: 50 }, (_, index) => boardItemNode({ id: `i-${page}-${index}`, title: `卡 ${page}-${index}`, optionId: "o1" }));
  const { service, calls } = makeService((body, callIndex) =>
    viewerBoardPage({ items: itemsOf(callIndex), totalCount: 220, hasNextPage: callIndex < 4, endCursor: callIndex < 4 ? `c${callIndex}` : undefined }),
  );
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.fetchedCount, 200, "4 页 × 50 拉满上限");
  assert.equal(result.totalCount, 220, "服务端总数口径");
  assert.equal(calls.length, 4);
  const visible = result.board.columns.reduce((sum, column) => sum + column.items.length, 0);
  assert.equal(visible, 200);
});

test("S3.2 listProjects 排序:updatedAt 降序,同更新时间按编号升序;closed 过滤", async () => {
  const { service } = makeService(() =>
    viewerProjectsPage([
      projectNode({ id: "a", number: 5, title: "同刻五号", updatedAt: "2026-09-30T00:00:00Z" }),
      projectNode({ id: "b", number: 2, title: "较新", updatedAt: "2026-10-01T00:00:00Z" }),
      projectNode({ id: "c", number: 3, title: "同刻三号", updatedAt: "2026-09-30T00:00:00Z" }),
      projectNode({ id: "d", number: 1, title: "已关闭", updatedAt: "2026-10-02T00:00:00Z", closed: true }),
      projectNode({ id: "e", number: 4, title: "较旧", updatedAt: "2026-09-01T00:00:00Z" }),
    ]),
  );
  const result = await service.listProjects();
  assert.deepEqual(
    result.projects.map((project) => project.number),
    [2, 3, 5, 4],
  );
});

// ── 项目去重与路由(业务级;纯函数构件在 S3.1) ───────────────────────────────

test("S3.2 去重与路由:跨 owner 同编号三路独立,同 id 多仓留配置序靠后,getBoard 按 repo 路由", async () => {
  const calls = [];
  const { service } = makeService((body) => {
    calls.push(body);
    if (isBoard(body)) {
      if (body.variables.owner !== undefined) return repoBoardPage({ owner: body.variables.owner, name: body.variables.name, number: body.variables.number, items: [boardItemNode({ id: `i-${body.variables.name}`, title: `${body.variables.owner}/${body.variables.name} 的卡`, optionId: "o1" })] });
      return viewerBoardPage({ number: 3, title: "viewer #3" });
    }
    if (isRepoList(body)) {
      const repo = `${body.variables.owner}/${body.variables.name}`;
      const entries =
        repo === "octocat/alpha"
          ? [projectNode({ id: "pv-alpha-3", number: 3, title: "Alpha #3", updatedAt: "2026-09-29T00:00:00Z" }), projectNode({ id: "pv-shared-9", number: 9, title: "Shared", updatedAt: "2026-09-27T00:00:00Z" })]
          : repo === "octocat/beta"
            ? [projectNode({ id: "pv-beta-3", number: 3, title: "Beta #3", updatedAt: "2026-09-30T00:00:00Z" }), projectNode({ id: "pv-shared-9", number: 9, title: "Shared", updatedAt: "2026-09-27T00:00:00Z" })]
            : [];
      return repoProjectsPage(repo, entries);
    }
    return viewerProjectsPage([projectNode({ id: "pv-viewer-3", number: 3, title: "Viewer #3", updatedAt: "2026-09-28T00:00:00Z" })]);
  }, { repos: ["octocat/alpha", "octocat/beta"] });
  const list = await service.listProjects();
  assert.deepEqual(
    list.projects.map((project) => `${project.repo ?? ""}#${project.number}`),
    ["octocat/beta#3", "octocat/alpha#3", "#3", "octocat/beta#9"],
    "跨 owner 同编号不互撞;同 id 双仓去重留配置序靠后",
  );
  const alphaBoard = await service.getBoard({ projectNumber: 3, repo: "octocat/alpha" });
  const viewerBoard = await service.getBoard({ projectNumber: 3 });
  const lastTwo = calls.slice(-2);
  assert.deepEqual(lastTwo[0].variables, { owner: "octocat", name: "alpha", number: 3 }, "repo 条目走 repository 路径");
  assert.ok(String(lastTwo[1].query).includes("viewer"), "无 repo 条目走 viewer 路径");
  assert.equal(alphaBoard.board.columns[0].items[0].title, "octocat/alpha 的卡");
  assert.equal(viewerBoard.board.project.title, "viewer #3");
});

// ── 局部失败 / 权限错误 ──────────────────────────────────────────────────────

test("S3.2 局部失败:单仓 GraphQL 错误 + 仓库缺席不拖垮列表,viewer 与好仓保留 + 来源级警告", async () => {
  const { service } = makeService((body) => {
    if (isRepoList(body)) {
      if (body.variables.name === "forbidden") return { errors: [{ message: "Resource not accessible by integration" }] };
      if (body.variables.name === "gone") return { data: { repository: null } };
      return repoProjectsPage(`${body.variables.owner}/${body.variables.name}`, [projectNode({ id: "pv-ok", number: 4, title: "好仓项目" })]);
    }
    return viewerProjectsPage([projectNode({ id: "pv-v", number: 1, title: "viewer 项目" })]);
  }, { repos: ["octocat/forbidden", "octocat/gone", "octocat/ok"] });
  const result = await service.listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.projects.length, 2, "成功来源保留");
  assert.deepEqual(
    result.warnings.map((warning) => `${warning.source}[${warning.code}]`),
    ["octocat/forbidden[graphql_error]", "octocat/gone[repo_missing]"],
  );
});

test("S3.2 权限错误:HTTP 401(无效 token)折叠为 http_error 且消息不含 token", async () => {
  const secret = "ghp_service_test_secret";
  const service = new host.GithubKanbanService({
    env: { GITHUB_TOKEN: secret },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http_error");
  assert.ok(result.error.message.includes("401"));
  assert.ok(!JSON.stringify(result).includes(secret), "凭据不进错误信封");
});

test("S3.2 权限错误:GraphQL FORBIDDEN 消息脱敏后进警告(单仓),viewer 照常", async () => {
  const secret = "ghp_graphql_forbidden_secret";
  const { service } = makeService((body) => {
    if (isRepoList(body)) return { errors: [{ message: `FORBIDDEN token ${secret}` }] };
    return viewerProjectsPage([projectNode({ id: "pv-v", number: 1, title: "viewer" })]);
  }, { env: { GITHUB_TOKEN: secret }, repos: ["octocat/locked"] });
  const result = await service.listProjects();
  assert.equal(result.ok, true);
  const warning = result.warnings[0];
  assert.equal(warning.code, "graphql_error");
  assert.ok(!warning.message.includes(secret), "警告消息脱敏");
});

test("S3.2 全来源失败:返回 all_sources_failed 并点名来源,绝不伪装成空列表", async () => {
  const { service } = makeService(() => ({ errors: [{ message: "down" }] }), { repos: ["octocat/a"] });
  const result = await service.listProjects();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "all_sources_failed");
  assert.ok(result.error.message.includes("viewer"));
  assert.ok(result.error.message.includes("octocat/a"));
  assert.equal(result.projects, undefined);
});

// ── 畸形响应 ────────────────────────────────────────────────────────────────

test("S3.2 畸形响应:nodes 非数组 → shape_error(不无声退化为空)", async () => {
  // 看板单来源:畸形直接透传为 shape_error
  const boardService = new host.GithubKanbanService({
    env: ENV,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { viewer: { projectV2: { id: "p7", number: 7, title: "x", items: { nodes: "not-array", pageInfo: { hasNextPage: false } } } } } }) }),
  });
  const board = await boardService.getBoard({ projectNumber: 7 });
  assert.equal(board.ok, false);
  assert.equal(board.error.code, "shape_error");
  // 列表(多来源聚合):唯一来源畸形 → all_sources_failed,来源警告点名 shape_error
  const { service } = makeService(() => ({ data: { viewer: { projectsV2: { nodes: "not-array", pageInfo: { hasNextPage: false } } } } }));
  const list = await service.listProjects();
  assert.equal(list.ok, false);
  assert.equal(list.error.code, "all_sources_failed");
  assert.ok(list.error.message.includes("shape_error"), "底层 code 仍在消息里可观测");
});

test("S3.2 畸形响应:pageInfo 缺席 → 取首页即止(可解释的保守行为,不抛不循环)", async () => {
  const { service, calls } = makeService(() => ({ data: { viewer: { projectsV2: { nodes: [projectNode({ id: "p1", number: 1, title: "x" })] } } } }));
  const result = await service.listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.projects.length, 1);
  assert.equal(calls.length, 1, "无 pageInfo 即视为无下一页");
});

test("S3.2 畸形响应:projectV2 缺席(null)→ project_not_found;输入非法 → input_invalid", async () => {
  const { service } = makeService(() => ({ data: { viewer: { projectV2: null } } }));
  const missing = await service.getBoard({ projectNumber: 404 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "project_not_found");
  const badNumber = await service.getBoard({ projectNumber: 0 });
  assert.equal(badNumber.error.code, "input_invalid");
  const badRepo = await service.getBoard({ projectNumber: 3, repo: "no-slash" });
  assert.equal(badRepo.error.code, "input_invalid");
});

test("S3.2 畸形响应:fields 连接缺席/非数组 → Status 缺失口径(单列 + hint),不抛", async () => {
  const { service } = makeService(() => ({
    data: { viewer: { projectV2: { id: "p7", number: 7, title: "Alpha", items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } },
  }));
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.board.hasStatusField, false);
  assert.equal(result.board.statusFieldHint, "not_found");
  assert.equal(result.board.columns.length, 1);
  assert.equal(result.board.columns[0].fallback, "all");
});

test("S3.2 完整性:items 拉满上限且无服务端总数 → incomplete 显式标记(不假称全量)", async () => {
  const items = Array.from({ length: 50 }, (_, index) => boardItemNode({ id: `i${index}`, title: `卡${index}`, optionId: "o1" }));
  const { service } = makeService((_body, callIndex) => viewerBoardPage({ items, hasNextPage: true, endCursor: "c" }));
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.incomplete, true);
  assert.equal(result.fetchedCount, 200);
});

test("S3.2 自诊断:content null 计数进 board.contentMissing;字段值截断计数进 fieldValuesTruncated", async () => {
  const { service } = makeService(() =>
    viewerBoardPage({
      totalCount: 3,
      items: [
        boardItemNode({ id: "i1", contentMissing: true, optionId: "o1" }),
        boardItemNode({ id: "i2", title: "正常", optionId: "o1" }),
        boardItemNode({ id: "i3", title: "标签超页", optionId: "o1", labels: ["L1"], truncated: { fieldValues: true } }),
      ],
    }),
  );
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.board.contentMissing, 1);
  assert.equal(result.board.fieldValuesTruncated, 1);
});

// ── 0.9.0 载荷扩展(拖拽写回与 GitHub 风格渲染供数;只增不改) ─────────────────

test("S3.2 载荷扩展:projectNodeId/statusFieldId/列 color/optionId 入投影(fallback 列二者 null)", async () => {
  const { service } = makeService(() =>
    viewerBoardPage({
      number: 7,
      statusOptions: [
        { id: "o1", name: "Todo", color: "GRAY" },
        { id: "o2", name: "Done" }, // 选项缺 color → 投影 null(形状稳定:color 恒在场)
      ],
      totalCount: 1,
      items: [
        boardItemNode({ id: "i-unknown", title: "未知列卡", optionId: "o-unknown" }), // 落 unfiled 兜底列
      ],
    }),
  );
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.board.projectNodeId, "pv-7", "项目全局 node id(写回 mutation 的 projectId 来源)");
  assert.equal(result.board.statusFieldId, "f_status", "Status 字段全局 id(写回 mutation 的 fieldId 来源)");
  const [todo, done, unfiled] = result.board.columns;
  assert.equal(todo.optionId, "o1");
  assert.equal(todo.color, "GRAY", "列 color 来自 ProjectV2FieldOptionColor 枚举(如 GREEN/RED)");
  assert.equal(done.optionId, "o2");
  assert.equal(done.color, null, "选项缺 color → null,键恒在场(客户端透传依赖形状稳定)");
  assert.equal(unfiled.optionId, null, "fallback 列 optionId=null(既有口径)");
  assert.equal(unfiled.color, null, "fallback 列 color=null");
});

test("S3.2 载荷扩展:无 Status 字段 → statusFieldId=null,单列兜底 optionId/color 均 null", async () => {
  const { service } = makeService(() => viewerBoardPage({ number: 7, statusOptions: null, totalCount: 0 }));
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.board.hasStatusField, false);
  assert.equal(result.board.statusFieldId, null);
  assert.equal(result.board.projectNodeId, "pv-7");
  assert.equal(result.board.columns[0].fallback, "all");
  assert.equal(result.board.columns[0].optionId, null);
  assert.equal(result.board.columns[0].color, null);
});

test("S3.2 载荷扩展:卡片 assignees 保持 login 字符串数组,新增 assigneeDetails 带 avatarUrl;labels color 透传", async () => {
  const { service } = makeService(() =>
    viewerBoardPage({
      number: 7,
      totalCount: 1,
      items: [
        {
          id: "i1",
          content: { title: "样式卡" },
          fieldValues: {
            nodes: [
              { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "o1", field: { name: "Status" } },
              {
                __typename: "ProjectV2ItemFieldUserValue",
                field: { name: "Assignees" },
                users: { nodes: [{ login: "octocat", avatarUrl: "https://avatars.example/u/octocat?size=40" }, { login: "nobody" }] },
              },
              { __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { nodes: [{ name: "P1", color: "ff8800" }] } },
            ],
          },
        },
      ],
    }),
  );
  const result = await service.getBoard({ projectNumber: 7 });
  const cardItem = result.board.columns[0].items[0];
  assert.deepEqual(cardItem.assignees, ["octocat", "nobody"], "既有 assignees(login 数组)不动");
  assert.deepEqual(
    cardItem.assigneeDetails,
    [
      { login: "octocat", avatarUrl: "https://avatars.example/u/octocat?size=40" },
      { login: "nobody", avatarUrl: null },
    ],
    "新增 assigneeDetails:与 assignees 同序,avatarUrl 缺失补 null(形状稳定)",
  );
  assert.deepEqual(cardItem.labels, [{ name: "P1", color: "ff8800" }], "labels color(不带 # 的 6 位 hex)随节点透传");
});

test("S3.2 载荷扩展查询契约:看板查询带 options color 与 avatarUrl(size: 40),两入口一致", () => {
  const q = host.graphqlQueries;
  for (const key of ["boardPage", "repoBoardPage"]) {
    assert.ok(q[key].includes("options { id name color }"), `${key}:Status 选项带 color(ProjectV2FieldOptionColor 枚举)`);
    assert.ok(q[key].includes("avatarUrl(size: 40)"), `${key}:assignees 节点带 40px 头像`);
    assert.ok(q[key].includes("fieldValues(first: 30)"), `${key}:fieldValues 在 item 级查询(与 content 三路片段正交,一处补齐即 issues/PRs/drafts 三路同享)`);
  }
});

// ── 0.9.0 写回 mutation moveCard(读 + 状态写回;先读后写,写不缓存不去重) ──────

const isMutation = (body) => String(body.query).trimStart().startsWith("mutation");
/** moveCard 替身的成功 mutation 响应(与 MUTATION_MOVE_CARD 选择集同形)。 */
const mutationOk = () => ({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "i1" } } } });
/** moveCard 读阶段的看板页(带 Status 字段)。 */
const moveCardBoardPage = () => viewerBoardPage({ number: 7, statusOptions: [{ id: "o1", name: "Todo", color: "GRAY" }], totalCount: 0 });

test("S3.2 moveCard 成功:mutation 文档 + 变量五元组 + Authorization 用入口快照凭据,返回 {ok:true}", async () => {
  const { service, calls } = makeService((body) => (isMutation(body) ? mutationOk() : moveCardBoardPage()));
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.deepEqual(result, { ok: true });
  assert.ok(!("value" in result), "成功信封无 value 键(网关拆包 raw.ok===true && \"value\" in raw ? raw.value : raw 原样透传)");
  assert.equal(calls.length, 2, "先读(同键缓存解析 projectNodeId/statusFieldId)后写");
  const doc = String(calls[1].body.query);
  assert.ok(doc.includes("updateProjectV2ItemFieldValue(input: $input)"), "写回走 updateProjectV2ItemFieldValue");
  assert.ok(doc.includes("UpdateProjectV2ItemFieldValueInput!"), "input 变量类型");
  assert.ok(doc.includes("projectV2Item { id }"), "选择集");
  assert.deepEqual(
    calls[1].body.variables,
    { input: { projectId: "pv-7", itemId: "i1", fieldId: "f_status", value: { singleSelectOptionId: "o1" } } },
    "变量五元组:projectId/itemId/fieldId/value.singleSelectOptionId,全部与看板载荷同源",
  );
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`, "Authorization 用凭据快照(R3host/P1 同刻语义)");
});

test("S3.2 moveCard 凭据同刻:在途窗口内轮换 token,mutation 仍按入口快照凭据发出", async () => {
  const tokenA = "r3-move-token-A";
  const tokenB = "r3-move-token-B";
  const env = { GITHUB_TOKEN: tokenA };
  const seenAuth = [];
  const service = new host.GithubKanbanService({
    env,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isMutation(body)) {
        seenAuth.push(init.headers.Authorization);
        return { ok: true, status: 200, json: async () => mutationOk() };
      }
      env.GITHUB_TOKEN = tokenB; // 读链路在途窗口内轮换身份(与 R3host-P1 同窗口)
      return { ok: true, status: 200, json: async () => viewerBoardPage({ number: 7, totalCount: 0 }) };
    },
  });
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, true);
  assert.deepEqual(seenAuth, [`Bearer ${tokenA}`], "mutation 按方法入口捕获的快照凭据发出(若执行时读 env 会拿到轮换后的 B)");
  assert.ok(!JSON.stringify(result).includes(tokenB));
});

test("S3.2 moveCard 错误映射:HTTP 403 → forbidden(transient:false),消息脱敏不含 token", async () => {
  const secret = "ghp_move_forbidden_secret";
  const service = new host.GithubKanbanService({
    env: { GITHUB_TOKEN: secret },
    fetchImpl: fetchResponding(async (body) => (isMutation(body) ? { status: 403 } : moveCardBoardPage())),
  });
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "forbidden");
  assert.equal(result.error.transient, false, "无写权限是非瞬态(README 排障表:检查 PAT scope)");
  assert.ok(result.error.message.includes("403"));
  assert.ok(!JSON.stringify(result).includes(secret), "错误消息脱敏不含凭据");
});

test("S3.2 moveCard 错误映射:GraphQL FORBIDDEN 文本同样 → forbidden(transient:false)", async () => {
  const { service } = makeService((body) =>
    isMutation(body) ? { errors: [{ message: "FORBIDDEN: Resource not accessible by integration" }] } : moveCardBoardPage(),
  );
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.error.code, "forbidden");
  assert.equal(result.error.transient, false);
});

test("S3.2 moveCard 错误映射:422/无法校验按 GraphQL 文本判别 option_missing/item_missing,判不准统一 write_failed(均非瞬态)", async () => {
  const cases = [
    { response: { errors: [{ message: "Could not find the specified option on the field" }] }, code: "option_missing" },
    { response: { errors: [{ message: "Project item could not be found" }] }, code: "item_missing" },
    { response: { errors: [{ message: "validation exploded inexplicably" }] }, code: "write_failed" },
    { response: { status: 422 }, code: "write_failed", note: "HTTP 422 无 errors 文本可判 → write_failed" },
  ];
  for (const { response, code, note } of cases) {
    const { service } = makeService((body) => (isMutation(body) ? response : moveCardBoardPage()));
    const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
    assert.equal(result.ok, false, note ?? JSON.stringify(response));
    assert.equal(result.error.code, code, note ?? JSON.stringify(response));
    assert.equal(result.error.transient, false, "写回失败均非瞬态,恢复靠重拖/刷新");
  }
});

test("S3.2 moveCard:not_supported —— 项目无 Status 字段(statusFieldId=null),不发 mutation", async () => {
  const { service, calls } = makeService(() => viewerBoardPage({ number: 7, statusOptions: null, totalCount: 0 }));
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not_supported");
  assert.equal(result.error.transient, false);
  assert.equal(calls.length, 1, "只读一次看板,mutation 不发");
});

test("S3.2 moveCard:形状非法 → bad_request(非瞬态),零网络请求", async () => {
  const { service, calls } = makeService(() => moveCardBoardPage());
  const badRequests = [
    undefined,
    { itemId: "i1", optionId: "o1" }, // 缺 projectNumber
    { projectNumber: 0, itemId: "i1", optionId: "o1" }, // 非正整数
    { projectNumber: 1.5, itemId: "i1", optionId: "o1" },
    { projectNumber: 7, optionId: "o1" }, // 缺 itemId
    { projectNumber: 7, itemId: "", optionId: "o1" }, // 空串
    { projectNumber: 7, itemId: 42, optionId: "o1" }, // 类型不对
    { projectNumber: 7, itemId: "i1" }, // 缺 optionId
    { projectNumber: 7, itemId: "i1", optionId: 42 },
    { projectNumber: 7, itemId: "i1", optionId: "o1", repo: "no-slash" }, // repo 格式
  ];
  for (const request of badRequests) {
    const result = await service.moveCard(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "bad_request", JSON.stringify(request));
    assert.equal(result.error.transient, false, JSON.stringify(request));
  }
  assert.equal(calls.length, 0, "形状校验在前,零网络请求");
});

test("S3.2 moveCard:mutation 超时 → timeout(transient:true)", async () => {
  const service = new host.GithubKanbanService({
    env: ENV,
    requestTimeoutMs: 25,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isMutation(body)) return new Promise(() => {}); // 写回悬挂:期限内放弃
      return { ok: true, status: 200, json: async () => moveCardBoardPage() };
    },
  });
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.equal(result.error.transient, true, "超时瞬态:卡片已回滚,重拖或刷新");
});

test("S3.2 moveCard:token 缺失 → token_missing,不打网络", async () => {
  const { service, calls } = makeService(() => moveCardBoardPage(), { env: {} });
  const result = await service.moveCard({ projectNumber: 7, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "token_missing");
  assert.equal(calls.length, 0);
});

test("S3.2 moveCard:读链路失败原样透传(project_not_found),不发明新码、不加 transient", async () => {
  const { service } = makeService(() => ({ data: { viewer: { projectV2: null } } }));
  const result = await service.moveCard({ projectNumber: 404, itemId: "i1", optionId: "o1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "project_not_found");
  assert.equal(result.error.transient, undefined);
});

test("S3.2 moveCard wire 契约:原型标记含 moveCard(direct),方法签名恰为 1 个简单标识符参数 request", () => {
  const service = new host.GithubKanbanService({ env: ENV });
  const marker = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "@deepseek-ai/dsh-typert-protocol/remote-methods")?.value;
  assert.equal(marker.version, 1);
  assert.deepEqual(
    marker.methods.find((entry) => entry.method === "moveCard"),
    { method: "moveCard", invocation: { kind: "direct" } },
    "与 protocol mark() 产出逐字段一致(键序/冻结,见 §5 契约 1)",
  );
  const source = Object.getPrototypeOf(service).moveCard.toString();
  const params = source.slice(source.indexOf("(") + 1, source.indexOf(")")).trim();
  assert.equal(params, "request", "参数数量契约(二轮 P1):恰 1 个简单标识符形参,不用默认参数/rest,wire 字段名 = request");
});

// ── 超时与取消 ──────────────────────────────────────────────────────────────

test("S3.2 超时:悬挂 fetch 在期限内退出为 timeout,底层收到 abort,迟到响应被忽略", async () => {
  let release;
  const signals = [];
  const hanging = new host.GithubKanbanService({
    env: ENV,
    requestTimeoutMs: 25,
    fetchImpl: (_url, init) => {
      signals.push(init.signal);
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => viewerProjectsPage([projectNode({ id: "late", number: 1, title: "迟到" })]) });
      });
    },
  });
  const result = await hanging.listProjects();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.ok(signals[0] instanceof AbortSignal && signals[0].aborted === true, "底层被 abort");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await hanging.listProjects()).error.code, "timeout", "迟到响应不写缓存,后续仍是干净的超时语义");
});

test("S3.2 超时:响应体悬挂同样有界(错误信息区分阶段)", async () => {
  const service = new host.GithubKanbanService({
    env: ENV,
    requestTimeoutMs: 25,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  });
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.ok(result.error.message.includes("响应体读取"), "点名响应体阶段");
});

test("S3.2 取消与恢复:超时 settle 后 in-flight 出队,再次调用发起新请求", async () => {
  let fetchCount = 0;
  const service = new host.GithubKanbanService({
    env: ENV,
    requestTimeoutMs: 25,
    fetchImpl: () => {
      fetchCount += 1;
      return new Promise(() => {});
    },
  });
  const first = await service.listProjects();
  assert.equal(first.error.code, "timeout");
  assert.equal(service.cache.inflight.size, 0, "条目不残留");
  const second = await service.listProjects();
  assert.equal(second.error.code, "timeout");
  assert.equal(fetchCount, 2, "新请求不复用悬挂 Promise");
});

test("S3.2 网络错误:fetch 抛错折叠为 network_error 且脱敏", async () => {
  const secret = "ghp_net_secret_value";
  const service = new host.GithubKanbanService({
    env: { GITHUB_TOKEN: secret },
    fetchImpl: async () => {
      throw new Error(`network down ${secret}`);
    },
  });
  const result = await service.getBoard({ projectNumber: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network_error");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("S3.2 token 只进 Authorization 头:查询串、body、URL 均不含凭据", async () => {
  const secret = "ghp_purity_secret";
  let seen;
  const service = new host.GithubKanbanService({
    env: { GITHUB_TOKEN: secret },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => viewerProjectsPage([]) };
    },
  });
  await service.listProjects();
  assert.equal(seen.init.headers.Authorization, `Bearer ${secret}`);
  assert.ok(!seen.init.body.includes(secret));
  assert.ok(!String(seen.init.headers["User-Agent"]).includes(secret));
  assert.equal(seen.url, "https://api.github.com/graphql");
});
