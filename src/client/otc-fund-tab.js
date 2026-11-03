// 持仓看板 dsh-portfolio — 客户端 bundle 源码：场外基金页（净值 / 估值、盈亏百分比、历史净值曲线）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { API, api, describeError, fmt, fmtAmount, fmtPct, fmtSign, lkbConfirm, notifyFailure, trend, useInterval } from "./core.js";

/** 宽松取数：非有限值一律当"没有"。上游字段可能缺失 / null / 空串，页面不许因此崩。 */
function num(v) {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
}

/** "2026-11-03T09:23:37+08:00" → "09:23:37"；取不出时间就原样透出。 */
function clockOf(iso) {
	const t = String(iso ?? "");
	const m = /T(\d{2}:\d{2}:\d{2})/.exec(t);
	return m === null ? t : m[1];
}

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
			const nav = num(p[1]);
			if (nav !== null) out.push({ date: p[0], nav: nav });
			continue;
		}
		if (p === null || typeof p !== "object") continue;
		const nav = num(p.nav ?? p.value ?? p.y);
		if (nav !== null) out.push({ date: p.date ?? p.time ?? p.x ?? "", nav: nav });
	}
	return out;
}

/** 历史净值曲线（P1）：净值折线 + 成本线水平参考线。
 *
 *  纯 SVG、无依赖——与 K 线页一样只画折线，不引图表库。历史数组缺失或不足
 *  两点时降级成"暂无净值曲线"占位，绝不因为字段没准备好就把整页打崩。 */
function NavChart({ points, costNav }) {
	if (points.length < 2) return h("div", { className: "lkb_fundChartEmpty" }, "暂无净值曲线");
	const W = 600;
	const H = 168;
	const PAD = { l: 8, r: 8, t: 12, b: 20 };
	const navs = points.map((p) => p.nav);
	let min = Math.min(...navs);
	let max = Math.max(...navs);
	const cost = num(costNav);
	if (cost !== null) {
		min = Math.min(min, cost);
		max = Math.max(max, cost);
	}
	// 净值恒定的序列（新基金 / 只有一天）会让除数变 0，先撑开一点再画。
	if (max - min < 1e-9) {
		max += 0.0005;
		min -= 0.0005;
	}
	const plotW = W - PAD.l - PAD.r;
	const plotH = H - PAD.t - PAD.b;
	const x = (i) => PAD.l + plotW * (i / (points.length - 1));
	const y = (v) => PAD.t + plotH * (1 - (v - min) / (max - min));
	const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.nav).toFixed(1)}`).join(" ");
	// A 股口径：区间收涨画红、收跌画绿（与 .lkb-up / .lkb-down 一致，别按欧美惯例反过来）。
	const stroke = points[points.length - 1].nav >= points[0].nav ? "#e03131" : "#0f9d6e";
	const costY = cost === null ? null : y(cost);
	const last = points[points.length - 1];
	return h(
		"div",
		{ className: "lkb_fundChart" },
		h(
			"svg",
			{
				className: "lkb_fundChartSvg",
				viewBox: `0 0 ${W} ${H}`,
				preserveAspectRatio: "none",
				fill: "none",
				focusable: "false",
				"aria-hidden": "true",
			},
			h("path", {
				d: d,
				stroke: stroke,
				strokeWidth: 1.6,
				// preserveAspectRatio="none" 会把笔画横向拉扁，这里让它保持等宽。
				vectorEffect: "non-scaling-stroke",
				strokeLinejoin: "round",
				strokeLinecap: "round",
			}),
			costY === null
				? null
				: h("line", {
						x1: PAD.l,
						x2: W - PAD.r,
						y1: costY,
						y2: costY,
						stroke: "#4c6ef5",
						strokeWidth: 1,
						strokeDasharray: "5 4",
						vectorEffect: "non-scaling-stroke",
					})
		),
		h(
			"div",
			{ className: "lkb_fundChartAxis" },
			h("span", null, `高 ${fmt(max)}`),
			h("span", null, `低 ${fmt(min)}`),
			cost === null ? null : h("span", { className: "lkb_fundCostTag" }, `成本线 ${fmt(cost)}`),
			h("span", null, `${shortDate(points[0].date)} → ${shortDate(last.date)}`)
		)
	);
}

/** 行内编辑表单：名称 / 份额 / 成本净值（Enter 保存、Esc 取消，与自选页 PositionCell 同一套手感）。 */
/** 表格内的可编辑单元格：与自选页「持仓 / 成本」列的交互完全一致
 *  （虚线可点 -> 点击变输入框 -> Enter/失焦保存、Esc 取消）。
 *  保存成功后只刷新数据，不关闭已展开的详情行。 */
function EditableCell({ value, display, placeholder, onSave }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const start = (e) => {
		e.stopPropagation();
		setDraft(value === null || value === void 0 ? "" : String(value));
		setEditing(true);
	};
	const commit = () => {
		const raw = draft.trim();
		setEditing(false);
		if (raw === "") {
			onSave(null);
			return;
		}
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) return;
		onSave(parsed);
	};
	if (!editing) {
		const empty = value === null || value === void 0;
		return h(
			"span",
			{ className: "lkb-posCell" + (empty ? " lkb-posEmpty" : ""), title: "点击修改", onClick: start },
			empty ? placeholder : display
		);
	}
	return h("input", {
		className: "lkb-input",
		style: { width: 88, padding: "3px 6px", fontSize: 11 },
		value: draft,
		autoFocus: true,
		placeholder,
		onClick: (e) => e.stopPropagation(),
		onChange: (e) => setDraft(e.target.value),
		onKeyDown: (e) => {
			e.stopPropagation();
			if (e.key === "Enter") commit();
			else if (e.key === "Escape") setEditing(false);
		},
		onBlur: commit,
	});
}
function FundEditForm({ fund, saving, onSave, onCancel, onDelete }) {
	const [name, setName] = useState(fund.name ?? "");
	const [shares, setShares] = useState(fund.shares === null || fund.shares === void 0 ? "" : String(fund.shares));
	const [costNav, setCostNav] = useState(fund.costNav === null || fund.costNav === void 0 ? "" : String(fund.costNav));
	const [err, setErr] = useState("");
	const submit = () => {
		const sh = num(shares);
		const cn = num(costNav);
		if (String(name).trim() === "") {
			setErr("请填写名称");
			return;
		}
		if (sh === null || sh <= 0) {
			setErr("份额需为大于 0 的数字");
			return;
		}
		if (cn === null || cn <= 0) {
			setErr("成本净值需为大于 0 的数字");
			return;
		}
		onSave({ name: String(name).trim(), shares: sh, costNav: cn });
	};
	return h(
		"div",
		{
			className: "lkb_fundEdit",
			// 行本身可点击展开，表单内部的点击/按键不该冒泡回行。
			onClick: (e) => e.stopPropagation(),
			onKeyDown: (e) => {
				e.stopPropagation();
				if (e.key === "Enter") submit();
				else if (e.key === "Escape") onCancel();
			},
		},
		h(
			"div",
			{ className: "lkb_fundEditGrid" },
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "名称"),
				h("input", {
					className: "lkb-input",
					value: name,
					autoFocus: true,
					placeholder: "基金名称",
					onClick: (e) => e.stopPropagation(),
					onChange: (e) => {
						setName(e.target.value);
						setErr("");
					},
				})
			),
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "份额"),
				h("input", {
					className: "lkb-input",
					type: "number",
					step: "0.01",
					min: "0",
					value: shares,
					placeholder: "如 1000",
					onClick: (e) => e.stopPropagation(),
					onChange: (e) => {
						setShares(e.target.value);
						setErr("");
					},
				})
			),
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "成本净值"),
				h("input", {
					className: "lkb-input",
					type: "number",
					step: "0.0001",
					min: "0",
					value: costNav,
					placeholder: "如 1.2345",
					onClick: (e) => e.stopPropagation(),
					onChange: (e) => {
						setCostNav(e.target.value);
						setErr("");
					},
				})
			)
		),
		h(
			"div",
			{ className: "lkb_fundEditActions" },
			h("button", { className: "lkb-btn", disabled: saving, onClick: submit }, saving ? "保存中…" : "保存"),
			h("button", { className: "lkb-btnGhost", disabled: saving, onClick: onCancel }, "取消"),
			h("button", { className: "lkb-btnGhost lkb_fundDanger", disabled: saving, onClick: onDelete }, "删除"),
			err === "" ? null : h("span", { className: "lkb-error lkb_fundEditErr" }, err)
		)
	);
}

/** 新增基金持仓：只要求 6 位基金代码，名称/份额/成本净值可后补（走同一个 upsert）。 */
function AddFundForm({ saving, onSave, onCancel }) {
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [shares, setShares] = useState("");
	const [costNav, setCostNav] = useState("");
	const [err, setErr] = useState("");
	const submit = () => {
		const c = String(code).trim();
		if (!/^\d{6}$/.test(c)) {
			setErr("请输入 6 位基金代码");
			return;
		}
		const sh = shares.trim() === "" ? null : num(shares);
		const cn = costNav.trim() === "" ? null : num(costNav);
		if (shares.trim() !== "" && (sh === null || sh <= 0)) {
			setErr("份额需为大于 0 的数字");
			return;
		}
		if (costNav.trim() !== "" && (cn === null || cn <= 0)) {
			setErr("成本净值需为大于 0 的数字");
			return;
		}
		onSave({ code: c, name: name.trim(), shares: sh, costNav: cn });
	};
	return h(
		"div",
		{
			className: "lkb_fundEdit",
			onKeyDown: (e) => {
				e.stopPropagation();
				if (e.key === "Enter") submit();
				else if (e.key === "Escape") onCancel();
			},
		},
		h(
			"div",
			{ className: "lkb_fundEditGrid" },
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "基金代码"),
				h("input", {
					className: "lkb-input",
					value: code,
					autoFocus: true,
					placeholder: "如 110022",
					onChange: (e) => {
						setCode(e.target.value);
						setErr("");
					},
				})
			),
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "名称"),
				h("input", {
					className: "lkb-input",
					value: name,
					placeholder: "可留空，自动取",
					onChange: (e) => {
						setName(e.target.value);
						setErr("");
					},
				})
			),
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "份额"),
				h("input", {
					className: "lkb-input",
					type: "number",
					step: "0.01",
					min: "0",
					value: shares,
					placeholder: "可留空",
					onChange: (e) => {
						setShares(e.target.value);
						setErr("");
					},
				})
			),
			h(
				"label",
				{ className: "lkb_fundField" },
				h("span", null, "成本净值"),
				h("input", {
					className: "lkb-input",
					type: "number",
					step: "0.0001",
					min: "0",
					value: costNav,
					placeholder: "可留空",
					onChange: (e) => {
						setCostNav(e.target.value);
						setErr("");
					},
				})
			)
		),
		h(
			"div",
			{ className: "lkb_fundEditActions" },
			h("button", { className: "lkb-btn", disabled: saving, onClick: submit }, saving ? "提交中…" : "添加"),
			h("button", { className: "lkb-btnGhost", disabled: saving, onClick: onCancel }, "取消"),
			err === "" ? null : h("span", { className: "lkb-error lkb_fundEditErr" }, err)
		)
	);
}

/**
 * 场外基金页。
 *
 * 数据全部来自宿主 `/api/leekbox/otc-fund/snapshot` 的缓存：盈亏百分比、浮盈、
 * 市值/盈亏都是宿主算好的，客户端**不自己算指标**（口径只有一处，避免两边漂移）。
 * 写操作只走 `/otc-fund/mutate`（upsert / delete）。
 *
 * `active` 为 false 时停掉轮询：面板的 body 分支只渲染当前选中的标签页，切走即
 * 卸载，所以正常路径下这里本来就是"不活跃即不轮询"；保留这个开关是为了将来把
 * 标签页改成常驻（keep-alive）渲染时不会静默变成后台狂拉。
 */
export function OtcFundTab({ active = true }) {
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [openCode, setOpenCode] = useState(null);
	const [addOpen, setAddOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [msg, setMsg] = useState("");
	const seqRef = useRef(0);
	const load = useCallback(() => {
		const seq = ++seqRef.current;
		return api(API.otcFundSnapshot)
			.then((d) => {
				if (seq !== seqRef.current) return; // 已被更新的请求取代
				setData({
					funds: Array.isArray(d?.funds) ? d.funds : [],
					summary: d?.summary !== null && typeof d?.summary === "object" ? d.summary : {},
					updatedAt: typeof d?.updatedAt === "string" ? d.updatedAt : "",
				});
				setError("");
			})
			.catch((e) => {
				if (seq !== seqRef.current) return;
				setError(describeError(e));
			})
			.finally(() => {
				if (seq === seqRef.current) setLoading(false);
			});
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	// 30 秒轮询：只在这个标签页活跃时挂表（active=false → ms=null，useInterval 直接不建表）。
	useInterval(load, active ? 30000 : null);
	// 保存/删除的结果提示自动消失。
	useEffect(() => {
		if (msg === "") return;
		const timer = setTimeout(() => setMsg(""), 8000);
		return () => clearTimeout(timer);
	}, [msg]);
	/** 写操作统一入口。api() 自己会 JSON.stringify 并带上 content-type，这里传普通对象。 */
	const mutate = useCallback((body) => api(API.otcFundMutate, { method: "POST", body }), []);
	/**
	 * 单元格内联保存（成本 / 份额）。
	 *
	 * 接口的 upsert 要求 shares 与 costNav **同时合法**，所以改一个必须带上另一个的当前值。
	 * 任一侧缺失或非法就直接提示、不发请求 —— 否则后端返回 400，而输入框已经关掉了。
	 */
	const saveField = (fund, patch) => {
		const shares = patch.shares !== void 0 ? patch.shares : num(fund.shares);
		const costNav = patch.costNav !== void 0 ? patch.costNav : num(fund.costNav);
		if (shares === null || !(shares > 0)) {
			setMsg("份额需为大于 0 的数字");
			return;
		}
		if (costNav === null || !(costNav > 0)) {
			setMsg("成本净值需为大于 0 的数字");
			return;
		}
		setSaving(true);
		mutate({ action: "upsert", code: fund.code, name: fund.name, shares, costNav })
			.then(() => {
				setMsg(`已保存 ${fund.code}`);
				load();
			})
			.catch(notifyFailure("保存基金持仓"))
			.finally(() => setSaving(false));
	};	const upsert = (body) => {
		setSaving(true);
		mutate({ action: "upsert", ...body })
			.then(() => {
				setMsg(body.code === void 0 ? "已保存" : `已保存 ${body.code}`);
				setOpenCode(null);
				setAddOpen(false);
				load();
			})
			.catch(notifyFailure("保存基金持仓"))
			.finally(() => setSaving(false));
	};
	const remove = (fund) => {
		lkbConfirm(`确定删除 ${fund.name ?? ""}（${fund.code}）的持仓记录吗？`).then((ok) => {
			if (!ok) return;
			setSaving(true);
			mutate({ action: "delete", code: fund.code })
				.then(() => {
					setMsg(`已删除 ${fund.code}`);
					setOpenCode(null);
					load();
				})
				.catch(notifyFailure("删除基金持仓"))
				.finally(() => setSaving(false));
		});
	};
	const funds = data?.funds ?? [];
	const summary = data?.summary ?? {};
	const fundPnl = num(summary.fundTotalPnl);
	const marketValue = num(summary.fundMarketValue);
	const totalCost = num(summary.fundTotalCost);
	const returnPct = num(summary.fundTotalReturnPct);
	const updated = data?.updatedAt === void 0 || data?.updatedAt === "" ? "" : clockOf(data.updatedAt);
	const summaryBar = h(
		"div",
		// 与自选页汇总条同构（.lkb-posSummary / .lkb-posTag）：市值 / 成本 / 浮动盈亏 / 收益率，
		// 指标全部由 Host 算好，这里只渲染。
		{ className: "lkb-posSummary" },
		h("span", { className: "lkb-posTag" }, `基金 ${funds.length} 只`),
		h("span", null, "市值 ", h("b", null, fmtAmount(marketValue))),
		h("span", null, "成本 ", h("b", null, fmtAmount(totalCost))),
		// A 股口径：盈利红、亏损绿（trend() 与自选页持仓汇总同一套，别反过来）。
		h("span", null, "浮动盈亏 ", h("b", { className: trend(fundPnl) }, fmtSign(fundPnl))),
		returnPct === null ? null : h("span", null, "收益率 ", h("b", { className: trend(returnPct) }, fmtPct(returnPct))),
		updated === "" ? null : h("span", { className: "lkb_fundDim" }, `更新于 ${updated}`)
	);
	const addRow = h(
		"div",
		{ className: "lkb_fundAddRow" },
		h(
			"button",
			{ className: "lkb-chip", "data-active": addOpen ? "true" : "false", onClick: () => setAddOpen((v) => !v) },
			addOpen ? "收起" : "＋ 添加基金"
		),
		h("span", { className: "lkb_fundDim" }, "数据由宿主在披露窗口内分段刷新"),
		msg === "" ? null : h("span", { className: "lkb-status" }, msg)
	);
	const body = !(data !== null) && loading
		? h("div", { className: "lkb-empty" }, "加载中…")
		: funds.length === 0
			? h("div", { className: "lkb-empty" }, "暂无基金持仓。点击「＋ 添加基金」录入代码与成本净值，即可跟踪盈亏与浮盈。")
			: h(
					"table",
					null,
					// 真正的 <table>：th/td 全部走 .lkb_card 那套表格样式（白底圆角、11px 表头、
					// 行分隔线、悬停左侧主色条），与自选页/行情页的表格在结构上就是同一样东西。
					h(
						"thead",
						null,
						h(
							"tr",
							null,
							h("th", null, "基金"),
							h("th", null, "最新净值"),
							h("th", { title: "相对成本净值的盈亏百分比（分母是成本净值）" }, "盈亏"),
							h("th", { title: "成本净值，点单元格可直接改" }, "成本"),
							h("th", { title: "持有份额，点单元格可直接改" }, "份额"),
							h("th", { title: "按份额与最新净值计算的浮动盈亏（保留两位小数）" }, "浮盈"),
							h("th", null, "")
						)
					),
					h(
						"tbody",
						null,
						funds.map((fund) => {
							const code = String(fund.code ?? "");
							const dist = num(fund.distanceToCostPct);
							const estimate = fund.estimateAvailable === true;
							const nav = estimate ? num(fund.estimateNav) ?? num(fund.latestNav) : num(fund.latestNav);
							const open = openCode === code;
							const rowPnl = num(fund.pnl);
							const toggle = () => setOpenCode(open ? null : code);
							return [
								h(
									"tr",
									{ key: code, onClick: toggle },
									h(
										"td",
										null,
										h("span", { className: "lkb-name" }, fund.name || code),
										h("span", { className: "lkb-code" }, code),
										fund.stale === true ? h("span", { className: "lkb_fundFlag", title: "宿主在披露窗口内未取到新净值" }, "数据未更新") : null
									),
									h(
										"td",
										null,
										h("span", { className: "lkb_fundNavVal" }, fmt(nav, 4)),
										h("span", { className: "lkb_fundBadge", "data-est": estimate ? "true" : "false" }, estimate ? "估值" : "已披露"),
										h("span", { className: "lkb_fundDim" }, estimate ? fund.estimateTime || "估值中" : fund.latestDate || "—")
									),
									h("td", { className: trend(dist) }, dist === null ? "—" : fmtPct(dist)),
									h(
										"td",
										null,
										h(EditableCell, {
											value: num(fund.costNav),
											display: fmt(fund.costNav, 4),
											placeholder: "+成本",
											onSave: (v) => saveField(fund, { costNav: v }),
										})
									),
									h(
										"td",
										null,
										h(EditableCell, {
											value: num(fund.shares),
											display: fund.shares === null || fund.shares === void 0 ? "—" : String(fund.shares),
											placeholder: "+份额",
											onSave: (v) => saveField(fund, { shares: v }),
										})
									),
									h("td", { className: trend(rowPnl) }, rowPnl === null ? "—" : fmtSign(rowPnl)),
									h(
										"td",
										null,
										h(
											"button",
											{
												className: "lkb-chip",
												"data-active": open ? "true" : "false",
												onClick: (event) => {
													// 行本身也绑了 toggle，按钮这里必须阻止冒泡，否则会连开再关
													event.stopPropagation();
													toggle();
												},
											},
											open ? "收起" : "编辑"
										)
									)
								),
								open
									? h(
											"tr",
											{ key: `${code}-detail` },
											h(
												"td",
												{ colSpan: 7, className: "lkb_fundDetailCell" },
												h(
													"div",
													{ className: "lkb_fundDetail" },
													h(FundEditForm, {
														fund: fund,
														saving: saving,
														onSave: (patch) => upsert({ code: code, ...patch }),
														onCancel: () => setOpenCode(null),
														onDelete: () => remove(fund),
													}),
													h(NavChart, { points: navPoints(fund.navHistory), costNav: fund.costNav })
												)
											)
										)
									: null
							];
						})
					)
				);
	return h(
		"div",
		// 必须挂一个类：没有它整页就没有基准字号，会继承浏览器默认 16px，
		// 而面板其它页（.lkb_card table）是 12.5px，看起来就"字体不一致"。
		{ className: "lkb_fundPage" },
		data === null ? null : summaryBar,
		addRow,
		addOpen ? h(AddFundForm, { saving: saving, onSave: (patch) => upsert(patch), onCancel: () => setAddOpen(false) }) : null,
		// 轮询失败时不再清空已有内容：错误条挂在上面，下方仍显示上一份快照（行情类
		// 页面最忌讳"抖一下就把表格换成一行红字"）。
		error === "" ? null : h("div", { className: "lkb-error" }, error),
		body
	);
}
