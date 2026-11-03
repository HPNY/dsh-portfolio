// 测试总入口。
//
// **为什么需要这个文件**：`package.json` 原来把各套件用 `&&` 串起来，于是
// 「前一个失败 → 后面全部不执行」。上游既存的 p1-f10-longhu-test.mjs 是个日期脆性
// 测试（会随真实日期过期），它一旦变红就会**静默跳过**它之后的所有套件 ——
// 包括本插件新增的三个场外基金套件。也就是说：`npm test` 绿不绿，取决于那个
// 脆性测试当天的心情，而被跳过的套件没有任何提示。
//
// 这里改成自己串行跑完**每一个**套件、逐个报告，最后统一给结论：
//   - 全部通过 → 退出码 0
//   - 有任何失败 → 退出码 1，并列出失败清单
// 单个套件失败不会阻止其余套件执行。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 已知的、与本插件无关的上游缺陷套件：失败时只警告，不计入失败退出码。 */
const KNOWN_UPSTREAM_RED = new Set(["p1-f10-longhu-test.mjs"]);

const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const suites = String(pkg.scripts?.["test:suites"] ?? "")
	.split(/\s+/)
	.map((s) => s.trim())
	.filter((s) => s !== "" && s !== "node" && s.endsWith(".mjs"));

if (suites.length === 0) {
	console.error("✗ 没有解析到任何测试套件（检查 package.json 的 test:suites）");
	process.exit(1);
}

const failed = [];
const knownRed = [];
const started = Date.now();

for (const suite of suites) {
	const t0 = Date.now();
	// 直接跑文件本身，不复用 npm：避免多一层 shell 与 `&&` 语义。
	const result = spawnSync(process.execPath, [suite], { cwd: here, stdio: "pipe", encoding: "utf8" });
	const ms = Date.now() - t0;
	const okRun = result.status === 0;

	if (okRun) {
		console.log(`  PASS  ${suite}  (${ms}ms)`);
		continue;
	}

	if (KNOWN_UPSTREAM_RED.has(suite)) {
		knownRed.push(suite);
		console.log(`  KNOWN-RED  ${suite}  (${ms}ms)  ← 上游既存缺陷，不计入失败`);
		continue;
	}

	failed.push(suite);
	console.log(`  FAIL  ${suite}  (${ms}ms)`);
	// 把失败套件的尾部输出打出来，不用再单独跑一遍
	const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd().split("\n").slice(-25).join("\n");
	if (tail !== "") console.log(tail.replace(/^/gm, "        "));
}

const total = suites.length;
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log("");
console.log(`共 ${total} 个套件，通过 ${total - failed.length - knownRed.length}，失败 ${failed.length}` + (knownRed.length > 0 ? `，已知上游缺陷 ${knownRed.length}` : "") + `，用时 ${secs}s`);

if (knownRed.length > 0) {
	console.log("");
	console.log("已知上游缺陷（非本次改造引入，已用纯净上游复现）：");
	for (const suite of knownRed) {
		console.log(`  - ${suite}：龙虎榜缺省日期 fixture 固定在 2026-10-09，已过期，回溯窗口内无数据即 502。`);
	}
}

if (failed.length > 0) {
	console.log("");
	console.log(`✗ 失败套件：${failed.join(", ")}`);
	process.exit(1);
}

console.log("");
console.log("✓ 全部通过");
