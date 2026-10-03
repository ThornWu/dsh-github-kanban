/**
 * 断言助手(阶段 3):vm 沙箱跨 realm 结构比较。
 *
 * lib/client.js 在 vm.runInNewContext 里物化(忠实还原浏览器装载形态),其内部
 * 产生的对象/数组的原型属于**另一个 realm** —— assert.deepStrictEqual 会因原型
 * 身份不同而拒绝内容完全相等的结构。jsonEqual 先过 JSON(内容语义,丢原型)再
 * 严格比较,既保持严格值比较又不受 realm 影响。
 */
import assert from "node:assert/strict";

export const jsonEqual = (actual, expected, message) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);

export { assert };
