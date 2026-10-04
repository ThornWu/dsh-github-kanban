/**
 * 真实 React 测试环境(阶段 3 / S3.4 / R06 兑现)。
 *
 * 环境构成(与 dsh 宿主对齐的依据,详见 notes/remediation/phase3.md):
 *   - React 18.3.1 + react-dom 18.3.1(devDependencies 锁定):dsh web 实际下发的
 *     前端 dist vendor bundle 里捆绑的就是 18.3.1(dsh-web-frontend 同源);
 *     宿主平台 seed 的 require("react") 与壳层共用同一实例 —— 这里同理,组件、
 *     react-dom、测试三方同一 react 实例。
 *   - jsdom:浏览器 DOM(样式注入、事件、localStorage、可见性)。测试专用
 *     devDependency,不进分发包(files 白名单)。
 *   - react-dom/client createRoot + React.act:真实调度、真实 effect 生命周期
 *     (setup/cleanup/卸载),这正是 R06 指出 mini 替身缺失的部分。
 *   - 虚拟时钟(clock.mjs):只替换插件可见的 setTimeout/ctx.timeout/ctx.interval,
 *     不触碰 React —— 4s 自愈轮 / 30s 轮询 / 10s deadline 可确定性推进。
 *
 * 装配层级:走**真实 apply(ctx) 链** —— mountRemote → scoped fiber 取面 →
 * createBoardApi(信封拆包/deadline)→ 座位注册。face 替身只模拟网关 transport
 * (返回 {ok:true,value:<业务>} 信封),面板以上全部是被测真实代码。
 */
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import react, { act } from "react";
import { createVirtualClock } from "./clock.mjs";
import { loadClient } from "./load-client.mjs";
import { strictArgumentFace, manifestArities } from "./fixtures.mjs";

const PANEL_ID = "github-kanban";
const NS = "thorn-github-kanban";

/** 中文词典绑定(与 smoke 同型:ctx.locale.register/bind 的替身,读 zh 源)。 */
const makeLocale = () => {
  const byNs = new Map();
  return {
    register: (ns, dicts) => {
      byNs.set(ns, dicts);
      return () => {};
    },
    bind: (ns) => (key, params) => {
      const raw = byNs.get(ns)?.zh?.[key] ?? key;
      return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    },
  };
};

/**
 * 挂载一个完整面板(真实 React + 真实 client.js apply 链)。
 * @param {object} options.face 远程面替身:方法返回网关信封(gatewayOk/gatewayFail),
 *   或返回 Promise(悬挂/迟到场景)。
 * @param {Function} [options.decorateCtx] 追加/改写 ctx 键(服务缺席等场景用)。
 * @param {boolean} [options.strictMode] 用 <StrictMode> 包裹渲染(双挂载生命周期)。
 * @param {object} [options.seedStorage] 预置 localStorage 键值(偏好/旧快照场景,
 *   在挂载前写入 —— 控制器首启时读取)。
 * @returns 面板操纵面:{ container, root, props, clock, face, mod, advance, act: actWrapped,
 *   text, $, button, select, fireChange, fireClick, unmount, calls }
 */
export async function mountPanel(options = {}) {
  const { face, decorateCtx, strictMode = false, seedStorage, domStubs } = options;
  const dom = new JSDOM(`<!doctype html><html><body><div id="tgk-host"></div></body></html>`, {
    url: "https://dsh-panel.test/",
    pretendToBeVisual: true,
  });
  if (seedStorage !== undefined) {
    for (const [key, value] of Object.entries(seedStorage)) dom.window.localStorage.setItem(key, value);
  }
  // 主题检测桩(0.9.0):默认主题链会读 window.matchMedia / html 的 data-theme /
  // getComputedStyle —— 测试可在这里覆盖(matchMedia 假返回、宿主主题属性等)。
  // 必须在组件渲染前生效,故在 JSDOM 创建后立即应用。
  if (typeof domStubs === "function") domStubs(dom);
  // react-dom 事件系统与部分 DOM 探测读全局:与 RTL 同型地指到当前 jsdom 实例。
  // node --test 每个文件独立进程,重复赋值无跨用例污染。(navigator 在 Node 21+
  // 是只读全局,需 defineProperty 覆盖。)
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const clock = createVirtualClock();
  const { mod } = loadClient({
    globals: {
      window: dom.window, // __ModuleLoader__ 由 loadClient 补挂
      document: dom.window.document,
      localStorage: dom.window.localStorage,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id),
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (id) => clock.clearInterval(id),
    },
  });

  const seats = [];
  const mountedContributions = [];
  const scopedInjectCalls = [];
  const locale = makeLocale();
  const ctx = {
    effect: (callback) => callback(),
    inject: (injectList, callback) => {
      scopedInjectCalls.push([...injectList]);
      // 面替身过参数数量闸(R2/P1 防漂移):与真网关客户端同严 —— 清单声明 N 参的方法
      // 必须以恰好 N 个实参被调用。数量口径取自 apply 里 $mount 的清单(与网关客户端
      // prepareInvocation 的计数同源),client 侧回退到 0 实参调用时这里先红。
      callback({ remote: { githubKanban: strictArgumentFace(face, manifestArities(mountedContributions[0])) } });
      return { dispose: () => {} };
    },
    slots: {
      inject: (seat, factory) => factory(),
      register: (seatOptions, component) => {
        seats.push({ options: seatOptions, component });
        return () => {};
      },
    },
    remote: { $mount: async (contribution) => { mountedContributions.push(contribution); return () => {}; } },
    // timer Service 替身(宿主里由 client runner 内建):全部走虚拟时钟。
    // 契约形状对齐 cordis timer Service:返回 dispose 函数(而非定时器 id)——
    // client 侧按「函数才收口」判定,数字句柄会被当成无法取消。
    timeout: (callback, ms) => {
      const id = clock.setTimeout(callback, ms);
      return () => clock.clearTimeout(id);
    },
    interval: (callback, ms) => {
      const id = clock.setInterval(callback, ms);
      return () => clock.clearInterval(id);
    },
    locale,
  };
  decorateCtx?.(ctx);
  await mod.apply(ctx);

  const seat = seats.find((entry) => entry.options.key === PANEL_ID);
  if (seat === undefined) throw new Error(`main 座位(${PANEL_ID})未注册:${seats.map((s) => s.options.name).join(",")}`);
  const t = locale.bind(NS);
  const props = { ...seat.options.inject(), t };

  const container = dom.window.document.getElementById("tgk-host");
  const root = createRoot(container);
  const wrappedAct = async (fn) => act(async () => {
    await fn();
  });
  const render = () => {
    const tree = react.createElement(seat.component, props);
    return strictMode ? react.createElement(react.StrictMode, null, tree) : tree;
  };
  await wrappedAct(async () => {
    root.render(render());
  });
  const settle = async (rounds = 8) => {
    for (let round = 0; round < rounds; round += 1) await wrappedAct(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();
  // 热身:推进虚拟时间,让 bootstrap 链内的退避等待(600/1100ms 虚拟 delay)走完
  // —— 即时 settle 只冲微任务,不含时钟。2.5s 覆盖链内前两次重试的等待,且
  // 低于 30s 轮询间隔,不会误触轮询。
  await wrappedAct(async () => { await clock.advance(2_500); });
  await settle(4);

  const text = () => container.textContent.replace(/\s+/g, " ").trim();
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  const reloadButton = () => $$("button").find((button) => button.textContent.includes("刷新"));
  const projectSelect = () => $("select#tgk-project-select");
  const fireChange = async (selectElement, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
    await wrappedAct(async () => {
      setter.call(selectElement, value);
      selectElement.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  const fireClick = async (element) => {
    await wrappedAct(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const advance = async (ms) => {
    await wrappedAct(async () => {
      await clock.advance(ms);
    });
  };
  const unmount = async () => {
    await wrappedAct(async () => {
      root.unmount();
    });
  };
  return {
    dom,
    container,
    root,
    props,
    clock,
    face,
    mod,
    seats,
    mountedContributions,
    scopedInjectCalls,
    advance,
    settle,
    act: wrappedAct,
    text,
    $,
    $$,
    reloadButton,
    projectSelect,
    fireChange,
    fireClick,
    unmount,
  };
}

/** 把 document.visibilityState 切到目标值(页面后台/回前台场景,jsdom 默认 visible)。 */
export function setVisibility(documentObject, state) {
  Object.defineProperty(documentObject, "visibilityState", { value: state, configurable: true });
  Object.defineProperty(documentObject, "hidden", { value: state === "hidden", configurable: true });
}
