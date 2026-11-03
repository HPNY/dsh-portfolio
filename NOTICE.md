# NOTICE — 上游归属与派生说明

`dsh-portfolio`（**持仓看板**）是 [`SuCriss/dsh-leekbox`](https://github.com/SuCriss/dsh-leekbox)（**韭菜盒子 LeekBox**）
的衍生作品（fork）。本仓库原名 `dsh-leekbox-plus`，2026-11 起对外改名为「持仓看板 / dsh-portfolio」。

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

在保留上游全部能力的前提下，新增「基金」子系统：

| 文件 | 说明 |
|---|---|
| `lib/otc-fund.js` | 场外基金数据层：pingzhongdata 解析、估值降级链、指标计算、两条路由 |
| `lib/otc-fund-store.js` | `.leekbox-otc-fund.json` 持久化（原子替换 + 写锁） |
| `lib/otc-fund-poller.js` | 披露窗口分段轮询（含跨零点窗口、`lateDisclosure`） |
| `src/client/otc-fund-tab.js` | 「基金」标签页 UI |
| `otc-fund-test.mjs` / `otc-fund-store-test.mjs` / `otc-fund-poller-test.mjs` | 测试 |
| `docs/otc-fund.md` | 子系统契约文档（含数据源实测结论） |

## 相对上游的改动点（完整清单）

以下改动是为了容纳新模块，均不改变上游原有行为：

1. `package.json` — 包名改为 `dsh-leekbox-plus`，版本 `0.20.0`，补上新增测试与 `check` 目标。
2. `cordis.patch.yml` — 注册行 id 改为 `leekbox-plus`，避免与已安装的上游副本冲突。
3. `build.mjs` — 产物 banner 与 `__ModuleLoader__.load({ id })` 改为 `dsh-leekbox-plus`。
4. `lib/index.js` — 追加两条场外基金路由的挂载、展开 `FUND_ROUTES` 进总路由表、
   在 `applyImpl` 中启动/清理轮询器；插件名与单实例哨兵改为 `leekbox-plus`。
   **`/api/leekbox/*` 既有路由的语义与实现未改动。**
5. `src/client/core.js` — API 表追加两个端点。
6. `src/client/panel.js` — TABS 追加一项、新增标签图标、body 分支追加一个。
7. `src/client/styles.js` — 追加标签页样式（`lkb_fund*` 类名，不改既有选择器）。
8. `src/client/entry.js` — 侧边栏入口文案改为「韭菜盒子 Plus」。
9. `client-bundle-test.mjs` — 两处断言随插件 id 重命名同步更新。

## 许可

本衍生作品同样以 **MIT** 分发，并保留上游版权声明。
上游对「韭菜盒子 LeekBox」的命名与品牌归 SuCriss 所有；本仓库以 `dsh-leekbox-plus`
名义分发，仅在描述中如实说明其派生自上游。
