/**
 * dsh-github-kanban · 宿主半边 —— Phase 1.1「最小服务骨架」。
 *
 * 定位:GitHub Projects(Projects v2)看板在宿主侧的唯一数据出口。
 * Phase 1.1 只注册服务骨架:不联网、不读 token、不声明远程面 ——
 * 目的是让「bundle patch → loader 行 → 宿主服务」这段链路先立起来。
 *
 * 隐私红线(执行守则 2):GitHub token 只走环境变量(如 DSH_GITHUB_TOKEN),
 * 永不进 git、日志或明文配置;本文件现阶段不读任何凭据。
 *
 * 浏览器如何调用宿主方法(Phase 1.2 起):不是加个 @Remote 就完事 ——
 * 需要 TypertRemoteService 子类 + 生成或手写的 typert 工件(见 notes/dev-notes.md 差异 3)。
 * 方案定下来之前,这里刻意不暴露任何远程面。
 */

/** 宿主服务键;Phase 1.2 起浏览器侧即 ctx.remote.<SERVICE_KEY>。 */
const SERVICE_KEY = "githubKanban";
/** 宿主半边身份(与 package.json 的 name 一致)。 */
const PACKAGE_ID = "@local/thorn-github-kanban";
/** 骨架版本,与 package.json 的 version 同步维护。 */
const VERSION = "0.1.0";

/** cordis 插件名(loader 行 id 与之配套)。 */
const name = "thorn-github-kanban";

/** 现阶段不依赖任何宿主服务;Phase 1.2 会加(定时器、存储之类)。 */
const inject = [];

/**
 * 宿主装载适配层(执行守则 3:dsh 是 rc,装载契约可能 breaking)。
 * 全插件只有这里接触 cordis 的宿主契约;dsh 升级时只改这一段。
 * @param ctx 宿主 Context
 * @returns 适配面:publishService / log
 */
function createHostAdapter(ctx) {
  if (typeof ctx?.provide !== "function") {
    throw new Error(
      `[${PACKAGE_ID}] 宿主装载契约不匹配:ctx.provide 不可用。` +
        "本插件按 cordis 4.x(Service 的 provide/set 分离)编写;" +
        "dsh 升级后请对照官方包源码更新 lib/index.js 的适配层。",
    );
  }
  return {
    /**
     * 注册宿主服务(key 即浏览器侧 ctx.remote 的名字空间)。
     * 服务寿命跟随本插件 fiber,卸载由 cordis 收回。
     */
    publishService(key, value) {
      ctx.provide(key, value);
      return key;
    },
    /** 结构化日志;ctx.logger 缺失时静默降级,不影响功能。 */
    log(level, message) {
      const logger = ctx.logger;
      if (logger !== undefined && typeof logger[level] === "function") {
        logger[level](`[${PACKAGE_ID}] ${message}`);
      }
    },
  };
}

/**
 * 看板服务骨架:Phase 1.1 只有身份与自描述,没有任何 GitHub 调用。
 * @param config cordis.patch.yml 传入的 config 段
 */
function createBoardService(config) {
  return {
    key: SERVICE_KEY,
    version: VERSION,
    /** 自描述:Phase 1.2 会在这里报告 token 是否就绪、当前项目等。 */
    describe() {
      return {
        key: SERVICE_KEY,
        version: VERSION,
        stage: "skeleton",
        configKeys: Object.keys(config ?? {}),
      };
    },
  };
}

/**
 * 插件入口。
 * @param ctx 宿主 Context
 * @param config bundle patch 的 config 段
 */
function apply(ctx, config) {
  const host = createHostAdapter(ctx);
  host.publishService(SERVICE_KEY, createBoardService(config));
  host.log("info", `宿主服务 ${SERVICE_KEY} 已注册(v${VERSION},骨架阶段,无远程面)`);
}

const Config = undefined;

export { Config, apply, inject, name };
