/**
 * 语法/静态检查(测试体系内):仓库全部 JS/MJS 源过一遍 `node --check`。
 *
 * npm run lint 覆盖交付物(lib/ 两文件,与阶段 1/2 的先例命令一致);本套件把
 * 检查面扩到 scripts/ 与 test/ 自身 —— 任何文件引入语法错误,测试即红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** 递归收集目录下(不含 node_modules)的 .js/.mjs 文件。 */
const collect = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) out.push(full);
  }
  return out.sort();
};

const targets = [...collect(join(repoRoot, "lib")), ...collect(join(repoRoot, "scripts")), ...collect(join(repoRoot, "test"))];

test(`语法检查:${targets.length} 个 JS/MJS 源文件全部通过 node --check`, () => {
  assert.ok(targets.length >= 8, `收集到足够文件(lib/scripts/test):${targets.length}`);
  const broken = [];
  for (const file of targets) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) broken.push(`${file.replace(repoRoot, "")}: ${(result.stderr || "").split("\n")[0]}`);
  }
  assert.deepEqual(broken, [], "全部文件语法检查通过");
});
