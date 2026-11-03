// 持仓看板 dsh-portfolio — 客户端 bundle 源码：侧边栏入口
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。

function sidebarRoot() {
	const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
	if (column === null) return void 0;
	return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
}
function newSessionButton(root) {
	const nested = root.querySelector("button[class*=\"newSession\"]");
	if (nested !== null) return nested;
	for (const child of root.children) if (child.tagName === "BUTTON") return child;
}
function createEntry(options) {
	const entry = document.createElement("button");
	entry.type = "button";
	entry.setAttribute(options.rowAttribute, "");
	if (options.plugin !== void 0) {
		entry.setAttribute("data-dsh-plugin", options.plugin);
		entry.setAttribute("data-dsh-part", "sidebar-entry");
	}
	entry.className = options.css["entry"] ?? "";
	entry.setAttribute("aria-label", options.label());
	if (options.tooltip !== void 0) entry.setAttribute("title", options.tooltip());
	entry.innerHTML = "<span class=\"" + (options.css["entryIcon"] ?? "") + "\">" + options.icon + "</span><span class=\"" + (options.css["entryLabel"] ?? "") + "\">" + options.label() + "</span>";
	lockIconGeometry(entry, options.css["entryIcon"] ?? "");
	entry.addEventListener("click", options.onToggle);
	return entry;
}

/**
 * 把图标槽位与其中 SVG 的尺寸写死在行内 style 上。
 *
 * 尺寸依据：DSH 自己的侧边栏 CSS（app.asar 里的 `.wtg9ga_panelGlyph`）**不给图标槽位定
 * 宽高**，只做 flex 居中；原生图标的实际渲染尺寸是 **16x16**（24 viewBox 在 16px 下渲染，
 * 墨迹约 13.3px）。之前这里按 24x24 画，等于比原生大 1.5 倍，整行自然显得格格不入。
 *
 * 行内 style 优先级高于类选择器，所以即使槽位上借来了原生 class（见 adoptNativeClasses），
 * 尺寸也只由这里决定。
 */
function lockIconGeometry(entry, ownIconClass) {
	if (typeof entry.querySelector !== "function") return;
	const slot = ownIconClass === "" ? entry.firstElementChild : entry.querySelector("[class~=\"" + ownIconClass + "\"]");
	if (slot === null || slot === void 0 || slot.style === void 0) return;
	slot.style.flex = "none";
	slot.style.display = "inline-flex";
	slot.style.alignItems = "center";
	slot.style.justifyContent = "center";
	slot.style.lineHeight = "0";
	if (typeof slot.querySelector !== "function") return;
	const svg = slot.querySelector("svg");
	if (svg === null || svg === void 0 || svg.style === void 0) return;
	svg.style.width = "16px";
	svg.style.height = "16px";
	svg.style.display = "block";
}
function placeEntry(root, entry, options) {
	const button = newSessionButton(root);
	if (button === void 0) return false;
	if (entry.parentElement !== root) {
		const row = button.closest('[class*="logoRow"]');
		const base = row !== null && row.parentElement === root ? row : button;
		const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
		const anchor =
			options.position === "before"
				? family.length > 0
					? family[0]
					: base.nextElementSibling
				: family.length > 0
					? family[family.length - 1].nextElementSibling
					: base.nextElementSibling;
		root.insertBefore(entry, anchor);
	}
	adoptNativeClasses(root, entry, options);
	return true;
}

/**
 * 让入口的**图标槽位**和**文字节点**都带上与 DSH 原生菜单项同一个 class。
 *
 * 为什么必须借用原生 class 而不是自己写尺寸/间距：这两处的视觉参数（槽位宽高、
 * 槽位到文字的 gap、文字的 padding / 字号 / 行高）都由原生那层 class 决定。硬编码
 * 像素值只能对着某一版 GUI 对齐一次，DSH 一换样式就再次错位；直接借用，起点必然一致
 * （「时钟」「四角星」那些入口就是 familySelectors 命中的）。
 *
 * 尺寸仍由我们自己的 CSS 与 lockIconGeometry 的**行内 style** 兜底（16x16），所以即使
 * 借来的 class 自带别的宽高，也不会把图标撑歪。
 *
 * 找不到原生项就保持自己的 class —— 功能不受影响，只是退化成"可能差几个像素"。
 */
function adoptNativeClasses(root, entry, options) {
	const ownIconClass = options.css["entryIcon"] ?? "";
	const ownLabelClass = options.css["entryLabel"] ?? "";
	if (ownIconClass === "" && ownLabelClass === "") return;
	const iconSlot = ownIconClass === "" ? null : entry.querySelector("[class~=\"" + ownIconClass + "\"]");
	const label = ownLabelClass === "" ? null : entry.querySelector("[class~=\"" + ownLabelClass + "\"]");
	if (iconSlot === null && label === null) return;
	const families = options.familySelectors.join(", ");
	for (const sibling of Array.from(root.children)) {
		if (sibling === entry || !(sibling instanceof HTMLElement) || !sibling.matches(families)) continue;
		// 图标槽位：原生项里 <svg> 的父元素就是它的图标容器。
		if (iconSlot !== null) {
			const nativeIcon = sibling.querySelector("svg");
			const nativeSlot = nativeIcon === null ? null : nativeIcon.parentElement;
			if (nativeSlot !== null && typeof nativeSlot.className === "string" && nativeSlot.className !== "") {
				iconSlot.className = nativeSlot.className + " " + ownIconClass;
			}
		}
		// 文字节点：第一个有文字的原生 span/div。
		if (label !== null) {
			for (const node of Array.from(sibling.querySelectorAll("span, div"))) {
				if ((node.textContent ?? "").trim() === "") continue;
				if (typeof node.className !== "string" || node.className === "") continue;
				// 原生 class 放在前面，让它的间距规则生效；自己的 class 追加在后面只提供
				// ellipsis 截断，不引入任何 margin/padding，因此不影响对齐。
				label.className = node.className + " " + ownLabelClass;
				break;
			}
		}
		return;
	}
}
export function mountSidebarEntry(options) {
	if (typeof document !== "undefined" && document.querySelector(options.rowSelector) !== null) return () => {};
	const entry = createEntry(options);
	let root;
	let placed = false;
	const tryPlace = () => {
		if (root !== void 0 && !root.isConnected) {
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		if (placed) {
			if (document.body.contains(entry)) return;
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		root ??= sidebarRoot();
		if (root === void 0) return;
		placed = placeEntry(root, entry, options);
		if (placed) rootObserver.observe(root, { childList: true, subtree: true });
	};
	const waitObserver = new MutationObserver(() => {
		tryPlace();
	});
	waitObserver.observe(document.body, { childList: true, subtree: true });
	const rootObserver = new MutationObserver(() => {
		if (root === void 0 || !root.isConnected) {
			placed = false;
			tryPlace();
			return;
		}
		if (!root.contains(entry)) placed = placeEntry(root, entry, options);
	});
	tryPlace();
	return () => {
		waitObserver.disconnect();
		rootObserver.disconnect();
		entry.remove();
	};
}
