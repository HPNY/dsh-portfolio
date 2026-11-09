// 持仓看板 dsh-portfolio — 客户端 bundle 源码：基金详情浮窗
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 与自选页的 StockDetailWindow 同一套窗口 chrome（.lkb-win 可拖拽、层级递增、✕ 关闭），
// 内容按成熟基金详情页排布：净值 / 阶段涨幅 / 净值走势（可切区间）/ 我的持仓。
// 阶段涨幅由 Host 算好（/api/leekbox/otc-fund/history），本文件只渲染。
import { h, useEffect, useRef, useState } from "./react.js";
import { API, api, describeError, fmt, fmtAmount, fmtPct, fmtSign, lkbConfirm, notifyFailure, trend } from "./core.js";

/** 曲线横轴标签：秒/毫秒时间戳与 "YYYY-MM-DD" 都归一成 "MM-DD"。 */
function shortDate(v) {
	const s = String(v ?? "");
	if (/^\d{10,13}$/.test(s)) {
		const d = new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
		return Number.isNaN(d.getTime()) ? s : `${d.getMonth() + 1}-${d.getDate()}`;
	}
	const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
	return m === null ? s : `${Number(m[2])}-${Number(m[3])}`;
}

/** 净值序列容错解析：兼容 [ts, nav] / {date,nav} / {time,value} 三种上游形状。 */
function navPoints(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const p of raw) {
		if (Array.isArray(p)) {
			const nav = Number(p[1]);
			if (Number.isFinite(nav)) out.push({ date: p[0], nav });
			continue;
		}
		if (p === null || typeof p !== "object") continue;
		const nav = Number(p.nav ?? p.value ?? p.y);
		if (Number.isFinite(nav)) out.push({ date: p.date ?? p.time ?? p.x ?? "", nav });
	}
	return out;
}

/** 取区间起点（含当天），用于「近 N 月/年」切换。 */
function sliceRecent(points, days) {
	if (!Array.isArray(points) || points.length === 0 || days === null) return points ?? [];
	const last = points[points.length - 1];
	const end = new Date(`${String(last.date).slice(0, 10)}T00:00:00+08:00`).getTime();
	const cutoff = end - days * 86400000;
	const out = [];
	for (const p of points) {
		const t = new Date(`${String(p.date).slice(0, 10)}T00:00:00+08:00`).getTime();
		if (Number.isFinite(t) && t >= cutoff) out.push(p);
	}
	return out.length > 0 ? out : points;
}

/** 净值走势：净值折线 + 成本线水平参考线（与 K 线页一样纯 SVG，不引图表库）。 */
function NavChart({ points, costNav, height = 220 }) {
	const W = 720;
	const H = 200;
	if (!Array.isArray(points) || points.length < 2) {
		return h("div", { className: "lkb_fundChartEmpty" }, "暂无历史净值");
	}
	const navs = points.map((p) => p.nav);
	const cost = typeof costNav === "number" && costNav > 0 ? costNav : null;
	let min = Math.min(...navs);
	let max = Math.max(...navs);
	if (cost !== null) {
		if (cost < min) min = cost;
		if (cost > max) max = cost;
	}
	const pad = (max - min) * 0.08 || 0.01;
	min -= pad;
	max += pad;
	const px = (i) => (i / (points.length - 1)) * W;
	const py = (v) => H - ((v - min) / (max - min)) * H;
	const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)} ${py(p.nav).toFixed(1)}`).join(" ");
	const area = `${d} L${W} ${H} L0 ${H} Z`;
	const ticks = [min, (min + max) / 2, max];
	return h(
		"div",
		{ className: "lkb_fundChart" },
		h(
			"div",
			{ className: "lkb-fundChartWrap" },
			h(
				"svg",
				{
					className: "lkb-fundDetailChart",
					viewBox: `0 0 ${W} ${H}`,
					preserveAspectRatio: "none",
					style: { height },
					role: "img",
					"aria-label": "历史净值走势",
				},
				ticks.map((t, i) => h("line", { key: i, x1: 0, y1: py(t), x2: W, y2: py(t), stroke: "#e8e9ed", strokeWidth: 1, vectorEffect: "non-scaling-stroke" })),
				h("path", { d: area, fill: "#4c6ef520" }),
				h("path", { d, fill: "none", stroke: "#4c6ef5", strokeWidth: 1.6, vectorEffect: "non-scaling-stroke", strokeLinejoin: "round" }),
				cost === null
					? null
					: h("line", { x1: 0, y1: py(cost), x2: W, y2: py(cost), stroke: "#e03131", strokeDasharray: "5 4", strokeWidth: 1, vectorEffect: "non-scaling-stroke" })
			),
			// 刻度标签是普通文本，必须挂在 svg 外层（svg 里不允许放 <span>）
			ticks.map((t, i) => h("span", { key: `t${i}`, className: "lkb-fundTick", style: { top: `${(py(t) / H) * 100}%` } }, fmt(t, 4)))
		),
		h(
			"div",
			{ className: "lkb_fundChartAxis" },
			h("span", null, shortDate(points[0]?.date)),
			cost === null ? null : h("span", { className: "lkb_fundCostTag" }, `成本线 ${fmt(cost, 4)}`),
			h("span", null, shortDate(points[points.length - 1]?.date))
		)
	);
}

/** 基金详情浮窗：与 StockDetailWindow 同一套窗口骨架（可拖拽 / 层级 / 关闭）。 */
export function FundDetailWindow({ fund, x, y, z, onFocus, onClose, onChanged }) {
	const code = String(fund?.code ?? "");
	const [data, setData] = useState(null);
	const [positions, setPositions] = useState([]);
	const [posError, setPosError] = useState("");
	const [error, setError] = useState("");
	const [range, setRange] = useState("m6");
	const [tracked, setTracked] = useState(null);
	const cardRef = useRef(null);
	const [pos, setPos] = useState({ x, y });
	// 挂载后按**实际尺寸**夹回视口内：详情页多长取决于数据多少，窗口可能比估算的
	// 更高更宽，不夹就会压出屏幕、每次都得手动拖。只在首次挂载跑一次。
	useEffect(() => {
		const el = cardRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const maxX = Math.max(8, window.innerWidth - r.width - 8);
		const maxY = Math.max(8, window.innerHeight - r.height - 8);
		setPos((p) => ({ x: Math.min(Math.max(8, p.x), maxX), y: Math.min(Math.max(8, p.y), maxY) }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		let alive = true;
		setError("");
		setData(null);
		api(API.otcFundHistory + `?code=${encodeURIComponent(code)}`)
			.then((d) => alive && setData(d))
			.catch((e) => alive && setError(describeError(e)));
		// 最新披露的前十大重仓股（含占净值比例与实时涨跌）
		setPositions([]);
		setPosError("");
		api(API.otcFundPositions + `?code=${encodeURIComponent(code)}`)
			.then((d) => alive && setPositions(d?.positions ?? []))
			.catch((e) => alive && setPosError(describeError(e)));
		return () => {
			alive = false;
		};
	}, [code]);

	// 是否已在基金持仓里（决定按钮显示「加入」还是「移出」），null = 还在查。
	// 由 history 接口的 tracked 字段给出，不再额外拉一遍快照。
	useEffect(() => {
		if (data?.tracked !== void 0) setTracked(data.tracked === true);
	}, [data]);

	const onHeadDown = (e) => {
		if (e.button !== 0) return;
		if (e.target.closest("button") !== null) return;
		e.preventDefault();
		const rect = cardRef.current !== null ? cardRef.current.getBoundingClientRect() : null;
		if (rect === null) return;
		const startX = e.clientX;
		const startY = e.clientY;
		const baseLeft = rect.left;
		const baseTop = rect.top;
		const clampX = (v) => Math.max(8 - rect.width + 80, Math.min(v, window.innerWidth - 80));
		const clampY = (v) => Math.max(8, Math.min(v, window.innerHeight - 40));
		const onMove = (ev) => setPos({ x: clampX(baseLeft + ev.clientX - startX), y: clampY(baseTop + ev.clientY - startY) });
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";
		};
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};
	const centerWindow = () => {
		const rect = cardRef.current !== null ? cardRef.current.getBoundingClientRect() : null;
		if (rect === null) return;
		setPos({ x: Math.max(8, Math.round((window.innerWidth - rect.width) / 2)), y: Math.max(8, Math.round((window.innerHeight - rect.height) / 2)) });
	};
	const item = (label, value, cls) =>
		h("div", { className: "lkb-qItem" }, h("div", { className: "lkb-qLabel" }, label), h("div", { className: "lkb-qValue " + (cls ?? "") }, value));

	const history = data?.navHistory ?? [];
	const points = sliceRecent(navPoints(history), RANGES.find((r) => r.key === range)?.days ?? null);
	const ret = data?.stageReturns ?? {};
	const latestNav = Number.isFinite(Number(data?.latestNav)) ? Number(data.latestNav) : null;
	const dayPct = ret.d1 === null || ret.d1 === void 0 ? null : Number(ret.d1);
	// 持仓字段一律取 history 接口返回的 fund 行（Host 从持仓文件算好），不能读 prop：
	// 从行情页搜索打开时 prop 只有 {code,name}，读不到份额/成本，会整片显示"—"。
	const f = data?.fund ?? fund;
	const dist = Number.isFinite(Number(f?.distanceToCostPct)) ? Number(f.distanceToCostPct) : null;
	const rowPnl = Number.isFinite(Number(f?.pnl)) ? Number(f.pnl) : null;
	const mktValue = Number.isFinite(Number(f?.marketValue)) ? Number(f.marketValue) : null;
	const returnPct = dist;
	const estimate = f?.estimateAvailable === true;

	// 与自选页股票详情的「加自选」同位同形：加入 = 只建壳子（份额/成本随后在表格里点补），
	// 移出 = 删除持仓。加入用 upsert 但不带份额/成本，Host 会存成 null。
	const toggleTrack = () => {
		if (tracked === null) return;
		if (tracked) {
			lkbConfirm(`确定删除 ${data?.name || fund?.name || ""}（${code}）的持仓记录吗？`).then((ok) => {
				if (!ok) return;
				api(API.otcFundMutate, { method: "POST", body: { action: "delete", code } })
					.then(() => {
						setTracked(false);
						onChanged?.();
					})
					.catch(notifyFailure("移出基金"));
			});
			return;
		}
		api(API.otcFundMutate, { method: "POST", body: { action: "upsert", code, name: data?.name || fund?.name || "" } })
			.then(() => {
				setTracked(true);
				onChanged?.();
			})
			.catch(notifyFailure("加入基金"));
	};

	return h(
		"div",
		{ className: "lkb-win", ref: cardRef, style: { left: pos.x, top: pos.y, zIndex: z }, onPointerDown: onFocus },
		h(
			"div",
			{ className: "lkb_head", title: "拖动移动窗口 · 双击居中", onPointerDown: onHeadDown, onDoubleClick: centerWindow },
			h(
				"span",
				{ className: "lkb_headTitle" },
				h("span", { className: "lkb-logo" }, data?.name || fund?.name || code),
				h("span", { className: "lkb-code" }, code)
			),
			h(
				"div",
				{ className: "lkb_headRight" },
				h(
					"button",
					{
						className: "lkb-chip",
						"data-active": tracked === true ? "true" : "false",
						disabled: tracked === null,
						title: tracked === true ? "从基金持仓中移出" : "加入基金持仓（份额与成本可随后补）",
						onClick: toggleTrack,
					},
					tracked === true ? "移出基金" : "加入基金"
				),
				h("button", { className: "lkb_close", title: "关闭", onClick: onClose }, "✕")
			)
		),
		error === "" ? null : h("div", { className: "lkb-error" }, error),
		h(
			"div",
			{ className: "lkb-fundBody" },
			// 净值区：与股票详情顶部同一套 .lkb-detailQuote 网格（边框圆角卡片 + 小标签/大数值）
			h(
				"div",
				{ className: "lkb-detailQuote" },
				item("单位净值", fmt(latestNav, 4)),
				item("日涨幅", dayPct === null ? "—" : fmtPct(dayPct), dayPct === null ? "" : trend(dayPct)),
				item("披露状态", estimate ? "估值" : "已披露"),
				item("净值日期", estimate ? data?.estimateTime || "估值中" : data?.latestDate || "—")
			),
			// 阶段涨幅
			h(
				"div",
				null,
				h("div", { className: "lkb-secTitle" }, "阶段涨幅"),
				h(
					"div",
					{ className: "lkb-detailQuote" },
					item("近 1 月", fmtPct(ret.m1), trend(ret.m1)),
					item("近 3 月", fmtPct(ret.m3), trend(ret.m3)),
					item("近 6 月", fmtPct(ret.m6), trend(ret.m6)),
					item("近 1 年", fmtPct(ret.y1), trend(ret.y1)),
					item("近 3 年", fmtPct(ret.y3), trend(ret.y3)),
					item("区间以来", fmtPct(ret.since), trend(ret.since))
				)
			),
			// 净值走势：与股票详情的 K 线区块同款 .lkb-chartBox + .lkb-chartTitle，
			// 区间切换放在标题右侧（对应 K 线标题右侧的 周K/月K/分时…）。
			h(
				"div",
				{ className: "lkb-chartBox" },
				h(
					"div",
					{ className: "lkb-chartTitle" },
					h("span", null, "净值走势（单位净值 + 成本线）"),
					h(
						"div",
						{ className: "lkb-fundRanges" },
						RANGES.map((r) =>
							h(
								"button",
								{ key: r.key, className: "lkb-chip", "data-active": range === r.key ? "true" : "false", onClick: () => setRange(r.key) },
								r.label
							)
						)
					)
				),
				h(NavChart, { points, costNav: f?.costNav, height: 220 })
			),
			// 我的持仓
			h(
				"div",
				null,
				h("div", { className: "lkb-secTitle" }, "我的持仓"),
				h(
					"div",
					{ className: "lkb-detailQuote" },
					item("持有份额", f?.shares === null || f?.shares === void 0 ? "—" : String(f.shares)),
					item("成本净值", fmt(f?.costNav, 4)),
					item("持仓市值", fmtAmount(mktValue)),
					item("浮盈", fmtSign(rowPnl), trend(rowPnl)),
					item("盈亏比例", fmtPct(returnPct), trend(returnPct))
				)
			),
			// 最新披露的前十大重仓股：占净值比例 + 实时涨跌（港股无行情则显示"—"）
			positions.length === 0 && posError === ""
				? null
				: h(
						"div",
						{ className: "lkb-chartBox" },
						h("div", { className: "lkb-chartTitle" }, "最新披露 · 前十大重仓股"),
						posError !== ""
							? h("div", { className: "lkb_fundChartEmpty" }, posError)
							: h(
									"div",
									{ className: "lkb-fundPos" },
									positions.map((p) => {
										const w = Number(p.weight);
										const scale = Math.max(...positions.map((q) => Number(q.weight) || 0), 1);
										const pct = Number(p.changePct);
										return h(
											"div",
											{ key: p.exchange + p.code, className: "lkb-fundPosRow" },
											h("span", { className: "lkb-fundPosName" }, p.name),
											h("span", { className: "lkb-code" }, p.code),
											h(
												"span",
												{ className: "lkb-fundPosBar" },
												h("span", { className: "lkb-fundPosFill", style: { width: `${Number.isFinite(w) ? Math.min(100, (w / scale) * 100) : 0}%` } })
											),
											h("span", { className: "lkb-fundPosWeight" }, Number.isFinite(w) ? `${w.toFixed(2)}%` : "—"),
											h("span", { className: "lkb-fundPosChange " + (Number.isFinite(pct) ? trend(pct) : "") }, fmtPct(p.changePct)),
											h(
												"span",
												{ className: "lkb_fundDim" },
												p.changeType === "" ? "" : `${p.changeType}${Number.isFinite(Number(p.changeVsPrev)) ? " " + Number(p.changeVsPrev).toFixed(2) : ""}`
											)
										);
									})
								)
					)
		)
	);
}

/** 区间切换项：days 为 null 表示「全部」。 */
const RANGES = [
	{ key: "m1", label: "近 1 月", days: 30 },
	{ key: "m3", label: "近 3 月", days: 91 },
	{ key: "m6", label: "近 6 月", days: 182 },
	{ key: "y1", label: "近 1 年", days: 365 },
	{ key: "y3", label: "近 3 年", days: 1095 },
	{ key: "all", label: "全部", days: null },
];
