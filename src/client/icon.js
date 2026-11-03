// 持仓看板 dsh-portfolio — 客户端 bundle 源码：品牌图标
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 图标只有**一份**真源：`assets/icon.svg`（也就是 package.json `icon` 指向、
// DSH 设置页读取的那个文件）。这里用 esbuild 的 `text` loader 把同一份文件当字符串
// 读进来内联到 DOM，避免"插件图标"和"侧边栏图标"两份 SVG 各自漂移。
//
// 为什么必须内联而不是 <img src>：SVG 里用的是 `currentColor`，靠 CSS `color` 继承
// 才能跟随选中/未选中、浅色/深色主题。用 <img> 加载时 SVG 是隔离文档，继承不到颜色，
// 会退化成黑色。内联进按钮后，颜色由 `.lkb_entry` 的 `color` 决定。
import svg from "../../assets/icon.svg";

/** 内联 SVG 标记（字符串）。用于 sidebar.js 的 innerHTML 与面板标题。 */
export const BRAND_ICON_SVG = svg.trim();
