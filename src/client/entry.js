// 持仓看板 dsh-portfolio — 客户端 bundle 源码：插件入口（apply/inject + slot 注册）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 「弹窗 → 页面」迁移后，面板由宿主经**官方 slot** 挂载：
//   - `main`（key = 插件名）注册主面板页面 PortfolioPage —— 侧栏行的点击由宿主
//     承担，自动获得选中态、折叠栏、固定/更多菜单（与「插件」「大肥鱼军械库」
//     同一套机制）；
//   - `sidebar.panellist` 注册面板行图标 PanelIcon。
// 弹窗时代手搓 DOM 挂侧边栏入口的 sidebar.js 已整体退役。
import "./styles.js";
import { startSessionClock, startThemeClock } from "./core.js";
import { mountAlertWatcher } from "./watchlist-tab.js";
import { PortfolioPage, PanelIcon } from "./panel.js";
import { DISPLAY_NAME, PLUGIN_NAME } from "../../lib/identity.js";

export const inject = [];

export function apply(ctx) {
	// 这两件事必须随**插件**存活，而不是随面板：面板挂载/卸载随宿主的视图切换，
	// 挂在面板里的价格预警看护会跟着卸载（README 承诺的"交易时段自动盯盘"
	// 就会静默失效）。同理，交易日历的拉取与"回到前台补拉"也不该绑在面板生命周期上。
	const sessionClock = startSessionClock();
	const themeClock = startThemeClock();
	const alertWatcher = mountAlertWatcher();
	const disposers = [];
	try {
		// 官方面板注册（声明感知的 slots.inject：声明出现时注册、折叠时回收）。
		// label 走注册参数字符串；本插件界面文案为中文（与 DISPLAY_NAME 一致）。
		// order:-1 争取排在「插件」等原生行之前（升序、并列按注册顺序），
		// 与旧布局里"持仓看板在菜单组顶部"的既有顺序对齐。
		ctx.slots.inject("main", () => {
			ctx.slots.register({ name: "main", key: PLUGIN_NAME, label: DISPLAY_NAME, inject: () => ({}) }, PortfolioPage);
		});
		ctx.slots.inject("sidebar.panellist", () => {
			ctx.slots.register({ name: "sidebar.panellist", id: PLUGIN_NAME, order: -1, label: DISPLAY_NAME }, PanelIcon);
		});
		disposers.push(() => alertWatcher.dispose());
		disposers.push(() => sessionClock());
		disposers.push(() => themeClock());
	} catch (error) {
		console.warn("[portfolio] mount failed:", error);
	}
	ctx.effect(
		() => () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
		"portfolio: ui mounts"
	);
}
