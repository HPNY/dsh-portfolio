// 场外基金(OTC fund)持仓与净值历史持久化。
//
// 与 lib/index.js 里的自选股 / 预警存储（`watchlistPath` / `alertsPath` 一带）
// 共用同一套写法，刻意保持一致：
//   * 路径         `join(dshHome, ".leekbox-otc-fund.json")`
//   * 读取         readFileSync + try/catch，缺失或损坏一律回落到空默认值，绝不抛
//   * 写入         `${file}.${pid}.${Date.now()}.tmp` + writeFileSync + renameSync；
//                  失败时 unlinkSync 清掉临时文件并返回 false，绝不抛
//   * 写锁         makeListLock() 的 Promise 链，串行化"读→改→写"
//
// 为什么两者都要：原子改名只保证**文件不会写坏**（读者要么看到旧的完整内容、
// 要么看到新的完整内容），它挡不住**丢更新**——两个并发 mutation 都在
// read 之后、write 之前拿到同一份快照，后写的那个会把前一个的结果覆盖掉。
// 所以每个 mutation 都必须走 withOtcFundLock 串起来。
//
// 这里只做纯存储：不认识行情、不认识路由、不认识时钟。数据形状由调用方决定，
// 本模块只保证形状合法（三个顶层键始终存在）。

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 存储文件名，读写在 $DSH_HOME 下。 */
const OTC_FUND_FILE = ".leekbox-otc-fund.json";

/** 三个顶层键的规范形状。每次读取/校验都从这里重建，避免共享可变引用。 */
function emptyOtcFund() {
	return { holdings: {}, navSnapshots: {}, navHistory: {} };
}

/** 判断一个值是不是可当作字典用的普通对象（数组/null 都不算）。 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把任意解析结果收敛成合法的三键形状。
 *
 * 为什么每个键都单独判：文件可能被手改、被旧版本写过、或写到一半断电。
 * 只校验顶层是对象是不够的——`{"holdings":[]}` 会让下游 `Object.keys()` 拿到
 * 数组索引、`holdings[code] = x` 静默失效。逐键回落能把"部分损坏"救回来，
 * 而不是整份丢掉。
 */
function normalizeOtcFund(parsed) {
	const out = emptyOtcFund();
	if (!isPlainObject(parsed)) return out;
	for (const key of ["holdings", "navSnapshots", "navHistory"]) {
		if (isPlainObject(parsed[key])) out[key] = parsed[key];
	}
	return out;
}

/** 场外基金存储文件的绝对路径。 */
export function otcFundPath(dshHome) {
	return join(dshHome, OTC_FUND_FILE);
}

/**
 * 读取整份存储。文件缺失、JSON 损坏、或形状不对都回落到空形状，永不抛。
 * 返回的默认对象是新建的，调用方随意改不会污染其他调用方。
 */
export function readOtcFund(dshHome) {
	try {
		const raw = readFileSync(otcFundPath(dshHome), "utf8");
		return normalizeOtcFund(JSON.parse(raw));
	} catch {
		/* 缺失或损坏 —— 从空开始 */
	}
	return emptyOtcFund();
}

/**
 * 原子写入整份存储。成功 true，失败 false，永不抛。
 *
 * 先写同目录的临时文件再 renameSync：POSIX/NTFS 上同卷改名是原子的，读者
 * 不会看到写了一半的 JSON。临时文件名带 pid + 时间戳，避免多个进程/多次
 * 写入互相踩。任何一步失败都要把临时文件清掉，否则 $DSH_HOME 会攒下一堆
 * 垃圾 .tmp。
 */
export function writeOtcFund(dshHome, data) {
	const file = otcFundPath(dshHome);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {}
		return false;
	}
}

/**
 * 串行化"读→改→写"周期（与 lib/index.js 的 makeListLock 同一实现）。
 *
 * 队列是 Promise 链：每个任务在前一个 settle 之后才开跑，于是每个周期都能
 * 看到上一个周期的结果，并发 mutation 不会互相覆盖。链上挂的是"吞掉错误"的
 * 版本，所以某个 fn 抛错只会让它自己的调用者收到 rejection，不会把后面排队
 * 的所有调用者一起带崩。
 */
function makeListLock() {
	let queue = Promise.resolve();
	return function withLock(run) {
		const task = queue.then(() => run());
		queue = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	};
}

const withStoreLock = makeListLock();

/**
 * 把 fn 排进存储写锁队列。fn 负责完成整个"读→改→写"周期（通常这样用）：
 *
 *   await withOtcFundLock(() => {
 *     const data = readOtcFund(dshHome);
 *     upsertHolding(data, input);
 *     writeOtcFund(dshHome, data);
 *   });
 *
 * 返回 Promise：fn 的返回值原样透传，fn 抛错则 reject（且不破坏队列）。
 */
export function withOtcFundLock(fn) {
	return withStoreLock(fn);
}

/** 基金代码归一化：去空白、只保留字符串形态。非字符串或空串 → null。 */
function normalizeCode(code) {
	if (typeof code !== "string") return null;
	const trimmed = code.trim();
	return trimmed === "" ? null : trimmed;
}

/** 校验一个有限数。非法返回 null，0 是合法值。 */
function finiteNumber(v) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return v;
}

/**
 * 新增或更新一只持仓（mutates + 返回同一个 data，便于链式调用）。
 *
 * input = { code, name, shares, costNav, lateDisclosure }
 *   code          必填，非空字符串（会 trim）
 *   shares        有限数且 >= 0
 *   costNav       有限数且 > 0
 *   name          可选字符串（空/非字符串则不写入）
 *   lateDisclosure 仅在严格为 true 时写入（其余情况视为 false）
 *
 * 校验不过直接抛 TypeError —— 这是**编程错误**而不是用户输入错误，调用方
 * （路由层）应当先校验再进来；静默写半条脏数据会让净值计算长期错下去。
 * 已存在的持仓做**部分更新**：只覆盖本次显式提供的字段。
 */
export function upsertHolding(data, input) {
	if (!isPlainObject(data)) throw new TypeError("upsertHolding: data 必须是对象");
	if (!isPlainObject(input)) throw new TypeError("upsertHolding: input 必须是对象");
	const code = normalizeCode(input.code);
	if (code === null) throw new TypeError("upsertHolding: code 必须是非空字符串");
	const shares = finiteNumber(input.shares);
	if (shares === null || shares < 0) throw new TypeError("upsertHolding: shares 必须是 >= 0 的有限数");
	const costNav = finiteNumber(input.costNav);
	if (costNav === null || costNav <= 0) throw new TypeError("upsertHolding: costNav 必须是 > 0 的有限数");

	if (!isPlainObject(data.holdings)) data.holdings = {};
	const prev = isPlainObject(data.holdings[code]) ? data.holdings[code] : {};
	const entry = { ...prev };
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (name !== "") entry.name = name;
	entry.shares = shares;
	entry.costNav = costNav;
	// 字段始终存在（形状稳定），但只有 true 才为 true —— 与冻结的样例一致。
	entry.lateDisclosure = input.lateDisclosure === true;
	data.holdings[code] = entry;
	return data;
}

/**
 * 删除一只持仓（mutates + 返回 data）。代码不存在时是空操作（幂等），
 * 这样客户端的重试/重复删除不会报错。代码非法同样按"不存在"处理。
 */
export function deleteHolding(data, code) {
	if (!isPlainObject(data)) throw new TypeError("deleteHolding: data 必须是对象");
	const normalized = normalizeCode(code);
	if (normalized === null) return data;
	if (isPlainObject(data.holdings)) delete data.holdings[normalized];
	return data;
}

/**
 * 追加净值历史（mutates + 返回 data）。
 *
 * points = [{ date: "YYYY-MM-DD", nav: number }, ...]
 *
 * 存储按 `${code}:${date}` 作键，因此**同 code + 同 date 天然不重复**：
 * 重复追加只会覆盖同一天的值（幂等），不会长出第二条。这正是"append-only
 * 且去重"想要的效果——轮询器反复抓到同一个披露日也不会把数组撑爆。
 *
 * 非法点（缺日期、日期格式不对、nav 非有限数）逐条跳过而不抛：净值历史是
 * 派生数据，丢一个坏点远好过让整轮刷新失败。
 */
export function appendNavHistory(data, code, points) {
	if (!isPlainObject(data)) throw new TypeError("appendNavHistory: data 必须是对象");
	const normalized = normalizeCode(code);
	if (normalized === null) return data;
	if (!Array.isArray(points)) return data;
	if (!isPlainObject(data.navHistory)) data.navHistory = {};
	for (const point of points) {
		if (!isPlainObject(point)) continue;
		const date = typeof point.date === "string" ? point.date.trim() : "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		const nav = finiteNumber(point.nav);
		if (nav === null) continue;
		data.navHistory[`${normalized}:${date}`] = { code: normalized, date, nav };
	}
	return data;
}
