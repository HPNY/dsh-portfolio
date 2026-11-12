// 持仓看板 dsh-portfolio — 客户端 bundle 源码：侧边栏入口
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。

/**
 * 面板导航列表（nav）定位。
 *
 * DSH 侧边栏（@deepseek-ai/dsh-client-ui-sidebar）的布局：品牌行与新会话按钮固定，
 * 其下的滚动视口承载**面板导航 nav** 与工作区区块——菜单整体滚动时导航先随视口
 * 滚走。展开态视口带稳定标记 `data-sidebar-scrollport`（ui-sidebar README 明言
 * "供测试和集成方定位"），nav 是它里面的 `nav[class*="panelList"]`。
 *
 * 入口必须挂进这个 nav。旧实现插在 sidebar root 下、nav **外面**（固定区），
 * 于是菜单整体滚动时它不动、视觉上也脱离菜单组——「不随整体滚动、单独显示」。
 */
function panelNav() {
	const port = document.querySelector("[data-sidebar-scrollport]");
	if (port !== null) {
		const inPort = port.querySelector('nav[class*="panelList"]') ?? port.querySelector("nav");
		if (inPort !== null) return inPort;
	}
	const nav = document.querySelector('nav[class*="panelList"]');
	return nav === null ? void 0 : nav;
}
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
 * 复刻一条原生面板行作为入口行，找不到可复刻的行时返回 undefined。
 *
 * 原生行的 DOM（SidebarRoot.tsx 的 PanelRow）是
 *   `button.panelRow > span.panelGlyph(>svg) + span.panelTitle`
 * 但类名是 css-modules 哈希（`.wtg9ga_panelRow` 这种），外部写死不了；行高、padding、
 * gap、圆角、悬停底色、折叠态几何也全由那套类决定，而且**会随 DSH 版本变**
 * （36px 行高就改成了 32px，见 styles.js 里旧值的下场）。所以这里直接 cloneNode
 * 借用**当前运行版本**的行 DOM：几何/悬停/折叠态天然与原生一致，只把图标换成
 * 品牌 SVG、文字换成入口文案，再接上自己的点击。复刻体是惰性 DOM，不带 React
 * 事件（宿主的事件委托在 root 上），被重渲染抹掉时由 mountSidebarEntry 补回。
 */
function cloneNativeEntry(options) {
	const nav = panelNav();
	const scope = nav ?? document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]') ?? document.body;
	const model =
		scope.querySelector('[class*="panelEntry"] button[class*="panelRow"]') ??
		Array.from(scope.querySelectorAll("button[class*=\"panelRow\"]")).find(
			(button) => !button.hasAttribute(options.rowAttribute) && !button.hasAttribute("aria-haspopup")
		);
	if (model === void 0 || model === null) return void 0;
	const entry = model.cloneNode(true);
	// 菜单语义不带过来：「更多」行的 aria-haspopup/aria-expanded、选中行的
	// aria-current、Tooltip 的 aria-describedby（克隆体里没有它指向的提示元素）。
	for (const attr of ["aria-haspopup", "aria-expanded", "aria-current", "aria-describedby"]) entry.removeAttribute(attr);
	// 图标：svg 的父槽位整段换成品牌 SVG（单一真源 src/client/icon.js）
	const icon = entry.querySelector("svg");
	const slot = icon === null ? null : icon.parentElement;
	if (slot === null) return void 0;
	slot.innerHTML = options.icon;
	const ownIconClass = options.css["entryIcon"] ?? "";
	if (ownIconClass !== "") slot.classList.add(ownIconClass);
	lockIconGeometry(entry, ownIconClass);
	// 文字：第一个非空文字节点（原生结构里就是 panelTitle）
	let labelNode = null;
	for (const node of Array.from(entry.querySelectorAll("span, div"))) {
		if ((node.textContent ?? "").trim() === "") continue;
		labelNode = node;
		break;
	}
	if (labelNode === null) return void 0;
	labelNode.textContent = options.label();
	const ownLabelClass = options.css["entryLabel"] ?? "";
	if (ownLabelClass !== "") labelNode.classList.add(ownLabelClass);
	// 自己的标记与交互
	entry.setAttribute(options.rowAttribute, "");
	if (options.plugin !== void 0) {
		entry.setAttribute("data-dsh-plugin", options.plugin);
		entry.setAttribute("data-dsh-part", "sidebar-entry");
	}
	entry.setAttribute("aria-label", options.label());
	if (options.tooltip !== void 0) entry.setAttribute("title", options.tooltip());
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

/**
 * 挂载入口。优先挂进面板导航列表（nav）作**第一行**——与「插件」等原生行同组、
 * 随菜单整体滚动，顺序上保持「持仓看板」在菜单组顶部的既有布局（它原本就在
 * 「插件」上面）。找不到 nav（旧版 GUI / 渲染时序）时降级回旧行为：插在
 * sidebar root 的新会话按钮之后、并借用原生 class 对齐。
 */
function placeEntry(host, entry, options, inNav) {
	if (inNav) {
		if (entry.parentElement !== host || host.firstElementChild !== entry) {
			host.insertBefore(entry, host.firstElementChild);
		}
		return true;
	}
	const button = newSessionButton(host);
	if (button === void 0) return false;
	if (entry.parentElement !== host) {
		const row = button.closest('[class*="logoRow"]');
		const base = row !== null && row.parentElement === host ? row : button;
		const family = Array.from(host.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
		const anchor =
			options.position === "before"
				? family.length > 0
					? family[0]
					: base.nextElementSibling
				: family.length > 0
					? family[family.length - 1].nextElementSibling
					: base.nextElementSibling;
		host.insertBefore(entry, anchor);
	}
	adoptNativeClasses(host, entry, options);
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
 *
 * 注意：这是**降级路径**的对齐手段（见 placeEntry）。首选路径 cloneNativeEntry
 * 直接复刻整条原生行，不存在"借两个 class 对不齐"的问题。
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
	let entry;
	let host;
	let inNav = false;
	const ensurePlaced = () => {
		// 已挂在正确的宿主上就不动：省掉每次 DOM 变更的重排写入（侧边栏的
		// 会话列表随时在变，这里必须便宜）。
		if (
			entry !== void 0 &&
			entry.isConnected &&
			host !== void 0 &&
			host.isConnected &&
			entry.parentElement === host &&
			(!inNav || host.firstElementChild === entry)
		) {
			return;
		}
		const nav = panelNav();
		const nextHost = nav ?? sidebarRoot();
		if (nextHost === void 0) return;
		host = nextHost;
		inNav = nav !== void 0;
		if (entry === void 0 || !entry.isConnected) {
			// 挂载/重挂时优先复刻原生行；复刻不出来先自建顶上（可能只是原生行
			// 还没渲染的时序问题），下一轮变更回调会再试并换上复刻体。
			entry = cloneNativeEntry(options) ?? entry ?? createEntry(options);
		}
		placeEntry(host, entry, options, inNav);
	};
	const observer = new MutationObserver(() => {
		ensurePlaced();
	});
	// 观察整个 body：侧边栏会整块重挂（布局切换、GUI 升级），挂在 root 上会漏掉。
	ensurePlaced();
	observer.observe(document.body, { childList: true, subtree: true });
	return () => {
		observer.disconnect();
		entry?.remove();
	};
}
