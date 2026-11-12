// 持仓看板 dsh-portfolio — 客户端 bundle 源码：场外基金页（净值 / 估值、盈亏百分比、历史净值曲线）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { API, api, describeError, fmt, fmtAmount, fmtPct, fmtSign, lkbConfirm, notifyFailure, trend, useInterval } from "./core.js";
import { rowHover } from "./hover-preview.js";

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
/** 新增基金持仓：只要求 6 位基金代码，名称/份额/成本净值可后补（走同一个 upsert）。 */

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
export function OtcFundTab({ active = true, onOpen, bump = 0 }) {
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
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
	// 详情浮窗里删除持仓后，面板会 bump 一下，这里跟着刷新。
	useEffect(() => {
		if (bump > 0) load();
	}, [bump]);
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
	const body = !(data !== null) && loading
		? h("div", { className: "lkb-empty" }, "加载中…")
		: funds.length === 0
			? h("div", { className: "lkb-empty" }, "暂无基金持仓。到「行情」页搜索基金，打开详情后点「加入基金」即可跟踪盈亏与浮盈。")
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
							h("th", { title: "按份额与最新净值计算的浮动盈亏（保留两位小数）" }, "浮盈")
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
							const rowPnl = num(fund.pnl);
							// 点行打开基金详情浮窗（与自选页点行开详情窗同一套交互）
							return h(
								"tr",
								{ key: code, onClick: () => onOpen(fund), ...rowHover({ kind: "fund", code, name: fund?.name, fund }) },
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
									{ onClick: (e) => e.stopPropagation() },
									h(EditableCell, {
										value: num(fund.costNav),
										display: fmt(fund.costNav, 4),
										placeholder: "+成本",
										onSave: (v) => saveField(fund, { costNav: v }),
									})
								),
								h(
									"td",
									{ onClick: (e) => e.stopPropagation() },
									h(EditableCell, {
										value: num(fund.shares),
										display: fund.shares === null || fund.shares === void 0 ? "—" : String(fund.shares),
										placeholder: "+份额",
										onSave: (v) => saveField(fund, { shares: v }),
									})
								),
								h("td", { className: trend(rowPnl) }, rowPnl === null ? "—" : fmtSign(rowPnl))
							);
						})
					)
				);
	return h(
		"div",
		// 必须挂一个类：没有它整页就没有基准字号，会继承浏览器默认 16px，
		// 而面板其它页（.lkb_card table）是 12.5px，看起来就"字体不一致"。
		{ className: "lkb_fundPage" },
		data === null ? null : summaryBar,
		// 轮询失败时不再清空已有内容：错误条挂在上面，下方仍显示上一份快照（行情类
		// 页面最忌讳"抖一下就把表格换成一行红字"）。
		error === "" ? null : h("div", { className: "lkb-error" }, error),
		body
	);
}
