import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// 回归测试：cached() 的 name 不能漏。
//
// 背景（真实缺陷，0.20.0 引入、0.26.1 发现）：`searchFundSuggest` 与
// `fetchFundPositions` 调 cached({...}) 时没传 name，于是 cached() 里
// `registry.get(undefined)` 恒为 undefined，`createCache(undefined)` 建出一个
// **名为 "undefined" 的公共缓存实例**——两个完全无关的取数链共用同一个 Map：
// max 上限互相挤占、LRU 互相淘汰、命中率统计混在一起，而 /api/leekbox/health
// 的 caches 里只出现一个 "undefined" 键，看不出是谁。
// 现场证据：health 响应里 caches.undefined 存在，且其 size 增长同时受两条链影响。
//
// 本测试两层兜底：
//   1. 源码级：扫描全仓库的 cached({...}) 调用，要求每处都显式给了 name（字符串字面量）；
//   2. 运行级：真调 cached() 不带 name，必须抛 TypeError 而不是静默建出公共实例。

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
	if (ok) {
		pass += 1;
		console.log(`PASS  ${name}`);
	} else {
		fail += 1;
		console.log(`FAIL  ${name}${detail === undefined ? "" : "  — " + detail}`);
	}
}

//#region 1. 源码级扫描：每个 cached({...}) 调用都必须有 name

const SCAN_DIRS = ["lib", "src/client"];
const SCAN_ROOT_FILES = readdirSync(".").filter((f) => f.endsWith(".mjs") && f !== "run-tests.mjs" && !f.endsWith("-test.mjs"));

/**
 * 从 `cached({` 的位置起，取出这个对象字面量的顶层 `name` 值。
 * 只做浅层扫描（不解析嵌套对象/字符串内容里的 `name:`），对本仓库够用：
 * 需要检查的都是字面量直给的参数对象。
 *
 * 返回 `{ found, value }`：
 *   found=false          → 根本没有 name 键
 *   found=true, value="" → 有 name 键但值是空字符串（同样会建出坏实例）
 */
function readNameArg(src, startIndex) {
	let depth = 0;
	let inString = null;
	let escaped = false;
	for (let i = startIndex; i < src.length; i += 1) {
		const ch = src[i];
		if (inString !== null) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === inString) inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "{" || ch === "[" || ch === "(") {
			depth += 1;
			continue;
		}
		if (ch === "}" || ch === "]" || ch === ")") {
			depth -= 1;
			if (depth === 0) break;
			continue;
		}
		if (depth === 1 && src.slice(i, i + 5) === "name:" && (i === 0 || /[\s{,]/.test(src[i - 1]))) {
			const after = src.slice(i + 5);
			// 只认字符串字面量取值；变量/模板插值等交给运行级测试兜底
			const lit = after.match(/^\s*(["'`])([^"'`]*)\1/);
			return { found: true, value: lit === null ? null : lit[2] };
		}
	}
	return { found: false, value: null };
}

let scannedFiles = 0;
let scannedCalls = 0;
const missing = [];
const emptyValue = [];

function scanSource(label, src) {
	const re = /cached\(\{/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		scannedCalls += 1;
		const { found, value } = readNameArg(src, m.index + "cached(".length);
		const line = src.slice(0, m.index).split("\n").length;
		const loc = `${label}:${line}`;
		if (!found) missing.push(loc);
		else if (value !== null && value.trim() === "") emptyValue.push(loc);
	}
}

for (const dir of SCAN_DIRS) {
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
		// lib/client.js 是构建产物，源码在 src/client/，不重复扫
		if (dir === "lib" && file === "client.js") continue;
		scannedFiles += 1;
		scanSource(`${dir}/${file}`, readFileSync(`${dir}/${file}`, "utf8"));
	}
}
for (const file of SCAN_ROOT_FILES) {
	scannedFiles += 1;
	scanSource(file, readFileSync(file, "utf8"));
}
// route-cache.js 自己的函数签名里有一处 `cached({`（解构参数），它当然没有
// `name:` 键——那是定义不是调用，排除掉。
const missingReal = missing.filter((loc) => !loc.startsWith("lib/route-cache.js:"));

check(
	`扫描到 cached() 调用点（${scannedFiles} 个文件 / ${scannedCalls} 处调用）`,
	scannedCalls >= 15,
	`实际 ${scannedCalls} 处`
);
check(
	"每处 cached() 调用都显式传了 name",
	missingReal.length === 0,
	missingReal.length === 0 ? undefined : `缺少 name：${missingReal.join(", ")}`
);
check(
	"没有调用方把 name 传成空串或纯空白",
	emptyValue.length === 0,
	emptyValue.length === 0 ? undefined : `name 为空：${emptyValue.join(", ")}`
);
check(
	"已确认修复的两个调用点不再漏 name",
	!missingReal.some((loc) => loc.startsWith("lib/otc-fund.js:")),
	missingReal.filter((loc) => loc.startsWith("lib/otc-fund.js:")).join(", ")
);

//#endregion

//#region 2. 运行级：漏传 name 必须当场抛错

const { cached, routeCacheStats, resetRouteCachesForTests } = await import("./lib/route-cache.js");

resetRouteCachesForTests();
const beforeKeys = Object.keys(routeCacheStats());

let threw = null;
try {
	await cached({ key: "no-name", ttlMs: 1000, load: async () => 1 });
} catch (error) {
	threw = error;
}
check("cached() 漏传 name 抛 TypeError", threw instanceof TypeError, threw === null ? "没有抛错" : String(threw));
check("错误信息里带上了 key，便于定位调用方", threw !== null && String(threw.message).includes("no-name"), threw === null ? undefined : threw.message);

const afterKeys = Object.keys(routeCacheStats());
check(
	"漏传 name 不会创建名为 undefined 的缓存实例",
	!afterKeys.includes("undefined"),
	afterKeys.includes("undefined") ? `registry 现有键：${afterKeys.join(", ")}` : undefined
);
check(
	"抛错后 registry 没有多出任何实例",
	afterKeys.length === beforeKeys.length,
	`before=${beforeKeys.length} after=${afterKeys.length}`
);

// 空字符串 name 同样拒绝（否则会建出名为 "" 的实例，问题一样）
let emptyThrew = null;
try {
	await cached({ name: "", key: "k", ttlMs: 1000, load: async () => 1 });
} catch (error) {
	emptyThrew = error;
}
check("cached() 传空 name 抛 TypeError", emptyThrew instanceof TypeError, emptyThrew === null ? "没有抛错" : String(emptyThrew));

// 纯空白 name 一样拒绝：registry 里会变成一个看不出归属的键
let blankThrew = null;
try {
	await cached({ name: "  ", key: "k", ttlMs: 1000, load: async () => 1 });
} catch (error) {
	blankThrew = error;
}
check("cached() 传纯空白 name 也抛 TypeError", blankThrew instanceof TypeError, blankThrew === null ? "没有抛错" : String(blankThrew));

// 非字符串 name 也拒绝
let numThrew = null;
try {
	await cached({ name: 42, key: "k", ttlMs: 1000, load: async () => 1 });
} catch (error) {
	numThrew = error;
}
check("cached() 传非字符串 name 也抛 TypeError", numThrew instanceof TypeError, numThrew === null ? "没有抛错" : String(numThrew));

// 正常带 name 的调用不受影响
const okVal = await cached({ name: "sanity-cache", key: "k", ttlMs: 1000, load: async () => 42 });
check("带 name 的正常调用仍然工作", okVal === 42, `得到 ${okVal}`);
check("normal 调用在 registry 里登记了对应名字", Object.keys(routeCacheStats()).includes("sanity-cache"));

// 同名共享实例（这是 name 的语义，不是缺陷）
await cached({ name: "shared-cache", key: "x", ttlMs: 1000, load: async () => 1 });
await cached({ name: "shared-cache", key: "y", ttlMs: 1000, load: async () => 2 });
check("同名调用共享一个实例（预期行为）", routeCacheStats()["shared-cache"]?.size === 2, JSON.stringify(routeCacheStats()["shared-cache"]));

//#endregion

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} 项失败`);
