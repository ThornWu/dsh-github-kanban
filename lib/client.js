/**
 * dsh-github-kanban · 浏览器半边 —— Phase 1.4「左侧全局面板」。
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
    /** 全局面板 id:sidebar.panellist 的入口 id 与 main 座位的 key 用同一值(与 schedule 的 PANEL_ID 同型)。 */
    const PANEL_ID = "github-kanban";
    /** panellist 排序:排在 Automation tasks(order 10)之后。 */
    const PANEL_ORDER = 20;
    /** 宿主远程服务键(与 lib/index.js 的 SERVICE_KEY 一致)。 */
    const SERVICE_KEY = "githubKanban";
    /** 轮询间隔(TODO 1.3:每 30s 重拉看板;数据变化走既有 setState 更新链,非整页重建)。 */
    const POLL_INTERVAL_MS = 30000;

    // ─────────────────────────── 1. dsh 客户端适配层 ───────────────────────────
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
     *     未选中即整体卸载,轮询 effect 随 cleanup 停止,不依赖本探针;
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

    // ─────────────────────────── 2. 文案 ───────────────────────────

    /** 简体中文(键源)。 */
    const zh = {
      tabTitle: "GitHub 看板",
      panelTitle: "GitHub Projects 看板",
      phaseBadge: "只读",
      panelLede: "数据来自 GitHub Projects v2,列序 = Status 选项序;改动暂不写回(Phase 2)。",
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
      statusHintRenamed: "未找到名为「Status」的单选字段,但项目里有其他单选字段(可能已被改名),看板暂以单列「全部」展示。",
      statusHintTruncated: "字段数达到单页上限(40),「Status」字段可能未被加载,看板暂以单列「全部」展示。",
      contentMissingHint: "有 {count} 张卡读不到标题/链接:token 缺 Issues / Pull requests 读权限。去 GitHub 编辑这个 fine-grained PAT,给相关仓库勾上 Issues 与 Pull requests 的 Read-only 即可;token 值不变,权限保存后下轮刷新生效。",
      boardTotalCount: "共 {count} 张卡",
      boardTruncated: "已加载 {fetched} / {total} 张(超出单次拉取上限,看板可能不完整)",
      columnCount: "{count}",
      columnEmpty: "空",
    };

    /** English,逐键对照。 */
    const en = {
      tabTitle: "GitHub Board",
      panelTitle: "GitHub Projects board",
      phaseBadge: "read-only",
      panelLede: "Data comes from GitHub Projects v2; column order = Status option order. Writes land in Phase 2.",
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
      statusHintRenamed: "No single-select field named \"Status\" was found, but other single-select fields exist (it may have been renamed); the board falls back to a single \"All\" column.",
      statusHintTruncated: "The field list hit the page cap (40); the \"Status\" field may not be loaded. The board falls back to a single \"All\" column.",
      contentMissingHint: "{count} cards show no title/link: the token lacks Issues / Pull requests read access. Edit this fine-grained PAT on GitHub and grant Issues and Pull requests Read-only for the repos; the token value stays the same and the next refresh picks it up.",
      boardTotalCount: "{count} cards in total",
      boardTruncated: "Loaded {fetched} / {total} cards (over the fetch cap; the board may be incomplete)",
      columnCount: "{count}",
      columnEmpty: "empty",
    };

    // ─────────────────────────── 3. 数据流(boardApi 与加载状态机) ───────────────────────────

    /** 统一的结构化失败形状(与宿主 boardError 对齐)。 */
    const failed = (code, message) => ({ ok: false, error: { code, message } });

    // ─── 本地快照(0.5.0 提速):localStorage 乐观首屏 ───
    // 重开面板先用上次数据秒开,真数据回来逐项覆盖;读写全防御(隐私模式/配额/沙箱无
    // localStorage 均静默降级)。快照只含看板业务数据(公开元数据),token 永不出宿主。

    /** localStorage 键(带版本号,形状升级直接作废旧键)。 */
    const SNAPSHOT_KEY = `${PACKAGE_ID}/snapshot/v1`;

    function readSnapshot() {
      try {
        const raw = localStorage.getItem(SNAPSHOT_KEY);
        if (typeof raw !== "string") return null;
        const data = JSON.parse(raw);
        if (data === null || typeof data !== "object" || !Array.isArray(data.projects)) return null;
        if (data.board !== undefined && data.board !== null && (typeof data.board !== "object" || !Array.isArray(data.board.columns))) return null;
        return data;
      } catch {
        return null;
      }
    }

    function writeSnapshot(snapshot) {
      try {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
      } catch {
        // 写失败静默:快照是纯优化,不是功能依赖
      }
    }

    /**
     * 组件的数据出口:等 $mount 完成后,调 scoped fiber 里捕获的 remote.githubKanban 面。
     * RemoteError 与任何意外都折叠成结构化失败;组件不见异常、不见凭据。
     * inject 依据:cordis ReflectService 的 traceable get trap 对 "remote.githubKanban"
     * 这类嵌套 accessor 要求**调用方 fiber** 的 inject 清单含全名,否则抛
     * "cannot get property ... without inject"。该全名只进 apply 里
     * ctx.inject(["remote.githubKanban"], …) 的 scoped fiber(见下方死锁注记),
     * 面在 fiber 里捕获一次,之后的方法调用是普通 JS 引用,不再过 ctx 代理。
     * @param mountPromise 适配层 mountRemote() 的 promise
     * @param facePromise scoped fiber 捕获的 remote.githubKanban 面(拒绝/缺席降级成错误态)
     */
    function createBoardApi(mountPromise, facePromise) {
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
        let face;
        try {
          face = await facePromise;
        } catch (cause) {
          return failed("remote_missing", cause instanceof Error ? cause.message : String(cause));
        }
        if (face === undefined || typeof face[method] !== "function") {
          return failed("remote_missing", `远程面缺少 ${SERVICE_KEY}.${method}。`);
        }
        try {
          const raw = await face[method](...(args === undefined ? [] : [args]));
          // 网关 direct 调用的返回是信封:成功 {ok:true, value:<业务结果>} / 失败 {ok:false, error}
          // (rc.2 实测:官方插件不消费 direct 返回值,信封没人拆;本包业务结果从不带 value 键,借此拆包)。
          const result = raw !== null && typeof raw === "object" && raw.ok === true && "value" in raw ? raw.value : raw;
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
     * 选中键:仓归属 + 编号复合(同一编号在不同 owner 域会撞,用户级与仓级同 id 只留一份)。
     * 用户级项目(无 repo)键为 "#N",仓库级为 "owner/name#N"。
     */
    function projectKey(project) {
      return `${project.repo ?? ""}#${project.number}`;
    }

    /**
     * 瞬态失败判定:RPC 载波未就绪/服务正在启动或重启的窗口期失败 ——
     * gateway 把载波失败折成 gateway/internal,浏览器侧 fetch 抛 "Failed to fetch"。
     * 这类错误重试即自愈,不该把面板钉死在错误态(2026-10-01 真机:dsh 每次重启都会出现)。
     */
    function isTransientFailure(result) {
      return result?.ok !== true && (result?.error?.code === "gateway/internal" || String(result?.error?.message ?? "").includes("Failed to fetch"));
    }

    /** 项目切换器 + 刷新按钮。 */
    function ProjectSwitcher(props) {
      const { t, projects, selected, onSelect, onReload, refreshing } = props;
      // selected 不在当前列表(如刷新后项目被删)时回退空值,
      // 并插入一个禁用的占位 option 提示「项目已不可用」,不可被选中。
      const matched = projects.some((project) => projectKey(project) === selected);
      const placeholder = matched
        ? null
        : h("option", { key: "__gone__", value: "", disabled: true }, t("switcherProjectGone"));
      return h(
        "div",
        { className: "tgk-toolbar" },
        h("label", { className: "tgk-lede", htmlFor: "tgk-project-select" }, t("toolbarProject")),
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
     *   board —— createBoardApi 的数据出口(缺席则降级);t —— 本插件命名空间的翻译
     */
    function GithubKanbanBody(props) {
      const { board: boardApi, t, polling } = props;

      // ── 看板加载状态机:idle → status → projects → board ──
      const [phase, setPhase] = react.useState("idle"); // idle|loading|ready|error
      const [tokenConfigured, setTokenConfigured] = react.useState(undefined);
      const [projects, setProjects] = react.useState([]);
      const [selected, setSelected] = react.useState(null); // 选中键 projectKey(project);null=未选
      const [board, setBoard] = react.useState(undefined); // undefined=未拉取, null=空, object=数据
      const [errorText, setErrorText] = react.useState("");
      const [refreshing, setRefreshing] = react.useState(false);
      const [totalCount, setTotalCount] = react.useState(undefined); // 宿主 totalCount(服务端全量口径);缺席时 UI 退回列合计
      const [transient, setTransient] = react.useState(false); // 错误是否属连接未就绪类(可自动重试自愈)
      const [retryCount, setRetryCount] = react.useState(0); // 错误态自动重试轮数(成功清零,15 轮封顶)
      const projectRef = react.useRef(null); // 当前选中项目对象(轮询/刷新取 number+repo 用)
      projectRef.current = projects.find((project) => projectKey(project) === selected) ?? null;
      const inFlightRef = react.useRef(false); // 轮询节流:上一轮请求未回时不叠发
      const panelRef = react.useRef(null); // 面板根节点:可见性探针用
      const paintedRef = react.useRef(false); // 乐观首屏只画一次(重试轮不重画)
      const snapshotKeyRef = react.useRef(null); // 快照选中键(bootstrap 后续轮次要用)
      const disposedRef = react.useRef(false); // 卸载标记:重试链在各 await 后检查

      // 请求序守卫:发请求时取号,回包时对号;号已过期(期间又发起过请求)就整体丢弃,
      // 防止快速切换项目时慢的旧响应覆盖新项目的看板。
      const loadSeqRef = react.useRef(0);
      const loadBoard = react.useCallback(async (project, options = {}) => {
        if (boardApi === undefined || boardApi === null) return;
        const projectNumber = Number(project?.number);
        if (!Number.isInteger(projectNumber) || projectNumber <= 0) return; // 无有效项目时不发起请求
        const seq = ++loadSeqRef.current;
        inFlightRef.current = true;
        setRefreshing(true);
        setErrorText("");
        // repo 只在仓归属项目上带(用户级不带 undefined 键,wire 面保持旧形状);
        // noCache 由刷新按钮传:绕过宿主 TTL 缓存强制真拉(刷新语义)。
        const result = await boardApi.getBoard({
          projectNumber,
          ...(typeof project?.repo === "string" && project.repo.length > 0 ? { repo: project.repo } : {}),
          ...(options.noCache === true ? { noCache: true } : {}),
        });
        if (seq !== loadSeqRef.current) return; // 过期响应:不碰任何状态(inFlight 归最新请求复位)
        inFlightRef.current = false;
        setRefreshing(false);
        if (result.ok === true) {
          setBoard(result.board);
          setTotalCount(Number.isInteger(result.totalCount) ? result.totalCount : undefined);
          setPhase("ready");
        } else {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: [${result.error?.code}] ${result.error?.message ?? ""}`);
        }
      }, [boardApi, t]);

      react.useEffect(() => {
        disposedRef.current = false;
        return () => {
          disposedRef.current = true;
        };
      }, []);

      /**
       * 初始装载链:乐观首屏(仅首轮)→ status+list 并行(瞬态失败链内退避重试)→ 拉看板。
       * 抽成回调供两处复用:初次挂载,以及错误态下瞬态失败的自动重试(见下)。
       */
      const bootstrap = react.useCallback(async () => {
        if (boardApi === undefined || boardApi === null) {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: board api unavailable`);
          return;
        }
        // 乐观首屏:本地快照先上屏(重开面板秒出旧数据),真数据回来逐项覆盖。
        // 只在首轮画一次:重试轮再画会拿旧快照覆盖正在恢复的状态。
        if (paintedRef.current !== true) {
          paintedRef.current = true;
          const snapshot = readSnapshot();
          if (snapshot !== null) {
            setProjects(snapshot.projects);
            if (typeof snapshot.selectedKey === "string") {
              setSelected(snapshot.selectedKey);
              snapshotKeyRef.current = snapshot.selectedKey;
            }
            if (snapshot.board !== undefined && snapshot.board !== null) {
              setBoard(snapshot.board);
              setTotalCount(Number.isInteger(snapshot.totalCount) ? snapshot.totalCount : undefined);
            }
            setTokenConfigured(true);
            setPhase(snapshot.board === undefined || snapshot.board === null ? "loading" : "ready");
          }
        }
        setPhase("loading");
        // status 与 listProjects 并行(0.5.0 提速);瞬态失败(连接未就绪)链内退避重试
        // —— dsh 刚启动/刚重启时页面常比 RPC 载波先醒,一次失败不代表真故障。
        let status;
        let list;
        for (let attempt = 0; ; attempt += 1) {
          [status, list] = await Promise.all([boardApi.status(), boardApi.listProjects()]);
          if (disposedRef.current) return;
          const retryable = isTransientFailure(status) || isTransientFailure(list);
          if (!retryable || attempt >= 4) break;
          await new Promise((resolve) => setTimeout(resolve, 600 + attempt * 500));
          if (disposedRef.current) return;
        }
        if (status.ok !== true) {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: [${status.error?.code}] ${status.error?.message ?? ""}`);
          setTransient(isTransientFailure(status));
          return;
        }
        setRetryCount(0);
        setTokenConfigured(status.status?.tokenConfigured === true);
        if (status.status?.tokenConfigured !== true) {
          setPhase("ready");
          return;
        }
        if (list.ok !== true) {
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: [${list.error?.code}] ${list.error?.message ?? ""}`);
          setTransient(isTransientFailure(list));
          return;
        }
        setProjects(list.projects);
        if (list.projects.length === 0) {
          setPhase("ready");
          return;
        }
        // 快照选中的项目还在列表里就保持选择,否则回退第一个
        const target = list.projects.find((project) => projectKey(project) === snapshotKeyRef.current) ?? list.projects[0] ?? null;
        setSelected(target === null ? null : projectKey(target));
        // phase 完全交给 loadBoard 的成功/失败分支管理(成功 ready、失败 error),
        // 这里不再兜底置 ready —— 否则会覆盖失败分支已置的 error,把 401 展示成空板。
        await loadBoard(target);
      }, [boardApi, t, loadBoard]);

      // ref 转发调用:效果的依赖只剩稳定值(boardApi/基本类型状态),避免回调身份
      // 变化导致装载链被反复触发(mini-React 替身与真机对此都更稳)。
      const bootstrapRef = react.useRef(bootstrap);
      bootstrapRef.current = bootstrap;

      react.useEffect(() => {
        bootstrapRef.current().catch((cause) => {
          if (disposedRef.current) return;
          setPhase("error");
          setErrorText(`${t("errorPrefix")}: ${cause instanceof Error ? cause.message : String(cause)}`);
          setTransient(String(cause instanceof Error ? cause.message : String(cause)).includes("Failed to fetch"));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 初次挂载拉一次;后续切换/刷新/自动重试走显式回调
      }, [boardApi]);

      // 瞬态错误自愈:错误态且属连接类失败时,4s 后自动重跑 bootstrap(15 轮上限 ≈ 1 分钟),
      // 之后停在错误态等用户手动刷新 —— 服务真没了就别空转。
      react.useEffect(() => {
        if (phase !== "error" || transient !== true || retryCount >= 15) return undefined;
        const timer = setTimeout(() => {
          setRetryCount((count) => count + 1);
          bootstrapRef.current().catch(() => {});
        }, 4000);
        return () => clearTimeout(timer);
      }, [phase, transient, retryCount]);

      // 快照写回:列表+看板都到手后存一份(纯优化;token 永不出宿主,快照不含凭据)
      react.useEffect(() => {
        if (projects.length === 0 || board === undefined || board === null) return;
        writeSnapshot({ savedAt: Date.now(), projects, selectedKey: selected, board, totalCount });
      }, [projects, selected, board, totalCount]);

      // ── 轮询刷新(TODO 1.3):30s 重拉当前项目,新数据经既有 setState 链路进面板 ──
      // 不可见(右栏折叠 / 页面后台)时跳过本轮 = 暂停;回到可见后下一 tick 恢复。
      // 上一轮请求未回(inFlight)也跳过,避免慢响应下叠发。polling 缺席(旧 props/自检替身)则不轮询。
      react.useEffect(() => {
        if (polling === undefined || polling === null) return undefined;
        if (tokenConfigured !== true || projects.length === 0) return undefined;
        const dispose = polling.setInterval(() => {
          if (inFlightRef.current === true) return;
          const target = projectRef.current;
          if (target === null || target === undefined) return;
          if (polling.isVisible(panelRef.current) !== true) return;
          loadBoard(target);
        }, polling.intervalMs);
        return () => {
          if (typeof dispose === "function") dispose();
        };
      }, [polling, tokenConfigured, projects.length, loadBoard]);

      // 工具栏保留口径(R4 遗留 P2 修复):只要项目列表已知(token 已配且拉到过项目),
      // 切换器与刷新按钮在任何 phase(含 error / loading)都可见可操作;
      // 错误段不再整体替换工具栏。
      const visibleCount = board === undefined || board === null
        ? 0
        : (Array.isArray(board.columns) ? board.columns : []).reduce((sum, column) => sum + (Array.isArray(column?.items) ? column.items.length : 0), 0);
      const totalDisplay = Number.isInteger(totalCount) && totalCount >= visibleCount ? totalCount : visibleCount;
      const truncated = Number.isInteger(totalCount) && totalCount > visibleCount;
      const statusHintKey = board !== undefined && board !== null && board.hasStatusField === false
        ? { not_found: "statusHintNotFound", possibly_renamed: "statusHintRenamed", fields_truncated: "statusHintTruncated" }[board.statusFieldHint]
        : undefined;

      const body = [];
      if (tokenConfigured === false) {
        body.push(h(TokenGuide, { key: "guide", t }));
      } else if (phase === "loading" && board === undefined && projects.length === 0) {
        body.push(h("p", { key: "loading", className: "tgk-state" }, t("stateLoading")));
      } else {
        if (projects.length > 0) {
          body.push(
            h(ProjectSwitcher, {
              key: "switcher",
              t,
              projects,
              selected,
              refreshing,
              onSelect: (key) => {
                // 宽容语义:选中照设(失配时切换器回退占位提示),loadBoard 只在找到项目时发起
                setSelected(key);
                const project = projects.find((candidate) => projectKey(candidate) === key) ?? null;
                if (project !== null) loadBoard(project);
              },
              onReload: () => loadBoard(projectRef.current, { noCache: true }),
            }),
          );
        }
        if (phase === "error") {
          body.push(h("p", { key: "error", className: "tgk-state tgk-stateError" }, errorText));
          if (transient === true) body.push(h("p", { key: "retryhint", className: "tgk-state" }, t("connRetryHint")));
        } else if (projects.length === 0) {
          body.push(h("p", { key: "noproj", className: "tgk-state" }, t("stateNoProjects")));
        } else {
          if (statusHintKey !== undefined) body.push(h("p", { key: "statushint", className: "tgk-state" }, t(statusHintKey)));
          if (Number.isInteger(board?.contentMissing) && board.contentMissing > 0) {
            body.push(h("p", { key: "contentmissing", className: "tgk-state tgk-stateError" }, t("contentMissingHint", { count: board.contentMissing })));
          }
          if (board !== undefined && board !== null) {
            body.push(h("p", { key: "total", className: "tgk-total" }, t("boardTotalCount", { count: totalDisplay })));
            if (truncated) body.push(h("p", { key: "trunc", className: "tgk-total" }, t("boardTruncated", { fetched: visibleCount, total: totalCount })));
          }
          body.push(board === undefined || board === null ? h("p", { key: "emptyboard", className: "tgk-state" }, phase === "loading" ? t("stateLoading") : t("stateEmptyBoard")) : h(Board, { key: "board", t, board }));
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

    // ─────────────────────────── 5. 注册 ───────────────────────────

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
      const boardApi = createBoardApi(mountPromise, facePromise);
      // 轮询面(TODO 1.3):间隔用宿主 timer Service(插件声明 inject: ["timer"],
      // client runner 内建同 API 实现);缺席时退回全局 setInterval,rc 期双保险。
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

    return { apply, inject };
  },
});
