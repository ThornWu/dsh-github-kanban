/**
 * 共享夹具(阶段 3 测试体系):GraphQL 响应构造器、业务结果形状、网关信封。
 *
 * 口径沿用 phase2 交接:样例数据全部中性化(octocat/*),不出现个人仓库/登录名;
 * 形状与宿主 lib/index.js 的输出/输入逐字段同形(mapBoard 投影、pageAll 的
 * connection 视图),smoke 的既有夹具是同源参照。
 */

// ── 网关信封(dsh 0.2.0-rc.2 direct 调用返回形状,rc.2 实测 + 源码核验,见 lib/client.js 注释) ──

/** 网关成功信封:业务结果原样进 value。 */
export const gatewayOk = (result) => ({ ok: true, value: result });
/** 网关失败信封:载波/调用层失败(业务失败不走这层,业务自身就是 {ok:false,error})。 */
export const gatewayFail = (code, message) => ({ ok: false, error: { code, message } });

// ── 参数数量闸(R2/P1:镜像 dsh-api-gateway 客户端 prepareInvocation 的精确数量判定) ──
// 源码核验(2026-10-03,@deepseek-ai/dsh 0.2.0-rc.2):网关客户端把「清单形参数量」与
// 实参数量做**精确相等**比对,数量不符直接抛
//   "client api: githubKanban/listProjects expected 1 argument(s), got 0"
// (dsh-api-gateway/lib/client.js prepareInvocation);宿主侧 methodParameterNames 又只认
// 简单标识符参数(默认参数/rest 会让 SRC 签名无效),wire 上不存在「可选参数」的数量
// 宽容。面替身必须与真网关同严 —— client 侧一旦回退到 0 实参调用,替身先红(防漂移闸)。

/** 从已挂载的 remote 清单推「方法 → 声明参数量」(与网关客户端计数口径同源)。 */
export const manifestArities = (contribution) => {
  const arities = {};
  for (const descriptor of contribution?.descriptors ?? []) arities[descriptor.method] = descriptor.parameters.length;
  return arities;
};

/**
 * 给面替身包一层参数数量断言(与真网关同严):声明 N 参的方法被调用时实参数量必须
 * 恰为 N,否则抛与网关同文案的错。查找走原 face 的现值(挂载后替换方法同样受闸)。
 * @param face 远程面替身(方法返回网关信封;缺席方法保持缺席 → remote_missing 路径不变)
 * @param {Object<string, number>} arities manifestArities() 的产出
 */
export const strictArgumentFace = (face, arities) => {
  const wrapped = {};
  for (const method of Object.keys(face ?? {})) {
    const expected = arities?.[method];
    if (typeof face[method] !== "function" || !Number.isInteger(expected)) {
      wrapped[method] = face[method]; // 非方法键原样透传(缺席方法 → remote_missing 路径不变)
      continue;
    }
    wrapped[method] = (...args) => {
      if (args.length !== expected) {
        throw new Error(`client api: githubKanban/${method} expected ${expected} argument(s), got ${args.length}`);
      }
      return face[method](...args);
    };
  }
  return wrapped;
};

// ── fetch 替身构造器(S3.2/S3.3 服务与缓存测试;不真实联网) ──

/** 把 handler(body, url, init) 的返回包成 fetch Response 形状。 */
export const fetchResponding = (handler) => async (url, init) => {
  const outcome = await handler(JSON.parse(init.body), url, init);
  if (outcome instanceof Error) throw outcome;
  if (outcome.__raw === true) return outcome.response;
  const { data, errors, status = 200 } = outcome;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (errors === undefined ? { data } : { errors }),
  };
};

// ── GraphQL 页构造器 ──

export const viewerProjectsPage = (nodes, { hasNextPage = false, endCursor } = {}) => ({
  data: { viewer: { projectsV2: { nodes, pageInfo: { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) } } } },
});

export const repoProjectsPage = (repoLabel, nodes, { hasNextPage = false, endCursor } = {}) => ({
  data: { repository: { nameWithOwner: repoLabel, projectsV2: { nodes, pageInfo: { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) } } } },
});

export const projectNode = ({ id, number, title, updatedAt = "2026-09-30T00:00:00Z", closed = false, repo }) => ({
  id,
  number,
  title,
  updatedAt,
  closed,
  ...(repo === undefined ? {} : { repo }),
});

/** 单页看板(viewer 路径)。items/fields 形状与 QUERY_BOARD_PAGE 选择集一致。 */
export const viewerBoardPage = ({ number = 7, title = "Alpha", statusOptions = [{ id: "o1", name: "Todo" }], items = [], totalCount, hasNextPage = false, endCursor } = {}) => ({
  data: {
    viewer: {
      projectV2: {
        id: `pv-${number}`,
        number,
        title,
        fields: { nodes: statusOptions === null ? [] : [{ id: "f_status", name: "Status", options: statusOptions }] },
        items: {
          ...(totalCount === undefined ? {} : { totalCount }),
          pageInfo: { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) },
          nodes: items,
        },
      },
    },
  },
});

export const repoBoardPage = ({ owner = "octocat", name = "hello-world", number = 3, title = "Repo Board", items = [], totalCount, hasNextPage = false }) => ({
  data: {
    repository: {
      nameWithOwner: `${owner}/${name}`,
      projectV2: {
        id: `pv-${owner}-${name}-${number}`,
        number,
        title,
        fields: { nodes: [{ id: "f_status", name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
        items: { ...(totalCount === undefined ? {} : { totalCount }), pageInfo: { hasNextPage }, nodes: items },
      },
    },
  },
});

/** 看板 item 节点(与 fieldValues 嵌套选择集一致)。 */
export const boardItemNode = ({ id, title, optionId, assignees = [], labels = [], url, contentMissing = false, truncated = {} } = {}) => ({
  id,
  content: contentMissing ? null : { title, ...(url === undefined ? {} : { url }) },
  fieldValues: {
    ...(truncated.fieldValues === true ? { pageInfo: { hasNextPage: true } } : {}),
    nodes: [
      ...(optionId === undefined ? {} : [optionId === null ? {} : { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId, field: { name: "Status" } }]),
      ...(assignees.length > 0
        ? [{ __typename: "ProjectV2ItemFieldUserValue", field: { name: "Assignees" }, users: { pageInfo: {}, nodes: assignees.map((login) => ({ login })) } }]
        : []),
      ...(labels.length > 0
        ? [{ __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { pageInfo: {}, nodes: labels.map((label) => (typeof label === "string" ? { name: label } : label)) } }]
        : []),
    ].filter((value) => Object.keys(value).length > 0),
  },
});

// ── 业务结果(mapBoard 投影同形;S3.4/S3.5 面板与契约测试用) ──

export const statusResult = ({ tokenConfigured = true, repos = 0 } = {}) => ({ ok: true, status: { tokenConfigured, repos, version: "test" } });

export const projectsResult = (projects, warnings = []) => ({ ok: true, projects, ...(warnings.length > 0 ? { warnings } : {}) });

/** mapBoard 输出形状的看板(列/卡)。 */
export const boardResult = ({ number = 7, title = "Alpha", hasStatusField = true, columns, totalCount, fetchedCount, incomplete } = {}) => ({
  ok: true,
  board: { project: { id: `pv-${number}`, number, title }, hasStatusField, columns },
  ...(totalCount === undefined ? {} : { totalCount }),
  ...(fetchedCount === undefined ? {} : { fetchedCount }),
  ...(incomplete === undefined ? {} : { incomplete }),
});

export const card = ({ id, title = "卡", assignees = [], labels = [], url, optionId = "o1", untitled } = {}) => ({
  id,
  title,
  ...(untitled === true || title === "" ? { untitled: true } : {}),
  ...(url === undefined ? {} : { url }),
  assignees,
  labels,
  statusOptionId: optionId,
});

export const column = ({ name = "Todo", optionId = "o1", items = [], fallback } = {}) => ({
  optionId: optionId ?? null,
  name,
  ...(fallback === undefined ? {} : { fallback }),
  items,
});

/** 两项目 + 各一块看板的常见场景(切换/路由类用例的基础)。 */
export const twoProjectWorld = () => {
  const alphaBoard = boardResult({
    number: 7,
    title: "Alpha",
    columns: [column({ name: "AlphaColumn", optionId: "o1", items: [card({ id: "a1", title: "Alpha 的卡", assignees: ["octocat"], labels: [{ name: "P1", color: "ff8800" }] })] })],
    totalCount: 1,
  });
  const betaBoard = boardResult({
    number: 9,
    title: "Beta",
    columns: [column({ name: "BetaColumn", optionId: "o1", items: [card({ id: "b1", title: "Beta 的卡" })] })],
    totalCount: 1,
  });
  return {
    projects: projectsResult([
      { id: "pv-7", number: 7, title: "Alpha" },
      { id: "pv-9", number: 9, title: "Beta" },
    ]),
    boards: { 7: alphaBoard, 9: betaBoard },
  };
};
