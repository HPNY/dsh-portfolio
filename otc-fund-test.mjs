// 场外基金数据层测试（离线，不依赖东财可用性）。
//
// 全部网络访问由本文件里的 fetch 桩接管，断言的是**解析与契约**，不依赖上游当天
// 有没有数据 —— 上游接口这两年反复下线（见 lib/otc-fund.js 顶部的实测记录），
// 把测试绑在线上数据上只会让 CI 随机变红。
//
// 同时保留一条「真连一次」的可选冒烟：设置 OTC_FUND_LIVE=1 才跑，默认跳过。
import assert from "node:assert/strict";
import { resetRouteCachesForTests } from "./lib/route-cache.js";
import {
	FUND_ROUTES,
	resetFundSourceHealthForTests,
	computeFundMetrics,
	fetchFundProfile,
	makeOtcFundRoutes,
	parsePingzhong,
} from "./lib/otc-fund.js";

//#region 测试脚手架

let passed = 0;
function ok(label, fn) {
	try {
		const out = fn();
		if (out instanceof Promise) throw new Error("ok() 收到 Promise，请用 okAsync()");
		passed += 1;
		console.log(`  ok ${label}`);
	} catch (error) {
		console.error(`  ✗  ${label}\n     ${error.message}`);
		process.exitCode = 1;
	}
}
async function okAsync(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok ${label}`);
	} catch (error) {
		console.error(`  ✗  ${label}\n     ${error.message}`);
		process.exitCode = 1;
	}
}
function section(title) {
	console.log(`\n== ${title} ==`);
}

// 看门狗：任何意外挂起都强制失败，避免 CI 卡死
const watchdog = setTimeout(() => {
	console.error("\n✗ 测试超时（90s）—— 有路径没有在预算内返回");
	process.exit(1);
}, 90_000);
watchdog.unref?.();

//#endregion

//#region 假上游

/** 每次请求记录 url + headers，供断言「确实带了 referer」等。 */
let calls = [];
/** 各数据源的可用性开关，逐个场景切换。 */
const live = {
	pingzhong: true,
	gzlist: true,
	fundgz: true,
	fundmob: true,
};
/** 估值榜返回的行（null 表示「暂无数据」）。 */
let gzListRows = null;
/** 模拟东财前十大重仓接口的限流（ErrCode 61136403）。 */
let posThrottled = false;

/** 真实结构的 fixture：BOM + 注释 + 多个 var，与线上逐字节同构。 */
function pingzhongFixture({ name = "融通医疗保健行业混合A/B", points } = {}) {
	const trend =
		points ??
		[
			{ x: 1792944000000, y: 1.591, equityReturn: -1.36, unitMoney: "" },
			{ x: 1793030400000, y: 1.593, equityReturn: 0.13, unitMoney: "" },
			{ x: 1793462400000, y: 1.606, equityReturn: 0.82, unitMoney: "" },
		];
	return (
		"\uFEFF/**\n * 测试数据\n * @type {arry}\n */" +
		"/*2026-11-03 08:53:24*/var ishb=false;" +
		`/*基金或股票信息*/var fS_name = ${JSON.stringify(name)};var fS_code = "161616";` +
		'var fund_sourceRate="1.50";var fund_Rate="0.15";var fund_minsg="10";' +
		`var Data_netWorthTrend = ${JSON.stringify(trend)};` +
		'var Data_ACWorthTrend = [[1792944000000,2.971],[1793030400000,2.973],[1793462400000,2.986]];' +
		'var Data_fluctuationScale = {"categories":["2026-06-30","2026-09-30"],"series":[{"y":5.52,"mom":"-4.08%"},{"y":5.78,"mom":"4.74%"}]};' +
		'var Data_currentFundManager =[{"id":"30123456","name":"刘曦阳","star":3,"workTime":"2年又233天"}];' +
		'var syl_1n="-7.44";var syl_6y="-4.86";var syl_3y="-2.73";var syl_1y="-13.24";' +
		"var stockCodes=[\"6032591\",\"6883628\"];var zqCodes=\"\";"
	);
}

function jsonBody(obj) {
	return new Response(JSON.stringify(obj), {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/** 统一的 fetch 桩：按 URL 路由到各假源，并尊重 AbortSignal。 */
globalThis.fetch = async (input, init = {}) => {
	const url = String(input);
	calls.push({ url, headers: init.headers ?? {} });
	if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");

	// pingzhongdata
	if (url.includes("pingzhongdata/")) {
		if (!live.pingzhong) return new Response("", { status: 200 });
		// pingzhongCodes 非 null 时按代码放行，用来构造"只有部分基金取得到"的场景
		if (live.pingzhongCodes instanceof Set) {
			const code = (/\/(\d{6})\.js/.exec(url)?.[1] ?? "");
			if (!live.pingzhongCodes.has(code)) return new Response("", { status: 200 });
		}
		return new Response(pingzhongFixture(), { status: 200, headers: { "content-type": "application/javascript" } });
	}
	// 估值榜
	if (url.includes("GetFundGZList")) {
		if (!live.gzlist) return jsonBody({ Data: null, ErrCode: -1, ErrMsg: "暂无数据" });
		return jsonBody({ Data: gzListRows, ErrCode: 0 });
	}
	// 单只 JSONP
	if (url.includes("fundgz.1234567.com.cn")) {
		if (!live.fundgz) {
			// 线上现状：200 + 东财 404 HTML
			return new Response("<!doctype html><html><title>页面未找到 - 东方财富网</title></html>", { status: 200 });
		}
		return new Response(
			'jsonpgz({"fundcode":"161616","name":"融通医疗保健行业混合A/B","jzrq":"2026-11-02","dwjz":"1.606","gsz":"1.612","gszzl":"0.37","gztime":"2026-11-03 14:30"});',
			{ status: 200 }
		);
	}
	// App 接口
	if (url.includes("FundMNFInfo")) {
		if (!live.fundmob) return jsonBody({ Datas: null, ErrCode: 61136403, Success: false });
		const codes = (/Fcodes=([^&]*)/.exec(url)?.[1] ?? "").split(",").filter(Boolean);
		return jsonBody({
			Datas: codes.map((code) => ({ FCODE: code, SHORTNAME: "融通医疗", DWJZ: "1.606", PDATE: "2026-11-02", GSZ: null, GSZZL: null, GZTIME: null })),
			ErrCode: 0,
			Success: true,
		});
	}
	// 基金的前十大重仓（东财移动端）：含沪/深/港三种，验证交易所映射与"港股不给行情"
	if (url.includes("FundMNInverstPosition")) {
		if (posThrottled) {
			return jsonBody({ Datas: null, ErrCode: 61136403, Success: false, ErrMsg: "网络繁忙，请稍后重试！" });
		}
		return jsonBody({
			Datas: {
				fundStocks: [
					{ GPDM: "600519", GPJC: "贵州茅台", JZBL: "6.37", TEXCH: "1", PCTNVCHGTYPE: "增持", PCTNVCHG: "0.75" },
					{ GPDM: "00700", GPJC: "腾讯控股", JZBL: "6.06", TEXCH: "5", PCTNVCHGTYPE: "增持", PCTNVCHG: "0.34" },
					{ GPDM: "000568", GPJC: "泸州老窖", JZBL: "4.58", TEXCH: "2", PCTNVCHGTYPE: "减持", PCTNVCHG: "-0.04" },
				],
			},
			ErrCode: 0,
			Success: true,
		});
	}
	// 腾讯行情 stub（合并浮盈已移除，保留以防意外打真实网络）
	if (url.includes("qt.gtimg.cn")) {
		return new Response('v_sh600519="1~贵州茅台~600519~1500.00";v_sz000001="1~平安银行~000001~11.50";', { status: 200 });
	}
	return new Response("not found", { status: 404 });
};

/** 每个场景开始前：清缓存、清熔断、重置开关。 */
function reset(overrides = {}) {
	resetRouteCachesForTests();
	resetFundSourceHealthForTests();
	calls = [];
	gzListRows = null;
	posThrottled = false;
	Object.assign(live, { pingzhong: true, pingzhongCodes: null, gzlist: true, fundgz: true, fundmob: true }, overrides);
}

/** 构造一个内存版 store，实现 task-3 的冻结契约。 */
function fakeStore(initial) {
	const data = structuredClone(initial ?? { holdings: {}, navSnapshots: {}, navHistory: {} });
	return {
		data,
		readOtcFund: () => data,
		writeOtcFund: () => true,
		withOtcFundLock: (fn) => fn(),
		upsertHolding: (d, input) => {
			d.holdings[input.code] = { name: input.name, shares: input.shares, costNav: input.costNav, lateDisclosure: input.lateDisclosure };
			return d;
		},
		deleteHolding: (d, code) => {
			delete d.holdings[code];
			return d;
		},
		appendNavHistory: () => data,
	};
}

/** 建一个最小 req/res 对，用来直接调用路由 handler。 */
function makeReqRes({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
	const req = {
		method,
		url,
		headers,
		socket: { remoteAddress: "127.0.0.1" },
		on(event, fn) {
			if (event === "data" && body !== "") fn(Buffer.from(body, "utf8"));
			if (event === "end") fn();
			return this;
		},
		destroy() {},
	};
	const res = {
		statusCode: 0,
		headers: {},
		payload: "",
		writeHead(status, hdrs) {
			this.statusCode = status;
			this.headers = hdrs ?? {};
			return this;
		},
		end(chunk) {
			this.payload = chunk ?? "";
			return this;
		},
	};
	return { req, res };
}

function routeFor(routes, path) {
	const route = routes.find((r) => r.path === path);
	assert.ok(route, `未找到路由 ${path}`);
	return route;
}

/** 一套完整的场外基金路由（内存 store），用于只测信任围栏、不关心数据的场景。 */
function fenceRoutes() {
	return makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
}

/** 写请求的 JSON 体：makeReqRes 直接把字符串塞进流里，所以调用方必须自己序列化。 */
function jsonBodyOf(value) {
	return JSON.stringify(value);
}

//#endregion

//#region 1) pingzhongdata 解析

section("1) pingzhongdata 解析");
reset();

ok("BOM 被剥掉，名称取得干净", () => {
	const p = parsePingzhong("\uFEFFvar fS_name = \"融通医疗保健行业混合A/B\";", "161616");
	assert.equal(p.name, "融通医疗保健行业混合A/B");
});

ok("净值历史按日期升序且升到 3 个点", () => {
	const p = parsePingzhong(pingzhongFixture(), "161616");
	assert.equal(p.navHistory.length, 3);
	assert.deepEqual(
		p.navHistory.map((x) => x.date),
		["2026-10-26", "2026-10-27", "2026-11-01"]
	);
	assert.equal(p.latestNav, 1.606);
	assert.equal(p.latestDate, "2026-11-01");
});

ok("毫秒时间戳按东八区换算日期（与宿主机时区无关）", () => {
	// 1793462400000 = 2026-10-31T16:00:00Z = 2026-11-01T00:00:00+08:00
	const p = parsePingzhong('var fS_name = "x";var Data_netWorthTrend = [{"x":1793462400000,"y":1.1}];', "161616");
	assert.equal(p.navHistory[0].date, "2026-11-01");
});

ok("阶段收益 / 规模 / 经理都解析出来", () => {
	const p = parsePingzhong(pingzhongFixture(), "161616");
	assert.equal(p.returns.y1, -7.44);
	assert.equal(p.returns.m1, -13.24);
	assert.equal(p.scale, 5.78);
	assert.equal(p.scaleHistory.length, 2);
	assert.equal(p.manager.name, "刘曦阳");
	assert.equal(p.cumulativeNav, 2.986);
});

ok("括号配平：字符串里的分号/方括号不会截断字面量", () => {
	const tricky =
		'var fS_name = "A;B[C]";var Data_netWorthTrend = [{"x":1792944000000,"y":1.5,"unitMoney":"每份派现金0.1元;含[税]"}];';
	const p = parsePingzhong(tricky, "161616");
	assert.equal(p.name, "A;B[C]");
	assert.equal(p.navHistory.length, 1);
	assert.equal(p.navHistory[0].nav, 1.5);
});

ok("整份为空/畸形：不抛，返回空历史并保留代码作为名字", () => {
	const p = parsePingzhong("", "999999");
	assert.equal(p.name, "999999");
	assert.equal(p.latestNav, null);
	assert.deepEqual(p.navHistory, []);
});

ok("净值为 0 或非有限值的点被丢弃（不让假净值进曲线）", () => {
	const p = parsePingzhong(
		'var fS_name = "x";var Data_netWorthTrend = [{"x":1792944000000,"y":0},{"x":1793030400000,"y":null},{"x":1793462400000,"y":1.2}];',
		"161616"
	);
	assert.equal(p.navHistory.length, 1);
	assert.equal(p.latestNav, 1.2);
});

//#endregion

//#region 2) 估值链与降级

section("2) 估值链与降级");

await okAsync("估值榜命中 → 估值可用，时点归一成 YYYY-MM-DD HH:mm", async () => {
	reset();
	gzListRows = [{ FCODE: "161616", GSZ: "1.6120", GSZZL: "0.37", GZTIME: "2026-11-03 14:30" }];
	const p = await fetchFundProfile("161616", { fresh: true });
	assert.equal(p.estimateAvailable, true);
	assert.equal(p.estimateNav, 1.612);
	assert.equal(p.estimateTime, "2026-11-03 14:30");
	assert.equal(p.estimateSource, "gzlist");
});

await okAsync("估值榜空 → 回落到 JSONP 估值", async () => {
	reset();
	gzListRows = null;
	const p = await fetchFundProfile("161616", { fresh: true });
	assert.equal(p.estimateAvailable, true);
	assert.equal(p.estimateSource, "fundgz");
	assert.equal(p.estimateTime, "2026-11-03 14:30");
});

await okAsync("估值榜空 + JSONP 已下线（404 HTML）→ 回落到 App 接口", async () => {
	reset({ fundgz: false });
	gzListRows = null;
	// App 接口今日 GSZ 为 null —— 估值仍需标不可用
	const p = await fetchFundProfile("161616", { fresh: true });
	assert.equal(p.estimateAvailable, false);
	assert.equal(p.estimateSource, "nav");
	assert.equal(p.estimateNav, p.latestNav, "估值不可用时 estimateNav 应回落到已披露净值");
	assert.equal(p.estimateTime, "");
});

await okAsync("全部估值源不可用 → estimateAvailable=false 且估值=已披露净值", async () => {
	reset({ gzlist: false, fundgz: false, fundmob: false });
	const p = await fetchFundProfile("161616", { fresh: true });
	assert.equal(p.estimateAvailable, false);
	assert.equal(p.estimateNav, 1.606);
	assert.equal(p.stale, false);
});

await okAsync("JSONP 失败一次后熔断：后续不再打网络", async () => {
	reset({ fundgz: false, gzlist: false });
	await fetchFundProfile("161616", { fresh: true });
	const before = calls.filter((c) => c.url.includes("fundgz.1234567")).length;
	await fetchFundProfile("161616", { fresh: true });
	const after = calls.filter((c) => c.url.includes("fundgz.1234567")).length;
	assert.equal(after, before, "熔断期内不应重复打已下线的 JSONP 源");
});

//#endregion

//#region 3) 净值兜底与错误

section("3) 净值兜底与错误");

await okAsync("pingzhongdata 挂掉 → 用 App 接口净值兜底，并标 stale", async () => {
	reset({ pingzhong: false });
	const p = await fetchFundProfile("161616", { fresh: true });
	assert.equal(p.latestNav, 1.606);
	assert.equal(p.latestDate, "2026-11-02");
	assert.equal(p.stale, true, "兜底净值应标记数据未更新");
	assert.deepEqual(p.navHistory, [], "兜底路径没有历史曲线");
});

await okAsync("两个净值源全挂 → 抛中文错误", async () => {
	reset({ pingzhong: false, fundmob: false });
	await assert.rejects(
		() => fetchFundProfile("161616", { fresh: true }),
		(error) => {
			assert.match(error.message, /净值暂时取不到/);
			assert.match(error.message, /[\u4e00-\u9fa5]/, "错误文案必须是中文");
			return true;
		}
	);
});

await okAsync("非法代码 → 中文错误且不发请求", async () => {
	reset();
	for (const bad of ["", "abc", "12345", "1234567", null, undefined]) {
		await assert.rejects(
			() => fetchFundProfile(bad, { fresh: true }),
			(error) => /基金代码无法识别/.test(error.message)
		);
	}
	assert.equal(calls.length, 0, "非法代码不该产生任何网络请求");
});

await okAsync("请求上游时带 referer（不带会被回 404 页）", async () => {
	reset();
	await fetchFundProfile("161616", { fresh: true });
	const hit = calls.find((c) => c.url.includes("pingzhongdata/"));
	assert.ok(hit, "应当请求 pingzhongdata");
	const headers = hit.headers ?? {};
	const referer = headers.referer ?? headers.Referer ?? "";
	assert.match(String(referer), /fund\.eastmoney\.com/);
});

//#endregion

//#region 4) 指标口径

section("4) 指标口径");

ok("跌破成本：距离为负、未解套、进度与距离同值", () => {
	const m = computeFundMetrics({ shares: 10838.9, costNav: 1.9513 }, { latestNav: 1.606, estimateActive: false, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, -17.7);
	assert.equal(m.unwindProgressPct, m.distanceToCostPct);
	assert.equal(m.unwound, false);
	assert.ok(Math.abs(m.marketValue - 10838.9 * 1.606) < 1e-9);
	// 解套需涨：分母是当前净值，(1.9513-1.606)/1.606 = 21.5006...% → 21.5
	// 注意它与 |distanceToCostPct| (17.7) **不相等**，分母不同，别互相换算。
	assert.equal(m.neededRisePct, 21.5);
});

ok("解套需涨与距成本线是两个不同的数（分母不同，容易写混）", () => {
	const m = computeFundMetrics({ shares: 1, costNav: 2 }, { latestNav: 1, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, -50); // (1-2)/2
	assert.equal(m.neededRisePct, 100); // (2-1)/1，需要翻倍
	assert.notEqual(Math.abs(m.distanceToCostPct), m.neededRisePct);
});

ok("高于成本：已解套，解套需涨为 0（不是负数）", () => {
	const m = computeFundMetrics({ shares: 1000, costNav: 1.5 }, { latestNav: 1.6, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, 6.67);
	assert.equal(m.unwound, true);
	assert.equal(m.neededRisePct, 0, "已解套就不需要再涨，给 0 而不是负的需涨");
});

ok("刚好等于成本：已解套，需涨 0", () => {
	const m = computeFundMetrics({ shares: 1000, costNav: 1.5 }, { latestNav: 1.5, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, 0);
	assert.equal(m.unwound, true);
	assert.equal(m.neededRisePct, 0);
});

ok("估值可用时以估值为准，而不是已披露净值", () => {
	const m = computeFundMetrics(
		{ shares: 1000, costNav: 1.5 },
		{ latestNav: 1.6, estimateNav: 1.65, estimateAvailable: true }
	);
	assert.equal(m.distanceToCostPct, 10);
	assert.equal(m.neededRisePct, 0, "估值 1.65 > 成本 1.5，已解套");
});

ok("缺成本净值 → 距离/进度/需涨为 null（不是 0，0 会被读成已解套）", () => {
	const m = computeFundMetrics({ shares: 1000 }, { latestNav: 1.6, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, null);
	assert.equal(m.unwindProgressPct, null);
	assert.equal(m.unwound, false);
	assert.equal(m.neededRisePct, null);
	assert.equal(m.pnl, null);
});

ok("缺净值 → 全部为 null", () => {
	const m = computeFundMetrics({ shares: 1000, costNav: 1.5 }, { latestNav: null, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, null);
	assert.equal(m.marketValue, null);
});

ok("成本净值 <= 0 时不做除法（不产生 Infinity）", () => {
	const m = computeFundMetrics({ shares: 1000, costNav: 0 }, { latestNav: 1.6, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, null);
});

ok("百分比保留两位小数", () => {
	const m = computeFundMetrics({ shares: 1, costNav: 3 }, { latestNav: 2, estimateAvailable: false });
	assert.equal(m.distanceToCostPct, -33.33);
});

//#endregion

//#region 5) 路由：snapshot

section("5) 路由：snapshot");

ok("FUND_ROUTES 路径与方案一致", () => {
	assert.equal(FUND_ROUTES.otcFundSnapshot, "/api/leekbox/otc-fund/snapshot");
	assert.equal(FUND_ROUTES.otcFundMutate, "/api/leekbox/otc-fund/mutate");
});

await okAsync("snapshot：键集合、数值、summary 汇总都对", async () => {
	// 关掉估值源，让 nav 稳定等于已披露净值 1.606（否则断言会随估值链变化而漂）
	reset({ gzlist: false, fundgz: false });
	const store = fakeStore({
		holdings: {
			"161616": { name: "融通医疗", shares: 1000, costNav: 1.5 },
			"005827": { name: "易方达蓝筹", shares: 2000, costNav: 2.0 },
		},
		navSnapshots: {},
		navHistory: {},
	});
	const routes = makeOtcFundRoutes(
		{},
		{
			dshHome: "C:/tmp/dsh-home",
			store,
		}
	);
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1:51370" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);

	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.payload);
	assert.deepEqual(Object.keys(body).sort(), ["funds", "summary", "updatedAt"]);
	assert.equal(body.funds.length, 2);
	assert.deepEqual(
		Object.keys(body.funds[0]).sort(),
		["code", "costNav", "distanceToCostPct", "estimateAvailable", "estimateNav", "estimateTime", "latestDate", "latestNav", "marketValue", "name", "neededRisePct", "pnl", "shares", "stale", "unwindProgressPct", "unwound"]
	);
	const row = body.funds.find((f) => f.code === "161616");
	assert.equal(row.shares, 1000);
	assert.equal(row.costNav, 1.5);
	assert.equal(row.latestNav, 1.606);
	assert.equal(row.distanceToCostPct, 7.07);
	assert.equal(row.unwound, true);
	assert.equal(row.neededRisePct, 0, "已解套则需涨 0");
	// 逐行市值/浮盈：界面直接渲染，不在客户端算。
	// 逐行**不四舍五入**（只有 summary 金额舍入到分）：1000*(1.606-1.5) 的浮点尾巴
	// 106.0000000000001 属预期，别为了让它"好看"而引入舍入。
	assert.equal(row.marketValue, 1606);
	assert.ok(Math.abs(row.pnl - 106) < 1e-9, `逐行浮盈应为 106（浮点尾巴可接受），实际 ${row.pnl}`);
	assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
	assert.equal(typeof body.summary.fundMarketValue, "number");
	assert.equal(typeof body.summary.fundTotalPnl, "number");
	assert.deepEqual(
		Object.keys(body.summary).sort(),
		["fundMarketValue", "fundTotalCost", "fundTotalPnl", "fundTotalReturnPct"]
	);
	assert.equal(body.summary.fundTotalCost, 5500, "成本 = Σ(份额 × 成本净值) = 1000×1.5 + 2000×2.0");
	assert.equal(body.summary.fundTotalReturnPct, -12.4, "收益率 = 浮盈 / 成本 = -682 / 5500");
});

await okAsync("snapshot：全部持仓都取不到净值 → 市值/浮盈/收益率为 null，成本照常给（只依赖份额）", async () => {
	// 这是最危险的一种假数据：明明有持仓、只是今天取不到数，却报 0 市值 0 浮盈，
	// 界面会照着渲染成"基金市值 0.00"，比报错更误导（用户可能以为仓位没了）。
	reset({ pingzhong: false, gzlist: false, fundgz: false, fundmob: false });
	const store = fakeStore({
		holdings: { "161616": { shares: 1000, costNav: 1.5 }, "005827": { shares: 2000, costNav: 2.0 } },
		navSnapshots: {},
		navHistory: {},
	});
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	const body = JSON.parse(res.payload);
	assert.equal(body.funds.length, 2);
	for (const row of body.funds) {
		assert.equal(row.marketValue, null, `${row.code} 取不到净值时市值必须是 null`);
		assert.equal(row.stale, true);
	}
	assert.equal(body.summary.fundMarketValue, null, "有持仓但全取不到 → 市值必须是 null，不能是 0");
	assert.equal(body.summary.fundTotalPnl, null, "同理浮盈也不能是 0");
	assert.equal(body.summary.fundTotalCost, 5500, "成本只依赖份额与成本净值，取不到净值不影响它");
	assert.equal(body.summary.fundTotalReturnPct, null, "浮盈未知时不给收益率");
});

await okAsync("snapshot：只有部分持仓取到净值 → summary 也为 null（部分和不冒充总额）", async () => {
	// 关掉所有兜底源，只让 pingzhong 对 161616 放行
	reset({ gzlist: false, fundgz: false, fundmob: false, pingzhongCodes: new Set(["161616"]) });
	const store = fakeStore({
		holdings: { "161616": { shares: 1000, costNav: 1.5 }, "005827": { shares: 2000, costNav: 2.0 } },
		navSnapshots: {},
		navHistory: {},
	});
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	const body = JSON.parse(res.payload);
	assert.equal(body.funds.find((f) => f.code === "161616").marketValue, 1606);
	assert.equal(body.funds.find((f) => f.code === "005827").marketValue, null);
	assert.equal(body.summary.fundMarketValue, null, "只有一只算得出来时，不能把它的市值当总额");
	assert.equal(body.summary.fundTotalPnl, null, "浮盈同理：不把已知那只的 106 当总额");
	assert.equal(body.summary.fundTotalCost, 5500, "成本完整（两只的份额/成本净值都齐）");
	assert.equal(body.summary.fundTotalReturnPct, null, "浮盈未知 → 收益率不给");
});

await okAsync("snapshot：空持仓 → summary 是 0（这是『确实没有』，不是『不知道』）", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store: fakeStore() });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	const body = JSON.parse(res.payload);
	assert.deepEqual(body.funds, []);
	assert.equal(body.summary.fundMarketValue, 0, "没买基金就是 0，与『取不到数』要区分开");
	assert.equal(body.summary.fundTotalPnl, 0);
	assert.equal(body.summary.fundTotalCost, 0);
	assert.equal(body.summary.fundTotalReturnPct, null, "成本为 0 不做除法，与自选页一致");
});

await okAsync("snapshot：缺份额 → 市值/浮盈为 null（不是 0 份）", async () => {
	reset({ gzlist: false, fundgz: false });
	const store = fakeStore({ holdings: { "161616": { costNav: 1.5 } }, navSnapshots: {}, navHistory: {} });
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	const body = JSON.parse(res.payload);
	const row = body.funds[0];
	assert.equal(row.shares, null, "份额缺失就是 null，不能补成 0 份");
	assert.equal(row.marketValue, null);
	assert.equal(body.summary.fundTotalCost, null, "份额缺失 → 成本也算不出来");
	assert.equal(body.summary.fundTotalReturnPct, null);
	assert.equal(row.pnl, null);
	// 距成本线只依赖净值与成本，份额缺失不影响它
	assert.equal(row.distanceToCostPct, 7.07);
});

await okAsync("snapshot：?codes= 显式查询在无持仓文件时也能用（存储层降级）", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/nonexistent-home" });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundSnapshot}?codes=161616`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.payload);
	assert.equal(body.funds.length, 1);
	assert.equal(body.funds[0].costNav, null);
	assert.equal(body.funds[0].distanceToCostPct, null);
});

await okAsync("snapshot：非法 codes → 400 + 中文错误", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundSnapshot}?codes=abc`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.payload).error, /基金代码无法识别/);
});

await okAsync("snapshot：单只基金取数失败 → 该行 stale=true 而不是整页 502", async () => {
	reset({ pingzhong: false, fundmob: false });
	const store = fakeStore({ holdings: { "161616": { shares: 1000, costNav: 1.5 } }, navSnapshots: {}, navHistory: {} });
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.payload);
	assert.equal(body.funds[0].stale, true);
	assert.equal(body.funds[0].latestNav, null);
	assert.equal(body.funds[0].distanceToCostPct, null);
});

await okAsync("snapshot：非本机来源 → 403", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	req.socket.remoteAddress = "10.0.0.9";
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 403);
	assert.match(JSON.parse(res.payload).error, /仅允许本机请求/);
});

await okAsync("history：历史净值 + 阶段涨幅（口径在 Host，客户端只渲染）", async () => {
	reset({ gzlist: false, fundgz: false });
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store: fakeStore() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundHistory}?code=161616`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundHistory).handler(req, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.payload);
	assert.deepEqual(
		Object.keys(body).sort(),
		["code", "estimateAvailable", "estimateNav", "estimateTime", "fund", "latestDate", "latestNav", "name", "navHistory", "stageReturns", "tracked", "updatedAt"]
	);
	assert.equal(body.code, "161616");
	assert.deepEqual(Object.keys(body.stageReturns).sort(), ["d1", "m1", "m3", "m6", "since", "y1", "y3"]);
	assert.ok(Array.isArray(body.navHistory), "必须给出历史净值数组（详情页要画曲线）");
	assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
	// 持仓字段必须由 Host 从持仓文件算好带出来（详情页「我的持仓」直接渲染它）：
	// 调用方从行情页搜索打开时只带 {code,name}，靠 prop 会整片显示"—"。
	assert.equal(body.tracked, false, "空持仓 → tracked 为 false");
	assert.equal(body.fund.shares, null);
	assert.equal(body.fund.costNav, null);
	assert.deepEqual(
		Object.keys(body.fund).sort(),
		["code", "costNav", "distanceToCostPct", "estimateAvailable", "estimateNav", "estimateTime", "latestDate", "latestNav", "marketValue", "name", "neededRisePct", "pnl", "shares", "stale", "unwindProgressPct", "unwound"]
	);
});

await okAsync("history：已有持仓时 tracked=true，份额/成本/市值/浮盈照常算", async () => {
	reset({ gzlist: false, fundgz: false });
	const store = fakeStore({ holdings: { "161616": { shares: 1000, costNav: 1.5 } }, navSnapshots: {}, navHistory: {} });
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/dsh-home", store });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundHistory}?code=161616`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundHistory).handler(req, res);
	const body = JSON.parse(res.payload);
	assert.equal(body.tracked, true, "在持仓里 → tracked 为 true（按钮显示「移出」）");
	assert.equal(body.fund.shares, 1000);
	assert.equal(body.fund.costNav, 1.5);
	assert.equal(body.fund.marketValue, 1606, "市值 = 份额 × 最新净值");
	assert.ok(Math.abs(body.fund.pnl - 106) < 1e-9);
});

await okAsync("positions：前十大重仓 + 实时涨跌（港股不给行情，不编造）", async () => {
	reset({ gzlist: false, fundgz: false });
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore(), quoteProvider: async () => new Map([["sh600519", { price: 1500, changePct: 1.2 }]]) });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundPositions}?code=005827`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundPositions).handler(req, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.payload);
	assert.equal(body.code, "005827");
	assert.ok(Array.isArray(body.positions) && body.positions.length > 0, "必须给出重仓股列表");
	assert.deepEqual(Object.keys(body.positions[0]).sort(), ["changePct", "changeType", "changeVsPrev", "code", "exchange", "name", "price", "weight"]);
	// 只喂了 sh600519 的报价：那一条应取到现价/涨跌幅，其余保持 null
	const mt = body.positions.find((p) => p.code === "600519");
	assert.equal(mt.price, 1500);
	assert.equal(mt.changePct, 1.2);
	const other = body.positions.find((p) => p.code !== "600519");
	assert.equal(other.price, null, "拿不到行情就给 null，不能编造");
	assert.equal(other.changePct, null);
});

await okAsync("positions：非法 code → 400", async () => {
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundPositions}?code=xx`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundPositions).handler(req, res);
	assert.equal(res.statusCode, 400);
});

await okAsync("positions：接口限流（Datas:null）→ 502，不伪装成「没有持仓」", async () => {
	// ErrCode 61136403「网络繁忙」是**取不到**，不是**没有**：若返回空列表，
	// 界面会显示「暂无持仓披露数据」，把一次限流伪装成"这只基金没有重仓股"。
	reset();
	posThrottled = true;
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore(), quoteProvider: async () => new Map() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundPositions}?code=005827`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundPositions).handler(req, res);
	assert.equal(res.statusCode, 502, "限流必须如实报错，而不是 200 + 空列表");
	assert.match(JSON.parse(res.payload).error, /网络繁忙|请稍后重试/);
});

await okAsync("history：非法 code → 400（不悄悄回退成默认基金）", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundHistory}?code=abc`, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundHistory).handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.payload).error, /基金代码无法识别/);
});

await okAsync("history：方法不对 → 405", async () => {
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ url: `${FUND_ROUTES.otcFundHistory}?code=161616`, method: "POST", headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundHistory).handler(req, res);
	assert.equal(res.statusCode, 405);
});

await okAsync("snapshot：方法不对 → 405", async () => {
	reset();
	const routes = makeOtcFundRoutes({}, { dshHome: "C:/tmp/x", store: fakeStore() });
	const { req, res } = makeReqRes({ method: "POST", url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 405);
});

//#endregion

//#region 5b) 信任围栏的细节

section("5b) 信任围栏细节");

await okAsync("IPv6 loopback（[::1]）必须放行 —— URL.hostname 带方括号，比较前要剥掉", async () => {
	reset();
	const routes = fenceRoutes();
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: { host: "[::1]:51370", origin: "http://[::1]:51370", "content-type": "application/json" },
		body: jsonBodyOf({ action: "delete", code: "161616" }),
	});
	req.socket.remoteAddress = "::1";
	await routeFor(routes, FUND_ROUTES.otcFundMutate).handler(req, res);
	assert.notEqual(res.statusCode, 403, "从 IPv6 loopback 打开界面时保存不该被判成跨站");
	assert.equal(res.statusCode, 200);
});

await okAsync("Host 头里的 IPv6 也放行（两条路径口径一致）", async () => {
	reset();
	const routes = fenceRoutes();
	const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "[::1]:51370" } });
	req.socket.remoteAddress = "::1";
	await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
	assert.equal(res.statusCode, 200);
});

await okAsync("content-type 必须是 JSON 媒体类型本身：夹带 / 后缀 / text-plain 都不行", async () => {
	reset();
	const routes = fenceRoutes();
	const bad = [
		"application/jsonx",
		"text/plain; x=application/json",
		"text/plain",
		"application/x-www-form-urlencoded",
	];
		for (const ct of bad) {
		const { req, res } = makeReqRes({
			method: "POST",
			url: FUND_ROUTES.otcFundMutate,
			headers: { host: "127.0.0.1", "content-type": ct },
			body: jsonBodyOf({ action: "delete", code: "161616" }),
		});
		await routeFor(routes, FUND_ROUTES.otcFundMutate).handler(req, res);
		assert.equal(res.statusCode, 415, `content-type=${ct} 必须 415`);
	}
	// 带 charset 参数是合法的
	const okRes = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: { host: "127.0.0.1", "content-type": "application/json; charset=utf-8" },
		body: jsonBodyOf({ action: "delete", code: "161616" }),
	});
	await routeFor(routes, FUND_ROUTES.otcFundMutate).handler(okRes.req, okRes.res);
	assert.equal(okRes.res.statusCode, 200, "application/json; charset=utf-8 必须放行");
});

await okAsync("外站 Origin 一律 403（含伪装成本机域名的那些）", async () => {
	reset();
	const routes = fenceRoutes();
	for (const origin of ["https://evil.example", "http://127.0.0.1.evil.com", "http://127.0.0.1@evil.com", "null"]) {
		const { req, res } = makeReqRes({
			method: "POST",
			url: FUND_ROUTES.otcFundMutate,
			headers: { host: "127.0.0.1", origin, "content-type": "application/json" },
			body: jsonBodyOf({ action: "delete", code: "161616" }),
		});
		await routeFor(routes, FUND_ROUTES.otcFundMutate).handler(req, res);
		assert.equal(res.statusCode, 403, `Origin=${origin} 必须 403`);
	}
});

await okAsync("127.x 网段都算本机；10.x / ::ffff:8.8.8.8 不算", async () => {
	reset();
	const routes = fenceRoutes();
	for (const addr of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
		const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
		req.socket.remoteAddress = addr;
		await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
		assert.equal(res.statusCode, 200, `${addr} 应视为本机`);
	}
	for (const addr of ["10.0.0.5", "::ffff:8.8.8.8", "192.168.1.2"]) {
		const { req, res } = makeReqRes({ url: FUND_ROUTES.otcFundSnapshot, headers: { host: "127.0.0.1" } });
		req.socket.remoteAddress = addr;
		await routeFor(routes, FUND_ROUTES.otcFundSnapshot).handler(req, res);
		assert.equal(res.statusCode, 403, `${addr} 必须拒绝`);
	}
});

//#endregion

//#region 6) 路由：mutate

section("6) 路由：mutate");

function mutateCtx(store) {
	const routes = makeOtcFundRoutes(
		{},
		{ dshHome: "C:/tmp/x", store }
	);
	return routeFor(routes, FUND_ROUTES.otcFundMutate);
}

const JSON_HEADERS = { host: "127.0.0.1:51370", "content-type": "application/json" };

await okAsync("upsert 写入并返回 {ok:true}", async () => {
	reset();
	const store = fakeStore();
	const route = mutateCtx(store);
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: JSON_HEADERS,
		body: JSON.stringify({ action: "upsert", code: "161616", name: "融通医疗", shares: 10838.9, costNav: 1.9513 }),
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.payload), { ok: true });
	assert.equal(store.data.holdings["161616"].shares, 10838.9);
	assert.equal(store.data.holdings["161616"].costNav, 1.9513);
});

await okAsync("delete 删除持仓", async () => {
	reset();
	const store = fakeStore({ holdings: { "161616": { shares: 1, costNav: 1 } }, navSnapshots: {}, navHistory: {} });
	const route = mutateCtx(store);
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: JSON_HEADERS,
		body: JSON.stringify({ action: "delete", code: "161616" }),
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 200);
	assert.equal(store.data.holdings["161616"], undefined);
});

await okAsync("非法 action → 400 + ok:false", async () => {
	reset();
	const route = mutateCtx(fakeStore());
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: JSON_HEADERS,
		body: JSON.stringify({ action: "explode", code: "161616" }),
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 400);
	const body = JSON.parse(res.payload);
	assert.equal(body.ok, false);
	assert.match(body.error, /不支持的操作/);
});

await okAsync("份额/成本非法 → 400 + 中文错误", async () => {
	reset();
	const route = mutateCtx(fakeStore());
	for (const bad of [{ shares: -1, costNav: 1 }, { shares: 1, costNav: 0 }, { shares: "x", costNav: 1 }]) {
		const { req, res } = makeReqRes({
			method: "POST",
			url: FUND_ROUTES.otcFundMutate,
			headers: JSON_HEADERS,
			body: JSON.stringify({ action: "upsert", code: "161616", ...bad }),
		});
		await route.handler(req, res);
		assert.equal(res.statusCode, 400);
		assert.equal(JSON.parse(res.payload).ok, false);
	}
});

await okAsync("跨站 Origin → 403（CSRF 锁）", async () => {
	reset();
	const route = mutateCtx(fakeStore());
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: { ...JSON_HEADERS, origin: "https://evil.example" },
		body: JSON.stringify({ action: "delete", code: "161616" }),
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 403);
});

await okAsync("非 JSON content-type → 415", async () => {
	reset();
	const route = mutateCtx(fakeStore());
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: { host: "127.0.0.1", "content-type": "text/plain" },
		body: "{}",
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 415);
});

await okAsync("坏 JSON → 400", async () => {
	reset();
	const route = mutateCtx(fakeStore());
	const { req, res } = makeReqRes({ method: "POST", url: FUND_ROUTES.otcFundMutate, headers: JSON_HEADERS, body: "{oops" });
	await route.handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.payload).error, /不是合法 JSON/);
});

await okAsync("写失败 → ok:false（不谎报成功）", async () => {
	reset();
	const store = fakeStore();
	store.writeOtcFund = () => false;
	const route = mutateCtx(store);
	const { req, res } = makeReqRes({
		method: "POST",
		url: FUND_ROUTES.otcFundMutate,
		headers: JSON_HEADERS,
		body: JSON.stringify({ action: "upsert", code: "161616", shares: 1, costNav: 1 }),
	});
	await route.handler(req, res);
	assert.equal(res.statusCode, 502);
	const body = JSON.parse(res.payload);
	assert.equal(body.ok, false);
	assert.match(body.error, /保存失败/);
});

//#endregion

//#region 7) 缓存

section("7) 缓存与单飞");

await okAsync("同一代码第二次进入缓存：不再打 pingzhongdata", async () => {
	reset();
	await fetchFundProfile("161616");
	const first = calls.filter((c) => c.url.includes("pingzhongdata/")).length;
	await fetchFundProfile("161616");
	const second = calls.filter((c) => c.url.includes("pingzhongdata/")).length;
	assert.equal(second, first, "TTL 内应命中缓存");
});

await okAsync("并发同代码只打一次上游（单飞）", async () => {
	reset();
	await Promise.all([fetchFundProfile("161616"), fetchFundProfile("161616"), fetchFundProfile("161616")]);
	const hits = calls.filter((c) => c.url.includes("pingzhongdata/")).length;
	assert.equal(hits, 1, "三个并发请求应共享同一次上游取数");
});

//#endregion

//#region 8) 可选真连冒烟

section("8) 可选真连冒烟");
if (process.env.OTC_FUND_LIVE === "1") {
	const realFetch = globalThis.fetch;
	await okAsync("真连 161616 能拿到净值与历史", async () => {
		globalThis.fetch = realFetch;
		resetRouteCachesForTests();
		resetFundSourceHealthForTests();
		const p = await fetchFundProfile("161616", { fresh: true });
		assert.match(p.name, /融通|医疗/);
		assert.ok(p.latestNav > 0);
		assert.match(p.latestDate, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(p.navHistory.length > 20);
	});
} else {
	console.log("  -- 跳过（设置 OTC_FUND_LIVE=1 可跑真连冒烟）");
}

//#endregion

clearTimeout(watchdog);
if (process.exitCode === 1) {
	console.error("\n❌ 场外基金数据层测试失败");
} else {
	console.log(`\n✅ 场外基金数据层测试通过：${passed} 项断言`);
}
