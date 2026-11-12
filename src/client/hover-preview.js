// 持仓看板 dsh-portfolio — 客户端 bundle 源码：悬停预览（hover 浮窗）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 用法：列表行 onMouseEnter 时调用 showPreview({...})，鼠标离开后 hidePreview()。
// 设计要求（用户原话「鼠标悬停在对应股票和基金项上时显示浮窗，移开后取消」）：
//   1. **延迟出现**：划过一行不弹窗，停留约 380ms 才出——否则快速扫表会满屏闪烁；
//   2. **移开即消失**，但给一个很短的宽限（约 160ms）：鼠标从行移到浮窗上时不至于
//      立刻消失（浮窗本身可交互，比如点「打开详情」）；
//   3. **单例**：同一时刻只有一个预览浮窗，切行即换内容而不是叠一堆；
//   4. **定位**：贴在触发行的右侧/左侧（空间不够时自动翻边），并夹回视口；
//   5. 预览内容是**轻量快照**（报价 + 分时小图），不拉资金流/F10——那些留给右栏与
//      完整子页，悬停预览不该替用户发起重请求。
//
// 实现是"订阅式单例 + 一个渲染宿主"，与 core.js 的 toast/confirm 同一套路：
// 列表页只管调用 showPreview/hidePreview，不必各自维护浮窗状态。
import { h, useEffect, useRef, useState } from "./react.js";
import { StockDetailContent } from "./detail.js";
import { FundDetailContent } from "./fund-detail.js";

/** 停留多久才出现（ms）。太快会满屏闪，太慢显得没反应。 */
const SHOW_DELAY = 380;
/** 鼠标离开后等多久才收起（ms）：留给"从行移到浮窗"的时间。 */
const HIDE_GRACE = 160;

let previewState = null;
const previewListeners = new Set();
let showTimer = null;
let hideTimer = null;

function emit(next) {
	previewState = next;
	previewListeners.forEach((fn) => fn(next));
}

/** 计划在 delay 后显示预览；同一个 code 重复调用会被忽略（避免反复重置计时器）。 */
export function showPreviewSoon(payload, delay = SHOW_DELAY) {
	clearTimeout(hideTimer);
	hideTimer = null;
	if (previewState !== null && previewState.code === payload.code) return;
	clearTimeout(showTimer);
	showTimer = setTimeout(() => {
		showTimer = null;
		emit({ ...payload, anchor: payload.anchor ?? null });
	}, delay);
}

/** 取消显示计划（鼠标还在行上但还没到延迟、或已经离开）。 */
export function cancelPreviewSoon() {
	clearTimeout(showTimer);
	showTimer = null;
}

/** 立即收起；带宽限时用于"指针可能移进浮窗"的场景。 */
export function hidePreview(immediate = false) {
	cancelPreviewSoon();
	if (immediate) {
		clearTimeout(hideTimer);
		hideTimer = null;
		emit(null);
		return;
	}
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => {
		hideTimer = null;
		emit(null);
	}, HIDE_GRACE);
}

/** 指针进入浮窗本体时调用：取消待执行的收起。 */
export function keepPreview() {
	clearTimeout(hideTimer);
	hideTimer = null;
}

/** 订阅预览状态（宿主组件用）。 */
export function onPreview(fn) {
	previewListeners.add(fn);
	return () => previewListeners.delete(fn);
}

/** 给列表行用的便捷接线：返回可直接铺开的鼠标事件处理器。
 *  `getAnchor` 返回触发元素（用来定位浮窗），`payload` 是预览内容。
 *  注意返回里同时给了 mouseenter/leave/focus/blur：键盘 Tab 到行上也该能预览。 */
export function previewHandlers(payload, getAnchor) {
	return {
		onMouseEnter: (e) => {
			const anchor = getAnchor !== undefined ? getAnchor(e) : e.currentTarget;
			showPreviewSoon({ ...payload, anchor });
		},
		onMouseLeave: () => hidePreview(false),
		onFocus: (e) => {
			const anchor = getAnchor !== undefined ? getAnchor(e) : e.currentTarget;
			showPreviewSoon({ ...payload, anchor });
		},
		onBlur: () => hidePreview(true),
	};
}

/**
 * 列表行的悬停预览接线（只出两个事件处理器，点击仍由各列表自己的 onClick 管）。
 *
 * 各列表（自选/行情/选股/大盘/基金）行结构不同，但悬停预览的载荷拼装是同一种：
 * 这里统一产出 `{ onMouseEnter, onMouseLeave }`，各列表铺开即可，
 * 避免每个列表各写一遍（漏写就表现为"某些列表不预览"）。
 *
 * @param row { code, name, isIndex?, kind?, fund? } 行数据快照
 */
export function rowHover(row) {
	const payload =
		row.kind === "fund"
			? { kind: "fund", code: row.code, name: row.name, fund: row.fund ?? row }
			: { kind: "stock", code: row.code, name: row.name, isIndex: row.isIndex === true };
	return {
		onMouseEnter: (e) => showPreviewSoon({ ...payload, anchor: e.currentTarget }),
		onMouseLeave: () => hidePreview(false),
	};
}

/** 计算浮窗位置：优先贴在行的右侧；右边放不下就翻到左侧；最后夹回视口。
 *  纯函数，便于对照测试（不碰 DOM）。 */
export function previewPosition(rect, size, viewport) {
	const gap = 12;
	const margin = 8;
	let left = rect.right + gap;
	if (left + size.width > viewport.width - margin) {
		const flipped = rect.left - gap - size.width;
		// 左侧也放不下时，退化为"贴右边缘对齐行"（至少不出界）
		left = flipped >= margin ? flipped : Math.max(margin, viewport.width - margin - size.width);
	}
	let top = rect.top;
	if (top + size.height > viewport.height - margin) top = Math.max(margin, viewport.height - margin - size.height);
	if (top < margin) top = margin;
	return { left, top };
}

/** 预览浮窗宿主：挂在页面里，订阅预览状态。 */
export function PreviewHost() {
	const [state, setState] = useState(previewState);
	const boxRef = useRef(null);
	const [pos, setPos] = useState(null);
	useEffect(() => onPreview((next) => setState(next)), []);
	// 定位：等浮窗渲染出来拿到实际尺寸后再算，避免按估算值摆歪。
	useEffect(() => {
		if (state === null || state.anchor === null) {
			setPos(null);
			return;
		}
		const el = boxRef.current;
		if (el === null) return;
		const rect = state.anchor.getBoundingClientRect();
		const size = el.getBoundingClientRect();
		setPos(previewPosition(rect, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }));
	}, [state]);
	if (state === null) return null;
	const sel = state;
	return h(
		"div",
		{
			className: "lkb-hoverCard",
			ref: boxRef,
			style: pos === null ? { visibility: "hidden", left: 0, top: 0 } : { left: pos.left, top: pos.top },
			onMouseEnter: keepPreview,
			onMouseLeave: () => hidePreview(false),
			role: "tooltip",
		},
		h(
			"div",
			{ className: "lkb-hoverHead" },
			h("span", { className: "lkb-hoverTitle" }, sel.kind === "fund" ? sel.fund?.name || sel.name || sel.code : sel.name ?? sel.code),
			h("span", { className: "lkb-code" }, sel.code),
			h("button", { className: "lkb_close", title: "关闭预览", onClick: () => hidePreview(true) }, "✕")
		),
		sel.kind === "fund"
			? h(FundDetailContent, { fund: sel.fund, variant: "preview" })
			: h(StockDetailContent, { code: sel.code, name: sel.name, isIndex: sel.isIndex, variant: "preview" })
	);
}
