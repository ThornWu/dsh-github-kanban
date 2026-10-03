/**
 * S3.3 缓存测试:TTL、淘汰(LRU 8/maxBoards)、去重、失败不缓存、
 * token 指纹失效、强制刷新竞态(发起序号单调写)。
 *
 * 对象:GithubKanbanService 的进程内缓存(§5)。时间用 cache.now 注入(确定性),
 * 网络用 fetch 替身计数。缓存内部字段(cache.boards/inflight 等)是公开的自检
 * 面(smoke 4m–4p 同款口径),这里按同一口径断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as host from "../lib/index.js";
import { viewerProjectsPage, projectNode, viewerBoardPage, repoBoardPage, boardItemNode } from "./helpers/fixtures.mjs";

const ENV = { GITHUB_TOKEN: "cache-test-token" };

/** 可编程时钟 + 请求计数的缓存测试台。count() 是实时值(勿在建立时解构数字)。 */
const makeCacheHarness = ({ behavior, cache = {}, env = ENV } = {}) => {
  let nowMs = 1_000_000;
  let fetchCount = 0;
  const service = new host.GithubKanbanService({
    env,
    cache: { now: () => nowMs, ...cache },
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      return { ok: true, status: 200, json: async () => behavior(JSON.parse(init.body), fetchCount) };
    },
  });
  return {
    service,
    count: () => fetchCount,
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

const boardPageWith = (columnTitle, number = 7) => viewerBoardPage({ number, items: [boardItemNode({ id: `i-${columnTitle}`, title: `${columnTitle} 的卡`, optionId: "o1" })], totalCount: 1 });

const emptyViewerProjects = () => viewerProjectsPage([]);

// ── TTL ─────────────────────────────────────────────────────────────────────

test("S3.3 TTL:项目列表 60s 内命中缓存不打网络,过期后重拉", async () => {
  const { service, count: fetchCount, advance } = makeCacheHarness({ behavior: (body) => (String(body.query).includes("projectV2(number:") ? boardPageWith("B") : emptyViewerProjects()) });
  await service.listProjects();
  await service.listProjects();
  assert.equal(fetchCount(), 1, "TTL 内二连发只打一次");
  advance(60_001);
  await service.listProjects();
  assert.equal(fetchCount(), 2, "越过 projectsTtlMs 重拉");
});

test("S3.3 TTL:看板 15s 窗口;noCache 绕过 TTL 且成功后回填新值", async () => {
  let column = "Old";
  const { service, count: fetchCount, advance } = makeCacheHarness({ behavior: (body, call) => {
    if (!String(body.query).includes("projectV2(number:")) return emptyViewerProjects();
    const current = column;
    return boardPageWith(current);
  } });
  await service.getBoard({ projectNumber: 7 });
  await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 1, "TTL 内同键命中");
  advance(10_000);
  await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 1, "15s 窗口内仍命中");
  column = "New";
  const forced = await service.getBoard({ projectNumber: 7, noCache: true });
  assert.equal(fetchCount(), 2, "noCache 强制真拉");
  assert.equal(forced.board.columns[0].items[0].title, "New 的卡");
  advance(5_000); // 距强刷仅 5s(<15s),但强刷已回填
  const again = await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 2, "强刷回填后 TTL 重新计时");
  assert.equal(again.board.columns[0].items[0].title, "New 的卡");
});

test("S3.3 TTL:listProjects 同样支持 noCache 强拉(刷新 = 整链重拉的依据)", async () => {
  const { service, count: fetchCount } = makeCacheHarness({ behavior: () => emptyViewerProjects() });
  await service.listProjects();
  await service.listProjects({ noCache: true });
  assert.equal(fetchCount(), 2);
});

// ── 容量与淘汰(LRU,写入序) ────────────────────────────────────────────────

test("S3.3 淘汰:默认 maxBoards=8,写入第 9 块时最旧一块出局(容量有界)", async () => {
  const { service } = makeCacheHarness({ behavior: (body) => boardPageWith(`列${body.variables.number}`, body.variables.number) });
  for (let number = 1; number <= 9; number += 1) await service.getBoard({ projectNumber: number });
  assert.equal(service.cache.boards.size, 8, "恰好 8 块");
  assert.equal(service.cache.boards.has("#1"), false, "最旧写入出局");
  assert.equal(service.cache.boards.has("#9"), true);
  assert.deepEqual([...service.cache.boards.keys()], ["#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9"], "淘汰顺序 = 写入序");
});

test("S3.3 淘汰:读不续命(命中 TTL 不改写入序,口径可预期)", async () => {
  const { service, advance } = makeCacheHarness({ behavior: (body) => boardPageWith(`列${body.variables.number}`, body.variables.number), cache: { maxBoards: 2 } });
  await service.getBoard({ projectNumber: 1 });
  await service.getBoard({ projectNumber: 2 });
  advance(1_000);
  await service.getBoard({ projectNumber: 1 }); // TTL 内命中:不重写、不续命
  await service.getBoard({ projectNumber: 3 }); // 超容量:出局的仍是 #1(不是 #2)
  assert.equal(service.cache.boards.has("#1"), false, "读命中不改变淘汰序");
  assert.deepEqual([...service.cache.boards.keys()], ["#2", "#3"]);
});

test("S3.3 淘汰:cache.maxBoards 可配置(自定义容量同样有界)", async () => {
  const { service } = makeCacheHarness({ behavior: (body) => boardPageWith("x", body.variables.number), cache: { maxBoards: 2 } });
  await service.getBoard({ projectNumber: 1 });
  await service.getBoard({ projectNumber: 2 });
  await service.getBoard({ projectNumber: 3 });
  assert.equal(service.cache.boards.size, 2);
});

test("S3.3 缓存键:repo 与 number 复合,跨 owner 同编号互不覆盖", async () => {
  const { service } = makeCacheHarness({ behavior: (body) => {
    if (body.variables.owner === undefined) return boardPageWith("viewer", body.variables.number);
    return repoBoardPage({ owner: body.variables.owner, name: body.variables.name, number: body.variables.number, items: [boardItemNode({ id: "r", title: `${body.variables.owner} 的卡`, optionId: "o1" })], totalCount: 1 });
  } });
  await service.getBoard({ projectNumber: 3 });
  await service.getBoard({ projectNumber: 3, repo: "octocat/alpha" });
  await service.getBoard({ projectNumber: 3, repo: "octocat/beta" });
  assert.deepEqual([...service.cache.boards.keys()].sort(), ["#3", "octocat/alpha#3", "octocat/beta#3"]);
});

// ── 并发去重 ────────────────────────────────────────────────────────────────

test("S3.3 去重:同键并发请求共享一次拉取(in-flight 合并)", async () => {
  const { service, count: fetchCount } = makeCacheHarness({ behavior: () => boardPageWith("D") });
  const [first, second] = await Promise.all([service.getBoard({ projectNumber: 7 }), service.getBoard({ projectNumber: 7 })]);
  assert.equal(fetchCount(), 1, "共享一次网络往返");
  assert.equal(first.board.columns[0].items[0].title, second.board.columns[0].items[0].title);
  assert.equal(service.cache.inflight.size, 0, "settle 后条目出队");
});

test("S3.3 去重:强刷与普通请求是不同 in-flight 键(强刷不被普通请求吞并)", async () => {
  const { service, count: fetchCount } = makeCacheHarness({ behavior: () => boardPageWith("P") });
  await Promise.all([service.getBoard({ projectNumber: 7 }), service.getBoard({ projectNumber: 7, noCache: true })]);
  assert.equal(fetchCount(), 2, "强刷独立发起新拉取");
});

// ── 失败不缓存 ──────────────────────────────────────────────────────────────

test("S3.3 失败不缓存:getBoard 失败后,下一次调用重新发起请求(而非命中失败)", async () => {
  let mode = "fail";
  const { service, count: fetchCount } = makeCacheHarness({ behavior: () => (mode === "fail" ? { errors: [{ message: "boom" }] } : boardPageWith("R")) });
  const failed = await service.getBoard({ projectNumber: 7 });
  assert.equal(failed.ok, false);
  mode = "ok";
  const recovered = await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 2, "失败结果没有进缓存,恢复请求真拉");
  assert.equal(recovered.ok, true);
});

test("S3.3 失败不缓存:listProjects 全来源失败同样不留缓存条目", async () => {
  let mode = "fail";
  const { service, count: fetchCount } = makeCacheHarness({ behavior: () => (mode === "fail" ? { errors: [{ message: "boom" }] } : emptyViewerProjects()) });
  const failed = await service.listProjects();
  assert.equal(failed.ok, false);
  assert.equal(service.cache.projects, undefined, "失败不写缓存");
  mode = "ok";
  await service.listProjects();
  assert.equal(fetchCount(), 2);
});

// ── token 指纹失效(身份隔离) ──────────────────────────────────────────────

test("S3.3 身份失效:token 轮换后列表与看板缓存都不命中(TTL 内也强制重拉)", async () => {
  const env = { GITHUB_TOKEN: "identity-A" };
  let identity = "A";
  const { service, count: fetchCount } = makeCacheHarness({
    env,
    cache: {},
    behavior: (body) => (String(body.query).includes("projectV2(number:") ? boardPageWith(`身份${identity}`) : emptyViewerProjects()),
  });
  // makeCacheHarness 闭包 env 需要可变:直接替换实现
  await service.listProjects();
  await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 2);
  env.GITHUB_TOKEN = "identity-B";
  identity = "B";
  await service.listProjects();
  await service.getBoard({ projectNumber: 7 });
  assert.equal(fetchCount(), 4, "换身份后 0 命中,全部真拉");
});

test("S3.3 身份失效:指纹只留在进程内(缓存条目带 fp,返回值不含 token 也不含指纹)", async () => {
  const { service } = makeCacheHarness({ behavior: (body) => (String(body.query).includes("projectV2(number:") ? boardPageWith("F") : emptyViewerProjects()) });
  await service.getBoard({ projectNumber: 7 });
  const entry = service.cache.boards.get("#7");
  assert.ok(/^[0-9a-f]{16}$/.test(entry.fp), "条目带 16 位十六进制指纹(进程内记账)");
  const result = await service.getBoard({ projectNumber: 7 });
  assert.ok(!JSON.stringify(result).includes(ENV.GITHUB_TOKEN), "返回值不含 token");
  assert.ok(!JSON.stringify(result).includes(entry.fp), "返回值不含指纹值");
  const statusResult = await service.status();
  assert.ok(!JSON.stringify(statusResult).includes(entry.fp), "status 路径同样不带指纹");
});

// ── 强制刷新竞态(发起序号单调写) ────────────────────────────────────────────

test("S3.3 强刷竞态:先发起的慢请求不覆盖后发起强刷写入的新数据", async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let call = 0;
  const service = new host.GithubKanbanService({
    env: ENV,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        await sleep(60); // 先发起的普通请求:慢,旧数据
        return { ok: true, status: 200, json: async () => boardPageWith("OldCol") };
      }
      await sleep(5); // 后发起的强刷:快,新数据
      return { ok: true, status: 200, json: async () => boardPageWith("NewCol") };
    },
  });
  const slow = service.getBoard({ projectNumber: 7 });
  await sleep(15);
  const fast = service.getBoard({ projectNumber: 7, noCache: true });
  await fast;
  await slow; // 旧请求最后返回:不得回退强刷结果
  const cached = await service.getBoard({ projectNumber: 7 }); // TTL 内读缓存
  assert.equal(cached.board.columns[0].items[0].title, "NewCol 的卡", "缓存里是强刷的新数据");
});

test("S3.3 强刷竞态:列表同样按发起序单调写(旧慢响应不回退新列表)", async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let call = 0;
  const service = new host.GithubKanbanService({
    env: ENV,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        await sleep(60);
        return { ok: true, status: 200, json: async () => viewerProjectsPage([projectNode({ id: "old", number: 1, title: "旧列表" })]) };
      }
      await sleep(5);
      return { ok: true, status: 200, json: async () => viewerProjectsPage([projectNode({ id: "new", number: 2, title: "新列表" })]) };
    },
  });
  const slow = service.listProjects();
  await sleep(15);
  const fast = service.listProjects({ noCache: true });
  await fast;
  await slow;
  const cached = await service.listProjects();
  assert.deepEqual(cached.projects.map((project) => project.title), ["新列表"]);
});

// ── 第二轮整改(R2host):在途身份隔离 / 加入者单调性 / 命中信封保真 ──────────

/** 手动放行闸:挂起 fetch 直到 resolve 被调用(消除时序竞态,不用 sleep 赌调度)。 */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("R2host-P1 在途隔离:listProjects 在途请求不跨身份复用,旧数据不盖新身份标签", async () => {
  const env = { GITHUB_TOKEN: "r2-inflight-A" };
  const gateFirst = deferred();
  let fetchCount = 0;
  const service = new host.GithubKanbanService({
    env,
    cache: { now: () => 1_000_000 }, // 冻结时钟:TTL 永不过期,只考察身份与在途
    fetchImpl: async () => {
      fetchCount += 1;
      const identity = fetchCount === 1 ? "A" : "B"; // 进门即捕获:悬挂期间共享计数器会被后续请求推进
      if (fetchCount === 1) await gateFirst.promise; // 首个请求悬挂:模拟在途期间轮换身份
      return { ok: true, status: 200, json: async () => viewerProjectsPage([projectNode({ id: `p-${identity}`, number: 1, title: `身份${identity}的项目` })]) };
    },
  });
  const first = service.listProjects(); // 身份 A 发起,悬挂在途
  await sleep(10); // 确保在途条目已建立、fetch 已挂起
  env.GITHUB_TOKEN = "r2-inflight-B"; // 在途期间轮换身份(身份切换)
  const second = service.listProjects(); // 新身份调用:不得加入旧身份的在途
  gateFirst.resolve(); // 放行旧请求
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(fetchCount, 2, "新身份另起一次请求,不搭旧身份在途的顺风车");
  assert.deepEqual(firstResult.projects.map((project) => project.title), ["身份A的项目"], "发起者拿自己身份的数据");
  assert.deepEqual(secondResult.projects.map((project) => project.title), ["身份B的项目"], "新身份拿新身份数据(修复前:加入旧在途,拿到 A 的数据)");
  const third = await service.listProjects(); // TTL 内、当前身份 B:应命中 B 的条目
  assert.deepEqual(third.projects.map((project) => project.title), ["身份B的项目"], "缓存条目按发起时身份盖章(修复前:A 的数据被打成 B 的指纹,命中吐旧身份数据)");
});

test("R2host-P1 在途隔离:getBoard 同样不跨身份复用在途请求", async () => {
  const env = { GITHUB_TOKEN: "r2-board-A" };
  const gateFirst = deferred();
  let fetchCount = 0;
  const pageOf = (identity) => viewerBoardPage({ number: 7, items: [boardItemNode({ id: `i-${identity}`, title: `身份${identity}的卡`, optionId: "o1" })], totalCount: 1 });
  const service = new host.GithubKanbanService({
    env,
    cache: { now: () => 1_000_000 },
    fetchImpl: async () => {
      fetchCount += 1;
      const identity = fetchCount === 1 ? "A" : "B"; // 进门即捕获:悬挂期间共享计数器会被后续请求推进
      if (fetchCount === 1) await gateFirst.promise;
      return { ok: true, status: 200, json: async () => pageOf(identity) };
    },
  });
  const first = service.getBoard({ projectNumber: 7 });
  await sleep(10);
  env.GITHUB_TOKEN = "r2-board-B";
  const second = service.getBoard({ projectNumber: 7 });
  gateFirst.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(fetchCount, 2, "新身份另起请求");
  assert.equal(firstResult.board.columns[0].items[0].title, "身份A的卡");
  assert.equal(secondResult.board.columns[0].items[0].title, "身份B的卡", "修复前:新身份拿到旧身份数据");
  const third = await service.getBoard({ projectNumber: 7 });
  assert.equal(third.board.columns[0].items[0].title, "身份B的卡", "命中吐当前身份数据(修复前:旧数据被盖成新指纹)");
});

test("R2host-P2 加入者单调性:加入在途的去重调用不得用旧结果回退缓存", async () => {
  // 修复前的失败序列(加入者持有较晚序号参与回填守卫):
  //   t0 调用 A(普通)发起 board:#7,悬挂(gateA 未放行),startSeq=1;
  //   t1 强刷 F(noCache)发起 board:#7:force,独立在途,gateF 挂起,startSeq=2;
  //   t2 调用 B(普通)到达:缓存仍空(F 尚未回填)→ dedupe 命中 A 的在途条目,B 加入,
  //      但 B 已分到自己的 startSeq=3(比 A、F 都晚);
  //   t3 放行 F → F 回填 {seq:2, NewCol}(此时缓存里是新数据);
  //   t4 放行 A → 旧结果回包:A 自身被单调守卫挡下(existing.seq=2 > 1);
  //      而 B 的守卫是 existing.seq(2) <= B.startSeq(3) → 成立,
  //      B 把 A 的旧结果(OldCol)盖进缓存 —— 后发起强刷写入的新数据被回退;
  //   t5 TTL 内读缓存 → 拿到 OldCol(修复前本用例在此失败)。
  const gateA = deferred();
  const gateF = deferred();
  let call = 0;
  const pageOf = (column) => viewerBoardPage({ number: 7, items: [boardItemNode({ id: `i-${column}`, title: `${column} 的卡`, optionId: "o1" })], totalCount: 1 });
  const service = new host.GithubKanbanService({
    env: ENV,
    cache: { now: () => 1_000_000 },
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        await gateA.promise; // t0 发起的普通请求:最慢,旧数据
        return { ok: true, status: 200, json: async () => pageOf("OldCol") };
      }
      await gateF.promise; // 强刷:先放行,新数据
      return { ok: true, status: 200, json: async () => pageOf("NewCol") };
    },
  });
  const a = service.getBoard({ projectNumber: 7 }); // t0
  await sleep(10);
  const f = service.getBoard({ projectNumber: 7, noCache: true }); // t1
  await sleep(10);
  const b = service.getBoard({ projectNumber: 7 }); // t2:加入 A 的在途(同键同身份,去重本身是特性)
  await sleep(10);
  gateF.resolve(); // t3
  await f;
  gateA.resolve(); // t4
  await Promise.all([a, b]);
  const cached = await service.getBoard({ projectNumber: 7 }); // t5:TTL 命中
  assert.equal(cached.board.columns[0].items[0].title, "NewCol 的卡", "加入者不得用旧结果回退强刷写入的新数据");
  assert.equal(call, 2, "B 加入在途不另发请求(去重语义保留)");
});

test("R2host-P2 命中保真:listProjects 的 warnings(repo_missing 来源警告)在 TTL 命中时保留", async () => {
  const service = new host.GithubKanbanService({
    env: ENV,
    cache: { now: () => 1_000_000 },
    repos: ["octocat/gone"],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.variables?.name === "gone") return { ok: true, status: 200, json: async () => ({ data: { repository: null } }) }; // repo_missing 警告来源
      return { ok: true, status: 200, json: async () => viewerProjectsPage([projectNode({ id: "pv-1", number: 1, title: "viewer 项目" })]) };
    },
  });
  const first = await service.listProjects();
  assert.equal(first.ok, true);
  assert.deepEqual(first.warnings.map((warning) => `${warning.source}[${warning.code}]`), ["octocat/gone[repo_missing]"], "首次调用带来源警告");
  const second = await service.listProjects(); // TTL 内命中
  assert.deepEqual(
    (second.warnings ?? []).map((warning) => `${warning.source}[${warning.code}]`),
    ["octocat/gone[repo_missing]"],
    "缓存整个成功信封:命中时 warnings 原样返回(修复前:第二次调用警告消失)",
  );
  assert.deepEqual(second.projects.map((project) => project.title), ["viewer 项目"], "命中同时保留 projects");
  const refreshed = await service.listProjects({ noCache: true }); // 强拉路径同样整信封
  assert.deepEqual(refreshed.warnings.map((warning) => warning.code), ["repo_missing"], "强拉回填的也是整信封");
});

test("R2host-P2 命中保真:getBoard 命中保留完整性口径字段(核对性用例,boards 本就存整信封)", async () => {
  const service = new host.GithubKanbanService({
    env: ENV,
    cache: { now: () => 1_000_000 },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () =>
        viewerBoardPage({
          number: 7,
          items: [boardItemNode({ id: "i1", title: "卡", optionId: "o1", contentMissing: true, truncated: { fieldValues: true } })],
          totalCount: 5,
        }),
    }),
  });
  const first = await service.getBoard({ projectNumber: 7 });
  assert.equal(first.totalCount, 5, "服务端全量口径");
  assert.equal(first.fetchedCount, 1, "实际拉取口径");
  assert.equal(first.board.contentMissing, 1, "卡片内容不可读计数");
  assert.equal(first.board.fieldValuesTruncated, 1, "字段值截断计数");
  const second = await service.getBoard({ projectNumber: 7 }); // TTL 命中
  assert.equal(second.totalCount, 5, "命中保留 totalCount");
  assert.equal(second.fetchedCount, 1, "命中保留 fetchedCount");
  assert.equal(second.board.contentMissing, 1, "命中保留 board.contentMissing");
  assert.equal(second.board.fieldValuesTruncated, 1, "命中保留 board.fieldValuesTruncated");
});
