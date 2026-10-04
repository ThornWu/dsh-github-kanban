/**
 * S3.4 真实 React 测试(二):偏好持久化隔离(30 天到期、旧 snapshot/v1 清理、
 * 失配不落盘)、重试上限终止(虚拟时钟推进自愈轮)、StrictMode 双挂载生命周期。
 *
 * 与 board-lifecycle.test.mjs 同一环境(真实 React 18.3.1 + jsdom + 真实 apply 链);
 * 本文件的时间敏感场景(30 天偏好窗口 / 15 轮 ×4s 自愈轮)由虚拟时钟推进 ——
 * 时钟只作用于插件可见的定时器面,React 调度仍是真实实现(见 clock.mjs 头注)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mountPanel } from "../helpers/react-panel.mjs";
import { gatewayOk, gatewayFail, statusResult, twoProjectWorld } from "../helpers/fixtures.mjs";

const PACKAGE_ID = "@local/thorn-github-kanban";
const PREFS_KEY = `${PACKAGE_ID}/prefs/v1`;
const LEGACY_SNAPSHOT_KEY = `${PACKAGE_ID}/snapshot/v1`;

const world = twoProjectWorld();

/** 常规可用面板(两项目 + 各一块看板),可注入 listProjects 行为。 */
const makeFace = (overrides = {}) => {
  const boardCalls = [];
  const face = {
    status: async () => gatewayOk(statusResult()),
    listProjects: async () => gatewayOk(world.projects),
    getBoard: async (request) => {
      boardCalls.push(request);
      return gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]);
    },
    ...overrides,
  };
  return { face, boardCalls };
};

// ── 偏好持久化与隐私隔离(验收矩阵「同 origin 换身份」行) ───────────────────

test("S3.4 偏好:有效的持久化选择被延续(初拉偏好项目),写回仅含 { savedAt, selectedKey, theme }", async () => {
  const { face, boardCalls } = makeFace();
  const panel = await mountPanel({
    face,
    seedStorage: {
      [PREFS_KEY]: JSON.stringify({ savedAt: Date.now(), selectedKey: "#9" }),
      [LEGACY_SNAPSHOT_KEY]: JSON.stringify({ savedAt: 1, projects: [], selectedKey: "#9", board: { columns: [{ name: "SnapColumn", items: [{ id: "s1", title: "旧身份的卡" }] }] } }),
    },
  });
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [9], "初拉偏好选中的 #9");
  assert.ok(panel.text().includes("BetaColumn"), "渲染 #9 的看板");
  const stored = JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ["savedAt", "selectedKey", "theme", "v"], "0.9.0 起带 theme(UI 偏好)与 v:2 结构版本;仍不含任何业务数据");
  assert.equal(stored.v, 2, "v:2 起 theme 字段为三态模式(无版本旧值升级时按 auto 处理)");
  assert.equal(stored.selectedKey, "#9");
  await panel.unmount();
});

test("S3.4 偏好隔离:旧 snapshot/v1(整板快照含卡片数据)启动即清理,内容永不上屏", async () => {
  const { face } = makeFace();
  const panel = await mountPanel({
    face,
    seedStorage: {
      [LEGACY_SNAPSHOT_KEY]: JSON.stringify({ savedAt: 1, projects: [{ number: 9, title: "Beta" }], board: { columns: [{ name: "SnapColumn", items: [{ id: "s1", title: "旧身份的卡" }] }] } }),
    },
  });
  assert.equal(panel.dom.window.localStorage.getItem(LEGACY_SNAPSHOT_KEY), null, "旧快照键被清除");
  const text = panel.text();
  assert.ok(!text.includes("旧身份的卡") && !text.includes("SnapColumn"), "旧快照内容不出现");
  assert.ok(text.includes("AlphaColumn"), "上屏的是真实回包数据");
  await panel.unmount();
});

test("S3.4 偏好到期:savedAt 超出 30 天窗口不延续,回退列表第一项", async () => {
  const { face, boardCalls } = makeFace();
  const panel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: JSON.stringify({ savedAt: 1, selectedKey: "#9" }) }, // 1970 年存的
  });
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [7], "过期偏好忽略,回退第一项");
  const stored = JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.equal(stored.selectedKey, "#7", "写回实际选中");
  await panel.unmount();
});

test("S3.4 偏好到期:时钟前漂(savedAt 来自未来)同样视为无效", async () => {
  const { face, boardCalls } = makeFace();
  const panel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: JSON.stringify({ savedAt: Date.now() + 24 * 60 * 60 * 1000, selectedKey: "#9" }) },
  });
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [7]);
  await panel.unmount();
});

test("S3.4 偏好失配:选中键不在当前列表时不落盘(写入只认真实存在的项目)", async () => {
  const { face } = makeFace({
    listProjects: async () => gatewayOk({ ok: true, projects: [{ id: "p7", number: 7, title: "Alpha" }] }), // 列表里没有 #9
  });
  const panel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: JSON.stringify({ savedAt: Date.now(), selectedKey: "#9" }) },
  });
  await panel.settle();
  const stored = JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.equal(stored.selectedKey, "#7", "失配偏好不落盘,写回实际选中 #7");
  await panel.unmount();
});

test("S3.4 偏好结构:畸形 JSON / 缺字段静默忽略(偏好是纯优化,不是功能依赖)", async () => {
  const { face, boardCalls } = makeFace();
  const panel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: "{not json", [`${PACKAGE_ID}/prefs/other`]: "x" },
  });
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [7], "畸形偏好回退第一项,不崩");
  assert.ok(panel.text().includes("AlphaColumn"));
  await panel.unmount();
});

// ── 重试上限终止(验收矩阵「status 成功、列表持续瞬态失败」行;R04 语义端到端) ──

test("S3.4 重试上限:列表持续瞬态失败 → 自愈轮按 15 轮封顶终止;手动刷新重置预算后再封顶", async () => {
  let statusCalls = 0;
  let listCalls = 0;
  const panel = await mountPanel({
    face: {
      status: async () => {
        statusCalls += 1;
        return gatewayOk(statusResult()); // status 一直成功(R04 的精确场景)
      },
      listProjects: async () => {
        listCalls += 1;
        return gatewayFail("gateway/internal", "client api: githubKanban/listProjects failed: Failed to fetch");
      },
      getBoard: async () => gatewayOk(world.boards[7]),
    },
  });
  // 推进自愈轮直到稳定:15 轮封顶后,再推进也不应有新请求。
  const driveToCap = async () => {
    let stableChunks = 0;
    for (let chunk = 0; chunk < 40 && stableChunks < 2; chunk += 1) {
      const before = listCalls;
      await panel.advance(20_000);
      await panel.settle(2);
      stableChunks = listCalls === before ? stableChunks + 1 : 0;
    }
  };
  await driveToCap();
  const capped = listCalls;
  assert.ok(capped >= 16 * 5, `自愈轮真实发生(≥1 次初始 + 15 轮 × 链内容忍):${capped}`);
  let text = panel.text();
  assert.ok(text.includes("读取失败") && text.includes("[gateway/internal]"), "错误态可见且带 code");
  await panel.advance(60_000);
  assert.equal(listCalls, capped, "达上限后自动重试停止(推进时间无新请求)");
  text = panel.text();
  assert.ok(text.includes("读取失败"), "停在错误态等手动恢复");

  // 手动刷新:预算重置 → 重新自动重试 → 再次封顶(S1.5 语义)
  const button = panel.reloadButton();
  assert.ok(button !== undefined && button.disabled !== true);
  await panel.fireClick(button);
  await driveToCap();
  assert.ok(listCalls > capped, `手动刷新重置预算后重试真实发生:${capped} → ${listCalls}`);
  const recapped = listCalls;
  await panel.advance(60_000);
  assert.equal(listCalls, recapped, "新一轮仍按上限停止(不无界)");
  await panel.unmount();
}, { timeout: 120_000 });

// ── StrictMode 双挂载(真实 React 的 effect setup→cleanup→setup;R06 核心场景) ──

test("S3.4 StrictMode:effect 双调用(cleanup 真实执行)后最终状态一致,看板正常渲染", async () => {
  const { face, boardCalls } = makeFace();
  let statusCalls = 0;
  face.status = async () => {
    statusCalls += 1;
    return gatewayOk(statusResult());
  };
  const panel = await mountPanel({ face, strictMode: true });
  const text = panel.text();
  assert.ok(text.includes("AlphaColumn"), "双挂载后看板最终渲染成功");
  assert.ok(!text.includes("读取失败"), "无错误残留");
  assert.ok(statusCalls >= 2, `开发模式 StrictMode 双调用 effect(启动链跑了 ≥2 次):${statusCalls}`);
  // R2(代际守卫)后的有意变化:卸载已换代,旧链在首个检查点(status/list 回包后)被
  // 代际守卫拦下,不再发起多余的看板请求 —— 看板请求只属于重挂载后的新链。
  // (整改前旧链会照常拉看板、靠结果序号守卫丢弃;现在连请求都省了。)
  assert.equal(boardCalls.length, 1, `旧链被代际守卫作废,看板请求只来自新链:${boardCalls.length}`);
  assert.equal(panel.projectSelect().value, "#7", "选中态一致");

  // 双挂载后的轮询注册收敛为 1(重挂载不泄漏定时器)
  const intervals = panel.clock.pending().filter((task) => task.kind === "interval");
  assert.equal(intervals.length, 1, `轮询注册恰好 1 个:${JSON.stringify(intervals)}`);
  await panel.unmount();
  assert.ok(!panel.clock.pending().some((task) => task.kind === "interval"), "卸载后全部收口");
});

// ── 0.9.0 主题三态:跟随 dsh(auto,实时联动)/ 固定浅色 / 固定暗色 ──────────────
// jsdom 无 dsh 标记、无 matchMedia、背景全透明 → auto 态兜底链落到暗色;
// 需要「亮色生效」的用例用 domStubs 注入 matchMedia 假返回或 dsh 宿主标记属性。

test("0.9.0 主题三态:按钮循环 跟随dsh→浅色→暗色→跟随,data-tgk-theme 随动并持久化模式", async () => {
  const { face } = makeFace();
  const panel = await mountPanel({
    face,
    domStubs: (dom) => {
      dom.window.matchMedia = (query) => ({ media: query, matches: false }); // 兜底链会说亮色
    },
  });
  const root = () => panel.$(".tgk-root");
  const themeToggle = () => panel.$$(".tgk-themeToggle")[0];
  assert.ok(themeToggle() !== undefined, "工具栏带主题切换按钮");
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "auto 态:jsdom 无 dsh 标记,兜底链(matchMedia false)→ 生效亮色");
  assert.equal(themeToggle().getAttribute("aria-label"), "主题跟随 dsh 中,点击固定浅色", "auto 态 aria-label 指向固定浅色");

  await panel.fireClick(themeToggle()); // auto → light
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "固定浅色:生效主题不变(原本就是亮)");
  assert.equal(themeToggle().getAttribute("aria-label"), "切换到暗色模式", "下一态指向暗色");
  let stored = JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.equal(stored.theme, "light", "模式落盘(auto/light/dark 三值)");

  await panel.fireClick(themeToggle()); // light → dark
  assert.equal(root().getAttribute("data-tgk-theme"), "dark", "固定暗色生效");
  assert.equal(themeToggle().getAttribute("aria-label"), "跟随 dsh 主题(回到自动)");
  stored = JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.equal(stored.theme, "dark");

  await panel.fireClick(themeToggle()); // dark → auto(兜底链读数 = 亮)
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "回跟随态:立即采用宿主读数");
  assert.equal(themeToggle().getAttribute("aria-label"), "主题跟随 dsh 中,点击固定浅色");
  assert.ok(!panel.text().includes("读取失败"), "主题切换不扰动数据链");
  await panel.unmount();
});

test("0.9.0 主题实时联动:auto 态下 dsh 切换深浅色(body[data-ds-dark-theme])面板即时跟随;显式模式不随宿主", async () => {
  const { face } = makeFace();
  const panel = await mountPanel({
    face,
    domStubs: (dom) => {
      dom.window.document.body.setAttribute("data-ds-dark-theme", ""); // dsh 暗色标记(真机 2026-10-03 核实)
      dom.window.matchMedia = (query) => ({ media: query, matches: false }); // 移除标记后的兜底链会说亮色
    },
  });
  const root = () => panel.$(".tgk-root");
  const themeToggle = () => panel.$$(".tgk-themeToggle")[0];
  assert.equal(root().getAttribute("data-tgk-theme"), "dark", "auto 态:dsh 暗标记在场 → 生效暗色");

  panel.dom.window.document.body.removeAttribute("data-ds-dark-theme"); // 宿主切浅色
  await panel.settle(3); // observer 回调经微任务合并后派发
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "MutationObserver 联动:面板即时跟随变亮");
  assert.equal(JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY)).theme, "auto", "联动不改模式(仍 auto)");

  panel.dom.window.document.body.setAttribute("data-ds-dark-theme", "");
  await panel.settle(3);
  assert.equal(root().getAttribute("data-tgk-theme"), "dark", "切回暗色同样跟随");

  await panel.fireClick(themeToggle()); // auto → light(固定)
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "固定浅色生效");
  panel.dom.window.document.body.setAttribute("data-ds-dark-theme", "");
  await panel.settle(3);
  assert.equal(root().getAttribute("data-tgk-theme"), "light", "显式 light 不随宿主暗标记回场而变化(已停止订阅)");
  assert.equal(JSON.parse(panel.dom.window.localStorage.getItem(PREFS_KEY)).theme, "light");
  await panel.unmount();
});

test("0.9.0 主题:持久化的合法模式延续(v:2 偏好优先于宿主读数),非法值回 auto 走联动", async () => {
  const { face } = makeFace();
  const darkPanel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: JSON.stringify({ savedAt: Date.now(), v: 2, theme: "dark" }) },
    domStubs: (dom) => {
      dom.window.matchMedia = (query) => ({ media: query, matches: false }); // 联动读数会说亮色
    },
  });
  assert.equal(darkPanel.$(".tgk-root").getAttribute("data-tgk-theme"), "dark", "v:2 偏好固定 dark 优先于宿主读数(light)");
  await darkPanel.unmount();

  const invalidPanel = await mountPanel({
    face,
    seedStorage: { [PREFS_KEY]: JSON.stringify({ savedAt: Date.now(), v: 2, theme: "banana" }) },
    domStubs: (dom) => {
      dom.window.matchMedia = (query) => ({ media: query, matches: false });
    },
  });
  assert.equal(invalidPanel.$(".tgk-root").getAttribute("data-tgk-theme"), "light", "非法 theme 回 auto → 宿主读数(matchMedia false → light)");
  const stored = JSON.parse(invalidPanel.dom.window.localStorage.getItem(PREFS_KEY));
  assert.equal(stored.theme, "auto", "写回的是归一后的模式(auto),非生效主题");
  await invalidPanel.unmount();
});

test("0.9.0 主题默认检测:dsh 标记体系优先(暗标记压过一切),旧式 data-theme 线索次之,全无线索兜底暗色", async () => {
  const { face } = makeFace();
  const dshDarkPanel = await mountPanel({
    face,
    domStubs: (dom) => {
      dom.window.matchMedia = (query) => ({ media: query, matches: false }); // 系统偏好亮色
      dom.window.document.body.setAttribute("data-ds-dark-theme", ""); // dsh 说暗色
    },
  });
  assert.equal(dshDarkPanel.$(".tgk-root").getAttribute("data-tgk-theme"), "dark", "dsh 暗标记优先于系统偏好");
  await dshDarkPanel.unmount();

  const hostLightPanel = await mountPanel({
    face,
    domStubs: (dom) => {
      dom.window.matchMedia = (query) => ({ media: query, matches: true }); // 系统偏好暗色
      dom.window.document.documentElement.setAttribute("data-theme", "light"); // 旧式宿主线索说亮色
    },
  });
  assert.equal(hostLightPanel.$(".tgk-root").getAttribute("data-tgk-theme"), "light", "宿主线索(亮)压过系统偏好(暗)");
  await hostLightPanel.unmount();

  const fallbackPanel = await mountPanel({ face }); // jsdom:无线索、无 matchMedia → 兜底
  assert.equal(fallbackPanel.$(".tgk-root").getAttribute("data-tgk-theme"), "dark", "兜底暗色");
  await fallbackPanel.unmount();
});
