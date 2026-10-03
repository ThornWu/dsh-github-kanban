/**
 * dsh-github-kanban · 宿主半边 —— Phase 1.2「GitHub 读链路」。
 *
 * 职责(对外):
 *   1. GraphQL 客户端(零新增依赖,全局 fetch)读 GitHub Projects v2;
 *   2. 字段映射:Status 单选选项序 → 看板列序(纯函数,自检可测);
 *   3. Remote 面暴露:浏览器经 ctx.remote.githubKanban 调 status/listProjects/getBoard。
 *
 * 职责分层(S2.1,2026-10-03 整改:刻意**不拆文件**,只做内部结构分层 —— 宿主拆文件会
 * 增加 files/exports 维护面而没有消除任何转发;各层之间已经是纯函数调用,无转发层):
 *   §1 dsh 装载适配 —— createHostAdapter(provide/logger):全文件唯一接触 cordis 宿主契约的段落;
 *   §2 GraphQL 请求 —— ghGraphQL/withTimeout/sanitizeError/readToken:超时、脱敏、结构化失败;
 *   §3 查询定义与分页 —— QUERY_*(共享片段拼装)+ pageAll(唯一的翻页循环);
 *   §4 数据组装与纯映射 —— listProjectsImpl(来源合并去重)/getBoardImpl(完整性口径)/
 *      mapBoard/extractStatusField/statusFieldHint(纯函数,喂样例即可自检);
 *   §5 Remote 面 + 缓存 —— wire 契约集中定义 + TTL/LRU/去重(GithubKanbanService);
 *   §6 插件入口 —— apply。
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
 *
 * 可靠性(阶段 1 整改,REMEDIATION_PLAN §4):
 *   - S1.2 每次请求带应用层超时与 abort,响应体读取同样有界;迟到结果被显式吞掉;
 *   - S1.4 项目列表按来源(viewer/各仓)分别收集,局部失败保留成功来源并附警告;
 *   - S1.9 进程内缓存有容量边界(LRU)、token 指纹隔离与单调写入(旧请求不覆盖新数据)。
 */
import { createHash } from "node:crypto";

/** 宿主服务键;浏览器侧即 ctx.remote.githubKanban。 */
const SERVICE_KEY = "githubKanban";
/** 宿主半边身份(与 package.json 的 name 一致)。 */
const PACKAGE_ID = "@local/thorn-github-kanban";
/** 版本:代码内唯一来源(smoke 自检核对与 package.json 一致,S2.9)。 */
const VERSION = "0.8.0";

/** token 的唯一来源环境变量(命名以用户 2026-09-29 的纠正为准)。 */
const TOKEN_ENV = "GITHUB_TOKEN";
/** GraphQL API 端点。 */
const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
/** 单页 items 上限;服务端分页循环拉到最多这个总数。 */
const MAX_ITEMS = 200;
/** 项目列表分页上限(与 items 分页同型:防异常响应导致无界循环)。 */
const MAX_PROJECTS = 300;
/** 项目列表单页条数(与 QUERY_* 的 first: 30 对齐,分页上限按它换算页数)。 */
const PROJECTS_PAGE_SIZE = 30;
/** 看板 items 单页条数(与 QUERY_* 的 first: 50 对齐)。 */
const ITEMS_PAGE_SIZE = 50;
/** 字段定义单页上限(QUERY_* 的 fields first: 40;拉满时给 fields_truncated 提示)。 */
const FIELDS_PAGE_SIZE = 40;
/** 看板列字段名(Projects v2 默认 Status 单选)。 */
const STATUS_FIELD_NAME = "Status";
/**
 * 单次 GitHub 请求(建连+响应体读取分别计时)的应用层超时。
 * 为什么不用底层超时:全局 fetch 的超时行为跨运行时不一致,且注入的 fetchImpl 可能
 * 完全忽略超时参数 —— 应用层 race 是唯一对所有实现都成立的边界(S1.2/R02)。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** 看板缓存的容量边界(S1.9):LRU 按写入序淘汰最旧,防长期切换项目无界增长。 */
const DEFAULT_MAX_BOARDS = 8;

/** cordis 插件名(loader 行 id 与之配套)。 */
const name = "thorn-github-kanban";

/**
 * 宿主 inject 为空:轮询在**浏览器半边**(Phase 1.3 实测决策,见 notes/dev-notes.md 差异 10)——
 * 看板数据链路是浏览器经 remote 面发起的拉取,宿主无从得知当前选中项目;
 * 浏览器侧 client runner 自带同 API 的 timer Service,插件声明 inject: ["timer"] 即可用,零新增依赖。
 */
const inject = [];

// ─────────────────────────── §1. 宿主装载适配层 ───────────────────────────

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

// ─────────────────────────── §2. GraphQL 请求(超时/脱敏/结构化失败) ───────────────────────────

/**
 * 结构化失败信封 —— 宿主所有 Remote 方法的统一错误形状(S2.4 契约):
 *   `{ ok: false, error: { code: string, message: string } }`,message 永不含 token。
 * 错误 code 全集(浏览器侧按 code 分类瞬态/永久,见 lib/client.js isTransientFailure):
 *   token_missing / env_error / timeout / network_error / http_error / graphql_error /
 *   shape_error / input_invalid / project_not_found / all_sources_failed / repo_missing(警告)。
 */
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
 * @param token 实际发出本次请求所用的凭据(R3host:与请求同一刻的快照)—— 错误面里
 *   可能出现的正是它,而不是错误发生那一刻环境里「最新」的 token(轮换后的新值从未
 *   进过这次请求,拿它脱敏反而会漏掉真正要抹的旧值)。
 */
function sanitizeError(error, token) {
  const secret = typeof token === "string" && token.length > 0 ? token : null;
  let message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const redact = (text) => (secret !== null && text.includes(secret) ? text.split(secret).join("[redacted]") : text);
  if (message.length > 300) {
    message = message.slice(0, 300);
    if (secret !== null) {
      const max = Math.min(secret.length - 1, message.length);
      for (let len = max; len >= 4; len -= 1) {
        if (message.endsWith(secret.slice(0, len))) {
          message = `${message.slice(0, message.length - len)}[redacted]`;
          break;
        }
      }
    }
    message = `${message}…`;
  }
  return redact(message);
}

/** token 未配置的结构化失败(ghGraphQL 与 listProjectsImpl 共用同一文案与 code)。 */
function tokenMissingError() {
  return boardError("token_missing", `环境变量 ${TOKEN_ENV} 未配置,无法读取 GitHub。`);
}

/**
 * token 指纹(S1.9 缓存身份隔离):单向散列截断 16 字符,只留在宿主进程内存,
 * 用于比对「缓存写入时的身份」与「当前身份」;不进任何返回值、日志或浏览器。
 * token 轮换后指纹不匹配 → 缓存视为未命中,不吐旧身份数据。
 */
function tokenFingerprint(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * 应用层有界等待(S1.2/R02):先挂底层 Promise 的两个分支、再挂定时器 ——
 * 已就绪的调用不被立即触发的定时器误伤;到期 abort 底层请求并拒绝。
 * 超时错误带 isTimeout 标记,调用方据此给出可读的「超时」而非「网络错误」。
 * 两个分支都被显式消费:迟到的成功/失败不会变成 unhandled rejection。
 */
function withTimeout(promise, ms, controller, phase) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    promise.then(
      (value) => finish(resolve, value),
      (cause) => finish(reject, cause),
    );
    const timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // abort 失败不影响超时语义:迟到分支已被上面的消费点吞掉
      }
      const error = new Error(`GitHub ${phase}超过 ${ms}ms 未完成,已放弃等待`);
      error.isTimeout = true;
      finish(reject, error);
    }, ms);
  });
}

/**
 * 执行一次 GraphQL 请求。查询串是静态字面量;token 只进 Authorization 头。
 * @param query GraphQL 查询字面量
 * @param variables 变量(均为数字/字符串,不含凭据)
 * @param deps 可注入 { fetchImpl, env, requestTimeoutMs } 供自检替换
 * @param token 显式凭据快照(服务层在方法入口与缓存指纹同一刻捕获并逐层传入):
 *   标签必须描述实际使用的凭据 —— 请求凭据与缓存盖章指纹不再分属两个时刻(R3host/P1)。
 *   缺省(undefined)表示调用方未快照,在此刻读 env(直接调用/自检注入面的原行为);
 *   显式 null 表示「快照时就没有 token」,同样早退 token_missing。
 * @returns `{ ok: true, data }` 或结构化失败(见 boardError 的 code 全集)
 */
async function ghGraphQL(query, variables = {}, deps = {}, token) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // 生产兜底(2026-10-01 真机首验教训,dev-notes 差异 11):apply() 建服务是空 deps,
  // deps.env 仅自检注入,缺省必须回退进程环境,否则 token 永远「未配置」。
  const env = deps.env ?? process.env;
  // 凭据快照优先(R3host/P1):有快照用快照 —— 在途窗口内环境轮换不影响本次请求的
  // 身份;无快照维持原行为(此刻读 env)。两条路径殊途于同一个局部量,后续不再读环境。
  const credential = token === undefined ? readToken(env) : token;
  if (credential === null) return tokenMissingError();
  if (typeof fetchImpl !== "function") return boardError("env_error", "运行环境没有可用的 fetch。");
  // 超时可注入(自检用小值);非法配置回退默认 —— 悬挂请求必须有确定期限(S1.2)。
  const timeoutMs = Number.isInteger(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0 ? deps.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  // 有 AbortController 的环境把取消传给底层;没有则只靠 race 放弃等待(迟到结果被吞)。
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let response;
  try {
    response = await withTimeout(
      fetchImpl(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
          "User-Agent": `${PACKAGE_ID} v${VERSION}`,
        },
        body: JSON.stringify({ query, variables }),
        ...(controller === null ? {} : { signal: controller.signal }),
      }),
      timeoutMs,
      controller,
      "请求",
    );
  } catch (cause) {
    if (cause?.isTimeout === true) return boardError("timeout", sanitizeError(cause, credential));
    return boardError("network_error", sanitizeError(cause, credential));
  }
  if (!response.ok) return boardError("http_error", `GitHub API HTTP ${response.status}。`);
  let payload;
  try {
    // 响应体读取同样有界:连接成功但 body 挂住也是悬挂请求(S1.2 验收矩阵「响应体悬挂」)
    payload = await withTimeout(response.json(), timeoutMs, controller, "响应体读取");
  } catch (cause) {
    if (cause?.isTimeout === true) return boardError("timeout", sanitizeError(cause, credential));
    return boardError("http_error", sanitizeError(cause, credential));
  }
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return boardError("graphql_error", sanitizeError(payload.errors.map((e) => String(e?.message ?? "unknown")).join("; "), credential));
  }
  return { ok: true, data: payload?.data };
}

// ─────────────────────────── §3. 查询定义(共享片段拼装)与统一分页 ───────────────────────────

/**
 * 查询定义(S2.7:两套入口共用同一份字段集片段,消除平行维护的重复定义)。
 * viewer 入口与 repository 入口只差最外层的包装,projectV2/projectsV2 的选择集
 * 一律来自下面的片段常量 —— 改字段只改一处,两个入口不可能漂移。
 */

/** 项目列表的节点字段集(viewer 与 repository 入口共用)。 */
const PROJECT_NODE_FIELDS = "id number title updatedAt closed";

/** 查询:viewer 名下的 Projects v2 列表(供项目切换器,分页拉全)。
 *  不带 includeArchived:真机 2026-10-01 实测 GraphQL schema 不接受该参数
 *  (Field 'projectsV2' doesn't accept argument 'includeArchived'),closed 过滤在实现层做。 */
const QUERY_PROJECTS = `query($after: String) {
  viewer {
    projectsV2(first: ${PROJECTS_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PROJECT_NODE_FIELDS} }
    }
  }
}`;

/** 查询:单个仓库名下的 Projects v2 列表(link 到该仓的项目,分页拉全)。 */
const QUERY_REPO_PROJECTS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    projectsV2(first: ${PROJECTS_PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PROJECT_NODE_FIELDS} }
    }
  }
}`;

/**
 * 单项目的看板选择集(字段定义 + items 一页,S2.7 共享片段):viewer 与 repository
 * 两个入口逐字段一致。fieldValues/users/labels 带 pageInfo{hasNextPage}:单页上限
 * 处的截断要能被观测(S2.5「字段值达到分页上限有可解释行为」),不做无声丢弃。
 */
const BOARD_PROJECT_FIELDS = `id
      number
      title
      fields(first: ${FIELDS_PAGE_SIZE}) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
      items(first: ${ITEMS_PAGE_SIZE}, after: $after) {
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
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldUserValue { field { ... on ProjectV2FieldCommon { name } } users(first: 10) { pageInfo { hasNextPage } nodes { login } } }
              ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { name } } labels(first: 20) { pageInfo { hasNextPage } nodes { name color } } }
            }
          }
        }
      }`;

/**
 * 查询:viewer 路径的单项目看板。路由依据(2026-10-01 探针,dev-notes 差异 12):
 * repository.projectV2(number) 能解析 link 到该仓的用户级项目;org 项目只能走仓
 * 路径(number 按 owner 域,viewer.projectV2 查不到)。
 */
const QUERY_BOARD_PAGE = `query($number: Int!, $after: String) {
  viewer {
    projectV2(number: $number) {
      ${BOARD_PROJECT_FIELDS}
    }
  }
}`;

/** 查询:仓库路径的单项目看板(与 QUERY_BOARD_PAGE 同构,入口换 repository)。 */
const QUERY_REPO_BOARD_PAGE = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    projectV2(number: $number) {
      ${BOARD_PROJECT_FIELDS}
    }
  }
}`;

/** 查询文本(自检用:两入口字段集一致性的核对依据,S2.7)。 */
const graphqlQueries = { projects: QUERY_PROJECTS, repoProjects: QUERY_REPO_PROJECTS, boardPage: QUERY_BOARD_PAGE, repoBoardPage: QUERY_REPO_BOARD_PAGE };

/**
 * 解析配置的仓库清单("owner/name" 字符串数组)为 {owner, name} 列表。
 * 非法条目(格式不对/非字符串)跳过 —— 配置面只信形状,单条坏配置不拖垮整板。
 */
function normalizeRepos(repos) {
  return (Array.isArray(repos) ? repos : [])
    .filter((repo) => typeof repo === "string")
    .map((repo) => {
      const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim());
      return match === null ? null : { owner: match[1], name: match[2], label: `${match[1]}/${match[2]}` };
    })
    .filter((repo) => repo !== null);
}

/**
 * 统一分页循环(S2.1「查询分页」职责的唯一实现):按 pageInfo 翻页拉全一个 connection,
 * 上限 maxItems 兜底防异常响应导致无界循环。项目列表与看板 items 共用。
 * @param extract 从每页 data 取视图 `{ connection, parent? }`:
 *   - 返回 null 表示「宿主对象缺席」(配置的仓库不存在/无权限/项目找不到)→ 返回
 *     `{ absent: true }`,由调用方决定语义(列表:跳过+警告;看板:project_not_found);
 *   - connection 缺席或 nodes 非数组 → shape_error(结构畸形不无声退化,S2.4);
 *   - parent 只在首页捕获(看板场景的项目元信息来自首页)。
 * @param limits `{ maxItems, pageSize }`:页数上限 = ceil(maxItems / pageSize)。
 * @param token 凭据快照(由 listProjectsImpl/getBoardImpl 从服务层逐层传入,ghGraphQL
 *   用它发 Authorization;undefined 时 ghGraphQL 回退此刻读 env —— 直接调用原行为)。
 * @returns `{ ok: true, nodes, parent?, firstConnection?, capped }` | `{ ok: true, absent: true }` | 结构化失败。
 *   capped = 翻页到页数上限时服务端仍报有下一页 —— 数据可能不完整的**可观测信号**(S2.5),
 *   由调用方转成提示,不得假称全量。
 */
async function pageAll(query, baseVariables, extract, deps, limits, token) {
  const nodes = [];
  let parent;
  let firstConnection;
  let after;
  for (let page = 0; page < Math.ceil(limits.maxItems / limits.pageSize); page += 1) {
    const result = await ghGraphQL(query, { ...baseVariables, after }, deps, token);
    if (!result.ok) return result;
    const view = extract(result.data);
    if (view === null) return { ok: true, absent: true };
    const connection = view?.connection;
    if (connection === null || connection === undefined || !Array.isArray(connection.nodes)) {
      return boardError("shape_error", "GitHub 返回了意外的数据结构。");
    }
    if (firstConnection === undefined) {
      firstConnection = connection;
      if (view.parent !== undefined) parent = view.parent;
    }
    nodes.push(...connection.nodes);
    if (connection?.pageInfo?.hasNextPage !== true || typeof connection?.pageInfo?.endCursor !== "string") {
      return { ok: true, nodes, parent, firstConnection, capped: false };
    }
    after = connection.pageInfo.endCursor;
  }
  // 走出循环 = 到达页数上限且最后一页仍报有下一页:标记 capped,调用方给不完整提示
  return { ok: true, nodes, parent, firstConnection, capped: true };
}

// ─────────────────────────── §4. 数据组装与纯映射 ───────────────────────────

/**
 * 拉项目列表:viewer 名下(用户级)+ 配置仓库名下(link 到仓的用户/org 项目)合并。
 * 去重(按项目 id):同一项目既在 viewer 列表又 link 到配置仓时,保留**带仓归属**的版本
 * (切换器能显示来源,且 getBoard 走仓路径,org 项目也只有这条路)。同一项目 link 到
 * 多个配置仓时保留**配置序靠后**的仓归属(吸收顺序固定:先 viewer 后配置序,与并行
 * 拉取无关,dev-notes 差异 12)。
 * closed 项目过滤(替代 schema 不接受的 includeArchived)。
 * 并行拉取(0.5.0 提速):viewer 与各仓同时发,合并顺序仍固定。
 *
 * 返回契约(S2.4):
 *   成功 `{ ok: true, projects: Array<{id: string, number: number, title: string,
 *     updatedAt?: string, repo?: string}>, warnings?: Array<{source, code, message}> }`,
 *   按 updatedAt 降序、同更新时间按编号升序;警告 code 见下。
 *   失败:token_missing / all_sources_failed / timeout / ...(单来源失败**不**失败整表)。
 *   警告 code:graphql_error 等单来源错误 / repo_missing(仓库缺席)/
 *     projects_truncated(该来源项目数达分页上限,列表可能不完整,S2.5)。
 *
 * 局部失败语义(S1.4/R03,0.8.0 重设计):viewer 与各仓**分别收集**,单个来源失败
 * 不再拖垮整张列表 —— 成功来源照常返回,失败来源进 warnings(source 级警告);
 * 所有来源都失败才返回明确失败(all_sources_failed),绝不伪装成空列表。
 * token 缺失是全局前置条件而非单来源故障,保持 token_missing 原语义直接返回。
 */
async function listProjectsImpl(deps = {}, token) {
  // 凭据快照(R3host/P1):服务层在方法入口与缓存指纹同一刻捕获并传入;直接调用
  // (自检)未传(undefined)时在此刻读取,维持原行为。token_missing 早退同样按快照
  // 判定 —— 发起时有 token 而在途窗口内被清空,请求按快照发出,不误报缺失。
  const credential = token === undefined ? readToken(deps.env ?? process.env) : token;
  if (credential === null) return tokenMissingError();
  const toEntry = (node, repo) => ({
    id: String(node.id ?? ""),
    number: Number(node.number ?? 0),
    title: String(node.title ?? "(未命名项目)"),
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : undefined,
    ...(repo === undefined ? {} : { repo }),
  });
  const repos = normalizeRepos(deps.repos);
  const [viewer, ...perRepos] = await Promise.all([
    pageAll(QUERY_PROJECTS, {}, (data) => ({ connection: data?.viewer?.projectsV2 }), deps, { maxItems: MAX_PROJECTS, pageSize: PROJECTS_PAGE_SIZE }, credential),
    ...repos.map((repo) =>
      pageAll(
        QUERY_REPO_PROJECTS,
        { owner: repo.owner, name: repo.name },
        (data) => (data?.repository === null || data?.repository === undefined ? null : { connection: data.repository.projectsV2 }),
        deps,
        { maxItems: MAX_PROJECTS, pageSize: PROJECTS_PAGE_SIZE },
        credential,
      ),
    ),
  ]);

  const byId = new Map();
  const warnings = [];
  let okSources = 0;
  const absorb = (result, label, repo) => {
    if (result?.ok !== true) {
      warnings.push({ source: label, code: result?.error?.code ?? "unknown", message: result?.error?.message ?? "" });
      return;
    }
    if (result.absent === true) {
      // 仓库不存在/无权限 = 该来源缺席:跳过但留下可读警告,不静默吞掉配置问题
      warnings.push({ source: label, code: "repo_missing", message: "仓库不存在或无权限访问,已跳过。" });
      return;
    }
    okSources += 1;
    if (result.capped === true) {
      warnings.push({ source: label, code: "projects_truncated", message: `该来源项目数达到分页上限(${MAX_PROJECTS}),列表可能不完整。` });
    }
    for (const node of result.nodes) {
      if (node?.closed === true) continue;
      const entry = toEntry(node, repo);
      byId.set(entry.id, entry); // 同 id 覆盖 viewer 版本 → 保留仓归属
    }
  };
  absorb(viewer, "viewer", undefined);
  for (let index = 0; index < perRepos.length; index += 1) absorb(perRepos[index], repos[index].label, repos[index].label);

  if (okSources === 0) {
    // 全部来源超时属于同一类可自愈故障,聚合回 timeout 让 UI 给出对口的恢复指引
    const codes = new Set(warnings.map((warning) => warning.code));
    if (codes.size === 1 && codes.has("timeout")) {
      return boardError("timeout", "所有项目来源均请求超时,已放弃等待;请检查网络后重试。");
    }
    return boardError(
      "all_sources_failed",
      `所有项目来源均读取失败(${warnings.map((warning) => `${warning.source}[${warning.code}]`).join("、")});列表不可用,请检查网络或 token 权限后重试。`,
    );
  }

  return {
    ok: true,
    projects: [...byId.values()].sort((a, b) =>
      a.updatedAt === b.updatedAt ? a.number - b.number : String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * 数一张卡的字段值连接是否在任何一层达到单页上限(fieldValues/users/labels 的
 * pageInfo.hasNextPage —— 查询已显式请求,S2.5):这类截断只统计、不逐页追拉
 * (追拉需要按 item 嵌套翻页,成本不成比例),交给 UI 提示「可能缺失」。
 */
function countFieldValuesTruncated(itemNodes) {
  let count = 0;
  for (const node of Array.isArray(itemNodes) ? itemNodes : []) {
    const values = node?.fieldValues;
    let truncated = values?.pageInfo?.hasNextPage === true;
    if (truncated !== true) {
      truncated = (Array.isArray(values?.nodes) ? values.nodes : []).some(
        (value) => value?.users?.pageInfo?.hasNextPage === true || value?.labels?.pageInfo?.hasNextPage === true,
      );
    }
    if (truncated === true) count += 1;
  }
  return count;
}

/**
 * 拉一个项目的整块看板数据:字段定义 + items(分页,上限 MAX_ITEMS)。
 *
 * 返回契约(S2.4/S2.5):
 *   `{ ok: true, board, totalCount, fetchedCount, incomplete? }`
 *   - board:mapBoard 的投影(列/卡/提示标记),见 mapBoard 注释;
 *   - totalCount:**服务端全量口径**(GitHub items.totalCount),畸形/缺席时退回 fetchedCount;
 *   - fetchedCount:实际拉取条数;
 *   - incomplete:翻页到上限仍 hasNextPage 且服务端口径不足以自证完整(未知或不大于
 *     已取数)时为 true —— 看板**不完整但可解释**,由 UI 明示,不假称全量(S2.5)。
 *   失败:input_invalid / project_not_found / 各请求错误。
 * @param token 凭据快照(服务层发起时捕获,穿透给 pageAll→ghGraphQL;undefined =
 *   直接调用原行为,执行时读 env)。token 缺失由 ghGraphQL 按快照判定 token_missing。
 */
async function getBoardImpl(request, deps = {}, token) {
  const number = Number(request?.projectNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return boardError("input_invalid", "projectNumber 必须是正整数。");
  }
  // 仓路由:列表条目带 repo(仓归属)走 repository 路径,否则 viewer 路径。
  const repoMatch = request?.repo === undefined ? null : /^([\w.-]+)\/([\w.-]+)$/.exec(String(request.repo).trim());
  if (request?.repo !== undefined && repoMatch === null) {
    return boardError("input_invalid", "repo 必须是 owner/name 格式。");
  }
  const viaRepo = repoMatch !== null;
  const query = viaRepo ? QUERY_REPO_BOARD_PAGE : QUERY_BOARD_PAGE;
  const variables = viaRepo ? { owner: repoMatch[1], name: repoMatch[2], number } : { number };
  const page = await pageAll(
    query,
    variables,
    (data) => {
      const project = viaRepo ? data?.repository?.projectV2 : data?.viewer?.projectV2;
      return project === undefined || project === null ? null : { connection: project.items, parent: project };
    },
    deps,
    { maxItems: MAX_ITEMS, pageSize: ITEMS_PAGE_SIZE },
    token,
  );
  if (!page.ok) return page;
  if (page.absent === true) return boardError("project_not_found", `找不到编号为 ${number} 的项目(或无权访问)。`);
  const items = page.nodes.slice(0, MAX_ITEMS);
  const parent = page.parent ?? {};
  const fieldsNodes = parent.fields?.nodes;
  const board = mapBoard({
    project: {
      id: String(parent.id ?? ""),
      number: Number(parent.number ?? number),
      title: String(parent.title ?? "(未命名项目)"),
      statusField: extractStatusField(fieldsNodes),
    },
    itemNodes: items,
  });
  if (!board.ok) return board;
  // Status 缺失时的原因推断:给 UI 明确提示,而不是无声退化成单列(S2.8)。
  board.board.statusFieldHint = statusFieldHint(fieldsNodes, board.board.hasStatusField === true);
  // 卡片内容不可读的自诊断(2026-10-01 真机实测):fine-grained PAT 缺 Issues/PR 读权限时
  // GraphQL 不报错,而是把每张卡的 content 置 null(字段值照常返回)→ 面板满屏「(无标题)」。
  // 统计出来交给 UI 提示(可能原因不止权限一种,文案在浏览器侧,S2.8)。
  const contentMissing = items.filter((node) => node?.content === null || node?.content === undefined).length;
  if (contentMissing > 0) board.board.contentMissing = contentMissing;
  // 字段值层的单页截断计数(S2.5):提示「部分卡片可能缺标签/负责人」,不无声丢弃。
  const valuesTruncated = countFieldValuesTruncated(items);
  if (valuesTruncated > 0) board.board.fieldValuesTruncated = valuesTruncated;
  // totalCount 口径(S2.5):优先 GitHub 报告的 items.totalCount(全量);拉不到时退回实际拉取数。
  const reported = Number(page.firstConnection?.totalCount);
  const serverTotalKnown = Number.isInteger(reported) && reported >= 0;
  const totalCount = serverTotalKnown ? reported : items.length;
  // 截断可解释性:翻页到上限仍 hasNextPage 时,若服务端口径能自证不完整(totalCount >
  // fetchedCount,UI 会展示「已加载 X / Y」)则不必另加标记;口径未知或自相矛盾时
  // 显式置 incomplete,UI 给出无总数版本的不完整提示 —— 任何路径都不假称全量。
  const incomplete = page.capped === true && !(serverTotalKnown && totalCount > items.length);
  return {
    ok: true,
    board: board.board,
    totalCount,
    fetchedCount: items.length,
    ...(incomplete ? { incomplete: true } : {}),
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
 * Status 字段缺失时的原因推断(纯函数,供 UI 给出明确提示,替代无声退化;S2.8):
 *   - "fields_truncated":fields 拉满单页上限(40),Status 可能在未加载的字段里;
 *   - "possibly_renamed":没有 Status,但存在其他单选字段,疑似被改名;
 *   - "not_found":没有任何单选字段迹象。
 * 行为口径:改名或缺失都退化为单列兜底(fallback:"all"),**不会**自动猜测改名后的
 * 字段当 Status 用 —— 列序语义(= Status 选项序)不能建立在猜测上。
 * 只影响提示文案,不改变看板退化行为本身。
 */
function statusFieldHint(fieldNodes, statusFieldFound) {
  if (statusFieldFound === true) return null;
  const fields = (Array.isArray(fieldNodes) ? fieldNodes : []).filter((candidate) => candidate !== null && typeof candidate === "object");
  if (fields.length >= FIELDS_PAGE_SIZE) return "fields_truncated";
  if (fields.some((candidate) => candidate.name !== STATUS_FIELD_NAME && Array.isArray(candidate.options))) return "possibly_renamed";
  return "not_found";
}

/**
 * 把 GraphQL items 投影成看板:列序 = Status 选项序,空列保留。
 * 刻意做成纯函数:输入节点形状同 QUERY_BOARD_PAGE,自检直接喂样例。
 * 逐项防御(R4 遗留 P2):project 缺字段、statusField 畸形、itemNodes 混入非对象项、
 * fieldValues 里混入坏值 —— 坏项跳过或落兜底列,不抛不崩。
 *
 * 输出契约(S2.4;本地化职责在浏览器侧 —— 宿主无 locale 面,兜底文案一律发标记):
 *   board.project = { id: string, number: number, title: string }
 *   board.hasStatusField = boolean
 *   board.columns = Array<{ optionId: string|null, name: string, fallback?: "all"|"unfiled", items: Card[] }>
 *     - name 是数据本体(Status 选项名);fallback 标记列的显示名由浏览器侧查词典
 *       (columnAll/columnUnfiled,S2.9 国际化口径:宿主不产出面向用户的固定中文);
 *   Card = { id, title, untitled?: true, url?, assignees: string[], labels: {name,color?}[], statusOptionId: string|null }
 *     - 标题缺失时 title="" + untitled:true,显示文案由浏览器侧查词典(cardUntitled)。
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
  // 兜底列(S2.9):name 留空、带 fallback 标记 —— 「全部」= 无 Status 字段时的单列退化,
  // 「未分列」= 有字段但卡片的 optionId 对不上任何选项;显示名由浏览器侧本地化。
  const fallbackColumn = statusField === null
    ? { optionId: null, name: "", fallback: "all", items: [] }
    : { optionId: null, name: "", fallback: "unfiled", items: [] };
  const nodes = (Array.isArray(itemNodes) ? itemNodes : []).filter((node) => node !== null && typeof node === "object");
  const cards = nodes.map((node) => {
    const item = { id: String(node.id ?? ""), title: "", untitled: true, url: undefined, assignees: [], labels: [], statusOptionId: null };
    const content = node.content;
    if (content !== undefined && content !== null) {
      if (typeof content.title === "string" && content.title.length > 0) {
        item.title = content.title;
        item.untitled = false;
      }
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

// ─────────────────────────── §5. Remote 面(v1 wire 契约,集中定义)+ 缓存 ───────────────────────────

/**
 * Remote wire 契约的**唯一集中地**(S2.6)。以下形状已逐字段对照 dsh 0.2.0-rc.1/rc.2
 * 官方包源码核验(2026-10-03 复核,核验记录见 notes/remediation/phase2.md S2.6):
 *
 * 1. Remote 方法标记(宿主 SRC 回退的发现依据,对照 dsh-typert-protocol 的 mark()):
 *    原型属性 `@deepseek-ai/dsh-typert-protocol/remote-methods` = 冻结描述符
 *    `{ version: 1, methods: 冻结数组 }`,每个 marker 冻结为
 *    `{ method, invocation: { kind: "direct" } }` —— exportName 省略(= 方法名)、
 *    mode 省略(非流式),与 protocol `mark()` 的产出逐字段一致(protocol 对直接方法
 *    恰好省略这两个键;多写反而与官方形状不符)。
 * 2. 服务绑定(对照 protocol `bindTypertRemote()`):冻结的
 *    `{ service: 实例自身, serviceKey, namespace }`;gateway `readBinding()` 校验
 *    service 自指与 serviceKey/namespace 一致。namespace 必须匹配
 *    /^[A-Za-z0-9_$.-]+$/ 且不为 "." / ".."(protocol validateName)。
 * 3. 方法签名约束(gateway `methodParameterNames()`):方法必须是原型方法、参数为
 *    简单标识符(用 Function.toString 解析,不支持解构/默认值/rest)。wire 字段名 =
 *    参数名,本服务即 `request`。
 * 4. 参数校验能力(SRC/src-json 路径的**实际**校验,gateway `decode()`):只做
 *    JSON 安全校验(纯对象/数组/有限数字/字符串/布尔/null,拒绝循环引用与非普通
 *    原型),**不做形状校验** —— 所以业务参数的形状契约由本包在两端自行约定
 *    (request 的 projectNumber/repo/noCache,浏览器侧另有响应侧 coerce,S2.4)。
 *    缺席的 json 参数被接受(gateway assertExactArguments 对 src-json 参数允许
 *    missing),多余顶层字段被拒绝(gateway/arguments-invalid)。
 * 5. 返回信封(dsh 0.2.0-rc.2 实测,dev-notes 差异 11;gateway `encodeRpcResult()` /
 *    client `invoke()`):网关 direct 调用回 `{ ok: true, value: 业务结果 }` /
 *    `{ ok: false, error: { code, message, details } }`;业务结果原样进 value(SRC
 *    路径只做运行时 JSON 安全编码)。浏览器侧拆包逻辑见 lib/client.js createBoardApi。
 * 6. 兼容检查:smoke 自检对照上述规则核验本服务的标记/绑定/方法名与浏览器侧清单
 *    (scripts/smoke-load.mjs 的「wire 契约」用例);dsh 升级核对清单见
 *    notes/dev-notes.md「升级 dsh 时的核对清单」。
 */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/** 本服务暴露的 Remote 方法(wire 清单唯一来源;浏览器侧清单见 lib/client.js)。 */
const REMOTE_METHODS = ["status", "listProjects", "getBoard"];

/**
 * 在类的原型上登记 Remote 方法标记(与 protocol 的 mark() 逐字段一致,见上节契约 1)。
 * gateway 的 SRC 回退靠它发现「名字空间.方法 → 原型方法」。
 */
function markRemote(prototype, method) {
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
 * 本地缓存(0.5.0 提速,0.8.0 按 S1.9 加边界):GitHub 往返是面板打开慢的主因,加进程内
 * TTL 缓存 + in-flight 去重。命中窗口刻意短于轮询周期(board 15s < 轮询 30s),轮询永远
 * 拿新数据;面板关掉重开则秒回缓存。缓存只存看板业务结果(公开元数据),token 永不进
 * 缓存键/值(键里的「指纹」是单向散列,不是凭据)。边界:
 *   - 容量:boards 最多 maxBoards 块(默认 8,LRU 按写入序淘汰最旧),不随切换无界增长;
 *   - 身份:方法入口取**凭据快照**(token + 指纹同刻同值),指纹用于命中校验/去重键/
 *     写入盖章整链,token 穿透到实际请求(R3host/P1:标签必须描述实际使用的凭据,
 *     在途窗口内轮换不串刻);轮换 token 后旧身份缓存视为未命中;在途去重键同样含
 *     指纹 —— 身份切换后新调用不得加入旧身份的在途请求(R2host);
 *   - 单调写:全局序号只在**真正发起请求时**分配(produce 首次执行处),加入既有在途
 *     的调用不持有序号、不回填缓存 —— 否则加入者会以较晚序号把旧结果盖过更新结果
 *     (R2host);回填时旧请求(startSeq 较小)不得覆盖新请求已写入的数据 —— 强制刷新
 *     与普通请求并发时,后发起的强刷结果不会被先发起的慢请求顶掉。
 */
class GithubKanbanService {
  /** wire 契约:gateway 源模式发现用的可见绑定(见 §5 契约 2)。 */
  typertRemote;

  constructor(deps = {}) {
    /** 依赖注入面(fetch/env/repos/cache/超时)仅供自检替换;生产为空对象,env 缺省回退 process.env。 */
    this.deps = deps;
    this.name = SERVICE_KEY;
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
    for (const method of REMOTE_METHODS) markRemote(Object.getPrototypeOf(this), method);
    const ttl = deps.cache ?? {};
    this.cache = {
      now: typeof ttl.now === "function" ? ttl.now : () => Date.now(),
      projectsTtlMs: Number.isInteger(ttl.projectsTtlMs) ? ttl.projectsTtlMs : 60_000,
      boardTtlMs: Number.isInteger(ttl.boardTtlMs) ? ttl.boardTtlMs : 15_000,
      maxBoards: Number.isInteger(ttl.maxBoards) && ttl.maxBoards > 0 ? ttl.maxBoards : DEFAULT_MAX_BOARDS,
      projects: undefined, // { value: 成功信封(含 warnings), at, seq, fp }
      boards: new Map(), // key → { value: 成功信封, at, seq, fp }(Map 迭代序 = 写入序,首键即最旧)
      inflight: new Map(), // key → Promise(并发去重,键含 token 指纹;settle 时核对身份后出队)
      opSeq: 0, // 全局单调发号(只在请求真正发起时取号):写缓存的单调性依据
    };
    this.requestTimeoutMs =
      Number.isInteger(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0 ? deps.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** 服务状态:token 是否就绪 + 已配置仓库数(只给布尔/计数,不给任何凭据信息)。 */
  async status() {
    return {
      ok: true,
      status: {
        tokenConfigured: readToken(this.deps.env ?? process.env) !== null,
        repos: normalizeRepos(this.deps.repos).length,
        version: VERSION,
      },
    };
  }

  /** 当前凭据快照(R3host/P1):token 与其指纹在同一刻、由同一值计算 —— 缓存盖章的
   *  指纹恒等于实际发请求所用 token 的指纹。调用方在方法入口取一次,整链(命中校验/
   *  去重键/写入盖章/请求凭据)用同一份;在途期间环境轮换不影响本次请求的身份。 */
  credentialSnapshot() {
    const token = readToken(this.deps.env ?? process.env);
    return { token, fp: tokenFingerprint(token) };
  }

  /**
   * 并发去重:同键请求共享同一个 in-flight promise。键由调用方拼装且**必须包含 token
   * 指纹** —— 身份切换后新调用不加入旧身份的在途请求(R2host)。settle 时先核对自己
   * 仍是该键的在册条目再出队 —— 防止(防御性地)旧请求的清理动作误删新请求的条目(S1.3)。
   * produce 的任何异常都折进返回的 promise(不抛出),保证条目一定会被清理。
   */
  dedupe(key, produce) {
    const existing = this.cache.inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = Promise.resolve()
      .then(produce)
      .finally(() => {
        if (this.cache.inflight.get(key) === promise) this.cache.inflight.delete(key);
      });
    this.cache.inflight.set(key, promise);
    return promise;
  }

  /** viewer 名下的 Projects v2 列表(项目切换器数据源);TTL 内直接回缓存。
   *  request.noCache === true 时绕过 TTL(刷新语义),成功后回填新值。
   *  缓存的是**整个成功信封**(含 warnings):命中原样返回,repo_missing 等来源警告
   *  不因命中消失(R2host)。 */
  async listProjects(request) {
    const force = request?.noCache === true;
    // 发起时取凭据快照(R3host/P1):指纹(标签)与实际请求凭据是同一刻的同一值 ——
    // produce 微任务执行时环境已轮换,请求也仍按这份 token 发出,不会出现「B 的凭据
    // 拉数据、A 的指纹入缓存」。命中校验/去重键/写入盖章沿用同一 fp(R2host)。
    const { token, fp } = this.credentialSnapshot();
    const hit = this.cache.projects;
    if (!force && hit !== undefined && hit.fp === fp && this.cache.now() - hit.at < this.cache.projectsTtlMs) {
      return hit.value;
    }
    // 序号只在**真正发起**时分配(produce 首次执行处):加入既有在途的调用不持有序号
    // (startSeq 保持 0)、不回填缓存 —— 否则加入者会以较晚序号把旧结果盖过更新结果
    // (force 与非 force 是不同在途键、可同时在途,R2host)。
    let startSeq = 0;
    const result = await this.dedupe(`projects${force ? ":force" : ""}:${fp}`, () => {
      startSeq = ++this.cache.opSeq;
      // token = 入口快照:请求凭据与上面的 fp 按构造一致(缺 token 时为 null,
      // impl 按快照早退 token_missing,不再另读一次环境)。
      return listProjectsImpl(this.deps, token);
    });
    if (result.ok && startSeq > 0) {
      const existing = this.cache.projects;
      if (existing === undefined || existing.seq <= startSeq) {
        this.cache.projects = { value: result, at: this.cache.now(), seq: startSeq, fp };
      }
    }
    return result;
  }

  /**
   * 一个项目的看板投影(列序 = Status 选项序)。
   * request.noCache === true 时绕过缓存(刷新按钮语义),成功后回填新值;
   * 回填走单调写:先发起的旧请求不覆盖后发起请求(如强制刷新)已写入的结果(S1.9),
   * 加入既有在途的调用不持有序号、不回填(R2host)。缓存的与命中返回的都是整个成功
   * 信封(totalCount/fetchedCount/incomplete/board.contentMissing 等完整保留)。
   */
  async getBoard(request) {
    const key = `${typeof request?.repo === "string" ? request.repo : ""}#${Number(request?.projectNumber)}`;
    const force = request?.noCache === true;
    // 同 listProjects:凭据快照发起时取,指纹与实际请求凭据同一刻同一值(R3host/P1);
    // 在途键含指纹,身份切换不串台(R2host)。
    const { token, fp } = this.credentialSnapshot();
    const hit = this.cache.boards.get(key);
    if (!force && hit !== undefined && hit.fp === fp && this.cache.now() - hit.at < this.cache.boardTtlMs) {
      return hit.value;
    }
    let startSeq = 0;
    const result = await this.dedupe(`board:${key}${force ? ":force" : ""}:${fp}`, () => {
      startSeq = ++this.cache.opSeq;
      // token = 入口快照:请求凭据与上面的 fp 按构造一致(R3host/P1)。
      return getBoardImpl(request, this.deps, token);
    });
    if (result.ok && startSeq > 0) {
      const existing = this.cache.boards.get(key);
      if (existing === undefined || existing.seq <= startSeq) {
        if (!this.cache.boards.has(key) && this.cache.boards.size >= this.cache.maxBoards) {
          // 容量淘汰:Map 迭代序 = 写入序,首键即最久未写入的条目(LRU,读不续命:口径可预期)
          this.cache.boards.delete(this.cache.boards.keys().next().value);
        }
        this.cache.boards.set(key, { value: result, at: this.cache.now(), seq: startSeq, fp });
      }
    }
    return result;
  }
}

// ─────────────────────────── §6. 插件入口 ───────────────────────────

/**
 * 插件入口。
 * @param ctx 宿主 Context
 * @param config bundle patch 的 config 段
 */
function apply(ctx, config) {
  const host = createHostAdapter(ctx);
  const repos = normalizeRepos(config?.repos);
  const service = new GithubKanbanService({
    repos: repos.map((repo) => repo.label),
    cache: config?.cache,
    // 请求超时可配置(毫秒);非法值在构造器回退默认。防误配负数/0 把所有请求秒杀。
    requestTimeoutMs: config?.requestTimeoutMs,
  });
  host.publishService(SERVICE_KEY, service);
  host.log(
    "info",
    `宿主服务 ${SERVICE_KEY} 已注册(v${VERSION},远程面 ${REMOTE_METHODS.length} 方法:` +
      `token ${readToken() === null ? "未配置" : "已配置(不记录任何值)"},` +
      `仓库级项目 ${repos.length} 个:${repos.map((repo) => repo.label).join("、") || "无"},` +
      `缓存 TTL ${service.cache.projectsTtlMs}ms/${service.cache.boardTtlMs}ms(上限 ${service.cache.maxBoards} 块),` +
      `请求超时 ${service.requestTimeoutMs}ms)`,
  );
  return service;
}

const Config = undefined;

export {
  Config,
  GithubKanbanService,
  apply,
  extractStatusField,
  ghGraphQL,
  graphqlQueries,
  inject,
  mapBoard,
  name,
  normalizeRepos,
  readToken,
  statusFieldHint,
  VERSION,
};
