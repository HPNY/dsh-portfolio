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
	/\.lkb-page\{[^}]*display:flex/.test(src) && /\.lkb_panelIcon svg\{width:100%;height:100%/.test(src)
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
// 踩坑守卫：`ctx.slots` 只有声明在 inject 里才会被注入到 apply 的 ctx。
// 之前写成 inject:[] → 真实运行时 ctx.slots 为 undefined、注册抛错被 try/catch
// 吞掉，表现为「侧栏行点了没反应」；而用桩 ctx 的测试发现不了（桩里塞了 slots）。
// 官方模板 templates/decoration/client.js 与 dsh-armory 都声明了 'slots'。
check("inject 声明了 slots（否则 ctx.slots 不存在，面板注册静默失败）", (exp?.inject ?? []).includes("slots"));

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
// 面板行图标由 sidebar.panellist 的注册组件渲染，尺寸跟随宿主的 size 参数
// （展开 16 / 折叠栏 18），不再写死 16x16。
check(
	"面板行图标尺寸跟随宿主 size 参数（不写死）",
	/style:\s*\{\s*width: size \+ "px",\s*height: size \+ "px",?\s*\}/.test(src) && /\.lkb_panelIcon svg\{width:100%;height:100%/.test(src)
);
// ── 官方 slot 注册（sidebar.panellist + main），替代弹窗时代的 DOM 挂载 ────
//
// 侧栏入口不再是手搓 DOM：注册 sidebar.panellist（行点击由宿主承担，自动获得
// 选中态 / 折叠栏 / 固定 / 更多菜单），同一个 id 寻址 main slot 的主面板页面。
// 弹窗时代的 sidebar.js（cloneNode 复刻原生行 + MutationObserver 补挂）已退役。
check(
	"注册官方面板行 sidebar.panellist（id = 插件名 + 图标组件）",
	src.includes('ctx.slots.inject("sidebar.panellist"') && src.includes('name: "sidebar.panellist"') && src.includes(", PanelIcon)")
);
check(
	"注册主面板页面 main（key = 插件名 + PortfolioPage 组件）",
	src.includes('ctx.slots.inject("main"') && src.includes('name: "main"') && src.includes(", PortfolioPage)")
);
check("面板行带 order 排进原生导航组", /order: -?\d+/.test(src));
check(
	"DOM 注入式侧边栏挂载已退役（无 cloneNativeEntry / mountSidebarEntry / scrollport 定位）",
	!/function cloneNativeEntry\(/.test(src) && !/function mountSidebarEntry\(/.test(src) && !/data-sidebar-scrollport/.test(src)
);
// ── 页面形态：主从联动右栏（方向 C）+ 钻取子页（方向 B）────────────────
check(
	"点行联动右栏详情（DetailRail，不再是开窗）",
	src.includes("function DetailRail(") && /h\(\s*"aside",\s*\{ className: "lkb-rail" \}/.test(src)
);
check(
	"右栏「⤢ 打开完整详情」钻取子页（SubDetail，面包屑返回，变体 rail/page 分工）",
	src.includes("function SubDetail(") && src.includes("onDrill: () => setDrill(selected)") && src.includes('variant: "page"') && src.includes('variant: "rail"')
);
check(
	"ESC 层级：先退钻取再收右栏（escTarget 纯函数接线）",
	src.includes("function escTarget(") && src.includes("escTarget({ drill: drill !== null, selected: selected !== null })")
);
check(
	"右栏持仓卡复用自选页的内联编辑与预警表单",
	src.includes("const posCard = () =>") && src.includes("h(PositionCell,") && src.includes("h(AlertForm,")
);
check(
	"注册失败不静默（显式探活 ctx.slots + console.error 可诊断告警）",
	src.includes('if (ctx?.slots === void 0)') && src.includes("[portfolio] ctx.slots 不可用") && src.includes("[portfolio] 面板注册失败：")
);
// ── 悬停预览（hover 显示 / 移开取消）────────────────────────────────────
//
// 需求原话：「鼠标悬停在对应股票和基金项上时显示浮窗，移开后取消浮窗显示」。
// 四个要点都要在产物里可验证：延迟出现（不是划过就闪）、移开收起、
// 单例（不叠一堆）、以及各列表都接上了（漏一个就表现为"某些行不预览"）。
check(
	"悬停预览：延迟出现 + 移开收起（防闪烁的定时器）",
	/var SHOW_DELAY = \d+;/.test(src) && /var HIDE_GRACE = \d+;/.test(src) && src.includes("function showPreviewSoon(") && src.includes("function hidePreview(")
);
check(
	"悬停预览单例（订阅式广播，同一时刻只有一个浮窗）",
	src.includes("previewListeners") && src.includes("function PreviewHost(") && src.includes("function onPreview(")
);
check(
	"预览浮窗可被指针进入（否则移到浮窗上就消失）",
	src.includes("function keepPreview(") && /onMouseEnter: keepPreview/.test(src)
);
check(
	"预览定位纯函数：优先右侧、放不下翻左、夹回视口",
	src.includes("function previewPosition(") && /rect\.right \+ gap/.test(src) && /rect\.left - gap - size\.width/.test(src)
);
check(
	"预览用最轻的内容档（variant preview：无操作行/持仓卡，周期只留分时+日K）",
	/var PERIODS_PREVIEW = \["today", "day"\];/.test(src) && /variant: "preview"/.test(src)
);
check(
	"各列表行都接上了悬停预览（rowHover 被各页使用）",
	["watchlist-tab.js", "market-tab.js", "screener-tab.js", "indices-tab.js", "otc-fund-tab.js"].every((f) =>
		readFileSync(new URL(`./src/client/${f}`, import.meta.url), "utf8").includes("rowHover(")
	)
);
check(
	"右栏可钉浮窗并排对比（⧉ 按钮 + FloatLayer 渲染）",
	src.includes("function FloatLayer(") &&
		src.includes("function FloatCard(") &&
		src.includes("onPin: pinFloat") &&
		src.includes("h(FloatLayer, { floats, onClose: closeFloat, onFocus: focusFloat })")
);
check(
	"浮窗可拖拽且夹回视口（pointer 事件 + 边界夹取）",
	/setPointerCapture\?\.\(e\.pointerId\)/.test(src) && /Math\.max\(8 - d\.w \+ 80/.test(src) && /window\.innerHeight - 40/.test(src)
);
check(
	"浮窗复用右栏同一套紧凑内容（variant rail，不重复实现）",
	/floats\.map\(\(f\) => h\(FloatCard/.test(src) && (src.match(/variant: "rail"/g) ?? []).length >= 2
);
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
// 点基金行 → 右栏联动基金详情（与自选点行同一套联动）；旧的行内编辑页已删除。
check(
	"点基金行联动右栏基金详情（旧编辑页与旧浮窗都已删除）",
	src.includes("function FundDetailContent(") &&
		src.includes("onClick: () => onOpen(fund)") &&
		!src.includes("FundEditForm") &&
		!src.includes("colSpan: 7") &&
		!src.includes("function FundDetailWindow(")
);
check(
	"基金详情走 Host 的 history 接口（阶段涨幅由 Host 算）",
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
// 详情内容超长时必须**可滚动**，不能被 overflow:hidden 裁掉。
// 关键是 flex 子项要 min-height:0 —— 默认 min-height:auto 会撑满父级高度，
// 于是滚动条根本不出现，底部内容（财务摘要、重仓股列表）被切掉。
{
	const stylesSrc = readFileSync(new URL("./src/client/styles.js", import.meta.url), "utf8");
	check(
		"详情内容可滚动（.lkb_body / .lkb-fundBody：flex:1 + min-height:0，不会被裁掉）",
		/\.lkb_body\{[^}]*min-height:0/.test(stylesSrc) && /\.lkb-fundBody\{[^}]*min-height:0/.test(stylesSrc)
	);
	// 右栏宽度要有界：太窄挤爆内容、太宽挤扁列表
	check("右栏宽度有界（clamp(320px,36%,440px)）", /\.lkb-rail\{[^}]*width:clamp\(320px,36%,440px\)/.test(stylesSrc));
	// 周期按钮 13 个档位，必须不截断文字 —— 否则标题一长就挤成 "分\n时"。
	check("周期按钮文字不截断（white-space:nowrap）", /\.lkb-period\{[^}]*white-space:nowrap/.test(stylesSrc));
}
// 右栏紧凑版不渲染资金流/F10，也不该发这两组请求（variant 门控在内容层），
// 更不该把窗口时代的视口夹取/拖拽代码带回来。
{
	const detailSrc = readFileSync(new URL("./src/client/detail.js", import.meta.url), "utf8");
	const fundSrc = readFileSync(new URL("./src/client/fund-detail.js", import.meta.url), "utf8");
	check(
		"右栏/预览档跳过资金流/F10 请求且右栏渲染持仓卡（variant 门控）",
		/if \(variant !== "page"\) return;/.test(detailSrc) && /isRail \? posCard\(\) : null/.test(detailSrc)
	);
	check("详情内容不含窗口拖拽/视口夹取残留", !/getBoundingClientRect/.test(fundSrc));
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
	"详情里有「加入基金 / 移出基金」按钮，且「＋ 添加基金」入口已删除",
	src.includes("加入基金") &&
		src.includes("移出基金") &&
		!src.includes("AddFundForm") &&
		!src.includes("＋ 添加基金")
);
// 基金详情内容必须与股票详情内容用同一套卡片语言（.lkb-chartBox + .lkb-chartTitle + .lkb-detailQuote），
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
// 注意详情内容里也有"昨收"，但那走的是 item(...) 助手，用 td 写法区分。
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
// apply() 现在会真的碰 document —— 用桩跑一遍，确认挂载链路不抛，且两个
// 官方 slot（main + sidebar.panellist）都确实发出了注册。
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
	const slotCalls = [];
	const ctx = {
		effect: () => {},
		slots: {
			inject: (owner, cb) => {
				slotCalls.push(`inject:${owner}`);
				cb();
				return () => {};
			},
			register: (reg) => {
				slotCalls.push(`register:${reg.name}`);
				return () => {};
			},
		},
	};
	const origFetch = globalThis.fetch;
	// 日历拉取是后台异步的；这里给一个永不 resolve 的 fetch，避免测试退出前
	// 冒出未处理的 reject（真实环境走浏览器 fetch）。
	globalThis.fetch = () => new Promise(() => {});
	try {
		exp.apply(ctx);
	} catch (error) {
		applyError = error;
	} finally {
		globalThis.fetch = origFetch;
	}
	check("apply() 在最小 DOM 桩上不抛", applyError === null, applyError === null ? "" : String(applyError));
	check(
		"apply() 确实注册了 main 与 sidebar.panellist 两个 slot",
		slotCalls.includes("register:main") && slotCalls.includes("register:sidebar.panellist"),
		slotCalls.join(", ")
	);
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
	check("面板不再自己渲染 AlertWatcher", !/function PortfolioPage[\s\S]*?h\(AlertWatcher\b/.test(src), (src.match(/h\(AlertWatcher\b/g) ?? []).length + " 处渲染（应仅常驻宿主 1 处）");
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
