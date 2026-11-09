// 构建产物冒烟测试（无网络、无真 React/DOM）。
//
// lib/client.js 是 build.mjs 从 src/client/* 打出来的 DSH 客户端插件 bundle。
// 这个测试卡住它的**对外契约**，防止构建链改动悄悄把产物打坏：
//   1. 文件以 window.__ModuleLoader__.load() 包装，id 是 "dsh-portfolio"；
//   2. react / react-dom/client 保持 external——产物里只允许各出现一次
//      require("...")（宿主自带 React，打进产物就是双 React 事故）；
//   3. factory(require) 用桩 React 跑完模块顶层代码（顶层不碰 DOM，
//      样式注入有 document 守卫），返回 { apply, inject }。
import { readFileSync, readdirSync } from "node:fs";

const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");

let fail = 0;
const check = (name, ok, note = "") => {
	if (!ok) fail++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note === "" ? "" : `  — ${note}`}`);
};

// 1) 包装形态
check("生成声明头（GENERATED FILE）", src.includes("GENERATED FILE"));
check("ModuleLoader 包装", src.includes("window.__ModuleLoader__.load({"));
check("插件 id", src.includes('id: "dsh-portfolio"'));
// 样式表整体写在模板字符串里。注释里一旦混进反引号，字符串会提前截断，产出
// "语法合法、运行时才炸" 的 bundle（`node --check` 也查不出来：剩下的部分会被当成
// 带标签的模板调用）。这条在真正执行 factory 之前就先检查 CSS 是否完整。
check(
	"样式表未被反引号截断（CSS 完整）",
	/\.lkb_entry\{box-sizing:border-box;border-radius:var\(--dsw-radius-md\)/.test(src) &&
		/\.lkb_entryIcon svg\{display:block;width:16px;height:16px\}/.test(src)
);

// 2) React 不进 bundle
const reactRequires = src.match(/require\("react"\)/g) ?? [];
const domRequires = src.match(/require\("react-dom\/client"\)/g) ?? [];
check('require("react") 恰好 1 处（external）', reactRequires.length === 1, `实测 ${reactRequires.length}`);
check('require("react-dom/client") 恰好 1 处（external）', domRequires.length === 1, `实测 ${domRequires.length}`);
check(
	"产物未内联 React 源码",
	!src.includes("react.production.min") && !src.includes("react.development") && !src.includes("object-assign")
);

// 3) 桩上跑 factory
let registered = null;
globalThis.window = {
	__ModuleLoader__: {
		load: (def) => {
			registered = def;
		},
	},
};
const reactStub = {
	createElement: () => ({}),
	useState: (v) => [v, () => {}],
	useEffect: () => {},
	useRef: (v) => ({ current: v }),
	useCallback: (fn) => fn,
};
const requireStub = (name) => {
	if (name === "react") return reactStub;
	if (name === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
	throw new Error(`意外的 require: ${name}（只允许 react / react-dom/client）`);
};

new Function(src)();
check("执行后调用了 ModuleLoader.load", registered !== null);
check("registered.id === dsh-portfolio", registered?.id === "dsh-portfolio");
check("registered.factory 是函数", typeof registered?.factory === "function");

const exp = registered.factory(requireStub);
check("导出 apply(ctx)", typeof exp?.apply === "function");
check("导出 inject 数组", Array.isArray(exp?.inject));
check("inject 为空（样式走 styles.js 自注入）", exp.inject.length === 0);

// 3b) 侧边栏图标契约
//
// 图标必须是**内联单色线框 SVG**，因为它靠 `currentColor` 继承按钮文字色：
// 用 emoji 就固定是彩色字形，用 <img src> 则 SVG 是隔离文档、继承不到颜色（渲染成黑）。
// 这三条断言就是防止有人日后把图标改回 emoji 或换成外部图片。
check("图标是内联 SVG（非 emoji、非外部图片）", src.includes("<svg xmlns=") && !src.includes("<img "));
check(
	"图标为纯线框：stroke=currentColor + width=2 + 圆头端点/连接",
	src.includes('stroke="currentColor"') &&
		src.includes('stroke-width="2"') &&
		src.includes('stroke-linecap="round"') &&
		src.includes('stroke-linejoin="round"') &&
		src.includes('fill="none"')
);
check("图标不写死颜色（无 #000/#ccc 之类填充）", !/fill="#[0-9a-fA-F]{3,6}"/.test(src) && !/stroke="#[0-9a-fA-F]{3,6}"/.test(src));
check(
	"图标是 16x16（与原生 .wtg9ga_panelGlyph 里 16px 的图标同尺寸）",
	src.includes(".lkb_entryIcon svg{display:block;width:16px;height:16px}") && src.includes('svg.style.width = "16px"')
);
// 文字节点与图标槽位都要借用原生菜单项的 class，才能和「时钟」「四角星」对齐
check("挂载后借用原生菜单项 class（图标槽位 + 文字节点）", src.includes("function adoptNativeClasses(") && src.includes("nativeIcon.parentElement"));
// 行内 style 优先级高于类选择器，槽位尺寸不会被借来的 class 改掉
check(
	"图标几何写进行内 style",
	src.includes("function lockIconGeometry(") && src.includes('slot.style.flex = "none"') && src.includes('svg.style.height = "16px"')
);
// 行样式数值全部来自 app.asar 里 DSH 自己的 .wtg9ga_panelRow，不是估的
check(
	"行样式与原生 .wtg9ga_panelRow 一致（min-height36 / padding 7px 8px / gap 8px / margin 0 2px / line-height22）",
	src.includes("min-height:36px") &&
		src.includes("padding:7px 8px") &&
		src.includes("gap:8px") &&
		src.includes("margin:0 2px") &&
		src.includes("line-height:22px") &&
		src.includes("color:var(--dsw-alias-label-primary)") &&
		src.includes("font:inherit")
);
// 入口插在 nav.wtg9ga_panelList 外面，拿不到那个 nav 的 gap:2px，靠 margin-bottom 补齐，
// 否则和相邻原生行的行距会少 2px。
check("行距补齐原生 panelList 的 gap:2px", src.includes("margin:0 2px 2px"));
// 基金页根节点如果不带类名、CSS 也不给基准字号，未显式设字号的文字（基金名等）
// 会继承浏览器默认 16px，而面板其它页是 12.5px —— 表现为"整页字体比别的页大一圈"。
check(
	"基金页有基准字号且与面板表格一致（12.5px）",
	src.includes('className: "lkb_fundPage"') && src.includes(".lkb_fundPage{font-size:12.5px}")
);
check("基金页 NAV 字号不超过面板常态量级（13px）", src.includes(".lkb_fundNavVal{font-size:13px"));
// 基金列表用**真正的 <table>**：表头/行/分隔线/悬停全部由 .lkb_card 的表格规则提供，
// 与自选页、行情页在结构上就是同一种东西。用 grid 模拟容易出现各行列宽独立计算、错位。
check(
	"基金列表用真正的表格（table + thead + tbody）",
	src.includes('"table"') && src.includes('"thead"') && src.includes('"tbody"')
);
// 点基金行 → 打开基金详情浮窗（与自选点行开详情窗同一套交互）；旧的行内编辑页已删除。
check(
	"点基金行打开详情浮窗（旧编辑页已删除）",
	src.includes("function FundDetailWindow(") &&
		src.includes("onClick: () => onOpen(fund)") &&
		!src.includes("FundEditForm") &&
		!src.includes("colSpan: 7")
);
check(
	"基金详情浮窗走 Host 的 history 接口（阶段涨幅由 Host 算）",
	src.includes("otcFundHistory") && src.includes("stageReturns")
);
// 行情页搜索要能查场外基金；详情浮窗的「加入基金」是唯一入口，旧的「＋ 添加基金」表单已删。
//
// 断言必须锁 **API 表里登记的那一条**，不能只查字符串"otcFundSearch"是否存在：
// `api(API.otcFundSearch ...)` 里的属性名是同一个字符串，光查存在会把"表里没登记"
// 这个 bug 放过去 —— 实测后果是请求打到 /undefined?q=… 404，搜索框永远"无匹配结果"。
check(
	"行情页搜索合并场外基金结果（点基金条开基金详情窗）",
	src.includes('otcFundSearch: "/api/leekbox/otc-fund/search"') && src.includes("s.fund === true ? onOpenFund : onOpen")
);
// README 必须给出可直接复制的标准安装命令 `dsh plugin --profile web add <spec>`。
// 早期这里只有 mklink / pnpm add file: 的写法，市场爬虫扫不到标准命令会判定不通过。
{
	const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	check(
		"README 含标准安装命令 dsh plugin --profile web add（市场可扫描）",
		/dsh plugin --profile web add github:HPNY\/dsh-portfolio/.test(readme)
	);
}
// 分时图必须在交易时段自动推进，否则它是"打开那一刻的快照"——头部价格在跳、
// 曲线冻住，看起来像没有实时走势图。这条断言锁住那条 useTradingInterval。
{
	const detailSrc = readFileSync(new URL("./src/client/detail.js", import.meta.url), "utf8");
	check(
		"分时图在交易时段自动刷新（不是只取一次的静态快照）",
		/if \(period !== "today"\) return;/.test(detailSrc) && /API\.minute/.test(detailSrc) && /useTradingInterval/.test(detailSrc)
	);
	// 分时必须是**默认视图**且排在周期行首位（与雪球/同花顺一致）。此前默认日K、
	// 分时藏在第 4 个按钮里，用户以为根本没做分时图。
	// 顺序与雪球的周期行一致：分时/五日/日K/周K/月K/季K/年K/120分/60分/30分/15分/5分/1分。
	check(
		"分时是默认视图且周期行顺序与雪球一致",
		/useState\("today"\)/.test(detailSrc) &&
			/\["today", "m5day", "day", "week", "month", "quarter", "year", "m120", "m60", "m30", "m15", "m5", "m1"\]/.test(detailSrc)
	);
}
// 详情窗内容超长时必须**可滚动**，不能被 .lkb-win 的 overflow:hidden 裁掉。
// 关键是 flex 子项要 min-height:0 —— 默认 min-height:auto 会撑满父级高度，
// 于是滚动条根本不出现，底部内容（财务摘要、重仓股列表）被圆角边切掉。
{
	const stylesSrc = readFileSync(new URL("./src/client/styles.js", import.meta.url), "utf8");
	check(
		"详情窗 body 可滚动（flex:1 + min-height:0，不会被裁掉）",
		/\.lkb_body\{[^}]*min-height:0/.test(stylesSrc) && /\.lkb-fundBody\{[^}]*min-height:0/.test(stylesSrc)
	);
	// 浮窗高度要封顶，否则 88vh 的窗口在小屏上会压出可视区
	check("浮窗高度封顶（max-height 上限）", /max-height:min\(88vh,\d+px\)/.test(stylesSrc));
}
// 详情窗开屏要居中并在挂载后按实际尺寸夹回视口内，否则每次都得手动拖。
{
	const fundSrc = readFileSync(new URL("./src/client/fund-detail.js", import.meta.url), "utf8");
	const panelSrc = readFileSync(new URL("./src/client/panel.js", import.meta.url), "utf8");
	check(
		"详情窗开屏居中且夹回视口（不再错开溢出屏幕）",
		/getBoundingClientRect/.test(readFileSync(new URL("./src/client/detail.js", import.meta.url), "utf8")) &&
			/getBoundingClientRect/.test(fundSrc) &&
			!/k \* 28/.test(panelSrc)
	);
}
// 系统性守卫：src/client 里用到的每一个 API.<key> 都必须在 core.js 的 API 表里登记。
// 「表里没登记」的表现是 `API.xxx` 变 undefined、请求打到 /undefined?... 404，
// 界面只会安静地显示"无匹配结果"，很难定位 —— 上面那个 bug 就属于这一类。
{
	const apiSrc = readFileSync(new URL("./src/client/core.js", import.meta.url), "utf8");
	const mapBody = /export const API = \{([\s\S]*?)\n\};/.exec(apiSrc)?.[1] ?? "";
	const declared = new Set([...mapBody.matchAll(/^\t([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
	const used = new Set();
	const dir = new URL("./src/client/", import.meta.url);
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".js")) continue;
		const body = readFileSync(new URL(f, dir), "utf8");
		for (const m of body.matchAll(/\bAPI\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
	}
	const missing = [...used].filter((k) => !declared.has(k)).sort();
	check("src/client 用到的 API.<key> 都在 core.js 的 API 表里登记", missing.length === 0, `未登记: ${missing.join(", ") || "无"}`);
}
check(
	"详情浮窗有「加入基金 / 移出基金」按钮，且「＋ 添加基金」入口已删除",
	src.includes("加入基金") &&
		src.includes("移出基金") &&
		!src.includes("AddFundForm") &&
		!src.includes("＋ 添加基金")
);
// 基金详情浮窗必须与股票详情窗用同一套卡片语言（.lkb-chartBox + .lkb-chartTitle + .lkb-detailQuote），
// 不允许再出现自定义的 hero 排版——那是"看着不像同一个产品"的来源。
{
	const fundSrc = readFileSync(new URL("./src/client/fund-detail.js", import.meta.url), "utf8");
	check(
		"基金详情与股票详情同款卡片语言（chartBox / chartTitle / detailQuote）",
		fundSrc.includes('className: "lkb-chartBox"') &&
			fundSrc.includes('className: "lkb-chartTitle"') &&
			fundSrc.includes('className: "lkb-detailQuote"') &&
			!fundSrc.includes("lkb-fundHero")
	);
}
// 成本与份额必须是两列，不能挤在一个单元格里
check("成本、份额是两个独立表头", src.includes('}, "成本"),') && src.includes('}, "份额"),'));
// 两列的修改方式与自选页一致：点单元格 -> .lkb-input，复用 .lkb-posCell 观感
check(
	"成本/份额可内联编辑（复用自选页 .lkb-posCell 交互）",
	src.includes("function EditableCell(") && src.includes("lkb-posCell") && src.includes("const saveField")
);
// 旧的卡片/grid 方案必须彻底清掉，否则两套样式并存会打架
check("旧的卡片/grid 模拟样式已移除", !src.includes(".lkb_fundRow{") && !src.includes(".lkb_fundHead{") && !src.includes(".lkb_fundMain{"));
// 数值精度：浮盈一律两位小数。fmtAmount 对 <1万的数会取整（-3742.67 显示成 -3743），
// 所以必须用 fmtSign，且不能再出现 fmtAmount(rowPnl)。
check("基金浮盈两位小数（用 fmtSign，不用 fmtAmount）", src.includes("fmtSign(rowPnl)") && !src.includes("fmtAmount(rowPnl)"));
check("基金净值四位小数", src.includes("fmt(nav, 4)") && src.includes("fmt(fund.costNav, 4)"));
// 基金页的顶部汇总条与自选页同构：市值 / 成本 / 浮动盈亏 / 收益率（指标由 Host 算好）。
// 用变量名区分两页，避免只断言到自选那份就误过。
check(
	"基金汇总条与自选页同构（市值 / 成本 / 浮动盈亏 / 收益率）",
	src.includes('"市值 ", h("b", null, fmtAmount(marketValue))') &&
		src.includes('"成本 ", h("b", null, fmtAmount(totalCost))') &&
		src.includes('"浮动盈亏 ", h("b", { className: trend(fundPnl)') &&
		src.includes('"收益率 ", h("b", { className: trend(returnPct)')
);
// 自选表格的「昨收」列：表头 + 数据单元格都要在，且取的是行情的 prevClose 字段。
// 注意详情弹窗里也有"昨收"，但那走的是 item(...) 助手，用 td 写法区分。
check("自选表格有「昨收」列（行情字段 prevClose）", src.includes('}, "昨收"),') && src.includes('h("td", null, fmt(q?.prevClose))'));
// 列调整：表头「盈亏百分比」简化为「盈亏」；「解套需涨」「解套进度」两列都已删除。
// 注意 tooltip 里仍会描述"盈亏百分比"这个含义，所以只断言表头写法，不否证整个词。
check("表头为「盈亏」（且不再有解套需涨 / 解套进度两列）", src.includes('}, "盈亏"),') && !src.includes("解套需涨") && !src.includes("解套进度"));
check("解套进度条相关代码已移除", !src.includes("lkb_fundProgress") && !src.includes("fillPct"));
// 面板内部图标：这两处都是"静默失效"型 bug —— 样式不生效、图标渲染成空 SVG，
// 界面上只是看着不对，控制台一声不响，所以必须靠断言兜住。
check("头部标题类名与 CSS 一致（lkb_headTitle，不是 lkb-headTitle）", src.includes("lkb_headTitle") && !src.includes("lkb-headTitle"));
{
	const panelSrc = readFileSync(new URL("./src/client/panel.js", import.meta.url), "utf8");
	const tabKeys = [...(panelSrc.match(/const TABS = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
	const iconKeys = [...(panelSrc.match(/const TAB_ICONS = \{([\s\S]*?)\n\};/)?.[1] ?? "").matchAll(/^\t([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
	check(
		"每个 Tab 的 key 都有对应图标（TAB_ICONS 键名与 TABS 对齐）",
		tabKeys.length > 0 && tabKeys.every((k) => iconKeys.includes(k)),
		`TABS=${tabKeys.join(",")} | TAB_ICONS=${iconKeys.join(",")}`
	);
}

// 4) apply() 在最小 DOM 桩上必须能挂起来
//
// 预警看护与交易日历时钟都挪到了 entry.js（随插件而不是随面板存活），所以
// apply() 现在会真的碰 document —— 用桩跑一遍，确认 mount 链路不抛。
{
	const stubEl = () => ({
		dataset: {},
		style: {},
		setAttribute() {},
		removeAttribute() {},
		appendChild() {},
		remove() {},
		addEventListener() {},
		removeEventListener() {},
	});
	globalThis.document = {
		visibilityState: "visible",
		body: stubEl(),
		head: stubEl(),
		createElement: () => stubEl(),
		addEventListener() {},
		removeEventListener() {},
		querySelector: () => null,
	};
	let applyError = null;
	const ctx = { effect: () => {} };
	const origFetch = globalThis.fetch;
	const origObserver = globalThis.MutationObserver;
	// 侧边栏入口用 MutationObserver 盯宿主 DOM；桩一个空实现，免得 mount 抛错。
	globalThis.MutationObserver = class {
		observe() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	};
	// 日历拉取是后台异步的；这里给一个永不 resolve 的 fetch，避免测试退出前
	// 冒出未处理的 reject（真实环境走浏览器 fetch）。
	globalThis.fetch = () => new Promise(() => {});
	try {
		exp.apply(ctx);
	} catch (error) {
		applyError = error;
	} finally {
		globalThis.fetch = origFetch;
		globalThis.MutationObserver = origObserver;
	}
	check("apply() 在最小 DOM 桩上不抛", applyError === null, applyError === null ? "" : String(applyError));
}

// 5) 常驻件不能被塞回面板里
//
// 价格预警看护（AlertWatcher）与交易日历时钟必须随**插件**存活：面板关闭走
// root.unmount()，挂在面板里的看护会一起卸载 —— README 承诺的"交易时段自动
// 盯盘"就会静默失效。这两条断言把"它们由 entry.js 挂载"钉死，防止以后被
// 重构回 panel.js。panel.js 自己**不该**再渲染 AlertWatcher。
{
	const applyBody = src.slice(src.indexOf("function apply(ctx)"));
	const applyFn = applyBody.slice(0, applyBody.indexOf("\n}") + 2);
	check("apply 里挂载了预警看护", /\bmountAlertWatcher\s*\(/.test(applyFn), applyFn.split("\n").filter((l) => /mount|dispose/.test(l)).join(" | "));
	check("apply 里启动了交易日历时钟", /\bstartSessionClock\s*\(/.test(applyFn));
	check("apply 里把预警宿主挂进了 disposers", /alertWatcher\.dispose\s*\(/.test(applyFn));
	check("面板不再自己渲染 AlertWatcher", !/function PortfolioPanel[\s\S]*?h\(AlertWatcher\b/.test(src), (src.match(/h\(AlertWatcher\b/g) ?? []).length + " 处渲染（应仅常驻宿主 1 处）");
	check("AlertWatcher 只在常驻宿主里渲染一次", (src.match(/h\(AlertWatcher\b/g) ?? []).length === 1);
	// 预警宿主自带 toast 栈：面板没开时也得弹得出来
	check("产物的 toast 走订阅式广播（core 的 pushToast/onToast）", src.includes("toastListeners") && src.includes("function pushToast("));
	check("写接口调用带 application/json（服务端写锁要求）", src.includes('"content-type": "application/json"'));
	// 轮询门控：页面不可见 / 非交易时段都不发请求
	check("轮询带可见性门控", src.includes("visibilitychange") && src.includes("shouldPoll"));
	check("交易日历来自服务端 /calendar", src.includes("/api/leekbox/calendar"));
}

// 6) 源码模块之间的导入/导出必须对得上
//
// 存在的理由（一次真实的踩坑）：build 失败时 esbuild 不会覆盖 lib/client.js，
// 于是"重新构建后产物哈希不变"会被误读成"构建成功且幂等"。当时 detail.js 被
// 重建后漏掉了 StockDetailWindow 的 export，panel.js 的 import 就成了悬空引用；
// 构建一直在报错，但产物是上一次成功的旧文件，看起来"稳定"。
// 所以必须直接检查配对，而不是只看产物哈希。
{
	const { readdirSync } = await import("node:fs");
	const dir = new URL("./src/client/", import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
	const exportsOf = new Map();
	for (const f of files) {
		const s = readFileSync(new URL(f, dir), "utf8");
		const names = new Set();
		for (const m of s.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
		for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) {
			for (const part of m[1].split(",")) {
				const t = part.trim();
				if (t !== "") names.add((t.split(/\s+as\s+/).pop() ?? t).trim());
			}
		}
		exportsOf.set(f, names);
	}
	const missing = [];
	for (const f of files) {
		const s = readFileSync(new URL(f, dir), "utf8");
		for (const m of s.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+)";/gm)) {
			const target = m[2];
			if (!exportsOf.has(target)) {
				missing.push(`${f} → ./${target}（模块不存在）`);
				continue;
			}
			for (const part of m[1].split(",")) {
				const t = part.trim();
				if (t === "") continue;
				const name = (t.split(/\s+as\s+/)[0] ?? t).trim();
				if (!exportsOf.get(target).has(name)) missing.push(`${f} → ./${target} 未导出 ${name}`);
			}
		}
	}
	check(
		`${files.length} 个客户端模块的导入/导出配对`,
		missing.length === 0,
		missing.length === 0 ? "" : missing.slice(0, 4).join("; ")
	);
}

console.log(fail === 0 ? "\n✅ bundle 契约完好" : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
