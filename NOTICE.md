# NOTICE — 上游归属与派生说明

`dsh-portfolio`（**持仓看板**）是 [`SuCriss/dsh-leekbox`](https://github.com/SuCriss/dsh-leekbox)（**韭菜盒子 LeekBox**）
的衍生作品（fork）。本仓库原名 `dsh-leekbox-plus`，2026-11 起对外改名为「持仓看板 / dsh-portfolio」，
包名、bundle 行 id、产物 banner 与侧栏入口文案一并改为 `dsh-portfolio` / `portfolio` / 「持仓看板」。

## 上游

- 项目：`dsh-leekbox` — A股看盘助手 / A-share market dashboard for DeepSeek Harness (DSH)
- 作者：**SuCriss**
- 许可：**MIT**
- 钉定 commit：`1d47fb1bf8f0593b76a57fbfec77516ffe5f79fa`（2026-10-28，「fix(search): 未命中时兜底到东财 suggest（新上市票可搜）」）

上游的 `LICENSE`（MIT，Copyright (c) 2026 SuCriss）已**原样保留**在本仓库根目录。
上游全部功能 —— 大盘指数、行情列表、全市场搜索、自选分组与持仓盈亏、成本内联编辑、
价格预警、选股器、快讯聚合、AI 个股分析、K 线 / 分时图、CSV/JSON 导入导出、
股票 30 秒交易时段轮询 —— 均**完整保留、语义未改**。

## 本仓库新增

### 1. 场外基金子系统（0.20.0）

| 文件 | 说明 |
|---|---|
| `lib/otc-fund.js` | 场外基金数据层：pingzhongdata 解析、估值降级链、指标计算、五条路由 |
| `lib/otc-fund-store.js` | `.leekbox-otc-fund.json` 持久化（原子替换 + 写锁 + `order` 自定义顺序） |
| `lib/otc-fund-poller.js` | 披露窗口分段轮询（含跨零点窗口、`lateDisclosure`） |
| `src/client/otc-fund-tab.js` | 「基金」标签页 UI |
| `src/client/fund-detail.js` | 基金详情（右栏 / 钻取子页 / 悬停预览三档变体） |
| `otc-fund-test.mjs` / `otc-fund-store-test.mjs` / `otc-fund-poller-test.mjs` | 测试 |
| `docs/otc-fund.md` | 子系统契约文档（含数据源实测结论） |

### 2. 弹窗 → 页面化（0.22.0）

面板从「全屏遮罩弹窗 + 自建窗口系统」迁移为 DSH 主区域的**原生面板页面**：

- `src/client/entry.js` 改为注册官方 slot —— `main`（页面本体）与 `sidebar.panellist`（侧栏图标行）。
- `src/client/sidebar.js`（手搓 DOM 注入 + cloneNode 复刻原生行 + MutationObserver 补挂）**整体退役删除**。
- 窗口系统（`wins` 数组 / z 序 / 拖拽 / 视口夹取 / `mountPanel` 自挂 createRoot / `.lkb_overlay` / `.lkb_card` / `.lkb-win`）全部删除。
- `detail.js` / `fund-detail.js` 的 `*Window` 组件改为 `*Content`，新增 `variant` 三档：`page`（钻取子页，完整内容）、`rail`（右栏联动 / 浮窗）、`preview`（悬停预览，最轻档）。

### 3. 浮窗并排对比与悬停预览（0.23.0 / 0.24.0）

- 右栏头部 ⧉ 可把当前标的**钉成可拖拽浮窗**，多只并排对比；复用 `variant: "rail"` 内容组件。
- `src/client/hover-preview.js`：列表行悬停 380ms 弹出轻量预览（移开 160ms 宽限）、单例、右侧优先并夹回视口；五个列表各铺一行 `rowHover(...)` 即接入。

### 4. 响应式适配（0.25.0）

- `src/client/styles.js` 给 `.lkb-page` 加 `container-type:inline-size` + 具名容器 `lkbpage`，用**容器查询**（而非媒体查询）分三档 —— 面板宽度取决于侧栏折叠状态，媒体查询猜不准。
- `<860px` 右栏改覆盖式抽屉、页签只留图标、宽表可横滚；`fixed` 层的浮窗与预览按视口收窄。

### 5. 排序与自定义顺序（0.26.0 / 0.26.1）

| 文件 | 说明 |
|---|---|
| `src/client/table-sort-core.js` | 纯函数：`nextSortDir` / `sortRows` / `moveItem` / `mergeSubsetOrder` / `settleOrderCommit` |
| `src/client/table-sort.js` | `useTableSort` hook 与 `SortableTh` 表头组件（HTML5 拖拽 + 三态排序） |
| `lib/index.js` | 新增 `POST /api/leekbox/watchlist/reorder`（整份顺序提交、集合校验 409） |
| `lib/otc-fund-store.js` | `emptyOtcFund()` 增加 `order` 第四键 + `reorderHoldings()` |
| `sort-test.mjs` / `test-react-stub.mjs` | 81 项测试（含真调 handler / store / 渲染组件） |

## 相对上游的改动点（完整清单）

以下改动是为了容纳新模块与新交互，均不改变上游原有行为：

1. `package.json` — 包名 `dsh-portfolio`、`displayName`「持仓看板」、`author` 仍为 SuCriss 并把 HPNY 列入 `contributors`；`homepage` / `repository` / `bugs` 指向本 fork；补上新增测试与 `check` 目标。
2. `cordis.patch.yml` — 注册行 id 为 `portfolio`、`name: 'dsh-portfolio'`，避免与已安装的上游副本冲突。
3. `build.mjs` — 产物 banner 与 `__ModuleLoader__.load({ id: "dsh-portfolio" })`。
4. `lib/index.js` — 追加场外基金路由的挂载、展开 `FUND_ROUTES` 进总路由表、在 `applyImpl` 中启动/清理轮询器；追加自选 reorder 路由。
   **`/api/leekbox/*` 既有路由的语义与实现未改动。**
5. `lib/otc-fund-store.js` — 新增 `order` 键与 `reorderHoldings`；`holdings` 字典本身结构不变。
6. `src/client/core.js` — API 表追加场外基金与 reorder 端点。
7. `src/client/panel.js` — TABS 追加「基金」一项、新增标签图标、body 分支追加一个；新增 `DetailRail` / `SubDetail` / `FloatLayer` / `PreviewHost` / `PanelIcon`。
8. `src/client/styles.js` — 追加 `lkb_*` 新样式族；删除窗口系统的浮层类与 `.lkb_entry*`。
9. `src/client/entry.js` — 改为注册官方 slot（`inject` 必须声明 `"slots"`），侧栏入口文案改为 `DISPLAY_NAME`「持仓看板」。
10. `client-bundle-test.mjs` / `p2-silent-fixes-test.mjs` — 断言随契约重写（slot 注册、窗口系统退役否证、表头组件化）。
11. `README.md` / `README.en.md` / `CHANGELOG.md` / `NOTICE.md` / `docs/` / `market/` — 品牌、功能与数据源描述按实际实现更新。

## 许可

本衍生作品同样以 **MIT** 分发，并保留上游版权声明。
上游对「韭菜盒子 LeekBox」的命名与品牌归 SuCriss 所有；本仓库以 `dsh-portfolio` / 「持仓看板」
名义分发，仅在描述中如实说明其派生自上游。
