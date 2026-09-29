#!/usr/bin/env node
/**
 * dsh-github-kanban · 加载链路静态自检(零依赖,只用 node 内置模块)。
 *
 * 为什么有它:dsh 的浏览器插件链路只有装进 profile 重启 dsh web 才能真机验证(Phase 1.4),
 * 但契约本身是可以在本地核对的。本脚本按 dsh 0.2.0-rc.1 的加载器/座位契约跑一遍:
 *   1. package.json:dsh.client 声明、exports["./client"]、bundle patch 齐全;
 *   2. lib/client.js:注册形态正确(load({id, factory}))、id 等于包名、零副作用:
 *      物化时才注入样式,且样式带插件归属;
 *   3. apply(ctx):按 keyed 规则注册 1 个 tab 类型 + 2 个座位(body + title),
 *      座位 key 用的是 tab 类型 id(不是注册 id);
 *   4. lib/index.js:宿主半边注册服务骨架,且 1.1 边界内不含网络/凭据面;
 *   5. body 组件在**两份不同的会话投影快照**下渲染出不同读数(内容随投影变化)。
 *
 * 它不能替代真机验证:没有真实 React 渲染器、没有真实 dsh 服务,只验契约与数据流。
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

check("package.json:dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
check(
  "package.json:dsh.client.inject 是包名数组",
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0 && pkg.dsh.client.inject.every((s) => typeof s === "string"),
);
check("package.json:exports['./client'] 指向存在的文件", typeof CLIENT_ENTRY === "string" && existsSync(join(root, CLIENT_ENTRY)));
check("package.json:exports['.'] 指向存在的文件", typeof HOST_ENTRY === "string" && existsSync(join(root, HOST_ENTRY)));
check("package.json:dsh.bundle.patch 指向存在的文件", typeof PATCH === "string" && existsSync(join(root, PATCH)));

// ── 2. 注册阶段:只注册,不产生副作用 ────────────────────────────────────────
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const requireStub = (spec) => {
  if (spec === "react") return reactStub;
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
check("inject 声明客户端服务", Array.isArray(mod.inject) && mod.inject.includes("slots") && mod.inject.includes("locale") && mod.inject.includes("sidebarRightTabs"), `inject=${JSON.stringify(mod.inject)}`);
check(
  "样式随物化注入且带插件归属",
  styleTags.length === 1 && styleTags[0].dataset.plugin === PACKAGE_ID && typeof styleTags[0].dataset.pluginCss === "string" && styleTags[0].textContent.includes(".tgk-root"),
  `tags=${styleTags.length}`,
);

// ── 3. apply(ctx):座位与 tab 类型 ────────────────────────────────────────────
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
  locale,
};

try {
  mod.apply(ctx);
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
check("注册顺序:类型先于座位", tabTypes.length === 1 && seats.length === 2);
const zhKeys = Object.keys(dictsByNs.get(NS)?.zh ?? {}).sort();
const enKeys = Object.keys(dictsByNs.get(NS)?.en ?? {}).sort();
check("zh/en 字典逐键对照", zhKeys.length > 0 && zhKeys.join(",") === enKeys.join(","), `zh=${zhKeys.length} en=${enKeys.length}`);

// ── 4. 宿主半边:服务骨架,且 1.1 边界内不含网络/凭据面 ──────────────────────
const hostMod = await import(pathToFileURL(join(root, HOST_ENTRY)).href);
const provided = new Map();
const hostLogs = [];
hostMod.apply({ provide: (key, value) => provided.set(key, value), logger: { info: (message) => hostLogs.push(message) } }, {});
const service = provided.get("githubKanban");
check("宿主半边注册 githubKanban 服务", service !== undefined);
check("宿主服务自述为骨架阶段", service?.describe?.().stage === "skeleton");
check("宿主服务不含网络/凭据面(1.1 边界)", service !== undefined && Object.keys(service).sort().join(",") === "describe,key,version", Object.keys(service ?? {}).join(","));
check("宿主 inject 为空(cordis.patch.yml 一行 insert)", Array.isArray(hostMod.inject) && hostMod.inject.length === 0);
check("宿主激活留下一条可查日志", hostLogs.length === 1, hostLogs[0] ?? "");

// ── 5. 渲染:两份不同的投影快照 → 不同读数 ──────────────────────────────────
const bodySeat = seats.find((s) => s.seat === "sidebar.right.pane.tab");
const titleSeat = seats.find((s) => s.seat === "sidebar.right.pane.tab.title");
const t = locale.bind(NS);

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) return textOf(node.props?.children);
  return "";
};
const renderBody = (state) =>
  bodySeat.component({
    ...(bodySeat.options.inject ? bodySeat.options.inject() : {}),
    t,
    sessionId: state.sessionId,
    useTabInfo: () => ({ panel: { id: "pane-1" }, tab: { id: "tab-1" } }),
    useSessions: (selector) => selector(state.list),
    useProjection: (key, selector) => selector(key === "modelSelection" ? { next: { model: state.model } } : undefined),
  });

const stateA = {
  sessionId: "s1",
  model: "glm-5.3",
  list: { ids: ["s1"], byId: { s1: { running: true, displayTitle: "看板脚手架" } } },
};
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
const textA = textOf(renderBody(stateA)).replace(/\s+/g, " ").trim();
const textB = textOf(renderBody(stateB)).replace(/\s+/g, " ").trim();
check("面板随投影变化(两份快照读数不同)", textA !== textB && textA.length > 0 && textB.length > 0);
check("读数含会话总数 1→3", textA.includes(" 1 ") && textB.includes(" 3 "));
check("读数含投影模型名", textA.includes("glm-5.3") && textB.includes("deepseek-v4"));
check("读数含当前会话标题", textA.includes("看板脚手架") && textB.includes("Phase 1.2 读链路"));
check("自检区标出本插件占位", textA.includes("sidebar.right.pane.tab + sidebar.right.pane.tab.title"));

const titleText = textOf(titleSeat.component({ t, useSessions: (selector) => selector(stateB.list) })).replace(/\s+/g, " ").trim();
check("title 座位渲染出 chip 且带会话数", titleText.includes("GitHub 看板") && titleText.includes("3"), titleText);

// ── 6. 报告 ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  const mark = result.ok ? "✓" : "✗";
  console.log(`${mark} ${result.label}${result.detail === "" ? "" : `  — ${result.detail}`}`);
}
console.log(`\n投影快照 A:${textA}`);
console.log(`\n投影快照 B:${textB}`);
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
