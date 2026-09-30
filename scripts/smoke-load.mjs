#!/usr/bin/env node
/**
 * dsh-github-kanban · 加载链路静态自检(零依赖,只用 node 内置模块)。
 *
 * 为什么有它:dsh 的浏览器插件链路只有装进 profile 重启 dsh web 才能真机验证(Phase 1.4),
 * 但契约本身是可以在本地核对的。本脚本按 dsh 0.2.0-rc.1 的加载器/座位/远程契约跑一遍:
 *   1. package.json:dsh.client 声明、exports["./client"]、bundle patch 齐全;
 *   2. lib/client.js:注册形态正确(load({id, factory}))、id 等于包名、零副作用:
 *      物化时才注入样式,且样式带插件归属;
 *   3. apply(ctx):按 keyed 规则注册 1 个 tab 类型 + 2 个座位,并向 ctx.remote.$mount
 *      挂上手写远程清单(3 个 direct 方法,strict 编解码);
 *   4. lib/index.js:宿主 githubKanban 服务带 typertRemote 绑定 + 原型 Remote 标记;
 *      token 缺失路径不抛堆栈、不泄漏;GraphQL 查询串不含 token;字段映射列序正确;
 *   5. body 组件:投影读数随快照变化;token 引导 / 项目切换 / 分列渲染 / 错误态可交互。
 *
 * 它不能替代真机验证:React 与 dsh 服务都是替身(但 hook 语义按 React 规则实现)。
 * 用法:node scripts/smoke-load.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const check = (label, ok, detail) => results.push({ label, ok: ok === true, detail: detail ?? "" });
const die = (message) => {
  console.error(`smoke-load: ${message}`);
  process.exit(1);
};

// ── 1. 包声明 ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PACKAGE_ID = pkg.name;
const CLIENT_ENTRY = typeof pkg.exports?.["./client"] === "string" ? pkg.exports["./client"] : pkg.exports?.["./client"]?.default;
const HOST_ENTRY = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.default;
const PATCH = pkg.dsh?.bundle?.patch;
const NS = "thorn-github-kanban";
const TAB_ID = `${PACKAGE_ID}/board`;
const SERVICE_KEY = "githubKanban";

check("package.json:dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
check(
  "package.json:dsh.client.inject 是包名数组",
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0 && pkg.dsh.client.inject.every((s) => typeof s === "string"),
);
check("package.json:exports['./client'] 指向存在的文件", typeof CLIENT_ENTRY === "string" && existsSync(join(root, CLIENT_ENTRY)));
check("package.json:exports['.'] 指向存在的文件", typeof HOST_ENTRY === "string" && existsSync(join(root, HOST_ENTRY)));
check("package.json:dsh.bundle.patch 指向存在的文件", typeof PATCH === "string" && existsSync(join(root, PATCH)));

// ── 仓库级隐私红线:token 只走 GITHUB_TOKEN ─────────────────────────────────
const repoFiles = ["lib/index.js", "lib/client.js", "package.json", "cordis.patch.yml", "TODO.md"];
const offenders = [];
for (const file of repoFiles) {
  const text = readFileSync(join(root, file), "utf8");
  if (text.includes("DSH_" + "GITHUB_TOKEN")) offenders.push(file); // 模式拼接写,避免自检自身命中红线字样
}
check("仓库内无旧 token 变量名残留(已纠正为 GITHUB_TOKEN)", offenders.length === 0, offenders.join(","));

// ── 2. 注册阶段:只注册,不产生副作用 ────────────────────────────────────────
/** 最小 React 替身:useState/useEffect/useRef 按 React 语义;同值 setState 不触发重渲染。 */
function createMiniReact() {
  let states = [];
  let refs = [];
  let effectDeps = [];
  let hookIndex = 0;
  let render = null;
  const timers = [];
  const schedule = (fn) => timers.push(fn);
  const stub = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    useState(init) {
      const i = hookIndex++;
      if (states[i] === undefined) states[i] = typeof init === "function" ? init() : init;
      return [
        states[i],
        (value) => {
          const next = typeof value === "function" ? value(states[i]) : value;
          if (next === states[i]) return;
          states[i] = next;
          render?.();
        },
      ];
    },
    useRef(value) {
      const i = hookIndex++;
      if (refs[i] === undefined) refs[i] = { current: value };
      return refs[i];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(fn, deps) {
      const i = hookIndex++;
      const prev = effectDeps[i];
      const unchanged = Array.isArray(deps) && Array.isArray(prev) && deps.length === prev.length && deps.every((dep, k) => Object.is(dep, prev[k]));
      effectDeps[i] = deps;
      if (unchanged) return;
      schedule(() => fn());
    },
  };
  return {
    react: stub,
    /** 回到「未挂载」:下一次 settle 从头初始化 hook 状态。 */
    reset() {
      render = null;
    },
    /** 挂载组件并推进异步链:每轮执行到期的 effect,然后让出事件循环。
     *  同一 runtime 内的后续 settle 保留 hook 状态(供交互:onChange 后继续渲染)。 */
    async settle(component, props, rounds = 8) {
      if (render === null) {
        states = [];
        refs = [];
        effectDeps = [];
        hookIndex = 0;
      }
      let tree;
      render = () => {
        hookIndex = 0;
        tree = component(props);
      };
      render();
      for (let round = 0; round < rounds; round += 1) {
        const due = timers.splice(0, timers.length);
        for (const effect of due) effect();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return tree;
    },
  };
}
const miniReact = createMiniReact();
const settleFresh = (component, props, rounds) => {
  miniReact.reset();
  return miniReact.settle(component, props, rounds);
};
const requireStub = (spec) => {
  if (spec === "react") return miniReact.react;
  throw new Error(`未预期的 require(${JSON.stringify(spec)}):平台 seed 词之外还需要打包,本插件不支持(见文件头契约 2)`);
};

const registrations = [];
const styleTags = [];
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: (tag) => styleTags.push(tag) },
  },
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};

let registration;
try {
  vm.runInNewContext(readFileSync(join(root, CLIENT_ENTRY), "utf8"), sandbox, { filename: CLIENT_ENTRY });
} catch (error) {
  die(`client.js 执行失败:${error.message}`);
}
check("client.js 只注册一个工厂", registrations.length === 1, `registered=${registrations.length}`);
registration = registrations[0];
if (registration === undefined) die("client.js 未注册工厂");
check("注册 id 等于包名", registration.id === PACKAGE_ID, `id=${registration.id} name=${PACKAGE_ID}`);
check("样式在物化前不注入(load 阶段零副作用)", styleTags.length === 0);

let mod;
try {
  mod = registration.factory(requireStub);
} catch (error) {
  die(`factory 物化失败:${error.message}`);
}
check("导出 apply 与 inject", typeof mod.apply === "function" && Array.isArray(mod.inject));
check(
  "inject 声明客户端服务(slots/locale/sidebarRightTabs/remote)",
  ["slots", "locale", "sidebarRightTabs", "remote"].every((s) => mod.inject.includes(s)),
  `inject=${JSON.stringify(mod.inject)}`,
);
check(
  "样式随物化注入且带插件归属",
  styleTags.length === 1 && styleTags[0].dataset.plugin === PACKAGE_ID && typeof styleTags[0].dataset.pluginCss === "string" && styleTags[0].textContent.includes(".tgk-root"),
  `tags=${styleTags.length}`,
);

// ── 3. apply(ctx):座位、tab 类型、远程清单 ──────────────────────────────────
const seats = [];
const tabTypes = [];
const effectLabels = [];
const dictsByNs = new Map();
const locale = {
  register: (ns, dicts) => {
    dictsByNs.set(ns, dicts);
    return () => {};
  },
  bind: (ns) => (key, params) => {
    const raw = dictsByNs.get(ns)?.zh?.[key] ?? key;
    if (params === undefined) return raw;
    return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  },
};
const mountedContributions = [];
const ctx = {
  effect: (callback, label) => {
    effectLabels.push(label);
    return callback();
  },
  slots: {
    inject: (seat, factory) => factory(),
    register: (options, component) => {
      seats.push({ seat: options.name, options, component });
      return () => {};
    },
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabTypes.push(definition);
      return () => {};
    },
  },
  remote: {
    $mount: async (contribution) => {
      mountedContributions.push(contribution);
      return () => {};
    },
  },
  locale,
};

try {
  await mod.apply(ctx);
} catch (error) {
  die(`apply(ctx) 失败:${error.message}`);
}

check("register 生命周期挂在 ctx.effect 上(文案 + tab 类型)", effectLabels.length === 2, effectLabels.join(" | "));
check("注册了 1 个 tab 类型", tabTypes.length === 1);
const tabType = tabTypes[0] ?? {};
check("tab 类型 id 与座位 key 同一来源", tabType.id === TAB_ID, `id=${tabType.id}`);
check("tab 类型是页面型(无 patterns)", typeof tabType.kind === "string" && tabType.patterns === undefined, `kind=${tabType.kind}`);
check("tab 类型带 title 与 guide 入口", typeof tabType.title === "function" && Array.isArray(tabType.guide) && typeof tabType.guide[0]?.title === "function" && tabType.guide[0]?.title() === "GitHub 看板");
check(
  "注册 2 个 keyed 座位(body + title)",
  seats.length === 2 && seats.map((s) => s.seat).join(",") === "sidebar.right.pane.tab,sidebar.right.pane.tab.title",
  seats.map((s) => s.seat).join(","),
);
check("座位 key = tab 类型 id,locale = 命名空间", seats.every((s) => s.options.key === TAB_ID && s.options.locale === NS));
const zhKeys = Object.keys(dictsByNs.get(NS)?.zh ?? {}).sort();
const enKeys = Object.keys(dictsByNs.get(NS)?.en ?? {}).sort();
check("zh/en 字典逐键对照", zhKeys.length > 0 && zhKeys.join(",") === enKeys.join(","), `zh=${zhKeys.length} en=${enKeys.length}`);

// 远程清单(差异 3 的浏览器对端)
const contribution = mountedContributions[0];
check("apply 向 ctx.remote.$mount 恰好挂 1 份清单", mountedContributions.length === 1, `count=${mountedContributions.length}`);
check("清单归属本包", contribution?.package === PACKAGE_ID);
const descriptors = Array.isArray(contribution?.descriptors) ? contribution.descriptors : [];
check(
  "远程清单声明 3 个 direct 方法(status/listProjects/getBoard)",
  descriptors.length === 3 && descriptors.every((d) => d.namespace === SERVICE_KEY && d.invocation?.kind === "direct") &&
    ["status", "listProjects", "getBoard"].every((m) => descriptors.some((d) => d.method === m)),
  descriptors.map((d) => `${d.namespace}/${d.method}`).join(","),
);
check(
  "远程清单参数与结果都带 strict 编解码(客户端只校验 mode)",
  descriptors.every((d) => d.result?.mode === "strict" && typeof d.result.create === "function" &&
    d.parameters.every((p) => p.source === "json" && p.codec?.mode === "strict")) &&
    descriptors.find((d) => d.method === "getBoard")?.parameters?.[0]?.wire === "request",
  JSON.stringify(descriptors.map((d) => [d.method, d.result?.mode, typeof d.result?.create, d.parameters.length])),
);
check("strict 编解码占位的 create() 是无害透传", descriptors[0]?.result?.create().parse({ a: 1 }).a === 1);

// ── 4. 宿主半边:服务、绑定、token 红线、GraphQL 纯度 ────────────────────────
const hostMod = await import(pathToFileURL(join(root, HOST_ENTRY)).href);
const provided = new Map();
const hostLogs = [];
hostMod.apply({ provide: (key, value) => provided.set(key, value), logger: { info: (message) => hostLogs.push(message) } }, {});
const service = provided.get(SERVICE_KEY);
check("宿主半边注册 githubKanban 服务", service !== undefined);
check("宿主服务带 typertRemote 绑定(serviceKey/namespace/自指)", service?.typertRemote?.serviceKey === SERVICE_KEY && service?.typertRemote?.namespace === SERVICE_KEY && service?.typertRemote?.service === service);
const remoteMarkers = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service ?? {}), "@deepseek-ai/dsh-typert-protocol/remote-methods")?.value;
check(
  "宿主原型带 v1 Remote 标记(3 方法)",
  remoteMarkers?.version === 1 && ["status", "listProjects", "getBoard"].every((m) => remoteMarkers.methods.some((marker) => marker.method === m)),
  JSON.stringify(remoteMarkers?.methods?.map((m) => m.method) ?? []),
);
check("宿主 inject 为空(cordis.patch.yml 一行 insert)", Array.isArray(hostMod.inject) && hostMod.inject.length === 0);
check("宿主激活日志不含任何 token 值(只报配置与否)", hostLogs.length === 1 && !hostLogs[0].includes("ghp_"), hostLogs[0] ?? "");

// token 缺失路径:结构化错误,不抛堆栈
{
  const bare = new hostMod.GithubKanbanService({ env: {} });
  const status = await bare.status();
  check("status():token 未配置返回布尔标志而非报错", status?.ok === true && status.status?.tokenConfigured === false, JSON.stringify(status));
  const noToken = await bare.listProjects();
  check("listProjects():token 缺失返回结构化错误而非抛堆栈", noToken?.ok === false && noToken.error?.code === "token_missing" && noToken.error.message.includes("GITHUB_TOKEN"), JSON.stringify(noToken));
  const noTokenBoard = await bare.getBoard({ projectNumber: 1 });
  check("getBoard():token 缺失同上", noTokenBoard?.ok === false && noTokenBoard.error?.code === "token_missing");
  const badInput = await new hostMod.GithubKanbanService({ env: { GITHUB_TOKEN: "t" } }).getBoard({ projectNumber: -3 });
  check("getBoard():非法 projectNumber 返回 input_invalid", badInput?.ok === false && badInput.error?.code === "input_invalid", JSON.stringify(badInput));
}

// GraphQL 请求纯度:token 只进 Authorization 头,查询串与 body 不含 token
{
  const SECRET = "ghp_smoke_secret_value";
  const seen = [];
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { login: "thornwu" } } }) };
    },
  });
  const bodyText = seen[0]?.init?.body ?? "";
  check(
    "ghGraphQL():token 只出现在 Authorization 头",
    result.ok === true &&
      seen[0]?.init?.headers?.Authorization === `Bearer ${SECRET}` &&
      !bodyText.includes(SECRET) &&
      !(seen[0]?.init?.headers && Object.entries(seen[0].init.headers).some(([k, v]) => k !== "Authorization" && String(v).includes(SECRET))),
    `url=${seen[0]?.url}`,
  );
  check("ghGraphQL():端点是 api.github.com/graphql", seen[0]?.url === "https://api.github.com/graphql");
  const networkFail = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async () => {
      throw new Error(`network down ${SECRET}`);
    },
  });
  check(
    "ghGraphQL():网络错误折叠为结构化失败且抹掉 token 值",
    networkFail.ok === false && networkFail.error.code === "network_error" && !JSON.stringify(networkFail).includes(SECRET) && networkFail.error.message.includes("[redacted]"),
    JSON.stringify(networkFail),
  );
}

// 4b. graphql_error 分支文案脱敏(先红后绿:旧代码该分支不过 sanitizeError)
{
  const SECRET = "ghp_graphql_branch_secret";
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: `Bad token ${SECRET}` }, { message: "second segment" }] }),
    }),
  });
  check(
    "graphql_error:多段 message 拼接后整体脱敏(不残留 token,标记完整)",
    result.ok === false && result.error?.code === "graphql_error" && !JSON.stringify(result).includes(SECRET) &&
      result.error.message.includes("[redacted]") && result.error.message.includes("second segment"),
    JSON.stringify(result),
  );
}

// 4c. 脱敏与截断的顺序:token 横跨 300 字符边界时不残留、标记不被截半(先红后绿)
{
  const SECRET = "ghp_boundary_secret_token_value_9f3ab2";
  const message = `${"a".repeat(295)}${SECRET}${"b".repeat(50)}`;
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async () => {
      throw new Error(message);
    },
  });
  const text = result.error?.message ?? "";
  check(
    "sanitizeError:token 横跨 300 边界时先截断后脱敏,无明文残留且标记完整",
    result.ok === false && result.error?.code === "network_error" && !text.includes(SECRET) &&
      !text.includes(SECRET.slice(0, 10)) && text.includes("[redacted]"),
    `len=${text.length} tail=${JSON.stringify(text.slice(-24))}`,
  );
}

// 4d. 项目列表分页:>30 项目时按 pageInfo 拉全(先红后绿:旧代码只拉第一页)
{
  const pages = [
    {
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, number: i + 1, title: `P${i + 1}`, updatedAt: "2026-09-29T00:00:00Z" })),
      pageInfo: { hasNextPage: true, endCursor: "c1" },
    },
    {
      nodes: Array.from({ length: 5 }, (_, i) => ({ id: `p${i + 30}`, number: i + 31, title: `P${i + 31}`, updatedAt: "2026-09-29T00:00:00Z" })),
      pageInfo: { hasNextPage: false },
    },
  ];
  const calls = [];
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { projectsV2: pages[calls.length - 1] } } }) };
    },
  });
  const list = await service.listProjects();
  check(
    "listProjects:>30 项目按 pageInfo 分页拉全(2 页 35 个,第二页带 after 游标)",
    list.ok === true && list.projects?.length === 35 && calls.length === 2 && calls[1]?.variables?.after === "c1",
    `count=${list.projects?.length} calls=${calls.length}`,
  );
}

// 字段映射:列序 = Status 选项序;空列保留;卡片三要素
{
  const statusOptions = [
    { id: "opt_todo", name: "Todo" },
    { id: "opt_doing", name: "In Progress" },
    { id: "opt_done", name: "Done" },
  ];
  const project = { id: "p1", number: 7, title: "Alpha", statusField: { id: "f_status", name: "Status", options: statusOptions } };
  const itemNodes = [
    {
      id: "i1",
      content: { title: "设计 brief 评审", url: "https://example.com/1" },
      fieldValues: {
        nodes: [
          { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In Progress", optionId: "opt_doing", field: { name: "Status" } },
          { __typename: "ProjectV2ItemFieldUserValue", field: { name: "Assignees" }, users: { nodes: [{ login: "thornwu" }] } },
          { __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { nodes: [{ name: "P1", color: "ff8800" }] } },
        ],
      },
    },
    { id: "i2", content: { title: "待办卡" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "opt_todo", field: { name: "Status" } }] } },
    { id: "i3", content: { title: "无 Status 的卡" }, fieldValues: { nodes: [] } },
  ];
  const mapped = hostMod.mapBoard({ project, itemNodes });
  const columns = mapped.board.columns;
  check("映射:列序 = Status 选项序(Todo → In Progress → Done,末列兜底)", columns.map((c) => c.name).join("→") === "Todo→In Progress→Done→未分列", columns.map((c) => c.name).join(","));
  check("映射:空列(Done)也保留", columns[2].items.length === 0);
  check("映射:未分列的卡落到兜底列", columns[3]?.optionId === null && columns[3].items.some((i) => i.id === "i3"), JSON.stringify(columns[3]));
  const card = columns[1].items[0];
  check("映射:卡片三要素(标题/负责人/标签)", card.title === "设计 brief 评审" && card.assignees.join(",") === "thornwu" && card.labels[0]?.name === "P1", JSON.stringify(card));
  check("映射:optionId 归列正确(i1 → In Progress)", columns[1].items.length === 1 && columns[0].items.length === 1);
  const noField = hostMod.mapBoard({ project: { ...project, statusField: null }, itemNodes: [] });
  check("映射:缺 Status 字段退化为单列「全部」", noField.board.hasStatusField === false && noField.board.columns.length === 1 && noField.board.columns[0].name === "全部");
}

// ── 5. 渲染:mini hook 运行时驱动真实异步数据流 ──────────────────────────────
const bodySeat = seats.find((s) => s.seat === "sidebar.right.pane.tab");
const titleSeat = seats.find((s) => s.seat === "sidebar.right.pane.tab.title");
const t = locale.bind(NS);

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) {
    // 函数组件替身:直接以 props 调用展开(面板的子组件都是纯函数组件)。
    if (typeof node.type === "function") return textOf(node.type(node.props));
    return textOf(node.props?.children);
  }
  return "";
};
const findAll = (node, predicate, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if ("props" in node) {
    if (predicate(node)) out.push(node);
    if (typeof node.type === "function") findAll(node.type(node.props), predicate, out);
    findAll(node.props?.children, predicate, out);
  } else if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
  }
  return out;
};
const findFirst = (node, predicate) => findAll(node, predicate)[0];

/** 面板通用 props:座位 hook 替身 + 投影快照。 */
const makeProps = (state, boardApi, identity) => ({
  t,
  sessionId: state.sessionId,
  useTabInfo: () => ({ panel: { id: "pane-1" }, tab: { id: "tab-1" } }),
  useSessions: (selector) => selector(state.list),
  useProjection: (key, selector) => selector(key === "modelSelection" ? { next: { model: state.model } } : undefined),
  identity: identity ?? { packageId: PACKAGE_ID, ns: NS, tabId: TAB_ID, tabKind: "githubKanbanBoard", seats: ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"], remote: true },
  board: boardApi,
});

const stateB = {
  sessionId: "s3",
  model: "deepseek-v4",
  list: {
    ids: ["s1", "s2", "s3"],
    byId: {
      s1: { running: true, displayTitle: "看板脚手架" },
      s2: { running: false, displayTitle: "code review" },
      s3: { running: true, displayTitle: "Phase 1.2 读链路" },
    },
  },
};

/** 样例看板:与宿主 mapBoard 输出同形(列序即 Status 选项序)。 */
const sampleBoard = {
  project: { id: "p1", number: 7, title: "Alpha" },
  hasStatusField: true,
  columns: [
    { optionId: "opt_todo", name: "Todo", items: [{ id: "i2", title: "待办卡", url: undefined, assignees: [], labels: [], statusOptionId: "opt_todo" }] },
    { optionId: "opt_doing", name: "In Progress", items: [{ id: "i1", title: "设计 brief 评审", url: "https://example.com/1", assignees: ["thornwu"], labels: [{ name: "P1", color: "ff8800" }], statusOptionId: "opt_doing" }] },
    { optionId: "opt_done", name: "Done", items: [] },
  ],
};

// 5a. 投影读数仍随快照变化(1.1 回归)
{
  const stateA = { sessionId: "s1", model: "glm-5.3", list: { ids: ["s1"], byId: { s1: { running: true, displayTitle: "看板脚手架" } } } };
  const textA = textOf(await settleFresh(bodySeat.component, makeProps(stateA, undefined))).replace(/\s+/g, " ").trim();
  const textB = textOf(await settleFresh(bodySeat.component, makeProps(stateB, undefined))).replace(/\s+/g, " ").trim();
  check("面板随投影变化(两份快照读数不同)", textA !== textB && textA.length > 0 && textB.length > 0);
  check("读数含会话总数 1→3", textA.includes(" 1 ") && textB.includes(" 3 "));
  check("读数含投影模型名", textA.includes("glm-5.3") && textB.includes("deepseek-v4"));
  check("自检区标出本插件占位", textA.includes("sidebar.right.pane.tab + sidebar.right.pane.tab.title"));
}

// 5b. token 未配置 → 配置引导,不显示报错堆栈
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: false, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [] }),
    getBoard: async () => ({ ok: false, error: { code: "token_missing", message: "not reached" } }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("token 未配置:面板显示配置引导(标题 + 变量名 + 重启提示)", text.includes("尚未配置 GitHub 访问令牌") && text.includes("GITHUB_TOKEN") && text.includes("重启"), "");
  check("token 未配置:不出现错误前缀与堆栈样式", !text.includes("读取失败") && !/at\s+\S+ \(.*:\d+:\d+\)/.test(text));
}

// 5c. 已配置:项目切换器(≥2 项目)+ 按 Status 选项序分列 + 卡片三要素 + 空列
{
  const getCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
    getBoard: async (request) => {
      getCalls.push(request);
      return { ok: true, board: sampleBoard };
    },
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("看板:项目切换器列出 ≥2 个项目(#7 Alpha / #9 Beta)", text.includes("#7 Alpha") && text.includes("#9 Beta"));
  const select = findFirst(tree, (node) => node.type === "select");
  check("看板:切换器是 select 且默认选第一个项目", select !== undefined && select.props.value === "7", `value=${select?.props?.value}`);
  const columns = findAll(tree, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-column"));
  const columnNames = columns.map((column) => textOf(column).split("空")[0].trim().match(/^(Todo|In Progress|Done)/)?.[1]);
  check("看板:列渲染顺序 = Status 选项序(Todo → In Progress → Done)", columnNames.join(",") === "Todo,In Progress,Done", columnNames.join(","));
  const emptyMark = columns[2] !== undefined && textOf(columns[2]).includes("空");
  check("看板:空列(Done)也显示并标注「空」", emptyMark === true, textOf(columns[2] ?? "").trim());
  const cardText = textOf(columns[1]);
  check("看板:卡片含标题 + 负责人(@login)+ 标签(P1)", cardText.includes("设计 brief 评审") && cardText.includes("@thornwu") && cardText.includes("P1"), cardText.replace(/\s+/g, " "));
  check("看板:初拉默认项目 #7", getCalls.length === 1 && getCalls[0]?.projectNumber === 7, JSON.stringify(getCalls));

  if (select === undefined) {
    check("看板:切换器可交互(select 在场)", false, "select 缺席,无法模拟切换");
  } else {
    select.props.onChange({ target: { value: "9" } });
    await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  }
  check("看板:切换到 #9 后重拉 getBoard({projectNumber:9})", getCalls.some((r) => r?.projectNumber === 9), JSON.stringify(getCalls));
}

// 5c2. 初始 getBoard 失败(如 401)→ phase 应为 error,不得展示成空看板
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
    getBoard: async () => ({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("初始 getBoard 失败:显示错误态而非空看板", text.includes("读取失败") && text.includes("[http_error]") && !text.includes("该项目还没有看板条目") && !text.includes("viewer 名下没有"), text.match(/读取失败[^•]*/)?.[0]?.slice(0, 60));
  // 注:错误态吞掉切换器属已知 P2(loadBoard 失败时工具栏被错误段整体替换),本轮不修,记 TODO 1.3。
}

// 5c3. 快速切换项目:慢的旧响应不得覆盖新项目看板(请求序守卫)
{
  const boards = {
    7: { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "AlphaColumn", items: [{ id: "a1", title: "Alpha 的卡", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] },
    9: { project: { id: "p2", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "o2", name: "BetaColumn", items: [{ id: "b1", title: "Beta 的卡", url: undefined, assignees: [], labels: [], statusOptionId: "o2" }] }] },
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
    // #9 的响应比 #7 慢:无守卫时后到的旧响应会覆盖新看板
    getBoard: async ({ projectNumber }) => {
      await sleep(projectNumber === 9 ? 50 : 5);
      return { ok: true, board: boards[projectNumber] };
    },
  };
  // 组件的 react 是共享 miniReact 替身,交互必须在同一个 runtime 里做。
  miniReact.reset();
  const tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 40);
  const select = findFirst(tree, (node) => node.type === "select");
  select.props.onChange({ target: { value: "9" } }); // 先点 #9(慢)
  const tree2 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const select2 = findFirst(tree2, (node) => node.type === "select");
  select2.props.onChange({ target: { value: "7" } }); // 再点 #7(快,#7 先回,#9 后回)
  const tree3 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 80);
  const text3 = textOf(tree3);
  check("快速切换:最终展示的是后选项目(#7 Alpha)的看板", text3.includes("AlphaColumn") && !text3.includes("BetaColumn"), text3.match(/(AlphaColumn|BetaColumn)/g)?.join(","));
}

// 5c4. selected 项目不在当前列表(如刷新后被删):select 回退空值并给出「项目已不可用」禁用项
{
  const board7 = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "AlphaColumn", items: [] }] };
  const board9 = { project: { id: "p2", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "o2", name: "BetaColumn", items: [] }] };
  // 当前列表只剩 #7(模拟刷新后 #9 被删);selected 仍是 9 → 失配
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async ({ projectNumber }) => ({ ok: true, board: projectNumber === 9 ? board9 : board7 }),
  };
  // 组件的 react 是共享 miniReact 替身,交互必须在同一个 runtime 里做。
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const select = findFirst(tree, (node) => node.type === "select");
  select.props.onChange({ target: { value: "9" } }); // selected=9 不在当前 options 里
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const select2 = findFirst(tree, (node) => node.type === "select");
  const text = textOf(tree);
  check(
    "切换器:selected 项目不在列表时回退空值并提示「项目已不可用」",
    select2 !== undefined && select2.props.value === "" && text.includes("项目已不可用"),
    `value=${select2?.props?.value}`,
  );
  const disabledOption = findAll(select2, (node) => node.type === "option" && node.props?.disabled === true)[0];
  check(
    "切换器:失配占位是禁用 option,不可被选中",
    disabledOption !== undefined && textOf(disabledOption).includes("项目已不可用"),
    textOf(disabledOption ?? "").trim(),
  );
}

// 5d. 加载失败 → 结构化错误态(含 code,不含堆栈)
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: false, error: { code: "graphql_error", message: "Bad credentials" } }),
    getBoard: async () => ({ ok: false, error: { code: "unused", message: "" } }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("错误态:显示 [code] + 文案,无堆栈帧", text.includes("读取失败") && text.includes("[graphql_error]") && !/at\s+\S+ \(.*:\d+:\d+\)/.test(text), text.match(/读取失败[^•]*/)?.[0]?.slice(0, 80));
}

const titleText = textOf(titleSeat.component({ t, useSessions: (selector) => selector(stateB.list) })).replace(/\s+/g, " ").trim();
check("title 座位渲染出 chip 且带会话数", titleText.includes("GitHub 看板") && titleText.includes("3"), titleText);

// ── 6. 报告 ──────────────────────────────────────────────────────────────────
let failedCount = 0;
for (const result of results) {
  if (!result.ok) failedCount += 1;
  const mark = result.ok ? "✓" : "✗";
  console.log(`${mark} ${result.label}${result.detail === "" ? "" : `  — ${result.detail}`}`);
}
console.log(`\n${results.length - failedCount}/${results.length} 通过`);
process.exit(failedCount === 0 ? 0 : 1);
