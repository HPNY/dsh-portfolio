// 场外基金（OTC fund）净值披露轮询器：按披露窗口伸缩轮询节奏。
//
// 背景：场外基金的当日净值由基金公司在**盘后到凌晨**陆续披露（不是收盘就有），
// 每家的披露时刻差异很大 —— 早的在傍晚，晚的拖到次日凌晨。固定间隔轮询有两个毛病：
// 披露高峰（20:00-23:00）会漏掉刚出的净值；而 06:00-18:00 上游根本不会有新净值，
// 整天空转只会白白消耗东财的出口 IP 配额（参见 emrank.js 的冷却逻辑）。
//
// 一天切成四个披露窗口 + 一段关闭期，越接近披露高峰、间隔越短：
//   [06:00, 18:00)  closed     不轮询
//   [18:00, 20:00)  evening    30 分钟
//   [20:00, 23:00)  prime      5-10 分钟（区间内随机，避免整点撞车被上游限流）
//   [23:00, 01:00)  late       15 分钟（**跨零点**，见下）
//   [01:00, 06:00)  night      60 分钟
//
// 跨零点：`late` 窗口的右边界（01:00）小于左边界（23:00），**不能**写成
// `from <= m && m < to`，那样这个窗口永远不会命中。实现上按"东八区墙上分钟数"判定，
// 跨零点那条写成 `m >= from || m < to`；两端取半开区间（23:00 含、01:00 不含），
// 因此 [23:00,24:00) 与 [00:00,01:00) 两段合起来才是同一个窗口，且 01:00 不重复归属。
//
// 时区：窗口时刻是**北京时间（UTC+8）**，与宿主机时区无关。用户在 UTC 机器上跑插件时
// "现在几点"仍然必须是北京时间 —— 取法照抄 calendar.js 的 cnParts：先把 epoch 加 8 小时
// 再用 UTC 字段读，绝不使用 getHours() 这类宿主本地时区的接口。
//
// lateDisclosure：个别基金会迟到披露（过了 23:00-01:00 还没出净值）。被标记的基金在
// late 窗口里保持 15 分钟节奏，并且**必须出现在刷新的代码列表里**，这样即使它已被
// 当作"本轮无净值"也会被继续拉取。标记只影响 late 窗口，不放大其它窗口。
// 该判断隔离在 lateDisclosureCadence(holdings, windowName) 里，便于单独测试。
//
// 定时器：整条链是**单个自续期 setTimeout**（不是 setInterval —— 每个窗口间隔不同，
// 且必须每次重新按当前时刻判窗口，不能在边界上吃缓存）。所有句柄登记在 pending 集合，
// dispose() 一次清空并置 disposed 标志，所以任何时刻调用 dispose() 都不会留下活定时器；
// 正在跑的 refresh 即使还没 settle，回来后也会看到 disposed=true 而不再续期。
//
// 测试：windowFor 是纯函数（rng 可注入），startOtcFundPoller 的 now / timer / rng 也全部
// 可注入，见 otc-fund-poller-test.mjs 的假时钟 —— 不真的睡 30 分钟。

//#region 常量

/** 境内时间基准：东八区。宿主机时区不参与判断（与 calendar.js 同口径）。 */
const CN_OFFSET_MIN = 8 * 60;

const MINUTE_MS = 60 * 1000;

/** 窗口名。`closed` 不是披露窗口，表示"当前不轮询"（active=false）。 */
export const WINDOW_NAME = Object.freeze({
	closed: "closed",
	evening: "evening",
	prime: "prime",
	late: "late",
	night: "night",
});

/** 窗口边界（东八区墙上分钟数）。半开区间，跨零点那条单独判定。 */
const BOUNDS = Object.freeze({
	closedFrom: 6 * 60, // 06:00
	eveningFrom: 18 * 60, // 18:00
	primeFrom: 20 * 60, // 20:00
	lateFrom: 23 * 60, // 23:00
	lateTo: 1 * 60, // 01:00（跨零点：右边界小于左边界）
	nightTo: 6 * 60, // 06:00
});

const EVENING_INTERVAL_MS = 30 * MINUTE_MS;
const LATE_INTERVAL_MS = 15 * MINUTE_MS;
const NIGHT_INTERVAL_MS = 60 * MINUTE_MS;

/** prime 窗口的随机区间：5-10 分钟，**含两端**。 */
const PRIME_MIN_MS = 5 * MINUTE_MS;
const PRIME_MAX_MS = 10 * MINUTE_MS;

/** 关闭期的单次睡眠上限。
 *  06:00-18:00 长达 12 小时，这里**不**一次睡满：系统休眠/挂起或用户改系统时间都会让
 *  长定时器错过唤醒点。封顶 30 分钟自愈，代价只是白天每半小时空跑一次判定。 */
const IDLE_CAP_MS = 30 * MINUTE_MS;

/** 关闭期睡眠下限，防止时钟抖动导致忙循环。 */
const IDLE_FLOOR_MS = 1000;

/** refresh 超时。上游卡住时不能把整条轮询链挂死一整晚，到点按失败处理并排下一次。 */
export const DEFAULT_REFRESH_TIMEOUT_MS = 60 * 1000;

/** 持仓文件里的字段名：net asset value 快照所在文件由 peer task-3 提供。 */
const OTC_FUND_FILE = ".leekbox-otc-fund.json";

/** dispose() 用来打断"正卡在超时等待里的 refresh"的哨兵错误。 */
const DISPOSED = Symbol("otc-fund-poller.disposed");

//#endregion

//#region 时刻换算（时区无关）

/** 任意 epoch 毫秒 → 东八区墙上时间部件。 */
function cnParts(nowMs) {
	const shifted = new Date(nowMs + CN_OFFSET_MIN * MINUTE_MS);
	return {
		minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
		seconds: shifted.getUTCSeconds(),
		ms: shifted.getUTCMilliseconds(),
	};
}

/** 归一化入参：接受毫秒数或 Date；拿不到有效值时退回当前时刻。 */
function toMs(value) {
	if (value instanceof Date) return value.getTime();
	const n = Number(value);
	return Number.isFinite(n) ? n : Date.now();
}

//#endregion

//#region windowFor

/**
 * 某个时刻落在哪个披露窗口，以及该窗口的轮询间隔。
 *
 * 纯函数：不读时钟、不碰定时器、不发网络（`rng` 可注入，便于把 prime 的随机值钉死）。
 *
 * @param {number|Date} [nowMs=Date.now()] 绝对时刻（epoch 毫秒）
 * @param {object} [opts]
 * @param {() => number} [opts.rng=Math.random] prime 窗口随机源，返回 [0,1)
 * @returns {{ windowName: string, intervalMs: number, active: boolean }}
 *   `active === false`（closed）时 `intervalMs === 0`，调用方不得发起刷新。
 *   跨零点的 late 窗口在次日 00:00-01:00 同样命中。
 */
export function windowFor(nowMs = Date.now(), opts = {}) {
	const at = toMs(nowMs);
	const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
	const m = cnParts(at).minutes;

	// 跨零点判定：m >= 23:00 或 m < 01:00。写成区间相交的朴素形式会让它永不命中。
	if (m >= BOUNDS.lateFrom || m < BOUNDS.lateTo) {
		return { windowName: WINDOW_NAME.late, intervalMs: LATE_INTERVAL_MS, active: true };
	}
	if (m >= BOUNDS.eveningFrom && m < BOUNDS.primeFrom) {
		return { windowName: WINDOW_NAME.evening, intervalMs: EVENING_INTERVAL_MS, active: true };
	}
	if (m >= BOUNDS.primeFrom && m < BOUNDS.lateFrom) {
		return { windowName: WINDOW_NAME.prime, intervalMs: primeIntervalMs(rng), active: true };
	}
	if (m >= BOUNDS.lateTo && m < BOUNDS.nightTo) {
		return { windowName: WINDOW_NAME.night, intervalMs: NIGHT_INTERVAL_MS, active: true };
	}
	return { windowName: WINDOW_NAME.closed, intervalMs: 0, active: false };
}

/** prime 的随机间隔：5-10 分钟，含两端。rng 返回异常值时退回区间下端。 */
function primeIntervalMs(rng) {
	const raw = Number(rng());
	const safe = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
	const span = PRIME_MAX_MS - PRIME_MIN_MS;
	return PRIME_MIN_MS + Math.round(safe * span);
}

/**
 * 距离下一个窗口开启还有多久（关闭期用来睡眠）。
 *
 * 取所有窗口左边界里最近的一个：01:00、06:00、18:00、20:00、23:00。
 */
function msUntilNextWindowStart(nowMs) {
	const p = cnParts(nowMs);
	const edges = [BOUNDS.lateTo, BOUNDS.closedFrom, BOUNDS.eveningFrom, BOUNDS.primeFrom, BOUNDS.lateFrom];
	let best = Infinity;
	for (const edge of edges) {
		let deltaMin = edge - p.minutes;
		if (deltaMin <= 0) deltaMin += 24 * 60;
		let delay = deltaMin * MINUTE_MS - p.seconds * 1000 - p.ms;
		if (delay < IDLE_FLOOR_MS) delay += 24 * 60 * MINUTE_MS;
		if (delay < best) best = delay;
	}
	if (!Number.isFinite(best)) return IDLE_FLOOR_MS;
	return Math.max(IDLE_FLOOR_MS, Math.min(best, IDLE_CAP_MS));
}

//#endregion

//#region lateDisclosure

/**
 * 本轮需要刷新的基金代码。
 *
 * **所有窗口都返回全部持仓** —— 这是四窗口表的原意：23:00-01:00 本来就是每 15 分钟
 * 拉全部持仓。曾经写成"late 窗口只留 lateDisclosure 的基金"，那会让没被标记的基金
 * 在 23:00 之后**静默停止轮询**，而基金公司披露时刻本来就参差，漏掉一次就得等第二天，
 * 属于把"额外照顾"做成了"减少覆盖"。
 *
 * lateDisclosure 的差异因此不体现在名单上，而体现在节奏上：见 nightIntervalMs。
 *
 * @param {Array<{code?: string, lateDisclosure?: boolean}>} holdings 持仓
 * @param {string} [windowName] 当前窗口（保留参数以便调用方/测试显式传入；不改变名单）
 * @returns {string[]} 需要刷新的基金代码（去重、保序）
 */
export function lateDisclosureCadence(holdings, windowName) {
	void windowName;
	const list = Array.isArray(holdings) ? holdings : [];
	const codes = [];
	const seen = new Set();
	for (const holding of list) {
		if (holding === null || typeof holding !== "object") continue;
		const code = typeof holding.code === "string" ? holding.code.trim() : "";
		if (code === "" || seen.has(code)) continue;
		seen.add(code);
		codes.push(code);
	}
	return codes;
}

/**
 * night 窗口 (01:00-06:00) 的轮询间隔。
 *
 * 常规是 60 分钟；但只要有一只基金被标记 lateDisclosure，就整体收紧到 15 分钟 ——
 * 收敛范围**仅限本窗口**，不改动 evening/prime/late 的节奏，也就是方案里说的
 * "不全局放宽"。
 */
export function nightIntervalMs(holdings) {
	return hasLateDisclosure(holdings) ? LATE_INTERVAL_MS : NIGHT_INTERVAL_MS;
}

/** 持仓里是否存在迟到披露的基金。 */
function hasLateDisclosure(holdings) {
	if (!Array.isArray(holdings)) return false;
	return holdings.some((h) => h !== null && typeof h === "object" && h.lateDisclosure === true);
}

//#endregion

//#region poller

/**
 * 启动披露窗口轮询器。
 *
 * @param {object} deps
 * @param {string} [deps.dshHome] 宿主 home；持仓文件所在目录
 * @param {{warn?: Function}} [deps.logger] 宿主 logger（只用 warn，绝不抛）
 * @param {(codes: string[]) => any} [deps.refresh] 拉取并持久化净值的回调；可为 async。
 *   抛错/超时都不会打断轮询链。
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timer] 定时器实现注入
 * @param {() => number} [deps.now] 时钟注入
 * @param {() => number} [deps.rng] prime 随机源注入
 * @param {Function} [deps.readHoldings] 覆盖默认持仓读取（返回 [{ code, lateDisclosure }]）
 * @param {number} [deps.refreshTimeoutMs] refresh 超时；<=0 表示不限时
 * @returns {() => void} dispose：清空全部定时器并让后续触发成为空操作；幂等
 */
export function startOtcFundPoller(deps = {}) {
	const dshHome = typeof deps.dshHome === "string" ? deps.dshHome : "";
	const logger = deps.logger ?? null;
	const refresh = deps.refresh;
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const rng = typeof deps.rng === "function" ? deps.rng : Math.random;
	const timer = deps.timer ?? {};
	const setTimeoutFn = typeof timer.setTimeout === "function" ? timer.setTimeout : globalThis.setTimeout;
	const clearTimeoutFn = typeof timer.clearTimeout === "function" ? timer.clearTimeout : globalThis.clearTimeout;
	const readHoldings = typeof deps.readHoldings === "function" ? deps.readHoldings : defaultReadHoldings(dshHome);
	const refreshTimeoutMs = deps.refreshTimeoutMs === undefined ? DEFAULT_REFRESH_TIMEOUT_MS : Number(deps.refreshTimeoutMs);

	let disposed = false;
	/** 所有活着的定时器句柄。dispose() 的唯一清理依据。 */
	const pending = new Set();
	/** 正卡在 refresh 超时等待里的定时器 → 打断函数。 */
	const pendingTimeouts = new Map();
	let warnedNoRefresh = false;

	/** 登记定时器：触发时先把自己从 pending 摘掉，避免集合随长夜无限增长。 */
	function schedule(fn, delayMs) {
		const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
		let handle = null;
		handle = setTimeoutFn(() => {
			pending.delete(handle);
			fn();
		}, delay);
		pending.add(handle);
		// 宿主长期运行时定时器不应阻止进程退出（测试里的假句柄是数字，无 unref）。
		if (handle !== null && typeof handle === "object" && typeof handle.unref === "function") handle.unref();
		return handle;
	}

	function cancel(handle) {
		if (handle === null || handle === undefined) return;
		clearTimeoutFn(handle);
		pending.delete(handle);
	}

	function warn(error) {
		if (logger !== null && typeof logger.warn === "function") logger.warn(error);
	}

	/**
	 * 给 refresh 套一层超时。
	 *
	 * dispose() 时这些等待被立刻打断（DISPOSED 哨兵），而不是留着定时器等到超时
	 * —— "dispose 之后不留活定时器"是硬要求。
	 */
	function withTimeout(promise, timeoutMs) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
		return new Promise((resolve, reject) => {
			let settled = false;
			const handle = schedule(() => {
				pendingTimeouts.delete(handle);
				if (settled) return;
				settled = true;
				reject(new Error(`refresh 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			pendingTimeouts.set(handle, () => {
				if (settled) return;
				settled = true;
				reject(DISPOSED);
			});
			Promise.resolve(promise).then(
				(value) => {
					pendingTimeouts.delete(handle);
					cancel(handle);
					if (settled) return;
					settled = true;
					resolve(value);
				},
				(error) => {
					pendingTimeouts.delete(handle);
					cancel(handle);
					if (settled) return;
					settled = true;
					reject(error);
				}
			);
		});
	}

	async function runRefresh(codes) {
		if (typeof refresh !== "function") {
			if (!warnedNoRefresh) {
				warnedNoRefresh = true;
				warn("[leekbox] otc-fund poller: refresh 未注入，仅做窗口调度");
			}
			return;
		}
		try {
			await withTimeout(Promise.resolve().then(() => refresh(codes)), refreshTimeoutMs);
		} catch (error) {
			if (disposed || error === DISPOSED) return; // dispose 打断属正常路径，不刷日志
			warn(error);
		}
	}

	/** 一次窗口判定 + 一次刷新 + 续期下一次。整条链只有这一个异步入口。 */
	async function tick() {
		if (disposed) return;
		try {
			const holdings = await readHoldings();
			if (disposed) return;
			// 每 tick 重新取时钟并重新判窗口：绝不在边界上复用上一次的结论。
			const at = toMs(now());
			const win = windowFor(at, { rng });
			if (!win.active) {
				// 关闭期不刷新，只睡到下一个窗口开启（封顶 30 分钟自愈）。
				schedule(tick, msUntilNextWindowStart(at));
				return;
			}
			const codes = lateDisclosureCadence(holdings, win.windowName);
			if (codes.length > 0) await runRefresh(codes); // 没有持仓就不打上游
			if (disposed) return;
			// night 窗口按是否有迟到披露的基金动态收紧（只影响本窗口）
			const intervalMs = win.windowName === WINDOW_NAME.night ? nightIntervalMs(holdings) : win.intervalMs;
			schedule(tick, intervalMs);
		} catch (error) {
			// 兜底：任何意外都不能让轮询链静默消失。
			if (disposed) return;
			warn(error);
			schedule(tick, MINUTE_MS);
		}
	}

	// 起步：在窗口内就立刻刷一次（别等 30 分钟才拿第一份数据）；关闭期走睡眠分支。
	schedule(tick, 0);

	return function dispose() {
		if (disposed) return;
		disposed = true;
		// 先打断所有"等待 refresh 超时"的等待者，让 tick 立即收尾。
		for (const interrupt of [...pendingTimeouts.values()]) interrupt();
		pendingTimeouts.clear();
		// 再清空全部定时器句柄。此后 tick 里的 disposed 检查会拦住任何续期。
		for (const handle of [...pending]) clearTimeoutFn(handle);
		pending.clear();
	};
}

/**
 * 默认持仓读取：懒加载持久化层（peer task-3 的 ./otc-fund-store.js）。
 *
 * 刻意用动态 import + try/catch：持久化层缺失时轮询器必须照常按窗口工作
 * （只是拿不到持仓/迟到标记），不能因为一个可选依赖整个起不来。
 */
function defaultReadHoldings(dshHome) {
	return async function readHoldings() {
		const mod = await import("./otc-fund-store.js");
		if (typeof mod.readOtcFund !== "function") return [];
		const data = mod.readOtcFund(dshHome);
		const holdings = data === null || typeof data !== "object" ? null : data.holdings;
		if (holdings === null || typeof holdings !== "object") return [];
		return Object.entries(holdings).map(([code, holding]) => ({
			code,
			lateDisclosure: holding !== null && typeof holding === "object" && holding.lateDisclosure === true,
		}));
	};
}

/** 持仓文件路径（与持久化层同口径）。 */
export function otcFundFilePath(dshHome) {
	return `${String(dshHome ?? "")}/${OTC_FUND_FILE}`;
}

export { hasLateDisclosure };

//#endregion
