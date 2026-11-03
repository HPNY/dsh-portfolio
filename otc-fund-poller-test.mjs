// 场外基金披露窗口轮询器测试（离线、假时钟，不真的等 30 分钟）。
//
// 重点覆盖方案点名的那个坑：`late` 窗口 (23:00–01:00) 跨零点，写成
// `from <= m && m < to` 会**永远不命中**。这里把边界两侧都钉死。
import assert from "node:assert/strict";
import { lateDisclosureCadence, nightIntervalMs, startOtcFundPoller, windowFor, WINDOW_NAME } from "./lib/otc-fund-poller.js";

let passed = 0;
function ok(label, fn) {
	try {
		fn();
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

const watchdog = setTimeout(() => {
	console.error("\n✗ 测试超时（60s）");
	process.exit(1);
}, 60_000);
watchdog.unref?.();

//#region 时间构造：东八区墙上时间 → epoch 毫秒

/** 用 2026-11-03 作为基准日，拼出东八区某个时刻的 epoch 毫秒。 */
function cst(hours, minutes = 0, seconds = 0, dayOffset = 0) {
	return Date.UTC(2026, 10, 3 + dayOffset, hours - 8, minutes, seconds);
}

//#endregion

//#region 1) windowFor 边界

section("1) windowFor 窗口与边界");

ok("06:00 关闭期开始（06:00 本身不轮询）", () => {
	const w = windowFor(cst(6, 0));
	assert.equal(w.windowName, WINDOW_NAME.closed);
	assert.equal(w.active, false);
	assert.equal(w.intervalMs, 0);
});

ok("05:59 仍属 night 窗口", () => {
	const w = windowFor(cst(5, 59));
	assert.equal(w.windowName, WINDOW_NAME.night);
	assert.equal(w.intervalMs, 60 * 60 * 1000);
});

ok("12:00 白天关闭期", () => {
	assert.equal(windowFor(cst(12, 0)).active, false);
});

ok("17:59 仍关闭", () => {
	assert.equal(windowFor(cst(17, 59)).active, false);
});

ok("18:00 进入 evening，30 分钟", () => {
	const w = windowFor(cst(18, 0));
	assert.equal(w.windowName, WINDOW_NAME.evening);
	assert.equal(w.intervalMs, 30 * 60 * 1000);
});

ok("19:59 仍在 evening", () => {
	assert.equal(windowFor(cst(19, 59)).windowName, WINDOW_NAME.evening);
});

ok("20:00 进入 prime，间隔落在 5-10 分钟（含两端）", () => {
	const lo = windowFor(cst(20, 0), { rng: () => 0 });
	const hi = windowFor(cst(20, 0), { rng: () => 1 });
	assert.equal(lo.intervalMs, 5 * 60 * 1000);
	assert.equal(hi.intervalMs, 10 * 60 * 1000);
	const mid = windowFor(cst(20, 0), { rng: () => 0.5 });
	assert.ok(mid.intervalMs >= 5 * 60 * 1000 && mid.intervalMs <= 10 * 60 * 1000);
});

ok("22:59 仍在 prime", () => {
	assert.equal(windowFor(cst(22, 59)).windowName, WINDOW_NAME.prime);
});

//#endregion

//#region 2) 跨零点（方案点名的坑）

section("2) 跨零点 late 窗口");

ok("23:00 进入 late，15 分钟", () => {
	const w = windowFor(cst(23, 0));
	assert.equal(w.windowName, WINDOW_NAME.late);
	assert.equal(w.intervalMs, 15 * 60 * 1000);
});

ok("23:30 命中 late", () => {
	assert.equal(windowFor(cst(23, 30)).windowName, WINDOW_NAME.late);
});

ok("00:00 命中 late（跨过零点）", () => {
	const w = windowFor(cst(0, 0, 0, 1));
	assert.equal(w.windowName, WINDOW_NAME.late, "跨零点后必须仍然是 late，不能退化成 closed");
	assert.equal(w.intervalMs, 15 * 60 * 1000);
});

ok("00:30 命中 late", () => {
	assert.equal(windowFor(cst(0, 30, 0, 1)).windowName, WINDOW_NAME.late);
});

ok("00:59 命中 late", () => {
	assert.equal(windowFor(cst(0, 59, 0, 1)).windowName, WINDOW_NAME.late);
});

ok("01:00 退出 late，进入 night（半开区间，不重复归属）", () => {
	const w = windowFor(cst(1, 0, 0, 1));
	assert.equal(w.windowName, WINDOW_NAME.night);
	assert.equal(w.intervalMs, 60 * 60 * 1000);
});

ok("01:30 命中 night", () => {
	assert.equal(windowFor(cst(1, 30, 0, 1)).windowName, WINDOW_NAME.night);
});

ok("23:00-01:00 全区间无空档：逐分钟扫一遍，没有任何时刻落到 closed", () => {
	const gaps = [];
	// 23:00 → 次日 01:00，共 120 分钟
	for (let i = 0; i < 120; i++) {
		const ms = cst(23, 0) + i * 60 * 1000;
		const w = windowFor(ms);
		if (w.windowName !== WINDOW_NAME.late) gaps.push(new Date(ms).toISOString());
	}
	assert.deepEqual(gaps, [], `这些时刻漏出了 late 窗口：${gaps.join(", ")}`);
});

ok("整天逐分钟扫描：每个时刻恰好属于一个窗口，且 active 与 windowName 自洽", () => {
	const seen = new Set();
	for (let i = 0; i < 24 * 60; i++) {
		const w = windowFor(cst(0, 0) + i * 60 * 1000, { rng: () => 0 });
		assert.ok(Object.values(WINDOW_NAME).includes(w.windowName), `未知窗口 ${w.windowName}`);
		assert.equal(w.active, w.windowName !== WINDOW_NAME.closed, "active 必须与窗口名一致");
		if (w.active) assert.ok(w.intervalMs > 0, "活跃窗口必须有正间隔");
		else assert.equal(w.intervalMs, 0, "关闭期间隔必须是 0");
		seen.add(w.windowName);
	}
	assert.deepEqual([...seen].sort(), Object.values(WINDOW_NAME).sort(), "五种窗口都应在一天内出现");
});

//#endregion

//#region 3) lateDisclosureCadence

section("3) lateDisclosureCadence");

const holdings = [
	{ code: "161616", lateDisclosure: false },
	{ code: "005827", lateDisclosure: true },
	{ code: "000001", lateDisclosure: false },
];

ok("late 窗口：全部持仓都在刷新名单里（不因未标记而漏掉）", () => {
	const codes = lateDisclosureCadence(holdings, WINDOW_NAME.late);
	assert.deepEqual(codes, ["161616", "005827", "000001"], "23:00-01:00 按窗口表本就是每 15 分钟拉全部持仓");
});

ok("其它窗口：名单同样是全部持仓", () => {
	for (const win of [WINDOW_NAME.evening, WINDOW_NAME.prime, WINDOW_NAME.night]) {
		assert.equal(lateDisclosureCadence(holdings, win).length, 3, `${win} 窗口应包含全部 3 只`);
	}
});

ok("空持仓 → 空名单", () => {
	assert.deepEqual(lateDisclosureCadence([], WINDOW_NAME.late), []);
	assert.deepEqual(lateDisclosureCadence(null, WINDOW_NAME.late), []);
});

ok("畸形持仓条目被跳过，不抛", () => {
	const codes = lateDisclosureCadence([{ code: "161616" }, null, { lateDisclosure: true }, { code: "" }], WINDOW_NAME.late);
	assert.deepEqual(codes, ["161616"]);
});

ok("night 窗口：无标记 → 60 分钟；有标记 → 收紧到 15 分钟", () => {
	assert.equal(nightIntervalMs([{ code: "161616", lateDisclosure: false }]), 60 * 60 * 1000);
	assert.equal(nightIntervalMs([{ code: "161616", lateDisclosure: true }]), 15 * 60 * 1000);
	assert.equal(nightIntervalMs([]), 60 * 60 * 1000);
});

ok("night 收紧不泄漏到其它窗口：evening/prime/late 间隔保持原值", () => {
	const marked = [{ code: "161616", lateDisclosure: true }];
	assert.equal(nightIntervalMs(marked), 15 * 60 * 1000); // 仅 night
	assert.equal(windowFor(cst(19, 0)).intervalMs, 30 * 60 * 1000); // evening 不受影响
	assert.equal(windowFor(cst(22, 0), { rng: () => 0 }).intervalMs, 5 * 60 * 1000); // prime 不受影响
	assert.equal(windowFor(cst(23, 30)).intervalMs, 15 * 60 * 1000); // late 本来就是 15
});

//#endregion

//#region 4) startOtcFundPoller 调度与清理

section("4) startOtcFundPoller 调度与 dispose");

/** 假时钟 + 假定时器：手动推进时间，不真的等。 */
function makeFakeClock(startMs) {
	let nowMs = startMs;
	let seq = 0;
	const timers = new Map(); // id -> { at, fn }
	const clock = {
		now: () => nowMs,
		timer: {
			setTimeout(fn, delay) {
				const id = ++seq;
				timers.set(id, { at: nowMs + Number(delay ?? 0), fn });
				return id;
			},
			clearTimeout(id) {
				timers.delete(id);
			},
		},
		/** 推进 ms 毫秒，按到期顺序触发回调；返回触发的次数。 */
		advance(ms) {
			const target = nowMs + ms;
			let fired = 0;
			for (;;) {
				let next = null;
				for (const [id, t] of timers) {
					if (t.at <= target && (next === null || t.at < next.t.at)) next = { id, t };
				}
				if (next === null) break;
				timers.delete(next.id);
				nowMs = next.t.at;
				next.t.fn();
				fired += 1;
			}
			nowMs = target;
			return fired;
		},
		get pending() {
			return timers.size;
		},
	};
	return clock;
}

/**
 * 让假时钟上排好的回调及其异步续作跑完。
 *
 * 轮询链是 async 的：setTimeout 回调只是把 tick 推起来，tick 里的 await
 * （读持仓 → 刷新 → 续期）要多轮事件循环才settle，所以 advance(0) 与让出
 * 宏任务要交替进行。
 */
async function flush(clock, rounds = 16) {
	for (let i = 0; i < rounds; i++) {
		clock.advance(0);
		await new Promise((r) => setTimeout(r, 0));
	}
}

await okAsync("窗口内启动：立刻刷一次，然后按窗口间隔续期", async () => {
	const clock = makeFakeClock(cst(20, 30)); // prime
	const refreshed = [];
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616", lateDisclosure: false }],
		refresh: async (codes) => {
			refreshed.push(codes);
		},
		timer: clock.timer,
		now: clock.now,
		rng: () => 0, // prime 固定 5 分钟
	});
	await flush(clock);
	assert.equal(refreshed.length, 1, "窗口内启动应立刻刷一次");
	assert.deepEqual(refreshed[0], ["161616"]);

	clock.advance(5 * 60 * 1000);
	await flush(clock);
	assert.equal(refreshed.length, 2, "5 分钟后应再刷一次");
	dispose();
});

await okAsync("关闭期启动：不刷新，只睡眠", async () => {
	const clock = makeFakeClock(cst(12, 0));
	let calls = 0;
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616" }],
		refresh: async () => {
			calls += 1;
		},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock);
	assert.equal(calls, 0, "关闭期不得打上游");
	assert.ok(clock.pending >= 1, "应当挂着睡眠定时器等待下一个窗口");
	dispose();
});

await okAsync("没有持仓：窗口内也不打上游", async () => {
	const clock = makeFakeClock(cst(21, 0));
	let calls = 0;
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [],
		refresh: async () => {
			calls += 1;
		},
		timer: clock.timer,
		now: clock.now,
		rng: () => 0,
	});
	await flush(clock);
	assert.equal(calls, 0);
	dispose();
});

await okAsync("跨零点连续运行：23:00 起每 15 分钟触发，跨过 00:00 不中断", async () => {
	const clock = makeFakeClock(cst(23, 0));
	const stamps = [];
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616" }],
		refresh: async () => {
			stamps.push(clock.now());
		},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock);
	// 23:00 → 01:00 共 120 分钟，每 15 分钟一次 → 连起始那次共 8 次
	for (let i = 0; i < 8; i++) {
		clock.advance(15 * 60 * 1000);
		await flush(clock, 8);
	}
	assert.ok(stamps.length >= 7, `跨零点应持续触发，实际 ${stamps.length} 次`);
	// 触发时刻应覆盖零点前后
	const minutes = stamps.map((ms) => new Date(ms + 8 * 3600 * 1000).getUTCHours() * 60 + new Date(ms + 8 * 3600 * 1000).getUTCMinutes());
	assert.ok(minutes.some((m) => m >= 23 * 60), "应包含 23:xx 的触发");
	assert.ok(minutes.some((m) => m < 60), "应包含 00:xx 的触发（跨过零点）");
	dispose();
});

await okAsync("dispose 之后不再触发，且不留活定时器", async () => {
	const clock = makeFakeClock(cst(21, 0));
	let calls = 0;
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616" }],
		refresh: async () => {
			calls += 1;
		},
		timer: clock.timer,
		now: clock.now,
		rng: () => 0,
	});
	await flush(clock);
	const before = calls;
	assert.ok(before >= 1, "启动后应已刷过一次");
	dispose();
	assert.equal(clock.pending, 0, "dispose 必须清空所有定时器");
	clock.advance(60 * 60 * 1000);
	await flush(clock, 4);
	assert.equal(calls, before, "dispose 后不得再刷新");
});

await okAsync("dispose 幂等：调两次不抛", async () => {
	const clock = makeFakeClock(cst(21, 0));
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [],
		refresh: async () => {},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock, 4);
	dispose();
	dispose();
	assert.equal(clock.pending, 0);
});

await okAsync("refresh 抛错不影响后续排期（轮询链不静默死掉）", async () => {
	const clock = makeFakeClock(cst(21, 0));
	let calls = 0;
	const warnings = [];
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		logger: { warn: (e) => warnings.push(e) },
		readHoldings: async () => [{ code: "161616" }],
		refresh: async () => {
			calls += 1;
			throw new Error("upstream boom");
		},
		timer: clock.timer,
		now: clock.now,
		rng: () => 0,
	});
	await flush(clock);
	clock.advance(5 * 60 * 1000);
	await flush(clock);
	assert.ok(calls >= 2, `失败后必须继续排期（实际 ${calls} 次）`);
	assert.ok(warnings.length >= 1, "失败应记录日志");
	dispose();
});

await okAsync("readHoldings 抛错也不让轮询链死掉", async () => {
	const clock = makeFakeClock(cst(21, 0));
	let attempts = 0;
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		logger: { warn: () => {} },
		readHoldings: async () => {
			attempts += 1;
			throw new Error("disk boom");
		},
		refresh: async () => {},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock);
	assert.equal(attempts, 1);
	assert.ok(clock.pending >= 1, "应已排下一次重试");
	dispose();
});

await okAsync("night 窗口：有迟到披露标记时收紧到 15 分钟", async () => {
	const clock = makeFakeClock(cst(2, 0, 0, 1)); // 次日 02:00 → night
	const stamps = [];
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616", lateDisclosure: true }],
		refresh: async () => {
			stamps.push(clock.now());
		},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock);
	assert.equal(stamps.length, 1, "night 窗口内启动也应立刻刷一次");
	clock.advance(15 * 60 * 1000);
	await flush(clock);
	assert.equal(stamps.length, 2, "有标记时 night 应按 15 分钟触发，而不是 60 分钟");
	dispose();
});

await okAsync("night 窗口：无标记时按 60 分钟", async () => {
	const clock = makeFakeClock(cst(2, 0, 0, 1));
	const stamps = [];
	const dispose = startOtcFundPoller({
		dshHome: "C:/tmp/x",
		readHoldings: async () => [{ code: "161616", lateDisclosure: false }],
		refresh: async () => {
			stamps.push(clock.now());
		},
		timer: clock.timer,
		now: clock.now,
	});
	await flush(clock);
	assert.equal(stamps.length, 1);
	clock.advance(15 * 60 * 1000);
	await flush(clock);
	assert.equal(stamps.length, 1, "无标记时 15 分钟内不该再触发");
	clock.advance(45 * 60 * 1000);
	await flush(clock);
	assert.equal(stamps.length, 2, "满 60 分钟应触发");
	dispose();
});

//#endregion

clearTimeout(watchdog);
if (process.exitCode === 1) {
	console.error("\n❌ 场外基金轮询器测试失败");
} else {
	console.log(`\n✅ 场外基金轮询器测试通过：${passed} 项断言`);
}
