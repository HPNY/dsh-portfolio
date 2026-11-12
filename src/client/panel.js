// 持仓看板 dsh-portfolio — 客户端 bundle 源码：主面板页面（页签 + 右栏联动详情 + 钻取子页 + 预警 toast）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 「弹窗 → 页面」迁移后的形态：本组件由宿主经 main slot 挂载（见 entry.js），
// 不再自带 createRoot / 遮罩 / 拖拽 / 关闭按钮；个股与基金详情是右栏联动
// （DetailRail），「⤢ 打开完整详情」钻取为子页（SubDetail）。弹窗时代的
// 窗口系统（wins/z 序/拖拽/ESC 关窗）已全部退役。
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { API, api, calendarHint, closeConfirm, ConfirmDialog, confirmListeners, cnMarket, loadAnalysisConfig, marketOpenLabel, normCode, onToast, ToastStack, useAnalysisConfig, useInterval } from "./core.js";
import { IndicesTab } from "./indices-tab.js";
import { MarketTab } from "./market-tab.js";
import { WatchlistTab } from "./watchlist-tab.js";
import { ScreenerTab } from "./screener-tab.js";
import { NewsTab } from "./news-tab.js";
import { AnalysisTab } from "./analysis-tab.js";
import { OtcFundTab } from "./otc-fund-tab.js";
import { SettingsDialog } from "./settings.js";
import { StockDetailContent } from "./detail.js";
import { FundDetailContent } from "./fund-detail.js";
import { DISPLAY_NAME } from "../../lib/identity.js";
import { BRAND_ICON_SVG } from "./icon.js";

const TABS = [
	{ key: "indices", label: "大盘" },
	{ key: "market", label: "行情" },
	{ key: "watchlist", label: "自选" },
	{ key: "screener", label: "选股" },
	{ key: "news", label: "快讯" },
	{ key: "analysis", label: "分析" },
	{ key: "otcFund", label: "基金" },
];

/** 标签图标：手写 24×24 描边路径（Lucide 风格）。
 *
 * 不用 emoji：字体缺字时会出现豆腐块、各平台画风也不一致，而且 emoji 无法跟随
 * currentColor 变主题色。统一描边 1.8、颜色继承文字，选中态由 CSS 换成主色。
 */
const TAB_ICONS = {
	// 大盘：柱状图（指数概览）
	indices: [
		["path", { d: "M3 3v16.5A1.5 1.5 0 0 0 4.5 21H21" }],
		["path", { d: "M17.5 18V10" }],
		["path", { d: "M12.5 18V6" }],
		["path", { d: "M7.5 18v-5" }],
	],
	// 行情：K 线（报价板）
	market: [
		["path", { d: "M8 3v2.5" }],
		["rect", { x: 5.75, y: 5.5, width: 4.5, height: 8, rx: 1 }],
		["path", { d: "M8 13.5V17" }],
		["path", { d: "M16 6v2" }],
		["rect", { x: 13.75, y: 8, width: 4.5, height: 9, rx: 1 }],
		["path", { d: "M16 17v3" }],
	],
	// 自选：五角星（key 必须与 TABS 里的 key 一致，否则 tabIcon() 拿到空数组、
	// 这个标签就没有图标——之前写成 star 而 TABS 用的是 watchlist，正是这个 bug）
	watchlist: [["path", { d: "M12 3.6l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.87l-5.2 2.73.99-5.78-4.21-4.1 5.82-.85z" }]],
	// 选股：漏斗筛选
	screener: [
		["path", { d: "M3.5 5.5h17" }],
		["path", { d: "M6.5 12h11" }],
		["path", { d: "M10 18.5h4" }],
	],
	// 快讯：报纸
	news: [
		["path", { d: "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V19H5.5A1.5 1.5 0 0 1 4 17.5z" }],
		["path", { d: "M16 9h2.5A1.5 1.5 0 0 1 20 10.5v6a2.5 2.5 0 0 1-2.5 2.5" }],
		["path", { d: "M7 8.5h6" }],
		["path", { d: "M7 12.5h6" }],
	],
	// 分析：双星（AI 火花）
	analysis: [
		["path", { d: "M12 3.5l1.9 4.35 4.35 1.9-4.35 1.9L12 16l-1.9-4.35-4.35-1.9 4.35-1.9z" }],
		["path", { d: "M18.5 15.5l.9 2.05 2.05.9-2.05.9-.9 2.05-.9-2.05-2.05-.9 2.05-.9z" }],
	],
	// 场外基金：净值曲线（坐标轴 + 右上趋势线与箭头）。
	otcFund: [
		["path", { d: "M3 3v16.5A1.5 1.5 0 0 0 4.5 21H21" }],
		["path", { d: "M7 14.8l3.8-4.2 3 2.7 4.7-5.6" }],
		["path", { d: "M15.6 7.7h2.9v2.9" }],
	],
};

/** 把 TAB_ICONS 的路径描述渲染成 <svg>。 */
function tabIcon(key) {
	const paths = TAB_ICONS[key] ?? [];
	return h(
		"svg",
		{
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.8,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			focusable: "false",
		},
		paths.map(([tag, attrs], i) => h(tag, { key: i, ...attrs }))
	);
}

/** ESC 的作用目标（纯函数，导出以便逐场景对照测试）。
 *
 * 页面化后没有"窗口栈"了，ESC 的层级变成：先退钻取子页（drill），再收起右栏
 * 详情（selection），都没有就什么都不做——页面不像弹窗那样可以"关掉"。
 * 输入框里的 ESC 由调用方先行放行，不进这里。
 */
export function escTarget(view) {
	if (view.drill === true) return "drill";
	if (view.selected === true) return "selection";
	return null;
}

export function PortfolioPage() {
	const [tab, setTab] = useState("indices");
	// 右栏联动的当前选中（个股/基金）与钻取子页快照。
	const [selected, setSelected] = useState(null);
	const [drill, setDrill] = useState(null);
	// 浮窗（方向 A 叠加）：右栏常驻联动之外，用户可把若干标的**钉成浮窗**并排对比
	// （与弹窗时代的"多开对比"同一用法）。浮窗只读展示报价+分时，不抢右栏职责。
	const [floats, setFloats] = useState([]);
	const [watchCodes, setWatchCodes] = useState([]);
	const [watchBump, setWatchBump] = useState(0);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// 全局 AI 模型配置（订阅式单例）：面板挂载时拉一次，设置弹窗/分析页共享。
	const analysisCfg = useAnalysisConfig();
	useEffect(() => {
		loadAnalysisConfig();
	}, []);
	// 点行 → 右栏联动（不再是开窗）。指数同样进右栏；不可交易的语义由内容层标注。
	const openStock = useCallback((rawCode, rawName) => {
		const code = normCode(rawCode ?? "");
		if (!/^(sh|sz|bj)\d{6}$/.test(code)) return;
		const name = rawName ?? rawCode;
		// Index codes (上证/深证系列、北证指数) show a quote too — but
		// they are not tradable: no 加自选 and no 涨停/跌停 display.
		const isIndex = /^(sh000|sz399|sh899|bj899)/.test(code);
		setSelected({ kind: "stock", code, name, isIndex });
		setDrill(null);
	}, []);
	// 基金详情：接受整行快照（基金页点行）或 (code, name)（行情页搜索结果）。
	const openFund = useCallback((raw, maybeName) => {
		const fund = typeof raw === "object" && raw !== null ? raw : { code: raw, name: maybeName };
		const code = String(fund?.code ?? "");
		if (!/^\d{6}$/.test(code)) return;
		setSelected({ kind: "fund", code, name: fund?.name ?? code, fund });
		setDrill(null);
	}, []);
	const bumpWatch = () => setWatchBump((v) => v + 1);
	const [fundBump, setFundBump] = useState(0);
	const bumpFund = () => setFundBump((v) => v + 1);
	// 浮窗：把当前右栏标的钉成浮窗（同码已开则提到最前，不重复开）。
	// 位置按已开数量错开，避免完全重叠；z 递增保证后开的在上。
	const pinFloat = useCallback(() => {
		if (selected === null) return;
		setFloats((prev) => {
			const exist = prev.find((f) => f.code === selected.code);
			const z = (prev.reduce((m, f) => Math.max(m, f.z), 100) ?? 100) + 1;
			if (exist) return prev.map((f) => (f.code === selected.code ? { ...f, z } : f));
			const k = prev.length;
			return [...prev, { ...selected, id: `${selected.code}-${z}`, x: 24 + k * 28, y: 96 + k * 24, z }];
		});
	}, [selected]);
	const closeFloat = (code) => setFloats((prev) => prev.filter((f) => f.code !== code));
	const focusFloat = (code) =>
		setFloats((prev) => {
			const z = (prev.reduce((m, f) => Math.max(m, f.z), 100) ?? 100) + 1;
			return prev.map((f) => (f.code === code ? { ...f, z } : f));
		});
	// In-panel confirm dialog host (replaces native window.confirm).
	const [confirmReq, setConfirmReq] = useState(null);
	// 预警 toast：AlertWatcher 常驻在 entry.js（随插件而不是随面板存活），
	// 触发时经 core 的 pushToast 广播过来，面板只负责渲染。
	const [toasts, setToasts] = useState([]);
	const dismissToast = useCallback((id) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);
	useEffect(() => {
		return onToast((toast) => {
			setToasts((prev) => [...prev.slice(-3), toast]);
			setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), 10000);
		});
	}, []);
	useEffect(() => {
		const fn = (req) => setConfirmReq(req);
		confirmListeners.add(fn);
		return () => confirmListeners.delete(fn);
	}, []);
	useEffect(() => {
		return () => {
			// Unmounting with a pending confirm would otherwise leave the
			// promise forever unresolved: the panel is gone, so nothing can
			// call closeConfirm, confirmState stays set and every later
			// lkbConfirm silently resolves false — stars stop working until
			// the page reloads.
			closeConfirm(false);
		};
	}, []);
	// ESC：先退钻取子页，再收起右栏详情（层级见 escTarget）；输入框里的 ESC 不劫持。
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "Escape") return;
			const t = e.target;
			if (t !== null && t !== void 0 && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			const target = escTarget({ drill: drill !== null, selected: selected !== null });
			if (target === "drill") setDrill(null);
			else if (target === "selection") setSelected(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [drill, selected]);
	useEffect(() => {
		let alive = true;
		const refresh = () =>
			api(API.watchlist)
				.then((d) => {
					if (alive) setWatchCodes((d.watchlist ?? []).map((e) => normCode(e.code)));
				})
				.catch(() => {});
		refresh();
		const timer = setInterval(refresh, 20000);
		// StarButton broadcasts this so ★ state updates without waiting for
		// the next 20s poll.
		window.addEventListener("leekbox:watchlist-changed", refresh);
		return () => {
			alive = false;
			clearInterval(timer);
			window.removeEventListener("leekbox:watchlist-changed", refresh);
		};
	}, []);
	// 顶部"交易中/休市"这枚标签只看本地时钟，没有任何数据变化能触发它重算：
	// 已有的 20s 自选轮询一旦失败/停摆，标签就永远停在挂载那一刻。这里单独给
	// 一拍心跳，保证跨过 9:15 / 9:30 / 11:30 / 13:00 / 15:00 时标签能自己翻面。
	// eslint-disable-next-line no-unused-vars
	const [_clockTick, setClockTick] = useState(0);
	useInterval(() => setClockTick((v) => (v + 1) % 1000000), 30 * 1000);
	// 标签栏的键盘导航：←/→ 循环、Home/End 跳首尾。roving tabindex —— 只有选中项
	// tabIndex=0，所以 Tab 键进得来、出去得走，不会在 5 个标签里转圈。
	const onTabKeyDown = (e) => {
		const { key } = e;
		if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
		e.preventDefault();
		const from = TABS.findIndex((t) => t.key === tab);
		const to =
			key === "Home"
				? 0
				: key === "End"
					? TABS.length - 1
					: key === "ArrowLeft"
						? (from - 1 + TABS.length) % TABS.length
						: (from + 1) % TABS.length;
		setTab(TABS[to].key);
		const nodes = e.currentTarget.querySelectorAll("button.lkb_tab");
		if (nodes[to] !== void 0) nodes[to].focus();
	};
	// 自选数量做成标签徽标：用户不用切过去就知道自选里有几只。
	const tabBadge = (key) => (key === "watchlist" && watchCodes.length > 0 ? watchCodes.length : null);
	const mkt = marketOpenLabel();
	const body =
		tab === "indices"
			? h(IndicesTab, { onOpen: openStock })
			: tab === "market"
				? h(MarketTab, { onOpen: openStock, onOpenFund: openFund, watchCodes })
				: tab === "watchlist"
					? h(WatchlistTab, { onOpen: openStock, bump: watchBump })
					: tab === "screener"
						? h(ScreenerTab, { onOpen: openStock, watchCodes })
						: tab === "analysis"
							? h(AnalysisTab, { onOpen: openStock, configured: analysisCfg.configured, onOpenSettings: () => setSettingsOpen(true) })
							: tab === "otcFund"
								? h(OtcFundTab, { onOpen: openFund, bump: fundBump })
								: h(NewsTab, { onOpen: openStock });
	return h(
		"div",
		{ className: "lkb-page" },
		h(
			"div",
			{ className: "lkb_head" },
			h("span", { className: "lkb_headTitle" }, h("span", { className: "lkb-logo", dangerouslySetInnerHTML: { __html: BRAND_ICON_SVG } }), DISPLAY_NAME),
			h(
				"div",
				{ className: "lkb_headRight" },
				h("span", { className: "lkb_mktStatus", "data-open": mkt.open ? "true" : "false", title: calendarHint() }, mkt.label),
				h("button", { className: "lkb_settingsBtn", title: "全局设置", onClick: () => setSettingsOpen(true) }, "⚙️")
			)
		),
		// 钻取子页态隐藏页签栏（子页面包屑承担导航）。
		drill === null
			? h(
					"div",
					{ className: "lkb_tabBar", role: "tablist", "aria-label": `${DISPLAY_NAME}面板`, onKeyDown: onTabKeyDown },
					h(
						"div",
						{ className: "lkb_tabTrack" },
						TABS.map((t) => {
						const active = tab === t.key;
						const badge = tabBadge(t.key);
						return h(
							"button",
							{
								key: t.key,
								type: "button",
								className: "lkb_tab",
								id: `lkb-tab-${t.key}`,
								role: "tab",
								title: t.label,
								"aria-selected": active ? "true" : "false",
								"aria-controls": "lkb-tabpanel",
								tabIndex: active ? 0 : -1,
								"data-active": active ? "true" : "false",
								onClick: () => setTab(t.key),
							},
							h("span", { className: "lkb_tabIcon", "aria-hidden": "true" }, tabIcon(t.key)),
							h("span", { className: "lkb_tabLabel" }, t.label),
							badge === null ? null : h("span", { className: "lkb_tabBadge" }, String(badge))
						);
					})
				)
				)
			: null,
		drill !== null
			? h(SubDetail, { sel: drill, onBack: () => setDrill(null), onWatched: bumpWatch, onFundChanged: bumpFund })
			: h(
					"div",
					{ className: "lkb-split" },
					h(
			"div",
			{ className: "lkb_body", id: "lkb-tabpanel", role: "tabpanel", "aria-labelledby": `lkb-tab-${tab}` },
			h("div", { key: tab, className: "lkb_tabPanelIn" }, body)
		),
					selected === null
						? null
						: h(DetailRail, {
								sel: selected,
								onClose: () => setSelected(null),
								onDrill: () => setDrill(selected),
								onPin: pinFloat,
								pinned: floats.some((f) => f.code === selected.code),
								onWatched: bumpWatch,
								onFundChanged: bumpFund,
							})
				),
		// 浮窗层（方向 A 叠加）：钉住的标的并排对比，可拖拽/关闭/置顶。
		floats.length === 0 ? null : h(FloatLayer, { floats, onClose: closeFloat, onFocus: focusFloat }),
		h(
			"div",
			{ className: "lkb_foot" },
			h("span", null, "数据来源：腾讯财经 / 新浪财经 / 东方财富 / 金十数据"),
			h("span", null, "仅供研究参考，不构成投资建议。股市有风险，入市需谨慎。")
		),
		settingsOpen ? h(SettingsDialog, { onClose: () => setSettingsOpen(false) }) : null,
		confirmReq === null ? null : h(ConfirmDialog, { text: confirmReq.text }),
		h(ToastStack, { toasts, onDismiss: dismissToast })
	);
}

/** 钻取子页：面包屑 + 完整详情（设计方向 B 的整页形态，由右栏「⤢ 打开完整详情」进入）。 */
function SubDetail({ sel, onBack, onWatched, onFundChanged }) {
	const mkt = sel.kind === "stock" ? cnMarket(String(sel.code).slice(0, 2).toUpperCase()) : "";
	return h(
		"div",
		{ className: "lkb-sub" },
		h(
			"div",
			{ className: "lkb-crumb" },
			h("button", { className: "lkb-backBtn", type: "button", onClick: onBack }, "‹ 返回"),
			h("span", { className: "lkb-subTitle" }, sel.kind === "fund" ? sel.fund?.name || sel.name || sel.code : sel.name ?? sel.code),
			h("span", { className: "lkb-code" }, sel.code),
			mkt === "" ? null : h("span", { className: "lkb-mktTag" }, mkt)
		),
		sel.kind === "fund"
			? h(FundDetailContent, { fund: sel.fund, onChanged: onFundChanged, variant: "page" })
			: h(StockDetailContent, { code: sel.code, name: sel.name, isIndex: sel.isIndex, onWatched, variant: "page" })
	);
}

/** 浮窗层（方向 A 叠加在方向 C 之上）：把钉住的标的做成可拖拽浮窗并排对比。
 *
 * 与弹窗时代的多窗对比是同一用法，但职责收窄：浮窗只承载「报价 + 分时」的轻量
 * 对比视图（完整分析仍在右栏 / 钻取子页），所以不开满详情、不抢右栏。
 * 拖拽用 pointer 事件 + 视口夹取，逻辑与旧详情窗一致（避免浮窗被拖出屏幕）。
 */
function FloatLayer({ floats, onClose, onFocus }) {
	return h(
		"div",
		{ className: "lkb-floatLayer" },
		floats.map((f) => h(FloatCard, { key: f.id, item: f, onClose: () => onClose(f.code), onFocus: () => onFocus(f.code) }))
	);
}

function FloatCard({ item, onClose, onFocus }) {
	const [pos, setPos] = useState({ x: item.x, y: item.y });
	const dragRef = useRef(null);
	const onPointerDown = (e) => {
		onFocus();
		if (e.button !== 0) return;
		if (e.target.closest("button") !== null) return; // 让按钮正常工作
		const el = e.currentTarget;
		const rect = el.getBoundingClientRect();
		dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height };
		el.setPointerCapture?.(e.pointerId);
		e.preventDefault();
	};
	const onPointerMove = (e) => {
		const d = dragRef.current;
		if (d === null) return;
		// 夹回视口：浮窗不能被拖出屏幕（右/下边界留 8px，至少留 80px 可见）
		const x = Math.max(8 - d.w + 80, Math.min(e.clientX - d.dx, window.innerWidth - 80));
		const y = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - 40));
		setPos({ x, y });
	};
	const onPointerUp = (e) => {
		dragRef.current = null;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
	};
	return h(
		"div",
		{
			className: "lkb-floatWin",
			style: { left: pos.x, top: pos.y, zIndex: item.z },
			onPointerDown: onPointerDown,
			onPointerMove: onPointerMove,
			onPointerUp: onPointerUp,
			onPointerCancel: onPointerUp,
		},
		h(
			"div",
			{ className: "lkb-floatHead", title: "拖动移动 · 点击置顶" },
			h("span", { className: "lkb-floatTitle" }, item.name ?? item.code),
			h("span", { className: "lkb-code" }, item.code),
			h("button", { className: "lkb_close", title: "关闭浮窗", onClick: onClose }, "✕")
		),
		item.kind === "fund"
			? h(FundDetailContent, { fund: item.fund, variant: "rail" })
			: h(StockDetailContent, { code: item.code, name: item.name, isIndex: item.isIndex, variant: "rail" })
	);
}
/** 右栏联动详情（设计方向 C）：列表点行即切换，✕ 收起，⤢ 钻取完整详情，
 *  ⧉ 把当前标的钉成浮窗（方向 A 叠加：右栏看一只、浮窗并排对比多只）。 */
function DetailRail({ sel, onClose, onDrill, onPin, pinned, onWatched, onFundChanged }) {
	return h(
		"aside",
		{ className: "lkb-rail" },
		h(
			"div",
			{ className: "lkb-railHead" },
			h("span", { className: "lkb-railTitle" }, sel.kind === "fund" ? sel.fund?.name || sel.name || sel.code : sel.name ?? sel.code),
			h("span", { className: "lkb-code" }, sel.code),
			h(
				"button",
				{
					className: "lkb-pinBtn",
					type: "button",
					title: pinned ? "已钉为浮窗（可并排对比）" : "钉为浮窗并排对比",
					"data-active": pinned ? "true" : "false",
					"aria-pressed": pinned ? "true" : "false",
					onClick: onPin,
				},
				"⧉"
			),
			h("button", { className: "lkb_close", title: "收起详情栏", onClick: onClose }, "✕")
		),
		sel.kind === "fund"
			? h(FundDetailContent, { fund: sel.fund, onChanged: onFundChanged, onDrill, variant: "rail" })
			: h(StockDetailContent, { code: sel.code, name: sel.name, isIndex: sel.isIndex, onWatched, onDrill, variant: "rail" })
	);
}

/** 侧栏面板行的图标（sidebar.panellist 的注册组件）：宿主按 size 传 16（展开）/ 18（折叠栏）。
 *  品牌 SVG 是 currentColor 线框，自动随行的选中态与深色主题变色。 */
export function PanelIcon({ size = 16 }) {
	return h("span", {
		className: "lkb_panelIcon",
		style: { width: size + "px", height: size + "px" },
		dangerouslySetInnerHTML: { __html: BRAND_ICON_SVG },
	});
}
