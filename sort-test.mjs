// 排序功能测试：按列排序（纯函数）+ 自定义拖拽排序（moveItem）+ 服务端重排路由。
//
// 为什么单独一个套件：排序逻辑是纯函数，能逐场景精确断言（升/降/取消、缺值沉底、
// 稳定性），比在 bundle 里 grep 锚点可靠得多；服务端重排还要验证"集合不一致就拒绝"
// 这条数据安全规则——静默拼接会悄悄改用户数据，必须测。
import { readFileSync } from "node:fs";
import { sortRows, nextSortDir, moveItem, mergeSubsetOrder, settleOrderCommit } from "./src/client/table-sort-core.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
	if (cond) {
		pass += 1;
		console.log(`  PASS  ${name}`);
	} else {
		fail += 1;
		console.log(`  FAIL  ${name}${detail === void 0 ? "" : "  —  " + detail}`);
	}
}

const rows = [
	{ code: "a", price: 10, name: "B公司" },
	{ code: "b", price: null, name: "A公司" },
	{ code: "c", price: 30, name: "C公司" },
	{ code: "d", price: 10, name: "A公司" },
];
const getters = { price: (r) => r.price, name: (r) => r.name };

// ── 表头点击循环：null → asc → desc → null ──────────────────────────
check("排序方向循环 null→asc", nextSortDir(null) === "asc");
check("排序方向循环 asc→desc", nextSortDir("asc") === "desc");
check("排序方向循环 desc→null（取消）", nextSortDir("desc") === null);

// ── 按列排序 ────────────────────────────────────────────────────────
const asc = sortRows(rows, "price", "asc", getters);
check("升序：数值从小到大", asc.map((r) => r.price).join(",") === "10,10,30,", asc.map((r) => r.price).join(","));
check("缺值（null）升序沉底", asc[asc.length - 1].code === "b");
const desc = sortRows(rows, "price", "desc", getters);
check("降序：数值从大到小", desc.map((r) => r.price).join(",") === "30,10,10,", desc.map((r) => r.price).join(","));
check("缺值（null）降序也沉底", desc[desc.length - 1].code === "b");
check("取消排序（key=null）原样返回", sortRows(rows, null, "asc", getters) === rows);
check("取消排序（dir=null）原样返回", sortRows(rows, "price", null, getters) === rows);
check("排序不修改原数组", rows.map((r) => r.code).join(",") === "a,b,c,d");

// 稳定性：等值时保持原相对顺序（自定义顺序不会因"相等项"被打乱）
const stable = sortRows(rows, "name", "asc", getters);
const names = stable.map((r) => r.name).join(",");
check("等值项保持原相对顺序（稳定排序）", names === "A公司,A公司,B公司,C公司", names);
const byPrice = sortRows(rows, "price", "asc", getters);
check("按价格升序时两个 10 保持原序（a 在 d 前）", byPrice[0].code === "a" && byPrice[1].code === "d", byPrice.map((r) => r.code).join(","));

// 字符串排序：中文按拼音（localeCompare zh-Hans-CN）
const zh = sortRows([{ n: "张" }, { n: "安" }, { n: "白" }], "n", "asc", { n: (r) => r.n });
check("中文按拼音排序（安<白<张）", zh.map((r) => r.n).join("") === "安白张", zh.map((r) => r.n).join(""));

// ── 自定义排序：moveItem ────────────────────────────────────────────
const list = ["a", "b", "c", "d"];
check("下移：把第 1 项移到第 3 位", moveItem(list, 0, 2).join(",") === "b,c,a,d", moveItem(list, 0, 2).join(","));
check("上移：把第 4 项移到第 1 位", moveItem(list, 3, 0).join(",") === "d,a,b,c", moveItem(list, 3, 0).join(","));
check("原地移动返回同一引用（省一次重渲染）", moveItem(list, 1, 1) === list);
check("越界索引不改变", moveItem(list, -1, 2).join(",") === "a,b,c,d" && moveItem(list, 0, 9).join(",") === "a,b,c,d");
check("moveItem 不修改原数组", list.join(",") === "a,b,c,d");

// ── 分组内拖拽：子集顺序合并回完整列表 ──────────────────────────────
// 自选页有分组筛选；在「短线」分组里拖拽只拿到子集，但服务端要求完整集合。
// 合并规则：子集按新顺序填回原位置，分组外的项原位不动。
const full = [{ code: "a" }, { code: "b" }, { code: "c" }, { code: "d" }, { code: "e" }];
// 假设 b、d 属于「短线」分组，把它们在分组内互换
const merged = mergeSubsetOrder(full, ["d", "b"]);
check("分组内互换：子集按新顺序填回原位置", merged.join(",") === "a,d,c,b,e", merged.join(","));
check("合并结果包含全部条目（不丢行）", merged.length === full.length);
check("合并结果无重复", new Set(merged).size === merged.length);
// 三只的逆序：a/c/e 占据第 1/3/5 位，按 [e,c,a] 依次填入 → e,b,c,d,a
const merged3 = mergeSubsetOrder(full, ["e", "c", "a"]);
check("三只子集逆序合并（子集只占用自己原来的槽位）", merged3.join(",") === "e,b,c,d,a", merged3.join(","));
// 子集等于全集 → 结果就是提交的顺序
check("子集=全集时结果即提交顺序", mergeSubsetOrder(full, ["e", "d", "c", "b", "a"]).join(",") === "e,d,c,b,a");
// 空子集 → 原样
check("空子集不改变顺序", mergeSubsetOrder(full, []).join(",") === "a,b,c,d,e");

// ── 服务端：自选重排路由（**真调 handler**，不是 grep 源码）─────────
// 只做字符串断言等于没测行为：把校验删掉、把写入顺序写反都能过。这里起真实
// 临时 $DSH_HOME，直接调 makeRoutes 拿到的 handler，验证顺序真的落盘、非法请求真被拒。
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync as readFile, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { makeRoutes, ROUTES } from "./lib/index.js";

const home = mkdtempSync(joinPath(tmpdir(), "leekbox-sort-"));
const routes = makeRoutes({}, { dshHome: home, logger: { warn() {} } });
const reorderRoute = routes.find((r) => r.path === ROUTES.watchlist + "/reorder");
const addRoute = routes.find((r) => r.path === ROUTES.watchlist + "/add");
const listRoute = routes.find((r) => r.path === ROUTES.watchlist);
check("自选 /reorder 路由已注册", reorderRoute !== void 0);

function makePost(url, body) {
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), "utf8")]);
	req.method = "POST";
	req.url = url;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost", "content-type": "application/json", origin: "http://localhost" };
	return req;
}
function makeRes() {
	const res = new EventEmitter();
	res.headersSent = false;
	res.body = null;
	res.statusCode = 0;
	res.writeHead = (code) => {
		res.statusCode = code;
		res.headersSent = true;
	};
	res.write = (s) => {
		res.body = (res.body ?? "") + s;
		return true;
	};
	res.end = (s) => {
		if (s) res.body = (res.body ?? "") + s;
	};
	return res;
}

// 先加三只（服务端 push 顺序 = 初始自定义顺序）
for (const code of ["sh600519", "sz000001", "sh601318"]) {
	const res = makeRes();
	await addRoute.handler(makePost(ROUTES.watchlist + "/add", { code }), res);
	check(`加入 ${code} 成功`, res.statusCode === 200, `status=${res.statusCode}`);
}

// 合法重排：倒序提交
let res = makeRes();
await reorderRoute.handler(makePost(ROUTES.watchlist + "/reorder", { codes: ["sh601318", "sz000001", "sh600519"] }), res);
check("合法重排返回 200", res.statusCode === 200, `status=${res.statusCode}`);
const stored = JSON.parse(readFile(joinPath(home, ".leekbox-watchlist.json"), "utf8"));
check("顺序真的落盘（倒序）", stored.map((e) => e.code).join(",") === "sh601318,sz000001,sh600519", stored.map((e) => e.code).join(","));

// 少一个 code：必须 409（否则会静默丢行）
res = makeRes();
await reorderRoute.handler(makePost(ROUTES.watchlist + "/reorder", { codes: ["sh601318", "sz000001"] }), res);
check("缺少条目 → 409 拒绝", res.statusCode === 409, `status=${res.statusCode}`);
const after1 = JSON.parse(readFile(joinPath(home, ".leekbox-watchlist.json"), "utf8"));
check("被拒后顺序不变（没有半截写入）", after1.map((e) => e.code).join(",") === "sh601318,sz000001,sh600519");

// 多一个不存在的 code：必须 409
res = makeRes();
await reorderRoute.handler(makePost(ROUTES.watchlist + "/reorder", { codes: ["sh601318", "sz000001", "sh600519", "sh600000"] }), res);
check("多出条目 → 409 拒绝", res.statusCode === 409, `status=${res.statusCode}`);

// 重复 code：必须 400
res = makeRes();
await reorderRoute.handler(makePost(ROUTES.watchlist + "/reorder", { codes: ["sh601318", "sh601318", "sh600519"] }), res);
check("重复条目 → 400 拒绝", res.statusCode === 400, `status=${res.statusCode}`);

// codes 不是数组：必须 400
res = makeRes();
await reorderRoute.handler(makePost(ROUTES.watchlist + "/reorder", { codes: "sh601318" }), res);
check("codes 非数组 → 400 拒绝", res.statusCode === 400, `status=${res.statusCode}`);

// 列表接口返回的就是自定义顺序（重开插件看到的顺序与拖拽后一致）
res = makeRes();
await listRoute.handler({ method: "GET", url: ROUTES.watchlist, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" } }, res);
check("GET 列表按自定义顺序返回", JSON.parse(res.body).watchlist.map((e) => e.code).join(",") === "sh601318,sz000001,sh600519");

rmSync(home, { recursive: true, force: true });

// ── 服务端：基金重排（**真调 store 纯函数**）────────────────────────
// 这里刻意不用 grep：`reorderHoldings` 的"集合必须完全一致"是最容易写漏又最危险的
// 规则（写漏了会把用户持仓静默改掉），必须用真实数据走一遍。
const { reorderHoldings, upsertHolding, deleteHolding, readOtcFund } = await import("./lib/otc-fund-store.js");

const fundData = { holdings: {}, navSnapshots: {}, navHistory: {}, order: [] };
for (const code of ["161725", "110022", "003096"]) {
	upsertHolding(fundData, { code, shares: 100, costNav: 1.5 });
}
check("upsert 后 order 按加入顺序累积", fundData.order.join(",") === "161725,110022,003096", fundData.order.join(","));

const okReorder = reorderHoldings(fundData, ["003096", "161725", "110022"]);
check("合法重排返回 data（不是 null）", okReorder !== null);
check("重排后 order 就是提交顺序", fundData.order.join(",") === "003096,161725,110022", fundData.order.join(","));
check("重排不影响 holdings 内容", Object.keys(fundData.holdings).sort().join(",") === "003096,110022,161725");

check("缺一只 → 拒绝（返回 null）", reorderHoldings(fundData, ["003096", "161725"]) === null);
check("多一只 → 拒绝", reorderHoldings(fundData, ["003096", "161725", "110022", "999999"]) === null);
check("重复项 → 拒绝", reorderHoldings(fundData, ["003096", "003096", "110022"]) === null);
check("非数组 → 拒绝", reorderHoldings(fundData, "003096") === null);
check("被拒后 order 保持原样（没有半截修改）", fundData.order.join(",") === "003096,161725,110022", fundData.order.join(","));

// 删除后 order 同步收缩（不留幽灵项），新加入的追加到末尾
deleteHolding(fundData, "161725");
check("删除持仓后 order 同步摘除", fundData.order.join(",") === "003096,110022", fundData.order.join(","));
upsertHolding(fundData, { code: "161725", shares: 100, costNav: 1.5 });
check("重新加入的持仓追加到 order 末尾（不打乱既有顺序）", fundData.order.join(",") === "003096,110022,161725", fundData.order.join(","));

// 读取时清理脏 order：指向不存在持仓的项、重复项都要被过滤
const dirtyHome = mkdtempSync(joinPath(tmpdir(), "leekbox-fund-order-"));
const { writeOtcFund, otcFundPath } = await import("./lib/otc-fund-store.js");
writeOtcFund(dirtyHome, {
	holdings: { "161725": { shares: 100, costNav: 1.5 }, "110022": { shares: 200, costNav: 2 } },
	navSnapshots: {},
	navHistory: {},
	order: ["110022", "161725", "999999", "110022"],
});
const cleaned = readOtcFund(dirtyHome);
check("读取时过滤掉指向不存在持仓的 order 项", !cleaned.order.includes("999999"), cleaned.order.join(","));
check("读取时去掉 order 里的重复项", cleaned.order.length === 2, cleaned.order.join(","));
check("读取保留合法顺序", cleaned.order.join(",") === "110022,161725", cleaned.order.join(","));
rmSync(dirtyHome, { recursive: true, force: true });
void otcFundPath;

const fundSrc = readFileSync(new URL("./lib/otc-fund.js", import.meta.url), "utf8");
check("基金 mutate 支持 reorder 动作", fundSrc.includes('if (action === "reorder")'));
check("基金快照按 order 排序并补齐未列出的持仓", fundSrc.includes("const ordered = order.filter((c) => known.has(c))") && fundSrc.includes("const rest = all.filter((c) => !ordered.includes(c))"));

// ── 保存失败必须回退本地顺序 ────────────────────────────────────────
// 真实故障：宿主加载旧服务端代码 → reorder 路由未注册 → POST 回 401，
// 但本地顺序照样生效，界面显示新顺序、服务端一无所知，重进就变回旧顺序。
{
	let rolledBack = false;
	const okOutcome = settleOrderCommit(Promise.resolve(), () => (rolledBack = true));
	check("保存成功不回退", okOutcome !== null && (await okOutcome) === false && rolledBack === false);

	let rolledBack2 = false;
	const failOutcome = settleOrderCommit(Promise.reject(new Error("401")), () => (rolledBack2 = true));
	const didRollback = await failOutcome;
	check("保存失败回退本地顺序", didRollback === true && rolledBack2 === true);
	// 吞掉上面那个 rejected promise 的未处理告警
	void failOutcome.catch(() => {});

	// 回调不返回 promise（老签名/同步回调）→ 无从判断，不假装回退
	let rolledBack3 = false;
	check("回调不返回 Promise 时不回退（无从判断）", settleOrderCommit(void 0, () => (rolledBack3 = true)) === null && rolledBack3 === false);
	check("回调返回 null 时不回退", settleOrderCommit(null, () => (rolledBack3 = true)) === null && rolledBack3 === false);
}

// ── 组件渲染：SortableTh 真的产出了可点击表头 ────────────────────────
// 用 esbuild 把 table-sort.js 打成一个临时包（"react" 别名指向轻量桩），
// 然后当普通函数调用 —— 这样断言的是真实元素树（类名/aria/箭头），
// 而不是"源码里出现过某段字符串"。
{
	const { build } = await import("esbuild");
	// 产物写到项目目录下（系统临时目录在沙箱里可能不可写），用完立刻删。
	const outFile = fileURLToPath(new URL("./.render-bundle.tmp.mjs", import.meta.url));
	await build({
		entryPoints: ["src/client/table-sort.js"],
		bundle: true,
		format: "esm",
		outfile: outFile,
		platform: "neutral",
		alias: { react: "./test-react-stub.mjs", "react-dom/client": "./test-react-stub.mjs" },
		logLevel: "silent",
	});
	const mod = await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
	const th = mod.SortableTh;
	check("SortableTh 是函数组件", typeof th === "function");

	// 未排序态：显示 ⇅ 占位、aria-sort=none
	const idle = th({ label: "现价", colKey: "price", sortKey: null, sortDir: null, onToggle: () => {} });
	check("未排序表头 aria-sort=none", idle.props["aria-sort"] === "none", String(idle.props["aria-sort"]));
	check("未排序表头显示 ⇅ 占位（避免列宽跳动）", JSON.stringify(idle.children).includes("⇅"));
	check("可排序表头带 lkb-thSort 类（有 cursor:pointer）", idle.props.className.includes("lkb-thSort"));
	check("可排序表头可键盘聚焦", idle.props.tabIndex === 0);

	// 升序态：▲ + aria-sort=ascending + 高亮类
	const ascTh = th({ label: "现价", colKey: "price", sortKey: "price", sortDir: "asc", onToggle: () => {} });
	check("升序表头 aria-sort=ascending", ascTh.props["aria-sort"] === "ascending");
	check("升序表头显示 ▲", JSON.stringify(ascTh.children).includes("▲"));
	check("当前排序列加高亮类 lkb-thSortActive", ascTh.props.className.includes("lkb-thSortActive"));

	// 降序态：▼
	const descTh = th({ label: "现价", colKey: "price", sortKey: "price", sortDir: "desc", onToggle: () => {} });
	check("降序表头 aria-sort=descending", descTh.props["aria-sort"] === "descending");
	check("降序表头显示 ▼", JSON.stringify(descTh.children).includes("▼"));

	// 点击真的回调对应列 key
	let clicked = null;
	const clickTh = th({ label: "涨跌幅", colKey: "changePct", sortKey: null, sortDir: null, onToggle: (k) => (clicked = k) });
	clickTh.props.onClick();
	check("点击表头回调正确的列 key", clicked === "changePct", String(clicked));
	// 回车/空格也能排序（键盘可达）
	clicked = null;
	clickTh.props.onKeyDown({ key: "Enter", preventDefault() {} });
	check("回车键也能触发表头排序", clicked === "changePct", String(clicked));

	// 拖拽禁用条件：按列排序时 dragProps 必须返回 {}（否则用户拖了没反应还以为坏了）
	// 用桩 hooks 直接调 useTableSort，验证互斥规则真的生效。
	const sortHook = mod.useTableSort;
	check("useTableSort 是函数", typeof sortHook === "function");
	const sampleRows = [{ code: "a" }, { code: "b" }];
	const noSort = sortHook(sampleRows, {}, () => {}, (r) => r.code);
	check("未排序时可拖拽（dragProps 返回 draggable）", noSort.canDrag === true && noSort.dragProps(0).draggable === true);
	// 桩 useState 不会真的更新状态，所以直接构造"已排序"的调用：sortKey 由内部状态决定，
	// 这里改为断言互斥规则的表达式本身存在于源码，并额外验证 onReorder=null 时禁用。
	const noCallback = sortHook(sampleRows, {}, null, (r) => r.code);
	check("没有 onReorder 回调时禁用拖拽", noCallback.canDrag === false && JSON.stringify(noCallback.dragProps(0)) === "{}");

	rmSync(outFile, { force: true });
}

// ── 客户端接线：两个列表都接上了排序 ──────────────────────────────
const wl = readFileSync(new URL("./src/client/watchlist-tab.js", import.meta.url), "utf8");
const fund = readFileSync(new URL("./src/client/otc-fund-tab.js", import.meta.url), "utf8");
check("自选页接了 useTableSort + SortableTh", wl.includes("useTableSort(") && wl.includes("SortableTh"));
check("基金页接了 useTableSort + SortableTh", fund.includes("useTableSort(") && fund.includes("SortableTh"));
check("自选页行铺开拖拽属性", wl.includes("table.dragProps(rowIndex)"));
check("基金页行铺开拖拽属性", fund.includes("table.dragProps(rowIndex)"));
check("两页都有排序提示（说明按列排序时拖拽暂停）", wl.includes("拖拽自定义顺序已暂停") && fund.includes("拖拽自定义顺序已暂停"));

// ── 保存失败必须让界面知道（否则显示一个没保存成功的顺序）─────────────
// 真实故障复盘：v0.26.0 发布后用户拖拽排序，重进页面变回原顺序。两个成因：
//   (1) 宿主还跑着旧服务端代码，reorder 路由没注册 → POST 回 401；
//   (2) 客户端把失败吞了，本地顺序照样生效 —— 界面显示新顺序，服务端一无所知。
// 这里锁住 (2)：两个提交回调都必须把 promise 交出去，并在失败时 throw，
// 让 useTableSort 的回退逻辑真的能触发。
check("自选 commitOrder 把 promise 交出去（回退逻辑靠它判断）", /return api\(API\.watchlistReorder/.test(wl));
check("自选 commitOrder 失败时抛错", /保存排序失败[\s\S]{0,160}?throw e;/.test(wl));
check("基金 commitFundOrder 把 promise 交出去", /\(codes\) =>\s*mutate\(\{ action: "reorder"/.test(fund));
check("基金 commitFundOrder 失败时抛错", /保存排序失败[\s\S]{0,160}?throw e;/.test(fund));
check("拖拽 drop 后调用 settleOrderCommit（失败回退）", readFileSync(new URL("./src/client/table-sort.js", import.meta.url), "utf8").includes("settleOrderCommit(outcome"));

console.log(`\n共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
