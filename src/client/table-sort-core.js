// 持仓看板 dsh-portfolio — 客户端 bundle 源码：排序纯逻辑（**不依赖 React**）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 为什么单独一个文件：这些是纯函数，能被 Node 直接 import 做逐场景断言
// （升/降/取消、缺值沉底、稳定性、移动越界）。放进 table-sort.js 会和 React
// 绑在一起，测试就得先搭一个假 React 环境——那是给测试添麻烦，不是给代码分层。

/** 表头点击循环：null（自定义/原始顺序）→ asc → desc → null。 */
export function nextSortDir(dir) {
	if (dir === null || dir === void 0) return "asc";
	if (dir === "asc") return "desc";
	return null;
}

/** 取出可比较的值：数字字段用数值比较，其余按本地化字符串比较。 */
function compareValues(a, b, numeric) {
	if (numeric) {
		const na = Number(a);
		const nb = Number(b);
		if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	}
	return String(a).localeCompare(String(b), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

/** 是否"缺数据"（null/undefined/NaN）。 */
function isMissing(v) {
	return v === null || v === void 0 || (typeof v === "number" && !Number.isFinite(v));
}

/**
 * 纯函数排序。`rows` 不被修改（返回新数组）。
 *
 * 缺数据处理是**独立于升降序**的一步：缺数据的行永远沉底。曾经把"缺值沉底"
 * 写成比较函数里返回 ±1、再整体乘 dir 的符号——降序时缺值就被翻到了最上面。
 * 所以这里把空值判定放在乘符号之前单独处理。
 *
 * @param rows    原始行数组
 * @param key     排序字段名（null = 不排序，原样返回同一引用）
 * @param dir     "asc" | "desc" | null
 * @param getters { [key]: (row) => value } 字段取值器
 */
export function sortRows(rows, key, dir, getters) {
	if (key === null || key === void 0 || dir === null || dir === void 0) return rows;
	const get = getters?.[key];
	if (typeof get !== "function") return rows;
	const sign = dir === "desc" ? -1 : 1;
	// 稳定排序：值相等时保持原相对顺序（自定义顺序因此不会被"相等项"打乱）。
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const va = get(a.row);
			const vb = get(b.row);
			const ma = isMissing(va);
			const mb = isMissing(vb);
			// 空值沉底：不受 dir 影响（"没有数据"不是"最小值"）。
			if (ma || mb) {
				if (ma && mb) return a.index - b.index;
				return ma ? 1 : -1;
			}
			const numeric = typeof va === "number" || typeof vb === "number";
			const c = compareValues(va, vb, numeric);
			return c !== 0 ? c * sign : a.index - b.index;
		})
		.map((x) => x.row);
}

/** 把数组里 from 位置的元素移到 to 位置（返回新数组，不修改原数组）。 */
export function moveItem(list, from, to) {
	if (from === to) return list;
	if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}

/**
 * 把「保存自定义顺序的结果」翻译成「要不要回退本地顺序」。
 *
 * 为什么需要：拖拽后本地顺序立刻生效（否则会闪一下旧顺序），但**保存可能失败**。
 * v0.26.0 就踩过这个坑：宿主里跑的还是旧服务端代码（reorder 路由没注册，POST 回
 * 401），本地顺序却照样生效——界面显示新顺序、服务端一无所知，重新进入页面就变回
 * 旧顺序，用户只会觉得「拖了白拖」。界面不能显示一个没保存成功的顺序，所以失败
 * 必须回退，并让调用方提示原因。
 *
 * @param outcome      onReorder 的返回值（Promise 才能感知成败）
 * @param onRollback   回退动作（失败时调用）
 * @returns Promise<boolean>（true = 已回退），或 null（无需等待）
 */
export function settleOrderCommit(outcome, onRollback) {
	if (outcome === null || outcome === void 0 || typeof outcome.then !== "function") return null;
	return Promise.resolve(outcome).then(
		() => false,
		() => {
			onRollback();
			return true;
		}
	);
}

/**
 * 把「子集的新顺序」合并回完整列表。
 *
 * 为什么需要：拖拽发生在**当前分组**里（比如只看「短线」分组），拿到的是子集；
 * 而服务端要求提交完整集合（否则会 409）。直接提交子集会保存失败，所以要把
 * 子集按新顺序填回它在完整列表里原来占据的那些位置——分组内的相对顺序被换掉，
 * 分组外的项原位不动。这样在任何分组里拖拽都能保存，且不会打乱别的分组。
 *
 * @param fullItems    完整列表（原顺序）
 * @param subsetOrder  子集的新顺序（id 数组）
 * @param idOf         取 id
 */
export function mergeSubsetOrder(fullItems, subsetOrder, idOf = (x) => x.code) {
	const subset = new Set(subsetOrder);
	let cursor = 0;
	return fullItems.map((item) => (subset.has(idOf(item)) ? subsetOrder[cursor++] : idOf(item)));
}
