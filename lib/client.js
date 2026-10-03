/**
 * dsh-github-kanban · 浏览器半边 —— Phase 1.4「左侧全局面板」。
 *
 * 装载契约(dsh 0.2.0-rc.1/rc.2,依据 @deepseek-ai/dsh-client-modules 源码):
 *   1. 本文件被 dsh 按原样当 <script> 提供:不打包、不转译;执行时只注册工厂(零副作用),
 *      样式注入等动作都发生在 factory 物化时。
 *   2. require 只能命中平台 seed 词或已装载插件的包名 —— 相对路径不可用,
 *      所以适配层必须和组件同处一个文件(差异 5)。
 *   3. 注册的 id 必须等于 package.json 的 name,否则加载器报 "loaded without registering"。
 *
 * 数据面(差异 3 的落地):apply 时用 ctx.remote.$mount(手写清单)把宿主 githubKanban
 * 服务装进浏览器 remote 面,组件经 boardApi 调 status / listProjects / getBoard。
 * token 永不出现在这里:面板只看「未配置」布尔与结构化错误文案。
 *
 * 职责分层(S2.2,2026-10-03 整改;受单文件交付约束,分层只在文件内部):
 *   §1 dsh 客户端适配层(座位/文案/remote 挂载:唯一接触 dsh 装载契约的段落);
 *   §2 文案(zh/en 词典,逐键对照);
 *   §3 数据控制层 —— 状态机 + 控制器 + 响应契约校验(框架无关、依赖可注入,
 *      自检可以不经 React 直接驱动,见 mod.internals);
 *   §4 视图组件(只做展示与触发:从快照渲染,把交互转交控制器);
 *   §5 注册(apply/inject)。
 */
window.__ModuleLoader__.load({
  id: "@local/thorn-github-kanban",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;

    /** 身份常量:与 package.json(name / dsh.client)保持一致。 */
    const PACKAGE_ID = "@local/thorn-github-kanban";
    /** 文案命名空间(ctx.locale 注册 / 座位注册的 locale)。 */
    const NS = "thorn-github-kanban";
    /** 全局面板 id:sidebar.panellist 的入口 id 与 main 座位的 key 用同一值(与 schedule 的 PANEL_ID 同型)。 */
    const PANEL_ID = "github-kanban";
    /** panellist 排序:排在 Automation tasks(order 10)之后。 */
    const PANEL_ORDER = 20;
    /** 宿主远程服务键(与 lib/index.js 的 SERVICE_KEY 一致)。 */
    const SERVICE_KEY = "githubKanban";
    /** 轮询间隔(30s 重拉看板;决策记录见 notes/dev-notes.md 差异 10;数据变化走既有 setState 更新链)。 */
    const POLL_INTERVAL_MS = 30000;

    // ─────────────────────────── §1. dsh 客户端适配层 ───────────────────────────
    // 执行守则 3:dsh 是 rc,装载/座位/远程 API 可能 breaking。全插件只有这一节接触
    // dsh 契约(座位注册、tab 类型、文案、样式归属、remote 挂载);组件只吃 props。

    /** 座位:左栏「Global panels」入口 + 主区页面(跨项目全局,与 schedule 同型)。 */
    const SEAT = {
      panellist: "sidebar.panellist",
      main: "main",
    };

    /**
     * 注入样式标签:带 plugin / plugin-css 归属,框架按插件认领并在卸载、HMR 时清理。
     */
    function injectPluginStyles(tagId, css) {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** strict 编解码占位:浏览器侧只校验 mode,create() 不会被调用(dsh-api-gateway 客户端源码)。
     *  仍给一个透传 parse,让自检可以证明它无害。 */
    function strictStub(typeSymbol) {
      return { mode: "strict", typeSymbol, create: () => ({ parse: (value) => value }) };
    }

    /**
     * 面板可见性探针(保守口径;宿主没有插件可用的 onShow/onHide 折叠事件):
     *   - main 座位由宿主按 activePanelId keyed 渲染(dsh-client-ui-layout):
     *     未选中即整体卸载,轮询随控制器 dispose 停止,不依赖本探针;
     *   - 挂载期间浏览器页面后台(document.visibilityState === "hidden")→ 不可见;
     *   - 面板根节点被 [hidden] / [aria-hidden="true"] 祖先遮蔽 → 不可见;
     *     无 DOM 环境(自检替身)视为可见。
     */
    function defaultIsVisible(element) {
      if (typeof document === "undefined") return true;
      if (document.visibilityState === "hidden") return false;
      if (element === undefined || element === null || element.isConnected !== true) return false;
      return typeof element.closest === "function" && element.closest('[aria-hidden="true"], [hidden]') === null;
    }

    /**
     * 手写 remote 清单:宿主 SRC 回退面的浏览器对端(三个 direct 方法)。
     * wire 契约的集中说明(与宿主 lib/index.js §5 的核验记录互为对照,S2.6):
     *   - 描述符形状对照 dsh-typert-registry 客户端 validateInvocation:id 非空;
     *     service/namespace/method 只允许 [A-Za-z0-9_$.-] 且不为 "."/"..";参数是
     *     {name, wire, source:"json", codec};codec/result 必须 strict 且带
     *     typeSymbol + create()。本清单的 create() 从不被网关客户端调用
     *     (dsh-api-gateway/lib/client.js 全文无 codec.create 调用点),result.decode
     *     缺省时业务结果原样进信封 value —— 所以透传占位是安全的。
     *   - listProjects 与 getBoard 一样带可选 request({noCache}):刷新要能强拉项目列表(S1.6)。
     */
    function remoteContribution() {
      const method = (name, parameters) => ({
        id: `${PACKAGE_ID}#githubKanban/${name}`,
        service: SERVICE_KEY,
        namespace: SERVICE_KEY,
        method: name,
        invocation: { kind: "direct" },
        parameters,
        result: strictStub(`${PACKAGE_ID}/client#${name}Result`),
      });
      const requestParam = [{ name: "request", wire: "request", source: "json", codec: strictStub(`${PACKAGE_ID}/client#request`) }];
      return {
        package: PACKAGE_ID,
        descriptors: [
          method("status", []),
          method("listProjects", requestParam),
          method("getBoard", requestParam),
        ],
      };
    }

    /**
     * 校验装载契约并返回适配面。座位/文案契约缺失就当场大声报错;
     * remote 面缺失不报错(降级为面板内可读的错误态),避免把 tab 打崩。
     * @param ctx 浏览器侧 Client Context
     */
    function createClientAdapter(ctx) {
      const missing = [];
      if (typeof ctx?.slots?.inject !== "function" || typeof ctx?.slots?.register !== "function") missing.push("slots.inject/register");
      if (typeof ctx?.locale?.register !== "function" || typeof ctx?.locale?.bind !== "function") missing.push("locale.register/bind");
      if (typeof ctx?.effect !== "function") missing.push("effect");
      if (missing.length > 0) {
        throw new Error(
          `[${PACKAGE_ID}] 客户端装载契约不匹配,缺少:${missing.join("、")}。` +
            `本插件按 dsh 0.2.0-rc.1 的 ${SEAT.panellist} / ${SEAT.main} / locale 契约编写;` +
            "dsh 升级后请对照官方包源码更新 lib/client.js 的适配层。",
        );
      }
      const hasRemote = ctx.remote !== undefined && typeof ctx.remote.$mount === "function";
      return {
        identity: {
          packageId: PACKAGE_ID,
          ns: NS,
          panelId: PANEL_ID,
          seats: [SEAT.panellist, SEAT.main],
          remote: hasRemote,
        },
        registerDictionary(dicts) {
          return ctx.effect(() => ctx.locale.register(NS, dicts), `${PACKAGE_ID}: dictionaries`);
        },
        registerSeat(seat, Component, extra, inject) {
          const options = { name: seat, locale: NS, registrant: PACKAGE_ID, ...extra };
          if (inject !== undefined) options.inject = inject;
          return ctx.slots.inject(seat, () => ctx.slots.register(options, Component));
        },
        /**
         * 挂载手写 remote 清单;返回结构化结果而非抛错(远程面缺失是可降级的运行态)。
         */
        async mountRemote() {
          if (!hasRemote) return { ok: false, error: { code: "remote_missing", message: "客户端没有 remote 服务(ctx.remote 不可用)。" } };
          try {
            const dispose = await ctx.remote.$mount(remoteContribution());
            return { ok: true, dispose };
          } catch (cause) {
            return { ok: false, error: { code: "remote_mount_failed", message: cause instanceof Error ? cause.message : String(cause) } };
          }
        },
      };
    }

    /** 面板样式:只用 dsh 设计令牌(带兜底值),不引第三方样式系统。 */
    const PANEL_CSS = `
.tgk-root{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px 16px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.7}
.tgk-head{display:flex;align-items:center;gap:8px;min-width:0}
.tgk-title{margin:0;font-size:13px;font-weight:500}
.tgk-badge{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,inherit);font-size:11px}
.tgk-lede{margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.tgk-total{margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;font-variant-numeric:tabular-nums}
.tgk-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tgk-select{flex:0 1 auto;min-width:0;max-width:100%;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit}
.tgk-reload{flex:none;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}
.tgk-reload:disabled{opacity:.5;cursor:default}
.tgk-state{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-fill-l1,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.tgk-stateError{background:var(--dsw-alias-state-error-fill,rgba(211,51,51,.08));color:var(--dsw-alias-label-primary,inherit)}
.tgk-guide{display:flex;flex-direction:column;gap:8px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:var(--dsw-radius-md,8px)}
.tgk-guideTitle{margin:0;font-size:12px;font-weight:500}
.tgk-guideText{margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.tgk-guideCode{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;overflow-wrap:anywhere}
.tgk-board{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}
.tgk-column{flex:1 0 150px;min-width:150px;display:flex;flex-direction:column;gap:6px}
.tgk-columnHead{display:flex;align-items:baseline;gap:6px;margin:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,inherit)}
.tgk-columnCount{font-weight:400;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.tgk-cards{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.tgk-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.tgk-cardTitle{margin:0;font-size:12px;font-weight:500;overflow-wrap:anywhere}
.tgk-cardTitleLink{color:inherit;text-decoration:none}
.tgk-meta{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0;list-style:none}
.tgk-assignee{padding:0 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));font-size:11px}
.tgk-label{padding:0 6px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));font-size:11px}
.tgk-emptyColumn{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}
/* 本面板不含 transition/animation:prefers-reduced-motion 下天然等价 */
`;

    injectPluginStyles(`${PACKAGE_ID}/panel.css`, PANEL_CSS);

    // ─────────────────────────── §2. 文案 ───────────────────────────

    /** 简体中文(键源)。 */
    const zh = {
      tabTitle: "GitHub 看板",
      panelTitle: "GitHub Projects 看板",
      phaseBadge: "只读",
      panelLede: "数据来自 GitHub Projects v2,列序 = Status 选项序;改动暂不写回(只读 Alpha,双向写回见路线图)。",
      toolbarProject: "项目",
      toolbarReload: "刷新",
      toolbarRefreshing: "刷新中…",
      switcherProjectGone: "项目已不可用(可能已被删除或失去访问权限)",
      stateLoading: "正在读取 GitHub…",
      stateNoProjects: "viewer 名下没有可显示的 Projects v2 项目。",
      stateEmptyBoard: "该项目还没有看板条目。",
      guideTitle: "尚未配置 GitHub 访问令牌",
      guideStep1: "在启动 dsh 的环境里设置环境变量 GITHUB_TOKEN(需要 repo + project 读权限的 fine-grained PAT);",
      guideStep2: "完全退出并重启 dsh web(环境变量在启动时读取);",
      guideStep3: "重新打开本面板即可看到看板。令牌只留在宿主进程里,不会进入浏览器或日志。",
      errorPrefix: "读取失败",
      connRetryHint: "dsh 连接还没就绪(服务可能正在启动或重启),面板会自动重试;若长时间未恢复,点「刷新」或稍后重开面板。",
      statusHintNotFound: "未找到名为「Status」的单选字段,看板暂以单列「全部」展示(项目可能还没有该字段)。",
      statusHintRenamed: "未找到名为「Status」的单选字段,但项目里有其他单选字段(可能已被改名),看板暂以单列「全部」展示。改名或缺失都不会自动猜测替代字段。",
      statusHintTruncated: "字段数达到单页上限(40),「Status」字段可能未被加载,看板暂以单列「全部」展示。",
      contentMissingHint: "有 {count} 张卡读不到标题/链接。可能原因:token 缺 Issues / Pull requests 读权限(最常见),或卡片关联的 Issue / PR 已被删除、不可见。若是权限问题:去 GitHub 编辑这个 fine-grained PAT,给相关仓库勾上 Issues 与 Pull requests 的 Read-only 即可;token 值不变,权限保存后下轮刷新生效。",
      boardTotalCount: "共 {count} 张卡",
      boardTruncated: "已加载 {fetched} / {total} 张(超出单次拉取上限,看板可能不完整)",
      boardCapped: "已加载 {fetched} 张,超出单次拉取上限且拿不到服务端总数,看板可能不完整",
      fieldValuesTruncated: "有 {count} 张卡的字段值超过单页上限,标签 / 负责人列表可能不完整",
      sourceWarning: "部分项目来源读取失败:{sources};其余来源的项目正常显示。",
      sourceTruncated: "部分来源项目数达到分页上限:{sources};列表可能不完整。",
      columnAll: "全部",
      columnUnfiled: "未分列",
      cardUntitled: "(无标题)",
      columnCount: "{count}",
      columnEmpty: "空",
    };

    /** English,逐键对照。 */
    const en = {
      tabTitle: "GitHub Board",
      panelTitle: "GitHub Projects board",
      phaseBadge: "read-only",
      panelLede: "Data comes from GitHub Projects v2; column order = Status option order. Writes are not supported yet (read-only alpha; see the roadmap).",
      toolbarProject: "Project",
      toolbarReload: "Reload",
      toolbarRefreshing: "Refreshing…",
      switcherProjectGone: "Project is no longer available (deleted or access revoked)",
      stateLoading: "Reading GitHub…",
      stateNoProjects: "No Projects v2 boards are visible to the viewer.",
      stateEmptyBoard: "This project has no board items yet.",
      guideTitle: "GitHub token is not configured yet",
      guideStep1: "Set the GITHUB_TOKEN environment variable where dsh starts (a fine-grained PAT with repo + project read access);",
      guideStep2: "Quit and restart dsh web completely (the variable is read at startup);",
      guideStep3: "Reopen this panel. The token stays in the host process and never reaches the browser or logs.",
      errorPrefix: "Failed to load",
      connRetryHint: "The dsh connection is not ready yet (the service may be starting or restarting); the panel retries automatically. If it does not recover, press Reload or reopen the panel later.",
      statusHintNotFound: "No single-select field named \"Status\" was found; the board falls back to a single \"All\" column (the project may not have this field yet).",
      statusHintRenamed: "No single-select field named \"Status\" was found, but other single-select fields exist (it may have been renamed); the board falls back to a single \"All\" column. Renamed or missing, no substitute field is guessed.",
      statusHintTruncated: "The field list hit the page cap (40); the \"Status\" field may not be loaded. The board falls back to a single \"All\" column.",
      contentMissingHint: "{count} cards show no title/link. Possible causes: the token lacks Issues / Pull requests read access (most common), or the linked Issue / PR was deleted or is not visible. For the permission case: edit this fine-grained PAT on GitHub and grant Issues and Pull requests Read-only for the repos; the token value stays the same and the next refresh picks it up.",
      boardTotalCount: "{count} cards in total",
      boardTruncated: "Loaded {fetched} / {total} cards (over the fetch cap; the board may be incomplete)",
      boardCapped: "Loaded {fetched} cards, over the fetch cap with no server-side total; the board may be incomplete",
      fieldValuesTruncated: "{count} cards have more field values than one page loads; labels / assignees may be incomplete",
      sourceWarning: "Some project sources failed to load: {sources}; projects from the remaining sources are shown.",
      sourceTruncated: "Some sources hit the project pagination cap: {sources}; the list may be incomplete.",
      columnAll: "All",
      columnUnfiled: "Unfiled",
      cardUntitled: "(untitled)",
      columnCount: "{count}",
      columnEmpty: "empty",
    };

    // ─────────────────────────── §3. 数据控制层(状态机 + 控制器 + 契约校验) ───────────────────────────
    // S2.2/S2.3 整改:启动、重试、切换、刷新、轮询集中在本节。状态机与控制器是
    // 框架无关的纯逻辑 —— 依赖(delay/scheduleRetry/polling/可见性探针)全部可注入,
    // 自检可以不经 React 直接驱动(smoke 经 mod.internals 取用);§4 的组件只订阅
    // 快照做展示、把交互转交控制器,不再持有任何数据流决策。

    /** 统一的结构化失败形状(与宿主 boardError 对齐)。 */
    const failed = (code, message) => ({ ok: false, error: { code, message } });

    /**
     * 选中键:仓归属 + 编号复合(同一编号在不同 owner 域会撞,用户级与仓级同 id 只留一份)。
     * 用户级项目(无 repo)键为 "#N",仓库级为 "owner/name#N"。
     */
    function projectKey(project) {
      return `${project.repo ?? ""}#${project.number}`;
    }

    /**
     * 瞬态失败判定:RPC 载波未就绪/服务正在启动或重启的窗口期失败 ——
     * gateway 把载波失败折成 gateway/internal,浏览器侧 fetch 抛 "Failed to fetch",
     * 应用层/宿主侧超时折成 remote_timeout / timeout。这类错误重试即自愈,不该把面板
     * 钉死在错误态(2026-10-01 真机:dsh 每次重启都会出现;阶段 1 起超时也归入此类)。
     */
    function isTransientFailure(result) {
      return (
        result?.ok !== true &&
        (result?.error?.code === "gateway/internal" ||
          result?.error?.code === "remote_timeout" ||
          result?.error?.code === "timeout" ||
          String(result?.error?.message ?? "").includes("Failed to fetch"))
      );
    }

    // ─── 响应契约校验(S2.4)───
    // 宿主三种业务信封进状态机前先过形状核验。畸形响应**不能**无声退化为空数据:
    // 核验失败折成 shape_error 结构化失败,走可观测的错误路径(错误态 + code),
    // 宁可明确失败也不渲染误导性的空看板/空列表。失败信封({ok:false,error})原样透传。

    /** status 契约:{ ok, status: { tokenConfigured: boolean, ... } }。 */
    function coerceStatus(result) {
      if (result?.ok !== true) return result;
      const status = result.status;
      if (status === null || typeof status !== "object" || typeof status.tokenConfigured !== "boolean") {
        return failed("shape_error", `${SERVICE_KEY}.status 返回了意外结构(缺 status.tokenConfigured 布尔)。`);
      }
      return result;
    }

    /** listProjects 契约:{ ok, projects: Array<{id,number,title,updatedAt?,repo?}>, warnings? }。 */
    function coerceProjectsResult(result) {
      if (result?.ok !== true) return result;
      if (!Array.isArray(result.projects)) {
        return failed("shape_error", `${SERVICE_KEY}.listProjects 成功但缺 projects 数组,拒绝当作空列表。`);
      }
      for (const project of result.projects) {
        if (project === null || typeof project !== "object" || !Number.isInteger(project.number) || project.number <= 0) {
          return failed("shape_error", `${SERVICE_KEY}.listProjects 的项目条目畸形(number 缺失或非正整数)。`);
        }
      }
      const warnings = Array.isArray(result.warnings)
        ? result.warnings
            .filter((warning) => warning !== null && typeof warning === "object")
            .map((warning) => ({ source: String(warning.source ?? ""), code: String(warning.code ?? ""), message: String(warning.message ?? "") }))
        : [];
      return { ok: true, projects: result.projects, ...(warnings.length > 0 ? { warnings } : {}) };
    }

    /** getBoard 契约:{ ok, board: { project, hasStatusField, columns: Array<{items:Array}> },
     *  totalCount?, fetchedCount?, incomplete? }。列结构畸形即失败,不过滤、不降级。 */
    function coerceBoardResult(result) {
      if (result?.ok !== true) return result;
      const board = result.board;
      if (board === null || typeof board !== "object" || !Array.isArray(board.columns)) {
        return failed("shape_error", `${SERVICE_KEY}.getBoard 成功但缺 board.columns 数组。`);
      }
      for (const column of board.columns) {
        if (column === null || typeof column !== "object" || !Array.isArray(column.items)) {
          return failed("shape_error", `${SERVICE_KEY}.getBoard 的看板列畸形(缺 items 数组)。`);
        }
      }
      return result;
    }

    // ─── 本地偏好(0.8.0,S1.1/R01 重设计)───
    // 旧版把整份看板(项目列表 + 卡片)写进 localStorage 做乐观首屏,但浏览器侧在身份
    // 确认之前(那需要一次真实网络往返)无从校验快照属于谁:同一 origin 换 token/身份
    // 就会先看到旧身份的卡片;而「等身份确认后再读快照」又会让乐观首屏失去意义。
    // 因此本版只持久化**必要的项目选择偏好**(一个复合键字符串,不含任何业务数据),
    // 完整快照能力移除,旧 snapshot/v1 键在启动时主动清理(隐私优先于首屏提速)。
    // 读写全防御:隐私模式 / 配额 / 沙箱无 localStorage 均静默降级,偏好只是纯优化。

    /** 偏好键(带版本号,形状升级直接作废旧键)。 */
    const PREFS_KEY = `${PACKAGE_ID}/prefs/v1`;
    /** 旧版整板快照键:内容含他人可见的项目/卡片元数据,启动时无条件清除。 */
    const LEGACY_SNAPSHOT_KEY = `${PACKAGE_ID}/snapshot/v1`;
    /** 偏好过期窗口:过久未用的选择回退默认(首项),避免长期陈旧。 */
    const PREFS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

    function readPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (typeof raw !== "string") return null;
        const data = JSON.parse(raw);
        if (data === null || typeof data !== "object" || typeof data.selectedKey !== "string" || data.selectedKey === "") return null;
        // 到期校验:savedAt 缺失/畸形/超出窗口(含明显来自未来的时钟漂移)都视为无效
        if (typeof data.savedAt !== "number" || data.savedAt > Date.now() + 60_000 || Date.now() - data.savedAt > PREFS_MAX_AGE_MS) return null;
        return data;
      } catch {
        return null;
      }
    }

    function writePrefs(selectedKey) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ savedAt: Date.now(), selectedKey }));
      } catch {
        // 写失败静默:偏好是纯优化,不是功能依赖
      }
    }

    /** 清掉旧版整板快照(内容不再被任何路径读取,留着只有隐私负担)。 */
    function purgeLegacySnapshot() {
      try {
        localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
      } catch {
        // 同上:清理失败不影响功能
      }
    }

    // ─── 数据访问层(boardApi:等 mount → 取面 → 有界调用)───

    /**
     * 组件的数据出口:等 $mount 完成后,调 scoped fiber 里捕获的 remote.githubKanban 面。
     * RemoteError 与任何意外都折叠成结构化失败;组件不见异常、不见凭据。
     * inject 依据:cordis ReflectService 的 traceable get trap 对 "remote.githubKanban"
     * 这类嵌套 accessor 要求**调用方 fiber** 的 inject 清单含全名,否则抛
     * "cannot get property ... without inject"。该全名只进 apply 里
     * ctx.inject(["remote.githubKanban"], …) 的 scoped fiber(见下方死锁注记),
     * 面在 fiber 里捕获一次,之后的方法调用是普通 JS 引用,不再过 ctx 代理。
     *
     * 有界等待(S1.2/R02):挂载、取面、每次调用都套 deadline —— RPC 载波卡死时面板
     * 不会永远停在「读取中」,而是拿到可读的结构化超时错误;刷新与轮询可立即重试。
     * 底层无法真正取消时(替换面/悬挂的 gateway),迟到结果在 withDeadline 里被显式吞掉,
     * 不会覆盖已返回的状态,也不会变成 unhandled rejection。
     *
     * 返回信封(S2.6,rc.2 实测 + 源码核验):网关客户端 invoke() 把业务结果包成
     * {ok:true, value:<业务>} / {ok:false, error}(dsh-api-gateway client 的 encodeRpcResult/
     * invoke 链);本包业务结果从不带 value 键,按 value 键存在与否拆包。
     * @param mountPromise 适配层 mountRemote() 的 promise
     * @param facePromise scoped fiber 捕获的 remote.githubKanban 面(拒绝/缺席降级成错误态)
     * @param scheduleDeadline 定时调度器(apply 注入:优先宿主 ctx.timeout,回退全局 setTimeout)
     */

    /** Remote 等待上限:挂载/取面 10s,单次调用 20s(与宿主请求超时同量级)。 */
    const REMOTE_MOUNT_DEADLINE_MS = 10_000;
    const REMOTE_CALL_DEADLINE_MS = 20_000;

    const describeCause = (cause) => (cause instanceof Error ? cause.message : String(cause));

    /**
     * 有界等待:resolve-only(永不 reject)。先挂底层 Promise 的两个分支、再挂定时器,
     * 已就绪的调用不会被立即触发的定时器误伤;到期给 { timedOut: true }。
     * settle 之后迟到的一切(成功或失败)都被丢弃 —— 「旧请求不得覆盖新状态」的客户端侧依据。
     */
    function withDeadline(promise, ms, scheduleDeadline) {
      return new Promise((resolve) => {
        let settled = false;
        let cancel = null;
        const settle = (outcome) => {
          if (settled) return;
          settled = true;
          if (typeof cancel === "function") cancel();
          resolve(outcome);
        };
        promise.then((value) => settle({ value }), (cause) => settle({ cause }));
        cancel = scheduleDeadline(() => settle({ timedOut: true }), ms);
      });
    }

    function createBoardApi(mountPromise, facePromise, scheduleDeadline) {
      const call = async (method, args) => {
        const mounted = await withDeadline(mountPromise, REMOTE_MOUNT_DEADLINE_MS, scheduleDeadline);
        if (mounted.timedOut === true) {
          return failed("remote_timeout", `远程面挂载超过 ${REMOTE_MOUNT_DEADLINE_MS}ms 未完成,已放弃等待;点「刷新」或重开面板可重试。`);
        }
        if (mounted.cause !== undefined) return failed("remote_mount_failed", describeCause(mounted.cause));
        if (mounted.value === undefined || mounted.value.ok !== true) {
          return failed(mounted.value?.error?.code ?? "remote_mount_failed", mounted.value?.error?.message ?? "远程面未挂载。");
        }
        const face = await withDeadline(facePromise, REMOTE_MOUNT_DEADLINE_MS, scheduleDeadline);
        if (face.timedOut === true) {
          return failed("remote_timeout", `远程服务就绪超过 ${REMOTE_MOUNT_DEADLINE_MS}ms 未完成,已放弃等待;点「刷新」或重开面板可重试。`);
        }
        if (face.cause !== undefined) return failed("remote_missing", describeCause(face.cause));
        if (face.value === undefined || typeof face.value[method] !== "function") {
          return failed("remote_missing", `远程面缺少 ${SERVICE_KEY}.${method}。`);
        }
        let invocation;
        try {
          invocation = face.value[method](...(args === undefined ? [] : [args]));
        } catch (cause) {
          return failed("remote_error", describeCause(cause));
        }
        const outcome = await withDeadline(invocation, REMOTE_CALL_DEADLINE_MS, scheduleDeadline);
        if (outcome.timedOut === true) {
          return failed(
            "remote_timeout",
            `${SERVICE_KEY}.${method} 调用超过 ${REMOTE_CALL_DEADLINE_MS}ms 未返回,已放弃等待;迟到的结果会被忽略,点「刷新」或等下一轮轮询即可重试。`,
          );
        }
        if (outcome.cause !== undefined) return failed("remote_error", describeCause(outcome.cause));
        const raw = outcome.value;
        // 网关 direct 调用的返回是信封:成功 {ok:true, value:<业务结果>} / 失败 {ok:false, error}
        // (rc.2 实测:官方插件不消费 direct 返回值,信封没人拆;本包业务结果从不带 value 键,借此拆包)。
        const result = raw !== null && typeof raw === "object" && raw.ok === true && "value" in raw ? raw.value : raw;
        if (result !== undefined && result !== null && typeof result === "object" && "ok" in result) return result;
        return failed("shape_error", `${SERVICE_KEY}.${method} 返回了意外结构。`);
      };
      return {
        status: () => call("status"),
        // 参数数量契约(R2/P1,2026-10-03 对照 dsh 0.2.0-rc.2 源码核验):
        //   - 网关客户端 prepareInvocation(dsh-api-gateway/lib/client.js)把**清单形参数量**
        //     与实参数量做精确相等比对 —— 0 实参调用声明 1 参的方法直接抛
        //     "client api: githubKanban/listProjects expected 1 argument(s), got 0",
        //     折成非瞬态 remote_error,真机首载/自动重试(都不带 request)会全挂;
        //   - 服务端 assertExactArguments 对 src-json 参数允许 wire 键缺席,但客户端的
        //     数量判定在前面就拦下了,轮不到这层宽容;
        //   - 宿主侧 methodParameterNames 只认简单标识符参数(默认参数/rest 会让 SRC
        //     签名无效)—— wire 上不存在「可选参数」的数量宽容。
        // 因此清单声明 1 参的方法恒传恰好 1 个实参:请求缺席补 {}(空对象合法上 wire,
        // 宿主按 request?.noCache 读取,与 undefined 同义);status 恒 0 实参。
        listProjects: (request) => call("listProjects", request ?? {}),
        getBoard: (request) => call("getBoard", request ?? {}),
      };
    }

    // ─── 状态机(S2.3):单一 phase 字段 + 显式转换 ───

    /** 状态机 phase 全集(与 UI 视图一一对应,推导见 viewBoardState)。 */
    const BOARD_PHASES = Object.freeze({ IDLE: "idle", LOADING: "loading", READY: "ready", ERROR: "error" });

    /**
     * 状态机语义(S2.3;整改前的问题:phase/tokenConfigured/transient/refreshing 等布尔与
     * ref 之间的隐含约束分散在多个 setState 点,现在收敛为「单一 phase + 显式转换」):
     *   idle    初始化:组件挂载、启动链尚未发起;
     *   loading 启动/刷新链进行中(工具栏常驻可操作,看板区显示读取中;旧列表保留);
     *   ready   可用,三个子形态由 payload 区分(**部分失败**不是独立 phase):
     *             a) token 未配置(tokenConfigured === false → 配置引导视图);
     *             b) 空项目列表(projects 空 → 空态提示 + 刷新入口);
     *             c) 正常看板 —— 可携带来源级警告(部分来源失败/截断,数据可用但降级,
     *                警告行点名来源,不升级为 error);
     *   error   失败:启动链或看板拉取失败;payload error = { code, text, transient, stage },
     *           transient = 连接未就绪/超时类(错误态 4s 自愈轮的依据,15 轮封顶)。
     * 活动标记 boardInFlight(看板请求在途)不是 phase:轮询刷新期间面板保持 ready,
     * 只用它门控按钮禁用与加载占位。
     */
    function initialBoardState() {
      return {
        phase: BOARD_PHASES.IDLE,
        tokenConfigured: undefined, // undefined = 尚未知晓(不等于 false;工具栏显隐依据)
        projects: [],
        selected: null, // 选中键 projectKey(project);null = 未选
        board: undefined, // undefined = 未拉取, object = 数据
        boardKey: null, // 当前 board 属于哪个项目键(S1.7 一致性门控)
        totalCount: undefined, // 宿主 totalCount(服务端全量口径);缺席时 UI 退回列合计
        incomplete: false, // 宿主明确报告「拉取截断且无总数可自证」(S2.5)
        error: null, // { code, text, transient, stage } | null;仅 error phase 有值
        boardInFlight: false,
        retryCount: 0, // 自动重试轮数(完整启动成功才清零,15 轮封顶,S1.5/R04)
        warnings: [], // 项目列表来源级警告(S1.4;ready 子形态 c 的「部分失败」payload)
      };
    }

    /**
     * 显式状态转换(纯函数,唯一允许改变 phase/业务 payload 的地方;自检直接驱动)。
     * 事件全集(转换语义):
     *   START           启动/刷新链开始:清错误进 loading(数据保留,工具栏可操作)
     *   FAILED          启动链(status/list/bootstrap)或看板(board)失败:进 error,带瞬态
     *                   标记;R3:链级错误在场时,迟到的 board 级失败不顶替根因(stage 优先级)
     *   TOKEN_GUIDE     status 回报 token 未配置:ready + 引导子形态,归零重试预算
     *   TOKEN_KNOWN     status 回报 token 已配置(记录布尔,phase 不变)
     *   LIST_OK         列表成功:空列表 = ready(归零预算);非空保持 loading 等看板
     *   SELECT          选择切换(宽容语义:失配键照设,切换器回退占位提示)
     *   BOARD_START     看板请求发起(boardInFlight;R3:只清 board 级错误 —— 链级错误
     *                   与本次看板请求无关,发起不得清掉,否则在途期错误文案凭空消失)
     *   BOARD_OK        看板成功:board/boardKey/totalCount/incomplete 记账;仅当没有链级
     *                   错误在场时才进 ready 清错(R3:单看板成功证明不了列表新鲜;board 级
     *                   错误的恢复不受此门控影响)
     *   BOOTSTRAP_DONE  完整启动成功(S1.5/R04:唯一归零点之一,由控制器在看板成功后发)
     *   RETRY_TICK      错误态自愈轮 +1(是否继续调度由控制器按 15 轮上限判定)
     *   RETRY_RESET     手动刷新:重置自动重试预算(用户明确要求恢复,重新给满一轮)
     */
    function boardTransition(state, event) {
      switch (event.type) {
        case "START":
          return { ...state, phase: BOARD_PHASES.LOADING, error: null };
        case "FAILED": {
          // R3(第三轮整改)根因优先:链级(status/list/bootstrap)错误在场时,看板请求
          // (轮询/错误期手动切换)的失败只是从属噪声 —— 放它顶替会把 stage 换成 board,
          // 下一轮看板成功就能「合法」清错,列表级失败从另一条路被掩盖。根因错误保持,
          // 直到整链重新成功(START)或用户手动刷新。
          if (state.phase === BOARD_PHASES.ERROR && state.error !== null && state.error.stage !== "board" && event.stage === "board") {
            return { ...state, boardInFlight: false };
          }
          return {
            ...state,
            phase: BOARD_PHASES.ERROR,
            error: {
              code: event.code ?? "unknown",
              text: event.text,
              transient: event.transient === true,
              stage: event.stage,
            },
            boardInFlight: false,
          };
        }
        case "TOKEN_GUIDE":
          return { ...state, phase: BOARD_PHASES.READY, tokenConfigured: false, error: null, retryCount: 0 };
        case "TOKEN_KNOWN":
          return { ...state, tokenConfigured: true };
        case "LIST_OK": {
          const warnings = Array.isArray(event.warnings) ? event.warnings : [];
          if (event.projects.length === 0) {
            // 空列表是合法结果:启动链完整结束(S1.6:「刷新」可再拉新项目)
            return {
              ...state,
              phase: BOARD_PHASES.READY,
              projects: event.projects,
              warnings,
              selected: null,
              board: undefined,
              boardKey: null,
              totalCount: undefined,
              incomplete: false,
              error: null,
              retryCount: 0,
            };
          }
          return { ...state, projects: event.projects, warnings, error: null };
        }
        case "SELECT":
          return { ...state, selected: event.key };
        case "BOARD_START": {
          // R3:错误清理按 stage 门控。看板请求只拥有自己的 board 级错误 —— 新请求在途,
          // 旧的看板失败文案让位(pure.test S3.1 钉住的既有口径);链级(status/list/
          // bootstrap)错误与这次看板请求无关,发起不得把它清掉:否则轮询/错误期切换一旦
          // 拉看板,列表级错误文案就在在途期间凭空消失(空错误框),且 BOARD_OK 的门控
          // 再也看不到被清掉的链级错误,掩盖路径复活。链级错误的清错点只在链级事件:
          // START(整链重新开始)/ LIST_OK / TOKEN_GUIDE / 完整 BOARD_OK。
          const chainErrorActive = state.phase === BOARD_PHASES.ERROR && state.error !== null && state.error.stage !== "board";
          return { ...state, boardInFlight: true, ...(chainErrorActive ? {} : { error: null }) };
        }
        case "BOARD_OK": {
          const accounting = {
            board: event.board,
            boardKey: event.key,
            totalCount: event.totalCount,
            incomplete: event.incomplete === true,
            boardInFlight: false,
          };
          // R3(P2 修复):链级(status/list/bootstrap)失败在场时,单看板成功不得把面板翻回
          // ready 或清错 —— 30s 轮询只证明「当前项目的卡片拉得动」,证明不了项目列表/启动
          // 链新鲜;否则刷新时的列表 503 会被下一个轮询成功静默吞掉,列表停在旧数据,用户
          // 以为一切正常(错误必须保持可见,直到整链重新成功或用户手动刷新)。整链恢复走
          // START → … → BOARD_OK:START 先清错进 loading,轮询/切换触发的 BOARD_OK 不会
          // 经过本分支。看板数据本身照常上账 —— 它是当前选中项目的真实回包,链恢复后无需
          // 重复等待。board 级错误是看板请求自己的失败,轮询成功恢复它是合法路径,不受门控。
          if (state.phase === BOARD_PHASES.ERROR && state.error !== null && state.error.stage !== "board") {
            return { ...state, ...accounting };
          }
          return { ...state, phase: BOARD_PHASES.READY, error: null, ...accounting };
        }
        case "BOOTSTRAP_DONE":
          return { ...state, retryCount: 0 };
        case "RETRY_TICK":
          return { ...state, retryCount: state.retryCount + 1 };
        case "RETRY_RESET":
          return { ...state, retryCount: 0 };
        default:
          return state;
      }
    }

    /**
     * 视图推导(纯函数):快照 → 渲染决策。组件据此渲染,不再各自维护布尔约束;
     * 「部分失败」= ready + warnings 非空,在这里与其它子形态一并判别。
     */
    function viewBoardState(state) {
      const columns = state.board !== undefined && state.board !== null && Array.isArray(state.board.columns) ? state.board.columns : [];
      const visibleCount = columns.reduce((sum, column) => sum + (Array.isArray(column?.items) ? column.items.length : 0), 0);
      const totalKnown = Number.isInteger(state.totalCount);
      const truncatedByTotal = totalKnown && state.totalCount > visibleCount;
      return {
        phase: state.phase,
        tokenConfigured: state.tokenConfigured,
        showGuide: state.tokenConfigured === false,
        showToolbar: state.tokenConfigured !== false,
        showError: state.phase === BOARD_PHASES.ERROR,
        showNoProjects: state.phase !== BOARD_PHASES.ERROR && state.tokenConfigured !== false && state.projects.length === 0,
        showBoardArea: state.tokenConfigured !== false && state.phase !== BOARD_PHASES.ERROR && state.projects.length > 0,
        failedSources: state.warnings.filter((warning) => warning.code !== "projects_truncated").map((warning) => warning.source),
        truncatedSources: state.warnings.filter((warning) => warning.code === "projects_truncated").map((warning) => warning.source),
        // 一致性门控(S1.7):看板只在「属于当前选中项目」时上屏 —— 加载新项目期间旧板
        // 一律退位成加载态,不把旧内容冒充成新项目内容;本地持久化的只有选择键,天然同源。
        boardMatchesSelection: state.board !== undefined && state.board !== null && state.boardKey !== null && state.boardKey === state.selected,
        boardAreaLoading: state.phase === BOARD_PHASES.LOADING || state.boardInFlight === true,
        visibleCount,
        totalDisplay: totalKnown && state.totalCount >= visibleCount ? state.totalCount : visibleCount,
        truncated: truncatedByTotal || state.incomplete === true,
        truncatedByTotal,
        incomplete: state.incomplete === true,
      };
    }

    /** 选择延续优先级(纯函数):当前选择(刷新场景)→ 持久化偏好(重开面板)→ 列表第一项。 */
    function selectTarget(projects, selectedKey, preferredKey) {
      return (
        projects.find((project) => projectKey(project) === selectedKey) ??
        projects.find((project) => projectKey(project) === preferredKey) ??
        projects[0] ??
        null
      );
    }

    /**
     * 看板数据控制器(S2.2):启动/重试/切换/刷新/轮询的唯一归属。框架无关 —— 组件只
     * 订阅快照做展示、把交互转交进来;所有可变时序(退避、自愈轮、轮询注册)都走
     * 注入的调度器,自检可以不经 React 直接驱动。
     * @param deps {
     *   getApi: () => boardApi(每渲染刷新引用,容忍 props 替换);
     *   t: 翻译函数(错误文案前缀);
     *   polling?: { intervalMs, setInterval(cb, ms) → dispose, isVisible(el) } —— 缺席不轮询;
     *   getElement?: () => 面板根节点(可见性探针入参);
     *   delay: (ms) => Promise —— 启动链内退避等待;
     *   scheduleRetry: (cb, ms) => cancel —— 错误态自愈定时器;
     * }
     */
    function createBoardController(deps) {
      const { t, delay, scheduleRetry } = deps;
      let state = initialBoardState();
      const listeners = new Set();
      let disposed = false;
      let started = false;
      // 请求生命周期(S1.3/S1.7):发起序号守卫 + 轮询节流
      let loadSeq = 0;
      let inFlight = false;
      // 链代数(R2):dispose 与每轮新链(start/reload/自愈重试发起的 bootstrap)都递增;
      // 所有异步续体在 dispatch 前核对「发起时捕获的代数」,失配即静默丢弃。覆盖两类
      // loadSeq 管不到的竞态:
      //   a) 卸载前在途的 status/list/board 迟到结果混入重挂载新链(StrictMode 双挂载、
      //      面板切换)—— dispose 时换代,重挂载不复活旧代;
      //   b) 整链刷新(或两轮刷新)与在途旧链竞态 —— 旧链迟到的 LIST_OK/BOARD_OK 会把
      //      新链刚立好的列表/看板回退成旧数据。
      // loadSeq 仍保留:它保护**同代之内**的看板请求先后(快速切换项目),代数保护链与链之间。
      let epoch = 0;
      // 一次性动作标记(S1.1:偏好只读一次、旧快照只清一次)
      let preferredKey = null;
      let prefsRead = false;
      let legacyPurged = false;
      // 定时器句柄(S1.8:自愈轮 + 轮询注册,dispose 统一收口)
      let retryTimer = null;
      let pollDispose = null;

      const emit = () => {
        if (disposed) return;
        for (const listener of [...listeners]) listener();
      };
      /** 事件派发:过状态机,再同步三个副作用(偏好写回 / 轮询注册 / 自愈轮调度)。 */
      const dispatch = (event) => {
        state = boardTransition(state, event);
        if (disposed) return;
        syncPrefs();
        syncPolling();
        syncRetry();
        emit();
      };
      const failureEvent = (result, stage) => {
        const code = result?.error?.code ?? "unknown";
        const message = result?.error?.message ?? "";
        return {
          type: "FAILED",
          stage,
          code,
          text: `${t("errorPrefix")}: [${code}] ${message}`,
          transient: isTransientFailure(result),
        };
      };

      /**
       * 看板请求(S1.3/S1.7):发请求取号、回包对号;号已过期(期间又发起过请求)就
       * 整体丢弃,防止快速切换项目时慢的旧响应覆盖新项目的看板。成功/失败/超时都要
       * 复位 inFlight(轮询节流不能被一次失败永久卡死);序号过期时归最新请求管理。
       * 响应先过契约校验(S2.4),畸形结构走可观测的错误路径。
       */
      const loadBoard = async (project, options = {}) => {
        const api = deps.getApi();
        if (api === undefined || api === null) return undefined;
        const projectNumber = Number(project?.number);
        if (!Number.isInteger(projectNumber) || projectNumber <= 0) return undefined; // 无有效项目时不发起请求
        const key = projectKey(project);
        const seq = ++loadSeq;
        const boardEpoch = epoch; // 发起时捕获:回包时链已被替换(刷新/重挂载换代)就整体作废
        inFlight = true;
        dispatch({ type: "BOARD_START" });
        // repo 只在仓归属项目上带(用户级不带 undefined 键,wire 面保持旧形状);
        // noCache 由刷新按钮传:绕过宿主 TTL 缓存强制真拉(刷新语义)。
        let result;
        try {
          result = await api.getBoard({
            projectNumber,
            ...(typeof project?.repo === "string" && project.repo.length > 0 ? { repo: project.repo } : {}),
            ...(options.noCache === true ? { noCache: true } : {}),
          });
        } finally {
          if (seq === loadSeq) inFlight = false;
        }
        if (result === undefined || disposed || boardEpoch !== epoch || seq !== loadSeq) return result; // 过期/已换代/已卸载:不碰任何状态
        const coerced = coerceBoardResult(result);
        if (coerced.ok === true) {
          dispatch({
            type: "BOARD_OK",
            board: coerced.board,
            key,
            totalCount: Number.isInteger(coerced.totalCount) ? coerced.totalCount : undefined,
            incomplete: coerced.incomplete === true,
          });
        } else {
          dispatch(failureEvent(coerced, "board")); // 轮询期的失败也维护瞬态标记,错误态自愈才有依据
        }
        return coerced;
      };

      /**
       * 初始装载链(S1.1 起:不再有快照乐观首屏 —— 本地只存选择偏好,业务数据一律等真回包):
       * 清旧版整板快照 → 读选择偏好 → status+list 并行(瞬态失败链内退避重试)→ 拉看板。
       * 三处复用:初次挂载(start)、错误态自动重试(自愈轮)、手动「刷新」(reload 带 noCache)。
       * 重试计数只在**完整启动成功**后归零(S1.5/R04):status 成功但列表持续瞬态失败时,
       * 计数必须能累计到 15 轮上限,否则自动重试永不停止。
       * chainEpoch 是发起时(runBootstrap)领到的链代数:链已被替换(刷新/重挂载/自愈新一轮)
       * 或控制器已卸载时,后续续体一律静默退出,不把旧链结果 dispatch 进新链状态(R2)。
       */
      const bootstrap = async (chainEpoch, options = {}) => {
        const api = deps.getApi();
        if (api === undefined || api === null) {
          dispatch({ type: "FAILED", stage: "bootstrap", code: "env_error", text: `${t("errorPrefix")}: board api unavailable`, transient: false });
          return;
        }
        if (legacyPurged !== true) {
          legacyPurged = true;
          purgeLegacySnapshot(); // 旧版整板快照含业务数据且无身份隔离,启动即清(R01)
        }
        if (prefsRead !== true) {
          prefsRead = true;
          const prefs = readPrefs();
          if (prefs !== null) preferredKey = prefs.selectedKey;
        }
        dispatch({ type: "START" });
        // status 与 listProjects 并行(0.5.0 提速);瞬态失败(连接未就绪/超时)链内退避重试
        // —— dsh 刚启动/刚重启时页面常比 RPC 载波先醒,一次失败不代表真故障。
        let status;
        let list;
        for (let attempt = 0; ; attempt += 1) {
          [status, list] = await Promise.all([api.status(), api.listProjects(options.noCache === true ? { noCache: true } : undefined)]);
          if (disposed || chainEpoch !== epoch) return; // 链已换代/已卸载:旧链结果作废
          const retryable = isTransientFailure(status) || isTransientFailure(list);
          if (!retryable || attempt >= 4) break;
          await delay(600 + attempt * 500);
          if (disposed || chainEpoch !== epoch) return;
        }
        const statusResult = coerceStatus(status);
        if (statusResult.ok !== true) {
          dispatch(failureEvent(statusResult, "status"));
          return;
        }
        if (statusResult.status.tokenConfigured !== true) {
          dispatch({ type: "TOKEN_GUIDE" }); // 引导态 = 启动链完整结束(不是错误),归零预算
          return;
        }
        dispatch({ type: "TOKEN_KNOWN" });
        const listResult = coerceProjectsResult(list);
        if (listResult.ok !== true) {
          dispatch(failureEvent(listResult, "list"));
          return; // 这里**不**归零重试计数(R04 的关键差异:完整成功才归零)
        }
        dispatch({ type: "LIST_OK", projects: listResult.projects, warnings: listResult.warnings ?? [] });
        if (listResult.projects.length === 0) return; // 空列表归零在转换里完成
        // 选择延续优先级(纯函数):当前选择 → 持久化偏好 → 列表第一项
        const target = selectTarget(listResult.projects, state.selected, preferredKey);
        dispatch({ type: "SELECT", key: target === null ? null : projectKey(target) });
        // phase 完全交给 BOARD_OK/FAILED 管理(成功 ready、失败 error),这里不再兜底置
        // ready —— 否则会覆盖失败分支已置的 error,把 401 展示成空板。
        const boardResult = await loadBoard(target, options);
        // 归零同样只属于当前链:旧链的成功不得给新链(或重挂载后的链)重置重试预算
        if (boardResult?.ok === true && !disposed && chainEpoch === epoch) dispatch({ type: "BOOTSTRAP_DONE" }); // 完整启动成功:归零自动重试预算(S1.5)
      };

      /** 发起一轮启动链:领新代数(旧链在途结果一律作废),异常兜底也按代数收口。 */
      const runBootstrap = (options) => {
        const chainEpoch = ++epoch;
        bootstrap(chainEpoch, options).catch((cause) => {
          if (disposed || chainEpoch !== epoch) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          dispatch({
            type: "FAILED",
            stage: "bootstrap",
            code: "unexpected",
            text: `${t("errorPrefix")}: ${message}`,
            transient: message.includes("Failed to fetch"),
          });
        });
      };

      /** 偏好写回(S1.1):只存选中键(一个字符串),不存任何看板/项目业务数据;
       *  选中项必须真实存在于当前列表,失配键(如项目已删)不落盘。 */
      const syncPrefs = () => {
        if (state.selected === null || state.projects.length === 0) return;
        if (!state.projects.some((project) => projectKey(project) === state.selected)) return;
        writePrefs(state.selected);
      };

      /** 轮询注册(30s 重拉当前项目):条件失配即收掉旧注册;句柄走单一字段收口,
       *  任何时刻最多一个活跃定时器(S1.8;轮询在 error/ready 期都可能活跃)。R3 语义:
       *  board 级错误期的轮询成功仍是看板恢复路径;list/bootstrap 级错误期的轮询成功只
       *  更新看板数据、不清错不翻 ready(门控在 BOARD_OK/FAILED 转换,见状态机注释)。
       *  不可见(折叠/后台)时跳过本轮 = 暂停。 */
      const syncPolling = () => {
        const polling = deps.polling;
        const stop = () => {
          const dispose = pollDispose;
          pollDispose = null;
          if (typeof dispose === "function") dispose();
        };
        if (polling === undefined || polling === null || state.tokenConfigured !== true || state.projects.length === 0) {
          stop();
          return;
        }
        if (pollDispose !== null) return; // 已在册:不重复注册(重调度防御)
        const dispose = polling.setInterval(() => {
          if (disposed || inFlight === true) return;
          const target = state.projects.find((project) => projectKey(project) === state.selected) ?? null;
          if (target === null) return;
          if (polling.isVisible(deps.getElement === undefined ? undefined : deps.getElement()) !== true) return;
          loadBoard(target);
        }, polling.intervalMs);
        pollDispose = typeof dispose === "function" ? dispose : null;
      };

      /** 瞬态错误自愈:错误态且属连接类失败时,4s 后自动重跑 bootstrap(15 轮上限 ≈ 1 分钟),
       *  之后停在错误态等用户手动刷新 —— 服务真没了就别空转。重调度前先清旧定时器,
       *  保证不叠发(S1.8)。 */
      const syncRetry = () => {
        if (state.phase !== BOARD_PHASES.ERROR || state.error?.transient !== true || state.retryCount >= 15) {
          if (retryTimer !== null) {
            retryTimer.cancel();
            retryTimer = null;
          }
          return;
        }
        if (retryTimer !== null) return; // 已在倒计时
        const cancel = scheduleRetry(() => {
          retryTimer = null;
          dispatch({ type: "RETRY_TICK" });
          runBootstrap();
        }, 4000);
        retryTimer = { cancel: typeof cancel === "function" ? cancel : () => {} };
      };

      return {
        /** 当前快照(只读引用;转换总是产出新对象)。 */
        getSnapshot: () => state,
        /** 订阅状态变化(组件挂视图用);返回退订函数。 */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** 挂载入口:首挂载发起启动链;重挂载(effect 重跑,如 StrictMode 双挂载)先清
         *  卸载标记再重新拉全链 —— 对齐旧实现「effect 体重置 disposedRef」的口径;
         *  卸载前在途的迟到结果由链代数守卫丢弃(dispose 已换代),不会污染新一轮(R2)。 */
        start() {
          const remount = disposed === true;
          disposed = false;
          if (started === true && remount !== true) return;
          started = true;
          runBootstrap();
        },
        /**
         * 手动「刷新」(S1.6/R05):整链重拉 —— 项目列表 + 看板一起覆盖,而不是只重拉当前
         * 看板(项目新增/删除/权限变化要能反映到列表);列表与看板都带 noCache 绕过宿主 TTL。
         * 手动重试同时重置自动重试预算:用户明确要求恢复时,再给满一轮自动自愈。
         */
        reload() {
          if (disposed) return;
          dispatch({ type: "RETRY_RESET" });
          runBootstrap({ noCache: true });
        },
        /** 项目切换(宽容语义:选中照设,失配时切换器回退占位提示;找到项目才发起拉取)。 */
        select(key) {
          if (disposed) return;
          dispatch({ type: "SELECT", key });
          const project = state.projects.find((candidate) => projectKey(candidate) === key) ?? null;
          if (project !== null) loadBoard(project);
        },
        /** 卸载收口(S1.8):停自愈轮与轮询注册;同时换代(R2)—— 即便之后重挂载把
         *  disposed 翻回 false,卸载前在途的一切结果也按旧代作废,不混入新链。 */
        dispose() {
          if (disposed) return;
          disposed = true;
          epoch += 1;
          if (retryTimer !== null) {
            retryTimer.cancel();
            retryTimer = null;
          }
          const stop = pollDispose;
          pollDispose = null;
          if (typeof stop === "function") stop();
          listeners.clear();
        },
      };
    }

    // ─────────────────────────── §4. 视图组件(只做展示与触发) ───────────────────────────

    /** token 未配置的引导视图:只讲「去哪设、怎么生效」,不显示任何错误堆栈。 */
    function TokenGuide(props) {
      const { t } = props;
      return h(
        "section",
        { className: "tgk-guide", "aria-label": t("guideTitle") },
        h("p", { className: "tgk-guideTitle" }, t("guideTitle")),
        h("p", { className: "tgk-guideText" }, `1. ${t("guideStep1")}`),
        h("code", { className: "tgk-guideCode" }, "GITHUB_TOKEN=ghp_…  # env of the dsh process"),
        h("p", { className: "tgk-guideText" }, `2. ${t("guideStep2")}`),
        h("p", { className: "tgk-guideText" }, `3. ${t("guideStep3")}`),
      );
    }

    /**
     * 项目切换器:label + select。刷新按钮不在这里 —— 工具栏(含按钮)在错误态/空列表
     * 也要常驻(S1.6/R05:无快照的首载失败必须有恢复入口),由 body 统一拼装。
     */
    function ProjectSwitcher(props) {
      const { t, projects, selected, onSelect } = props;
      // selected 不在当前列表(如刷新后项目被删)时回退空值,
      // 并插入一个禁用的占位 option 提示「项目已不可用」,不可被选中。
      const matched = projects.some((project) => projectKey(project) === selected);
      const placeholder = matched
        ? null
        : h("option", { key: "__gone__", value: "", disabled: true }, t("switcherProjectGone"));
      return h(
        "label",
        { className: "tgk-lede", htmlFor: "tgk-project-select" },
        t("toolbarProject"),
        h(
          "select",
          {
            id: "tgk-project-select",
            className: "tgk-select",
            value: matched ? selected : "",
            onChange: (event) => onSelect(event.target.value),
          },
          placeholder,
          projects.map((project) =>
            h(
              "option",
              { key: projectKey(project), value: projectKey(project) },
              `#${project.number} ${project.title}${project.repo === undefined ? "" : ` · ${project.repo}`}`,
            ),
          ),
        ),
      );
    }

    /**
     * 列显示名(S2.9):数据本体(Status 选项名)直出;宿主的兜底列只给 fallback
     * 标记(all = 无 Status 字段的单列退化 / unfiled = 卡片未归列),显示名查词典。
     */
    function columnDisplayName(column, t) {
      if (column.fallback === "all") return t("columnAll");
      if (column.fallback === "unfiled") return t("columnUnfiled");
      return String(column.name ?? "");
    }

    /** 单张卡片:标题(带链接)、负责人、标签三要素;标题缺失走词典(S2.9)。 */
    function Card(props) {
      const { item, t } = props;
      const title = item.untitled === true ? t("cardUntitled") : item.title;
      const titleNode = item.url === undefined
        ? h("p", { className: "tgk-cardTitle" }, title)
        : h("p", { className: "tgk-cardTitle" }, h("a", { className: "tgk-cardTitleLink", href: item.url, target: "_blank", rel: "noreferrer" }, title));
      return h(
        "li",
        { className: "tgk-card" },
        titleNode,
        item.assignees.length > 0
          ? h("ul", { className: "tgk-meta", "aria-label": "assignees" }, item.assignees.map((login) => h("li", { key: login, className: "tgk-assignee" }, `@${login}`)))
          : null,
        item.labels.length > 0
          ? h("ul", { className: "tgk-meta", "aria-label": "labels" }, item.labels.map((label) => h("li", { key: label.name, className: "tgk-label", style: label.color === undefined ? undefined : { borderColor: `#${label.color}` } }, label.name)))
          : null,
      );
    }

    /** 看板分列:列序由宿主 mapBoard 保证 = Status 选项序,这里只按顺序渲染。 */
    function Board(props) {
      const { t, board } = props;
      if (board.columns.length === 0 || board.columns.every((column) => column.items.length === 0) === true) {
        return h("p", { className: "tgk-state" }, t("stateEmptyBoard"));
      }
      return h(
        "div",
        { className: "tgk-board", role: "list" },
        board.columns.map((column) =>
          h(
            "section",
            { className: "tgk-column", key: column.optionId ?? "__unfiled", role: "listitem", "aria-label": columnDisplayName(column, t) },
            h(
              "p",
              { className: "tgk-columnHead" },
              columnDisplayName(column, t),
              h("span", { className: "tgk-columnCount" }, t("columnCount", { count: column.items.length })),
            ),
            column.items.length === 0
              ? h("p", { className: "tgk-emptyColumn" }, t("columnEmpty"))
              : h("ul", { className: "tgk-cards" }, column.items.map((item) => h(Card, { key: item.id, item, t }))),
          ),
        ),
      );
    }

    /**
     * 看板面板 body —— 视图层(S2.2 整改后):创建/订阅控制器,从快照 + 视图推导渲染;
     * 交互(select/reload)转交控制器,组件内不再有数据流分支。
     * props 来自框架座位与插件 inject 面:
     *   board —— createBoardApi 的数据出口(缺席则降级);t —— 本插件命名空间的翻译;
     *   polling —— 轮询面(缺席不轮询)
     */
    function GithubKanbanBody(props) {
      const { board: boardApiProp, t, polling } = props;
      // boardApi 经 ref 透传给控制器:props 替换(理论上)无需重建控制器。
      const apiRef = react.useRef(boardApiProp);
      apiRef.current = boardApiProp;
      const panelRef = react.useRef(null); // 面板根节点:可见性探针用
      const [controller] = react.useState(() =>
        createBoardController({
          getApi: () => apiRef.current,
          t,
          polling,
          getElement: () => panelRef.current,
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          scheduleRetry: (callback, ms) => {
            const id = setTimeout(callback, ms);
            return () => clearTimeout(id);
          },
        }),
      );
      // 订阅快照:控制器每次转换发通知,这里只递增版本号触发重渲染。
      const [, setTick] = react.useState(0);
      react.useEffect(() => {
        const unsubscribe = controller.subscribe(() => setTick((count) => count + 1));
        controller.start();
        return () => {
          unsubscribe();
          controller.dispose(); // 卸载兜底(S1.8):自愈轮与轮询统一收口
        };
      }, [controller]);

      const state = controller.getSnapshot();
      const view = viewBoardState(state);
      const statusHintKey = state.board !== undefined && state.board !== null && state.board.hasStatusField === false
        ? { not_found: "statusHintNotFound", possibly_renamed: "statusHintRenamed", fields_truncated: "statusHintTruncated" }[state.board.statusFieldHint]
        : undefined;

      const body = [];
      if (view.showGuide) {
        body.push(h(TokenGuide, { key: "guide", t }));
      } else {
        // 工具栏常驻口径(S1.6/R05):token 已知「非未配置」时,切换器(有列表的话)与
        // 刷新按钮在任何 phase(含 error / loading / 空列表)都可见可操作。
        body.push(
          h(
            "div",
            { key: "toolbar", className: "tgk-toolbar" },
            state.projects.length > 0
              ? h(ProjectSwitcher, {
                  key: "switcher",
                  t,
                  projects: state.projects,
                  selected: state.selected,
                  onSelect: controller.select,
                })
              : null,
            h(
              "button",
              { key: "reload", className: "tgk-reload", type: "button", onClick: controller.reload, disabled: state.boardInFlight === true },
              state.boardInFlight === true ? t("toolbarRefreshing") : t("toolbarReload"),
            ),
          ),
        );
        if (view.showError) {
          body.push(h("p", { key: "error", className: "tgk-state tgk-stateError" }, state.error?.text ?? ""));
          if (state.error?.transient === true) body.push(h("p", { key: "retryhint", className: "tgk-state" }, t("connRetryHint")));
        } else {
          // 来源级警告独立渲染(R2):空列表也要可见 —— viewer 0 项目常正是「某来源读取
          // 失败/截断,其余来源也没有项目」的结果,只在看板区渲染会把失败藏进「暂无项目」,
          // 用户无从知道有来源读失败。错误态不并排(错误文案已点名 stage/code)。
          if (view.failedSources.length > 0) {
            body.push(h("p", { key: "srcwarn", className: "tgk-state" }, t("sourceWarning", { sources: view.failedSources.join("、") })));
          }
          if (view.truncatedSources.length > 0) {
            body.push(h("p", { key: "srctrunc", className: "tgk-state" }, t("sourceTruncated", { sources: view.truncatedSources.join("、") })));
          }
          if (view.showNoProjects) {
            body.push(h("p", { key: "noproj", className: "tgk-state" }, state.phase === BOARD_PHASES.LOADING ? t("stateLoading") : t("stateNoProjects")));
          } else if (view.showBoardArea) {
            if (statusHintKey !== undefined) body.push(h("p", { key: "statushint", className: "tgk-state" }, t(statusHintKey)));
            if (Number.isInteger(state.board?.contentMissing) && state.board.contentMissing > 0) {
              body.push(h("p", { key: "contentmissing", className: "tgk-state tgk-stateError" }, t("contentMissingHint", { count: state.board.contentMissing })));
            }
            if (Number.isInteger(state.board?.fieldValuesTruncated) && state.board.fieldValuesTruncated > 0) {
              body.push(h("p", { key: "valuestrunc", className: "tgk-state" }, t("fieldValuesTruncated", { count: state.board.fieldValuesTruncated })));
            }
            if (view.boardMatchesSelection) {
              body.push(h("p", { key: "total", className: "tgk-total" }, t("boardTotalCount", { count: view.totalDisplay })));
              if (view.truncatedByTotal) body.push(h("p", { key: "trunc", className: "tgk-total" }, t("boardTruncated", { fetched: view.visibleCount, total: state.totalCount })));
              else if (view.incomplete) body.push(h("p", { key: "capped", className: "tgk-total" }, t("boardCapped", { fetched: view.visibleCount })));
              body.push(h(Board, { key: "board", t, board: state.board }));
            } else {
              // 看板退位的空位文案:初次装载(loading)或切换/刷新途中(boardInFlight)
              // 都表明正在读取 —— 不能把「读取中」误标成「没有条目」。
              body.push(h("p", { key: "emptyboard", className: "tgk-state" }, view.boardAreaLoading ? t("stateLoading") : t("stateEmptyBoard")));
            }
          }
        }
      }

      return h(
        "section",
        { className: "tgk-root", "aria-label": t("panelTitle"), ref: panelRef },
        h(
          "header",
          { className: "tgk-head" },
          h("h2", { className: "tgk-title" }, t("panelTitle")),
          h("span", { className: "tgk-badge" }, t("phaseBadge")),
        ),
        h("p", { className: "tgk-lede" }, t("panelLede")),
        ...body,
      );
    }

    /**
     * panellist 入口图标:朴素的三列看板字形(svg,随宿主 currentColor 填色)。
     * 图形逻辑沿用原 title chip 的克制口径:只画板形,不夹带状态。
     */
    function GithubKanbanPanelIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          "aria-hidden": "true",
        },
        h("rect", { x: 1.75, y: 2.75, width: 4.5, height: 10.5, rx: 1 }),
        h("rect", { x: 9.75, y: 2.75, width: 4.5, height: 6.5, rx: 1 }),
      );
    }

    // ─────────────────────────── §5. 注册 ───────────────────────────

    /**
     * 浏览器半边入口。
     * @param ctx 已装载 slots / locale / remote(含嵌套 githubKanban 面)的 Client Context
     */
    async function apply(ctx) {
      const dsh = createClientAdapter(ctx);
      dsh.registerDictionary({ zh, en });
      const t = ctx.locale.bind(NS);
      // 先挂远程面再注册座位:组件拿到的 boardApi 首次调用会等 mount 完成。
      const mountPromise = dsh.mountRemote();
      // 取面必须走带全名 inject 的 scoped fiber:remote.githubKanban 是本插件 $mount
      // 自装的服务,fiber 会等它装好才运行,所以 facePromise 天然在 mount 成功之后;
      // mount 失败则同样拒绝,由 boardApi 折叠成结构化错误态。
      const facePromise = new Promise((resolve, reject) => {
        mountPromise.then(
          (mounted) => {
            if (mounted !== undefined && mounted.ok !== true) reject(new Error(mounted.error?.message ?? "远程面未挂载。"));
          },
          (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
        );
        if (typeof ctx?.inject !== "function") {
          reject(new Error("客户端缺少 ctx.inject(scoped fiber 不可用)。"));
          return;
        }
        // 双名对齐官方插件(product-analytics 的 inject: ["remote","remote.productAnalytics"]):
        // 父名 "remote" 由核心网关开机提供,不会死等;全名才是取面授权。
        ctx.inject(["remote", "remote.githubKanban"], (scoped) => {
          resolve(scoped.remote.githubKanban);
        });
      });
      // Remote 有界等待的定时调度(S1.2):优先宿主 timer Service 的 ctx.timeout
      // (与轮询的 ctx.interval 同一来源,随 ctx 生命周期自动清理),缺席时回退全局
      // setTimeout —— 两态语义一致:到期才触发,销毁句柄可提前取消。
      const scheduleRemoteDeadline = typeof ctx?.timeout === "function"
        ? (callback, ms) => {
            const dispose = ctx.timeout(callback, ms);
            return typeof dispose === "function" ? dispose : () => {};
          }
        : (callback, ms) => {
            const id = setTimeout(callback, ms);
            return () => clearTimeout(id);
          };
      const boardApi = createBoardApi(mountPromise, facePromise, scheduleRemoteDeadline);
      // 轮询面:间隔用宿主 timer Service(插件声明 inject: ["timer"],client runner 内建
      // 同 API 实现);缺席时退回全局 setInterval,rc 期双保险(决策见 notes/dev-notes.md 差异 10)。
      const scheduleInterval = typeof ctx?.interval === "function"
        ? (callback, ms) => ctx.interval(callback, ms)
        : (callback, ms) => {
            const id = setInterval(callback, ms);
            return () => clearInterval(id);
          };
      const polling = { intervalMs: POLL_INTERVAL_MS, setInterval: scheduleInterval, isVisible: defaultIsVisible };
      // 主区页面:内容就是既有看板 body,视觉零改动(迁移自右栏 tab,Phase 1.4)。
      dsh.registerSeat(SEAT.main, GithubKanbanBody, { key: PANEL_ID }, () => ({ identity: dsh.identity, board: boardApi, polling }));
      // 左栏「Global panels」入口:与 Automation tasks(order 10)同型,点击由宿主 ctx.layout.selectPanel(id) 派发。
      dsh.registerSeat(SEAT.panellist, GithubKanbanPanelIcon, { id: PANEL_ID, order: PANEL_ORDER, label: () => t("tabTitle") });
      // 失败不抛:面板会用结构化错误态呈现;这里只留一条可查的 Promise 链。
      mountPromise.catch(() => {});
    }

    /** 需要的客户端服务:座位注册、文案、remote 面本体、timer(30s 轮询)。
     *  全名 "remote.githubKanban" **禁止**进这份清单:该服务由本插件 apply 里的
     *  $mount 自装,而入口激活会先等 inject 里的服务 → apply 永不运行 → 死锁
     *  (真机 2026-10-01 实测:pending "waiting for service: remote.githubKanban";
     *  官方插件敢这么写是因为其描述符由核心包开机 $mount,不存在自装)。
     *  取面一律走 apply 里 ctx.inject(["remote.githubKanban"], …) 的 scoped fiber。 */
    const inject = ["slots", "locale", "remote", "timer"];

    /**
     * 自检接缝(S2.2):暴露数据控制层的纯函数与控制器工厂,供 scripts/smoke-load.mjs
     * 不经 React 直接驱动。不是对外 API —— 浏览器运行时无人引用,dsh 装载器只取
     * apply/inject;若未来删除,同步删自检里对 internals 的引用。
     */
    const internals = {
      BOARD_PHASES,
      boardTransition,
      coerceBoardResult,
      coerceProjectsResult,
      coerceStatus,
      createBoardController,
      initialBoardState,
      isTransientFailure,
      projectKey,
      selectTarget,
      viewBoardState,
    };

    return { apply, inject, internals };
  },
});
