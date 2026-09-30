/**
 * dsh-github-kanban · 宿主半边 —— Phase 1.2「GitHub 读链路」。
 *
 * 职责:
 *   1. GraphQL 客户端(零新增依赖,全局 fetch)读 GitHub Projects v2;
 *   2. 字段映射:Status 单选选项序 → 看板列序(纯函数,自检可测);
 *   3. Remote 面暴露:浏览器经 ctx.remote.githubKanban 调 status/listProjects/getBoard。
 *
 * 隐私红线(执行守则 2):
 *   - token 只从环境变量 GITHUB_TOKEN 读,永不进 git/日志/返回给浏览器的数据;
 *   - token 缺失不抛错堆栈:服务在 status() 里报「未配置」,方法返回结构化错误。
 *
 * Remote 路线(实测决策,详见 notes/dev-notes.md 差异 9):
 *   - @deepseek-ai/dsh-typert-generator 能从 npm 装到,但它是 monorepo 的 TypeScript
 *     工程分析器(tsconfig.host.json / FaceModel / zod 工件),本包是纯 JS 零构建,
 *   - 故走宿主 SRC 回退:服务实例带 typertRemote 绑定 + 原型 Remote 标记(v1 wire 契约,
 *     与 @deepseek-ai/dsh-typert-protocol 逐字段一致,gateway 据此生成 src-json 描述符);
 *   - 浏览器半边用 ctx.remote.$mount() 挂手写 strict 编解码清单(客户端只校验 mode,
 *     不调用 create()),两侧零新增依赖。
 */

/** 宿主服务键;浏览器侧即 ctx.remote.githubKanban。 */
const SERVICE_KEY = "githubKanban";
/** 宿主半边身份(与 package.json 的 name 一致)。 */
const PACKAGE_ID = "@local/thorn-github-kanban";
/** 版本,与 package.json 同步维护。 */
const VERSION = "0.3.2";

/** token 的唯一来源环境变量(命名以用户 2026-09-29 的纠正为准)。 */
const TOKEN_ENV = "GITHUB_TOKEN";
/** GraphQL API 端点。 */
const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
/** 单页 items 上限;服务端分页循环拉到最多这个总数。 */
const MAX_ITEMS = 200;
/** 项目列表分页上限(与 items 分页同型:防异常响应导致无界循环)。 */
const MAX_PROJECTS = 300;
/** 看板列字段名(Projects v2 默认 Status 单选)。 */
const STATUS_FIELD_NAME = "Status";

/** cordis 插件名(loader 行 id 与之配套)。 */
const name = "thorn-github-kanban";

/**
 * 宿主 inject 为空:轮询在**浏览器半边**(Phase 1.3 实测决策,见 notes/dev-notes.md 差异 10)——
 * 看板数据链路是浏览器经 remote 面发起的拉取,宿主无从得知当前选中项目;
 * 浏览器侧 client runner 自带同 API 的 timer Service,插件声明 inject: ["timer"] 即可用,零新增依赖。
 */
const inject = [];

// ─────────────────────────── 1. 宿主装载适配层 ───────────────────────────

/**
 * 宿主装载适配层(执行守则 3:dsh 是 rc,装载契约可能 breaking)。
 * 全插件只有这里接触 cordis 的宿主契约;dsh 升级时只改这一段。
 * @param ctx 宿主 Context
 */
function createHostAdapter(ctx) {
  if (typeof ctx?.provide !== "function") {
    throw new Error(
      `[${PACKAGE_ID}] 宿主装载契约不匹配:ctx.provide 不可用。` +
        "本插件按 cordis 4.x(Service 的 provide/set 分离)编写;" +
        "dsh 升级后请对照官方包源码更新 lib/index.js 的适配层。",
    );
  }
  return {
    /** 注册宿主服务(key 即浏览器侧 ctx.remote 的名字空间)。 */
    publishService(key, value) {
      ctx.provide(key, value);
      return key;
    },
    /** 结构化日志;ctx.logger 缺失时静默降级。绝不接受含凭据的内容。 */
    log(level, message) {
      const logger = ctx.logger;
      if (logger !== undefined && typeof logger[level] === "function") {
        logger[level](`[${PACKAGE_ID}] ${message}`);
      }
    },
  };
}

// ─────────────────────────── 2. GraphQL 客户端(纯函数,零依赖) ───────────────────────────

/** 结构化失败:永远不含 token,面向浏览器可安全展示。 */
function boardError(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * 读 token:唯一入口。缺失返回 null,由调用方决定如何呈现。
 * 任何日志/错误路径都不得引用返回值。
 */
function readToken(env = process.env) {
  const value = env?.[TOKEN_ENV];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 把底层错误折叠成不泄密的结构化失败(token 即便出现在 message 里也替换掉)。
 * 顺序:先截断、再脱敏(split/join 是全量替换,单遍即净);若截断把 token 切成两半,
 * 结尾残留的 token 前缀也一并抹掉,红线面上不留缝。
 */
function sanitizeError(error, env = process.env) {
  const token = readToken(env);
  let message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const redact = (text) => (token !== null && text.includes(token) ? text.split(token).join("[redacted]") : text);
  if (message.length > 300) {
    message = message.slice(0, 300);
    if (token !== null) {
      const max = Math.min(token.length - 1, message.length);
      for (let len = max; len >= 4; len -= 1) {
        if (message.endsWith(token.slice(0, len))) {
          message = `${message.slice(0, message.length - len)}[redacted]`;
          break;
        }
      }
    }
    message = `${message}…`;
  }
  return redact(message);
}

/**
 * 执行一次 GraphQL 请求。查询串是静态字面量;token 只进 Authorization 头。
 * @param query GraphQL 查询字面量
 * @param variables 变量(均为数字/字符串,不含凭据)
 * @param deps 可注入 { fetchImpl, env } 供自检替换
 */
async function ghGraphQL(query, variables = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const token = readToken(deps.env);
  if (token === null) return boardError("token_missing", `环境变量 ${TOKEN_ENV} 未配置,无法读取 GitHub。`);
  if (typeof fetchImpl !== "function") return boardError("env_error", "运行环境没有可用的 fetch。");
  let response;
  try {
    response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": `${PACKAGE_ID} v${VERSION}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    return boardError("network_error", sanitizeError(cause, deps.env));
  }
  if (!response.ok) return boardError("http_error", `GitHub API HTTP ${response.status}。`);
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    return boardError("http_error", sanitizeError(cause, deps.env));
  }
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return boardError("graphql_error", sanitizeError(payload.errors.map((e) => String(e?.message ?? "unknown")).join("; "), deps.env));
  }
  return { ok: true, data: payload?.data };
}

/** 查询:viewer 名下的 Projects v2 列表(供项目切换器,分页拉全)。 */
const QUERY_PROJECTS = `query($after: String) {
  viewer {
    projectsV2(first: 30, after: $after, includeArchived: false) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title updatedAt }
    }
  }
}`;

/** 查询:单项目的字段定义(Status 单选选项序)+ items 分页一页。 */
const QUERY_BOARD_PAGE = `query($number: Int!, $after: String) {
  viewer {
    projectV2(number: $number) {
      id
      number
      title
      fields(first: 40) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        totalCount
        nodes {
          id
          content {
            __typename
            ... on DraftIssue { title }
            ... on Issue { title number url state }
            ... on PullRequest { title number url state }
          }
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldUserValue { field { ... on ProjectV2FieldCommon { name } } users(first: 10) { nodes { login } } }
              ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { name } } labels(first: 20) { nodes { name color } } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * 拉项目列表。返回 { ok, projects } 或结构化错误。
 */
async function listProjectsImpl(deps = {}) {
  // 分页循环(与 getBoard 的 items 分页同型):按 pageInfo 翻页拉全,上限 MAX_PROJECTS 兜底。
  const nodes = [];
  let after;
  for (let page = 0; page < Math.ceil(MAX_PROJECTS / 30); page += 1) {
    const result = await ghGraphQL(QUERY_PROJECTS, { after }, deps);
    if (!result.ok) return result;
    const connection = result.data?.viewer?.projectsV2;
    const pageNodes = connection?.nodes;
    if (!Array.isArray(pageNodes)) return boardError("shape_error", "GitHub 返回了意外的项目列表结构。");
    nodes.push(...pageNodes);
    if (connection?.pageInfo?.hasNextPage !== true || typeof connection?.pageInfo?.endCursor !== "string") break;
    after = connection.pageInfo.endCursor;
  }
  return {
    ok: true,
    projects: nodes.map((node) => ({
      id: String(node.id ?? ""),
      number: Number(node.number ?? 0),
      title: String(node.title ?? "(未命名项目)"),
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : undefined,
    })).sort((a, b) => a.updatedAt === b.updatedAt ? a.number - b.number : String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))),
  };
}

/**
 * 拉一个项目的整块看板数据:字段定义 + items(分页循环,上限 MAX_ITEMS)。
 */
async function getBoardImpl(request, deps = {}) {
  const number = Number(request?.projectNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return boardError("input_invalid", "projectNumber 必须是正整数。");
  }
  const items = [];
  let after;
  let projectMeta;
  let fieldsNodes;
  let serverTotal;
  for (let page = 0; page < Math.ceil(MAX_ITEMS / 50); page += 1) {
    const result = await ghGraphQL(QUERY_BOARD_PAGE, { number, after }, deps);
    if (!result.ok) return result;
    const project = result.data?.viewer?.projectV2;
    if (project === undefined || project === null) return boardError("project_not_found", `找不到编号为 ${number} 的项目(或无权访问)。`);
    if (projectMeta === undefined) {
      fieldsNodes = project.fields?.nodes;
      projectMeta = {
        id: String(project.id ?? ""),
        number: Number(project.number ?? number),
        title: String(project.title ?? "(未命名项目)"),
        statusField: extractStatusField(project.fields?.nodes),
      };
    }
    const connection = project.items;
    if (serverTotal === undefined) {
      const reported = Number(connection?.totalCount);
      if (Number.isInteger(reported) && reported >= 0) serverTotal = reported;
    }
    for (const node of Array.isArray(connection?.nodes) ? connection.nodes : []) {
      if (items.length < MAX_ITEMS) items.push(node);
    }
    if (connection?.pageInfo?.hasNextPage === true && typeof connection.pageInfo.endCursor === "string") {
      after = connection.pageInfo.endCursor;
    } else {
      break;
    }
  }
  const board = mapBoard({
    project: projectMeta,
    itemNodes: items,
  });
  if (!board.ok) return board;
  // Status 缺失时的原因推断:给 UI 明确提示,而不是无声退化成单列「全部」。
  board.board.statusFieldHint = statusFieldHint(fieldsNodes, projectMeta?.statusField !== null && projectMeta?.statusField !== undefined);
  // totalCount 口径:优先 GitHub 报告的 items.totalCount(全量);拉不到时退回实际拉取数。
  return {
    ok: true,
    board: board.board,
    totalCount: Number.isInteger(serverTotal) ? serverTotal : items.length,
    fetchedCount: items.length,
  };
}

/** 从字段定义里取 Status 单选字段(找不到给 null,看板退化为单列)。 */
function extractStatusField(fieldNodes) {
  const fields = Array.isArray(fieldNodes) ? fieldNodes : [];
  const field = fields.find(
    (candidate) => candidate?.name === STATUS_FIELD_NAME && Array.isArray(candidate?.options),
  );
  if (field === undefined) return null;
  return {
    id: String(field.id ?? ""),
    name: String(field.name),
    options: field.options
      .filter((option) => option !== null && typeof option === "object")
      .map((option) => ({ id: String(option.id ?? ""), name: String(option.name ?? "") })),
  };
}

/**
 * Status 字段缺失时的原因推断(纯函数,供 UI 给出明确提示,替代无声退化):
 *   - "fields_truncated":fields 拉满单页上限(40),Status 可能在未加载的字段里;
 *   - "possibly_renamed":没有 Status,但存在其他单选字段,疑似被改名;
 *   - "not_found":没有任何单选字段迹象。
 * 只影响提示文案,不改变看板退化为单列「全部」的行为本身。
 */
function statusFieldHint(fieldNodes, statusFieldFound) {
  if (statusFieldFound === true) return null;
  const fields = (Array.isArray(fieldNodes) ? fieldNodes : []).filter((candidate) => candidate !== null && typeof candidate === "object");
  if (fields.length >= 40) return "fields_truncated";
  if (fields.some((candidate) => candidate.name !== STATUS_FIELD_NAME && Array.isArray(candidate.options))) return "possibly_renamed";
  return "not_found";
}

// ─────────────────────────── 3. 字段映射(纯函数) ───────────────────────────

/** 一张空卡片的形状。 */
function emptyItem(id) {
  return { id, title: "(无标题)", url: undefined, assignees: [], labels: [], statusOptionId: null };
}

/**
 * 把 GraphQL items 投影成看板:列序 = Status 选项序,空列保留。
 * 刻意做成纯函数:输入节点形状同 QUERY_BOARD_PAGE,自检直接喂样例。
 * 逐项防御(R4 遗留 P2):project 缺字段、statusField 畸形、itemNodes 混入非对象项、
 * fieldValues 里混入坏值 —— 坏项跳过或落兜底列,不抛不崩。
 */
function mapBoard({ project, itemNodes }) {
  const projectMeta = project !== null && typeof project === "object" ? project : {};
  const rawStatusField = projectMeta.statusField;
  const statusField = rawStatusField !== null && typeof rawStatusField === "object" ? rawStatusField : null;
  const optionList = (Array.isArray(statusField?.options) ? statusField.options : []).filter((option) => option !== null && typeof option === "object");
  const columns = optionList.map((option) => ({
    optionId: String(option.id ?? ""),
    name: String(option.name ?? ""),
    items: [],
  }));
  const byOptionId = new Map(columns.map((column) => [column.optionId, column]));
  const fallbackColumn = { optionId: null, name: statusField === null ? "全部" : "未分列", items: [] };
  const nodes = (Array.isArray(itemNodes) ? itemNodes : []).filter((node) => node !== null && typeof node === "object");
  const cards = nodes.map((node) => {
    const item = emptyItem(String(node.id ?? ""));
    const content = node.content;
    if (content !== undefined && content !== null) {
      item.title = String(content.title ?? item.title);
      if (typeof content.url === "string") item.url = content.url;
    }
    for (const value of Array.isArray(node.fieldValues?.nodes) ? node.fieldValues.nodes : []) {
      if (value === null || typeof value !== "object") continue;
      const fieldName = String(value.field?.name ?? "");
      if (value.__typename === "ProjectV2ItemFieldSingleSelectValue" && fieldName === STATUS_FIELD_NAME) {
        item.statusOptionId = value.optionId === undefined || value.optionId === null ? null : String(value.optionId);
      } else if (value.__typename === "ProjectV2ItemFieldUserValue" && fieldName === "Assignees") {
        item.assignees = (Array.isArray(value.users?.nodes) ? value.users.nodes : []).map((user) => String(user?.login ?? "")).filter(Boolean);
      } else if (value.__typename === "ProjectV2ItemFieldLabelValue" && fieldName === "Labels") {
        item.labels = (Array.isArray(value.labels?.nodes) ? value.labels.nodes : []).map((label) => ({ name: String(label?.name ?? ""), color: typeof label?.color === "string" ? label.color : undefined })).filter((label) => label.name !== "");
      }
    }
    return item;
  });

  for (const card of cards) {
    const column = card.statusOptionId !== null ? byOptionId.get(card.statusOptionId) : undefined;
    (column ?? fallbackColumn).items.push(card);
  }
  return {
    ok: true,
    board: {
      project: { id: String(projectMeta.id ?? ""), number: Number(projectMeta.number ?? 0), title: String(projectMeta.title ?? "(未命名项目)") },
      hasStatusField: statusField !== null,
      columns: fallbackColumn.items.length > 0 || statusField === null ? [...columns, fallbackColumn] : columns,
    },
  };
}

// ─────────────────────────── 4. Remote 面(v1 wire 契约,零依赖) ───────────────────────────

/** 与 @deepseek-ai/dsh-typert-protocol 一致的 Remote 标记描述符键(源码常量,wire 契约)。 */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * 在类的原型上登记 Remote 方法标记(与 protocol 的 mark() 逐字段一致)。
 * gateway 的 SRC 回退靠它发现「名字空间.方法 → 原型方法」。
 */
function markRemote(prototype, method, exportName) {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
  const descriptor = property?.value;
  if (descriptor !== undefined) {
    if (descriptor.version !== 1 || !Array.isArray(descriptor.methods)) {
      throw new Error(`[${PACKAGE_ID}] Remote 标记描述符版本不被支持。`);
    }
    if (descriptor.methods.some((marker) => marker.method === method)) return;
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) })]),
    }),
  });
}

/**
 * 看板服务:浏览器侧 ctx.remote.githubKanban 的三个方法都在这里。
 *
 * 契约要点(依据 dsh-api-gateway 源码):
 *   - 实例必须带 typertRemote = { service, serviceKey, namespace }(冻结对象,service 指向实例本身);
 *   - Remote 方法必须是**原型方法**且参数是简单标识符(SRC 用 Function.toString 解析参数名);
 *   - 未注册 strict typert 描述符时走 SRC 回退:参数按 src-json 只做 JSON 安全校验。
 */
class GithubKanbanService {
  /** wire 契约:gateway 源模式发现用的可见绑定。 */
  typertRemote;

  constructor(deps = {}) {
    /** 依赖注入面(fetch/env)仅供自检替换;生产为空对象。 */
    this.deps = deps;
    this.name = SERVICE_KEY;
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
    markRemote(Object.getPrototypeOf(this), "status");
    markRemote(Object.getPrototypeOf(this), "listProjects");
    markRemote(Object.getPrototypeOf(this), "getBoard");
  }

  /** 服务状态:token 是否就绪(只给布尔,不给任何凭据信息)。 */
  async status() {
    return { ok: true, status: { tokenConfigured: readToken(this.deps.env) !== null, version: VERSION } };
  }

  /** viewer 名下的 Projects v2 列表(项目切换器数据源)。 */
  async listProjects() {
    const result = await listProjectsImpl(this.deps);
    return result.ok ? { ok: true, projects: result.projects } : result;
  }

  /** 一个项目的看板投影(列序 = Status 选项序)。 */
  async getBoard(request) {
    return getBoardImpl(request, this.deps);
  }
}

// ─────────────────────────── 5. 插件入口 ───────────────────────────

/**
 * 插件入口。
 * @param ctx 宿主 Context
 * @param config bundle patch 的 config 段
 */
function apply(ctx, config) {
  const host = createHostAdapter(ctx);
  const service = new GithubKanbanService();
  host.publishService(SERVICE_KEY, service);
  host.log(
    "info",
    `宿主服务 ${SERVICE_KEY} 已注册(v${VERSION},远程面 3 方法:` +
      `token ${readToken() === null ? "未配置" : "已配置(不记录任何值)"})`,
  );
  return service;
}

const Config = undefined;

export { Config, GithubKanbanService, apply, extractStatusField, ghGraphQL, inject, mapBoard, name, readToken, statusFieldHint };
