// 持仓看板 dsh-portfolio — 项目身份常量
//
// 本项目由 `dsh-leekbox`（韭菜盒子 LeekBox，SuCriss，MIT）fork 而来，自 2026-11 起
// 对外改名为「持仓看板 / dsh-portfolio」。用户可见文案已全部替换，但**部分内部标识符
// 刻意保留原值** —— 改它们要么会让用户已存的数据失联，要么纯属内部实现细节、改了只
// 增加风险。下表是唯一的对应关系来源，再次改名或重构前请先读这里。
//
// | 内部标识符        | 保留值                        | 为什么保留 |
// |-------------------|-------------------------------|-----------|
// | HTTP 路由前缀     | `/api/leekbox/*`              | 客户端 bundle、文档、测试、用户自建脚本都按此路径调用；属接口契约而非用户可见文案 |
// | 持久化文件名前缀  | `$DSH_HOME/.leekbox-*.json`   | **改名会读不到用户已有持仓/自选/预警数据**，等同数据丢失，绝不可动 |
// | CSS 类名前缀      | `lkb_` / `lkb-`               | 纯内部样式钩子，只有本插件自己的 DOM 使用 |
// | 样式元素 id       | `dsh-leekbox-style`           | 注入 <style> 时的去重标记，内部实现细节 |
//
// 已随改名同步更新的标识符（用户可见或带品牌含义）：
//   包名 `dsh-leekbox-plus` → `dsh-portfolio`；
//   Loader 行 id `leekbox-plus` → `portfolio`；
//   客户端 bundle id（`__ModuleLoader__.load({ id })`）与单实例哨兵同上；
//   侧边栏入口文案、面板标题、README/NOTICE/文档、插件显示名。
//
// 注意：DSH 读取的**插件显示名来自 `locale/*.json` 的 `meta.title`**（不是 package.json
// 的 `displayName`；后者在 DSH 中不生效，仅为兼容 npm 侧工具保留）。改显示名请改 locale。

/** 插件对外显示名（中文）。必须与 `locale/zh.json` 的 `meta.title` 保持一致。 */
export const DISPLAY_NAME = "持仓看板";

/** 英文显示名。必须与 `locale/en.json` 的 `meta.title` 保持一致。 */
export const DISPLAY_NAME_EN = "Portfolio Board";

/** cordis 插件名 / 命名空间 key，同时是 Loader 行 `name` 与包名。 */
export const PLUGIN_NAME = "dsh-portfolio";

/*
 * 品牌图标**不在**这个文件里：唯一真源是 `assets/icon.svg`，客户端侧由
 * `src/client/icon.js` 把同一份文件当字符串内联进 DOM。
 *
 * 为什么必须内联：SVG 里用的是 `currentColor`，靠 CSS `color` 继承才能跟随
 * 选中/未选中与浅色/深色主题；用 `<img src>` 加载时 SVG 是隔离文档，继承不到颜色。
 *
 * 这里原先有个 `BRAND_EMOJI = "📊"` 侧边栏图标 —— emoji 是彩色字形，既跟不上主题，
 * 也和 DSH 原生图标的纯线条风格不一致，已按「纯线条、无填充、单色」的要求删除。
 * 不要再加回来。
 */

/** API 前缀。历史原因保留 `leekbox`，见文件头表格 —— 勿改。 */
export const API_PREFIX = "/api/leekbox";

/** 单实例哨兵 key（`globalThis[Symbol.for(...)]`）。 */
export const MOUNT_SYMBOL = "dsh-portfolio.mounted";

/** 侧边栏入口的 DOM 标记属性，以及与之配套的选择器。仅本插件使用。 */
export const ENTRY_ROW_ATTRIBUTE = "data-dsh-portfolio-entry";
export const ENTRY_SELECTOR = "[data-dsh-portfolio-entry]";
