/**
 * 分发包内容检查(S3.6):npm pack --dry-run --json 的产物清单断言。
 *
 * 交付约束:浏览器单文件(lib/client.js 原样 <script>)+ 宿主入口 + patch + 文档。
 * 断言两层:
 *   1. 必须在包内(files 白名单生效);
 *   2. 开发/测试/笔记产物不得混入(test/、scripts/、notes/、package-lock 等)。
 * 本文件由 `npm run pack:check` 触发;CI 里同样跑(内容检查不依赖任何凭据)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("pack:check:npm pack --dry-run 的文件清单与交付白名单一致", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `npm pack --dry-run 失败:${result.stderr}`);
  const manifest = JSON.parse(result.stdout)[0];
  assert.equal(manifest.name, "@local/thorn-github-kanban");
  const files = manifest.files.map((file) => file.path).sort();

  const required = ["LICENSE", "README.md", "cordis.patch.yml", "lib/client.js", "lib/index.js", "package.json"];
  for (const path of required) assert.ok(files.includes(path), `分发包缺少 ${path}`);

  const forbiddenPrefixes = ["test/", "scripts/", "notes/", "review/", "memory/", "node_modules/", ".github/", ".zcode/"];
  const forbiddenExact = ["package-lock.json", "REMEDIATION_PLAN.md", "TODO.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"];
  const leaked = files.filter((path) => forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) || forbiddenExact.includes(path));
  assert.deepEqual(leaked, [], "开发与笔记产物不得进入分发包");

  // 单文件交付的核心断言:client.js 必须原样在包内(无构建产物/无转译副本)
  const client = manifest.files.find((file) => file.path === "lib/client.js");
  assert.ok(client.size > 30_000, `client.js 以完整源交付(当前 ${client.size} 字节,非桩非片段)`);
}, { timeout: 60_000 });
