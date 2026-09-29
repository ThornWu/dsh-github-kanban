/**
 * dsh-github-kanban · 浏览器半边 —— Phase 1.1「hello 面板」。
 *
 * 装载契约(dsh 0.2.0-rc.1,依据 @deepseek-ai/dsh-client-modules 源码):
 *   1. 本文件被 dsh 按原样当 <script> 提供:不打包、不转译;执行时只注册工厂(零副作用),
 *      样式注入等动作都发生在 factory 物化时。
 *   2. require 只能命中平台 seed 词(react / react-dom / react/jsx-runtime / @deepseek-ai/cordis /
 *      dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit)
 *      或已装载插件的包名 —— 相对路径不可用,所以适配层必须和组件同处一个文件。
 *   3. 注册的 id 必须等于 package.json 的 name,否则加载器报 "loaded without registering"。
 *
 * 本面板 Phase 1.1 只做一件事:证明「宿主半边 → 浏览器半边 → 右栏 tab → 内容随投影变化」这条链路。
 * 不含任何网络调用、token 或 GitHub 数据(那是 Phase 1.2)。
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

    // ─────────────────────────── 1. dsh 客户端适配层 ───────────────────────────
    // 执行守则 3:dsh 是 rc,装载/座位 API 可能 breaking。全插件只有这一节接触 dsh 的
    // 装载与座位契约(座位注册、tab 类型注册、文案注册、样式归属);组件只吃 props。
    // dsh 升级时改这一节,组件与数据流不动。

    /** 右栏座位:body 与 chip 标题是同一套 keyed 派发(按 tab 类型的 id)。 */
    const SEAT = {
      tab: "sidebar.right.pane.tab",
      tabTitle: "sidebar.right.pane.tab.title",
    };

    /**
     * 注入样式标签:带 plugin / plugin-css 归属,框架按插件认领并在卸载、HMR 时清理。
     * @param tagId 本插件内唯一的样式标签 id
     * @param css 样式文本
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

    /**
     * 校验装载契约并返回适配面。契约缺失就当场大声报错(fiber 失败可见),
     * 而不是静默不注册 —— 静默失败在 rc 期最难查。
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
      return {
        /** 适配层身份快照:面板的自检区直接读它,插件占位一目了然。 */
        identity: {
          packageId: PACKAGE_ID,
          ns: NS,
          tabId: TAB_ID,
          tabKind: TAB_KIND,
          seats: [SEAT.tab, SEAT.tabTitle],
        },
        /**
         * 注册文案字典(zh 为键源,en 逐键对照)。
         * @param dicts { zh, en }
         */
        registerDictionary(dicts) {
          return ctx.effect(() => ctx.locale.register(NS, dicts), `${PACKAGE_ID}: dictionaries`);
        },
        /**
         * 注册 tab 类型:keyed 座位只对**已注册**的类型派发 body 与标题;
         * 先注册类型再注册座位,是这个座位的硬顺序要求。
         * @param definition SidebarRightTabDefinition(id / kind / title / guide ...)
         */
        registerTabType(definition) {
          return ctx.effect(() => ctx.sidebarRightTabs.register(definition), `${PACKAGE_ID}: ${TAB_KIND} tab type`);
        },
        /**
         * 把一个组件挂到座位;keyed 座位用 `key`(= tab 类型的 id),不是 `id`。
         * @param seat 座位名
         * @param Component 组件
         * @param inject 可选:本座位的注入面工厂
         */
        registerSeat(seat, Component, inject) {
          const options = { name: seat, key: TAB_ID, locale: NS, registrant: PACKAGE_ID };
          if (inject !== undefined) options.inject = inject;
          return ctx.slots.inject(seat, () => ctx.slots.register(options, Component));
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
      tabDescription: "GitHub Projects 看板(Phase 1.1:加载链路验证面板)",
      panelTitle: "GitHub Projects 看板",
      phaseBadge: "hello 面板",
      panelLede: "Phase 1.1 脚手架:此处只验证加载链路与投影数据流,尚未接入 GitHub。",
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
      footprint: "本插件占位:{seats}",
      beat: "渲染节拍 {count}(每秒 +1,证明面板是活的)",
      nextHint: "下一步:Phase 1.2 接入 Projects v2 读链路(token 走 DSH_GITHUB_TOKEN)。",
    };

    /** English,逐键对照。 */
    const en = {
      tabTitle: "GitHub Board",
      tabDescription: "GitHub Projects board (Phase 1.1: load-path probe panel)",
      panelTitle: "GitHub Projects board",
      phaseBadge: "hello panel",
      panelLede: "Phase 1.1 scaffold: this panel only proves the load path and the projection data flow; GitHub is not wired yet.",
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
      footprint: "Plugin footprint: {seats}",
      beat: "Render beat {count} (+1 every second — the panel is live)",
      nextHint: "Next: Phase 1.2 wires the Projects v2 read path (token via DSH_GITHUB_TOKEN).",
    };

    // ─────────────────────────── 3. 组件 ───────────────────────────

    /**
     * 缺席座位 hook 的固定替身:座位 hook 由框架注入,rc 期哪个缺了都不该把面板打崩。
     * 用替身而不是条件调用,保证 hook 调用数目恒定(React 规则),缺哪个就在自检里红一个。
     */
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

    /**
     * hello 面板 body。props 全部来自框架座位:
     *   useTabInfo  —— 座位级 hook(父级注入):本 tab 的面板与记录信息
     *   sessionId / useSessions / useProjection —— ui-session 注入的标准 props(会话与投影读数)
     *   identity    —— 本插件适配层的身份快照(本插件 inject 面)
     *   t           —— 本插件命名空间的翻译
     */
    function GithubKanbanBody(props) {
      const { useTabInfo, useSessions, useProjection, sessionId, identity, t } = props;

      const tabInfoHook = typeof useTabInfo === "function" ? useTabInfo : noopTabInfo;
      const sessionsHook = typeof useSessions === "function" ? useSessions : noopSelector;
      const projectionHook = typeof useProjection === "function" ? useProjection : noopProjection;

      // ── 投影读数:宿主算好推给客户端,这里只读,不做任何折叠 ──
      const tabInfo = tabInfoHook();
      const sessionCount = sessionsHook((state) => state?.ids?.length);
      const runningCount = sessionsHook((state) => (state?.ids ?? []).filter((id) => state?.byId?.[id]?.running === true).length);
      const currentTitle = sessionsHook((state) => (sessionId === undefined ? undefined : state?.byId?.[sessionId]?.displayTitle));
      const currentModel = projectionHook("modelSelection", (value) => value?.next?.model);

      // 渲染节拍:证明面板是活的(Phase 1.3 的轮询刷新到位前,先用它当"内容会变"的兜底证据)。
      const [beat, setBeat] = react.useState(0);
      react.useEffect(() => {
        const timer = setInterval(() => setBeat((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, []);

      const show = (value, fallback) => (value === undefined || value === null ? t(fallback) : String(value));
      const seats = identity?.seats ?? [];

      const chain = [
        { key: "chainBodySeat", ok: typeof useTabInfo === "function", detail: SEAT.tab },
        { key: "chainSessionsSeat", ok: typeof useSessions === "function", detail: `sessions=${show(sessionCount, "valueAbsent")}` },
        { key: "chainProjectionSeat", ok: typeof useProjection === "function", detail: `modelSelection=${show(currentModel, "valueAbsent")}` },
        {
          key: "chainTabRecord",
          ok: tabInfo !== undefined,
          detail: tabInfo === undefined ? t("valueAbsent") : `${tabInfo.panel?.id ?? "?"} / ${tabInfo.tab?.id ?? "?"}`,
        },
      ];

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

    /**
     * tab chip 标题:面板活着时它自己会变(会话数),比静态标题更能证明 title 座位是活的。
     */
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

    // ─────────────────────────── 4. 注册 ───────────────────────────

    /**
     * 浏览器半边入口。
     * @param ctx 已装载 slots / locale / sidebarRightTabs 的 Client Context
     */
    function apply(ctx) {
      const dsh = createClientAdapter(ctx);
      dsh.registerDictionary({ zh, en });
      const t = ctx.locale.bind(NS);
      dsh.registerTabType({
        id: TAB_ID,
        kind: TAB_KIND,
        // 页面型:无 patterns,只能按 kind 打开,不参与资源地址路由。
        title: () => t("tabTitle"),
        // guide 条目 = 用户从右栏 guide 页打开本面板的入口(1.1 的验证入口)。
        guide: [{ id: "board", order: 40, title: () => t("tabTitle"), description: () => t("tabDescription") }],
      });
      dsh.registerSeat(SEAT.tab, GithubKanbanBody, () => ({ identity: dsh.identity }));
      dsh.registerSeat(SEAT.tabTitle, GithubKanbanTitle);
    }

    /** 需要的客户端服务:座位注册、文案、tab 类型注册。 */
    const inject = ["slots", "locale", "sidebarRightTabs"];

    return { apply, inject };
  },
});
