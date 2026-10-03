/**
 * S3.4 真实 React 测试(一):看板生命周期 —— 首次失败+恢复按钮、正常渲染、
 * 快速切换、卸载后定时器清理与迟到响应忽略、页面后台/回前台、宿主重连恢复。
 *
 * 这是 R06 的兑现位置:React/react-dom 为真实实现(18.3.1,与 dsh 宿主注入版本
 * 一致),effect 的 setup/cleanup/卸载语义由 React 真实调度 —— 不再以自制 hook
 * 模拟证明生命周期行为。装配与替身边界见 test/helpers/react-panel.mjs 头注。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mountPanel, setVisibility } from "../helpers/react-panel.mjs";
import { gatewayOk, gatewayFail, statusResult, projectsResult, boardResult, column, card, twoProjectWorld } from "../helpers/fixtures.mjs";

const PACKAGE_ID = "@local/thorn-github-kanban";

// ── 首次加载失败 + 恢复入口(验收矩阵「无快照首次加载失败」行,R05) ─────────

test("S3.4 首载失败:错误态带 [code] 与可操作的刷新按钮;点击后整链重拉(noCache)并恢复", async () => {
  const world = twoProjectWorld();
  const listCalls = [];
  let listMode = "fail";
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async (request) => {
        listCalls.push(request);
        if (listMode === "fail") return gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } });
        return gatewayOk(world.projects);
      },
      getBoard: async (request) => gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]),
    },
  });
  const errorText = panel.text();
  assert.ok(errorText.includes("读取失败"), `错误态可见:${errorText.slice(0, 80)}`);
  assert.ok(errorText.includes("[http_error]"));
  assert.ok(!errorText.includes("该项目还没有看板条目"), "不把失败伪装成空看板");
  const button = panel.reloadButton();
  assert.ok(button !== undefined, "刷新按钮在场");
  assert.notEqual(button.disabled, true, "按钮可操作");
  assert.equal(listCalls.length, 1, "非瞬态失败不自动重试(只有首载那一次)");

  listMode = "ok";
  await panel.fireClick(button);
  await panel.settle();
  const recovered = panel.text();
  assert.ok(recovered.includes("AlphaColumn"), "恢复后渲染看板");
  assert.ok(!recovered.includes("读取失败"));
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[1].noCache, true, "刷新 = 整链带 noCache 重拉");
  await panel.unmount();
});

test("S3.4 服务缺席:ctx.remote 缺失时面板给出错误而非挂死(可恢复,不空白)", async () => {
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(projectsResult([])),
      getBoard: async () => gatewayOk(boardResult({ columns: [] })),
    },
    decorateCtx: (ctx) => {
      delete ctx.remote;
    },
  });
  const text = panel.text();
  assert.ok(text.includes("读取失败"), "结构化错误态在场");
  assert.ok(text.includes("[remote_missing]"), `点名 remote_missing:${text.match(/读取失败[^\n]{0,60}/)?.[0] ?? ""}`);
  assert.ok(panel.reloadButton() !== undefined, "仍有恢复入口");
  await panel.unmount();
});

// ── 正常渲染与两项目切换(验收矩阵「有卡项目与至少两个项目切换」行的替身侧) ──

test("S3.4 正常渲染:两个项目可选,列/卡/负责人/标签/计数与数据一致", async () => {
  const board7 = boardResult({
    number: 7,
    title: "Alpha",
    columns: [
      column({ name: "Todo", optionId: "o1", items: [card({ id: "a1", title: "待办卡" })] }),
      column({ name: "In Progress", optionId: "o2", items: [card({ id: "a2", title: "进行中的卡", assignees: ["octocat"], labels: [{ name: "P1", color: "ff8800" }] })] }),
      column({ name: "Done", optionId: "o3", items: [] }),
    ],
    totalCount: 2,
  });
  const board9 = boardResult({ number: 9, title: "Beta", columns: [column({ name: "BetaColumn", optionId: "o1", items: [card({ id: "b1", title: "Beta 的卡" })] })], totalCount: 1 });
  const boardCalls = [];
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(projectsResult([{ id: "p7", number: 7, title: "Alpha" }, { id: "p9", number: 9, title: "Beta" }])),
      getBoard: async (request) => {
        boardCalls.push(request);
        return gatewayOk(request.projectNumber === 9 ? board9 : board7);
      },
    },
  });
  const text = panel.text();
  const select = panel.projectSelect();
  assert.ok(select !== undefined, "项目切换器在场");
  assert.equal(select.value, "#7", "默认选中第一项");
  assert.deepEqual([...select.options].map((option) => option.textContent), ["#7 Alpha", "#9 Beta"]);
  const columnNames = panel.$$(".tgk-column").map((element) => element.getAttribute("aria-label"));
  assert.deepEqual(columnNames, ["Todo", "In Progress", "Done"], "列序 = Status 选项序");
  assert.ok(text.includes("空"), "空列标注「空」");
  assert.ok(text.includes("@octocat") && text.includes("P1"), "负责人与标签渲染");
  assert.ok(text.includes("共 2 张卡"), "计数 = 服务端总数口径");
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [7], "初拉默认项目");

  await panel.fireChange(select, "#9");
  await panel.settle();
  assert.equal(panel.projectSelect().value, "#9");
  assert.deepEqual(boardCalls.map((call) => call.projectNumber), [7, 9], "切换后拉取新项目");
  assert.ok(panel.text().includes("BetaColumn"));
  await panel.unmount();
});

// ── 快速切换、响应倒序(验收矩阵「快速切换、响应倒序」行) ───────────────────

test("S3.4 快速切换:慢的旧响应不覆盖当前项目;加载期间旧看板退位不冒充", async () => {
  const world = twoProjectWorld();
  let releaseBeta;
  const betaGate = new Promise((resolve) => {
    releaseBeta = resolve;
  });
  let betaGated = false;
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async (request) => {
        if (request.projectNumber === 9 && betaGated) await betaGate; // #9 的回包被拦住
        return gatewayOk(world.boards[request.projectNumber]);
      },
    },
  });
  assert.ok(panel.text().includes("AlphaColumn"), "初拉 #7");
  const select = panel.projectSelect();

  betaGated = true;
  await panel.fireChange(select, "#9");
  await panel.settle(3);
  const midText = panel.text();
  assert.ok(midText.includes("正在读取"), "加载新项目期间显示读取中");
  assert.ok(!midText.includes("AlphaColumn"), "旧看板退位,不冒充新项目内容");

  await panel.fireChange(panel.projectSelect(), "#7"); // 切回 #7(#7 立即回包)
  await panel.settle();
  assert.ok(panel.text().includes("AlphaColumn"));

  releaseBeta(); // #9 的迟到回包到达
  await panel.settle(6);
  const finalText = panel.text();
  assert.ok(finalText.includes("AlphaColumn") && !finalText.includes("BetaColumn"), "迟到回包不覆盖当前项目");
  await panel.unmount();
});

// ── 卸载:定时器清理与迟到响应忽略(验收矩阵「页面后台、恢复前台、卸载」行的卸载半边) ──

test("S3.4 卸载清理:轮询注册释放,迟到回包不重渲染、不再触发新轮询", async () => {
  const world = twoProjectWorld();
  const boardCalls = [];
  let gateResolve;
  let gated = false;
  const gate = new Promise((resolve) => {
    gateResolve = resolve;
  });
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async (request) => {
        boardCalls.push(request.projectNumber);
        if (gated) await gate;
        return gatewayOk(world.boards[request.projectNumber]);
      },
    },
  });
  assert.equal(boardCalls.length, 1, "初拉一次");
  assert.ok(panel.clock.pending().some((task) => task.kind === "interval"), "轮询定时器已注册");

  gated = true;
  await panel.advance(30_000); // 轮询 tick:第 2 次请求被拦住(pending)
  assert.equal(boardCalls.length, 2);

  await panel.unmount();
  assert.ok(!panel.clock.pending().some((task) => task.kind === "interval"), "卸载后无遗留轮询调度");
  assert.equal(panel.container.textContent, "", "渲染树已清空");

  gateResolve(); // 迟到回包到达(已卸载)
  await panel.settle(4);
  await panel.advance(60_000); // 卸载后继续推进时间:不得有任何新请求/新渲染
  assert.equal(boardCalls.length, 2, "无新请求");
  assert.equal(panel.container.textContent, "");
  await panel.unmount();
});

test("S3.4 卸载清理:错误态自愈定时器同样收口(卸载后推进时间不再发起请求)", async () => {
  const transientFail = () => gatewayFail("gateway/internal", "client api: githubKanban/listProjects failed: Failed to fetch");
  let statusCalls = 0;
  const panel = await mountPanel({
    face: {
      status: async () => {
        statusCalls += 1;
        return gatewayOk(statusResult());
      },
      listProjects: async () => transientFail(),
      getBoard: async () => gatewayOk(twoProjectWorld().boards[7]),
    },
  });
  await panel.advance(30_000); // 推进自愈轮若干轮(卸载前有活跃 retry 定时器)
  const callsAtUnmount = statusCalls;
  assert.ok(callsAtUnmount > 1, `自愈轮已发生:${callsAtUnmount}`);
  assert.ok(panel.clock.pending().some((task) => task.kind === "timeout"), "有在册的自愈定时器");

  await panel.unmount();
  await panel.advance(120_000);
  assert.equal(statusCalls, callsAtUnmount, "卸载后自愈轮不再发请求");
  assert.ok(!panel.clock.pending().some((task) => task.kind === "timeout"), "自愈定时器已被取消");
  await panel.unmount();
});

// ── 页面后台 / 恢复前台(验收矩阵同行的后台半边;真实 defaultIsVisible 探针) ──

test("S3.4 可见性:页面后台跳过本轮轮询,回前台恢复(真实 defaultIsVisible 路径)", async () => {
  const world = twoProjectWorld();
  const boardCalls = [];
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async (request) => {
        boardCalls.push(request.projectNumber);
        return gatewayOk(world.boards[request.projectNumber]);
      },
    },
  });
  assert.equal(boardCalls.length, 1);

  setVisibility(panel.dom.window.document, "hidden");
  await panel.advance(30_000);
  assert.equal(boardCalls.length, 1, "后台期间 tick 被跳过(不发起请求)");

  setVisibility(panel.dom.window.document, "visible");
  await panel.advance(30_000);
  assert.equal(boardCalls.length, 2, "回前台后下一 tick 恢复轮询");
  assert.ok(panel.text().includes("AlphaColumn"), "面板仍在渲染");
  await panel.unmount();
});

// ── 宿主重启窗口的连接恢复(验收矩阵「宿主重启、网络中断后恢复」行的替身侧) ──

test("S3.4 重连:连接未就绪两次后自愈,面板恢复渲染且无残留错误态", async () => {
  const world = twoProjectWorld();
  let statusCalls = 0;
  const panel = await mountPanel({
    face: {
      status: async () => {
        statusCalls += 1;
        if (statusCalls <= 2) return gatewayFail("gateway/internal", "client api: githubKanban/status failed: Failed to fetch");
        return gatewayOk(statusResult());
      },
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async (request) => gatewayOk(world.boards[request.projectNumber]),
    },
  });
  const text = panel.text();
  assert.ok(text.includes("AlphaColumn"), "自愈后看板渲染");
  assert.ok(!text.includes("读取失败"), "无残留错误态");
  assert.ok(statusCalls >= 3, `确有重试发生:${statusCalls}`);
  await panel.unmount();
});

test("S3.4 面板样式随物化注入且带插件归属(浏览器行为,jsdom DOM 验证)", async () => {
  const world = twoProjectWorld();
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult({ tokenConfigured: false })),
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async () => gatewayOk(world.boards[7]),
    },
  });
  const styleTag = panel.dom.window.document.head.querySelector(`style[data-plugin-css="${PACKAGE_ID}/panel.css"]`);
  assert.ok(styleTag !== undefined, "样式标签存在");
  assert.equal(styleTag.dataset.plugin, PACKAGE_ID, "带插件归属(卸载/HMR 由框架认领)");
  assert.ok(styleTag.textContent.includes(".tgk-root"));
  assert.ok(panel.text().includes("尚未配置 GitHub 访问令牌"), "token 未配置走引导视图");
  await panel.unmount();
});

// ── R2(第二轮整改)回归:代际守卫 / 刷新链序 / 空列表来源警告(2026-10-03) ──────

test("R2 代际:StrictMode 双挂载后,卸载前在途的旧链列表回包不得清空新链状态", async () => {
  let listCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const world = twoProjectWorld();
  const panel = await mountPanel({
    strictMode: true, // 真实双挂载:setup → cleanup(dispose)→ setup(start 重挂载)
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          await firstGate; // 第 1 条链(卸载前)的列表回包被拦住
          return gatewayOk(projectsResult([])); // 旧链视角:空列表
        }
        return gatewayOk(world.projects); // 第 2 条链(重挂载后)立即拿到两项目
      },
      getBoard: async (request) => gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]),
    },
  });
  assert.ok(listCalls >= 2, `双挂载两条链都发起了列表请求:${listCalls}`);
  const healthy = panel.text();
  assert.ok(healthy.includes("AlphaColumn"), `重挂载新链正常工作(渲染新链数据):${healthy.slice(0, 80)}`);
  assert.equal(panel.projectSelect().value, "#7");

  releaseFirst(); // 卸载前旧链的迟到回包到达
  await panel.settle(6);
  const after = panel.text();
  assert.ok(after.includes("AlphaColumn"), `旧链迟到的空列表不得清掉新链状态:${after.slice(0, 80)}`);
  assert.ok(!after.includes("没有可显示"), "不回退到「暂无项目」");
  assert.equal(panel.projectSelect()?.value, "#7", "选中态不被旧链覆盖");
  await panel.unmount();
});

test("R2 链序:手动刷新整链完成后,首载链迟到的空列表不得回退刷新链的新状态", async () => {
  let listCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const world = twoProjectWorld();
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          await firstGate; // 首载链的列表回包被拦住(面板停在读取中)
          return gatewayOk(projectsResult([])); // 旧链视角:空列表
        }
        return gatewayOk(world.projects); // 刷新链:立即拿到两项目
      },
      getBoard: async (request) => gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]),
    },
  });
  const button = panel.reloadButton();
  assert.ok(button !== undefined && button.disabled !== true, "读取中刷新按钮仍可操作");

  await panel.fireClick(button); // 手动刷新:整链 noCache 重拉,新链先完成
  await panel.settle();
  assert.ok(panel.text().includes("AlphaColumn"), "刷新链先完成,渲染新数据");
  assert.equal(listCalls, 2, `首载 1 次 + 刷新 1 次:${listCalls}`);

  releaseFirst(); // 首载链的迟到回包到达(旧数据:空列表)
  await panel.settle(6);
  const after = panel.text();
  assert.ok(after.includes("AlphaColumn") && !after.includes("没有可显示"), `旧链迟到的空列表不得回退新链状态:${after.slice(0, 80)}`);
  assert.equal(panel.projectSelect()?.value, "#7", "列表与选中保持新链口径");
  await panel.unmount();
});

test("R2 空列表:viewer 0 项目 + 来源失败/截断时,「暂无项目」分支也显示来源警告", async () => {
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () =>
        gatewayOk(
          projectsResult([], [
            { source: "octocat/gone", code: "repo_missing", message: "仓库不存在或无权限" },
            { source: "octocat/alpha", code: "projects_truncated", message: "项目数达到分页上限(300)" },
          ]),
        ),
      getBoard: async () => gatewayOk(boardResult({ columns: [] })),
    },
  });
  const text = panel.text();
  assert.ok(text.includes("没有可显示"), "空列表提示在场");
  assert.ok(text.includes("部分项目来源读取失败"), `来源失败警告在空列表分支可见(不只藏看板区):${text.slice(0, 120)}`);
  assert.ok(text.includes("octocat/gone"), "点名失败来源");
  assert.ok(text.includes("列表可能不完整"), "来源截断警告同样可见(独立文案,不与失败句式混排)");
  assert.ok(text.includes("octocat/alpha"), "点名截断来源");
  await panel.unmount();
});

// ── R3(第三轮整改)回归:轮询/切换的看板成功不得掩盖链级失败(2026-10-03) ────────
// 审查结论(P2):刷新时 listProjects 瞬态 503 → FAILED(stage:list) → error 态,但
// 旧 projects 列表仍在场 → 30s 轮询照常触发 → getBoard 成功 → BOARD_OK 无条件翻
// ready 清错 —— 列表级失败被「部分成功化」,项目列表停在旧数据,用户以为一切正常。
// 新语义:链级(status/list/bootstrap)失败在场时,看板成功只上账看板数据,不翻
// ready、不清错;错误保持可见,直到整链重新成功或用户手动刷新。board 级失败(看板
// 请求自己的失败)被轮询成功恢复是合法路径,保留。

test("R3 掩盖:刷新后 list 503,轮询的看板成功不得清错/翻 ready(错误保持可见)", async () => {
  const world = twoProjectWorld();
  let listMode = "ok";
  const listCalls = [];
  const boardCalls = [];
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async (request) => {
        listCalls.push(request);
        if (listMode === "fail") return gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } });
        return gatewayOk(world.projects);
      },
      getBoard: async (request) => {
        boardCalls.push(request);
        return gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]);
      },
    },
  });
  assert.ok(panel.text().includes("AlphaColumn"), "首载成功(旧列表在场)");
  assert.equal(boardCalls.length, 1);

  listMode = "fail"; // 刷新的列表拉取 503(http_error 非瞬态 → 无自愈轮干扰,确定性推进)
  await panel.fireClick(panel.reloadButton());
  await panel.settle();
  const errorText = panel.text();
  assert.ok(errorText.includes("读取失败") && errorText.includes("[http_error]"), `刷新的列表 503 → 错误态:${errorText.slice(0, 80)}`);
  assert.ok(!errorText.includes("AlphaColumn"), "错误优先级最高,看板区退位");

  await panel.advance(30_000); // 轮询 tick:getBoard 成功(旧实现:BOARD_OK 无条件翻 ready 清错)
  const afterTick = panel.text();
  assert.equal(boardCalls.length, 2, "轮询确实发生且 getBoard 成功");
  assert.ok(afterTick.includes("读取失败") && afterTick.includes("[http_error]"), `看板成功不得清除列表错误:${afterTick.slice(0, 80)}`);
  assert.ok(!afterTick.includes("AlphaColumn"), "未翻 ready:错误态下看板区不上屏");

  await panel.advance(30_000); // 第二个 tick:错误依旧(不是一次性的时序运气)
  assert.ok(panel.text().includes("读取失败"), "错误持续可见");
  assert.equal(boardCalls.length, 3, "轮询照常节流(每 tick 恰一次,不叠发)");

  listMode = "ok"; // 用户手动刷新:整链成功 = 认可的恢复路径
  await panel.fireClick(panel.reloadButton());
  await panel.settle();
  const recovered = panel.text();
  assert.ok(recovered.includes("AlphaColumn") && !recovered.includes("读取失败"), "整链成功后恢复正常");
  assert.equal(listCalls.length, 3, `首载 1 + 失败刷新 1 + 恢复刷新 1:${listCalls.length}`);
  assert.equal(listCalls[2].noCache, true, "手动刷新整链带 noCache");
  await panel.unmount();
});

test("R3 掩盖(切换路径):list 级错误期手动切换项目,看板成功同样不得清错", async () => {
  const world = twoProjectWorld();
  let listMode = "ok";
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => (listMode === "fail" ? gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } }) : gatewayOk(world.projects)),
      getBoard: async (request) => gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]),
    },
  });
  assert.ok(panel.text().includes("AlphaColumn"), "首载成功");
  listMode = "fail";
  await panel.fireClick(panel.reloadButton());
  await panel.settle();
  assert.ok(panel.text().includes("读取失败"), "列表 503 → 错误态(旧列表仍在切换器里)");

  await panel.fireChange(panel.projectSelect(), "#9"); // 错误期切换:SELECT + loadBoard(#9) 成功
  await panel.settle();
  const after = panel.text();
  assert.ok(after.includes("读取失败") && after.includes("[http_error]"), `切换触发的看板成功不清列表错误:${after.slice(0, 80)}`);
  assert.ok(!after.includes("BetaColumn"), "不翻 ready(旧实现:BOARD_OK 把面板翻回 ready)");
  await panel.unmount();
});

test("R3 根因优先:list 级错误期的看板失败不得顶替根因错误(stage 保持 list)", async () => {
  const world = twoProjectWorld();
  let listMode = "ok";
  let boardMode = "ok";
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => (listMode === "fail" ? gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 503。" } }) : gatewayOk(world.projects)),
      getBoard: async (request) => {
        if (boardMode === "fail") return gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } });
        return gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]);
      },
    },
  });
  assert.ok(panel.text().includes("AlphaColumn"), "首载成功");
  listMode = "fail";
  await panel.fireClick(panel.reloadButton());
  await panel.settle();
  assert.ok(panel.text().includes("503"), "列表 503 错误在场");

  boardMode = "fail";
  await panel.advance(30_000); // 轮询 tick:这次 getBoard 失败(401)
  const after = panel.text();
  assert.ok(after.includes("503"), `根因(列表 503)保持可见:${after.slice(0, 90)}`);
  assert.ok(!after.includes("401"), "从属的看板 401 不顶替根因错误(顶替后下一轮看板成功就能清错,掩盖路径的变体)");
  await panel.unmount();
});

test("R3 保留路径:board 级错误期的轮询成功仍恢复看板(不因门控误伤)", async () => {
  const world = twoProjectWorld();
  let boardMode = "fail";
  const panel = await mountPanel({
    face: {
      status: async () => gatewayOk(statusResult()),
      listProjects: async () => gatewayOk(world.projects),
      getBoard: async (request) => {
        if (boardMode === "fail") return gatewayOk({ ok: false, error: { code: "http_error", message: "GitHub API HTTP 401。" } });
        return gatewayOk(world.boards[request.projectNumber] ?? world.boards[7]);
      },
    },
  });
  const errorText = panel.text();
  assert.ok(errorText.includes("读取失败") && errorText.includes("401"), "看板自身失败 → 错误态(stage=board)");

  boardMode = "ok";
  await panel.advance(30_000); // 轮询 tick:看板成功 → 恢复(审查确认的合法路径,必须保留)
  const recovered = panel.text();
  assert.ok(recovered.includes("AlphaColumn") && !recovered.includes("读取失败"), "board 级错误被轮询成功恢复");
  await panel.unmount();
});
