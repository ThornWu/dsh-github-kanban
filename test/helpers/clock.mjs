/**
 * 虚拟时钟(阶段 3 测试体系):可控的 setTimeout/setInterval/clearTimeout/clearInterval。
 *
 * 为什么自己写而不用 sinon 假定时器:本仓库零运行时依赖、测试选型「轻量优先」
 * (REMEDIATION_PLAN §6 / phase3.md 选型说明)。时钟只替换**插件可见的全局**
 * (lib/client.js 沙箱里的 setTimeout 系与 ctx.timeout/ctx.interval 替身),
 * React 与 react-dom 本体跑在真实实现上 —— 被 R06 点名要「真实」的部分
 * (hook 语义、effect cleanup、卸载行为)不经过任何替身,这里的替身只服务于
 * 时间维度(4s 自愈轮 / 30s 轮询 / 10s deadline),等价于 jest.useFakeTimers
 * 的作用面,且作用面更小(不碰 Date/performance/队列微任务)。
 *
 * 语义:advance(ms) 按到期时间升序逐个执行到期任务,每个任务执行后冲刷微任务
 * 链(让异步 bootstrap/重试链推进),可重入任务(interval)按周期重排。
 */
export function createVirtualClock() {
  let now = 0;
  let seq = 0;
  const tasks = new Map(); // id → { kind: "timeout"|"interval", fn, at, period? }

  const flushMicrotasks = async () => {
    // 真实定时器只用于让微任务链与 Promise 队列走完(每轮 macrotask 之间微任务全清)。
    for (let round = 0; round < 16; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const clock = {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      tasks.set(id, { kind: "timeout", fn, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    setInterval(fn, ms = 0) {
      const id = ++seq;
      const period = Math.max(1, Number(ms) || 1);
      tasks.set(id, { kind: "interval", fn, at: now + period, period });
      return id;
    },
    clearInterval(id) {
      tasks.delete(id);
    },
    /** 仍在册的定时器(观测「卸载后无遗留调度」用)。 */
    pending() {
      return [...tasks.values()].map((task) => ({ kind: task.kind, dueInMs: task.at - now }));
    },
    /** 推进虚拟时间:处理 (now, now+ms] 内到期的所有任务,期间每步冲刷微任务。 */
    async advance(ms) {
      const target = now + (Number(ms) || 0);
      for (;;) {
        let next;
        for (const [id, task] of tasks) {
          if (task.at > target) continue;
          if (next === undefined || task.at < tasks.get(next).at) next = id;
        }
        if (next === undefined) break;
        const task = tasks.get(next);
        now = Math.max(now, task.at);
        if (task.kind === "interval") task.at = now + task.period;
        else tasks.delete(next);
        task.fn();
        await flushMicrotasks();
      }
      now = Math.max(now, target);
    },
  };
  return clock;
}
