#!/usr/bin/env node
/**
 * dsh-github-kanban · 加载链路静态自检(零依赖,只用 node 内置模块)。
 *
 * 为什么有它:dsh 的浏览器插件链路只有装进 profile 重启 dsh web 才能真机验证(Phase 1.4),
 * 但契约本身是可以在本地核对的。本脚本按 dsh 0.2.0-rc.2 的加载器/座位/远程契约跑一遍
 * (2026-10-01 对照 rc.2 源码复核,含 SRC 回退与 scoped fiber 取面):
 *   1. package.json:dsh.client 声明、exports["./client"]、bundle patch 齐全;
 *   2. lib/client.js:注册形态正确(load({id, factory}))、id 等于包名、零副作用:
 *      物化时才注入样式,且样式带插件归属;
 *   3. apply(ctx):注册左栏 panellist 入口 + 主区 main 座位(跨会话全局面板),向 ctx.remote.$mount
 *      挂上手写远程清单(3 个 direct 方法,strict 编解码),并经 ctx.inject 的 scoped fiber
 *      捕获 remote.githubKanban 面(入口 inject 含自装服务全名会死锁,见 2026-10-01 真机);
 *   4. lib/index.js:宿主 githubKanban 服务带 typertRemote 绑定 + 原型 Remote 标记;
 *      token 缺失路径不抛堆栈、不泄漏;GraphQL 查询串不含 token;字段映射列序正确;
 *   5. body 组件:投影读数随快照变化;token 引导 / 项目切换 / 分列渲染 / 错误态可交互;
 *   6. 阶段 2(架构与数据契约,2026-10-03):wire 契约对照(S2.6)、查询片段防漂移与
 *      跨 owner 路由/去重(S2.7)、数据完整性口径(S2.5)、状态机与控制器直驱
 *      (S2.2/S2.3,经 mod.internals 不走 React)、畸形响应契约校验(S2.4)、
 *      兜底文案本地化与版本一致性(S2.9)。
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
const PANEL_ID = "github-kanban";
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
/** 最小 React 替身:useState/useEffect/useRef 按 React 语义;同值 setState 不触发重渲染。
 *  阶段 1 扩展(S1.8 用):effect 的 cleanup 返回值被记录,runtime.unmount() 统一执行 ——
 *  真实 React 的「卸载跑全部 cleanup」在这里有了对等入口;effect 重跑间的 cleanup 仍不
 *  执行(那是 R06/阶段 3 换真实 React 环境的活,这里只补卸载路径)。 */
function createMiniReact() {
  let states = [];
  let refs = [];
  let effectDeps = [];
  let effectCleanups = [];
  let hookIndex = 0;
  let render = null;
  let unmounted = false;
  const timers = [];
  const schedule = (fn) => {
    if (unmounted) return; // 卸载后不再调度 effect(对齐真实 React:setState 不再触发渲染)
    timers.push(fn);
  };
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
      schedule(() => {
        const cleanup = fn();
        effectCleanups[i] = cleanup;
      });
    },
  };
  return {
    react: stub,
    /** 回到「未挂载」:下一次 settle 从头初始化 hook 状态。 */
    reset() {
      render = null;
      unmounted = false;
      states = [];
      refs = [];
      effectDeps = [];
      effectCleanups = [];
      hookIndex = 0;
    },
    /** 卸载:逆序执行已登记的 effect cleanup,并屏蔽后续渲染/调度(可再 reset 后重挂载)。 */
    unmount() {
      unmounted = true;
      render = null;
      for (const cleanup of effectCleanups.splice(0).reverse()) {
        if (typeof cleanup === "function") cleanup();
      }
    },
    /** 挂载组件并推进异步链:每轮执行到期的 effect,然后让出事件循环。
     *  同一 runtime 内的后续 settle 保留 hook 状态(供交互:onChange 后继续渲染)。 */
    async settle(component, props, rounds = 8) {
      if (render === null) {
        states = [];
        refs = [];
        effectDeps = [];
        effectCleanups = [];
        hookIndex = 0;
      }
      let tree;
      render = () => {
        if (unmounted) return;
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
// localStorage 桩:__store === null 时禁用(getItem 回 null / setItem no-op),
// 行为等价「沙箱无 localStorage」—— 快照路径自然降级,既有用例不受影响;
// 快照用例里置 {} 启用并预置数据,用完必须还原 null。
const localStorageStub = {
  __store: null,
  getItem(key) {
    return this.__store === null ? null : (this.__store[key] ?? null);
  },
  setItem(key, value) {
    if (this.__store !== null) this.__store[key] = String(value);
  },
  removeItem(key) {
    if (this.__store !== null) delete this.__store[key];
  },
};
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
  // setTimeout 必须真的触发(微任务即刻):瞬态错误重试链(bootstrap 退避 + 错误态 4s 自愈轮)靠它推进
  setTimeout: (fn) => {
    Promise.resolve().then(() => fn());
    return 0;
  },
  clearTimeout: () => {},
  localStorage: localStorageStub,
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
  "inject 声明客户端服务(slots/locale/remote)",
  ["slots", "locale", "remote"].every((s) => mod.inject.includes(s)),
  `inject=${JSON.stringify(mod.inject)}`,
);
check("inject 声明 timer 服务(轮询调度用 client runner 内建 timer Service)", mod.inject.includes("timer"), `inject=${JSON.stringify(mod.inject)}`);
// 死锁回归(真机 2026-10-01 实测):remote.githubKanban 由本插件 apply 里的 $mount 自装,
// 入口激活会先等 inject 里的服务 → apply 永不运行。全名只允许出现在 scoped fiber。
check(
  "入口 inject 禁止声明 remote.githubKanban(自装服务进清单 = 激活死锁)",
  !mod.inject.includes("remote.githubKanban"),
  `inject=${JSON.stringify(mod.inject)}`,
);
check(
  "样式随物化注入且带插件归属",
  styleTags.length === 1 && styleTags[0].dataset.plugin === PACKAGE_ID && typeof styleTags[0].dataset.pluginCss === "string" && styleTags[0].textContent.includes(".tgk-root"),
  `tags=${styleTags.length}`,
);

// ── 3. apply(ctx):座位、全局面板注册、远程清单 ──────────────────────────────
const seats = [];
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
const scopedInjectCalls = [];
/** scoped fiber 捕获的远程面替身:按网关真实契约回信封 {ok:true, value:<业务结果>}(rc.2 实测)。 */
const remoteFaceStub = {
  status: async () => ({ ok: true, value: { ok: true, status: { tokenConfigured: false } } }),
  // moveCard(0.9.0 拖拽写回):成功 { ok: true }(刻意无 value 键,不进信封拆包)
  moveCard: async () => ({ ok: true, value: { ok: true } }),
};
/** 面替身参数数量闸(R2/P1 防漂移):与真网关客户端同严。dsh-api-gateway/lib/client.js
 *  的 prepareInvocation 把「清单形参数量」与实参数量做精确相等比对,数量不符直接抛
 *  "client api: githubKanban/<method> expected N argument(s), got M" —— 替身包一层
 *  同严断言,client 侧回退到 0 实参调用(真机首载必挂)时这里先红。数量口径取自
 *  $mount 清单(与网关客户端计数同源);清单缺席(如 remote 面缺失场景)则透传。 */
const withArgContract = (face) => {
  const descriptorsOfManifest = mountedContributions[0]?.descriptors;
  if (!Array.isArray(descriptorsOfManifest)) return face;
  const arities = new Map(descriptorsOfManifest.map((descriptor) => [descriptor.method, descriptor.parameters.length]));
  const wrapped = {};
  for (const method of Object.keys(face)) {
    const expected = arities.get(method);
    if (typeof face[method] !== "function" || expected === undefined) {
      wrapped[method] = face[method];
      continue;
    }
    wrapped[method] = (...args) => {
      if (args.length !== expected) throw new Error(`client api: githubKanban/${method} expected ${expected} argument(s), got ${args.length}`);
      return face[method](...args);
    };
  }
  return wrapped;
};
// Remote 有界等待(S1.2)的手动定时桩:ctx.timeout 存在时 client 走它;不主动触发
// = deadline 永不到期(快路径自然胜出),fireClientDeadlines() 显式推进超时用例。
const clientDeadlineTimers = [];
const fireClientDeadlines = () => {
  for (const fire of clientDeadlineTimers.splice(0)) fire();
};
const ctx = {
  effect: (callback, label) => {
    effectLabels.push(label);
    return callback();
  },
  // 模拟 cordis 运行时 inject(deps, callback):起一个带 deps 的 fiber 跑 callback。
  // 真实语义是等 remote.githubKanban 被 $mount 装好才运行;替身直接交付面(过参数数量闸)。
  inject: (injectList, callback) => {
    scopedInjectCalls.push([...injectList]);
    callback({ remote: { githubKanban: withArgContract(remoteFaceStub) } });
    return { dispose: () => {} };
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
      throw new Error(`sidebarRightTabs.register 不应再被调用(右栏入口已迁移):${definition?.id}`);
    },
  },
  remote: {
    $mount: async (contribution) => {
      mountedContributions.push(contribution);
      return () => {};
    },
  },
  // timer Service 的 timeout 面:登记不触发,由用例显式 fire(见 fireClientDeadlines)
  timeout: (callback, ms) => {
    clientDeadlineTimers.push(callback);
    return () => {
      const index = clientDeadlineTimers.indexOf(callback);
      if (index >= 0) clientDeadlineTimers.splice(index, 1);
    };
  },
  locale,
};

try {
  await mod.apply(ctx);
} catch (error) {
  die(`apply(ctx) 失败:${error.message}`);
}

check("register 生命周期挂在 ctx.effect 上(文案)", effectLabels.length === 1, effectLabels.join(" | "));
check(
  "注册 2 个座位(左栏 panellist 入口 + 主区 main 页面)",
  seats.length === 2 && [...seats.map((s) => s.seat)].sort().join(",") === "main,sidebar.panellist",
  seats.map((s) => s.seat).join(","),
);
const mainSeat = seats.find((s) => s.seat === "main");
const panellistSeat = seats.find((s) => s.seat === "sidebar.panellist");
check(
  "main 座位绑定 key = 面板 id,locale = 命名空间(与 schedule 同型)",
  mainSeat !== undefined && mainSeat.options.key === PANEL_ID && mainSeat.options.locale === NS,
  `key=${mainSeat?.options?.key}`,
);
const mainInjectProps = mainSeat?.options?.inject?.();
check(
  "main 座位 inject 面提供 identity / board / polling",
  mainInjectProps !== undefined && mainInjectProps.identity?.panelId === PANEL_ID && typeof mainInjectProps.board?.getBoard === "function" && typeof mainInjectProps.polling?.setInterval === "function",
  JSON.stringify(Object.keys(mainInjectProps ?? {})),
);
// 取面通路:boardApi 的 facePromise 必须经 scoped fiber(双名 inject)捕获 remote.githubKanban。
check(
  "取面走 scoped fiber:ctx.inject 以 [remote, remote.githubKanban] 恰好调一次",
  scopedInjectCalls.length === 1 && JSON.stringify(scopedInjectCalls[0]) === JSON.stringify(["remote", "remote.githubKanban"]),
  JSON.stringify(scopedInjectCalls),
);
{
  const wired = await mainInjectProps?.board?.status?.();
  check(
    "boardApi.status() 经 scoped fiber 捕获的远程面返回结果",
    wired?.ok === true && wired.status?.tokenConfigured === false,
    JSON.stringify(wired),
  );
}
check(
  "panellist 注册带 id / order / label(与 Automation tasks 同型,order 20 > 10)",
  panellistSeat !== undefined && panellistSeat.options.id === PANEL_ID && panellistSeat.options.order === 20 && typeof panellistSeat.options.label === "function" && panellistSeat.options.label() === "GitHub 看板",
  `id=${panellistSeat?.options?.id} order=${panellistSeat?.options?.order}`,
);
check("panellist 入口注册不带 key(入口派发走 ctx.layout.selectPanel(id))", panellistSeat !== undefined && panellistSeat.options.key === undefined, `key=${panellistSeat?.options?.key}`);
// 迁移红线:右栏两处注册与 sidebarRightTabs 依赖必须移除干净(源级断言,防回潮)。
{
  const clientSource = readFileSync(join(root, CLIENT_ENTRY), "utf8");
  check(
    "右栏注册已移除且无残留引用(sidebar.right.pane.tab / sidebarRightTabs / ui-sidebar-right)",
    !clientSource.includes("sidebar.right.pane.tab") && !clientSource.includes("sidebarRightTabs") &&
      !JSON.stringify(pkg.dsh?.client?.inject ?? []).includes("dsh-client-ui-sidebar-right"),
    "client.js + package.json 均无残留",
  );
}
const zhKeys = Object.keys(dictsByNs.get(NS)?.zh ?? {}).sort();
const enKeys = Object.keys(dictsByNs.get(NS)?.en ?? {}).sort();
check("zh/en 字典逐键对照", zhKeys.length > 0 && zhKeys.join(",") === enKeys.join(","), `zh=${zhKeys.length} en=${enKeys.length}`);

// 远程清单(差异 3 的浏览器对端)
const contribution = mountedContributions[0];
check("apply 向 ctx.remote.$mount 恰好挂 1 份清单", mountedContributions.length === 1, `count=${mountedContributions.length}`);
check("清单归属本包", contribution?.package === PACKAGE_ID);
const descriptors = Array.isArray(contribution?.descriptors) ? contribution.descriptors : [];
check(
  "远程清单声明 4 个 direct 方法(status/listProjects/getBoard/moveCard,0.9.0 写回上清单)",
  descriptors.length === 4 && descriptors.every((d) => d.namespace === SERVICE_KEY && d.invocation?.kind === "direct") &&
    ["status", "listProjects", "getBoard", "moveCard"].every((m) => descriptors.some((d) => d.method === m)),
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
// 参数数量闸自证(R2/P1):替身与网关客户端 prepareInvocation 同严 —— 0 实参调用
// 声明 1 参的方法必抛(真网关同样拒绝,首载 0 实参曾是真机全挂根因,见 round2-client.md)。
{
  let threw = false;
  try {
    withArgContract({ listProjects: () => ({ ok: true, value: { ok: true, projects: [] } }) }).listProjects();
  } catch {
    threw = true;
  }
  check("面替身参数数量闸与网关同严(0 实参调 1 参方法必抛,1 实参放行)", threw === true);
  let passed = false;
  try {
    passed = withArgContract({ listProjects: (request) => ({ ok: true, value: { ok: true, projects: [] }, request }) }).listProjects({}).ok === true;
  } catch {
    passed = false;
  }
  check("面替身参数数量闸:恰好 1 实参的调用正常放行", passed === true);
  // moveCard(0.9.0)同闸:恰好 1 实参(写回 request)放行,0 实参必抛
  let moveThrew = false;
  try {
    withArgContract({ moveCard: () => ({ ok: true, value: { ok: true } }) }).moveCard();
  } catch {
    moveThrew = true;
  }
  check("面替身参数数量闸:moveCard 0 实参必抛(写回 request 恒 1 实参)", moveThrew === true);
  let movePassed = false;
  try {
    movePassed = withArgContract({ moveCard: (request) => ({ ok: true, value: { ok: true }, request }) }).moveCard({ projectNumber: 7, itemId: "i1", optionId: "o2" }).ok === true;
  } catch {
    movePassed = false;
  }
  check("面替身参数数量闸:moveCard 恰好 1 实参(写回请求)放行", movePassed === true);
  {
    const wired = await mainInjectProps?.board?.moveCard?.({ projectNumber: 1, itemId: "i1", optionId: "o1" });
    check(
      "boardApi.moveCard(request) 经 scoped fiber 捕获的远程面返回写回结果(恰好 1 实参过闸)",
      wired?.ok === true,
      JSON.stringify(wired),
    );
  }
}

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
  // 生产兜底(2026-10-01 真机首验教训):apply() 建服务是空 deps,env 必须回退 process.env。
  {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "smoke-probe-token";
    try {
      const prodShape = new hostMod.GithubKanbanService();
      const withToken = await prodShape.status();
      check(
        "status():空 deps 回退 process.env(置位后 tokenConfigured=true)",
        withToken?.ok === true && withToken.status?.tokenConfigured === true,
        JSON.stringify(withToken),
      );
      let seenAuth = "";
      await hostMod.ghGraphQL("query { viewer { login } }", {}, {
        fetchImpl: async (_url, init) => {
          seenAuth = init.headers.Authorization;
          return { ok: true, json: async () => ({ data: {} }) };
        },
      });
      check(
        "ghGraphQL():空 deps 回退 process.env 取 token,只进 Authorization 头",
        seenAuth === "Bearer smoke-probe-token",
        seenAuth === "Bearer smoke-probe-token" ? "已带探测值(非真实凭据)" : "unexpected",
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  }
}

// GraphQL 请求纯度:token 只进 Authorization 头,查询串与 body 不含 token
{
  const SECRET = "ghp_smoke_secret_value";
  const seen = [];
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { login: "octocat" } } }) };
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

// 仓库级项目(2026-10-01 集成):合并 + 同 id 去重保留仓归属 + closed 过滤 + 缺席仓跳过 + 仓路由
{
  const calls = [];
  const repoBoardPage = {
    data: {
      repository: {
        nameWithOwner: "octocat/hello-world",
        projectV2: {
          id: "pv3", number: 3, title: "Repo Board",
          fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "Done" }] }] },
          items: {
            totalCount: 1, pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "i9",
                content: { title: "仓卡", url: "https://example.com/9" },
                fieldValues: {
                  nodes: [
                    { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "o1", field: { name: "Status" } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    repos: ["octocat/hello-world", "bad repo!!", "octocat/gone"],
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const variables = body.variables;
      // 仓库路径:区分列表查询与看板查询;gone 仓返回 repository:null(不存在/无权限 → 跳过)
      if (variables?.owner !== undefined) {
        if (variables.name === "gone") return { ok: true, status: 200, json: async () => ({ data: { repository: null } }) };
        if (String(body.query).includes("projectV2(number:")) return { ok: true, status: 200, json: async () => repoBoardPage };
        return {
          ok: true, status: 200,
          json: async () => ({
            data: {
              repository: {
                nameWithOwner: "octocat/hello-world",
                projectsV2: {
                  nodes: [
                    { id: "pv2", number: 2, title: "@octocat's untitled project", updatedAt: "2026-09-28T00:00:00Z", closed: false },
                    { id: "pv3", number: 3, title: "Repo Board", updatedAt: "2026-09-30T00:00:00Z", closed: false },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        };
      }
      // viewer 路径:#2(与仓列表重复)+ closed 的 #1
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            viewer: {
              projectsV2: {
                nodes: [
                  { id: "pv2", number: 2, title: "@octocat's untitled project", updatedAt: "2026-09-28T00:00:00Z", closed: false },
                  { id: "pv1", number: 1, title: "Closed Old", updatedAt: "2026-09-27T00:00:00Z", closed: true },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }),
      };
    },
  });
  const st = await service.status();
  check("status():repos 计数 = 合法配置条数(坏格式过滤)", st?.ok === true && st.status?.repos === 2, JSON.stringify(st));
  const list = await service.listProjects();
  check(
    "listProjects:仓级合并 + 同 id 去重保留仓归属 + closed 过滤 + 缺席仓跳过",
    list.ok === true &&
      list.projects.length === 2 &&
      list.projects[0]?.repo === "octocat/hello-world" && list.projects[0]?.number === 3 &&
      list.projects[1]?.repo === "octocat/hello-world" && list.projects[1]?.number === 2 &&
      !list.projects.some((p) => p.number === 1),
    JSON.stringify(list.projects),
  );
  const board = await service.getBoard({ projectNumber: 3, repo: "octocat/hello-world" });
  const boardCall = calls[calls.length - 1];
  check(
    "getBoard:带 repo 走 repository 路径(owner/name 进变量,查询含 repository)",
    board.ok === true &&
      board.board?.columns?.map((c) => c.name).join(",") === "Todo,Done" &&
      boardCall?.variables?.owner === "octocat" && boardCall?.variables?.name === "hello-world" &&
      String(boardCall?.query ?? "").includes("repository("),
    `cols=${board.board?.columns?.map((c) => c.name).join(",")}`,
  );
  const badRepo = await service.getBoard({ projectNumber: 3, repo: "no-slash" });
  check("getBoard:repo 非 owner/name 格式返回 input_invalid", badRepo?.ok === false && badRepo.error?.code === "input_invalid", JSON.stringify(badRepo));
}

// 本地缓存(0.5.0 提速):TTL 命中不打网络、并发去重共享一次拉取、noCache 绕缓存回填
{
  let nowMs = 1_000_000;
  let fetchCount = 0;
  const viewerPage = () => ({
    data: { viewer: { projectsV2: { nodes: [{ id: "p7", number: 7, title: "Alpha", updatedAt: "2026-09-30T00:00:00Z", closed: false }], pageInfo: { hasNextPage: false } } } },
  });
  const boardPage = () => ({
    data: {
      viewer: {
        projectV2: {
          id: "p7", number: 7, title: "Alpha",
          fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
          items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    cache: { now: () => nowMs },
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => (String(body.query).includes("projectV2(number:") ? boardPage() : viewerPage()) };
    },
  });
  await service.listProjects();
  await service.listProjects();
  check("listProjects:TTL 内二连发只打一次网络", fetchCount === 1, `fetch=${fetchCount}`);
  nowMs += 61_000; // 越过默认 projectsTtlMs=60s
  await service.listProjects();
  check("listProjects:TTL 过期后重拉", fetchCount === 2, `fetch=${fetchCount}`);

  await service.getBoard({ projectNumber: 7 });
  await service.getBoard({ projectNumber: 7 });
  check("getBoard:同键 TTL 内二连发只打一次网络", fetchCount === 3, `fetch=${fetchCount}`);
  await service.getBoard({ projectNumber: 7, noCache: true });
  check("getBoard:noCache 绕过缓存强制真拉", fetchCount === 4, `fetch=${fetchCount}`);
  nowMs += 16_000; // 越过默认 boardTtlMs=15s
  await service.getBoard({ projectNumber: 7 });
  check("getBoard:TTL 过期后重拉(noCache 已回填新值)", fetchCount === 5, `fetch=${fetchCount}`);

  // 并发去重:同时发起的两个 listProjects 共享同一次拉取(先推过 TTL 避免直接命中缓存)
  nowMs += 61_000;
  const before = fetchCount;
  await Promise.all([service.listProjects(), service.listProjects()]);
  check("并发去重:同键 in-flight 请求共享一次拉取", fetchCount === before + 1, `fetch=${fetchCount} before=${before}`);
}

// 4i. 应用层超时(S1.2/R02):悬挂 fetch 在期限内退出、底层被 abort、迟到结果无副作用
{
  let releaseFetch;
  const seenSignals = [];
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: "t" },
    requestTimeoutMs: 20,
    fetchImpl: (_url, init) => {
      seenSignals.push(init.signal);
      return new Promise((resolve) => {
        releaseFetch = () => resolve({ ok: true, status: 200, json: async () => ({ data: { viewer: { login: "late" } } }) });
      });
    },
  });
  check(
    "超时:悬挂 fetch 按期限返回结构化 timeout 错误(不悬挂调用方)",
    result.ok === false && result.error?.code === "timeout" && result.error.message.includes("已放弃等待"),
    JSON.stringify(result),
  );
  check("超时:底层请求收到 abort(signal.aborted = true)", seenSignals[0] instanceof AbortSignal && seenSignals[0].aborted === true, `aborted=${seenSignals[0]?.aborted}`);
  // 迟到的响应在超时后才到达:必须被吞掉(进程不因 unhandled rejection 崩溃,结果不变)
  releaseFetch();
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("超时:迟到响应被忽略(结果保持 timeout,无未处理拒绝)", result.error?.code === "timeout", JSON.stringify(result));
}

// 4j. 响应体悬挂同样有界(S1.2 验收矩阵「响应体悬挂」)
{
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: "t" },
    requestTimeoutMs: 20,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  });
  check(
    "超时:响应体读取悬挂按期限返回 timeout(错误信息区分阶段)",
    result.ok === false && result.error?.code === "timeout" && result.error.message.includes("响应体读取"),
    JSON.stringify(result),
  );
}

// 4k. in-flight 生命周期(S1.3/R02):超时也清理对应条目,后续请求发起新拉取且可恢复
{
  let fetchCount = 0;
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    requestTimeoutMs: 20,
    fetchImpl: () => {
      fetchCount += 1;
      return new Promise(() => {}); // 每次都悬挂
    },
  });
  const first = await service.listProjects();
  check(
    "in-flight:全部来源超时聚合为 timeout 错误(可读,不是笼统失败)",
    first.ok === false && first.error?.code === "timeout",
    JSON.stringify(first),
  );
  check("in-flight:请求 settle(含超时)后条目出队(不残留悬挂 Promise)", service.cache.inflight.size === 0, `size=${service.cache.inflight.size}`);
  const second = await service.listProjects();
  check("in-flight:悬挂超时后可恢复 —— 再次调用发出新请求,不复用旧 Promise", second.error?.code === "timeout" && fetchCount === 2, `fetch=${fetchCount}`);
}

// 4l. 项目列表局部失败(S1.4/R03):单仓失败保留成功来源 + 来源级警告;全失败明确失败
{
  const repoProjects = (label) => ({
    data: {
      repository: {
        nameWithOwner: label,
        projectsV2: {
          nodes: [{ id: `pv-${label}`, number: 3, title: `${label} Board`, updatedAt: "2026-09-30T00:00:00Z", closed: false }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  });
  const viewerPage = () => ({
    data: { viewer: { projectsV2: { nodes: [{ id: "pv-viewer", number: 1, title: "Viewer Board", updatedAt: "2026-09-29T00:00:00Z", closed: false }], pageInfo: { hasNextPage: false } } } },
  });
  const makeFetch = (behavior) => {
    const calls = [];
    return {
      calls,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        const outcome = behavior(body);
        if (outcome === "viewer") return { ok: true, status: 200, json: async () => viewerPage() };
        if (typeof outcome === "object") return { ok: true, status: 200, json: async () => outcome };
        return outcome;
      },
    };
  };
  // 场景 1:一个仓 GraphQL 报错,另一个仓 + viewer 正常 → 列表保留成功来源 + 警告
  {
    const harness = makeFetch((body) => {
      if (body.variables?.owner === undefined) return "viewer";
      if (body.variables.name === "bad") return { errors: [{ message: "Repo exploded" }] };
      if (body.variables.name === "gone") return { data: { repository: null } }; // 不存在/无权限 → 缺席
      return repoProjects("octocat/ok");
    });
    const service = new hostMod.GithubKanbanService({ env: { GITHUB_TOKEN: "t" }, repos: ["octocat/bad", "octocat/gone", "octocat/ok"], fetchImpl: harness.fetchImpl });
    const list = await service.listProjects();
    const warningSources = (list.warnings ?? []).map((warning) => `${warning.source}[${warning.code}]`);
    check(
      "局部失败:单仓 GraphQL 错误/缺席不拖垮列表,成功来源保留 + 来源级警告",
      list.ok === true &&
        list.projects.length === 2 &&
        list.projects.some((project) => project.repo === "octocat/ok") &&
        list.projects.some((project) => project.repo === undefined) &&
        warningSources.join(",") === "octocat/bad[graphql_error],octocat/gone[repo_missing]",
      `ok=${list.ok} projects=${list.projects?.length} warnings=${warningSources.join(",")}`,
    );
  }
  // 场景 2:viewer 失败但仓库来源成功 → 仍返回仓库项目 + viewer 警告
  {
    const harness = makeFetch((body) => (body.variables?.owner === undefined ? { errors: [{ message: "viewer down" }] } : repoProjects("octocat/ok")));
    const service = new hostMod.GithubKanbanService({ env: { GITHUB_TOKEN: "t" }, repos: ["octocat/ok"], fetchImpl: harness.fetchImpl });
    const list = await service.listProjects();
    check(
      "局部失败:viewer 失败时仓库项目保留,viewer 进警告",
      list.ok === true && list.projects.length === 1 && list.projects[0]?.repo === "octocat/ok" && list.warnings?.[0]?.source === "viewer",
      JSON.stringify({ n: list.projects?.length, warnings: list.warnings }),
    );
  }
  // 场景 3:所有来源都失败 → 明确失败,绝不伪装成空列表
  {
    const harness = makeFetch(() => ({ errors: [{ message: "everything down" }] }));
    const service = new hostMod.GithubKanbanService({ env: { GITHUB_TOKEN: "t" }, repos: ["octocat/a"], fetchImpl: harness.fetchImpl });
    const list = await service.listProjects();
    check(
      "局部失败:全来源失败返回 all_sources_failed(含来源清单),不是 ok+空列表",
      list.ok === false && list.error?.code === "all_sources_failed" && list.error.message.includes("viewer") && list.error.message.includes("octocat/a") && list.projects === undefined,
      JSON.stringify(list),
    );
  }
}

// 4m. 看板缓存容量(S1.9):LRU 按写入序淘汰最旧,有明确容量边界
{
  const boardPage = (number) => ({
    data: { viewer: { projectV2: { id: `p${number}`, number, title: `B${number}`, fields: { nodes: [] }, items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } },
  });
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    cache: { maxBoards: 2 },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => boardPage(body.variables.number) };
    },
  });
  await service.getBoard({ projectNumber: 1 });
  await service.getBoard({ projectNumber: 2 });
  await service.getBoard({ projectNumber: 3 }); // 超容量:最旧的 #1 被淘汰
  check("缓存:boards 上限生效(maxBoards=2 → 恰好 2 块)", service.cache.boards.size === 2, `size=${service.cache.boards.size}`);
  check("缓存:淘汰最旧写入(#1 出局,#2/#3 在册)", service.cache.boards.has("#1") === false && service.cache.boards.has("#2") && service.cache.boards.has("#3"), [...service.cache.boards.keys()].join(","));
}

// 4n. 缓存身份隔离(S1.9):token 轮换后旧身份数据不命中(TTL 内也强制重拉)
{
  const env = { GITHUB_TOKEN: "identity-A" };
  let fetchCount = 0;
  const viewerPage = () => ({ data: { viewer: { projectsV2: { nodes: [{ id: "p1", number: 1, title: "A 的项目", updatedAt: "2026-09-30T00:00:00Z", closed: false }], pageInfo: { hasNextPage: false } } } } });
  const boardPage = () => ({ data: { viewer: { projectV2: { id: "p1", number: 1, title: "A 的项目", fields: { nodes: [] }, items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } });
  const service = new hostMod.GithubKanbanService({
    env,
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => (String(body.query).includes("projectV2(number:") ? boardPage() : viewerPage()) };
    },
  });
  await service.listProjects();
  await service.getBoard({ projectNumber: 1 });
  env.GITHUB_TOKEN = "identity-B"; // 同一进程内换身份(如撤权后换 PAT)
  const listAfter = await service.listProjects();
  const boardAfter = await service.getBoard({ projectNumber: 1 });
  check(
    "缓存:token 轮换后 TTL 内不命中旧身份数据(列表与看板都真拉)",
    fetchCount === 4 && listAfter.ok === true && boardAfter.ok === true,
    `fetch=${fetchCount}`,
  );
}

// 4o. 强制刷新与普通请求并发(S1.9):先发起的慢请求不得覆盖后发起强刷写入的新数据
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const boardPage = (column) => ({
    data: { viewer: { projectV2: { id: "p7", number: 7, title: "Alpha", fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: column }] }] }, items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } },
  });
  let call = 0;
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        await sleep(80); // 先发起的普通请求:慢,返回旧数据
        return { ok: true, status: 200, json: async () => boardPage("OldCol") };
      }
      await sleep(5); // 后发起的强刷:快,返回新数据
      return { ok: true, status: 200, json: async () => boardPage("NewCol") };
    },
  });
  const slow = service.getBoard({ projectNumber: 7 }); // 普通请求先发起
  await sleep(20);
  const fast = service.getBoard({ projectNumber: 7, noCache: true }); // 强刷后发起
  await fast;
  await slow; // 旧请求最后返回
  const cached = await service.getBoard({ projectNumber: 7 }); // TTL 内应读缓存
  check(
    "缓存:旧请求不回退强刷新数据(缓存里是 NewCol,不是 OldCol)",
    cached.ok === true && cached.board?.columns?.[0]?.name === "NewCol",
    `col=${cached.board?.columns?.[0]?.name}`,
  );
}

// 4p. listProjects 强刷参数(S1.6):noCache 绕过 TTL,供「刷新=整链重拉」使用
{
  let nowMs = 1_000_000;
  let fetchCount = 0;
  const viewerPage = () => ({ data: { viewer: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    cache: { now: () => nowMs },
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, json: async () => viewerPage() };
    },
  });
  await service.listProjects();
  await service.listProjects({ noCache: true });
  check("listProjects:noCache 绕过 TTL 强制真拉(TTL 内也发出第 2 次请求)", fetchCount === 2, `fetch=${fetchCount}`);
}

// ── S2.6 wire 契约兼容检查:宿主标记/绑定与 protocol·gateway 规则逐项对照 ──────
// 规则来源(只读核验,2026-10-03):@deepseek-ai/dsh 0.2.0-rc.2 的
// dsh-typert-protocol mark()/bindTypertRemote()、dsh-api-gateway 的
// resolveSrcDescriptor/methodParameterNames/assertExactArguments、
// dsh-typert-registry 客户端 validateInvocation。
{
  const SEGMENT = /^[A-Za-z0-9_$.-]+$/;
  const isSegment = (value) => typeof value === "string" && value !== "." && value !== ".." && SEGMENT.test(value);
  // 1) 原型标记描述符:version 1 + 每个 marker 冻结为 {method, invocation:{kind:"direct"}}
  //    (protocol 对 exportName===method、非流式恰好省略这两个键,多写反而与官方形状不符)
  const markerOk = remoteMarkers.methods.every((marker) =>
    Object.isFrozen(marker) &&
    JSON.stringify(Object.keys(marker)) === JSON.stringify(["method", "invocation"]) &&
    Object.isFrozen(marker.invocation) &&
    JSON.stringify(marker.invocation) === JSON.stringify({ kind: "direct" }),
  );
  check(
    "wire 契约(S2.6):宿主 Remote 标记与 protocol mark() 产出逐字段一致(键序/冻结/direct)",
    remoteMarkers.version === 1 && markerOk,
    JSON.stringify(remoteMarkers.methods[0]),
  );
  // 2) 绑定:service 自指 + serviceKey/namespace 可作 RPC 端点段(gateway readBinding 校验)
  check(
    "wire 契约(S2.6):typertRemote 绑定满足 gateway readBinding(namespace 是合法端点段)",
    Object.isFrozen(service.typertRemote) && service.typertRemote.service === service && isSegment(service.typertRemote.serviceKey) && isSegment(service.typertRemote.namespace),
    JSON.stringify({ serviceKey: service.typertRemote?.serviceKey, namespace: service.typertRemote?.namespace }),
  );
  // 3) 方法签名:简单标识符参数(gateway 用 Function.toString 解析参数名 → wire 字段名)
  const wireParamsOk = ["status", "listProjects", "getBoard", "moveCard"].every((method) => {
    const source = Object.getPrototypeOf(service)[method].toString();
    const body = source.slice(source.indexOf("(") + 1, source.indexOf(")")).trim();
    return body === "" ? method === "status" : body === "request";
  });
  check("wire 契约(S2.6):四个 Remote 方法都是简单标识符参数(wire 字段名 = 参数名;0.9.0 起 moveCard 同型)", wireParamsOk, "status→无参,listProjects/getBoard/moveCard→request");
  check(
    "wire 契约(S2.6):宿主 moveCard 标记在册(0.9.0 写回;宿主半边由并行线程交付)",
    remoteMarkers.methods.some((marker) => marker.method === "moveCard"),
    JSON.stringify(remoteMarkers.methods.map((marker) => marker.method)),
  );
  // 4) 浏览器侧清单:对照 dsh-typert-registry 客户端 validateInvocation 的规则镜像
  const descriptorRulesOk = descriptors.every((descriptor) =>
    typeof descriptor.id === "string" && descriptor.id.length > 0 && // id 只要求非空(客户端 registry)
    isSegment(descriptor.service) && isSegment(descriptor.namespace) && isSegment(descriptor.method) &&
    descriptor.invocation.kind === "direct" &&
    descriptor.parameters.every((parameter) => isSegment(parameter.name) && isSegment(parameter.wire) && parameter.source === "json") &&
    descriptor.result.mode === "strict" && typeof descriptor.result.typeSymbol === "string" && typeof descriptor.result.create === "function" &&
    descriptor.parameters.every((parameter) => parameter.codec.mode === "strict" && typeof parameter.codec.typeSymbol === "string" && typeof parameter.codec.create === "function"),
  );
  check(
    "wire 契约(S2.6):浏览器侧清单满足 registry 客户端 validateInvocation 的形状规则",
    descriptorRulesOk,
    descriptors.map((d) => d.method).join(","),
  );
  // 5) 返回信封拆包依据:本包业务结果从不带 value 键(否则 {ok,value} 拆包会误伤)
  {
    const sample = await service.status();
    check("wire 契约(S2.6):业务结果不带 value 键(信封拆包约定成立)", !("value" in sample), JSON.stringify(Object.keys(sample ?? {})));
  }
}

// ── S2.7 查询片段防漂移:viewer 与 repository 两套查询共享同一份字段集 ──────────
{
  /** 取「锚点后的首个 {...} 平衡选择集」的原文(空白归一),用于逐字比对。 */
  const selectionAfter = (query, anchor) => {
    const open = query.indexOf("{", query.indexOf(anchor));
    let depth = 0;
    for (let i = open; i < query.length; i += 1) {
      if (query[i] === "{") depth += 1;
      if (query[i] === "}") {
        depth -= 1;
        if (depth === 0) return query.slice(open + 1, i).replace(/\s+/g, " ").trim();
      }
    }
    return "";
  };
  const q = hostMod.graphqlQueries;
  check(
    "查询片段(S2.7):viewer 与 repository 看板查询的 projectV2 选择集逐字一致",
    selectionAfter(q.boardPage, "projectV2(number: $number)") === selectionAfter(q.repoBoardPage, "projectV2(number: $number)") &&
      selectionAfter(q.boardPage, "projectV2(number: $number)").includes("fieldValues(first: 30)"),
    selectionAfter(q.boardPage, "projectV2(number: $number)").slice(0, 60),
  );
  check(
    "查询片段(S2.7):viewer 与 repository 项目列表的 projectsV2 选择集逐字一致",
    selectionAfter(q.projects, "projectsV2(") === selectionAfter(q.repoProjects, "projectsV2("),
    selectionAfter(q.projects, "projectsV2("),
  );
  check(
    "查询片段(S2.7):fieldValues/users/labels 带 pageInfo{hasNextPage}(字段值截断可观测,S2.5)",
    q.boardPage.includes("fieldValues(first: 30) {\n            pageInfo { hasNextPage }") ||
      (q.boardPage.match(/fieldValues\(first: 30\) \{\s*pageInfo \{ hasNextPage \}/) !== null &&
        q.boardPage.match(/users\(first: 10\) \{ pageInfo \{ hasNextPage \}/) !== null &&
        q.boardPage.match(/labels\(first: 20\) \{ pageInfo \{ hasNextPage \}/) !== null),
    "三个连接都请求 hasNextPage",
  );
}

// ── S2.7 路由与去重:跨 owner 同编号、同一项目关联多仓、缓存键隔离 ──────────────
{
  const repoProjectsPage = (repoLabel, entries) => ({
    data: { repository: { nameWithOwner: repoLabel, projectsV2: { nodes: entries, pageInfo: { hasNextPage: false } } } },
  });
  const viewerProjectsPage = (entries) => ({ data: { viewer: { projectsV2: { nodes: entries, pageInfo: { hasNextPage: false } } } } });
  const boardPageFor = (repoLabel) => ({
    data: {
      repository: {
        nameWithOwner: repoLabel,
        projectV2: {
          id: `pv-${repoLabel}`, number: 3, title: `${repoLabel} #3`,
          fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
          items: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ id: `i-${repoLabel}`, content: { title: `${repoLabel} 的卡` }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "o1", field: { name: "Status" } }] } }] },
        },
      },
    },
  });
  const viewerBoardPage = {
    data: { viewer: { projectV2: { id: "pv-viewer-3", number: 3, title: "Viewer #3", fields: { nodes: [] }, items: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } },
  };
  const calls = [];
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    repos: ["octocat/alpha", "octocat/beta"],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const variables = body.variables;
      if (variables?.owner === undefined) {
        // viewer 列表:自己的 #3(用户级);viewer 看板 #3
        return { ok: true, status: 200, json: async () => (String(body.query).includes("projectV2(number:") ? viewerBoardPage : viewerProjectsPage([{ id: "pv-viewer-3", number: 3, title: "Viewer #3", updatedAt: "2026-09-28T00:00:00Z", closed: false }])) };
      }
      const repo = `${variables.owner}/${variables.name}`;
      if (String(body.query).includes("projectV2(number:")) return { ok: true, status: 200, json: async () => boardPageFor(repo) };
      // octocat/beta 的 #3 与 octocat/alpha 的 #3 是**不同项目**(不同 id);beta 还 link 了 alpha 的 #9(同 id 多仓)
      const entries = repo === "octocat/alpha"
        ? [{ id: "pv-alpha-3", number: 3, title: "Alpha #3", updatedAt: "2026-09-29T00:00:00Z", closed: false }, { id: "pv-shared-9", number: 9, title: "Shared #9", updatedAt: "2026-09-27T00:00:00Z", closed: false }]
        : [{ id: "pv-beta-3", number: 3, title: "Beta #3", updatedAt: "2026-09-30T00:00:00Z", closed: false }, { id: "pv-shared-9", number: 9, title: "Shared #9", updatedAt: "2026-09-27T00:00:00Z", closed: false }];
      return { ok: true, status: 200, json: async () => repoProjectsPage(repo, entries) };
    },
  });
  const list = await service.listProjects();
  const keys = list.projects.map((project) => `${project.repo ?? ""}#${project.number}`);
  check(
    "路由去重(S2.7):跨 owner 同编号不互撞(viewer#3 / alpha#3 / beta#3 三个独立条目)",
    list.ok === true && keys.join(",") === "octocat/beta#3,octocat/alpha#3,#3,octocat/beta#9" && new Set(keys).size === 4,
    keys.join(","),
  );
  check(
    "路由去重(S2.7):同一项目(id)link 到多仓只留一条,仓归属 = 配置序靠后(beta 覆盖 alpha)",
    list.projects.length === 4 && list.projects.some((project) => project.id === "pv-shared-9" && project.repo === "octocat/beta") && !list.projects.some((project) => project.id === "pv-shared-9" && project.repo === "octocat/alpha"),
    JSON.stringify(list.projects.find((project) => project.id === "pv-shared-9")),
  );
  // 路由:getBoard 按 repo 走对应 owner 域;缓存键含 repo,两块看板互不覆盖
  const alphaBoard = await service.getBoard({ projectNumber: 3, repo: "octocat/alpha" });
  const betaBoard = await service.getBoard({ projectNumber: 3, repo: "octocat/beta" });
  const viewerBoard = await service.getBoard({ projectNumber: 3 });
  const routed = [calls.slice(-3)[0]?.variables, calls.slice(-2)[0]?.variables, calls.slice(-1)[0]?.variables];
  check(
    "路由去重(S2.7):同编号 #3 按 repo 路由到 alpha/beta/viewer 三条路径(变量/查询各自正确)",
    alphaBoard.ok === true && betaBoard.ok === true && viewerBoard.ok === true &&
      routed[0]?.owner === "octocat" && routed[0]?.name === "alpha" &&
      routed[1]?.owner === "octocat" && routed[1]?.name === "beta" &&
      routed[2]?.owner === undefined && String(calls.slice(-1)[0]?.query).includes("viewer"),
    JSON.stringify(routed),
  );
  check(
    "路由去重(S2.7):看板内容按来源区分(alpha/beta/viewer 各是各的卡,不错配)",
    alphaBoard.board.columns[0].items[0].title === "octocat/alpha 的卡" &&
      betaBoard.board.columns[0].items[0].title === "octocat/beta 的卡" &&
      viewerBoard.board.project.id === "pv-viewer-3",
    `${alphaBoard.board.columns[0].items[0].title} | ${betaBoard.board.columns[0].items[0].title}`,
  );
  check(
    "路由去重(S2.7):缓存键含 repo —— 跨 owner 同编号两块看板同时在册,互不覆盖",
    service.cache.boards.has("octocat/alpha#3") && service.cache.boards.has("octocat/beta#3") && service.cache.boards.has("#3") &&
      service.cache.boards.get("octocat/alpha#3")?.value?.board?.columns?.[0]?.items?.[0]?.title === "octocat/alpha 的卡",
    [...service.cache.boards.keys()].join(","),
  );
}

// ── S2.5 数据完整性口径:items 分页上限 / 字段值截断 / 项目列表上限 ──────────────
{
  // 场景 1:items 永远 hasNextPage 且服务端不报 totalCount → 拉满 200 条后停,
  // 必须显式 incomplete(不假称全量);fetchedCount = 200。
  const makeBoardJson = ({ totalCount, hasNextPage }) => ({
    data: {
      viewer: {
        projectV2: {
          id: "p7", number: 7, title: "Alpha",
          fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
          items: {
            ...(totalCount === undefined ? {} : { totalCount }),
            pageInfo: { hasNextPage, endCursor: hasNextPage ? "c" : undefined },
            nodes: Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, content: { title: `卡${i}` }, fieldValues: { nodes: [] } })),
          },
        },
      },
    },
  });
  {
    let boardCalls = 0;
    const service = new hostMod.GithubKanbanService({
      env: { GITHUB_TOKEN: "t" },
      fetchImpl: async (_url, init) => {
        boardCalls += 1;
        return { ok: true, status: 200, json: async () => makeBoardJson({ totalCount: undefined, hasNextPage: boardCalls < 10 }) };
      },
    });
    const result = await service.getBoard({ projectNumber: 7 });
    check(
      "完整性(S2.5):items 拉满上限且无服务端总数 → incomplete=true(不假称全量),fetchedCount=200",
      result.ok === true && result.incomplete === true && result.fetchedCount === 200 && result.totalCount === 200 && boardCalls === 4,
      `calls=${boardCalls} fetched=${result.fetchedCount} incomplete=${result.incomplete}`,
    );
  }
  // 场景 2:服务端总数已知且大于已取数 → 不需要 incomplete(客户端走「已加载 X / Y」口径)
  {
    const service = new hostMod.GithubKanbanService({
      env: { GITHUB_TOKEN: "t" },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => makeBoardJson({ totalCount: 500, hasNextPage: true }) }),
    });
    const result = await service.getBoard({ projectNumber: 7 });
    check(
      "完整性(S2.5):服务端总数可自证不完整(500 > 200)→ 不另加 incomplete,totalCount=500",
      result.ok === true && result.incomplete === undefined && result.totalCount === 500 && result.fetchedCount === 200,
      `total=${result.totalCount} fetched=${result.fetchedCount} incomplete=${result.incomplete}`,
    );
  }
  // 场景 3:字段值连接 hasNextPage → board.fieldValuesTruncated 计数(可观测,不无声丢弃)
  {
    const service = new hostMod.GithubKanbanService({
      env: { GITHUB_TOKEN: "t" },
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({
          data: {
            viewer: {
              projectV2: {
                id: "p7", number: 7, title: "Alpha",
                fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
                items: {
                  totalCount: 3, pageInfo: { hasNextPage: false },
                  nodes: [
                    { id: "i1", content: { title: "值超页" }, fieldValues: { pageInfo: { hasNextPage: true }, nodes: [] } },
                    { id: "i2", content: { title: "标签超页" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: "L1" }] } }] } },
                    { id: "i3", content: { title: "正常" }, fieldValues: { nodes: [] } },
                  ],
                },
              },
            },
          },
        }),
      }),
    });
    const result = await service.getBoard({ projectNumber: 7 });
    check(
      "完整性(S2.5):字段值/标签达单页上限 → fieldValuesTruncated 计数(2 张卡被点名)",
      result.ok === true && result.board.fieldValuesTruncated === 2,
      `fieldValuesTruncated=${result.board.fieldValuesTruncated}`,
    );
  }
  // 场景 4:项目列表来源翻页到页数上限仍有下一页 → 来源级 projects_truncated 警告
  {
    let projectCalls = 0;
    const service = new hostMod.GithubKanbanService({
      env: { GITHUB_TOKEN: "t" },
      fetchImpl: async () => {
        projectCalls += 1;
        return {
          ok: true, status: 200,
          json: async () => ({ data: { viewer: { projectsV2: { nodes: [{ id: `p${projectCalls}`, number: projectCalls, title: `P${projectCalls}`, updatedAt: "2026-09-29T00:00:00Z", closed: false }], pageInfo: { hasNextPage: true, endCursor: "c" } } } } }),
        };
      },
    });
    const list = await service.listProjects();
    const truncationWarnings = (list.warnings ?? []).filter((warning) => warning.code === "projects_truncated");
    check(
      "完整性(S2.5):项目列表拉满 10 页仍有下一页 → projects_truncated 来源警告 + 数据照常返回",
      list.ok === true && list.projects.length === 10 && projectCalls === 10 && truncationWarnings.length === 1 && truncationWarnings[0]?.source === "viewer",
      `projects=${list.projects?.length} calls=${projectCalls} warnings=${JSON.stringify(truncationWarnings)}`,
    );
  }
}

// 卡片内容不可读自诊断(2026-10-01 真机):content null 计数进 board.contentMissing
{
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    fetchImpl: async (url, init) => ({
      ok: true, status: 200,
      json: async () => ({
        data: {
          viewer: {
            projectV2: {
              id: "p7", number: 7, title: "Alpha",
              fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo" }] }] },
              items: {
                totalCount: 2, pageInfo: { hasNextPage: false },
                nodes: [
                  { id: "i1", content: null, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "o1", field: { name: "Status" } }] } },
                  { id: "i2", content: { title: "正常卡" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "o1", field: { name: "Status" } }] } },
                ],
              },
            },
          },
        },
      }),
    }),
  });
  const result = await service.getBoard({ projectNumber: 7 });
  check(
    "getBoard:content 为 null 的卡计数进 board.contentMissing(权限缺口自诊断)",
    result?.ok === true && result.board?.contentMissing === 1 && result.totalCount === 2,
    `contentMissing=${result.board?.contentMissing}`,
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
          { __typename: "ProjectV2ItemFieldUserValue", field: { name: "Assignees" }, users: { nodes: [{ login: "octocat" }] } },
          { __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { nodes: [{ name: "P1", color: "ff8800" }] } },
        ],
      },
    },
    { id: "i2", content: { title: "待办卡" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "opt_todo", field: { name: "Status" } }] } },
    { id: "i3", content: { title: "无 Status 的卡" }, fieldValues: { nodes: [] } },
  ];
  const mapped = hostMod.mapBoard({ project, itemNodes });
  const columns = mapped.board.columns;
  check(
    "映射:列序 = Status 选项序(Todo → In Progress → Done,末列兜底)",
    columns.map((c) => c.name).join("→") === "Todo→In Progress→Done→" && columns[3]?.fallback === "unfiled" && columns[3]?.name === "",
    columns.map((c) => `${c.name || `[${c.fallback ?? "?"}]`}`).join(","),
  );
  check("映射:空列(Done)也保留", columns[2].items.length === 0);
  check("映射:未分列的卡落到兜底列", columns[3]?.optionId === null && columns[3].fallback === "unfiled" && columns[3].items.some((i) => i.id === "i3"), JSON.stringify(columns[3]));
  const card = columns[1].items[0];
  check("映射:卡片三要素(标题/负责人/标签)", card.title === "设计 brief 评审" && card.assignees.join(",") === "octocat" && card.labels[0]?.name === "P1", JSON.stringify(card));
  check("映射:optionId 归列正确(i1 → In Progress)", columns[1].items.length === 1 && columns[0].items.length === 1);
  const noField = hostMod.mapBoard({ project: { ...project, statusField: null }, itemNodes: [] });
  check("映射:缺 Status 字段退化为单列兜底(fallback=all,显示名由浏览器词典出)", noField.board.hasStatusField === false && noField.board.columns.length === 1 && noField.board.columns[0].fallback === "all" && noField.board.columns[0].name === "");
  const untitled = hostMod.mapBoard({ project, itemNodes: [{ id: "i9", content: null, fieldValues: { nodes: [] } }] });
  const untitledCard = untitled.board.columns.find((column) => column.fallback === "unfiled")?.items[0];
  check("映射:无标题卡带 untitled 标记(title 空串,显示名由浏览器词典出)", untitledCard?.untitled === true && untitledCard?.title === "");
}

// 4e. statusFieldHint 纯函数:四个口径(缺失提示用,不再无声退化)
{
  check(
    "statusFieldHint:not_found / possibly_renamed / fields_truncated / 已找到=null",
    hostMod.statusFieldHint([], false) === "not_found" &&
      hostMod.statusFieldHint([{ name: "State", options: [] }], false) === "possibly_renamed" &&
      hostMod.statusFieldHint(Array.from({ length: 40 }, (_, i) => ({ name: `f${i}` })), false) === "fields_truncated" &&
      hostMod.statusFieldHint([{ name: "Status", options: [] }], true) === null,
    JSON.stringify([hostMod.statusFieldHint([], false), hostMod.statusFieldHint([{ name: "State", options: [] }], false)]),
  );
}

// 4f. getBoard 集成:Status 改名 → hint + 单列;totalCount 口径 = 服务端 items.totalCount
{
  const fields = [{ id: "f_state", name: "State", options: [{ id: "o1", name: "A" }] }];
  const service = new hostMod.GithubKanbanService({
    env: { GITHUB_TOKEN: "t" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { viewer: { projectV2: { id: "p1", number: 7, title: "Alpha", fields: { nodes: fields }, items: { totalCount: 12, pageInfo: { hasNextPage: false }, nodes: [] } } } } }),
    }),
  });
  const result = await service.getBoard({ projectNumber: 7 });
  check(
    "getBoard:Status 改名 → possibly_renamed 提示 + 单列兜底(fallback=all)+ totalCount=12 / fetchedCount=0",
    result.ok === true && result.board.hasStatusField === false && result.board.statusFieldHint === "possibly_renamed" &&
      result.board.columns.length === 1 && result.board.columns[0].fallback === "all" && result.totalCount === 12 && result.fetchedCount === 0,
    JSON.stringify({ hint: result.board?.statusFieldHint, total: result.totalCount, fetched: result.fetchedCount }),
  );
}

// 4g. sanitizeError 单遍 redact:token 出现两次也全量替换(R4 遗留 P2:双遍冗余已改单遍,行为不变)
{
  const SECRET = "ghp_repeat_secret_value";
  const result = await hostMod.ghGraphQL("query { viewer { login } }", {}, {
    env: { GITHUB_TOKEN: SECRET },
    fetchImpl: async () => {
      throw new Error(`a ${SECRET} b ${SECRET} c`);
    },
  });
  const text = result.error?.message ?? "";
  check(
    "sanitizeError:token 出现两次时单遍即净(两处 [redacted],无残留)",
    result.ok === false && !text.includes(SECRET) && text.split("[redacted]").length - 1 === 2,
    text,
  );
}

// 4h. mapBoard 守卫:畸形节点不抛不崩,坏项跳过 / 落兜底列
{
  const project = { id: "p1", number: 7, title: "Alpha", statusField: { id: "f", name: "Status", options: [{ id: "o1", name: "Todo" }] } };
  const itemNodes = [
    null,
    "junk",
    42,
    { id: "bad1", content: null, fieldValues: { nodes: [null, "x", { __typename: "ProjectV2ItemFieldLabelValue", field: { name: "Labels" }, labels: { nodes: "not-array" } }] } },
    { id: "ok1", content: { title: "正常卡" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "o1", field: { name: "Status" } }] } },
  ];
  const mapped = hostMod.mapBoard({ project, itemNodes });
  const noProject = hostMod.mapBoard({ project: null, itemNodes: [] });
  check(
    "mapBoard:畸形节点(非对象项/坏 fieldValues)不抛,坏项落兜底列、好卡归列",
    mapped.ok === true && mapped.board.columns[0].items.length === 1 && mapped.board.columns[0].items[0].id === "ok1" &&
      mapped.board.columns.some((column) => column.fallback === "unfiled" && column.items.some((item) => item.id === "bad1")),
    JSON.stringify(mapped.board.columns.map((column) => [column.name || column.fallback, column.items.length])),
  );
  check(
    "mapBoard:project 为 null 时兜底不抛(单列「全部」+ 占位元信息)",
    noProject.ok === true && noProject.board.hasStatusField === false && noProject.board.project.title === "(未命名项目)",
    JSON.stringify(noProject.board.project),
  );
}

// ── 5. 渲染:mini hook 运行时驱动真实异步数据流 ──────────────────────────────
const bodySeat = mainSeat; // 看板 body 现挂在 main 座位(视觉零改动迁移)
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

/** 面板通用 props:座位 hook 替身 + 投影快照;polling 缺席时组件不轮询(替身注入可控 timer)。 */
const makeProps = (state, boardApi, identity, polling) => ({
  t,
  sessionId: state.sessionId,
  useTabInfo: () => ({ panel: { id: "pane-1" }, tab: { id: "tab-1" } }),
  useSessions: (selector) => selector(state.list),
  useProjection: (key, selector) => selector(key === "modelSelection" ? { next: { model: state.model } } : undefined),
  identity: identity ?? { packageId: PACKAGE_ID, ns: NS, panelId: PANEL_ID, seats: ["sidebar.panellist", "main"], remote: true },
  board: boardApi,
  polling,
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
    { optionId: "opt_doing", name: "In Progress", items: [{ id: "i1", title: "设计 brief 评审", url: "https://example.com/1", assignees: ["octocat"], labels: [{ name: "P1", color: "ff8800" }], statusOptionId: "opt_doing" }] },
    { optionId: "opt_done", name: "Done", items: [] },
  ],
};

// 5a. 面板纯净化(0.6.0):链路自检/读数/节拍等调试区移除;标准 props 缺席也不崩
{
  const stateA = { sessionId: "s1", model: "glm-5.3", list: { ids: ["s1"], byId: { s1: { running: true, displayTitle: "看板脚手架" } } } };
  const textA = textOf(await settleFresh(bodySeat.component, makeProps(stateA, undefined))).replace(/\s+/g, " ").trim();
  check(
    "面板:链路自检/投影读数/渲染节拍/占位说明等调试区已移除",
    !textA.includes("链路自检") && !textA.includes("渲染节拍") && !textA.includes("本插件占位") && !textA.includes("会话总数") && !textA.includes("渲染节拍"),
    textA.slice(0, 90),
  );
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.6.0" } }),
    listProjects: async () => ({ ok: true, projects: [] }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  const { useTabInfo: _ti, useProjection: _pj, ...rootProps } = makeProps(stateB, boardApi);
  const textRoot = textOf(await settleFresh(bodySeat.component, rootProps)).replace(/\s+/g, " ").trim();
  check("面板:标准 props(hook)缺席时正常渲染不崩", textRoot.includes(t("panelTitle")), textRoot.slice(0, 70));
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
  check("看板:切换器是 select 且默认选第一个项目(复合键 #N)", select !== undefined && select.props.value === "#7", `value=${select?.props?.value}`);
  const columns = findAll(tree, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-column"));
  const columnNames = columns.map((column) => textOf(column).split("空")[0].trim().match(/^(Todo|In Progress|Done)/)?.[1]);
  check("看板:列渲染顺序 = Status 选项序(Todo → In Progress → Done)", columnNames.join(",") === "Todo,In Progress,Done", columnNames.join(","));
  const emptyMark = columns[2] !== undefined && textOf(columns[2]).includes("空");
  check("看板:空列(Done)也显示并标注「空」", emptyMark === true, textOf(columns[2] ?? "").trim());
  const cardText = textOf(columns[1]);
  check("看板:卡片含标题 + 标签(P1)", cardText.includes("设计 brief 评审") && cardText.includes("P1"), cardText.replace(/\s+/g, " "));
  // 0.9.0:负责人渲染为头像(assigneeDetails 在场 → img[alt=login];缺席 → 首字母圆点)
  {
    const detailBoard = { ...sampleBoard, columns: [{ ...sampleBoard.columns[1], items: [{ ...sampleBoard.columns[1].items[0], assigneeDetails: [{ login: "octocat", avatarUrl: "https://example.com/octocat.png" }] }] }] };
    const detailApi = { ...boardApi, getBoard: async () => ({ ok: true, board: detailBoard }) };
    const detailTree = await settleFresh(bodySeat.component, makeProps(stateB, detailApi));
    const avatarImg = findAll(detailTree, (node) => node.type === "img" && node.props?.className === "tgk-avatar")[0];
    check("看板(0.9.0):assigneeDetails 在场 → 20px 圆形头像 img(alt=login,loading lazy)", avatarImg !== undefined && avatarImg.props.alt === "octocat" && avatarImg.props.loading === "lazy" && avatarImg.props.src === "https://example.com/octocat.png", JSON.stringify(avatarImg?.props ?? null));
    const stringAssignee = findAll(tree, (node) => typeof node.props?.className === "string" && node.props.className.includes("tgk-avatarFallback"))[0];
    check("看板(0.9.0):assignees 仅 string(旧宿主形状)→ 首字母圆点退化(title=login)", stringAssignee !== undefined && stringAssignee.props.title === "octocat" && textOf(stringAssignee) === "O", JSON.stringify(stringAssignee?.props ?? null));
  }
  check("看板:初拉默认项目 #7", getCalls.length === 1 && getCalls[0]?.projectNumber === 7, JSON.stringify(getCalls));

  if (select === undefined) {
    check("看板:切换器可交互(select 在场)", false, "select 缺席,无法模拟切换");
  } else {
    select.props.onChange({ target: { value: "#9" } });
    await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  }
  check("看板:切换到 #9 后重拉 getBoard({projectNumber:9})", getCalls.some((r) => r?.projectNumber === 9), JSON.stringify(getCalls));
}

// 5c1b. 仓库级项目(2026-10-01 集成):切换器带仓标签,选中键 owner/name#N,getBoard 透传 repo
{
  const getCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 3, version: "0.4.0" } }),
    listProjects: async () => ({
      ok: true,
      projects: [
        { id: "p1", number: 7, title: "Alpha" },
        { id: "p11", number: 11, title: "Repo Board", repo: "octocat/Spoon-Knife" },
      ],
    }),
    getBoard: async (request) => {
      getCalls.push(request);
      return { ok: true, board: sampleBoard };
    },
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("看板:仓库级项目选项带 · owner/name 标签", text.includes("#11 Repo Board · octocat/Spoon-Knife"), text.match(/#[\d]+[^•]{0,60}/g)?.join(" | "));
  const select = findFirst(tree, (node) => node.type === "select");
  const repoOption = select !== undefined ? findAll(select, (node) => node.type === "option" && node.props?.value === "octocat/Spoon-Knife#11")[0] : undefined;
  check("看板:仓库级选项值是复合键 owner/name#N", repoOption !== undefined, `value=${repoOption?.props?.value}`);
  if (select !== undefined && repoOption !== undefined) {
    select.props.onChange({ target: { value: "octocat/Spoon-Knife#11" } });
    await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  }
  check("看板:切到仓库级项目后 getBoard 透传 repo", getCalls.some((r) => r?.projectNumber === 11 && r?.repo === "octocat/Spoon-Knife"), JSON.stringify(getCalls));
}

// 5c1d. 卡片内容不可读提示:board.contentMissing > 0 时面板给出 token 权限指引
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 3, version: "0.5.1" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => ({
      ok: true,
      board: {
        project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, contentMissing: 17,
        columns: [{ optionId: "o1", name: "Todo", items: [{ id: "a1", title: "(无标题)", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }],
      },
      totalCount: 17,
    }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check(
    "看板:contentMissing 提示列多种可能原因(权限缺口 + 已删除/不可见),不只归因 PAT 权限(S2.8)",
    text.includes("读不到标题") && text.includes("17") && text.includes("Read-only") &&
      text.includes("可能原因") && text.includes("已被删除"),
    text.match(/有 \d+ 张卡读不到[^。]{0,120}/)?.[0] ?? "",
  );
}

// 5c1c. 本地偏好(S1.1/R01 重设计,0.8.0):只持久化选择键;旧 snapshot/v1 被清理;
//       本地不再有任何看板业务数据可上屏(同 origin 换身份不可能看到旧身份卡片)。
{
  localStorageStub.__store = {};
  const LEGACY_KEY = `${PACKAGE_ID}/snapshot/v1`;
  const PREFS_KEY = `${PACKAGE_ID}/prefs/v1`;
  // 预置旧版整板快照(模拟升级场景:里面是"旧身份"的卡片)+ 新版选择偏好 #9
  localStorageStub.__store[LEGACY_KEY] = JSON.stringify({
    savedAt: 1,
    projects: [{ id: "p9", number: 9, title: "Beta" }],
    selectedKey: "#9",
    board: { project: { id: "p9", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "s1", name: "SnapColumn", items: [{ id: "s1i", title: "旧身份的卡", url: undefined, assignees: [], labels: [], statusOptionId: "s1" }] }] },
    totalCount: 1,
  });
  localStorageStub.__store[PREFS_KEY] = JSON.stringify({ savedAt: Date.now(), selectedKey: "#9" });
  const getCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 3, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p9", number: 9, title: "Beta" }] }),
    getBoard: async (request) => {
      getCalls.push(request);
      return { ok: true, board: { project: { id: "p9", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "f1", name: "FreshColumn", items: [{ id: "f1i", title: "新卡", url: undefined, assignees: [], labels: [], statusOptionId: "f1" }] }] }, totalCount: 1 };
    },
  };
  try {
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check("偏好:选中延续(初拉打的是偏好选中项 #9 而非列表第一项)", getCalls[0]?.projectNumber === 9, JSON.stringify(getCalls));
    check("隐私:旧 snapshot/v1 被清理(localStorage 不再保留整板快照)", localStorageStub.__store[LEGACY_KEY] === undefined, `legacy=${localStorageStub.__store[LEGACY_KEY] ?? "已清除"}`);
    check("隐私:旧快照的卡片/列名不上屏(无本地业务数据可恢复)", !text.includes("旧身份的卡") && !text.includes("SnapColumn") && text.includes("FreshColumn"), text.match(/(Fresh|Snap)Column/)?.[0] ?? "");
    const stored = JSON.parse(localStorageStub.__store[PREFS_KEY] ?? "{}");
    check(
      "偏好:写回仅含 { savedAt, selectedKey, theme }(0.9.0 起带 UI 主题偏好),不含项目列表/看板/计数",
      Object.keys(stored).sort().join(",") === "savedAt,selectedKey,theme,v" && stored.selectedKey === "#9" && stored.v === 2,
      `keys=${Object.keys(stored).join(",")}`,
    );
  } finally {
    localStorageStub.__store = null; // 还原禁用,不影响后续用例
  }
}

// 5c1c2. 偏好到期校验:过期(或时钟畸形)的选择不延续,回退列表第一项
{
  localStorageStub.__store = {};
  const PREFS_KEY = `${PACKAGE_ID}/prefs/v1`;
  localStorageStub.__store[PREFS_KEY] = JSON.stringify({ savedAt: 1, selectedKey: "#9" }); // 1970 年存的,早已过期
  const getCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 0, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p9", number: 9, title: "Beta" }] }),
    getBoard: async (request) => {
      getCalls.push(request);
      return { ok: true, board: sampleBoard };
    },
  };
  try {
    await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    check("偏好:过期(savedAt 超出 30 天窗口)不延续,回退列表第一项", getCalls[0]?.projectNumber === 7, JSON.stringify(getCalls));
  } finally {
    localStorageStub.__store = null;
  }
}

// 5c1e. 瞬态连接错误(gateway/internal / Failed to fetch)自动重试自愈(0.7.0)
{
  // 前两次 status 报连接未就绪,第三次成功 → 面板最终渲染看板而非钉死错误态
  let statusCalls = 0;
  const boardApi = {
    status: async () => {
      statusCalls += 1;
      if (statusCalls <= 2) return { ok: false, error: { code: "gateway/internal", message: "client api: githubKanban/status failed: Failed to fetch" } };
      return { ok: true, status: { tokenConfigured: true, repos: 3, version: "0.9.0" } };
    },
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => ({ ok: true, board: sampleBoard, totalCount: 2 }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("瞬态错误:status 两次连接未就绪后第三次成功,面板恢复渲染看板", text.includes("Todo") && text.includes("设计 brief 评审"), `statusCalls=${statusCalls}`);
  check("瞬态错误:重试期间不残留错误态/重试提示", !text.includes("读取失败") && !text.includes("自动重试"), text.match(/(读取失败|自动重试)[^。]{0,40}/)?.[0] ?? "");
  check("瞬态错误:bootstrap 链内确有重试(status 被调 ≥3 次)", statusCalls >= 3, `statusCalls=${statusCalls}`);
}

// 5c1f. 瞬态错误持续失败 → 错误态 + 自动重试提示,重试轮真实发生(有 15 轮封顶,settle 可结束)
{
  let statusCalls = 0;
  const boardApi = {
    status: async () => {
      statusCalls += 1;
      return { ok: false, error: { code: "gateway/internal", message: "client api: githubKanban/status failed: Failed to fetch" } };
    },
    listProjects: async () => ({ ok: true, projects: [] }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi), 90);
  const text = textOf(tree);
  check("瞬态错误:持续失败显示错误态 + 自动重试提示", text.includes("读取失败") && text.includes("自动重试"), text.match(/(读取失败|自动重试)[^。]{0,50}/)?.[1] ?? "");
  check("瞬态错误:错误态自愈轮真实发生(status 被调多次)", statusCalls >= 5, `statusCalls=${statusCalls}`);
}

// 5c1f2. 重试上限(R04 回归):status 成功但列表持续瞬态失败 —— 旧实现在 status 成功后
//        就把计数归零,自动重试永不停止;这里断言达上限后调用数不再增长。
{
  let statusCalls = 0;
  const boardApi = {
    status: async () => {
      statusCalls += 1;
      return { ok: true, status: { tokenConfigured: true, repos: 3, version: "0.9.0" } };
    },
    listProjects: async () => ({ ok: false, error: { code: "gateway/internal", message: "client api: githubKanban/listProjects failed: Failed to fetch" } }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  let tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi), 90);
  const text = textOf(tree);
  check("重试上限(R04):status 成功但列表持续失败时显示错误态 + 自动重试提示", text.includes("读取失败") && text.includes("自动重试"), text.match(/(读取失败|自动重试)[^。]{0,50}/)?.[1] ?? "");
  check("重试上限(R04):错误态自愈轮真实发生(status 被调多次)", statusCalls >= 5, `statusCalls=${statusCalls}`);
  const capped = statusCalls;
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 30);
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 30);
  check("重试上限(R04):达上限后自动重试停止,再推进也不新增请求", statusCalls === capped && textOf(tree).includes("读取失败"), `capped=${capped} now=${statusCalls}`);
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
  // 注:错误态保留切换器/刷新按钮属 R4 遗留 P2,1.3 轮已修(见 5g 用例)。
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
  select.props.onChange({ target: { value: "#9" } }); // 先点 #9(慢)
  const tree2 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const select2 = findFirst(tree2, (node) => node.type === "select");
  select2.props.onChange({ target: { value: "#7" } }); // 再点 #7(快,#7 先回,#9 后回)
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
  select.props.onChange({ target: { value: "#9" } }); // selected=#9 不在当前 options 里
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

// ── 5e–5h. TODO 1.3:轮询 / 可见性 / 错误态工具栏 / totalCount 口径 ─────────

/** 手动 tick 的轮询替身:setInterval 只登记回调,由用例显式推进(不依赖真实 30s)。 */
const makePolling = (isVisible = () => true) => {
  const registered = [];
  return {
    polling: { intervalMs: 30_000, setInterval: (callback, ms) => { registered.push({ callback, ms }); return () => registered.pop(); }, isVisible },
    ticks: () => { for (const { callback } of [...registered]) callback(); },
    count: () => registered.length,
  };
};

// 5e. 轮询触发重拉:tick 到期 → remote getBoard 再次发生且新数据进投影;inFlight 时不叠发
{
  const boardV1 = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title: "网页端改的旧标题", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] };
  const boardV2 = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title: "网页端改的新标题", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] };
  const getCalls = [];
  let pending = null; // 挂起第 2 次 getBoard 的返回,用于构造 inFlight 窗口
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async (request) => {
      getCalls.push(request);
      if (pending !== null) return pending.promise;
      return { ok: true, board: getCalls.length === 1 ? boardV1 : boardV2, totalCount: 1 };
    },
  };
  const { polling, ticks } = makePolling();
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling));
  check("轮询:初次挂载后 1 次 getBoard(项目 #7),且已注册 1 个轮询定时器", getCalls.length === 1 && getCalls[0]?.projectNumber === 7, JSON.stringify(getCalls));
  // 第 1 个 tick:拉到新看板
  ticks();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 12);
  check("轮询:tick 到期后再次调用 getBoard({projectNumber:7})", getCalls.length === 2 && getCalls[1]?.projectNumber === 7, JSON.stringify(getCalls));
  check("轮询:重拉的新标题进投影(网页端改卡,面板跟上)", textOf(tree).includes("网页端改的新标题") && !textOf(tree).includes("网页端改的旧标题"), textOf(tree).match(/网页端改的(新|旧)标题/)?.[0]);
  // 第 2 个 tick:getBoard 挂起未回(inFlight),再 tick 两次都不得叠发
  pending = { promise: new Promise(() => {}) };
  ticks(); // 发起第 3 次请求,永不返回 → inFlight 恒真
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 4);
  ticks();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 4);
  check("轮询:上一轮请求未回(inFlight)时 tick 不叠发(仍只有 3 次调用)", getCalls.length === 3, `getBoard 次数=${getCalls.length}`);
}

// 5f. 不可见时跳过本轮 = 暂停,可见后恢复;polling 缺席(props 不传)时组件不轮询不报错
{
  const board = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [] }] };
  const getCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async (request) => { getCalls.push(request); return { ok: true, board }; },
  };
  let visible = false; // 右栏折叠(aria-hidden)→ isVisible() = false
  const { polling, ticks } = makePolling(() => visible);
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling));
  ticks();
  await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 4);
  check("可见性:不可见期间 tick 被跳过(不发起 getBoard)", getCalls.length === 1, `getBoard 次数=${getCalls.length}`);
  visible = true; // 展开右栏
  ticks();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 8);
  check("可见性:回到可见后下一 tick 恢复轮询(getBoard=2)", getCalls.length === 2 && textOf(tree).includes("Alpha"), `getBoard 次数=${getCalls.length}`);
  // polling 缺席:props 不传 → 不轮询也不报错(旧 props / 降级路径)
  miniReact.reset();
  const bareTree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const bareText = textOf(bareTree);
  check("polling 缺席:组件正常渲染看板(空态文案)、无错误态、不发起轮询(只 +1 次初始拉取)", bareText.includes("该项目还没有看板条目") && !bareText.includes("读取失败") && getCalls.length === 3, `getBoard 次数=${getCalls.length}`);
}

// 5g. 错误态保留工具栏(R4 遗留 P2 修复):切换器与刷新按钮在场可操作
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
    getBoard: async () => ({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } }),
  };
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  const select = findFirst(tree, (node) => node.type === "select");
  const reload = findFirst(tree, (node) => node.type === "button" && String(node.props?.className).includes("tgk-reload"));
  check("错误态:切换器仍在场且可操作(value=#7)", select !== undefined && select.props.value === "#7" && typeof select.props.onChange === "function", `value=${select?.props?.value}`);
  check("错误态:刷新按钮仍在场(文案「刷新」,非禁用)", reload !== undefined && textOf(reload).includes("刷新") && reload.props.disabled !== true, textOf(reload ?? ""));
  check("错误态:错误文案与工具栏同屏共存", text.includes("读取失败") && text.includes("[http_error]") && text.includes("#7 Alpha") && text.includes("#9 Beta"), text.match(/读取失败[^•]*/)?.[0]?.slice(0, 60));
  // 刷新按钮可操作:点击后重发 getBoard
  reload.props.onClick();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 8);
  check("错误态:点刷新按钮重发 getBoard(错误态可重试)", textOf(tree).includes("读取失败") && textOf(tree).includes("#7 Alpha"), "");
}

// 5h. totalCount 口径:服务端口径在场时展示全量,缺席时退回列合计
{
  const board = sampleBoard; // 列合计 = 2(待办卡 + 设计 brief 评审)
  const boardApi = (withTotal) => ({
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.2.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => withTotal ? { ok: true, board, totalCount: 12 } : { ok: true, board },
  });
  const treeServer = await settleFresh(bodySeat.component, makeProps(stateB, boardApi(true)));
  const textServer = textOf(treeServer);
  check("totalCount:服务端口径在场时展示「共 12 张卡」+ 截断提示「已加载 2 / 12 张」", textServer.includes("共 12 张卡") && textServer.includes("已加载 2 / 12 张"), textServer.match(/共\s*\d+\s*张卡|已加载[^•]*/g)?.join(" | "));
  const treeLocal = await settleFresh(bodySeat.component, makeProps(stateB, boardApi(false)));
  const textLocal = textOf(treeLocal);
  check("totalCount:口径缺席时退回列合计「共 2 张卡」且无截断提示", textLocal.includes("共 2 张卡") && !textLocal.includes("已加载"), textLocal.match(/共\s*\d+\s*张卡|已加载[^•]*/g)?.join(" | "));
}

// 5i. 首载列表失败且无快照(R05 回归):错误态必须有恢复入口;刷新 = 整链重拉(列表+看板)
{
  const listCalls = [];
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async (request) => {
      listCalls.push(request);
      if (listCalls.length === 1) return { ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } };
      return { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] };
    },
    getBoard: async () => ({ ok: true, board: sampleBoard, totalCount: 2 }),
  };
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 12);
  let text = textOf(tree);
  const buttons = findAll(tree, (node) => node.type === "button" && String(node.props?.className ?? "").includes("tgk-reload"));
  check(
    "首载失败(R05):列表 503 时错误态在场且有可操作的刷新按钮(非瞬态不自动重试;主题切换按钮不计入恢复入口)",
    text.includes("读取失败") && text.includes("[http_error]") && buttons.length === 1 && buttons[0].props.disabled !== true && listCalls.length === 1,
    `reloadButtons=${buttons.length} listCalls=${listCalls.length}`,
  );
  // 防御式交互:旧实现(无恢复按钮)在这里应表现为上方用例失败,而不是脚本崩溃
  if (buttons[0] !== undefined) buttons[0].props.onClick();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 12);
  text = textOf(tree);
  check(
    "首载失败(R05):点刷新整链重拉 —— listProjects 带 noCache,成功后渲染看板",
    listCalls.length === 2 && listCalls[1]?.noCache === true && text.includes("Todo") && !text.includes("读取失败"),
    `calls=${JSON.stringify(listCalls)}`,
  );
}

// 5j. 空项目状态(S1.6):同样给恢复入口;项目新增后刷新可拉到
{
  let mode = "empty";
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => (mode === "empty" ? { ok: true, projects: [] } : { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  let text = textOf(tree);
  const reload = findFirst(tree, (node) => node.type === "button" && String(node.props?.className).includes("tgk-reload"));
  check("空项目:显示「没有可显示的项目」且刷新按钮在场可操作", text.includes("viewer 名下没有") && reload !== undefined && reload.props.disabled !== true, text.slice(0, 90));
  mode = "added";
  if (reload !== undefined) reload.props.onClick();
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 12);
  text = textOf(tree);
  check("空项目:刷新后新增项目进列表并渲染看板", text.includes("#7 Alpha") && text.includes("Todo"), text.slice(0, 90));
}

// 5j2. 空项目 + 来源失败/截断(R2):「暂无项目」分支也要显示来源警告 —— 只在看板区
// 渲染会把失败藏进空态文案,用户无从知道有来源读失败(与 5k 的非空列表路径对照)。
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => ({
      ok: true,
      projects: [],
      warnings: [
        { source: "octocat/gone", code: "repo_missing", message: "skip" },
        { source: "viewer", code: "projects_truncated", message: "项目数达到分页上限(300)" },
      ],
    }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check(
    "空项目(R2):来源失败/截断警告在「暂无项目」分支同样可见(点名来源)",
    text.includes("viewer 名下没有") && text.includes("部分项目来源读取失败") && text.includes("octocat/gone") &&
      text.includes("列表可能不完整") && text.includes("viewer"),
    text.slice(0, 120),
  );
}

// 5k. 来源级警告展示(S1.4):局部失败时列表照常,警告行点名失败来源
{
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => ({
      ok: true,
      projects: [{ id: "p1", number: 7, title: "Alpha" }],
      warnings: [
        { source: "octocat/bad", code: "graphql_error", message: "boom" },
        { source: "octocat/gone", code: "repo_missing", message: "skip" },
      ],
    }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check(
    "来源警告:单来源失败时看板照常渲染,警告行点名来源",
    text.includes("部分项目来源读取失败") && text.includes("octocat/bad") && text.includes("octocat/gone") && text.includes("Todo"),
    text.match(/部分项目来源读取失败[^。]{0,60}/)?.[0] ?? "",
  );
}

// 5l. 轮询期调用超时(S1.2):错误可读、inFlight 复位,后续恢复
{
  const boardV1 = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title: "超时前的旧标题", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] };
  const boardV2 = { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title: "恢复后的新标题", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] };
  let calls = 0;
  let mode = "timeout-after-first"; // 第 2 次起持续超时,测试显式切回恢复
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => {
      calls += 1;
      if (calls >= 2 && mode === "timeout-after-first") {
        return { ok: false, error: { code: "remote_timeout", message: "githubKanban.getBoard 调用超过 20000ms 未返回,已放弃等待;迟到的结果会被忽略,点「刷新」或等下一轮轮询即可重试。" } };
      }
      return { ok: true, board: calls === 1 ? boardV1 : boardV2, totalCount: 1 };
    },
  };
  const { polling, ticks } = makePolling();
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling));
  ticks(); // 第 2 次拉取:超时错误
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 10);
  const timeoutText = textOf(tree);
  check("轮询超时:错误态显示 remote_timeout 结构化文案(错误可读)", timeoutText.includes("[remote_timeout]") && timeoutText.includes("已放弃等待"), timeoutText.match(/读取失败[^\n]{0,60}/)?.[0] ?? "");
  mode = "recover";
  ticks(); // inFlight 已复位:恢复拉取
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 10);
  check("轮询超时:超时后 inFlight 复位,再次拉取恢复并渲染新数据", textOf(tree).includes("恢复后的新标题") && !textOf(tree).includes("超时前的旧标题"), `calls=${calls}`);
}

// 5m. 加载期间不把旧内容当新项目内容(S1.7):切换后、回包前是加载态而非旧项目看板
{
  const boards = {
    7: { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "AlphaColumn", items: [{ id: "a1", title: "Alpha 的卡", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] },
    9: { project: { id: "p2", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "o2", name: "BetaColumn", items: [{ id: "b1", title: "Beta 的卡", url: undefined, assignees: [], labels: [], statusOptionId: "o2" }] }] },
  };
  const gate = { pending: null }; // 非 null 时 #9 的回包被拦住
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
    getBoard: async ({ projectNumber }) => {
      if (projectNumber === 9 && gate.pending !== null) await gate.pending.promise;
      return { ok: true, board: boards[projectNumber] };
    },
  };
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const firstText = textOf(tree);
  check("一致性门控:初拉 #7 正常渲染", firstText.includes("AlphaColumn"), firstText.slice(0, 60));
  // 切到 #9 且拦住回包:期间不得显示 #7 的旧看板
  gate.pending = { resolve: null };
  gate.pending.promise = new Promise((resolve) => {
    gate.pending.resolve = resolve;
  });
  const select = findFirst(tree, (node) => node.type === "select");
  select.props.onChange({ target: { value: "#9" } });
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 4);
  const midText = textOf(tree);
  check("一致性门控:加载新项目期间旧看板退位(显示读取中,不冒充新项目内容)", midText.includes("正在读取") && !midText.includes("AlphaColumn"), midText.slice(0, 80));
  gate.pending.resolve(); // 放行 #9 回包
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 10);
  check("一致性门控:回包后展示当前项目的看板", textOf(tree).includes("BetaColumn") && !textOf(tree).includes("AlphaColumn"), textOf(tree).match(/(Alpha|Beta)Column/g)?.join(","));
}

// 5n. 卸载清理(S1.8):轮询注册释放、迟到回包不重渲染;重开面板可恢复
{
  const gate = { pending: null };
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
    getBoard: async () => {
      if (gate.pending !== null) await gate.pending.promise; // 挂起指定次数的回包
      return { ok: true, board: sampleBoard, totalCount: 2 };
    },
  };
  const { polling, ticks, count } = makePolling();
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling));
  check("卸载前:轮询已注册且看板已渲染", count() >= 1 && textOf(tree).includes("Todo"), `count=${count()}`);
  // 发起一个会被拦住的轮询请求,然后卸载
  gate.pending = { resolve: null };
  gate.pending.promise = new Promise((resolve) => {
    gate.pending.resolve = resolve;
  });
  ticks();
  await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 2);
  miniReact.unmount();
  check("卸载:轮询定时器注册被释放(关闭面板后不再调度)", count() === 0, `count=${count()}`);
  gate.pending.resolve(); // 迟到的回包到达
  await new Promise((resolve) => setTimeout(resolve, 5)); // 让微任务链跑完(不经过 settle = 不重挂载)
  ticks();
  check("卸载:迟到回包不重注册轮询、不抛错", count() === 0, `count=${count()}`);
  // 重新打开面板:reset 后重挂载可恢复
  miniReact.reset();
  gate.pending = null;
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi, undefined, polling), 12);
  check("重开:重新挂载后恢复拉取并重新注册轮询", count() >= 1 && textOf(tree).includes("Todo"), `count=${count()}`);
}

// 5o. 手动重试语义(S1.5/S1.6):自愈成功后手动刷新重置预算;持续失败再次按上限停止
{
  let statusCalls = 0;
  let listCalls = 0;
  let mode = "recover"; // 前 2 次 list 瞬态失败后恢复;手动刷新后永远失败
  const transientFail = () => ({ ok: false, error: { code: "gateway/internal", message: "client api: githubKanban/listProjects failed: Failed to fetch" } });
  const boardApi = {
    status: async () => {
      statusCalls += 1;
      return { ok: true, status: { tokenConfigured: true, version: "0.9.0" } };
    },
    listProjects: async () => {
      listCalls += 1;
      if (mode === "recover" && listCalls <= 2) return transientFail();
      if (mode === "fail") return transientFail();
      return { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] };
    },
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  miniReact.reset();
  let tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 40);
  check("预算:链内容忍 2 次瞬态失败后完整启动成功(渲染看板)", textOf(tree).includes("Todo") && listCalls >= 3, `listCalls=${listCalls}`);
  const recovered = statusCalls;
  mode = "fail";
  const reload = findFirst(tree, (node) => node.type === "button" && String(node.props?.className).includes("tgk-reload"));
  if (reload !== undefined) reload.props.onClick(); // 手动刷新:预算重置;此后持续失败要重新累计到 15 轮上限
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 90);
  const capped = statusCalls;
  check("预算:手动刷新后持续失败会重新自动重试(不是立即放弃)", capped > recovered && textOf(tree).includes("读取失败"), `${recovered} → ${capped}`);
  tree = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi), 30);
  check("预算:手动刷新后的新一轮自动重试仍按 15 轮上限停止(不无界)", statusCalls === capped, `capped=${capped} now=${statusCalls}`);
}

// 5p. apply 级 boardApi 有界等待(S1.2/R02):挂载/取面/调用悬挂都在期限内退出,迟到结果忽略
{
  const applyWithStubs = async (stubs) => {
    const deadliners = [];
    const localSeats = [];
    const ctx2 = {
      effect: (callback) => callback(),
      inject: (injectList, callback) => {
        if (stubs.hangFace !== true) callback({ remote: { githubKanban: withArgContract(stubs.face ?? {}) } });
        return { dispose: () => {} };
      },
      slots: {
        inject: (seat, factory) => factory(),
        register: (options, component) => {
          localSeats.push({ options, component });
          return () => {};
        },
      },
      remote: { $mount: () => (stubs.hangMount === true ? new Promise(() => {}) : Promise.resolve(() => {})) },
      locale,
      ...(stubs.noCtxTimeout === true
        ? {}
        : {
            timeout: (callback) => {
              deadliners.push(callback);
              return () => {
                const index = deadliners.indexOf(callback);
                if (index >= 0) deadliners.splice(index, 1);
              };
            },
          }),
    };
    await mod.apply(ctx2);
    const seat = localSeats.find((s) => s.options.key === PANEL_ID);
    return {
      boardApi: seat.options.inject().board,
      fire: () => {
        for (const fire of deadliners.splice(0)) fire();
      },
    };
  };
  // 场景 1:$mount 永不返回 → 挂载 deadline 退出
  {
    const { boardApi, fire } = await applyWithStubs({ hangMount: true, face: {} });
    const outcome = boardApi.status();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让链推进到挂载等待(只有挂载定时器在册)
    fire();
    const result = await outcome;
    check("有界等待:$mount 挂起 → remote_timeout(不再永久等待挂载)", result.ok === false && result.error?.code === "remote_timeout" && result.error.message.includes("挂载"), JSON.stringify(result));
  }
  // 场景 2:scoped fiber 永不交付面 → 取面 deadline 退出
  {
    const { boardApi, fire } = await applyWithStubs({ hangFace: true });
    const outcome = boardApi.status();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 挂载定时器已注销,只剩取面定时器
    fire();
    const result = await outcome;
    check("有界等待:远程面就绪挂起 → remote_timeout", result.ok === false && result.error?.code === "remote_timeout", JSON.stringify(result));
  }
  // 场景 3:方法调用悬挂 → 调用 deadline;迟到回包被忽略(结果不变、无未处理拒绝)
  {
    let lateResolve;
    const face = {
      status: () =>
        new Promise((resolve) => {
          lateResolve = resolve;
        }),
    };
    const { boardApi, fire } = await applyWithStubs({ face });
    const outcome = boardApi.status();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 挂载/取面定时器已注销,face.status 已被调用
    fire();
    const result = await outcome;
    lateResolve({ ok: true, value: { ok: true, status: { tokenConfigured: true } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    check(
      "有界等待:调用悬挂 → remote_timeout(点名方法),迟到回包不覆盖已返回结果",
      result.ok === false && result.error?.code === "remote_timeout" && result.error.message.includes("githubKanban.status"),
      JSON.stringify(result),
    );
  }
  // 场景 4:快路径不受 deadline 影响(不触发定时器即不超时)
  {
    const face = { status: async () => ({ ok: true, value: { ok: true, status: { tokenConfigured: true } } }) };
    const { boardApi } = await applyWithStubs({ face });
    const result = await boardApi.status();
    check("有界等待:正常路径不受 deadline 影响(定时器不触发即不超时)", result.ok === true && result.status?.tokenConfigured === true, JSON.stringify(result));
  }
  // 场景 5:宿主无 ctx.timeout 时回退全局定时器(沙箱里即刻触发 → 悬挂调用立刻按期限退出)
  {
    const face = { status: () => new Promise(() => {}) };
    const { boardApi } = await applyWithStubs({ face, noCtxTimeout: true });
    const result = await boardApi.status();
    check("有界等待:无 ctx.timeout 时回退全局定时器,悬挂调用仍按期限退出", result.ok === false && result.error?.code === "remote_timeout", JSON.stringify(result));
  }
}

// ── 5q. S2.3 状态机纯函数:单一 phase 字段 + 显式转换(不经 React 直接驱动) ────
{
  const { BOARD_PHASES: P, boardTransition, initialBoardState } = mod.internals;
  let state = initialBoardState();
  check("状态机(S2.3):初始态 phase=idle、无错误、无看板", state.phase === P.IDLE && state.error === null && state.board === undefined && state.tokenConfigured === undefined);
  state = boardTransition(state, { type: "START" });
  check("状态机(S2.3):START → loading(数据保留,错误清空)", state.phase === P.LOADING && state.error === null);
  state = boardTransition(state, { type: "FAILED", stage: "list", code: "http_error", text: "读取失败: [http_error] x", transient: false });
  check("状态机(S2.3):FAILED → error(payload 带 code/text/transient,boardInFlight 复位)", state.phase === P.ERROR && state.error?.code === "http_error" && state.error?.transient === false && state.error?.stage === "list" && state.boardInFlight === false);
  state = boardTransition(state, { type: "RETRY_TICK" });
  state = boardTransition(state, { type: "RETRY_TICK" });
  check("状态机(S2.3):RETRY_TICK 只累加计数(phase 不变)", state.phase === P.ERROR && state.retryCount === 2);
  state = boardTransition(state, { type: "START" });
  check("状态机(S2.3):重试再入 START → 回 loading 且计数保留(归零只发生在完整成功)", state.phase === P.LOADING && state.retryCount === 2);
  state = boardTransition(state, { type: "TOKEN_GUIDE" });
  check("状态机(S2.3):TOKEN_GUIDE → ready + tokenConfigured=false + 预算归零", state.phase === P.READY && state.tokenConfigured === false && state.retryCount === 0);
  state = initialBoardState();
  state = boardTransition(state, { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [], warnings: [{ source: "viewer", code: "graphql_error", message: "x" }] });
  check(
    "状态机(S2.3):LIST_OK 空列表 → ready(**部分失败**是 ready 的 payload:警告保留可渲染)",
    state.phase === P.READY && state.projects.length === 0 && state.warnings.length === 1,
    JSON.stringify(state.warnings),
  );
  state = boardTransition(state, { type: "START" });
  state = boardTransition(state, { type: "TOKEN_KNOWN" });
  state = boardTransition(state, { type: "LIST_OK", projects: [{ id: "p1", number: 7, title: "Alpha" }], warnings: [] });
  state = boardTransition(state, { type: "SELECT", key: "#7" });
  state = boardTransition(state, { type: "BOARD_START" });
  check("状态机(S2.3):非空 LIST_OK 保持 loading 等看板;BOARD_START 只标记在途", state.phase === P.LOADING && state.boardInFlight === true && state.selected === "#7");
  state = boardTransition(state, { type: "BOARD_OK", board: { columns: [] }, key: "#7", totalCount: 3, incomplete: true });
  check("状态机(S2.3):BOARD_OK → ready(看板/键/总数/不完整标记记账)", state.phase === P.READY && state.boardKey === "#7" && state.totalCount === 3 && state.incomplete === true && state.boardInFlight === false);
  state = boardTransition(state, { type: "BOOTSTRAP_DONE" });
  check("状态机(S2.3):BOOTSTRAP_DONE → 重试预算归零(唯一归零转换之一)", state.retryCount === 0);
  const untouched = boardTransition(state, { type: "UNKNOWN_EVENT" });
  check("状态机(S2.3):未知事件原样返回(转换封闭)", untouched === state);
}

// ── 5r. S2.2 控制器直驱:启动/重试/切换/刷新/轮询不经 React 即可验证 ────────────
{
  const internals = mod.internals;
  /** 微任务驱动的控制器驱动器:delay 即时,scheduleRetry 可控/可即时。 */
  const makeHarness = ({ api, polling, immediateRetry = false } = {}) => {
    const retryFires = [];
    const controller = internals.createBoardController({
      getApi: () => api,
      t,
      polling,
      getElement: () => undefined,
      delay: () => Promise.resolve(),
      scheduleRetry: (callback) => {
        retryFires.push(callback);
        if (immediateRetry) queueMicrotask(callback);
        return () => {};
      },
    });
    const settle = async (rounds = 6) => {
      for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    };
    return { controller, retryFires, settle };
  };
  const okBoard = (title) => ({ ok: true, board: { project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title, url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }] }, totalCount: 1 });

  // 场景 1:完整启动链 → ready;快照含选择/看板/警告(部分失败 payload)
  {
    const calls = [];
    const api = {
      status: async () => { calls.push("status"); return { ok: true, status: { tokenConfigured: true, version: "0.9.0" } }; },
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }], warnings: [{ source: "octocat/gone", code: "repo_missing", message: "x" }] }),
      getBoard: async () => { calls.push("board"); return okBoard("直驱卡"); },
    };
    const { controller, settle } = makeHarness({ api });
    controller.start();
    await settle();
    const snapshot = controller.getSnapshot();
    const view = internals.viewBoardState(snapshot);
    check(
      "控制器(S2.2):start 走完整链 → ready,选中首项,看板上账,警告进 payload(部分失败)",
      snapshot.phase === "ready" && snapshot.selected === "#7" && snapshot.boardKey === "#7" && calls.join(",") === "status,board" &&
        view.failedSources.join(",") === "octocat/gone",
      `phase=${snapshot.phase} calls=${calls.join(",")}`,
    );
    check("控制器(S2.2):快照只读给视图,不暴露内部句柄", typeof controller.subscribe === "function" && typeof controller.reload === "function" && typeof controller.select === "function");
  }
  // 场景 2:选择切换 + 请求序守卫(慢的旧响应不覆盖新选择)
  {
    const boards = {
      "#7": okBoard("Alpha 的卡"),
      "#9": { ok: true, board: { project: { id: "p2", number: 9, title: "Beta" }, hasStatusField: true, columns: [{ optionId: "o2", name: "Todo", items: [{ id: "b1", title: "Beta 的卡", url: undefined, assignees: [], labels: [], statusOptionId: "o2" }] }] }, totalCount: 1 },
    };
    const pending = { "#9": null };
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }, { id: "p2", number: 9, title: "Beta" }] }),
      getBoard: async (request) => {
        if (request.projectNumber === 9 && pending["#9"] !== null) await pending["#9"];
        return boards[`#${request.projectNumber}`];
      },
    };
    const { controller, settle } = makeHarness({ api });
    controller.start();
    await settle();
    pending["#9"] = new Promise(() => {}); // #9 永不回包
    controller.select("#9");
    await settle(2);
    check("控制器(S2.2):切换期间旧看板退位(boardInFlight 门控,快照不冒充新项目)", controller.getSnapshot().boardInFlight === true && internals.viewBoardState(controller.getSnapshot()).boardMatchesSelection === false);
  }
  // 场景 3:瞬态持续失败 → 自愈轮 15 轮封顶;手动 reload 重置预算后再封顶
  {
    let statusCalls = 0;
    const transientFail = () => ({ ok: false, error: { code: "gateway/internal", message: "client api: githubKanban/listProjects failed: Failed to fetch" } });
    const api = {
      status: async () => { statusCalls += 1; return { ok: true, status: { tokenConfigured: true, version: "0.9.0" } }; },
      listProjects: async () => transientFail(),
      getBoard: async () => okBoard("x"),
    };
    const { controller, settle } = makeHarness({ api, immediateRetry: true });
    controller.start();
    await settle(4);
    const snapshot1 = controller.getSnapshot();
    check(
      "控制器(S2.2):列表持续瞬态失败 → 错误态 + 瞬态标记,自愈轮累计到 15 封顶",
      snapshot1.phase === "error" && snapshot1.error?.transient === true && snapshot1.retryCount === 15,
      `retry=${snapshot1.retryCount}`,
    );
    const cappedCalls = statusCalls;
    await settle(2);
    check("控制器(S2.2):达上限后不再自增(无手动干预不再发起)", statusCalls === cappedCalls && controller.getSnapshot().retryCount === 15, `calls=${statusCalls}/${cappedCalls}`);
    controller.reload(); // 手动刷新:预算重置(链内 5 次容忍 + 新一轮 15 轮)
    await settle(4);
    check(
      "控制器(S2.2):手动 reload 重置预算后重新累计,仍按上限停止",
      controller.getSnapshot().retryCount === 15 && statusCalls > cappedCalls,
      `retry=${controller.getSnapshot().retryCount} calls=${cappedCalls}→${statusCalls}`,
    );
  }
  // 场景 4:轮询注册/推进/节流与 dispose 收口(不经 React)
  {
    const registered = [];
    const polling = {
      intervalMs: 30_000,
      setInterval: (callback, ms) => { registered.push({ callback, ms }); return () => registered.pop(); },
      isVisible: () => true,
    };
    const boardCalls = [];
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
      getBoard: async (request) => { boardCalls.push(request); return okBoard(`第 ${boardCalls.length} 版`); },
    };
    const { controller, settle } = makeHarness({ api, polling });
    controller.start();
    await settle();
    check("控制器(S2.2):ready 后注册轮询(1 个,30s 间隔)", registered.length === 1 && registered[0]?.ms === 30_000 && boardCalls.length === 1, `timers=${registered.length}`);
    registered[0].callback();
    await settle(2);
    check("控制器(S2.2):tick 到期重拉当前项目(带 projectNumber=7)", boardCalls.length === 2 && boardCalls[1]?.projectNumber === 7, JSON.stringify(boardCalls.map((call) => call.projectNumber)));
    controller.dispose();
    check("控制器(S2.2):dispose 收口轮询注册(关闭面板不再调度)", registered.length === 0, `timers=${registered.length}`);
    // dispose 后迟到结果不上账
    const before = controller.getSnapshot().board;
    boardCalls.length = 0;
    controller.reload();
    await settle(2);
    check("控制器(S2.2):dispose 后 reload/迟到回包被忽略(快照不动)", controller.getSnapshot().board === before && boardCalls.length === 0, `calls=${boardCalls.length}`);
  }
  // 场景 5(R2):重挂载代际 —— dispose 后 start() 重挂载,卸载前在途的旧链回包不得混入新链
  {
    let listCalls = 0;
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => {
        listCalls += 1;
        if (listCalls === 1) { await firstGate; return { ok: true, projects: [] }; } // 旧链(卸载前)视角:空列表
        return { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] };
      },
      getBoard: async () => okBoard("重挂载后的卡"),
    };
    const { controller, settle } = makeHarness({ api });
    controller.start();
    await settle(2); // 旧链卡在列表
    controller.dispose();
    controller.start(); // 重挂载(StrictMode 双挂载同源路径):disposed 翻回 false,新链跑通
    await settle();
    const remounted = controller.getSnapshot();
    check(
      "控制器(R2):重挂载新链正常工作(ready + 新看板上账)",
      remounted.phase === "ready" && remounted.boardKey === "#7" && remounted.projects.length === 1,
      `phase=${remounted.phase} projects=${remounted.projects.length}`,
    );
    releaseFirst(); // 卸载前旧链的迟到回包(空列表)到达
    await settle(4);
    const after = controller.getSnapshot();
    check(
      "控制器(R2):卸载前旧链迟到的空列表不得清掉重挂载新链状态",
      after.phase === "ready" && after.projects.length === 1 && after.boardKey === "#7",
      `phase=${after.phase} projects=${after.projects.length} boardKey=${after.boardKey}`,
    );
    controller.dispose();
  }
  // 场景 6(R2):刷新链序 —— reload 新链完成后,旧链迟到的列表回包不得回退新链状态
  {
    let listCalls = 0;
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => {
        listCalls += 1;
        if (listCalls === 1) { await firstGate; return { ok: true, projects: [] }; } // 首载链(慢)视角:空列表
        return { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] };
      },
      getBoard: async () => okBoard("新链的卡"),
    };
    const { controller, settle } = makeHarness({ api });
    controller.start();
    await settle(2); // 首载链卡在列表
    controller.reload(); // 手动刷新:新链立即完成
    await settle();
    check("控制器(R2):reload 新链完成(列表+看板为新链口径)", controller.getSnapshot().phase === "ready" && controller.getSnapshot().projects.length === 1, `phase=${controller.getSnapshot().phase}`);
    releaseFirst(); // 首载链的迟到回包到达
    await settle(4);
    const after = controller.getSnapshot();
    check(
      "控制器(R2):旧链迟到的空列表不得回退新链状态",
      after.phase === "ready" && after.projects.length === 1 && after.boardKey === "#7",
      `phase=${after.phase} projects=${after.projects.length}`,
    );
    controller.dispose();
  }
  // 场景 7(R2):看板窗口 —— reload 已换代但新链尚未拉看板时,旧链看板回包不得落账
  // (此窗口内 loadSeq 未被新链推进,仅靠序号守卫拦不住,必须靠代数)
  {
    let listCalls = 0;
    let boardCalls = 0;
    let releaseBoard;
    const boardGate = new Promise((resolve) => { releaseBoard = resolve; });
    let releaseList;
    const listGate = new Promise((resolve) => { releaseList = resolve; });
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => {
        listCalls += 1;
        if (listCalls === 2) await listGate; // 新链(reload 后)的列表被拦
        return { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] };
      },
      getBoard: async () => {
        boardCalls += 1;
        if (boardCalls === 1) { await boardGate; return okBoard("旧链的卡"); } // 旧链看板(慢)
        return okBoard("新链的卡");
      },
    };
    const { controller, settle } = makeHarness({ api });
    controller.start();
    await settle(2); // 旧链:列表已回、看板 #1 被拦
    controller.reload(); // 刷新:新链的列表被拦(listGate)→ 尚未发起看板请求
    await settle(2);
    releaseBoard(); // 旧链看板回包到达:此时 loadSeq 未变,仅靠序号守卫拦不住 —— 必须靠代数
    await settle(2);
    check(
      "控制器(R2):换代后旧链看板不落账(新链进行中不闪旧数据)",
      controller.getSnapshot().board === undefined && controller.getSnapshot().phase === "loading",
      `phase=${controller.getSnapshot().phase} board=${controller.getSnapshot().board !== undefined}`,
    );
    releaseList(); // 新链列表放行 → 新链看板上账
    await settle(4);
    const after = controller.getSnapshot();
    check(
      "控制器(R2):新链看板最终上账(旧链看板被作废)",
      after.phase === "ready" && after.board?.columns?.[0]?.items?.[0]?.title === "新链的卡",
      `phase=${after.phase} title=${after.board?.columns?.[0]?.items?.[0]?.title}`,
    );
    controller.dispose();
  }
  // 场景 8(R3):轮询/切换的看板成功不得掩盖链级失败 —— 门控在 BOARD_OK/FAILED 转换。
  // 场景:健康面板 → 刷新时 list 503 → 错误态(旧列表在场,轮询仍注册)→ 轮询 tick。
  {
    const registered = [];
    const polling = {
      intervalMs: 30_000,
      setInterval: (callback, ms) => { registered.push({ callback, ms }); return () => registered.pop(); },
      isVisible: () => true,
    };
    let listMode = "ok";
    let boardMode = "ok";
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () =>
        listMode === "fail"
          ? { ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } }
          : { ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] },
      getBoard: async () =>
        boardMode === "fail"
          ? { ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } }
          : okBoard("轮询的新卡"),
    };
    const { controller, settle } = makeHarness({ api, polling });
    controller.start();
    await settle();
    check("控制器(R3):健康期看板正常上账(门控不影响正常路径)", controller.getSnapshot().phase === "ready" && registered.length === 1, `phase=${controller.getSnapshot().phase} timers=${registered.length}`);

    listMode = "fail";
    controller.reload(); // 刷新:list 503 → 链级错误(非瞬态 → 无自愈轮干扰)
    await settle();
    const listError = controller.getSnapshot();
    check(
      "控制器(R3):刷新的 list 失败 → 错误态(stage=list),轮询仍注册(旧列表在场)",
      listError.phase === "error" && listError.error?.stage === "list" && registered.length === 1,
      JSON.stringify({ phase: listError.phase, stage: listError.error?.stage, timers: registered.length }),
    );

    registered[0].callback(); // 轮询 tick:看板成功
    await settle(2);
    const afterTick = controller.getSnapshot();
    check(
      "控制器(R3):轮询的看板成功不清链级错误 —— 数据上账、phase/错误保持",
      afterTick.phase === "error" && afterTick.error?.stage === "list" && afterTick.error?.text.includes("503") &&
        afterTick.board?.columns?.[0]?.items?.[0]?.title === "轮询的新卡" && afterTick.boardInFlight === false,
      JSON.stringify({ phase: afterTick.phase, stage: afterTick.error?.stage, title: afterTick.board?.columns?.[0]?.items?.[0]?.title }),
    );

    boardMode = "fail";
    registered[0].callback(); // 轮询 tick:看板失败(401)
    await settle(2);
    const afterFail = controller.getSnapshot();
    check(
      "控制器(R3):链级错误期的看板失败不顶替根因(stage 仍 list、文案仍 503)",
      afterFail.phase === "error" && afterFail.error?.stage === "list" && afterFail.error?.text.includes("503") &&
        !afterFail.error?.text.includes("401") && afterFail.boardInFlight === false,
      JSON.stringify({ stage: afterFail.error?.stage, text: afterFail.error?.text }),
    );

    listMode = "ok";
    boardMode = "ok";
    controller.reload(); // 用户手动刷新:整链成功 = 认可的恢复路径
    await settle();
    const recovered = controller.getSnapshot();
    check("控制器(R3):整链成功后恢复正常(ready、错误清空)", recovered.phase === "ready" && recovered.error === null, JSON.stringify({ phase: recovered.phase }));
    controller.dispose();
  }
  // 场景 9(R3 保留路径):board 级错误期的轮询成功仍恢复看板(门控只针对链级错误)
  {
    const registered = [];
    const polling = {
      intervalMs: 30_000,
      setInterval: (callback, ms) => { registered.push({ callback, ms }); return () => registered.pop(); },
      isVisible: () => true,
    };
    let boardMode = "fail";
    const api = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
      getBoard: async () => (boardMode === "fail" ? { ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } } : okBoard("恢复的卡")),
    };
    const { controller, settle } = makeHarness({ api, polling });
    controller.start();
    await settle();
    const errored = controller.getSnapshot();
    check("控制器(R3):看板自身失败 → 错误态(stage=board)", errored.phase === "error" && errored.error?.stage === "board", JSON.stringify({ phase: errored.phase, stage: errored.error?.stage }));
    boardMode = "ok";
    registered[0].callback(); // 轮询 tick:看板成功 → 恢复(合法路径,保留)
    await settle(2);
    const recovered = controller.getSnapshot();
    check(
      "控制器(R3):board 级错误仍被轮询成功恢复(ready + 新卡上账)",
      recovered.phase === "ready" && recovered.error === null && recovered.board?.columns?.[0]?.items?.[0]?.title === "恢复的卡",
      JSON.stringify({ phase: recovered.phase }),
    );
    controller.dispose();
  }
}

// ── 5r2. R3 转换层门控:链级错误对 BOARD_START/BOARD_OK/FAILED(board) 的保持(纯函数直驱) ──
// 规则集中在一处:链级(status/list/bootstrap)错误在场时,看板请求的生命周期事件
// (发起/成功/失败)都动不了全局 phase/error —— 单看板成功证明不了列表新鲜。board
// 级错误是看板请求自己的失败,恢复路径不受影响。
{
  const { boardTransition, initialBoardState } = mod.internals;
  const failEvent = (stage, text) => ({ type: "FAILED", stage, code: "http_error", text, transient: false });
  const boardOkEvent = { type: "BOARD_OK", board: { columns: [] }, key: "#7", totalCount: 1, incomplete: false };
  // FAILED(list) → BOARD_OK:错误保持,看板数据上账(不翻 ready)
  {
    let state = boardTransition(initialBoardState(), failEvent("list", "读取失败: [http_error] GitHub API HTTP 503。"));
    state = boardTransition(state, boardOkEvent);
    check(
      "转换(R3):list 级错误在场,BOARD_OK 不翻 ready 不清错(看板数据照常上账)",
      state.phase === "error" && state.error?.text.includes("503") && state.boardKey === "#7" && state.boardInFlight === false,
      `phase=${state.phase} boardKey=${state.boardKey}`,
    );
  }
  // FAILED(list) → BOARD_START:发起不清错(旧实现:错误文案在在途期凭空消失)
  {
    let state = boardTransition(initialBoardState(), failEvent("list", "503"));
    state = boardTransition(state, { type: "BOARD_START" });
    check(
      "转换(R3):BOARD_START 不清链级错误,只标记在途(board 级错误让位是既有口径)",
      state.phase === "error" && state.error?.text === "503" && state.boardInFlight === true,
      JSON.stringify({ phase: state.phase, error: state.error?.text }),
    );
  }
  // FAILED(board) → BOARD_START:board 级错误让位(看板请求自己的错误;pure.test S3.1 同口径)
  {
    let state = boardTransition(initialBoardState(), failEvent("board", "401"));
    state = boardTransition(state, { type: "BOARD_START" });
    check(
      "转换(R3):BOARD_START 清 board 级错误(新看板请求在途,旧失败让位)",
      state.phase === "error" && state.error === null && state.boardInFlight === true,
      JSON.stringify({ phase: state.phase, error: state.error }),
    );
  }
  // FAILED(list) → FAILED(board):根因不被从属失败顶替
  {
    let state = boardTransition(initialBoardState(), failEvent("list", "503"));
    state = boardTransition(state, failEvent("board", "401"));
    check("转换(R3):链级错误不被 board 级失败顶替(stage 保持根因)", state.error?.stage === "list" && state.error?.text === "503", JSON.stringify(state.error));
  }
  // FAILED(board) → BOARD_OK:保留路径(轮询成功恢复看板)
  {
    let state = boardTransition(initialBoardState(), failEvent("board", "401"));
    state = boardTransition(state, boardOkEvent);
    check("转换(R3):board 级错误仍被 BOARD_OK 正常恢复(ready + 清错)", state.phase === "ready" && state.error === null, `phase=${state.phase}`);
  }
  // FAILED(status) → BOARD_OK:status 同属链级(看板成功证明不了 status 健康)
  {
    let state = boardTransition(initialBoardState(), failEvent("status", "503"));
    state = boardTransition(state, boardOkEvent);
    check("转换(R3):status 级错误同样保持,不被看板成功清除", state.phase === "error" && state.error?.stage === "status", JSON.stringify({ phase: state.phase, stage: state.error?.stage }));
  }
  // loading 期(无错误)的 BOARD_OK:正常进 ready(链内路径不受门控)
  {
    let state = boardTransition(initialBoardState(), { type: "START" });
    state = boardTransition(state, boardOkEvent);
    check("转换(R3):链内(loading 期)BOARD_OK 照常进 ready(门控只针对错误态)", state.phase === "ready" && state.error === null, `phase=${state.phase}`);
  }
}

// ── 5s. S2.4 响应契约校验:畸形响应走可观测错误,不无声退化 ─────────────────────
{
  const internals = mod.internals;
  // 纯校验函数:三种畸形
  check("契约(S2.4):status 缺 tokenConfigured 布尔 → shape_error", internals.coerceStatus({ ok: true, status: { repos: 1 } }).error?.code === "shape_error");
  check(
    "契约(S2.4):listProjects 缺 projects 数组 → shape_error(拒绝当作空列表)",
    internals.coerceProjectsResult({ ok: true, projects: "oops" }).error?.code === "shape_error" && internals.coerceProjectsResult({ ok: true }).error?.code === "shape_error",
  );
  check(
    "契约(S2.4):项目条目畸形(缺 number)→ shape_error",
    internals.coerceProjectsResult({ ok: true, projects: [{ id: "p1", title: "x" }] }).error?.code === "shape_error",
  );
  check(
    "契约(S2.4):getBoard 缺 board/缺 columns/列缺 items → shape_error",
    internals.coerceBoardResult({ ok: true }).error?.code === "shape_error" &&
      internals.coerceBoardResult({ ok: true, board: { hasStatusField: true } }).error?.code === "shape_error" &&
      internals.coerceBoardResult({ ok: true, board: { columns: [{ name: "Todo" }] } }).error?.code === "shape_error",
  );
  check(
    "契约(S2.4):合法形状原样放行(totalCount 缺席合法;warnings 缺省为无)",
    internals.coerceBoardResult({ ok: true, board: { columns: [] } })?.ok === true && internals.coerceProjectsResult({ ok: true, projects: [{ id: "p1", number: 7, title: "A" }] })?.ok === true,
    "",
  );
  // 组件级:畸形响应呈现为结构化错误态(不是崩溃、不是空看板)
  {
    const boardApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: "not-an-array" }),
      getBoard: async () => ({ ok: true, board: sampleBoard }),
    };
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check("契约(S2.4):畸形列表 → 错误态显示 [shape_error],不崩不渲染空列表", text.includes("读取失败") && text.includes("[shape_error]"), text.match(/读取失败[^•]*/)?.[0]?.slice(0, 70));
  }
  {
    const boardApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
      getBoard: async () => ({ ok: true, board: { project: { number: 7 }, hasStatusField: true } }), // 缺 columns
    };
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check("契约(S2.4):畸形看板 → 错误态显示 [shape_error](不是「还没有看板条目」)", text.includes("[shape_error]") && !text.includes("该项目还没有看板条目"), text.match(/读取失败[^•]*/)?.[0]?.slice(0, 70));
  }
}

// ── 5t. S2.5/S2.9 渲染口径:无总数截断提示、字段值截断、来源截断行、兜底列名本地化、版本一致 ──
{
  // 1) incomplete(无服务端总数)→ boardCapped 文案;fieldValuesTruncated → 提示行
  {
    const boardApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
      getBoard: async () => ({
        ok: true,
        board: {
          project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: true, fieldValuesTruncated: 2,
          columns: [{ optionId: "o1", name: "Todo", items: [{ id: "i1", title: "卡", url: undefined, assignees: [], labels: [], statusOptionId: "o1" }] }],
        },
        fetchedCount: 200,
        incomplete: true, // 无 totalCount:宿主明说「截断且无总数可自证」
      }),
    };
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check(
      "完整性渲染(S2.5):incomplete 无总数 → 「超出单次拉取上限…可能不完整」,不假称全量",
      text.includes("超出单次拉取上限") && text.includes("可能不完整") && !text.includes("已加载 1 /"),
      text.match(/已加载[^。]{0,60}/)?.[0] ?? "",
    );
    check("完整性渲染(S2.5):fieldValuesTruncated → 字段值可能缺失的提示行(点名张数)", text.includes("2") && text.includes("字段值超过单页上限"), text.match(/有 \d+ 张卡的字段值[^。]{0,40}/)?.[0] ?? "");
  }
  // 2) 来源级 projects_truncated 警告走独立文案(不冒充「读取失败」)
  {
    const boardApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({
        ok: true,
        projects: [{ id: "p1", number: 7, title: "Alpha" }],
        warnings: [{ source: "viewer", code: "projects_truncated", message: "cap" }],
      }),
      getBoard: async () => ({ ok: true, board: sampleBoard }),
    };
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check(
      "完整性渲染(S2.5):projects_truncated 走「列表可能不完整」文案,不混入「读取失败」句式",
      text.includes("列表可能不完整") && !text.includes("部分项目来源读取失败"),
      text.match(/部分来源[^。]{0,50}/)?.[0] ?? "",
    );
  }
  // 3) 兜底列名/无标题卡的本地化(S2.9):宿主给 fallback/untitled 标记,显示名查词典
  {
    const boardApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [{ id: "p1", number: 7, title: "Alpha" }] }),
      getBoard: async () => ({
        ok: true,
        board: {
          project: { id: "p1", number: 7, title: "Alpha" }, hasStatusField: false, statusFieldHint: "not_found",
          columns: [
            { optionId: null, name: "", fallback: "all", items: [{ id: "i1", title: "", untitled: true, url: undefined, assignees: [], labels: [], statusOptionId: null }] },
          ],
        },
      }),
    };
    const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
    const text = textOf(tree);
    check(
      "本地化(S2.9):fallback=all 列显示「全部」,untitled 卡显示「(无标题)」(词典出,非宿主硬编码)",
      text.includes("全部") && text.includes("(无标题)") && text.includes("共 1 张卡"),
      text.slice(0, 160),
    );
    const columns = findAll(tree, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-column"));
    check("本地化(S2.9):兜底列 key 稳定(__unfiled),aria-label 用本地化名", columns[0]?.props?.key === "__unfiled" && columns[0]?.props?.["aria-label"] === "全部", `key=${columns[0]?.props?.key}`);
  }
  // 4) 版本来源统一(S2.9):代码常量与 package.json 一致
  check("版本(S2.9):lib/index.js VERSION 与 package.json version 一致", hostMod.VERSION === pkg.version, `lib=${hostMod.VERSION} pkg=${pkg.version}`);
}

// ── 5u. 0.9.0:alpha 徽章/写回说明、主题切换、载荷透传、moveCard 自检接缝 ──────
{
  // 1) 面板头:phaseBadge=「alpha」,说明句交代拖拽写回与边界(保留来源句)
  const boardApi = {
    status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 0, version: "0.9.0" } }),
    listProjects: async () => ({ ok: true, projects: [] }),
    getBoard: async () => ({ ok: true, board: sampleBoard }),
  };
  const tree = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const text = textOf(tree);
  check("0.9.0 面板头:徽章 alpha(替代只读),说明句含写回指引与边界、保留数据来源句", text.includes("alpha") && text.includes("拖拽卡片到其他列会更新 GitHub 上的 Status") && text.includes("不支持列内排序、建卡与删卡") && text.includes("数据来自 GitHub Projects v2"), text.slice(0, 120));
  // 2) 主题切换按钮(0.9.0 三态):smoke 沙箱无 matchMedia/宿主线索 → auto 态生效主题兜底暗色;
  //    循环 auto → light → dark → auto,aria-label 恒指向点击后的状态
  const miniTree0 = await settleFresh(bodySeat.component, makeProps(stateB, boardApi));
  const root0 = findFirst(miniTree0, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-root"));
  const toggle0 = findFirst(miniTree0, (node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("tgk-themeToggle"));
  check("0.9.0 主题:根节点带 data-tgk-theme(沙箱 auto 态兜底暗色),aria-label 指向跟随态", root0?.props?.["data-tgk-theme"] === "dark" && toggle0 !== undefined && toggle0.props["aria-label"] === "主题跟随 dsh 中,点击固定浅色" && typeof toggle0.props.onClick === "function", `theme=${root0?.props?.["data-tgk-theme"]} label=${toggle0?.props["aria-label"]}`);
  toggle0.props.onClick(); // auto → light(生效主题 dark → light)
  const miniTree1 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const root1 = findFirst(miniTree1, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-root"));
  const toggle1 = findFirst(miniTree1, (node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("tgk-themeToggle"));
  check("0.9.0 主题:auto→light 生效主题翻转为 light,aria-label 指向暗色", root1?.props?.["data-tgk-theme"] === "light" && toggle1?.props["aria-label"] === "切换到暗色模式", `theme=${root1?.props?.["data-tgk-theme"]}`);
  toggle1.props.onClick(); // light → dark
  const miniTree2 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const root2 = findFirst(miniTree2, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-root"));
  const toggle2 = findFirst(miniTree2, (node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("tgk-themeToggle"));
  check("0.9.0 主题:light→dark 生效主题 dark,aria-label 指回跟随 dsh", root2?.props?.["data-tgk-theme"] === "dark" && toggle2?.props["aria-label"] === "跟随 dsh 主题(回到自动)", `theme=${root2?.props?.["data-tgk-theme"]}`);
  toggle2.props.onClick(); // dark → auto(沙箱无宿主源:生效主题保持 dark,不跳变)
  const miniTree3 = await miniReact.settle(bodySeat.component, makeProps(stateB, boardApi));
  const root3 = findFirst(miniTree3, (node) => node.type === "section" && typeof node.props?.className === "string" && node.props.className.includes("tgk-root"));
  const toggle3 = findFirst(miniTree3, (node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("tgk-themeToggle"));
  check("0.9.0 主题:dark→auto 回跟随态(沙箱无宿主源,生效主题保持 dark)", root3?.props?.["data-tgk-theme"] === "dark" && toggle3?.props["aria-label"] === "主题跟随 dsh 中,点击固定浅色", `theme=${root3?.props?.["data-tgk-theme"]}`);
  // 3) 主题持久化:UI 偏好进 prefs(业务数据仍零落盘)
  {
    localStorageStub.__store = {};
    const PREFS_KEY = `${PACKAGE_ID}/prefs/v1`;
    const themeApi = {
      status: async () => ({ ok: true, status: { tokenConfigured: true, repos: 0, version: "0.9.0" } }),
      listProjects: async () => ({ ok: true, projects: [] }), // 空列表:选中键缺席也要能落盘主题
      getBoard: async () => ({ ok: true, board: sampleBoard }),
    };
    try {
      const themeTree = await settleFresh(bodySeat.component, makeProps(stateB, themeApi));
      const themeToggle = findFirst(themeTree, (node) => node.type === "button" && typeof node.props?.className === "string" && node.props.className.includes("tgk-themeToggle"));
      themeToggle.props.onClick();
      await miniReact.settle(bodySeat.component, makeProps(stateB, themeApi));
      const stored = JSON.parse(localStorageStub.__store[PREFS_KEY] ?? "{}");
      check(
        "0.9.0 主题持久化:空项目列表下切换主题也落盘 { savedAt, theme }(selectedKey 缺席不落盘,失配不落盘规则不变)",
        stored.theme === "light" && stored.selectedKey === undefined && typeof stored.savedAt === "number",
        `keys=${Object.keys(stored).sort().join(",")} theme=${stored.theme}`,
      );
    } finally {
      localStorageStub.__store = null;
    }
  }
  // 4) 自检接缝:0.9.0 纯函数(主题/乐观移动/可拖性)与载荷透传校验
  {
    const internals = mod.internals;
    const themeFns = ["normalizeTheme", "normalizeMode", "cycleThemeMode", "resolveInitialMode", "hostThemeMarker", "detectDefaultTheme", "themeEnvironment", "hostThemeHint", "statusColorHex", "labelPillStyle"];
    const moveFns = ["moveCardInBoard", "dragDisabledReason"];
    check(
      "0.9.0 internals:主题与拖拽写回纯函数经自检接缝暴露(不经 React 可直驱)",
      themeFns.every((name) => typeof internals[name] === "function") && moveFns.every((name) => typeof internals[name] === "function"),
      themeFns.concat(moveFns).filter((name) => typeof internals[name] !== "function").join(",") || "all present",
    );
    const board = { project: { number: 7 }, hasStatusField: true, columns: [
      { optionId: "o1", name: "Todo", items: [{ id: "a1", title: "卡", assignees: [], labels: [] }] },
      { optionId: "o2", name: "Done", items: [] },
    ] };
    const moved = internals.moveCardInBoard(board, "a1", "o2");
    check(
      "0.9.0 moveCardInBoard:乐观移动(目标列末尾),原看板不改写(快照回滚依据)",
      moved.columns[1].items[0]?.id === "a1" && moved.columns[0].items.length === 0 && board.columns[0].items[0]?.id === "a1",
      JSON.stringify(moved.columns.map((column) => column.items.map((item) => item.id))),
    );
    check(
      "0.9.0 dragDisabledReason:正常列可拖,fallback 列给词典键(兜底列 title 提示)",
      internals.dragDisabledReason(board, board.columns[0], null) === null && internals.dragDisabledReason(board, { optionId: null, fallback: "unfiled", items: [] }, null) === "dragHintFallback",
      "",
    );
    check(
      "0.9.0 statusColorHex/labelPillStyle:枚举色两套 hex + 非法值退化",
      internals.statusColorHex("BLUE", "light") === "#0969da" && internals.statusColorHex("UNKNOWN", "dark") === "#8b949e" && internals.labelPillStyle("ff8800", "light")?.backgroundColor === "rgba(255, 136, 0, 0.2)" && internals.labelPillStyle("nope", "light") === undefined,
      "",
    );
    check(
      "0.9.0 coerceBoard:载荷扩展(projectNodeId/列 color)在场须字符串、缺席放行",
      internals.coerceBoardResult({ ok: true, board: { projectNodeId: "PV", statusFieldId: "SF", columns: [{ optionId: "o1", color: "BLUE", name: "Todo", items: [] }] } }).ok === true &&
        internals.coerceBoardResult({ ok: true, board: { columns: [{ color: 42, items: [] }] } }).error?.code === "shape_error",
      "",
    );
  }
}

// panellist 入口图标:svg 字形(朴素、aria-hidden、不吃文字内容),label 由注册项自己提供。
{
  const iconTree = panellistSeat.component({ size: 16 });
  check(
    "panellist 图标渲染 svg 字形(aria-hidden,不吃文案)",
    iconTree?.type === "svg" && iconTree?.props?.["aria-hidden"] === "true" && iconTree?.props?.viewBox === "0 0 16 16",
    `type=${iconTree?.type}`,
  );
}

// ── 6. 报告 ──────────────────────────────────────────────────────────────────
let failedCount = 0;
for (const result of results) {
  if (!result.ok) failedCount += 1;
  const mark = result.ok ? "✓" : "✗";
  console.log(`${mark} ${result.label}${result.detail === "" ? "" : `  — ${result.detail}`}`);
}
console.log(`\n${results.length - failedCount}/${results.length} 通过`);
process.exit(failedCount === 0 ? 0 : 1);
