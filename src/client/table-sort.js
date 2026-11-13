// 持仓看板 dsh-portfolio — 客户端 bundle 源码：表格排序与自定义（拖拽）排序
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 需求（用户原话）：「实现自选和基金部分支持按列排序以及个人自定义排序功能」。
// 两个列表都要：
//   1. **按列排序**：点表头在「升序 → 降序 → 取消」间循环，表头显示方向箭头；
//   2. **自定义排序**：手动拖动行调整顺序，顺序持久化到服务端，重开仍在。
//
// 纯逻辑（比较、移动、方向循环）在 table-sort-core.js —— 那里不依赖 React，
// 能被 Node 直接 import 做逐场景断言。本文件只放 React 接线。
//
// 设计取舍（都是踩过的坑，不是随手写的）：
//   * **自定义顺序与按列排序互斥**：一旦按列排，顺序由排序键决定，拖拽没有意义。
//     所以按列排序时禁用拖拽并给出提示，而不是让用户拖了没反应。
//   * **拖拽用 HTML5 draggable 而不是 pointer 事件**：表格行的拖拽排序是原生能力，
//     pointer 方案要自己算插入位置、还得处理滚动，代码多且易错。
//   * **拖拽后本地立即生效**：等服务端确认期间不回弹，否则拖完会闪一下旧顺序。
import { h, useCallback, useEffect, useRef, useState } from "./react.js";
import { moveItem, nextSortDir, sortRows } from "./table-sort-core.js";

// 重新导出，调用方只 import 这一个模块就够。
export { moveItem, nextSortDir, sortRows };

/**
 * 表格排序 + 拖拽排序的组合钩子。
 *
 * @param rows       当前展示的行（已按分组过滤）
 * @param getters    字段取值器表
 * @param onReorder  自定义顺序提交回调（收到整份 code 数组）；null = 不支持自定义排序
 * @param idOf       取行唯一标识
 *
 * 返回 { sorted, sortKey, sortDir, toggleSort, dragProps, canDrag, dragging, overIndex }：
 *   - sorted/toggleSort 给表头与 tbody 用；
 *   - dragProps(i) 给每一行铺开（draggable + 三个事件）；按列排序时返回 {}（自动禁用）。
 */
export function useTableSort(rows, getters, onReorder, idOf = (row) => row.code) {
	const [sortKey, setSortKey] = useState(null);
	const [sortDir, setSortDir] = useState(null);
	const [dragIndex, setDragIndex] = useState(null);
	const [overIndex, setOverIndex] = useState(null);
	// 本地顺序：拖拽后立即生效，等服务端确认期间不回弹（否则拖完会闪一下旧顺序）。
	const [localOrder, setLocalOrder] = useState(null);
	// 行的 code 集合变化（增删）时丢弃本地顺序，避免拿着过期顺序去排新数据。
	const idList = rows.map(idOf).join(",");
	const lastIdList = useRef(idList);
	useEffect(() => {
		if (lastIdList.current !== idList) {
			lastIdList.current = idList;
			setLocalOrder(null);
		}
	}, [idList]);

	const toggleSort = useCallback(
		(key) => {
			if (sortKey !== key) {
				// 换一列：从升序开始
				setSortKey(key);
				setSortDir("asc");
			} else {
				const nextDir = nextSortDir(sortDir);
				setSortDir(nextDir);
				// 取消排序 = 回到自定义/原始顺序
				if (nextDir === null) setSortKey(null);
			}
			// 一旦进入按列排序，自定义顺序不再生效（互斥），清掉本地顺序避免混淆。
			setLocalOrder(null);
		},
		[sortKey, sortDir]
	);

	// 自定义顺序：把本地顺序映射到当前行（不在顺序里的行（新加的）排在最后）。
	const baseRows = (() => {
		if (localOrder === null) return rows;
		const rank = new Map(localOrder.map((id, i) => [id, i]));
		return [...rows].sort((a, b) => {
			const ra = rank.has(idOf(a)) ? rank.get(idOf(a)) : Number.MAX_SAFE_INTEGER;
			const rb = rank.has(idOf(b)) ? rank.get(idOf(b)) : Number.MAX_SAFE_INTEGER;
			return ra - rb;
		});
	})();

	const sorted = sortRows(baseRows, sortKey, sortDir, getters);
	const canDrag = onReorder !== null && onReorder !== void 0 && sortKey === null;

	const dragProps = (index) => {
		if (!canDrag) return {};
		return {
			draggable: true,
			onDragStart: (e) => {
				setDragIndex(index);
				// 有些浏览器必须 setData 才会真正开始拖拽。
				try {
					e.dataTransfer.setData("text/plain", String(index));
					e.dataTransfer.effectAllowed = "move";
				} catch {}
			},
			onDragOver: (e) => {
				if (dragIndex === null) return;
				e.preventDefault(); // 允许放下（否则 drop 不触发）
				try {
					e.dataTransfer.dropEffect = "move";
				} catch {}
				if (overIndex !== index) setOverIndex(index);
			},
			onDragLeave: () => {
				if (overIndex === index) setOverIndex(null);
			},
			onDrop: (e) => {
				e.preventDefault();
				const from = dragIndex;
				setDragIndex(null);
				setOverIndex(null);
				if (from === null || from === index) return;
				const moved = moveItem(sorted, from, index);
				const ids = moved.map(idOf);
				setLocalOrder(ids); // 先本地生效
				onReorder(ids); // 再提交（失败时调用方负责提示，不回弹）
			},
			onDragEnd: () => {
				setDragIndex(null);
				setOverIndex(null);
			},
		};
	};

	return { sorted, sortKey, sortDir, toggleSort, dragProps, canDrag, dragging: dragIndex, overIndex };
}

/** 表头单元格：可点击排序，当前排序列显示升/降序箭头。
 *  `colKey` 是本列对应的排序字段；`sortKey`/`sortDir` 是表格当前排序状态。
 *  箭头未激活时显示浅色 ⇅ 占位，避免列宽因"箭头出现/消失"而跳动。 */
export function SortableTh({ label, colKey, sortKey, sortDir, onToggle, title }) {
	const active = sortKey === colKey;
	return h(
		"th",
		{
			className: "lkb-thSort" + (active ? " lkb-thSortActive" : ""),
			title: title ?? `点击按「${label}」排序`,
			"aria-sort": active ? (sortDir === "asc" ? "ascending" : "descending") : "none",
			onClick: () => onToggle(colKey),
			tabIndex: 0,
			onKeyDown: (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle(colKey);
				}
			},
		},
		h("span", { className: "lkb-thLabel" }, label),
		h("span", { className: "lkb-sortArrow", "aria-hidden": "true" }, active ? (sortDir === "asc" ? "▲" : "▼") : "⇅")
	);
}
