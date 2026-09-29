/**
 * dsh-github-kanban · 浏览器半边 —— Phase 1.2「GitHub 读链路看板」。
 *
 * 装载契约(dsh 0.2.0-rc.1,依据 @deepseek-ai/dsh-client-modules 源码):
 *   1. 本文件被 dsh 按原样当 <script> 提供:不打包、不转译;执行时只注册工厂(零副作用),
 *      样式注入等动作都发生在 factory 物化时。
 *   2. require 只能命中平台 seed 词或已装载插件的包名 —— 相对路径不可用,
 *      所以适配层必须和组件同处一个文件(差异 5)。
 *   3. 注册的 id 必须等于 package.json 的 name,否则加载器报 "loaded without registering"。
 *
 * 数据面(差异 3 的落地):apply 时用 ctx.remote.$mount(手写清单)把宿主 githubKanban
 * 服务装进浏览器 remote 面,组件经 boardApi 调 status / listProjects / getBoard。
 * token 永不出现在这里:面板只看「未配置」布尔与结构化错误文案。
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
    /** tab 类型 id:keyed 座位按它派发 body 与 chip 标题。 */
    const TAB_ID = "@local/thorn-github-kanban/board";
    /** tab 类型 kind:openTab(kind) 用的判别值。 */
    const TAB_KIND = "githubKanbanBoard";
    /** 宿主远程服务键(与 lib/index.js 的 SERVICE_KEY 一致)。 */
    const SERVICE_KEY = "githubKanban";

    // ─────────────────────────── 1. dsh 客户端适配层 ───────────────────────────
    // 执行守则 3:dsh 是 rc,装载/座位/远程 API 可能 breaking。全插件只有这一节接触
    // dsh 契约(座位注册、tab 类型、文案、样式归属、remote 挂载);组件只吃 props。

    /** 右栏座位:body 与 chip 标题是同一套 keyed 派发(按 tab 类型的 id)。 */
    const SEAT = {
      tab: "sidebar.right.pane.tab",
      tabTitle: "sidebar.right.pane.tab.title",
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
     * 手写 remote 清单:宿主 SRC 回退面的浏览器对端(三个 direct 方法)。
     * 字段逐项对照 dsh-typert-registry validateInvocation 的要求。
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
      return {
        package: PACKAGE_ID,
        descriptors: [
          method("status", []),
          method("listProjects", []),
          method("getBoard", [{ name: "request", wire: "request", source: "json", codec: strictStub(`${PACKAGE_ID}/client#getBoardRequest`) }]),
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
      if (typeof ctx?.sidebarRightTabs?.register !== "function") missing.push("sidebarRightTabs.register");
      if (typeof ctx?.locale?.register !== "function" || typeof ctx?.locale?.bind !== "function") missing.push("locale.register/bind");
      if (typeof ctx?.effect !== "function") missing.push("effect");
      if (missing.length > 0) {
        throw new Error(
          `[${PACKAGE_ID}] 客户端装载契约不匹配,缺少:${missing.join("、")}。` +
            `本插件按 dsh 0.2.0-rc.1 的 ${SEAT.tab} / sidebarRightTabs / locale 契约编写;` +
            "dsh 升级后请对照官方包源码更新 lib/client.js 的适配层。",
        );
      }
      const hasRemote = ctx.remote !== undefined && typeof ctx.remote.$mount === "function";
      return {
        identity: {
          packageId: PACKAGE_ID,
          ns: NS,
          tabId: TAB_ID,
          tabKind: TAB_KIND,
          seats: [SEAT.tab, SEAT.tabTitle],
          remote: hasRemote,
        },
        registerDictionary(dicts) {
          return ctx.effect(() => ctx.locale.register(NS, dicts), `${PACKAGE_ID}: dictionaries`);
        },
        registerTabType(definition) {
          return ctx.effect(() => ctx.sidebarRightTabs.register(definition), `${PACKAGE_ID}: ${TAB_KIND} tab type`);
        },
        registerSeat(seat, Component, inject) {
          const options = { name: seat, key: TAB_ID, locale: NS, registrant: PACKAGE_ID };
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
.tgk-readings{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;margin:0}
.tgk-reading{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.tgk-readingLabel{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}
.tgk-readingValue{margin:0;font-size:16px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tgk-subhead{margin:2px 0 0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,inherit)}
.tgk-chain{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.tgk-chainRow{display:flex;align-items:baseline;gap:6px;font-size:12px}
.tgk-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#d33)}
.tgk-dotOk{background:var(--dsw-alias-state-success-primary,#2a2)}
.tgk-chainLabel{color:var(--dsw-alias-label-secondary,inherit)}
.tgk-chainDetail{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}
.tgk-foot,.tgk-beat,.tgk-next{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;overflow-wrap:anywhere}
.tgk-beat{font-variant-numeric:tabular-nums}
.tgk-chip{display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:12px}
.tgk-chipCount{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,inherit));font-variant-numeric:tabular-nums}
/* 本面板不含 transition/animation:prefers-reduced-motion 下天然等价 */
`;

    injectPluginStyles(`${PACKAGE_ID}/panel.css`, PANEL_CSS);

    // ─────────────────────────── 2. 文案 ───────────────────────────

    /** 简体中文(键源)。 */
    const zh = {
      tabTitle: "GitHub 看板",
      tabDescription: "GitHub Projects 看板(只读,支持项目切换)",
      panelTitle: "GitHub Projects 看板",
      phaseBadge: "只读",
      panelLede: "数据来自 GitHub Projects v2,列序 = Status 选项序;改动暂不写回(Phase 2)。",
      toolbarProject: "项目",
      toolbarReload: "刷新",
      toolbarRefreshing: "刷新中…",
      stateLoading: "正在读取 GitHub…",
      stateNoProjects: "viewer 名下没有可显示的 Projects v2 项目。",
      stateEmptyBoard: "该项目还没有看板条目。",
      guideTitle: "尚未配置 GitHub 访问令牌",
      guideStep1: "在启动 dsh 的环境里设置环境变量 GITHUB_TOKEN(需要 repo + project 读权限的 fine-grained PAT);",
      guideStep2: "完全退出并重启 dsh web(环境变量在启动时读取);",
      guideStep3: "重新打开本面板即可看到看板。令牌只留在宿主进程里,不会进入浏览器或日志。",
      errorPrefix: "读取失败",
      columnCount: "{count}",
      columnEmpty: "空",
      readingSessions: "会话总数",
      readingRunning: "运行中会话",
      readingCurrent: "当前会话",
      readingModel: "当前模型(投影)",
      valueAbsent: "—",
      valueUnnamed: "(未命名)",
      chainTitle: "链路自检",
      chainBodySeat: "body 座位",
      chainSessionsSeat: "会话座位(useSessions)",
      chainProjectionSeat: "宿主投影座位(useProjection)",
      chainTabRecord: "tab 记录",
      chainRemote: "远程面(remote.$mount)",
      footprint: "本插件占位:{seats}",
      beat: "渲染节拍 {count}(每秒 +1,证明面板是活的)",
      nextHint: "下一步:Phase 1.3 定时轮询(30s)自动刷新;Phase 2 拖卡写回。",
    };

    /** English,逐键对照。 */
    const en = {
      tabTitle: "GitHub Board",
      tabDescription: "GitHub Projects board (read-only, project switcher)",
      panelTitle: "GitHub Projects board",
      phaseBadge: "read-only",
      panelLede: "Data comes from GitHub Projects v2; column order = Status option order. Writes land in Phase 2.",
      toolbarProject: "Project",
      toolbarReload: "Reload",
      toolbarRefreshing: "Refreshing…",
      stateLoading: "Reading GitHub…",
      stateNoProjects: "No Projects v2 boards are visible to the viewer.",
      stateEmptyBoard: "This project has no board items yet.",
      guideTitle: "GitHub token is not configured yet",
      guideStep1: "Set the GITHUB_TOKEN environment variable where dsh starts (a fine-grained PAT with repo + project read access);",
      guideStep2: "Quit and restart dsh web completely (the variable is read at startup);",
      guideStep3: "Reopen this panel. The token stays in the host process and never reaches the browser or logs.",
      errorPrefix: "Failed to load",
      columnCount: "{count}",
      columnEmpty: "empty",
      readingSessions: "Sessions",
      readingRunning: "Running",
      readingCurrent: "Current session",
      readingModel: "Current model (projection)",
      valueAbsent: "—",
      valueUnnamed: "(untitled)",
      chainTitle: "Load-path self-check",
      chainBodySeat: "body seat",
      chainSessionsSeat: "session seat (useSessions)",
      chainProjectionSeat: "host projection seat (useProjection)",
      chainTabRecord: "tab record",
      chainRemote: "remote face ($mount)",
      footprint: "Plugin footprint: {seats}",
      beat: "Render beat {count} (+1 every second — the panel is live)",
      nextHint: "Next: Phase 1.3 adds a 30s polling refresh; Phase 2 adds drag-to-write-back.",
    };

    // ─────────────────────────── 3. 数据流(boardApi 与加载状态机) ───────────────────────────

    /** 统一的结构化失败形状(与宿主 boardError 对齐)。 */
    const failed = (code, message) => ({ ok: false, error: { code, message } });

    /**
     * 组件的数据出口:等 $mount 完成后调 ctx.remote.githubKanban。
     * RemoteError 与任何意外都折叠成结构化失败;组件不见异常、不见凭据。
     * @param mountPromise 适配层 mountRemote() 的 promise
     * @param remote 浏览器 ctx.remote(可为 undefined,降级成错误态)
     */
    function createBoardApi(mountPromise, remote) {
      const call = async (method, args) => {
        let mounted;
        try {
          mounted = await mountPromise;
        } catch (cause) {
          return failed("remote_mount_failed", cause instanceof Error ? cause.message : String(cause));
        }
        if (mounted === undefined || mounted.ok !== true) {
          return failed(mounted?.error?.code ?? "remote_mount_failed", mounted?.error?.message ?? "远程面未挂载。");
        }
        const face = remote?.[SERVICE_KEY];
        if (face === undefined || typeof face[method] !== "function") {
          return failed("remote_missing", `远程面缺少 ${SERVICE_KEY}.${method}。`);
        }
        try {
          const result = await face[method](...(args === undefined ? [] : [args]));
          if (result !== undefined && result !== null && typeof result === "object" && "ok" in result) return result;
          return failed("shape_error", `${SERVICE_KEY}.${method} 返回了意外结构。`);
        } catch (cause) {
          return failed("remote_error", cause instanceof Error ? cause.message : String(cause));
        }
      };
      return {
        status: () => call("status"),
        listProjects: () => call("listProjects"),
        getBoard: (request) => call("getBoard", request),
      };
    }

    // ─────────────────────────── 4. 组件 ───────────────────────────

    /** 缺席座位 hook 的固定替身:座位 hook 由框架注入,rc 期哪个缺了都不该把面板打崩。 */
    const noopTabInfo = () => undefined;
    const noopSelector = () => undefined;
    const noopProjection = () => undefined;

    /** 一行投影读数(dl > div > dt/dd)。 */
    function reading(label, value) {
      return h(
        "div",
        { className: "tgk-reading", key: label },
        h("dt", { className: "tgk-readingLabel" }, label),
        h("dd", { className: "tgk-readingValue" }, value),
      );
    }

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

    /** 项目切换器 + 刷新按钮。 */
    function ProjectSwitcher(props) {
      const { t, projects, selected, onSelect, onReload, refreshing } = props;
      return h(
        "div",
        { className: "tgk-toolbar" },
        h("label", { className: "tgk-lede", htmlFor: "tgk-project-select" }, t("toolbarProject")),
        h(
          "select",
          {
            id: "tgk-project-select",
            className: "tgk-select",
            value: selected === null || selected === undefined ? "" : String(selected),
            onChange: (event) => onSelect(Number(event.target.value)),
          },
          projects.map((project) =>
            h("option", { key: project.number, value: String(project.number) }, `#${project.number} ${project.title}`),
          ),
        ),
        h("button", { className: "tgk-reload", type: "button", onClick: onReload, disabled: refreshing === true }, refreshing === true ? t("toolbarRefreshing") : t("toolbarReload")),
      );
    }

    /** 单张卡片:标题(带链接)、负责人、标签三要素。 */
    function Card(props) {
      const { item } = props;
      const title = item.url === undefined
        ? h("p", { className: "tgk-cardTitle" }, item.title)
        : h("p", { className: "tgk-cardTitle" }, h("a", { className: "tgk-cardTitleLink", href: item.url, target: "_blank", rel: "noreferrer" }, item.title));
      return h(
        "li",
        { className: "tgk-card" },
        title,
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
            { className: "tgk-column", key: column.optionId ?? "__unfiled", role: "listitem", "aria-label": column.name },
            h(
              "p",
              { className: "tgk-columnHead" },
              column.name,
              h("span", { className: "tgk-columnCount" }, t("columnCount", { count: column.items.length })),
            ),
            column.items.length === 0
              ? h("p", { className: "tgk-emptyColumn" }, t("columnEmpty"))
              : h("ul", { className: "tgk-cards" }, column.items.map((item) => h(Card, { key: item.id, item }))),
          ),
        ),
      );
    }

    /**
     * 看板面板 body。props 来自框架座位与插件 inject 面:
     *   useTabInfo / sessionId / useSessions / useProjection —— 标准座位 props
     *   identity —— 适配层身份快照;board —— createBoardApi 的数据出口(缺席则降级)
     *   t —— 本插件命名空间的翻译
     */
    function GithubKanbanBody(props) {
      const { useTabInfo, useSessions, useProjection, sessionId, identity, board: boardApi, t } = props;

      const tabInfoHook = typeof useTabInfo === "function" ? useTabInfo : noopTabInfo;
      const sessionsHook = typeof useSessions === "function" ? useSessions : noopSelector;
      const projectionHook = typeof useProjection === "function" ? useProjection : noopProjection;

      const tabInfo = tabInfoHook();
      const sessionCount = sessionsHook((state) => state?.ids?.length);
      const runningCount = sessionsHook((state) => (state?.ids ?? []).filter((id) => state?.byId?.[id]?.running === true).length);
      const currentTitle = sessionsHook((state) => (sessionId === undefined ? undefined : state?.byId?.[sessionId]?.displayTitle));
      const currentModel = projectionHook("modelSelection", (value) => value?.next?.model);

      // ── 看板加载状态机:idle → status → projects → board ──
      const [phase, setPhase] = react.useState("idle"); // idle|loading|ready|error
      const [tokenConfigured, setTokenConfigured] = react.useState(undefined);
      const [projects, setProjects] = react.useState([]);
      const [selected, setSelected] = react.useState(null);
      const [board, setBoard] = react.useState(undefined); // undefined=未拉取, null=空, object=数据
      const [errorText, setErrorText] = react.useState("");
      const [refreshing, setRefreshing] = react.useState(false);
      const [beat, setBeat] = react.useState(0);
      const projectRef = react.useRef(null);
      projectRef.current = selected;

      react.useEffect(() => {
        const timer = setInterval(() => setBeat((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, []);

      const loadBoard = react.useCallback(async (projectNumber, isInitial) => {
        if (boardApi === undefined || boardApi === null) return;
        if (isInitial) setPhase("loading");
        setRefreshing(true);
        setErrorText("");
        const result = await boardApi.getBoard({ projectNumber });
        setRefreshing(false);
        if (result.ok === true) {
          setBoard(result.board);
          setPhase("ready");
        } else {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: [${result.error?.code}] ${result.error?.message ?? ""}`);
        }
      }, [boardApi, t]);

      react.useEffect(() => {
        let cancelled = false;
        if (boardApi === undefined || boardApi === null) {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: board api unavailable`);
          return undefined;
        }
        (async () => {
          setPhase("loading");
          const status = await boardApi.status();
          if (cancelled) return;
          if (status.ok !== true) {
            setPhase("error");
            setErrorText(`${t("errorPrefix")}: [${status.error?.code}] ${status.error?.message ?? ""}`);
            return;
          }
          setTokenConfigured(status.status?.tokenConfigured === true);
          if (status.status?.tokenConfigured !== true) {
            setPhase("ready");
            return;
          }
          const list = await boardApi.listProjects();
          if (cancelled) return;
          if (list.ok !== true) {
            setPhase("error");
            setErrorText(`${t("errorPrefix")}: [${list.error?.code}] ${list.error?.message ?? ""}`);
            return;
          }
          setProjects(list.projects);
          if (list.projects.length === 0) {
            setPhase("ready");
            return;
          }
          const first = list.projects[0]?.number ?? null;
          setSelected(first);
          await loadBoard(first, false);
          if (!cancelled) setPhase("ready");
        })().catch((cause) => {
          if (cancelled) return;
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 初次挂载拉一次;后续切换/刷新走显式回调
      }, [boardApi]);

      const show = (value, fallback) => (value === undefined || value === null ? t(fallback) : String(value));
      const seats = identity?.seats ?? [];
      const remoteOk = identity?.remote === true;

      const chain = [
        { key: "chainBodySeat", ok: typeof useTabInfo === "function", detail: SEAT.tab },
        { key: "chainSessionsSeat", ok: typeof useSessions === "function", detail: `sessions=${show(sessionCount, "valueAbsent")}` },
        { key: "chainProjectionSeat", ok: typeof useProjection === "function", detail: `modelSelection=${show(currentModel, "valueAbsent")}` },
        {
          key: "chainTabRecord",
          ok: tabInfo !== undefined,
          detail: tabInfo === undefined ? t("valueAbsent") : `${tabInfo.panel?.id ?? "?"} / ${tabInfo.tab?.id ?? "?"}`,
        },
        { key: "chainRemote", ok: remoteOk, detail: remoteOk ? SERVICE_KEY : t("valueAbsent") },
      ];

      const body = [];
      if (tokenConfigured === false) {
        body.push(h(TokenGuide, { key: "guide", t }));
      } else if (phase === "loading") {
        body.push(h("p", { key: "loading", className: "tgk-state" }, t("stateLoading")));
      } else if (phase === "error") {
        body.push(h("p", { key: "error", className: "tgk-state tgk-stateError" }, errorText));
      } else if (projects.length === 0) {
        body.push(h("p", { key: "noproj", className: "tgk-state" }, t("stateNoProjects")));
      } else {
        body.push(
          h(ProjectSwitcher, {
            key: "switcher",
            t,
            projects,
            selected,
            refreshing,
            onSelect: (number) => {
              setSelected(number);
              loadBoard(number, false);
            },
            onReload: () => loadBoard(projectRef.current, false),
          }),
        );
        body.push(board === undefined || board === null ? h("p", { key: "emptyboard", className: "tgk-state" }, t("stateEmptyBoard")) : h(Board, { key: "board", t, board }));
      }

      return h(
        "section",
        { className: "tgk-root", "aria-label": t("panelTitle") },
        h(
          "header",
          { className: "tgk-head" },
          h("h2", { className: "tgk-title" }, t("panelTitle")),
          h("span", { className: "tgk-badge" }, t("phaseBadge")),
        ),
        h("p", { className: "tgk-lede" }, t("panelLede")),
        ...body,
        h(
          "dl",
          { className: "tgk-readings" },
          reading(t("readingSessions"), show(sessionCount, "valueAbsent")),
          reading(t("readingRunning"), show(runningCount, "valueAbsent")),
          reading(t("readingCurrent"), sessionId === undefined ? t("valueAbsent") : show(currentTitle, "valueUnnamed")),
          reading(t("readingModel"), show(currentModel, "valueAbsent")),
        ),
        h("h3", { className: "tgk-subhead" }, t("chainTitle")),
        h(
          "ul",
          { className: "tgk-chain" },
          ...chain.map((row) =>
            h(
              "li",
              { key: row.key, className: "tgk-chainRow" },
              h("span", { className: row.ok ? "tgk-dot tgk-dotOk" : "tgk-dot", "aria-hidden": "true" }),
              h("span", { className: "tgk-chainLabel" }, t(row.key)),
              h("code", { className: "tgk-chainDetail" }, row.detail),
            ),
          ),
        ),
        h("p", { className: "tgk-foot" }, t("footprint", { seats: seats.join(" + ") })),
        h("p", { className: "tgk-beat" }, t("beat", { count: beat })),
        h("p", { className: "tgk-next" }, t("nextHint")),
      );
    }

    /** tab chip 标题:面板活着时它自己会变(会话数),比静态标题更能证明 title 座位是活的。 */
    function GithubKanbanTitle(props) {
      const { useSessions, t } = props;
      const sessionsHook = typeof useSessions === "function" ? useSessions : noopSelector;
      const sessionCount = sessionsHook((state) => state?.ids?.length);
      return h(
        "span",
        { className: "tgk-chip" },
        h("span", { className: "tgk-chipText" }, t("tabTitle")),
        sessionCount === undefined ? null : h("span", { className: "tgk-chipCount" }, String(sessionCount)),
      );
    }

    // ─────────────────────────── 5. 注册 ───────────────────────────

    /**
     * 浏览器半边入口。
     * @param ctx 已装载 slots / locale / sidebarRightTabs / remote 的 Client Context
     */
    async function apply(ctx) {
      const dsh = createClientAdapter(ctx);
      dsh.registerDictionary({ zh, en });
      const t = ctx.locale.bind(NS);
      dsh.registerTabType({
        id: TAB_ID,
        kind: TAB_KIND,
        // 页面型:无 patterns,只能按 kind 打开,不参与资源地址路由。
        title: () => t("tabTitle"),
        // guide 条目 = 用户从右栏 guide 页打开本面板的入口。
        guide: [{ id: "board", order: 40, title: () => t("tabTitle"), description: () => t("tabDescription") }],
      });
      // 先挂远程面再注册座位:组件拿到的 boardApi 首次调用会等 mount 完成。
      const mountPromise = dsh.mountRemote();
      const boardApi = createBoardApi(mountPromise, ctx.remote);
      dsh.registerSeat(SEAT.tab, GithubKanbanBody, () => ({ identity: dsh.identity, board: boardApi }));
      dsh.registerSeat(SEAT.tabTitle, GithubKanbanTitle);
      // 失败不抛:面板会用结构化错误态呈现;这里只留一条可查的 Promise 链。
      mountPromise.catch(() => {});
    }

    /** 需要的客户端服务:座位注册、文案、tab 类型注册、remote 面。 */
    const inject = ["slots", "locale", "sidebarRightTabs", "remote"];

    return { apply, inject };
  },
});
