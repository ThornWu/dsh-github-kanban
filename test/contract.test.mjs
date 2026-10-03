/**
 * S3.5 dsh 契约验证:注册、挂载、信封 {ok,value}、服务缺席、重连。
 *
 * 替身边界(逐项声明,阶段 5 真机验收的对照清单):
 *   - 用替身:dsh 装载器行为(window.__ModuleLoader__ / require 平台 seed)、
 *     座位/文案/remote 服务本身、网关 transport(信封形状)。
 *   - 需真实宿主(归阶段 5):dsh-client-modules 真装载、dsh-api-gateway 真编解码
 *     与 SRC 描述符生成、cordis scoped fiber 的服务等待语义、timer Service 的
 *     ctx.timeout/ctx.interval 存在性、真浏览器里的 seat 渲染。
 * 本套件钉住的是:**本包两侧的 wire 形状**在上述替身下的自洽 —— 升级 dsh 时
 * 这里红了先怀疑形状漂移,再去核对官方源码(升级清单见 notes/dev-notes.md)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as host from "../lib/index.js";
import { loadClient, createMemoryStorage } from "./helpers/load-client.mjs";
import { createVirtualClock } from "./helpers/clock.mjs";
import { jsonEqual } from "./helpers/assertions.mjs";
import { gatewayOk, gatewayFail, statusResult, projectsResult, boardResult, strictArgumentFace, manifestArities } from "./helpers/fixtures.mjs";

/** 冲刷微任务链到 macrotask 边界(让 boardApi 的 await 链走到 deadline 登记)。 */
const flushAsync = async () => {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const PANEL_ID = "github-kanban";
const NS = "thorn-github-kanban";
const SERVICE_KEY = "githubKanban";

// ── 注册(装载契约:load({id, factory})、零副作用) ──────────────────────────

test("S3.5 注册:client.js 恰好注册一个工厂,id === 包名(load 阶段零副作用)", () => {
  const registrations = [];
  const styleTags = [];
  const sandboxWindow = {};
  sandboxWindow.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
  vm.runInNewContext(
    readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"),
    {
      window: sandboxWindow,
      document: {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: "" }),
        head: { appendChild: (tag) => styleTags.push(tag) },
      },
      console,
    },
    { filename: "lib/client.js" },
  );
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, pkg.name);
  assert.deepEqual(Object.keys(registrations[0]).sort(), ["factory", "id"], "注册形态就是 {id, factory}");
  assert.equal(styleTags.length, 0, "样式在物化前不注入(装载阶段零副作用)");
});

test("S3.5 注册:物化后导出 apply/inject,inject 恰好声明四个客户端服务", () => {
  const { mod } = loadClient({ globals: { localStorage: createMemoryStorage() } });
  assert.equal(typeof mod.apply, "function");
  jsonEqual(mod.inject, ["slots", "locale", "remote", "timer"]);
  assert.ok(!mod.inject.includes("remote.githubKanban"), "自装服务全名禁止进入口清单(2026-10-01 真机死锁回归)");
});

// ── 挂载(座位/文案/远程清单/scoped fiber 取面) ────────────────────────────

/** 完整 ctx 替身(带可注入 face 与时钟),返回观测面。 */
const makeCtx = ({ face = {}, clock, omit = [] } = {}) => {
  const seats = [];
  const dictsByNs = new Map();
  const mountedContributions = [];
  const scopedInjectCalls = [];
  const ctx = {
    effect: (callback) => callback(),
    inject: (injectList, callback) => {
      scopedInjectCalls.push([...injectList]);
      // 面替身过参数数量闸(R2/P1):与网关客户端 prepareInvocation 的精确数量判定同严,
      // 数量口径取自 $mount 清单(见 fixtures.mjs strictArgumentFace 注释)。
      if (!omit.includes("face")) callback({ remote: { [SERVICE_KEY]: strictArgumentFace(face, manifestArities(mountedContributions[0])) } });
      return { dispose: () => {} };
    },
    slots: {
      inject: (seat, factory) => factory(),
      register: (options, component) => {
        seats.push({ options, component });
        return () => {};
      },
    },
    remote: { $mount: async (contribution) => { mountedContributions.push(contribution); return () => {}; } },
    timeout: (callback, ms) => clock.setTimeout(callback, ms),
    interval: (callback, ms) => clock.setInterval(callback, ms),
    locale: {
      register: (ns, dicts) => { dictsByNs.set(ns, dicts); return () => {}; },
      bind: (ns) => (key, params) => {
        const raw = dictsByNs.get(ns)?.zh?.[key] ?? key;
        return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
      },
    },
  };
  if (omit.includes("remote")) delete ctx.remote;
  return { ctx, seats, dictsByNs, mountedContributions, scopedInjectCalls };
};

const applyClient = async ({ face, clock = createVirtualClock(), omit } = {}) => {
  const { mod } = loadClient({ globals: { localStorage: createMemoryStorage() } });
  const harness = makeCtx({ face, clock, omit });
  await mod.apply(harness.ctx);
  const mainSeat = harness.seats.find((seat) => seat.options.key === PANEL_ID);
  return { ...harness, mod, mainSeat, boardApi: mainSeat?.options?.inject?.().board };
};

test("S3.5 挂载:注册 main + panellist 两个座位,属性与面板 id/命名空间对齐", async () => {
  const { seats } = await applyClient();
  const names = seats.map((seat) => seat.options.name).sort();
  assert.deepEqual(names, ["main", "sidebar.panellist"]);
  const main = seats.find((seat) => seat.options.name === "main");
  assert.equal(main.options.key, PANEL_ID);
  assert.equal(main.options.locale, NS);
  assert.equal(main.options.registrant, pkg.name);
  const panel = seats.find((seat) => seat.options.name === "sidebar.panellist");
  assert.deepEqual({ id: panel.options.id, order: panel.options.order, key: panel.options.key ?? "(none)" }, { id: PANEL_ID, order: 20, key: "(none)" });
  assert.equal(panel.options.label(), "GitHub 看板", "入口 label 由词典出");
});

test("S3.5 挂载:文案经 ctx.effect 注册,zh/en 逐键对照", async () => {
  const { dictsByNs } = await applyClient();
  const dicts = dictsByNs.get(NS);
  const zhKeys = Object.keys(dicts?.zh ?? {}).sort();
  const enKeys = Object.keys(dicts?.en ?? {}).sort();
  assert.ok(zhKeys.length > 0);
  assert.deepEqual(zhKeys, enKeys);
});

test("S3.5 挂载:远程清单 3 个 direct 方法,strict 编解码满足 registry 客户端规则", async () => {
  const { mountedContributions } = await applyClient();
  assert.equal(mountedContributions.length, 1);
  const contribution = mountedContributions[0];
  assert.equal(contribution.package, pkg.name);
  const SEGMENT = /^[A-Za-z0-9_$.-]+$/;
  for (const descriptor of contribution.descriptors) {
    assert.ok(typeof descriptor.id === "string" && descriptor.id.length > 0, "id 非空");
    for (const key of ["service", "namespace", "method"]) assert.ok(SEGMENT.test(descriptor[key]) && descriptor[key] !== "." && descriptor[key] !== "..", `${key}=${descriptor[key]} 合法端点段`);
    assert.equal(descriptor.invocation.kind, "direct");
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.source, "json");
      assert.ok(SEGMENT.test(parameter.name) && SEGMENT.test(parameter.wire));
      assert.equal(parameter.codec.mode, "strict");
      assert.equal(typeof parameter.codec.typeSymbol, "string");
      assert.equal(typeof parameter.codec.create, "function");
    }
    assert.equal(descriptor.result.mode, "strict");
    assert.equal(typeof descriptor.result.typeSymbol, "string");
    assert.equal(typeof descriptor.result.create, "function");
  }
  assert.deepEqual(contribution.descriptors.map((descriptor) => descriptor.method).join(",").split(","), ["status", "listProjects", "getBoard"]);
});

test("S3.5 挂载:取面走 scoped fiber(双名 inject,恰好一次)", async () => {
  const { scopedInjectCalls } = await applyClient();
  assert.equal(scopedInjectCalls.length, 1);
  assert.deepEqual(scopedInjectCalls[0], ["remote", "remote.githubKanban"], "父名 + 全名对齐官方插件口径");
});

// ── 信封 {ok, value}(网关 direct 调用的返回拆包) ───────────────────────────

test("S3.5 信封:{ok:true, value:<业务>} 被拆包为业务结果;业务失败信封原样透传", async () => {
  const face = {
    status: async () => gatewayOk(statusResult({ tokenConfigured: true })),
    listProjects: async () => gatewayFail("http_error", "GitHub API HTTP 401。"),
    getBoard: async () => gatewayOk(boardResult({ columns: [] })),
  };
  const { boardApi } = await applyClient({ face });
  const status = await boardApi.status();
  assert.equal(status.ok, true);
  assert.equal(status.status.tokenConfigured, true, "拆包后就是业务形状(无 value 一层)");
  const list = await boardApi.listProjects();
  assert.equal(list.ok, false);
  assert.equal(list.error.code, "http_error", "网关失败信封透传(code/message 保留)");
  const board = await boardApi.getBoard();
  assert.equal(board.ok, true);
  assert.ok(Array.isArray(board.board.columns));
});

test("S3.5 信封:非信封/畸形返回折叠为 shape_error(可观测,不静默)", async () => {
  const face = {
    status: async () => "garbage",
    listProjects: async () => null,
    getBoard: async () => 42, // 非对象:无 ok 语义,不是业务结果
  };
  const { boardApi } = await applyClient({ face });
  for (const method of ["status", "listProjects", "getBoard"]) {
    const result = await boardApi[method]();
    assert.equal(result.ok, false, `${method} → 结构化失败`);
    assert.equal(result.error.code, "shape_error", `${method} → shape_error`);
  }
});

test("S3.5 有界等待:方法调用悬挂 → deadline 到期返回 remote_timeout,迟到回包被忽略", async () => {
  const clock = createVirtualClock();
  let lateResolve;
  const face = {
    status: () => new Promise((resolve) => { lateResolve = resolve; }),
    listProjects: async () => gatewayOk(projectsResult([])),
    getBoard: async () => gatewayOk(boardResult({ columns: [] })),
  };
  const { boardApi } = await applyClient({ face, clock });
  const pending = boardApi.status();
  await flushAsync(); // 让调用链走到 deadline 登记(定时器此刻才进时钟)
  await clock.advance(20_001); // 越过 REMOTE_CALL_DEADLINE_MS(20s)
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "remote_timeout");
  assert.ok(result.error.message.includes("githubKanban.status"), "文案点名方法");
  lateResolve(gatewayOk(statusResult()));
  await flushAsync();
  assert.equal(result.error.code, "remote_timeout", "迟到回包不改变已返回的结果");
});

// ── 参数数量(R2/P1:网关客户端 prepareInvocation 精确数量判定的镜像) ─────────
// 源码核验(2026-10-03,@deepseek-ai/dsh 0.2.0-rc.2,dsh-api-gateway/lib/client.js):
// 客户端把「清单形参数量」与实参数量做精确相等比对,0 实参调用声明 1 参的方法直接抛
// "client api: githubKanban/listProjects expected 1 argument(s), got 0" → 折成
// remote_error(非瞬态)→ 真机首载/自动重试全挂。宿主侧 methodParameterNames 只认
// 简单标识符(默认参数/rest 即签名无效),因此「可选 request」在 wire 上不存在数量宽容。

test("S3.5 参数数量:首载与刷新链的 listProjects 调用恒以恰好 1 个实参到达远程面", async () => {
  const argCounts = [];
  const face = {
    status: async (...args) => { argCounts.push(`status:${args.length}`); return gatewayOk(statusResult()); },
    listProjects: async (...args) => { argCounts.push(`listProjects:${args.length}`); return gatewayOk(projectsResult([{ id: "p7", number: 7, title: "Alpha" }])); },
    getBoard: async (...args) => { argCounts.push(`getBoard:${args.length}`); return gatewayOk(boardResult({ columns: [{ optionId: "o1", name: "Todo", items: [] }] })); },
  };
  const { boardApi, mod } = await applyClient({ face });
  // 真实控制器直驱(不经 React):start 首载不带 request(0 形参调用点),reload 带 noCache
  const controller = mod.internals.createBoardController({
    getApi: () => boardApi,
    t: (key) => key,
    delay: () => Promise.resolve(),
    scheduleRetry: () => () => {},
  });
  controller.start();
  await flushAsync();
  assert.equal(controller.getSnapshot().phase, "ready", `首载完整成功:${JSON.stringify(argCounts)}`);
  controller.reload();
  await flushAsync();
  controller.dispose();
  assert.deepEqual(
    argCounts,
    ["status:0", "listProjects:1", "getBoard:1", "status:0", "listProjects:1", "getBoard:1"],
    "status 恒 0 实参;声明 1 参的方法(含无 request 的首载)恒以恰好 1 个实参到达面",
  );
});

test("S3.5 参数数量:数量替身与真网关同严 —— boardApi 的全部调用形态都被严格面接受", async () => {
  // 用与网关同严的面替身跑 boardApi 的三种调用形态:0 参 status、无 request 的
  // listProjects()(首载口径)、带 request 的 getBoard。任何形态数量不符都直接抛
  // (remote_error),这里要求全部通过 —— 即真网关下这些调用形态都会被接受。
  const face = strictArgumentFace({
    status: async () => gatewayOk(statusResult()),
    listProjects: async () => gatewayOk(projectsResult([])),
    getBoard: async () => gatewayOk(boardResult({ columns: [] })),
  }, { status: 0, listProjects: 1, getBoard: 1 });
  const { boardApi } = await applyClient({ face });
  const status = await boardApi.status();
  const list = await boardApi.listProjects(); // 首载口径:不传 request
  const board = await boardApi.getBoard({ projectNumber: 7 });
  assert.equal(status.ok, true, `status(0 实参)被严格面接受:${JSON.stringify(status)}`);
  assert.equal(list.ok, true, `listProjects() 无 request 调用被严格面接受(恰好 1 实参):${JSON.stringify(list)}`);
  assert.equal(board.ok, true);
});



test("S3.5 服务缺席:ctx.remote 缺失 → boardApi 返回 remote_missing,不抛不挂", async () => {
  const { boardApi } = await applyClient({ omit: ["remote"] });
  const result = await boardApi.status();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "remote_missing");
});

test("S3.5 服务缺席:远程面缺方法 → remote_missing 点名缺失方法", async () => {
  const face = { status: async () => gatewayOk(statusResult()) }; // 缺 listProjects/getBoard
  const { boardApi } = await applyClient({ face });
  const result = await boardApi.listProjects();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "remote_missing");
  assert.ok(result.error.message.includes("listProjects"));
});

test("S3.5 服务缺席:$mount 抛错 → remote_mount_failed(结构化,不炸装载)", async () => {
  const { mod } = loadClient({ globals: { localStorage: createMemoryStorage() } });
  const seats = [];
  const ctx = {
    effect: (callback) => callback(),
    inject: (list, callback) => callback({ remote: { [SERVICE_KEY]: {} } }),
    slots: { inject: (seat, factory) => factory(), register: (options) => { seats.push({ options }); return () => {}; } },
    remote: { $mount: async () => { throw new Error("gateway rejected"); } },
    locale: makeCtx().ctx.locale,
  };
  await mod.apply(ctx); // 不抛:挂载失败是可降级运行态
  const boardApi = seats.find((seat) => seat.options.key === PANEL_ID)?.options?.inject?.().board;
  const result = await boardApi.status();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "remote_mount_failed");
  assert.ok(result.error.message.includes("gateway rejected"));
});

// ── 重连(载波失败 → 瞬态分类 → 控制器自愈;不经 React 直驱) ────────────────

test("S3.5 重连:gateway/internal 载波失败经 boardApi→控制器自动重试后恢复(替身链)", async () => {
  const clock = createVirtualClock();
  let statusCalls = 0;
  const face = {
    status: async () => {
      statusCalls += 1;
      if (statusCalls <= 2) return gatewayFail("gateway/internal", "client api: githubKanban/status failed: Failed to fetch");
      return gatewayOk(statusResult());
    },
    listProjects: async () => gatewayOk(projectsResult([{ id: "p7", number: 7, title: "Alpha" }])),
    getBoard: async () => gatewayOk(boardResult({ columns: [{ optionId: "o1", name: "Todo", items: [] }] })),
  };
  const { boardApi, mod } = await applyClient({ face, clock });
  // 用真实控制器直驱(不经 React):链内容忍 + 到 ready
  const t = (key) => key;
  const controller = mod.internals.createBoardController({
    getApi: () => boardApi,
    t,
    delay: (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
    scheduleRetry: (callback, ms) => { const id = clock.setTimeout(callback, ms); return () => clock.clearTimeout(id); },
  });
  controller.start();
  await flushAsync(); // 启动链推进到首个退避等待(时钟登记后才可推进)
  await clock.advance(3_000);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "ready", `两次载波失败后自愈:${JSON.stringify({ statusCalls, phase: snapshot.phase })}`);
  assert.ok(snapshot.board !== undefined);
  controller.dispose();
});

// ── 宿主侧注册契约(供阶段 5 真机对照的最小面) ──────────────────────────────

test("S3.5 宿主注册:apply 发布 githubKanban 服务,带 v1 Remote 标记与冻结绑定", async () => {
  const provided = new Map();
  const logs = [];
  host.apply({ provide: (key, value) => provided.set(key, value), logger: { info: (message) => logs.push(message) } }, {});
  const service = provided.get(SERVICE_KEY);
  assert.ok(service !== undefined, "服务经 ctx.provide 发布");
  assert.equal(service.typertRemote.serviceKey, SERVICE_KEY);
  assert.equal(Object.isFrozen(service.typertRemote), true, "绑定冻结(protocol bindTypertRemote 形状)");
  const marker = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "@deepseek-ai/dsh-typert-protocol/remote-methods")?.value;
  assert.equal(marker.version, 1);
  assert.deepEqual(marker.methods.map((entry) => entry.method), ["status", "listProjects", "getBoard"]);
  assert.ok(Object.isFrozen(marker.methods[0]) && Object.isFrozen(marker.methods[0].invocation), "marker 冻结");
  assert.ok(logs.length === 1 && !logs[0].includes("ghp_"), "激活日志不含任何凭据");
});
