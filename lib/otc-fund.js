// 持仓看板 dsh-portfolio — 场外基金（OTC fund）Host 半数据层。
//
// 与 index.js 的场内行情模块并列，**只做场外基金**：净值、估值、历史净值曲线数据、
// 距成本线距离 / 解套进度，外加两条路由（/api/leekbox/otc-fund/{snapshot,mutate}）。
//
// ## 数据源（2026-11-03 实测结论，不要照抄网络上的旧教程）
//
// 方案原文写的两个接口**已经失效**，实测结果：
//   ✗ http://fundgz.1234567.com.cn/js/{code}.js?callback=jsonpgz
//     所有代码都返回东财 404 页面 HTML（title「页面未找到 - 东方财富网」），不是 JSONP。
//   ✗ http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=..&page=1&per=20
//     返回字面量 `var apidata=`（空），没有任何 records。
//   ✗ https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo  → ErrCode 61136403「网络繁忙」
//   ✗ https://fund.eastmoney.com/{code}.html → 前端 SPA 壳，服务端不渲染估值
//
// ⚠️ 关于 fundmobapi.eastmoney.com（FundMNFInfo / FundMNInverstPosition 都在这域名下）：
//     它**不是失效**，而是**按 User-Agent 拒绝**——用 fetch-utils 默认的桌面 Chrome UA
//     打过去一律 `ErrCode 61136403`「网络繁忙」，看起来跟接口下线一样。同一 URL 换成
//     移动端 UA 就正常返回（详见下方 MOBILE_UA 的注释）。所以这两个接口必须显式带
//     `user-agent: MOBILE_UA`，否则会静默变成"永远取不到"。
//
// 实际可用、且信息量更大的主源：
//   ✓ https://fund.eastmoney.com/pingzhongdata/{code}.js
//     一份 JS 赋值脚本，内含基金名、单位净值全历史、累计净值、阶段收益、经理、规模等。
//     文件是 UTF-8 **带 BOM**，必须剥掉；解析用「括号配平」而不是贪婪正则，见 parseScalar。
//
// 因此净值一律以 pingzhongdata 为准；估值（盘中实时估算）作为**可选增强**，
// 拿不到就把 estimateAvailable 置 false 并回落到已披露净值 —— 这正是方案里的降级路径。
// 估值链按优先级依次尝试，任一路失败只影响估值，不影响净值。
//
// ## 不该返回假数据
//
// README 承诺「绝不返回假的 0/0」。这里贯彻到底：
//   * 某只基金档案取不到 → 用持仓快照兜底，并 stale=true 标注数据未更新；
//   * 全都没有 → 抛中文错误，路由层回 502，绝不吐一行 0。
//   * 某只持仓缺成本净值时，距离/进度返回 null（而不是 0 —— 0 会被界面读成「已解套」）。
//
// ## 与其它模块的边界
//
// 持久化只用 otc-fund-store.js（对等模块，已被 task-3 交付）。本模块**只做场外基金**：
// 不读自选股文件、不抓股票行情、不跨插件读任何东西。

import { homedir } from "node:os";
import { join } from "node:path";
import { fetchText, fetchJson, feedError, errorDetail, userMessage } from "./fetch-utils.js";
import { cached } from "./route-cache.js";
import { cnDateStr, sessionTtl } from "./calendar.js";

//#region 常量

/** 场外基金代码：6 位数字。159xxx/161xxx/501xxx 这类场内 LOF 同样是 6 位，一视同仁。 */
const FUND_CODE = /^\d{6}$/;

const PINGZHONG_BASE = "https://fund.eastmoney.com/pingzhongdata/";

/** 基金搜索建议（行情页搜索框查场外基金用）。 */
const FUND_SUGGEST_BASE = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx";

/** 基金的股票持仓（最新披露的前十大重仓，含占净值比例）。 */
const FUND_POS_BASE = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition";

/** 估值榜（批量）——方案指定的第一优先估值源，目前大部分时段返回「暂无数据」。 */
const GZLIST_BASE = "https://api.fund.eastmoney.com/FundGuZhi/GetFundGZList";

/** 单只基金 JSONP 估值——方案指定的第二优先，目前站点已下线，保留作低成本探测。 */
const FUNDGZ_BASE = "http://fundgz.1234567.com.cn/js/";

/** 东财 App 接口：估值字段今日为 null，但净值/日期/涨跌幅可用于净值兜底。 */
const MOB_BASE = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo";

/** 兜底 UA：东财对没有 UA 的请求会直接给 404 页。 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * 东财移动端接口（fundmobapi）专用 UA。
 *
 * 实测：`fundmobapi.eastmoney.com` 会按 UA 拒绝请求——用上面那个桌面 Chrome UA
 * 打 FundMNInverstPosition 一律返回 `ErrCode 61136403`（文案"网络繁忙"，实际与
 * 网络无关），而移动端 UA 稳定返回数据。所以这些接口单独走这个 UA。
 */
const MOBILE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** 净值历史只保留最近 N 个点：曲线用不到 3400 个点，payload 越小越好。 */
// 详情页要算「近 3 年 / 成立来」涨幅，400 个点（约 1.6 年）不够；放宽到约 12 年。
// 只影响内存与解析，不影响网络（pingzhongdata 本来就是全历史返回）。
const NAV_HISTORY_LIMIT = 3000;

/** 净值超过这么多天没更新就认为数据陈旧（周末/长假 + 披露延迟都落在这个范围内）。 */
const STALE_NAV_DAYS = 7;

/** 档案缓存的 stale-if-error 容忍窗口：上游抖动时宁可给旧净值，也别让面板空白。 */
const PROFILE_STALE_MS = 30 * 60 * 1000;

/** 估值榜缓存：盘中 60 秒；盘后整份榜都不再变化，拉到 10 分钟。 */
const GZLIST_TTL_OPEN_MS = 60 * 1000;
const GZLIST_TTL_CLOSED_MS = 10 * 60 * 1000;

/** App 接口缓存：估值字段盘中每分钟刷新。 */
const MOB_TTL_MS = 60 * 1000;

/** 已失效数据源的冷却期：探测失败后一段时间内不再重复打，省掉每只基金 5s 空等。 */
const FUNDGZ_COOLDOWN_MS = 10 * 60 * 1000;
const GZLIST_COOLDOWN_MS = 5 * 60 * 1000;

/** 单次快照最多同时处理多少只基金（防止误传一堆代码把上游打爆）。 */
const MAX_SNAPSHOT_CODES = 50;

/** 路由路径（与 index.js 的 ROUTES 合并）。 */
export const FUND_ROUTES = Object.freeze({
	otcFundSnapshot: "/api/leekbox/otc-fund/snapshot",
	otcFundMutate: "/api/leekbox/otc-fund/mutate",
	otcFundHistory: "/api/leekbox/otc-fund/history",
	otcFundSearch: "/api/leekbox/otc-fund/search",
	otcFundPositions: "/api/leekbox/otc-fund/positions",
});

/** 字段上限，对齐 index.js 的 parseQty / parseCost 口径。 */
const MAX_SHARES = 1e10;
const MAX_COST_NAV = 1e7;
const MAX_NAME_LEN = 40;

//#endregion

//#region 小工具

/** 有限数字或 null（绝不把 NaN / Infinity 写进响应）。 */
function num(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** 四舍五入到两位小数（百分比统一两位）。 */
function round2(value) {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** 金额聚合：到「分」。 */
function roundMoney(value) {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** 归一化基金代码；不合法返回 null。 */
function normalizeFundCode(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return FUND_CODE.test(trimmed) ? trimmed : null;
}

/** 「今天」的东八区日期串。 */
function todayCn() {
	return cnDateStr(new Date());
}

/**
 * 两个 YYYY-MM-DD 之间相差多少天（b - a）。
 *
 * 用 Date.UTC 做纯日期算术：两个日期串都是东八区墙上日期，转 UTC 零点只是为了
 * 让减法不受夏令时/宿主时区影响。任一参数不合法返回 null。
 */
function daysBetween(a, b) {
	const pa = parseYmd(a);
	const pb = parseYmd(b);
	if (pa === null || pb === null) return null;
	return Math.round((pb - pa) / (24 * 3600 * 1000));
}

function parseYmd(value) {
	if (typeof value !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (m === null) return null;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isFinite(ms) ? ms : null;
}

/**
 * epoch 毫秒 → 东八区 YYYY-MM-DD。
 *
 * 东财 netWorthTrend 的 x 是「北京日期」的毫秒数，但它存的是当地零点对应的
 * UTC 值（实测 2026-11-02 → 1793548800000 = 2026-11-02T00:00:00+08:00）。
 * 所以直接按 +08 偏移读 UTC 字段即可，与宿主机时区无关。
 */
function navDateFromMs(ms) {
	const n = num(ms);
	if (n === null) return null;
	const shifted = new Date(n + 8 * 3600 * 1000);
	if (Number.isNaN(shifted.getTime())) return null;
	const y = shifted.getUTCFullYear();
	const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const d = String(shifted.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** 东八区毫秒 → "YYYY-MM-DD HH:mm"（估值时点）；拿不到返回空串。 */
function cnDateTimeFromMs(ms) {
	const n = num(ms);
	if (n === null) return "";
	const shifted = new Date(n + 8 * 3600 * 1000);
	if (Number.isNaN(shifted.getTime())) return "";
	const y = shifted.getUTCFullYear();
	const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const d = String(shifted.getUTCDate()).padStart(2, "0");
	const h = String(shifted.getUTCHours()).padStart(2, "0");
	const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
	return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** 当前时刻的 ISO8601（固定 +08:00 偏移，so 浏览器不用猜时区）。 */
function nowIsoCst(now = Date.now()) {
	const shifted = new Date(now + 8 * 3600 * 1000);
	const y = shifted.getUTCFullYear();
	const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const d = String(shifted.getUTCDate()).padStart(2, "0");
	const h = String(shifted.getUTCHours()).padStart(2, "0");
	const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
	const s = String(shifted.getUTCSeconds()).padStart(2, "0");
	return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
}

/** 把上游时间串（"2026-11-03 14:30" / "2026-11-03 14:30:00"）归一成 "YYYY-MM-DD HH:mm"。 */
function normalizeEstimateTime(raw) {
	if (typeof raw !== "string") return "";
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
	return m === null ? "" : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

//#endregion

//#region pingzhongdata 解析

/**
 * 从 `var NAME = ...;` 里取出那段字面量（保持原文，交给 JSON.parse）。
 *
 * 为什么不用 `=\s*([\s\S]*?);` 这种非贪婪正则：脚本里的字符串字段本身可能带分号
 * 或方括号（如 unitMoney），非贪婪正则会提前截断；贪婪 `[\s\S]*` 又会吃掉后面的
 * 所有变量。唯一稳妥的办法是按括号配平扫描，同时跳过字符串内部的括号。
 *
 * @returns {string|null} 字面量原文（不含结尾分号）
 */
function parseScalar(text, name) {
	const marker = `var ${name}`;
	let from = 0;
	for (;;) {
		const at = text.indexOf(marker, from);
		if (at === -1) return null;
		// 确保是完整的变量名（避免 fS_name 命中 fS_nameX）
		const after = text.charAt(at + marker.length);
		if (after === "" || !/[\w$]/.test(after)) {
			const eq = skipSpace(text, at + marker.length);
			if (text.charAt(eq) === "=") {
				return readLiteral(text, eq + 1);
			}
		}
		from = at + marker.length;
	}
}

function skipSpace(text, from) {
	let i = from;
	while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
	return i;
}

/** 从 from 起读一个字面量：括号配平 + 跳过引号字符串。 */
function readLiteral(text, from) {
	const start = skipSpace(text, from);
	if (start >= text.length) return null;
	const first = text.charAt(start);

	// 字符串标量：按引号配对读到收尾引号。**不能**用「读到分号」的简化写法 ——
	// 基金名/分红说明里会出现 "A;B[C]" 这种带分号和方括号的文案，那样会截断。
	if (first === '"' || first === "'") {
		const quote = first;
		for (let i = start + 1; i < text.length; i++) {
			const ch = text.charAt(i);
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === quote) {
				const inner = text.slice(start + 1, i);
				// 单引号不是合法 JSON，这里统一转成双引号字面量交给 JSON.parse
				return quote === '"' ? text.slice(start, i + 1) : JSON.stringify(inner);
			}
		}
		return null;
	}

	if (first === "[" || first === "{") {
		const close = first === "[" ? "]" : "}";
		let depth = 0;
		let quote = "";
		for (let i = start; i < text.length; i++) {
			const ch = text.charAt(i);
			if (quote !== "") {
				if (ch === "\\") i += 1;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === first) {
				depth += 1;
			} else if (ch === close) {
				depth -= 1;
				if (depth === 0) return text.slice(start, i + 1);
			}
		}
		return null;
	}
	// 数字/布尔/null：读到分号或换行为止
	const end = text.slice(start).search(/[;\n]/);
	return end === -1 ? text.slice(start) : text.slice(start, start + end);
}

/** JSON.parse 一段字面量；失败返回 fallback（东财偶尔写 `null` 或空数组）。 */
function parseJsonLiteral(raw, fallback = null) {
	if (raw === null || raw === "") return fallback;
	try {
		const parsed = JSON.parse(raw);
		return parsed === undefined ? fallback : parsed;
	} catch {
		return fallback;
	}
}

/** 取标量字符串（去引号）。 */
function parseString(text, name) {
	const raw = parseScalar(text, name);
	if (raw === null) return "";
	const parsed = parseJsonLiteral(raw, "");
	return typeof parsed === "string" ? parsed.trim() : String(parsed ?? "").trim();
}

/** 取标量数字。 */
function parseNumber(text, name) {
	return num(parseJsonLiteral(parseScalar(text, name), null));
}

/**
 * 解析 pingzhongdata 全文。
 *
 * 只认准「净值与基本信息」这一层，其余（持仓结构、规模、经理）做成可选字段，
 * 缺了就留空 —— 上游字段时有时无，硬依赖会让整页挂掉。
 */
export function parsePingzhong(text, code) {
	const body = String(text ?? "").replace(/^\uFEFF/, "");

	const name = parseString(body, "fS_name") || code;

	// 单位净值全历史：x=北京日期毫秒，y=单位净值
	const unitTrend = parseJsonLiteral(parseScalar(body, "Data_netWorthTrend"), []);
	const navHistory = [];
	const seenDate = new Set();
	if (Array.isArray(unitTrend)) {
		for (const point of unitTrend) {
			if (point === null || typeof point !== "object") continue;
			const date = navDateFromMs(point.x);
			const nav = num(point.y);
			if (date === null || nav === null || nav <= 0) continue;
			if (seenDate.has(date)) continue;
			seenDate.add(date);
			navHistory.push({ date, nav });
		}
	}
	// 升序；只保留最近 NAV_HISTORY_LIMIT 个点
	navHistory.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	if (navHistory.length > NAV_HISTORY_LIMIT) navHistory.splice(0, navHistory.length - NAV_HISTORY_LIMIT);

	const last = navHistory.length > 0 ? navHistory[navHistory.length - 1] : null;

	// 累计净值：只用于展示「成立以来」，不影响成本线
	const acTrend = parseJsonLiteral(parseScalar(body, "Data_ACWorthTrend"), []);
	let cumulativeNav = null;
	if (Array.isArray(acTrend) && acTrend.length > 0) {
		const tail = acTrend[acTrend.length - 1];
		if (Array.isArray(tail)) cumulativeNav = num(tail[1]);
	}

	// 经理：数组第一个
	const managerList = parseJsonLiteral(parseScalar(body, "Data_currentFundManager"), []);
	let manager = null;
	if (Array.isArray(managerList) && managerList.length > 0) {
		const first = managerList[0];
		if (first !== null && typeof first === "object") {
			manager = {
				name: typeof first.name === "string" ? first.name : "",
				workTime: typeof first.workTime === "string" ? first.workTime : "",
			};
		}
	}

	// 规模走势：categories 是报告期日期。series 有两种形态 ——
	//   {"series":[{"y":7.08,"mom":"7.12%"}, ...]}        ← 与 categories 平行的对象数组（实测 161616）
	//   {"series":[{"name":"净资产规模","data":[...]}]}    ← 带名字的嵌套数组（老形态）
	const scaleTrend = parseJsonLiteral(parseScalar(body, "Data_fluctuationScale"), null);
	let scale = null;
	let scaleHistory = [];
	if (scaleTrend !== null && typeof scaleTrend === "object") {
		const categories = Array.isArray(scaleTrend.categories) ? scaleTrend.categories : [];
		const series = Array.isArray(scaleTrend.series) ? scaleTrend.series : [];
		const data = series.length > 0 && Array.isArray(series[0].data) ? series[0].data : series;
		const points = [];
		for (let i = 0; i < Math.min(categories.length, data.length); i++) {
			const date = typeof categories[i] === "string" ? categories[i].trim() : "";
			const cell = data[i];
			const value = num(cell !== null && typeof cell === "object" ? cell.y : cell);
			if (date === "" || value === null) continue;
			points.push({ date, value });
		}
		if (points.length > 0) {
			scaleHistory = points.slice(-24);
			scale = scaleHistory[scaleHistory.length - 1].value;
		}
	}

	// 阶段收益
	const returns = {
		y1: parseNumber(body, "syl_1n"),
		m6: parseNumber(body, "syl_6y"),
		m3: parseNumber(body, "syl_3y"),
		m1: parseNumber(body, "syl_1y"),
	};

	return {
		code,
		name,
		latestNav: last === null ? null : last.nav,
		latestDate: last === null ? null : last.date,
		cumulativeNav,
		navHistory,
		returns,
		manager,
		scale,
		scaleHistory,
		feeRate: parseNumber(body, "fund_Rate"),
		sourceRate: parseNumber(body, "fund_sourceRate"),
		minBuy: num(parseJsonLiteral(parseScalar(body, "fund_minsg"), null)),
	};
}

//#endregion

//#region 上游取数

/** 小时级时间戳，给静态 .js 做 cache-buster（同时保留 CDN 命中率）。 */
function coarseStamp() {
	return Math.floor(Date.now() / (60 * 60 * 1000));
}

async function fetchPingzhongText(code) {
	const buffer = await fetchText(`${PINGZHONG_BASE}${code}.js?v=${coarseStamp()}`, {
		timeoutMs: 12000,
		headers: { referer: `https://fund.eastmoney.com/${code}.html` },
	});
	if (buffer === null) return null;
	const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
	// 上游被限流时会给一段 HTML 或空文件；没有 fS_name 就当没取到
	if (text.length < 200 || !text.includes("fS_name")) return null;
	return text;
}

/** 估值源健康状态（熔断）：失败后 cooldown 内不再重试，避免每只基金都空等一次超时。 */
const sourceHealth = {
	fundgzDownUntil: 0,
	gzlistDownUntil: 0,
};

/** 测试用：清掉估值源的熔断状态与缓存计数。 */
export function resetFundSourceHealthForTests() {
	sourceHealth.fundgzDownUntil = 0;
	sourceHealth.gzlistDownUntil = 0;
}

function gzlistCached(cooldown) {
	return Date.now() < sourceHealth.gzlistDownUntil;
}

/**
 * 估值榜（批量）：一次拿一页，按 FCODE 找我们的基金。
 *
 * 这是排行榜接口，不支持按代码查询，所以「榜单里没有」是常态而不是错误 ——
 * 找不到就返回 null，让下一路估值源接手。
 */
async function fetchGzListRow(code) {
	if (gzlistCached()) return null;
	const ttlMs = () => sessionTtl(GZLIST_TTL_OPEN_MS, 10);
	try {
		const rows = await cached({
			name: "otcFundGzList",
			key: "page1-1000",
			ttlMs,
			max: 2,
			load: async () => {
				const payload = await fetchJson(
					`${GZLIST_BASE}?type=1&sort=3&orderType=desc&canbuy=0&pageIndex=1&pageSize=1000`,
					{ timeoutMs: 8000, headers: { referer: "https://fund.eastmoney.com/" } }
				);
				const data = payload !== null && keyOf(payload, "Data");
				return Array.isArray(data) ? data : [];
			},
		});
		if (!Array.isArray(rows) || rows.length === 0) {
			sourceHealth.gzlistDownUntil = Date.now() + GZLIST_COOLDOWN_MS;
			return null;
		}
		const hit = rows.find((row) => String(row?.FCODE ?? "").trim() === code);
		if (hit === undefined) return null;
		return readEstimateFields(hit);
	} catch {
		sourceHealth.gzlistDownUntil = Date.now() + GZLIST_COOLDOWN_MS;
		return null;
	}
}

function keyOf(payload, key) {
	return payload !== null && typeof payload === "object" ? payload[key] : null;
}

/** 从一坨候选字段里读出估值三件套。字段名各接口略有差异，统一在这里收口。 */
function readEstimateFields(row) {
	if (row === null || typeof row !== "object") return null;
	const estimateNav = num(row.GSZ) ?? num(row.gsz) ?? num(row.estimateNav);
	if (estimateNav === null || estimateNav <= 0) return null;
	const rawTime = row.GZTIME ?? row.gztime ?? row.estimateTime ?? "";
	const estimateTime = normalizeEstimateTime(rawTime);
	const estimatePct = num(row.GSZZL) ?? num(row.gszzl);
	return {
		estimateNav,
		estimateTime,
		estimatePct,
	};
}

/**
 * 单只基金 JSONP 估值（方案指定的第二路）。
 *
 * 站点目前对所有代码返回 404 HTML，所以解析失败即熔断；万一恢复，
 * 这段解析不用改就能用。
 */
async function fetchFundgzEstimate(code) {
	if (Date.now() < sourceHealth.fundgzDownUntil) return null;
	const buffer = await fetchText(`${FUNDGZ_BASE}${code}.js?rt=${Date.now()}`, {
		timeoutMs: 5000,
		headers: { referer: "https://fund.eastmoney.com/" },
	});
	const text = buffer === null ? "" : buffer.toString("utf8");
	const m = /jsonpgz\(\s*(\{[\s\S]*?\})\s*\)/.exec(text);
	if (m === null) {
		sourceHealth.fundgzDownUntil = Date.now() + FUNDGZ_COOLDOWN_MS;
		return null;
	}
	const payload = parseJsonLiteral(m[1], null);
	if (payload === null) {
		sourceHealth.fundgzDownUntil = Date.now() + FUNDGZ_COOLDOWN_MS;
		return null;
	}
	return readEstimateFields({
		GSZ: payload.gsz,
		GSZZL: payload.gszzl,
		GZTIME: payload.gztime,
		FCODE: payload.fundcode,
		NAME: payload.name,
		DWJZ: payload.dwjz,
		JZRQ: payload.jzrq,
	});
}

/**
 * 东财 App 接口（批量）：今日估值字段为 null，但仍是可靠的官方净值源。
 *
 * 因此它同时承担两件事：估值链的第三路，以及 pingzhongdata 挂掉时的净值兜底。
 */
async function fetchMobRows(codes) {
	const key = codes.slice().sort().join(",");
	return cached({
		name: "otcFundMob",
		key,
		ttlMs: () => sessionTtl(MOB_TTL_MS, 5),
		max: 60,
		load: async () => {
			const url =
				`${MOB_BASE}?pageIndex=1&pageSize=${Math.max(codes.length, 20)}` +
				`&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=otc-fund&Fcodes=${codes.join(",")}`;
			const payload = await fetchJson(url, {
				timeoutMs: 8000,
				// 键名必须是 `user-agent`：以前写的是 `agent`，被 fetch-utils 忽略，
				// 于是这里一直用桌面 UA 打 fundmobapi —— 而该域名按 UA 拒绝桌面 Chrome
				// （ErrCode 61136403 / Datas:null），这个"净值兜底源"其实从未生效过。
				headers: { referer: "https://fund.eastmoney.com/", "user-agent": MOBILE_UA },
			});
			const data = payload !== null ? keyOf(payload, "Datas") : null;
			return Array.isArray(data) ? data : [];
		},
	});
}

//#endregion

//#region 档案与估值组装

/** 档案缓存 TTL：盘中 60 秒（估值在动），盘后 5 分钟（只等披露）。 */
function profileTtlMs() {
	return sessionTtl(60 * 1000, 5);
}

/**
 * 取一只基金的完整档案（含估值与陈旧标记）。
 *
 * @param {string} codeRaw 6 位基金代码
 * @param {{fresh?: boolean, ttlMs?: number}} [opts] fresh=true 跳过缓存（轮询器强刷用）
 */
export async function fetchFundProfile(codeRaw, opts = {}) {
	const code = normalizeFundCode(codeRaw);
	if (code === null) {
		throw feedError(
			`基金代码无法识别：${String(codeRaw ?? "")}（应为 6 位数字，例如 161616）`,
			`otc fund: invalid code=${String(codeRaw ?? "")}`
		);
	}
	if (opts.fresh === true) return loadFundProfile(code);
	return cached({
		name: "otcFundProfile",
		key: code,
		ttlMs: typeof opts.ttlMs === "number" ? opts.ttlMs : () => profileTtlMs(),
		max: 200,
		staleIfError: PROFILE_STALE_MS,
		load: () => loadFundProfile(code),
	});
}

async function loadFundProfile(code) {
	const text = await fetchPingzhongText(code);
	let profile = text === null ? null : parsePingzhong(text, code);
	let navFromFallback = false;

	// 主源挂了：用 App 接口的官方净值兜底（净值是对的，只是没有历史曲线）
	if (profile === null || profile.latestNav === null) {
		const mob = await fetchMobRow(code);
		if (mob !== null) {
			const nav = num(mob.DWJZ) ?? num(mob.NAV);
			const date = typeof mob.PDATE === "string" ? mob.PDATE.trim() : null;
			if (nav !== null && nav > 0) {
				navFromFallback = true;
				profile = {
					...(profile ?? emptyProfile(code)),
					name: profile?.name && profile.name !== code ? profile.name : (typeof mob.SHORTNAME === "string" && mob.SHORTNAME.trim() !== "" ? mob.SHORTNAME.trim() : code),
					latestNav: nav,
					latestDate: date,
				};
			}
		}
	}

	if (profile === null || profile.latestNav === null) {
		throw feedError(
			`基金 ${code} 的净值暂时取不到，请稍后重试`,
			`otc fund: pingzhongdata and mob feed both unavailable for ${code}`
		);
	}

	const estimate = await resolveEstimate(code);
	const stale = computeStale(profile.latestDate) || (navFromFallback && text === null);

	return finalizeProfile(profile, estimate, stale);
}

function emptyProfile(code) {
	return {
		code,
		name: code,
		latestNav: null,
		latestDate: null,
		cumulativeNav: null,
		navHistory: [],
		returns: { y1: null, m6: null, m3: null, m1: null },
		manager: null,
		scale: null,
		scaleHistory: [],
		feeRate: null,
		sourceRate: null,
		minBuy: null,
	};
}

/** 净值超过 STALE_NAV_DAYS 天没更新 → 陈旧。日期都拿不到时不算陈旧（无从判断）。 */
function computeStale(latestDate) {
	if (typeof latestDate !== "string" || latestDate === "") return false;
	const gap = daysBetween(latestDate, todayCn());
	return gap !== null && gap > STALE_NAV_DAYS;
}

/** 单只基金的 App 接口行。 */
async function fetchMobRow(code) {
	try {
		const rows = await fetchMobRows([code]);
		if (!Array.isArray(rows)) return null;
		return rows.find((row) => String(row?.FCODE ?? "").trim() === code) ?? null;
	} catch {
		return null;
	}
}

/**
 * 估值链：估值榜 → JSONP → App 接口 → 回落到已披露净值。
 *
 * 任一路拿到有效估值即返回；全失败时 estimateAvailable=false，
 * estimateNav 用已披露净值（界面据此显示「已披露」而不是「估值」）。
 */
async function resolveEstimate(code) {
	const providers = [
		["gzlist", () => fetchGzListRow(code)],
		["fundgz", () => fetchFundgzEstimate(code)],
		["fundmob", async () => {
			const row = await fetchMobRow(code);
			return row === null ? null : readEstimateFields(row);
		}],
	];
	for (const [source, run] of providers) {
		let hit = null;
		try {
			hit = await run();
		} catch {
			hit = null;
		}
		if (hit !== null) {
			return {
				estimateNav: hit.estimateNav,
				estimateTime: hit.estimateTime,
				estimatePct: hit.estimatePct ?? null,
				estimateSource: source,
				estimateAvailable: true,
			};
		}
	}
	return {
		estimateNav: null,
		estimateTime: "",
		estimatePct: null,
		estimateSource: "nav",
		estimateAvailable: false,
	};
}

/** 组装对外档案：估值不可用时回落到已披露净值，并如实标注。 */
function finalizeProfile(profile, estimate, stale) {
	const estimateAvailable = estimate.estimateAvailable === true && estimate.estimateNav !== null;
	return {
		code: profile.code,
		name: profile.name,
		latestNav: profile.latestNav,
		latestDate: profile.latestDate,
		estimateNav: estimateAvailable ? estimate.estimateNav : profile.latestNav,
		estimateTime: estimateAvailable ? estimate.estimateTime : "",
		estimateSource: estimate.estimateSource,
		estimateAvailable,
		estimatePct: estimate.estimatePct ?? null,
		stale: stale === true,
		navHistory: profile.navHistory,
		cumulativeNav: profile.cumulativeNav,
		returns: profile.returns,
		manager: profile.manager,
		scale: profile.scale,
		scaleHistory: profile.scaleHistory,
		feeRate: profile.feeRate,
		sourceRate: profile.sourceRate,
		minBuy: profile.minBuy,
	};
}

//#endregion

//#region 指标

/**
 * 由持仓与净值快照算「距成本线」和「解套进度」。
 *
 * 口径（与方案一致，并写进 README）：
 *   nav              = estimateAvailable ? estimateNav : latestNav
 *   distanceToCostPct= (nav - costNav) / costNav * 100，两位小数
 *   unwindProgressPct= distanceToCostPct（两者同值）
 *   unwound          = distanceToCostPct >= 0
 *   marketValue      = shares * nav
 *   pnl              = shares * (nav - costNav)
 *
 * 缺成本净值或净值时，距离/进度返回 null —— 返回 0 会被界面读成「已解套」，是假数据。
 *
 * @param {{shares?: number, costNav?: number}} holding
 * @param {{latestNav?: number, estimateNav?: number, estimateAvailable?: boolean}} snapshot
 */
export function computeFundMetrics(holding, snapshot) {
	const shares = num(holding?.shares);
	const costNav = num(holding?.costNav);
	const snap = snapshot ?? {};
	const estimateAvailable = snap.estimateAvailable === true;

	// 估值可用时以估值为准；估值字段缺失则退回已披露净值
	const primary = estimateAvailable ? num(snap.estimateNav) : num(snap.latestNav);
	const nav = primary ?? num(snap.latestNav) ?? num(snap.estimateNav);

	const distanceToCostPct = nav !== null && costNav !== null && costNav > 0 ? round2(((nav - costNav) / costNav) * 100) : null;
	const marketValue = shares !== null && nav !== null ? shares * nav : null;
	const pnl = shares !== null && nav !== null && costNav !== null ? shares * (nav - costNav) : null;

	// 「解套需涨」：从当前净值涨回成本线还差多少个百分点。
	// 分母是**当前净值**而不是成本 —— 问的是"还要涨多少"，与 distanceToCostPct 的分母
	// （成本）不同，两者不可互换、也不能互相换算。已解套时为 0（不需要再涨），不给负数。
	// costNav > 0 是硬条件：正常写入路径（API 与 store）都拒绝 <= 0，
	// 这里再挡一次，免得手改文件把 costNav 写成 0 时算出 -100% 这种垃圾。
	const unwound = distanceToCostPct !== null && distanceToCostPct >= 0;
	const neededRisePct =
		nav !== null && costNav !== null && nav > 0 && costNav > 0
			? unwound
				? 0
				: round2(((costNav - nav) / nav) * 100)
			: null;

	return {
		distanceToCostPct,
		unwindProgressPct: distanceToCostPct,
		unwound,
		neededRisePct,
		marketValue,
		pnl,
	};
}

//#endregion

//#region 持久化（只读 + 写入口经 store 模块）

/** 惰性加载对等存储模块；缺失时给出中文可读的失败原因（而不是 ERR_MODULE_NOT_FOUND）。 */
let storeModulePromise = null;
const STORE_EXPORTS = ["otcFundPath", "readOtcFund", "writeOtcFund", "withOtcFundLock", "upsertHolding", "deleteHolding"];

function loadStoreModule() {
	if (storeModulePromise === null) {
		storeModulePromise = import("./otc-fund-store.js")
			.then((mod) => {
				for (const key of STORE_EXPORTS) {
					if (typeof mod[key] !== "function") {
						throw new Error(`otc-fund-store.js 缺少导出 ${key}`);
					}
				}
				return mod;
			})
			.catch((error) => {
				storeModulePromise = null; // 下次再试，别把一次瞬时失败钉死
				throw error;
			});
	}
	return storeModulePromise;
}

function emptyStoreData() {
	return { holdings: {}, navSnapshots: {}, navHistory: {} };
}

/** 读持仓；存储层不可用时返回空集合并把错误交回给调用方决定怎么降级。 */
async function readHoldings(deps) {
	if (deps.store !== undefined && deps.store !== null) {
		return deps.store.readOtcFund(deps.dshHome);
	}
	const store = await loadStoreModule();
	const data = store.readOtcFund(deps.dshHome);
	return data ?? emptyStoreData();
}

//#endregion

//#region HTTP 工具（与 index.js 同一套信任围栏，独立实现避免循环依赖）

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(payload);
}

function isLoopbackAddress(address) {
	const value = String(address ?? "");
	if (value === "" ) return false;
	if (value === "::1") return true;
	const mapped = value.startsWith("::ffff:") ? value.slice(7) : value;
	return isIPv4Loopback(mapped);
}

function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * 主机名是不是本机。
 *
 * `new URL("http://[::1]:51370").hostname` 返回的是**带方括号**的 `"[::1]"`，
 * 直接 `=== "::1"` 会判否 —— 于是"用 IPv6 loopback 打开界面"会让每次保存都 403。
 * 两条路径（Host 头与 Origin）统一走这里，剥掉方括号后再比。
 */
function isLoopbackHostname(rawHostname) {
	let hostname = String(rawHostname ?? "").toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		if (end !== -1) hostname = hostname.slice(1, end);
	}
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || isIPv4Loopback(hostname);
}

/**
 * 本机请求判定：只认 loopback 地址，且 Host 头必须是本机（防 DNS rebinding）。
 */
function isLoopbackRequest(req) {
	if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
	const host = String(req.headers.host ?? "").toLowerCase();
	if (host === "") return true;
	const hostname = host.endsWith("]") && host.includes("[") ? host : host.replace(/:\d+$/, "");
	return isLoopbackHostname(hostname);
}

/** 写请求的 Origin 必须是本机（同源或本机其他端口都放行，外站一律拒）。 */
function isLoopbackOrigin(origin) {
	if (origin === void 0 || origin === null || origin === "") return true;
	let url;
	try {
		url = new URL(String(origin));
	} catch {
		return false;
	}
	return isLoopbackHostname(url.hostname);
}

/**
 * 写请求必须是 JSON（跨站表单发不出 application/json，这道锁挡 CSRF）。
 *
 * 只认**媒体类型本身**：`includes("application/json")` 会把
 * `text/plain; x=application/json`、`application/jsonx` 也放进来，
 * 比文档声称的宽松。这里取第一个 `;` 之前的部分精确比较。
 */
function isJsonContentType(value) {
	const raw = String(value ?? "");
	const mediaType = raw.split(";")[0].trim().toLowerCase();
	return mediaType === "application/json";
}

/** 读请求体，超过上限直接中止。 */
function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(feedError("请求体过大", "otc fund: body over limit"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#endregion

//#region 校验

function parseShares(value) {
	const n = num(value);
	if (n === null || n < 0 || n > MAX_SHARES) return null;
	return n;
}

function parseCostNav(value) {
	const n = num(value);
	if (n === null || n <= 0 || n > MAX_COST_NAV) return null;
	return n;
}

function parseName(value) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, MAX_NAME_LEN);
}

/** 解析 ?codes=161616,005827；全部非法时抛中文错误。 */
function parseCodeList(raw) {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	const out = [];
	for (const part of raw.split(",")) {
		const code = normalizeFundCode(part);
		if (code === null) {
			throw feedError(`基金代码无法识别：${part.trim()}（应为 6 位数字）`, `otc fund: bad code in list=${part}`);
		}
		if (!out.includes(code)) out.push(code);
	}
	if (out.length > MAX_SNAPSHOT_CODES) {
		throw feedError(`一次最多查询 ${MAX_SNAPSHOT_CODES} 只基金`, `otc fund: too many codes=${out.length}`);
	}
	return out;
}

//#endregion

//#region 路由

/**
 * 场外基金的两条路由。
 *
 * @param {object} ctx cordis 上下文（注入可选的 logger）
 * @param {{dshHome?: string, logger?: object, store?: object, quoteProvider?: Function}} deps
 */
/**
 * 阶段涨幅：最近净值相对 N 天前净值的涨幅（%），与逐行盈亏同一口径。
 *
 * 历史不足 N 天时给 null（"不知道"），不给 0 —— 与汇总口径同一条规则。
 * `since` 取历史窗口首尾；窗口起点晚于基金成立时就是"窗口内涨幅"。
 */
function computeStageReturns(navHistory) {
	const out = { d1: null, m1: null, m3: null, m6: null, y1: null, y3: null, since: null };
	if (!Array.isArray(navHistory) || navHistory.length === 0) return out;
	const last = navHistory[navHistory.length - 1];
	if (typeof last?.nav !== "number" || !(last.nav > 0) || typeof last.date !== "string") return out;
	const endTs = Date.parse(`${last.date}T00:00:00+08:00`);
	const at = (days) => {
		const cutoff = endTs - days * 86400000;
		for (let i = navHistory.length - 1; i >= 0; i--) {
			const row = navHistory[i];
			if (typeof row?.nav !== "number" || typeof row.date !== "string") continue;
			if (Date.parse(`${row.date}T00:00:00+08:00`) <= cutoff) {
				return row.nav > 0 ? round2(((last.nav - row.nav) / row.nav) * 100) : null;
			}
		}
		return null;
	};
	out.d1 = at(1);
	out.m1 = at(30);
	out.m3 = at(91);
	out.m6 = at(182);
	out.y1 = at(365);
	out.y3 = at(1095);
	const first = navHistory[0];
	out.since = typeof first?.nav === "number" && first.nav > 0 ? round2(((last.nav - first.nav) / first.nav) * 100) : null;
	return out;
}

/**
 * 基金搜索建议：东财 `FundSearchAPI`（`m=1` 返回纯 JSON，不带 JSONP 回调）。
 * CODE / NAME / JP（拼音首字母）都能命中。结果走缓存，避免连续输入打爆对方。
 */
async function searchFundSuggest(keyword) {
	return cached({
		key: `fundSuggest:${keyword}`,
		ttlMs: 5 * 60 * 1000,
		max: 32,
		load: async () => {
			const payload = await fetchJson(`${FUND_SUGGEST_BASE}?m=1&key=${encodeURIComponent(keyword)}`, {
				timeoutMs: 8000,
				headers: { referer: "https://fund.eastmoney.com/" },
			});
			const rows = payload !== null && Array.isArray(payload.Datas) ? payload.Datas : [];
			const out = [];
			for (const r of rows) {
				const code = normalizeFundCode(r?.CODE);
				const name = typeof r?.NAME === "string" ? r.NAME.trim() : "";
				const desc = typeof r?.CATEGORYDESC === "string" ? r.CATEGORYDESC : "";
				if (code === null || name === "") continue;
				// 这个接口对拼音/代码也会返回股票（CATEGORYDESC 形如 "沪市"/"深市"），
				// 只留真正的基金，否则股票会被误标成基金、点开弹错窗。
				if (!desc.includes("基金")) continue;
				out.push({ code, name, type: desc });
				if (out.length >= 20) break;
			}
			return out;
		},
	});
}

/**
 * 基金最新披露的股票持仓（前十大重仓）：代码 / 简称 / 占净值比例 / 较上期增减。
 * 东财移动端接口，返回 JSON，比 F10 网页版那个 HTML 表格好解析得多。
 *
 * **UA 是硬要求**：这个接口会把 `fetch-utils` 那个桌面 Chrome UA 直接拒掉，
 * 返回 `ErrCode 61136403 / Datas: null`（文案是"网络繁忙"，但跟网络无关，
 * 连打多少次都一样）。实测同一个 URL 换任意非桌面 UA（移动端 / 裸
 * `Mozilla/5.0` / 空 UA）都正常返回 10 条。所以这里必须显式覆盖 UA ——
 * 用同名的 `user-agent` 键（fetch-utils 的默认头也是小写，spread 后干净替换）。
 */
async function fetchFundPositions(code) {
	return cached({
		// v2：旧条目是"UA 不对时也返回空列表"那版代码写进去的，换键让它立刻失效，
		// 免得修复后还显示成「暂无持仓」把取不到伪装成"没有数据"。
		key: `fundPositions:v3:${code}`,
		// 前十大重仓是季度披露，30 分钟足够新。
		ttlMs: 30 * 60 * 1000,
		max: 32,
		load: async () => {
			const payload = await fetchJson(`${FUND_POS_BASE}?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8`, {
				timeoutMs: 8000,
				headers: { referer: "https://fund.eastmoney.com/", "user-agent": MOBILE_UA },
			});
			if (payload === null) throw new Error("基金持仓接口无响应");
			// `Datas: null` 是**取不到**，不是**没有**：返回空列表会让界面显示
			// 「暂无持仓披露数据」，把一次失败伪装成"这只基金没有持仓"。这里抛出去，
			// 路由转 502，界面如实提示稍后再试。
			if (payload.Datas === null || payload.Datas === void 0) {
				const msg = typeof payload.ErrMsg === "string" && payload.ErrMsg !== "" ? payload.ErrMsg : "基金持仓接口返回异常";
				throw new Error(msg);
			}
			const rows = Array.isArray(payload.Datas.fundStocks) ? payload.Datas.fundStocks : [];
			const out = [];
			for (const r of rows) {
				const stockCode = String(r?.GPDM ?? "").trim();
				const name = typeof r?.GPJC === "string" ? r.GPJC.trim() : "";
				if (stockCode === "" || name === "") continue;
				// TEXCH：1 = 沪，2 = 深，5 = 港。映射成行情源认得的市场前缀，
				// 港股不走 A 股行情链路，exchange 留 hk、price/changePct 给 null（不编造）。
				const texch = String(r?.TEXCH ?? "").trim();
				const exchange = texch === "1" ? "sh" : texch === "2" ? "sz" : "hk";
				out.push({
					code: stockCode,
					name,
					weight: num(r?.JZBL),
					changeType: typeof r?.PCTNVCHGTYPE === "string" ? r.PCTNVCHGTYPE : "",
					changeVsPrev: num(r?.PCTNVCHG),
					exchange,
				});
				if (out.length >= 10) break;
			}
			return out;
		},
	});
}

export function makeOtcFundRoutes(ctx, deps = {}) {
	const logger = deps.logger ?? ctx?.logger ?? { warn() {} };
	const dshHome = deps.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const resolved = { ...deps, dshHome, logger };

	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "拒绝访问：本接口仅允许本机请求" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `请求方法不支持：收到 ${req.method}，本接口只接受 ${method}` });
			return false;
		}
		if (method === "POST") {
			if (!isLoopbackOrigin(req.headers.origin)) {
				writeJson(res, 403, { error: "拒绝访问：本接口不接受来自其他站点的写入请求" });
				return false;
			}
			if (!isJsonContentType(req.headers["content-type"])) {
				writeJson(res, 415, { error: "请求体类型不支持：写接口需要 content-type: application/json" });
				return false;
			}
		}
		return true;
	};

	const fail = (res, error) => {
		logger.warn(error);
		writeJson(res, 502, {
			error: userMessage(error),
			reason: errorDetail(error) || (error instanceof Error ? error.message : String(error)),
		});
	};

	/** 组装一行基金快照。取不到档案时用持仓值兜底并标 stale，绝不吐 0。 */
	const buildRow = async (code, holding) => {
		// 份额缺失就是缺失：不要 `?? 0` —— 0 份会被界面读成"这只基金没仓位"，
		// 从而算出 0 市值、0 浮盈，把"不知道"伪装成"没有"。
		const shares = num(holding?.shares);
		const costNav = num(holding?.costNav);
		let profile;
		try {
			profile = await fetchFundProfile(code);
		} catch (error) {
			logger.warn(error);
			profile = null;
		}
		if (profile === null) {
			return {
				code,
				name: typeof holding?.name === "string" && holding.name.trim() !== "" ? holding.name.trim() : code,
				shares,
				costNav,
				latestNav: null,
				latestDate: null,
				estimateNav: null,
				estimateTime: "",
				distanceToCostPct: null,
				unwindProgressPct: null,
				unwound: false,
				neededRisePct: null,
				marketValue: null,
				pnl: null,
				estimateAvailable: false,
				stale: true,
			};
		}
		const metrics = computeFundMetrics({ shares, costNav }, profile);
		return {
			code,
			name: profile.name,
			shares,
			costNav,
			latestNav: profile.latestNav,
			latestDate: profile.latestDate,
			estimateNav: profile.estimateNav,
			estimateTime: profile.estimateTime,
			distanceToCostPct: metrics.distanceToCostPct,
			unwindProgressPct: metrics.unwindProgressPct,
			unwound: metrics.unwound,
			neededRisePct: metrics.neededRisePct,
			// 逐行市值/浮盈给界面用（客户端不自己算）；汇总金额另行舍入到分
			marketValue: metrics.marketValue,
			pnl: metrics.pnl,
			estimateAvailable: profile.estimateAvailable,
			stale: profile.stale,
		};
	};

	const snapshotRoute = {
		kind: "exact",
		path: FUND_ROUTES.otcFundSnapshot,
		handler: async (req, res) => {
			if (!guard(req, res, "GET")) return;
			try {
				const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
				let codes = parseCodeList(url.searchParams.get("codes"));

				let holdings = {};
				let order = [];
				let storeError = null;
				try {
					const data = await readHoldings(resolved);
					holdings = data?.holdings && typeof data.holdings === "object" ? data.holdings : {};
					order = Array.isArray(data?.order) ? data.order : [];
				} catch (error) {
					storeError = error;
					logger.warn(error);
				}

				if (codes === null) {
					if (storeError !== null) {
						// 没有显式代码、又读不到持仓文件：没有可回答的内容
						throw feedError("基金持仓文件暂时读不到，请稍后重试", String(storeError?.message ?? storeError));
					}
					// 顺序口径：先按用户自定义顺序（order）排，再补上 order 里没列到的
					// 持仓（历史数据/新增但未重排过的）——保证不丢行，也不打乱用户顺序。
					const all = Object.keys(holdings);
					const known = new Set(all);
					const ordered = order.filter((c) => known.has(c));
					const rest = all.filter((c) => !ordered.includes(c));
					codes = [...ordered, ...rest];
				}

				const funds = await Promise.all(codes.map((code) => buildRow(code, holdings[code])));

				// 汇总口径：**每一项只有全部持仓都算得出来才给数**。
				// 部分持仓取不到净值时返回 null，而不是"已取到那几只的和" —— 把部分和
				// 当总额展示会低报浮亏。空持仓（本来就没买）才是真正的 0，这是"知道"，
				// 不是"不知道"。
				//
				// 成本与收益率的口径与自选页汇总条一致：成本 = Σ(份额 × 成本净值)，
				// 收益率 = 浮盈 / 成本；成本未知或为 0 时不给收益率（不除零）。
				let fundMarketValue = 0;
				let fundTotalPnl = 0;
				let fundTotalCost = 0;
				let missingValue = 0;
				let missingPnl = 0;
				let missingCost = 0;
				for (const row of funds) {
					const shares = num(row.shares);
					const costNav = num(row.costNav);
					const cost = shares === null || costNav === null ? null : shares * costNav;
					if (row.marketValue === null || row.marketValue === undefined) missingValue += 1;
					else fundMarketValue += row.marketValue;
					if (row.pnl === null || row.pnl === undefined) missingPnl += 1;
					else fundTotalPnl += row.pnl;
					if (cost === null) missingCost += 1;
					else fundTotalCost += cost;
				}
				const fundTotalReturnPct =
					missingPnl === 0 && missingCost === 0 && fundTotalCost > 0 ? round2((fundTotalPnl / fundTotalCost) * 100) : null;

				writeJson(res, 200, {
					funds,
					summary: {
						fundMarketValue: missingValue === 0 ? roundMoney(fundMarketValue) : null,
						fundTotalPnl: missingPnl === 0 ? roundMoney(fundTotalPnl) : null,
						fundTotalCost: missingCost === 0 ? roundMoney(fundTotalCost) : null,
						fundTotalReturnPct,
					},
					updatedAt: nowIsoCst(),
				});
			} catch (error) {
				if (error instanceof Error && /无法识别|最多查询/.test(error.message)) {
					writeJson(res, 400, { error: userMessage(error), reason: errorDetail(error) });
					return;
				}
				fail(res, error);
			}
		},
	};

	const mutateRoute = {
		kind: "exact",
		path: FUND_ROUTES.otcFundMutate,
		handler: async (req, res) => {
			if (!guard(req, res, "POST")) return;
			try {
				const raw = await readBody(req);
				let body;
				try {
					body = JSON.parse(raw === "" ? "{}" : raw);
				} catch {
					writeJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
					return;
				}
				if (body === null || typeof body !== "object") {
					writeJson(res, 400, { ok: false, error: "请求体必须是对象" });
					return;
				}

				const action = typeof body.action === "string" ? body.action.trim() : "";

				// 自定义排序：提交整份顺序（不针对单只基金，所以在 code 校验之前分叉）。
				// 整份提交而非"移到某只前后"：客户端已持有完整列表，整份提交幂等，
				// 重试/并发/拖拽中断都不会留下半截顺序。
				if (action === "reorder") {
					if (!Array.isArray(body.codes)) {
						writeJson(res, 400, { ok: false, error: "排序请求需要 codes 数组" });
						return;
					}
					const store = resolved.store ?? (await loadStoreModule());
					if (typeof store.reorderHoldings !== "function") {
						writeJson(res, 501, { ok: false, error: "当前版本不支持自定义排序" });
						return;
					}
					let outcome = null;
					const run = async () => {
						const data = store.readOtcFund(dshHome) ?? emptyStoreData();
						const next = store.reorderHoldings(data, body.codes);
						if (next === null) return null; // 集合不一致：交给下面回 409
						const written = store.writeOtcFund(dshHome, next);
						if (written === false) throw feedError("保存失败：无法写入基金持仓文件", "otc fund: reorder write failed");
						return next;
					};
					outcome = typeof store.withOtcFundLock === "function" ? await store.withOtcFundLock(run) : await run();
					if (outcome === null) {
						writeJson(res, 409, { ok: false, error: "基金持仓已变化，请刷新后重试" });
						return;
					}
					writeJson(res, 200, { ok: true });
					return;
				}

				const code = normalizeFundCode(body.code);
				if (code === null) {
					writeJson(res, 400, { ok: false, error: `基金代码无法识别：${String(body.code ?? "")}（应为 6 位数字）` });
					return;
				}

				let patch = null;
				if (action === "upsert") {
					// 份额 / 成本净值**可以留空**：详情浮窗的「加入基金」只带代码+名称，
					// 先建一个空壳，用户随后在表格里点单元格补。缺字段是"未知"（存 null），
					// 给错值是"输错了"——后者一律 400，不静默吞。
					const hasShares = body.shares !== void 0 && body.shares !== null;
					const hasCostNav = body.costNav !== void 0 && body.costNav !== null;
					const shares = hasShares ? parseShares(body.shares) : null;
					const costNav = hasCostNav ? parseCostNav(body.costNav) : null;
					if (hasShares && shares === null) {
						writeJson(res, 400, { ok: false, error: "份额必须是 0 到 100 亿之间的数字" });
						return;
					}
					if (hasCostNav && costNav === null) {
						writeJson(res, 400, { ok: false, error: "成本净值必须是大于 0 的数字" });
						return;
					}
					patch = {
						code,
						name: parseName(body.name),
						shares,
						costNav,
						lateDisclosure: body.lateDisclosure === true,
					};
				} else if (action !== "delete") {
					writeJson(res, 400, { ok: false, error: `不支持的操作：${action === "" ? "（空）" : action}` });
					return;
				}

				const store = resolved.store ?? (await loadStoreModule());
				const run = async () => {
					const data = store.readOtcFund(dshHome) ?? emptyStoreData();
					const next =
						action === "delete" ? store.deleteHolding(data, code) : (store.upsertHolding(data, patch) ?? data);
					const written = store.writeOtcFund(dshHome, next);
					if (written === false) {
						throw feedError("保存失败：无法写入基金持仓文件", `otc fund: writeOtcFund returned false for ${code}`);
					}
					return next;
				};
				const saved = typeof store.withOtcFundLock === "function" ? await store.withOtcFundLock(run) : await run();

				// 写完之后立刻拉一次该基金，让界面下一步就拿到新净值（失败不影响写入结论）
				try {
					await fetchFundProfile(code, { fresh: true });
				} catch (error) {
					logger.warn(error);
				}

				void saved;
				writeJson(res, 200, { ok: true });
			} catch (error) {
				logger.warn(error);
				writeJson(res, 502, { ok: false, error: userMessage(error) });
			}
		},
	};

	// 行情页搜索框要能查场外基金：命中后点开基金详情浮窗，再从浮窗加入持仓。
	const searchRoute = {
		kind: "exact",
		path: FUND_ROUTES.otcFundSearch,
		handler: async (req, res) => {
			if (!guard(req, res, "GET")) return;
			try {
				const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
				const key = String(url.searchParams.get("q") ?? "").trim();
				if (key === "") {
					writeJson(res, 200, { results: [] });
					return;
				}
				writeJson(res, 200, { results: await searchFundSuggest(key) });
			} catch (error) {
				fail(res, error);
			}
		},
	};

	// 详情浮窗的数据源：历史净值 + 阶段涨幅。阶段涨幅的口径固定在 Host，
	// 客户端只渲染，避免两边漂移。
	const historyRoute = {
		kind: "exact",
		path: FUND_ROUTES.otcFundHistory,
		handler: async (req, res) => {
			if (!guard(req, res, "GET")) return;
			try {
				const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
				const code = normalizeFundCode(url.searchParams.get("code"));
				if (code === null) {
					writeJson(res, 400, { ok: false, error: "基金代码无法识别（应为 6 位数字）" });
					return;
				}
				let profile;
				try {
					profile = await fetchFundProfile(code);
				} catch (error) {
					logger.warn(error);
					profile = null;
				}
				if (profile === null) {
					writeJson(res, 502, { ok: false, error: "基金档案暂时取不到，请稍后重试" });
					return;
				}
				const navHistory = Array.isArray(profile.navHistory) ? profile.navHistory : [];
				// 持仓字段（份额/成本/市值/浮盈）与 tracked 必须从**持仓文件**取，不能靠调用方
				// 传进来的 fund：从行情页搜索打开时它只有 {code,name}，读不到份额成本，
				// 于是「我的持仓」会整片显示"—"。复用 buildRow 保证口径只有一处。
				let holding = null;
				try {
					const storeData = await readHoldings(resolved);
					holding = storeData?.holdings && typeof storeData.holdings === "object" ? storeData.holdings[code] ?? null : null;
				} catch (error) {
					logger.warn(error);
				}
				const row = await buildRow(code, holding);
				writeJson(res, 200, {
					code,
					name: profile.name,
					latestNav: profile.latestNav,
					latestDate: profile.latestDate,
					estimateNav: profile.estimateNav,
					estimateTime: profile.estimateTime,
					estimateAvailable: profile.estimateAvailable,
					stageReturns: computeStageReturns(navHistory),
					navHistory,
					tracked: holding !== null,
					fund: row,
					updatedAt: nowIsoCst(),
				});
			} catch (error) {
				fail(res, error);
			}
		},
	};

	// 详情浮窗的「基金持仓」：最新披露的前十大重仓 + 实时涨跌。
	// 持仓数据属于基金侧，但实时价格来自行情源 —— 行情通过 deps.quoteProvider 注入，
	// 本模块不直接抓行情，保持"这里只做场外基金数据"的边界。
	const positionsRoute = {
		kind: "exact",
		path: FUND_ROUTES.otcFundPositions,
		handler: async (req, res) => {
			if (!guard(req, res, "GET")) return;
			try {
				const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
				const code = normalizeFundCode(url.searchParams.get("code"));
				if (code === null) {
					writeJson(res, 400, { ok: false, error: "基金代码无法识别（应为 6 位数字）" });
					return;
				}
				let positions;
				try {
					positions = await fetchFundPositions(code);
				} catch (error) {
					logger.warn(error);
					positions = null;
				}
				if (positions === null) {
					writeJson(res, 502, { ok: false, error: "基金持仓暂时取不到，请稍后重试" });
					return;
				}
				// 实时涨跌只对 A 股有意义：港股不在 A 股行情链路里，price/changePct 留 null，
				// 不编造数值。
				let quotes = new Map();
				const ashare = positions.filter((p) => p.exchange === "sh" || p.exchange === "sz");
				if (ashare.length > 0 && typeof resolved.quoteProvider === "function") {
					try {
						const q = await resolved.quoteProvider(ashare.map((p) => p.exchange + p.code));
						// quoteProvider 有两种可能的返回形状：Map<code, quote>，或 quote 对象数组
						// （index.js 的 fetchTencentQuotes 返回的是**数组**，元素带 .code，键是
						// 带前缀的 sh600519）。两种都要归一成 Map —— 以前这里只认 Map，数组被
						// 整批丢掉，于是所有价格/涨跌都静默显示成空。
						if (q instanceof Map) {
							quotes = q;
						} else if (Array.isArray(q)) {
							for (const item of q) {
								const k = String(item?.code ?? "").trim();
								if (k !== "") quotes.set(k, item);
							}
						}
					} catch (error) {
						logger.warn(error);
					}
				}
				const quoteOf = (p) => {
					// 键可能是带前缀的（sh600519）也可能是裸码（600519），两种都试。
					for (const key of [p.exchange + p.code, p.code]) {
						const v = quotes.get(key);
						if (v !== null && v !== void 0) return v;
					}
					return null;
				};
				writeJson(res, 200, {
					code,
					positions: positions.map((p) => {
						const q = quoteOf(p);
						const obj = q !== null && typeof q === "object" ? q : null;
						return {
							code: p.code,
							name: p.name,
							weight: p.weight,
							changeType: p.changeType,
							changeVsPrev: p.changeVsPrev,
							exchange: p.exchange,
							price: obj !== null ? num(obj.price) : typeof q === "number" ? num(q) : null,
							changePct: obj !== null ? num(obj.changePct) : null,
						};
					}),
					updatedAt: nowIsoCst(),
				});
			} catch (error) {
				fail(res, error);
			}
		},
	};

	return [snapshotRoute, historyRoute, searchRoute, positionsRoute, mutateRoute];
}

//#endregion
