// 持仓看板 dsh-portfolio — 客户端 bundle 源码：插件入口（apply/inject）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
import "./styles.js";
import { startSessionClock, startThemeClock } from "./core.js";
import { mountPanel } from "./panel.js";
import { mountAlertWatcher } from "./watchlist-tab.js";
import { mountSidebarEntry } from "./sidebar.js";
import { DISPLAY_NAME, ENTRY_ROW_ATTRIBUTE, ENTRY_SELECTOR, PLUGIN_NAME } from "../../lib/identity.js";
import { BRAND_ICON_SVG } from "./icon.js";

export const inject = [];
const ENTRY_CSS = {
	entry: "lkb_entry",
	entryIcon: "lkb_entryIcon",
	entryLabel: "lkb_entryLabel",
};
/**
 * 侧边栏图标：内联 SVG 字符串（单一真源见 src/client/icon.js）。
 * 纯线条、无填充，笔画颜色全走 `currentColor`，因此自动跟随 `.lkb_entry` 的文字颜色：
 * 未选中是次级灰，hover / 激活是主文字色，深色主题同样自动生效。
 */
const ICON = BRAND_ICON_SVG;

export function apply(ctx) {
	const panel = mountPanel();
	// 这两件事必须随**插件**存活，而不是随面板：面板一关 root.unmount()，
	// 挂在面板里的价格预警看护就跟着卸载了（README 承诺的"交易时段自动盯盘"
	// 会静默失效）。同理，交易日历的拉取与"回到前台补拉"也不该绑在面板生命周期上。
	const sessionClock = startSessionClock();
	const themeClock = startThemeClock();
	const alertWatcher = mountAlertWatcher();
	const disposers = [];
	try {
		disposers.push(
			mountSidebarEntry({
				rowAttribute: ENTRY_ROW_ATTRIBUTE,
				rowSelector: ENTRY_SELECTOR,
				plugin: PLUGIN_NAME,
				icon: ICON,
				css: ENTRY_CSS,
				label: () => DISPLAY_NAME,
				tooltip: () => `${DISPLAY_NAME}：A股行情 / 选股 / 自选 / 7×24快讯 / 基金`,
				onToggle: () => panel.toggle(),
				position: "after",
				familySelectors: ["[data-dsh-taskboard-entry]", "[data-dsh-ssh-entry]", "[data-dsh-skill-explorer-entry]", ENTRY_SELECTOR],
			})
		);
		disposers.push(() => alertWatcher.dispose());
		disposers.push(() => sessionClock());
		disposers.push(() => themeClock());
		disposers.push(() => panel.dispose());
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
