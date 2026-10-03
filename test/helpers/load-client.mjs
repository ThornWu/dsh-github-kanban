/**
 * 装载 lib/client.js 的测试接缝(阶段 3):把浏览器半边按真实装载形态
 * (window.__ModuleLoader__.load + factory(require("react")))在 vm 沙箱里物化。
 *
 * 与 scripts/smoke-load.mjs 的关系:smoke 保留「包声明及加载契约检查」职责
 * (REMEDIATION_PLAN §6 明言保留);本助手是 test/ 体系共用的装载器,
 * 关键差异是 require("react") 返回**真实 React**(18.3.1,与 dsh 宿主注入版本
 * 一致,核验记录见 notes/remediation/phase3.md),不再用 mini 替身。
 *
 * 沙箱全局可注入(document/localStorage/时钟)。缺省不提供 document:
 * lib/client.js 的样式注入与可见性探针都会按「无 DOM 环境」降级 —— 纯函数/
 * 契约测试不需要 DOM;真实 React 测试经 react-panel.mjs 注入 jsdom。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import reactModule from "react";

const repoRoot = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** 纯内存 localStorage 替身(纯函数/契约测试用;React 测试用 jsdom 真实实现)。 */
export function createMemoryStorage(initial = Object.create(null)) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    __dump: () => Object.fromEntries(store),
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.globals] 注入沙箱的全局({ document, window, localStorage,
 *   setTimeout/clearTimeout/setInterval/clearInterval } —— 缺省用真实全局)。
 * @returns {{ mod: {apply, inject, internals}, registrations: Array, sandbox: object }}
 *   mod.internals 是 client 模块暴露的自检接缝(S2.2):状态机/控制器/coerce/视图推导。
 */
export function loadClient(options = {}) {
  const { globals = {} } = options;
  const registrations = [];
  const windowObject = globals.window ?? {};
  if (typeof windowObject.__ModuleLoader__?.load !== "function") {
    windowObject.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
  }
  const sandbox = {
    window: windowObject,
    console,
    setTimeout: globals.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: globals.clearTimeout ?? ((id) => clearTimeout(id)),
    setInterval: globals.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
    clearInterval: globals.clearInterval ?? ((id) => clearInterval(id)),
    ...(globals.document !== undefined ? { document: globals.document } : {}),
    ...(globals.localStorage !== undefined ? { localStorage: globals.localStorage } : {}),
    ...(globals.extra ?? {}),
  };
  vm.runInNewContext(readFileSync(join(repoRoot, "lib/client.js"), "utf8"), sandbox, { filename: "lib/client.js" });
  if (registrations.length !== 1) throw new Error(`client.js 应恰好注册 1 个工厂,实际 ${registrations.length}`);
  const requireStub = (spec) => {
    if (spec === "react") return reactModule; // 真实 React(与 dsh 平台 seed 同物)
    throw new Error(`未预期的 require(${JSON.stringify(spec)}):平台 seed 词之外不支持(装载契约 2)`);
  };
  const mod = registrations[0].factory(requireStub);
  return { mod, registrations, sandbox };
}
