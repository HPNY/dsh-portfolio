// OTC 基金存储层回归测试（无网络）。
//
// 覆盖 lib/otc-fund-store.js 的全部 8 个导出，断言的是**契约**而不是实现：
//   1. otcFundPath    —— 落在 $DSH_HOME/.leekbox-otc-fund.json
//   2. readOtcFund    —— 三键形状恒定；缺失/损坏/形状错误一律回落空形状且不抛
//   3. writeOtcFund   —— 原子改名不留 .tmp；round-trip 保真；失败返回 false 不抛
//   4. upsertHolding  —— 新增/部分更新/校验/字段裁剪
//   5. deleteHolding  —— 幂等删除
//   6. appendNavHistory —— `${code}:${date}` 键 + 同码同日去重
//   7. withOtcFundLock —— 并发读写不丢更新；再抛错的 fn 不破坏队列
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	otcFundPath,
	readOtcFund,
	writeOtcFund,
	withOtcFundLock,
	upsertHolding,
	deleteHolding,
	appendNavHistory,
} from "./lib/otc-fund-store.js";

const home = mkdtempSync(join(tmpdir(), "leekbox-otc-store-"));
let passed = 0;
function check(name, cond, detail) {
	assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
	passed += 1;
	console.log(`  ok ${name}`);
}
const tmpFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

try {
	// ---- 1) 路径 ----
	console.log("== 1) otcFundPath ==");
	check("路径落在 dshHome 下且名为 .leekbox-otc-fund.json", otcFundPath(home) === join(home, ".leekbox-otc-fund.json"), otcFundPath(home));

	// ---- 2) 读取默认值 ----
	console.log("== 2) readOtcFund 默认与容错 ==");
	const empty = readOtcFund(home);
	check("缺失文件 → 三键空形状", JSON.stringify(empty) === JSON.stringify({ holdings: {}, navSnapshots: {}, navHistory: {} }));
	check("默认对象互不共享引用", readOtcFund(home).holdings !== empty.holdings);

	writeFileSync(otcFundPath(home), "{ this is not json", "utf8");
	check("损坏 JSON → 空形状且不抛", JSON.stringify(readOtcFund(home)) === JSON.stringify({ holdings: {}, navSnapshots: {}, navHistory: {} }));

	writeFileSync(otcFundPath(home), JSON.stringify({ holdings: [], navSnapshots: "nope", navHistory: { "161616:2026-11-02": { code: "161616", date: "2026-11-02", nav: 1.606 } } }), "utf8");
	const partial = readOtcFund(home);
	check("错误键类型逐个回落，合法键保留", JSON.stringify(partial.holdings) === "{}" && JSON.stringify(partial.navSnapshots) === "{}" && Object.keys(partial.navHistory).length === 1);

	writeFileSync(otcFundPath(home), JSON.stringify(null), "utf8");
	check("顶层 null → 空形状", JSON.stringify(readOtcFund(home)) === JSON.stringify({ holdings: {}, navSnapshots: {}, navHistory: {} }));

	// ---- 3) 写入 round-trip ----
	console.log("== 3) writeOtcFund 原子写 ==");
	const sample = readOtcFund(home);
	upsertHolding(sample, { code: "161616", name: "融通医疗保健行业混合A/B", shares: 10838.9, costNav: 1.9513 });
	sample.navSnapshots["161616"] = { latestNav: 1.606, latestDate: "2026-11-02", estimateNav: null, estimateTime: "", stale: false };
	appendNavHistory(sample, "161616", [{ date: "2026-11-02", nav: 1.606 }]);
	check("写入返回 true", writeOtcFund(home, sample) === true);
	check("写后不留 .tmp", tmpFiles(home).length === 0, JSON.stringify(tmpFiles(home)));

	const roundTrip = readOtcFund(home);
	check(
		"round-trip 保真",
		roundTrip.holdings["161616"].shares === 10838.9 &&
			roundTrip.holdings["161616"].costNav === 1.9513 &&
			roundTrip.holdings["161616"].name === "融通医疗保健行业混合A/B" &&
			roundTrip.navSnapshots["161616"].latestNav === 1.606 &&
			roundTrip.navHistory["161616:2026-11-02"].nav === 1.606
	);
	check("落盘为缩进 JSON（人类可读）", readFileSync(otcFundPath(home), "utf8").includes("\n  \"holdings\""));

	// 失败路径：把一个**目录**当成目标文件，renameSync 必然失败。
	const badHome = join(home, "as-dir");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(badHome, ".leekbox-otc-fund.json"), { recursive: true });
	check("写入失败返回 false 且不抛", writeOtcFund(badHome, { holdings: {} }) === false);
	check("写入失败后清理 .tmp", tmpFiles(badHome).length === 0, JSON.stringify(tmpFiles(badHome)));

	// ---- 4) upsertHolding ----
	console.log("== 4) upsertHolding ==");
	const data = { holdings: {}, navSnapshots: {}, navHistory: {} };
	const ret = upsertHolding(data, { code: " 161616 ", shares: 100.5, costNav: 1.25, name: " 融通医疗 ", lateDisclosure: true });
	check("返回同一个 data（可链式）", ret === data);
	check("code 被 trim", !!data.holdings["161616"] && !data.holdings[" 161616 "]);
	check("lateDisclosure=true 被保留", data.holdings["161616"].lateDisclosure === true);
	check("name 被 trim", data.holdings["161616"].name === "融通医疗");

	upsertHolding(data, { code: "161616", shares: 200, costNav: 1.5 });
	check("部分更新覆盖 shares/costNav", data.holdings["161616"].shares === 200 && data.holdings["161616"].costNav === 1.5);
	check("部分更新保留 name", data.holdings["161616"].name === "融通医疗");
	check("未传 lateDisclosure → 归一为 false", data.holdings["161616"].lateDisclosure === false);

	upsertHolding(data, { code: "000001", shares: 0, costNav: 2 });
	check("shares=0 合法（空仓）", data.holdings["000001"].shares === 0);
	check("缺省 name 不写入该字段", !("name" in data.holdings["000001"]));

	const badInputs = [
		["code 缺失", { shares: 1, costNav: 1 }],
		["code 空串", { code: "  ", shares: 1, costNav: 1 }],
		["code 非字符串", { code: 161616, shares: 1, costNav: 1 }],
		["shares 负数", { code: "161616", shares: -1, costNav: 1 }],
		["shares NaN", { code: "161616", shares: NaN, costNav: 1 }],
		["shares 字符串", { code: "161616", shares: "100", costNav: 1 }],
		["shares 缺失", { code: "161616", costNav: 1 }],
		["costNav=0", { code: "161616", shares: 1, costNav: 0 }],
		["costNav 负数", { code: "161616", shares: 1, costNav: -1 }],
		["costNav Infinity", { code: "161616", shares: 1, costNav: Infinity }],
		["costNav 缺失", { code: "161616", shares: 1 }],
	];
	for (const [label, input] of badInputs) {
		assert.throws(() => upsertHolding({ holdings: {} }, input), TypeError, `${label} 应当抛 TypeError`);
		passed += 1;
	}
	check("11 组非法输入全部抛 TypeError", true);

	// ---- 5) deleteHolding ----
	console.log("== 5) deleteHolding ==");
	deleteHolding(data, "161616");
	check("删除命中", !("161616" in data.holdings));
	check("删除不影响其他持仓", !!data.holdings["000001"]);
	check("重复删除幂等（不抛）", deleteHolding(data, "161616") === data && deleteHolding(data, "不存在") === data);
	check("非法 code 按不存在处理", deleteHolding(data, "") === data && deleteHolding(data, null) === data);

	// ---- 6) appendNavHistory ----
	console.log("== 6) appendNavHistory ==");
	const hist = { holdings: {}, navSnapshots: {}, navHistory: {} };
	appendNavHistory(hist, "161616", [
		{ date: "2026-11-01", nav: 1.6 },
		{ date: "2026-11-02", nav: 1.606 },
	]);
	check("按 `${code}:${date}` 建键", !!hist.navHistory["161616:2026-11-01"] && !!hist.navHistory["161616:2026-11-02"]);
	check("条目自带 code/date/nav", JSON.stringify(hist.navHistory["161616:2026-11-02"]) === JSON.stringify({ code: "161616", date: "2026-11-02", nav: 1.606 }));

	appendNavHistory(hist, "161616", [{ date: "2026-11-02", nav: 1.6 }]);
	check("同 code+date 去重不新增键", Object.keys(hist.navHistory).length === 2);
	check("同 code+date 覆盖为最新值", hist.navHistory["161616:2026-11-02"].nav === 1.6);

	appendNavHistory(hist, "000001", [{ date: "2026-11-02", nav: 1.1 }]);
	check("不同 code 同日互不冲突", Object.keys(hist.navHistory).length === 3 && hist.navHistory["000001:2026-11-02"].nav === 1.1);

	appendNavHistory(hist, "161616", [
		{ date: "2026/11/03", nav: 1.7 },
		{ date: "2026-11-03", nav: NaN },
		{ date: "2026-11-03" },
		null,
		"garbage",
		{ date: "2026-11-03", nav: 1.7 },
	]);
	check("非法点逐条跳过，合法点写入", Object.keys(hist.navHistory).length === 4 && hist.navHistory["161616:2026-11-03"].nav === 1.7);
	check("points 非数组时不抛", appendNavHistory(hist, "161616", null) === hist && Object.keys(hist.navHistory).length === 4);

	// ---- 7) 写锁 ----
	console.log("== 7) withOtcFundLock 并发不变量 ==");
	check("返回 Promise", typeof withOtcFundLock(async () => 1).then === "function");
	check("透传返回值", (await withOtcFundLock(async () => "ok")) === "ok");

	// 抛错的 fn 不能把后续排队的调用者一起带崩。
	await assert.rejects(() => withOtcFundLock(async () => {
		throw new Error("boom");
	}));
	check("抛错后队列仍可用", (await withOtcFundLock(async () => "alive")) === "alive");

	// 真实并发：20 个 upsert 各自"读→改→写"，全部落盘且互不覆盖。
	const lockHome = mkdtempSync(join(tmpdir(), "leekbox-otc-lock-"));
	const codes = Array.from({ length: 20 }, (_, i) => String(100000 + i));
	await Promise.all(
		codes.map((code, i) =>
			withOtcFundLock(async () => {
				// 让周期交错：读之后先让出事件循环，再写。
				const snapshot = readOtcFund(lockHome);
				await new Promise((r) => setTimeout(r, 1));
				upsertHolding(snapshot, { code, shares: (i + 1) * 100, costNav: 1 + i / 100 });
				writeOtcFund(lockHome, snapshot);
			})
		)
	);
	const afterConcurrent = readOtcFund(lockHome);
	check("20 个并发 upsert 全部落盘（无丢更新）", Object.keys(afterConcurrent.holdings).length === 20, `实得 ${Object.keys(afterConcurrent.holdings).length}`);
	check("每个条目数值正确", codes.every((code, i) => afterConcurrent.holdings[code]?.shares === (i + 1) * 100));

	// 同码并发追加历史：去重后每个日期只有一条。
	await Promise.all(
		["2026-10-31", "2026-11-01", "2026-11-02"].map((date) =>
			withOtcFundLock(async () => {
				const snapshot = readOtcFund(lockHome);
				await new Promise((r) => setTimeout(r, 1));
				appendNavHistory(snapshot, "161616", [{ date, nav: 1.5 }]);
				writeOtcFund(lockHome, snapshot);
			})
		)
	);
	check("并发 append 三个日期 → 三条记录", Object.keys(readOtcFund(lockHome).navHistory).length === 3);

	console.log(`\n✅ OTC 基金存储层测试通过：${passed} 项断言`);
} finally {
	rmSync(home, { recursive: true, force: true });
	try {
		if (existsSync(home)) rmSync(home, { recursive: true, force: true });
	} catch {}
}
