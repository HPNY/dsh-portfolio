# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.26.4] - 2026-11-13

一次「核对文档数字时撞出来的真实缺陷」。写文档时去数因子到底是几个，才发现客户端兜底表与服务端定义早就不一致——而这一处不一致会让选股**静默返回空结果**，不是报错。

### Fixed

- **数值因子被当成必选因子时整轮选股被静默筛空**：选股引擎的必选闸门是 `for (const req of p.factorRequire) if (factors[req] !== true) return null;`（`lib/screener.js:323`），而 9 个数值因子（`rsiValue` / `macdHistValue` / `volumeRatioValue` / `atrValue` / `atrPercent` / `changePctValue` / `turnoverRateValue` / `priceAboveMa20Pct` / `bollWidth`）`computeQuantFactors` 给的是**数字**（RSI=56.3、ATR%=2.7……），永远不等于 `true`。于是只要勾中一个数值因子，每一只票都会在这一行被 `return null` 掉，用户看到的是「选股完成，0 只」——参数错了却看起来像市场没货。现在 `normalizeScreenerParams` 在 factor 模式下先拦一道：`factorRequire` 里只要出现 `type === "number"` 的因子就抛 `ScreenerError`（`ERR_INVALID_PARAMS`），路由据此回 **400**，文案点名具体是哪个因子。
- **客户端兜底因子分组多出一个 `numeric` 组**：服务端 `FACTOR_GROUPS` 一直只有 7 个分组（`price` / `momentum` / `volatility` / `volume` / `pattern` / `td` / `vwap`），全部是布尔因子；数值因子不属任何分组，只服务于条件 DSL。但 `src/client/screener-tab.js` 的 `SCREEN_FACTOR_GROUPS_FALLBACK` 额外列了第 8 组 `numeric`（9 个数值因子）。这个兜底表在**服务端 meta 拉取失败时**才会生效——恰好就是网络最差、用户最需要它别出错的时候，它却给出一个能勾中上面那条死路的勾选框。已删除该组，并加注释说明为什么不能有它。

### Tests

- `screener-meta-test.mjs` 新增 8 条断言：兜底因子分组数与内容必须与服务端 `screenerMeta()` 完全一致、兜底不含任何数值因子、数值因子仍为 9 个；以及端到端三条——数值因子作必选 → **400**（文案点名该因子）、布尔+数值混合 → 400、纯布尔因子 → 200。
- 变异验证：撤掉服务端拦截 → 3 条红；把 `numeric` 兜底组加回去 → 3 条红（`兜底 8 vs 服务端 7`）。两处都能被测试抓住。

### Changed

- **`QUANT_FACTOR_INTEGRATION.md` / `SUMMARY.md` 的数字与安装说明**：两份都写「30+ 个量化因子、8 个分组」，实测是 **35 个因子（26 布尔 + 9 数值）/ 7 个分组 / 5 预设**——那个「8」正是上面兜底表的错误被写进了文档。同时把它们里面的 `cd D:\code\tst-pl\dsh-leekbox` + `npm start` + `http://127.0.0.1:7890` 换成现状：本 fork 是 DSH 插件，`package.json` 里**从来没有** `start` 脚本，也不监听固定端口（`git log -S'"start"' -- package.json` 为空）。改成 `npm run build` + `dsh plugin --profile web add github:HPNY/dsh-portfolio`，并写明「改了 `lib/*.js` 只刷新浏览器不够」。失效的 `file:///D:/code/...` 死链一并去掉。这两份文档是上游 `bb79106` 带来的，本 fork 首次修改，在末尾注明这是后补修订。
- **`DELIVERY.md` 的版本与标识**：停在 v0.20.0 的交付说明，写的是 bundle `dsh-leekbox-plus`、行 id `leekbox-plus`、`include:leekbox-plus`、以及「24 个套件 + 1 个已知上游缺陷」（该缺陷已由 `7f93b5f` 根治、`KNOWN_UPSTREAM_RED` 已清空）。全部对齐到现状（`dsh-portfolio` / `portfolio` / 26 个套件 / 零已知缺陷），并保留其作为 0.20.0 场外基金交付证据的历史记录性质。

## [0.26.3] - 2026-11-13

一次「仓库自身的生成器与临时产物」收口。功能没有变化，修的是**会自己把成果改回旧品牌的东西**：`docs/og.png` 的生成脚本一直画的还是改名前的画面，任何人重跑一次就覆盖回旧品牌。

### Fixed

- **`scripts/make-og.py` 会把 `docs/og.png` 覆盖回旧品牌**：该脚本是这张 1200×630 社交卡片的唯一生成器（README 顶部横幅与 Pages `og:image` 共用），但内部仍写着 `韭菜盒子 LeekBox` 与 `github.com/SuCriss/dsh-leekbox`。也就是说上一轮手工重做的图只是「改了产物、没改生成器」，下次有人跑 `python scripts/make-og.py` 就前功尽弃。整份重写为与 `docs/index.html` 同源的视觉：品牌文案（`TITLE` / `TITLE_EN` / `REPO` / `EYEBROW` / `CHIPS` / `MOCK_TABS` / `MOCK_ROWS` / `FOOT_NOTE`）全部提为顶部常量，配色对齐 `--brand:#6c8cff` / `--up:#f0424d` / `--down:#10b981` / `--bg:#0a0c12`，图标复用 `assets/icon.svg` 的 `M3 3v18h18` / `M18 17V9` / `M13 17V5` / `M8 17v-3` 同一组路径。
- **楔形色带**：背景高光原先用「`ImageDraw` 画填充椭圆 → `ImageFilter.GaussianBlur(130)` → `Image.composite`」，在极暗底色上出现两道巨大楔形斜线（对比增强 6× 后清晰可见）。根因是**8 位灰度遮罩做高斯模糊会产生等值带**，1–2 个色阶差在 #0a0c12 上就足以成线。改为 `add_radial_glow()` 按距离解析计算 smoothstep 权重逐像素混合，没有量化中间态，色带消失。
- **字体跨平台**：原来硬编码 `FONTS = Path("C:/Windows/Fonts")` 与 `msyhbd.ttc` 等文件名，非 Windows 直接崩。改为依次尝试 Windows / macOS / Noto 三处目录的候选字体，全都找不到时退化到 `ImageFont.load_default()`，不中断生成。

### Changed

- **README 两份的测试套件数对齐**（`README.md:281`、`README.en.md:278`）：`25 个套件（24 \`*-test.mjs\`）` → `26 个（25 个）`。上一版新增 `cache-name-test.mjs` 后忘了同步。两个有真实网络依赖、按 `CHANGELOG.md` 既定策略不进 CI 的套件（`screener-test.mjs`、`rank-fallback-test.mjs`）已核对确认是有意排除，不是遗漏。
- **删除 `.bench-tabs/`**：四个文件（两个 1440 宽基准页、一个 375 宽、一个生成脚本，约 188KB）是当时验收用的一次性产物，`gen.mjs` 自己第 2 行就写着「不是产物的一部分，验收完可直接删掉整个 `.bench-tabs` 目录」。内容还停在旧品牌（`<span class="lkb-logo">🥬</span>韭菜盒子`），且 `ICONS` 的 key 是 `star` 而 `TABS` 用 `watchlist`，自选页签图标渲染成字面量 `undefined`。已在 `.gitignore` 加一条防止再被提交。

### Notes

- 试过给背景加 Bayer 有序抖动来消除 8 位色阶台阶：并排对比（对比增强 2.0× / 亮度 1.6×）**反而更糟**——暗部出现横向噪点纹理，体积从 105kb 涨到 154kb。已放弃，并在脚本里写明原因。台阶本身只有二十几级、正常观看不可见；真正的修复是上面那条「解析式径向渐变替代高斯模糊遮罩」。

## [0.26.2] - 2026-11-13

一次面向"代码与文档都对不上"的收口。代码侧修掉一个**真实的、静默的**缓存缺陷，文档侧把 CHANGELOG 缺的 23 个版本段补齐、并把三份停在旧实现上的文档对齐到现状。

### Fixed

- **`cached()` 漏传 `name` 会让无关的取数链共用同一个缓存实例**：`lib/otc-fund.js` 的 `searchFundSuggest` 与 `fetchFundPositions` 调 `cached({...})` 时都没传 `name`。而 `cached()` 内部是 `registry.get(name) ?? createCache(name, { max })`，`name` 为 `undefined` 时**永远**走 `createCache(undefined)`——于是这两条完全无关的链路共用一个名为 `"undefined"` 的公共缓存：`max` 上限互相挤占、LRU 互相淘汰、命中率统计混在一起，`/api/leekbox/health` 的 `caches` 里只出现一个 `undefined` 键、根本看不出归属。已补 `name: "fundSuggest"` / `name: "fundPositions"`。
- **从源头加守卫**：`cached()` 入口判断 `typeof name !== "string" || name.trim() === ""` 就抛 `TypeError`（报错带 `key` 便于定位调用方）。用 `trim()` 而非 `=== ""`，因为纯空白 name 在 registry 里同样会成为一个看不出是谁的键。宁可当场炸，也不要静默退化。
- **指数页最后一处弹窗时代文案**：v0.22.0 已把窗口系统整体退役（改官方面板 + 右栏联动 + 钻取子页），`indices-tab.js` 的「点击指数卡片**可弹出详情窗口**（K线 · 前复权）」是全仓库最后一处用户可见的旧措辞，改为「点击指数卡片**查看详情**（K线 · 前复权）」。
- **`package-lock.json` 的 `name` 对齐**：改名时只改了 `package.json`，lock 文件顶层与 `packages[""]` 一直是 `dsh-leekbox-plus`。`npm ci` 不校验这个字段，所以从未暴露。

### Changed

- **CHANGELOG 补齐 23 个缺失版本段**（0.15.0–0.21.1）：上游自己就缺（`git show 1d47fb1:CHANGELOG.md` 只到 0.14.0），本 fork 一直延续这个缺口。素材逐个取自各 tag 区间的提交正文。0.20.0 如实注明「由 `cb77557` 直接写定版本号，未打 tag」。
- **`CONTRIBUTING.md` 整份重写**：标题与包名改现状；补 fork 说明指向 `NOTICE.md` 与 `lib/identity.js`；安装段落改 `%DSH_HOME%\profiles\web\node_modules\dsh-portfolio`；行 id 改 `portfolio`。**删掉一个根本不存在的端点**——原文让贡献者 `curl -X POST http://127.0.0.1:<gui-port>/dsh-market/restart`，代码里从来没有这条路由（`git grep` 只命中本文件与无人引用的上游遗留 `restart-helper.cjs`）。改为如实说明 `lib/*.js` 不会热重载进运行中的 DSH 进程、只刷新浏览器不够、路由会 401/404 且写入静默不落盘。
- **`docs/otc-fund.md` 补齐到五条路由**：新增 `otc-fund/search`（东财 `FundSearchAPI`，`m=1` 纯 JSON，缓存 5 分钟，只留 `CATEGORYDESC` 含「基金」的行否则股票会被误标，上限 20 条）与 `otc-fund/positions`（前十大重仓股，行情经 `deps.quoteProvider` 注入、港股给 `null` 不编造、取不到 502）；补 `order` 第四键与三条不变式、`action:"reorder"` 错误码表（400/409/501）、详情段从「浮窗」改「右栏联动 + 钻取子页」。
- **`DELIVERY.md` 标注为 v0.20.0 的交付记录而非当前版本说明**，并逐处补现值：套件数 24 → 26；行 id / bundle 名 / `health` 的 `plugin` 字段改成现值并注明当时旧名；重排重复的 §4 编号。

### Tests

- 新增 `cache-name-test.mjs`（14 项断言）两层兜底：**源码级扫描** `lib/*.js` + `src/client/*.js` + 根目录 `.mjs`（跳过构建产物与测试自身）里每一处 `cached({` 调用，读取顶层 `name` 值要求存在且非空非纯空白（实测 40 个文件 / 18 处调用）；**运行级**真调 `cached()`，无 `name` / 空串 / 纯空白 / 非字符串都抛，且 `routeCacheStats()` 里不得出现 `undefined` 键。
- 变异验证 4 处全部抓红（删任一 `name` → 各 2 红；改空串 / 纯空白 → 各 1 红）。过程中两次变异漏网又补强：初版只判断 `name` 键**是否存在**而不读值，空串漏网；判 `value === ""` 而非 `trim() === ""`，纯空白漏网。

## [0.26.1] - 2026-11-13

「拖拽排好的顺序重进页面又复原」的修复。用户报障后排查出两条独立原因：一条是宿主跑着旧服务端代码，一条是客户端**保存失败却装作成功**。

### Fixed

- **保存失败不再静默成功**：`table-sort.js` 的 `onDrop` 调用 `onReorder(ids)` 后没有检查返回结果，本地顺序（`setLocalOrder`）无论如何都生效——于是提交失败时界面照样显示新顺序，用户以为保存好了，下次进页面才发现复原。新增纯函数 `settleOrderCommit(outcome, onRollback)`：结果不是 thenable 时返回 `null`（无从判断，不假装回退），是 Promise 时成功不回退、失败回退并让调用方提示。
- **两条提交链路改为如实上报失败**：`watchlist-tab.js` 的 `commitOrder` 改为 `return api(API.watchlistReorder, ...)`（不再吞掉异常），`otc-fund-tab.js` 的 `commitFundOrder` 失败时先 `setMsg(...)` 再 `throw e`，让 `settleOrderCommit` 能看见失败。
- **文档写明服务端改动需重载宿主**：`lib/*.js` 改动必须重启 DSH 或触发 profile 重新组合，**只刷新浏览器不够**——浏览器拿到的仍是旧服务端（表现为 404/401 且写入不落盘）。这条排查结论已回写进 README 的「安装细节」与常见问题。

### Tests

- `sort-test.mjs` 增至 81 项：新增 `settleOrderCommit` 四条纯函数断言（成功不回退 / 失败回退 / 非 Promise 不回退 / `null` 不回退）与五条接线断言。变异验证 6 处全部抓红：自选不交 promise、自选吞失败、基金吞失败、drop 不回退、失败不回退、永远不检查结果。

## [0.26.0] - 2026-11-13

自选与基金两张表支持**点表头按列排序**与**拖拽行自定义顺序**，顺序持久化到服务端，重开页面仍在。

### Added

- **按列排序（`table-sort.js` / `table-sort-core.js`）**：`useTableSort(rows, getters, onReorder, idOf)` 返回 `{ sorted, sortKey, sortDir, toggleSort, dragProps, canDrag, dragging, overIndex }`。点表头走 **升序 → 降序 → 取消** 三态；`SortableTh` 输出 `aria-sort`、`▲/▼/⇅` 箭头、`tabIndex=0` 与 Enter/空格触发。自选 10 个可排序列（名称 / 现价 / 涨跌幅 / 持仓 / 成本 / 盈亏 / 昨收 / 今开 / 成交额 / 换手，最高·最低不参与），基金 6 个（基金 / 最新净值 / 盈亏 / 成本 / 份额 / 浮盈）。
- **拖拽自定义顺序**：HTML5 draggable + 本地 `localOrder` 让拖拽立即生效不回弹；`tr[data-dragging]` 半透明、`tr[data-dragover]` 顶部蓝线提示落点。**按列排序期间拖拽自动停用**（`canDrag = onReorder != null && sortKey === null`），并显示提示条「当前按「X」升序排列，拖拽自定义顺序已暂停；再点表头可取消排序」。
- **顺序持久化（服务端）**：新增 `POST /api/leekbox/watchlist/reorder`（`{ codes: [...] }`）与 `otc-fund/mutate` 的 `action: "reorder"`。**整份顺序提交**而非「移到某只前后」——客户端本就持有完整列表，整份提交幂等，重试 / 并发 / 拖拽中断都不留半截顺序。集合不一致回 **409**（自选「自选列表已变化，请刷新后重试」、基金「基金持仓已变化，请刷新后重试」），重复项回 400。
- **基金 order 是独立第四键**：`emptyOtcFund()` 增加 `order: []`。`holdings` 是字典，`Object.keys()` 对 `"161725"` 这类整数样式键按数值升序而非插入顺序，**不能靠字典顺序保存拖拽结果**。`upsertHolding` 追加末尾、`deleteHolding` 摘除、`normalizeOtcFund` 读时过滤脏 order，新增 `reorderHoldings(data, codes)`（非法 / 重复 / 长度不符 / 含不存在 code 一律返回 `null`）。snapshot 无显式 codes 时按 `order` 排序并补齐未列出的持仓，不丢行。
- **分组视图拖拽不破坏全局顺序**：`mergeSubsetOrder(fullItems, subsetOrder, idOf)` 把分组子集的相对顺序合并回完整列表再提交，否则在分组视图拖拽只提交子集会必 409。

### Tests

- 新增 `sort-test.mjs`（72 项 → 后续 81 项）：纯函数逐场景（升降取消、空值双向沉底、稳定性、中文拼音、`moveItem` 越界、`mergeSubsetOrder` 槽位语义）、**真调 `makeRoutes` handler** 的自选 reorder 路由测试（合法重排落盘、少一条/多一条→409、重复/非数组→400、GET 按自定义顺序返回）、**真调 store 纯函数**的基金 order 测试、以及用 esbuild + `test-react-stub.mjs` 打包后**真实调用组件函数**的渲染级断言。
- 新增 `test-react-stub.mjs`：极简 React 桩，供 esbuild alias 把 `react` 指过来。
- **测试抓到真 bug**：`sortRows` 原先把空值沉底写在 `compareValues` 里返回 ±1、再整体乘升降序符号，导致**降序时空值被翻到最上面**；改为在乘 `sign` 之前单独判定缺失值。
- 教训：只 grep 源码字符串的断言等于没测（删校验、写反顺序都能过）；改为真调 handler / store / 渲染组件后，11 类变异（空值反向、降序丢符号、不校验集合、409 改 200、`canDrag` 恒真恒假等）全部能被抓红。

## [0.25.0] - 2026-11-12

### Added

- **响应式适配（容器查询）**：此前只有 `clamp`/`vw` 的弹性宽度，没有断点——窄窗下右栏固定占 320px+ 会把列表挤扁，宽表还会被 `overflow-x:hidden` 裁掉。现在按**面板实际宽度**（`container-type:inline-size` + 具名 `lkbpage`）分三档，比媒体查询准确，因为面板宽度取决于侧栏折叠状态：
  - `≥1080px`：宽屏现状（右栏 36% 并排）。
  - `860–1080px`：右栏收窄到 `clamp(280px,32%,360px)`，页面留白与页签间距收紧。
  - `<860px`：右栏改为**覆盖式抽屉**（绝对定位浮在列表之上，不挤占布局宽度），页签只留图标，宽表可横向滚动（`overflow-x:auto` + 表格 `min-width`）。
  - `<640px`：抽屉全宽、标题缩小。
- 浮窗与悬停预览是 `fixed` 层，按视口收窄：`≤900px` 宽 360/340px，`≤600px` 宽 300px 且限高。
- 抽屉模式仍可用 ✕ 与 ESC 关闭（既有 `escTarget` 层级不变）。

## [0.24.0] - 2026-11-12

### Added

- **悬停预览浮窗**：鼠标悬停在任意股票/基金行上（自选、行情、选股、大盘、场外基金五个列表）停留约 380ms 即弹出轻量预览浮窗，**移开自动收起**。设计要点：
  - **延迟出现**（380ms）——快速扫表不会满屏闪烁；**移开宽限**（160ms）——指针从行移到浮窗上时不至于立刻消失（浮窗可交互，可点关闭）。
  - **单例**：同一时刻只有一个预览，切行即换内容，不叠窗。
  - **智能定位**：优先贴在行的右侧，右边放不下翻到左侧，最终夹回视口（纯函数 `previewPosition`，便于对照测试）。
  - **最轻内容档**：新增 `variant: "preview"`（报价 + 分时/日K 两档 + 精简统计），不渲染操作行/持仓卡，也**不发资金流/F10 请求**——鼠标扫过不该打一串上游。
  - 键盘可达：行获得焦点同样触发预览（`previewHandlers` 提供 focus/blur）。
- 接线集中在 `core.js` 的 `rowHover(row)` 与 `hover-preview.js`，五个列表各铺一行即可；测试断言"每个列表都接上了"，漏一个就变红。

## [0.23.0] - 2026-11-12

### Fixed

- **侧栏「持仓看板」入口消失、面板打不开（0.22.0 回归）**：根因是客户端 `inject` 声明为空数组——`ctx.slots` 只有在 `inject` 里声明 `'slots'` 后才会注入到 `apply` 的 ctx 上，于是 `ctx.slots.inject(...)` 抛 TypeError、被 `try/catch` 静默吞掉，**两个 slot 注册都没发生**，表现就是侧栏没有入口行、面板无从打开。修复为 `inject = ["slots"]`（与官方模板 `templates/decoration/client.js`、`dsh-armory` 的 `inject = ['slots', ...]` 一致）。
- **注册失败不再静默**：`apply` 里先显式探活 `ctx.slots`，缺失时 `console.error` 给出可诊断信息（此前只有一个笼统的 `console.warn`）；slot 注册单独 `try/catch`，不再连带吞掉预警看护/时钟的挂载。
- **测试盲区**：`client-bundle-test.mjs` 之前给 `apply` 塞了 `ctx.slots` 桩，恰好掩盖了 `inject` 漏声明。新增断言「`inject` 必须声明 `slots`」与「注册失败必须可见」，两条都做过变异验证（改坏必红）。

### Added

- **方向 A 叠加：浮窗并排对比**。右栏联动（方向 C）之外，右栏头部新增 **⧉ 钉浮窗**：把当前标的钉成可拖拽浮窗，多只并排对比（与弹窗时代的多窗对比同一用法）。浮窗复用右栏的紧凑内容组件（`variant: "rail"`），不重复实现；同码重复钉只置顶不重开；pointer 拖拽 + 视口夹取，避免拖出屏幕。完整分析仍在右栏 / ⤢ 钻取子页。

## [0.22.0] - 2026-11-12

「弹窗 → 页面」整体迁移（设计方向 C·主从联动 + B·钻取子页，设计稿经确认后实施）。面板不再是全屏遮罩弹窗，而是 DSH 主区域的原生面板页面。

### Changed

- **面板页面化**：`PortfolioPanel` 弹窗（遮罩 + 居中卡片 + 拖拽 + ✕ 关闭）迁移为 `PortfolioPage` 页面，由宿主经官方 **`main` slot** 挂载。页头（logo + 标题 + 交易时段状态 + ⚙ 设置）、7 页签、免责声明页脚原样保留，内容区从 640px 固定卡片变为**主列全高**（同屏信息量约 +45%）。拖拽移动 / 双击复位 / ESC 关面板三个弹窗专属交互删除。
- **侧栏入口官方化**：手搓 DOM 注入的 sidebar.js（cloneNode 复刻原生行 + MutationObserver 补挂的整套补丁）退役，改为注册 **`sidebar.panellist`**（图标组件 `PanelIcon`，尺寸随宿主 size 参数 16/18）。入口成为完全原生的面板行：随菜单整体滚动、获得选中态 / 折叠栏 / 固定 / 更多菜单，与「插件」「大肥鱼军械库」同一套机制——「不随整体滚动、单独显示」的根因就此消除。
- **详情形态重做为右栏联动（方向 C）**：点个股/基金行 → **右侧详情栏**即时切换（不再是开浮窗）。右栏紧凑版含大字报价、6 档周期分时/K 线（分时默认）、行情统计、**我的持仓卡**（股数/成本内联编辑、持仓盈亏、预警摘要）；操作行 = ☆ 加自选 / 🔔 价格预警（复用自选页 AlertForm）/ ⤢ 打开完整详情。
- **⤢ 打开完整详情 → 钻取子页（方向 B）**：整页详情（面包屑「‹ 返回」）展示完整 13 档周期 + 资金流图/明细表 + F10 财务摘要；右栏紧凑版不发资金流/F10 请求（variant 门控）。ESC 层级 = 先退子页、再收右栏、无则不动作（纯函数 `escTarget`，替代旧 `topWindow` 窗口栈判定），输入框内 ESC 不劫持。
- 基金详情同套变体：右栏 = 净值区 / 净值走势（6 区间）/ 我的持仓；子页再加阶段涨幅与最新披露前十大重仓股。

### Removed

- **窗口系统整体退役**：`wins` 数组 / z 序 / 拖拽 / 挂载后视口夹取 / `mountPanel` 自挂 createRoot、`.lkb_overlay` / `.lkb_card` / `.lkb-win` 三个浮层类及其暗色规则。多窗同屏对比能力随设计确认（方向 C）移除。
- 侧边栏 DOM 注入（sidebar.js）与 `.lkb_entry*` 样式族。

### Tests

- `client-bundle-test.mjs` 锚点随契约重写：slot 注册断言（main + sidebar.panellist，apply 桩上验证两个 register 真实发出）、DetailRail / SubDetail / escTarget / 持仓卡接线、窗口系统退役否证（setWins/topWindow/mountPanel 不得复活）；`p2-silent-fixes-test.mjs` 的「ESC 关置顶窗口」段改为 escTarget 层级断言。24/24 套件通过，新锚点做过变异验证（改坏必红、还原必绿）。

## [0.21.1] - 2026-11-12

修掉侧栏入口行"不随菜单滚动、单独显示"的挂载位置错误。

### Fixed

- **侧栏入口行挂进面板导航列表**（`src/client/sidebar.js`）：此前用 `cloneNode` 复刻原生行后插在 sidebar 根节点下、`nav.panelList` **外面**（即固定区），于是它不参与菜单组的滚动与选中态。改为插进 `[data-sidebar-scrollport]` 内的 `nav[class*="panelList"]` 作为首个子元素，随菜单整体滚动并归组；清理 `aria-haspopup` / `aria-expanded` / `aria-current` / `aria-describedby` 等从原生行抄来但语义不符的属性。兜底行几何同步到当前 DSH 版本（`min-height:32px`、`padding:5px 9px`、`gap:6px`）。

### Tests

- `client-bundle-test.mjs` 侧栏段重写为新契约，并做变异验证（改坏锚点必红、还原必绿）。

## [0.21.0] - 2026-11-09

版本号在 0.20.0 之后积压了 13 个提交未升，本版一并定版。这一段的主线是**场外基金从"能看"到"能加、能看详情"**，外加一轮 K 线详情的可用性修补。

### Added

- **基金详情浮窗**（`src/client/fund-detail.js`，新增）：点基金行打开，与股票详情同一套窗口 chrome（可拖拽、层级递增、✕ 关闭）。内容：单位净值 / 日涨幅 / 披露状态 / 净值日期、阶段涨幅（近 1·3·6 月、1·3 年、区间以来）、净值走势（可切区间，叠加成本线）、我的持仓、最新披露前十大重仓股（含实时涨跌；港股无行情显示 `—` 不编造）。
- **添加基金改为「搜索 → 详情 → 加入」**：删除「＋ 添加基金」按钮与 `AddFundForm`；行情页搜索合并东财基金搜索结果，点基金条开详情浮窗，右上「加入基金 / 移出基金」与股票「加自选」同位同形。
- **K 线周期行对齐雪球**：分时 / 五日 / 日K / 周K / 月K / 季K / 年K / 120分 / 60分 / 30分 / 15分 / 5分 / 1分，共 13 档。语义修正：腾讯 `mkline` 的 `m1` 是**1 分钟 K**而不是分时，此前两者共用 `m1` 一个键；现在分时走独立 `today` 键（`/minute/query`）。

### Changed

- **详情窗开屏即居中**：去掉按固定 620px 估算高度再加 `k*28` 的错开偏移（窗口实际高度随内容浮动，常压出可视区），改为纯居中，并在挂载后按**实际尺寸**夹回视口内（只跑一次，不影响拖动）。`.lkb-win` 高度封顶 `max-height:min(88vh,760px)`。

### Fixed

- **基金持仓「永远取不到」**：根因是 **User-Agent**，不是限流——`fundmobapi.eastmoney.com` 对桌面 Chrome UA 一律返回 `ErrCode 61136403`「网络繁忙」，看起来像接口下线；实测换任意非桌面 UA（移动端 / 裸 `Mozilla/5.0` / 空）都稳定返回 10 条。新增 `MOBILE_UA`（iPhone Safari）显式用于两个 fundmobapi 调用。顺带修掉 `agent: UA` 这个键名写错的地方（`fetch-utils` 只认 `user-agent`，那条"净值兜底源"此前从未生效过）。另修 positions 路由把 `fetchTencentQuotes` 返回的**数组**当 Map 用导致现价/涨跌幅全空。
- **详情窗底部内容被裁**：flex 子项默认 `min-height:auto`，`.lkb_body` 虽写了 `overflow-y:auto;flex:1` 仍会被内容撑高不肯收缩，父级 `overflow:hidden` 直接裁掉且不出滚动条。`.lkb_body` 加 `min-height:0`、`.lkb-fundBody` 加 `flex:1;min-height:0`。
- **周期按钮被挤断字**（"分\n时"）：13 档与标题挤在 `space-between` 一行，标题过长就把按钮压到换行。`.lkb-chartTitle` 允许换行、标题超长省略；`.lkb-periodRow` 整体换行并靠右；`.lkb-period` 加 `white-space:nowrap`。
- **ⓘ 悬停图标在 DSH Desktop 的 webview 里不显示**（原生 `title` 提示不生效），按要求删除图标，标题只留短词（「当日分时」/「K线」/「净值走势」），连同 `.lkb-infoIcon` 样式与 26 条无引用的 CSS 一起清理。

### Tests

- `p1-f10-longhu-test.mjs` **根治日期脆性**：fixture 原钉死在 2026-10-08/09，过期后「不传 date」的用例回溯不到数据、返回 502 假失败，长期挂在 `KNOWN_UPSTREAM_RED` 里。改为按 `cnDateStr()` 相对推算（`shiftDays()` 走 UTC 日历算术，不受宿主机时区影响），并**清空 `KNOWN_UPSTREAM_RED` 名单**（机制保留）。
- `p2-silent-fixes-test.mjs` **消除时区依赖**：原断言 `new Date(y,m,d,...)` 造本地时间、在 UTC 机器上面日期恰好相等，GitHub Actions（跑在 UTC）必然假失败。改为两条时区无关断言（行为：`todayDateStr` 必须等于本地年月日；实现：产物里不得出现 `toISOString`/`getUTC*`），UTC / Asia/Hong_Kong / America/New_York 三时区实测一致。

## [0.20.0] - 2026-11-03

> 本版由 `cb77557` 直接写定版本号，**未打 tag**。

**整体更名为「持仓看板 / dsh-portfolio」**，并在同一插件内新增**场外基金**子系统——一个插件、一套安装、一个入口，同时覆盖场内（股票 / ETF / 可转债 / LOF）与场外基金。

### Added

- **场外基金模块**（详见 `docs/otc-fund.md`）：`GET /api/leekbox/otc-fund/snapshot`（净值/估值、盈亏百分比、浮盈、成本、份额、距成本线、解套需涨）、`POST /api/leekbox/otc-fund/mutate`（`upsert` / `delete`）。持久化 `$DSH_HOME/.leekbox-otc-fund.json`，原子写 + 写锁。披露窗口分段轮询：18:00–20:00 每 30 分、20:00–23:00 每 5–10 分随机、23:00–01:00 每 15 分、01:00–06:00 每 60 分（跨零点窗口按半开区间逐分钟判定）。
- 「基金」标签页：表格化，与自选 / 行情页同一套样式；汇总条与自选页同构（市值 / 成本 / 浮动盈亏 / 收益率）；成本与份额点单元格内联编辑。
- 侧栏图标改为线框柱状图 SVG（`currentColor`，与 DSH 原生图标对齐）。

### Changed

- 汇总口径「不知道就说不知道」：部分持仓取不到净值时给 `null` 而不是部分和，空持仓才是 `0`。
- 包名 `dsh-portfolio`、显示名「持仓看板」、插件行 id `portfolio`；内部标识（`/api/leekbox/*` 路由前缀、`.leekbox-*.json` 文件名、`lkb_` CSS 前缀）**刻意保留旧名**，理由见 `lib/identity.js`。

## [0.19.5] - 2026-10-28

### Fixed

- **搜索未命中时兜底到东财 suggest**：新增 `emSuggest()` 复用东财 searchadapter 的映射逻辑。`/search` 在本地索引查无结果时补两级兜底——纯字母走腾讯 smartbox 全拼，其余（或仍无结果）走东财 suggest。修掉纯数字代码查询（如新上市创业板 `301479`）在 6 小时索引快照未刷新期间**永远返回空且不走兜底**的问题；冷启动分支改用 `emSuggest` 复用，行为不变。

## [0.19.4] - 2026-10-27

### Changed

- **可发现性优化**（`dc4ac6d`）：README / npm 元数据 / 落地页 / 市场清单做一轮对齐，补齐 `robots.txt` 与 `sitemap.xml`（单页站点，显式声明可抓取），市场清单文案与线上条目对齐（含 tarball、13 信号 / 7 策略）。
- 版本号此前已随 `chore: bump version to 0.19.4` 先行推进，本段为其余三项文档提交。

## [0.19.3] - 2026-10-23

### Fixed

- **「右上角全天显示休市」**（`lib/calendar.js`）：两个根因叠加。语义错——日历用上证指数日 K 反推交易日，而日线只包含**已经出现过**的交易日（今天那根要到集合竞价前后才有，实测 09:05 没有、09:23 有了），旧实现把「今天的日线还没出」和「今天休市」混为一件事；缓存错——`ensureCalendar` 是 12 小时 TTL，09:05 建好的那份（不含今天）会一直用到当晚 21:05。改法：把「覆盖窗口内缺失」与「右边界之外还不知道」分开，按可信度排序判定（今天有日线 → 交易日；落在已发布序列覆盖窗口内却没有那根 → 确定休市；今天在窗口右侧 → 用 5 分钟线探测今天有没有分时）。

## [0.19.2] - 2026-10-15

### Fixed

- **快讯关联股票标签裸奔**：补齐缺失的 `.lkb-newsStock` 样式（原类名无对应 CSS），改为名称主文案 + 代码胶囊 + 右上跳转箭头，悬停转主色并补深色模式；移除无引用的 `.lkb-stockChip` 死样式。

## [0.19.1] - 2026-10-14

### Changed

- **首轮分析改分节输出并放开篇幅**：「AI 分析内容偏少」的根因不是数据给少了（六路数据已 544 字符），而是输出约束没跟上——「全文 400 字以内」来自最初只有三路数据的版本，数据加到七路后每个维度只剩 60 来字，模型只能各写一句就收尾。改为六个固定小节（价量概况 / 资金面 / 基本面与估值 / 板块与消息 / 风险提示 / 倾向），篇幅 400 → 800–1200 字，缺数据的小节要求明写「该项数据未取到」并说明影响；追问 200 → 400 字。`ANALYSIS_MAX_TOKENS` 2048 → 4096（三协议共用；实测 1202 字输出 = completion_tokens 1730，其中 925 是 reasoning_tokens）。顺带修掉一个结构 bug：六个小节原先与规则放在同一数组一起 `map`，被编成 `2)~7)`，抽出 `renderNumberedRules` 把子列表插在第 1 条之后、不参与编号。

## [0.19.0] - 2026-10-14

### Added

- **分析上下文补数据源**：把早就存在但没接进 prompt 的接口全部并入——主力资金（近 5 日净流入 + 连续方向）、龙虎榜（净买额 / 买卖额 / 上榜原因）、相关新闻（三源合并 + 相关性筛选）、板块环境（本股行业 + 领涨 / 领跌参照）。七路并发、各自降级，任一路失败不阻塞分析。
- **K 线窗口可配**（3 月 / 半年 / 1 年），窗口透传到服务端；窗口够长时补 MA60 / MA120 / 区间分位——60 根下这些算不出，宁可不给也不给误导性值。切换窗口与生成时不一致会提示需重新生成。
- **分析支持追问**。

### Changed

- 新闻是外部不可信文本，处理分两层：结构清洗（去控制字符、折叠换行、截断 120 字）+ system prompt 声明其地位。**不做关键词黑名单**——既挡不住真注入，又会误杀正常新闻。
- 新浪 `ext.stocks` 会误挂标签（一条讲东盟矿物的新闻因正文出现"投资"就挂了某 ETF 代码），改为分级评分 + 阈值 3（名称命中才算数），标签单独出现不采纳。

## [0.18.1] - 2026-10-14

### Changed

- **个股分析改为流式输出**：点「开始分析」走 SSE，服务端新增 `/analysis/analyze/stream`，`llmStream` 用 `curl -N` 实时读 LLM 增量并经 SSE 转发，前端 `fetch` 流式读取逐字追加。支持 OpenAI chat / OpenAI Responses / Anthropic 三种协议的流式增量解析。

## [0.18.0] - 2026-10-14

### Added

- **全局设置新增主题**：跟随系统 / 浅色 / 深色三档，与 AI 模型配置分区。持久化在 `localStorage`（键 `leekbox-theme`），切换 `body` 的 `data-ds-dark-theme` 属性即时生效；`system` 模式下监听系统主题变化。

## [0.17.5] - 2026-10-14

### Added

- **协议新增 OpenAI Responses API**（`/v1/responses`）：system 合并为 `instructions`、user 合并为 `input`，输出解析 `output` 里 message 的 `output_text` 块。服务端 `callResponses` + `normApi` 三协议归一化（`openai` / `responses` / `anthropic`）。

## [0.17.4] - 2026-10-14

### Added

- **全局设置新增「API 协议」下拉**：OpenAI 兼容（`/chat/completions`）或 Anthropic 原生（`/v1/messages`）。切服务商时自动填，但可手动改（例如自定义地址 + Anthropic 协议）。

## [0.17.3] - 2026-10-14

### Fixed

- **「获取模型」永远卡在「获取中」**：`settings.js` 里协议 state 变量名 `api` **遮蔽**了从 `core.js` 导入的 `api()` 请求函数，`fetchModels` 里 `api(...)` 实际调用的是字符串、同步抛 `TypeError`，而 `.finally(setFetching(false))` 永不执行，按钮永远转圈。改名 `protocol`。另加双保险：前端 `api()` 加 120s 超时（`AbortController`），服务端 `llmHttp` 加 Node 侧兜底强杀挂起的 `curl`。

## [0.17.2] - 2026-10-14

### Fixed

- **LLM 请求改走系统 `curl` 绕过 TLS 指纹拦截**：部分第三方聚合网关（nginx 反代 + WAF）按 TLS 指纹拦截 Node/OpenSSL 连接（直接 `ECONNRESET`），却放行 `curl` 的 Schannel TLS，导致「获取模型」与个股分析对这类网关完全不可用。新增 `llmHttp`：经 `spawn curl.exe` 发出（`-w` 取状态码、`--data-binary @-` 走 stdin），`callOpenai` / `callAnthropic` / `listLlmModels` 全部改用。

## [0.17.1] - 2026-10-14

### Added

- **兼容 Anthropic Claude 原生协议**：服务端 `callLlm` 拆分为 `callOpenai` + `callAnthropic`（走 `/v1/messages` + `x-api-key` + `anthropic-version`，`system` 单独提出、`content` 多个 text 块拼接），`listLlmModels` 同步支持 `/v1/models`。配置增加 `api` 字段（`openai` | `anthropic`，旧配置默认 `openai` 向后兼容）。

## [0.17.0] - 2026-10-13

### Added

- **模型多服务商下拉 + 动态获取模型列表**：设置弹窗改为「服务商下拉 → 自动填 API 地址 → 模型下拉（`datalist` 可下拉可手填）→ 一键获取模型」。覆盖 DeepSeek / OpenAI / Kimi / 智谱 / 通义 / b.ai 等 OpenAI 兼容服务商，不是只能 OpenAI 一家。服务端新增 `POST /api/leekbox/analysis/models`：调 `GET {baseUrl}/models` 拉真实模型列表（去重、上限 200、超时与错误转中文文案）。

## [0.16.2] - 2026-10-13

### Changed

- **模型配置从「分析」页签拆到全局设置**：新增 `settings.js` 全局设置弹窗；`core.js` 加订阅式配置单例（`loadAnalysisConfig` / `saveAnalysisConfig` / `useAnalysisConfig`），面板与分析页共享同一份状态。面板头部新增 ⚙️ 入口，设置弹窗 z 序高于详情窗、低于确认遮罩与 toast。分析页移除配置卡片，只留选股分析；未配置时「开始分析」变为「去配置模型」。

## [0.16.1] - 2026-10-13

### Added

- **分析结果支持「复制」与「重新生成」**：复制走 clipboard API + `execCommand` 兜底。

## [0.16.0] - 2026-10-13

### Added

- **新增「分析」页签**：可配置 OpenAI 兼容模型（API 地址 / 密钥 / 模型名），选股后用服务端汇总的行情 / K 线 / 财报数据调用模型生成个股分析。服务端新增 `/api/leekbox/analysis/config`（GET 读 / POST 存，密钥脱敏）与 `/api/leekbox/analysis/analyze`（汇总个股数据并调模型）。配置持久化到 `.leekbox-analysis.json`，密钥明文只在服务端落盘、绝不下发。

## [0.15.2] - 2026-10-13

### Fixed

- **K 线详情弹窗层级**：详情窗置顶于主面板卡片之上（此前被卡片盖住）。

## [0.15.1] - 2026-10-13

仅版本号推进（无功能改动）。

## [0.15.0] - 2026-10-13

### Added

- **量化因子选股**：新增 35 个量化因子（26 个布尔因子 + 9 个数值因子）、7 个因子分组（价格位置 / 动量指标 / 波动率 / 成交量 / 形态识别 / TD 序列 / VWAP）、5 个预设组合（趋势跟踪 / 超卖反弹 / 突破形态 / 均值回归 / 强势动量）。新增技术指标 ATR、TD 序列、蜡烛形态识别、VWAP。前端新增「量化因子」选股模式（因子选择 + 预设组合），后端筛选引擎支持 `factor` 模式（因子匹配与评分）。

### Fixed

- 因子模式参数验证：`factorPresets` 改用 `FACTOR_PRESETS` 而非 `FACTOR_META`；新增 `factorRequire` 校验确保单因子 key 有效。

## [0.14.0] - 2026-10-11

### Added

- **事件驱动选股扩展覆盖面**：新闻无关联股票时按热点关键词兜底——正文匹配当日涨幅靠前的概念板块名（东财），命中则取该板块涨幅前 5 的成分股作为关联股票。新增 `fetchBoardConstituents()`（emrank.js，`fs=b:BKxxxx`）；事件返回带 `via: news|board` 与 `board` 板块名；前端热点行显示板块标签 chip。限流保护：最多匹配 12 条新闻 / 6 个板块成分、行情批量 50 只；板块源不可用时安静降级为仅直接热点。

## [0.13.1] - 2026-10-11

### Changed

- **事件驱动选股重做为主题热点驱动**：上一版误实现为「技术形态事件」（涨停/跌停/连板等），本版按需求改为**时事热点新闻驱动选股**——抓取 7×24 财经快讯（新浪/东财/金十），筛出带关联股票的新闻（新浪源 `ext.stocks`），重要新闻优先，批量补实时行情，前端以「热点列表 → 点热点展开关联股票」呈现。
- 新增接口 `GET /api/leekbox/screener/events`（复用 NEWS_FETCHERS/mergeNews，45s TTL 缓存 + 单飞）；移除上一版 `signals.js` 的 EVENT_META/boardOf/limitPctFor/computeEvents/eventHits 及 validate/screener/cache 中的 `mode=event` 分支，恢复为 standard/multi 两条原流水线。

## [0.13.0] - 2026-10-11

### Added

- **事件驱动策略选股**：选股页新增第三模式「事件驱动」，捕捉当日发生的具体短线事件（而非指标状态）。事件由日K（OHLCV）实时计算，**按板块区分涨跌停幅度**：主板 10%、创业板/科创板 20%、北交所 30%、主板 ST 5%。共 10 个事件：涨停、跌停、连板、一字板、地天板、跳空高开、放量突破、创20日新高、缩量回踩、冲高回落。个股至少命中设定数量的事件才入选，按命中事件数排序。
- 服务端 `signals.js` 新增 `EVENT_META`、`boardOf()`、`limitPctFor()`、`computeEvents()`、`eventHits()`；`screenerMeta()` 下发 `events`；`screener-validate.js` 支持 `mode=event` + `events`/`minEventHits` 校验；结果缓存键纳入事件参数，避免不同事件组合互相穿透。

## [0.12.3] - 2026-10-11

### Fixed

- **根治切 tab 页面闪动**：此前只是加了淡入动画，未解决根因——面板卡片无固定高度，切页签时整块窗口随内容「空态 → 满载」伸缩。现在 `.lkb_card` 固定 `height:min(640px,88vh)`，窗口框架不再抖动，内容区在固定框架内滚动；大盘页（默认首页）加载中渲染 4 张 shimmer 骨架卡片（复用 `lkb-shimmer`），消除空态塌陷；动画改为纯淡入（去掉 translateY 位移、时长 160ms）。均尊重 `prefers-reduced-motion`。

## [0.12.2] - 2026-10-11

### Changed

- **tab 切换动效优化**：修复切页签时页面「抖动」——正文切换改为淡入 + 6px 上浮入场动画（`.lkb_tabPanelIn`，仅 transform/opacity，GPU 合成不触发重排）；`.lkb_body` 用 `scrollbar-gutter: stable` 让滚动条槽位常驻、`overflow-x: hidden` 防横向滚动条，切换时内容不再左右横跳。均尊重 `prefers-reduced-motion`。

## [0.12.1] - 2026-10-11

### Changed

- **标签栏美化**：五个页签（大盘 / 行情 / 自选 / 选股 / 快讯）的分段控件重新打磨——轨道圆角与内阴影、选中项品牌色光晕与描边、图标透明度过渡（不缩放、不位移）、徽标光晕，暗色模式同步对齐。保留并完善 SVG 图标、`role="tablist"`/`role="tab"`/`aria-selected` 无障碍语义、←/→/Home/End 键盘导航与自选数量徽标。

## [0.12.0] - 2026-10-10

第二批"静默失败"专项：六个缺陷的共同点是**不抛异常、不报错**——只是悄悄给出错误的结果，或者悄悄什么都不做。所以修复的重点不是"让它能跑"，而是"让它出错时说得出来"。

### Fixed

- **`/longhu?date=` 参数被完全忽略**（最严重）：路由从不读 `date`，永远拿"今天"去打上游。于是接口文档承诺的"查历史某天龙虎榜"根本不存在，而且盘中和周末请求会拿到空榜单——因为当天的榜要等收盘后晚间才发布。现在 `date` 是**回溯起点**：`fetchEmLonghu` 从该日起往前找最近有榜的交易日（遇到周末跳过，因为周末不可能有榜），响应回带 `requestedDate` 与实际的 `date`。解析用新增的 `parseDateOnly()`，它拒绝 `2026-02-30`、`2026-13-01` 这类会被 `Date` 静默进位的假日期，非法输入直接 400 而不是悄悄换成今天——"静默返回另一天的数据"正是这一批要消灭的缺陷类型。
- **回溯改成"只往过去"**：起点之后即使有数据也不取用。往前找会把未来日期的榜单当成用户请求的那天，语义上更糟。同时加了 15s 总预算（`budgetMs`）：此前最坏情况是 8 天 × 2 轮 × 2 个 host × 8s 超时，可以拖到几分钟。
- **资金流柱状图的悬停是死代码**：`FflowChart` 只有容器的 `onMouseLeave`，没有任何 setter 写过 `hover`，于是高亮下标 `hi` 恒为 `-1`——变暗、高亮、当日净流入读数**全部**永远不生效。现在每根柱子有 `onMouseEnter`，下标做 clamp，并在未悬停时给一句占位提示（而不是让读数行整块消失导致布局跳动）。
- **快讯 60 秒自动刷新会静默丢掉翻出来的页**：轮询恒取第 1 页并**替换**整个列表，但页码仍停在 3——于是"加载更多"从第 4 页继续，第 2、3 页永久缺失且用户毫无察觉。现在按已翻到的页号用 `loadThrough()` 重新取满（跨页去重，因为上游每次请求都会重新合并、页与页之间会漂移），并在切源时重置。
- **ESC / 点遮罩关错窗口**：`closeTopWin` 用 `slice(0, -1)` 关**数组末位**，而 `wins` 是插入顺序、`z` 由 `focusWin` 递增分配——用户点过别的窗口后，末位就不再是视觉上最上面的那个，于是关掉的是被压在底下的窗。现在按 `z` 最大值取（`topWindow()`，纯函数、模块作用域、可测试），ESC 与遮罩两个入口都走它。
- **用户主动点击的写操作失败时一声不吭**：星标、加/移自选、改分组、删预警失败后图标纹丝不动，用户以为已经生效。新增 `notifyFailure(what)`（走与价格预警同一条 toast 通道），接到这些入口上。**范围是刻意的**：后台轮询、预热、以及 F10/资金流这类可选增强的首次加载仍然保持安静——那些失败不该骚扰用户。
- **F10 / 资金流失败后整块消失**：现在保留标题、显示原因，并给一个"重试"按钮，而不是让用户对着空白猜。

### Added

- **K 线右侧价格刻度**：K 线此前**完全没有纵轴**（分时图有），用户无法从图上读出价位。新增纯函数 `priceAxisTicks()` 生成刻度（便于数值对照测试），并修正了命中判定——它原本除以整个 viewBox 宽度而不是绘图带宽度，最右侧一根会误判。刻度文字走 HTML 浮层（复用分时图的 `.lkb-maxis`）而不是 SVG 文本：`preserveAspectRatio="none"` 会把 SVG 文本横向拉伸。顺带确认 y 方向本来就是等比的（`svg` 高度恒等于 viewBox 高度），不是缺陷。
- **龙虎榜日期选择器**：服务端现在真的支持 `?date=`，界面上必须能选到它，否则这个能力等于不存在。请求日与显示日不同时明确提示"（2026-10-09 尚未发布，已回溯到最近交易日）"。日期上限用新增的 `todayDateStr()`（本机时区）而不是 `toISOString()`——后者按 UTC 取日期，北京时间清晨会让"今天"这个选项消失。

### Tests

- 新增 `p2-silent-fixes-test.mjs`（无网络）：`parseDateOnly` 拒绝假日期、路由以请求日期为首个上游查询、只往过去回溯、周末不进上游、400 文案；`priceAxisTicks` 的端点/单调性/退化区间（`min === max` 不产生 NaN、`count=1` 不除零）；K 线轴与命中判定的接线；`FflowChart` 悬停接线与 clamp；`loadThrough` 的页号保留与去重；`topWindow` 的 z 选择（含缺 `z`、并列、空列表）；四处用户操作确实接了 `notifyFailure`；日期选择器真的把 `lhQuery` 发给了服务端、失败时清掉旧行旧日期；`todayDateStr` 的本地日期语义。
- 上述断言逐条做过**变异验证**：把每个修复临时还原，确认测试会失败（而不是恒真）。
- `client-bundle-test.mjs` 补第 6 节：**14 个客户端模块的导入/导出必须配对**。这条是踩坑后补的——`lib/client.js` 是提交进仓库的产物，而 esbuild 构建失败时**不会覆盖产物**，于是"重建后产物哈希不变"会被误读成"构建成功且幂等"。当时 `detail.js` 重建后漏了 `StockDetailWindow` 的 `export`，构建一直在报错，产物却看起来"稳定"。现在直接检查配对，并按文件名+符号名报错。
- `p1-f10-longhu-test.mjs` 第 3 节重写：断言首个上游请求带的是**请求日期**（此前完全没断言，所以缺陷能一直躺着）、只往过去回溯、非法日期 400。
- `npm test` 18 → 19 个套件。

## [0.11.0] - 2026-10-10

第一批"地基"改进：交易日历、上游请求治理、写接口加固，以及两个功能性缺陷修复。

### Added

- **交易日历与交易时段（`lib/calendar.js` + `GET /api/leekbox/calendar`）**：交易日不再用"周一~周五"猜——国庆/春节这类工作日假期此前被显示成"交易中"并整天重复打上游。真值来源不需要新接口：**指数日 K 的日期序列本身就是交易日序列**（节假日没有 K 线），`fetchEmDailyKline("sh000001", {lmt:60})` 取 60 根推导，缓存 12 小时。`sessionState()` 给出 `preOpen / auction(9:15–9:25) / open / lunch / closed / weekend / holiday`，时刻一律按**东八区**判定（宿主机时区不参与 —— 用户在 UTC 机器上跑插件时结论必须一样）。首次请求**不阻塞**：先用工作日启发式回答、`source: "weekday-fallback"` 如实标注，后台把真日历建好（单飞）后再切换。`/health` 与 `/sentiment` 顺带回带时段摘要。
- **路由级缓存 + 单飞（`lib/route-cache.js`）**：`/quote` `/indices` `/minute` `/kline` `/rank` `/sector` `/fflow` `/f10` `/longhu` `/news` `/sentiment` 此前**每次请求都直打上游**，而客户端是 15~60s 轮询、多开详情窗还会并发同码请求 —— 重复请求不只是浪费，它会主动触发东财按出口 IP 的限流（项目自己记过这件事）。现在统一套 `cached()`：TTL 命中、**单飞**（并发同 key 共享一个上游调用，这是缓存挡不住的那一层）、**stale-if-error**（上游抖动时给上次成功值：榜单 10 分钟 / 历史 K 线 30 分钟 / F10 24 小时 / 快讯 30 分钟），失败照旧抛出、绝不写入"空快照"。TTL 支持按交易时段放宽（`sessionTtl`，默认 ×20），盘后与节假日的无效请求随之消失。顺带删掉两处手写 LRU（`/f10`、`/longhu`），它们都没有单飞。
- **`GET /api/leekbox/metrics`**：版本 / uptime / 时段状态 / 索引状态 / 各缓存的 size·hits·misses·stores·evictions·staleServes·hitRate。`/health` 也带上版本号与同一份缓存统计——以前只有自选与预警两个计数，"跑的是哪一版""到底在限流还是源挂了"都查不出来。

### Changed

- **写接口跨站加固**：回环栅栏只看 socket 与 Host，挡不住浏览器发起的跨站请求 —— 恶意页面 `fetch(..., {mode:"no-cors", body:"{...}"})` 打本机端口时 Host 仍是 `127.0.0.1`，响应读不到但**写操作已经生效**（可盲改自选/预警，还能触发全市场扫描）。现在写路由额外要求 `Origin` 缺失或指向本机（`Origin: null` 与其他站点 403），且 `Content-Type` 必须是 `application/json`（否则 415）—— 跨站 `no-cors` 的字符串 body 默认是 `text/plain`，这一条把它堵死。同源 JSON、脚本/curl（无 Origin）不受影响。
- **`/kline` 兜底与请求的复权口径对齐**：东财兜底此前写死 `fqt=1`（前复权）却回显调用方请求的 `fq`，请求 `hfq`/`none` 会拿到**前复权数据却标着 hfq**（静默错数据）。现在按 `fq` 映射 `fqt`（qfq→1 / hfq→2 / none→0），周期也支持 `klt` 101/102/103，兜底不再只对日线生效。
- **`/sentiment` 部分降级**：涨停/炸板/跌停池（push2ex 单主机、无镜像）挂掉时，此前整张情绪卡 502；现在与涨跌家数各自独立降级为 `null`（响应带 `partial: true`），两路都失败才报错。
- **`/longhu` 缓存按"日期 + 分页"分键**：此前只按日期分键，翻页会互相顶掉缓存。
- **选股 `universe` 加 3000 上限**：`universe: 0` 的含义是"全市场"（约 56 页 clist + 5400 只逐只拉 K 线），直接调 API 能把它变成一次 IP 限流；客户端下拉最多只给到 1500。超出按上限处理而不是拒绝。

### Fixed

- **价格预警只在面板打开时生效**（P0）：`AlertWatcher` 是 `LeekBoxPanel` 的子节点，关面板走 `root.unmount()` 就把盯盘定时器一起卸载了，面板关闭期间预警完全不判定 —— README 承诺的"交易时段自动盯盘"静默失效。现在把它提到 `entry.js` 的 `apply()`，随**插件**存活并自带 toast 宿主（面板没开时也能弹），toast 改为 `core` 里的订阅式广播（`pushToast`/`onToast`/`ToastStack`）。
- **行情页板块/龙虎榜永久卡在"加载中"**（P0）：`market-tab.js` 的 `loadRank`/`loadSector`/`loadLonghu` 共用一个 `loadSeq`，而 60s 轮询无条件调 `loadRank()` —— 看板块时在飞的板块请求被判成过期，`.finally` 里的 `setSectorLoading(false)` 被跳过，表格就再也不会结束 loading。现在三个数据域各有独立序号，且轮询按当前页签只刷看得见的那个（顺带省掉板块页签下每 60s 一次白打的 clist）。
- **`fq=none` + week/month 直接 502**：腾讯对 `fq=none` 把序列放在裸周期键下（`day`/`week`/`month`），旧代码恒取 `"day"`，于是周线/月线取不到数据。
- **轮询不看页面可见性、也没有交易日历**：`useInterval`/`useTradingInterval` 现在在页面不可见时不发请求，回到前台立即补一次；`marketOpenLabel` 换成语义更细的 `marketSession()`（旧签名的字段仍在，兼容既有调用点）。
- **客户端竞时段边界判错**：客户端的时段判定原本写成 `minutes < 9*60+25 → preOpen`，把 9:15–9:25 这段报成"盘前"而不是"集合竞价"（与服务端 `sessionState()` 不一致）。现在抽成纯函数 `classifySession()` 并由测试逐点对照服务端，两边口径一致。

### Tests

- 新增 `calendar-test.mjs`（无网络）：东八区时刻换算与跨日边界、9:15/9:25/9:30/11:30/13:00/15:00 逐点时段核对、工作日假期必须判为休市、无日历时如实退化并标注 source、`sessionTtl` 放大、快照形状、构建单飞与失败降级、未注入 provider 也不抛，以及**客户端与服务端的时段口径逐一对照**（从产物里抽出客户端的 `classifySession`，与 `sessionState()` 在一天 295 个采样点 × 交易日/休市两种日历上比对，含全部边界）——这条对照当场抓出了客户端竞时段边界写成 `minutes < 9:25 → preOpen` 的错判（`9:15–9:25` 会被报成"盘前"而不是"集合竞价"）。
- 新增 `route-cache-test.mjs`（无网络）：TTL 命中/过期、单飞（5 并发只打 1 次上游）、失败不写缓存且并发失败共享同一 Promise、stale-if-error 窗口内外、真 LRU 淘汰、真路由接线（`/quote` 并发同 codes 只打一次腾讯、`/health` 带版本与缓存统计、`/metrics`）以及写接口加固的六种输入（跨站 Origin、`Origin: null`、伪造回环前缀、无 Origin、`text/plain`、带 charset 的 JSON）。
- `client-bundle-test.mjs` 补第 4/5 节：`apply()` 在最小 DOM 桩上必须挂得起来；**预警看护与交易日历时钟必须由 entry.js 挂载**、面板不得再渲染 `AlertWatcher`（防止以后被重构回面板，那会让预警再次随面板卸载）；产物必须带可见性门控与 `/calendar`。
- 既有测试的写请求补上 `content-type: application/json` 与同源 `Origin`（写锁生效后的必然要求）：`p0-position-alerts-test.mjs`、`error-text-test.mjs`、`screener-meta-test.mjs`、`verify-fixes.mjs`。
- `npm test` 16 → 18 个套件；CI 的 `node --check` 补 `lib/calendar.js` 与 `lib/route-cache.js`。

## [0.10.2] - 2026-10-09

### Fixed

- **大盘页"上涨/下跌"家数空白**：东财对 push2 域的 `ulist.np` / `clist` / `stock.kline` 路由做了连接级封锁（TLS 握手后直接 RST，同域 `stock/get` 照常 200；curl/浏览器 UA/换 host 都一样），指数快照取涨跌家数的路线全线失效，`/sentiment` 的 `up/down/flat/marketTotal` 降级为 null，前端渲染成"—"。主源换成与涨停/跌停池同域同签名的**涨跌分布接口**（push2ex `getTopicZDFenBu`）：`fenbu` 的涨跌幅整数桶正数累加=上涨、负数=下跌、"0"=平盘，口径与涨停池逐家吻合（±11 桶 69/8 = limitUp/limitDown），合计 5362 家（与 ulist 口径 5566 的差异为排除停牌）。ulist.np 指数快照保留为备源，上游解封后自动回落；两个源都失败才抛错，"绝不返回假的 0/0"的语义不变。

## [0.10.1] - 2026-10-09

### Changed

- **客户端拆分为多文件源码 + esbuild 构建链**：3661 行的 `lib/client.js` 单文件按原 region 边界拆成 `src/client/` 下 14 个职责文件（react 桥接 / 样式 / API 与格式化 core / 星标 / 情绪仪表 / 大盘·行情·自选·选股·快讯五个页签 / 个股详情弹窗 / 主面板 / 侧边栏入口 / 插件入口），`build.mjs` 用 esbuild 打包回单文件产物——react / react-dom/client 保持 external（宿主 ModuleLoader 注入，杜绝双 React），产物继续提交进仓库，`npm run build` 重建、`npm run dev` watch。跨页签复用的 `fmtYi`（元→亿）上移到 core，顺带发现并删掉了从未使用的 `useMemo` 解构。运行时依赖依旧为零，esbuild 仅 devDependencies。

### Fixed

- **CI 的测试清单手抄漂移**：`ci.yml` 的 `unit-tests` job 把 `package.json` 的 `scripts.test` 手抄了一遍，抄漏 3 个——`p0-position-alerts-test.mjs`（持仓/预警写锁端到端）、`p0-minute-fflow-test.mjs`（分时+资金流数据形状）、`p1-f10-longhu-test.mjs`（F10/龙虎榜字段映射）。它们在本地 `npm test` 一直是绿的，却从未在 CI 上跑过，等于 P0/P1 那几批改动少了 CI 保护。现在该 job 直接 `npm test`，`scripts.test` 成为唯一来源，新增测试不再需要同步改 workflow。
- **esbuild 产物的跨平台差异**：新增的 bundle 新鲜度检查在 ubuntu 上必红——同版本 esbuild（0.28.2）、输入逐字节一致、metafile 里 14 个输入两边都判为 `esm`，但 win32 原生二进制会在 ESM→CJS 产物开头补一行 `"use strict";`，linux 不补，差 14 字节。`build.mjs` 改为 `write:false` + 插件合成 banner/footer 落盘，并剥掉这行：它落在 banner 的 `var module / var exports` 之后，已不在函数体的指令序言位置，只是个无效字符串表达式（拆分前手写的 bundle 里也没有），剥掉语义不变，产物在任何平台逐字节一致。新鲜度检查失败时现在会把 `git diff` 前 60 行、esbuild/node 版本、文件 sha 一并写进 step summary 与 `::error::` annotation（annotation 走公开 API 可读，job 日志需要仓库权限）——这次的根因就是靠它定位的。

### Tests

- 新增 `client-bundle-test.mjs` 并接入 `npm test`（15 → 16 个）：桩 React 跑 factory，卡住产物契约——ModuleLoader 包装 / 插件 id / `require("react")` 各恰 1 处未内联 / 导出 `{apply, inject}`。
- 抽产物源码的三个测试锚点改为与 bundler 无关的形式：esbuild 会把模块顶层 `const` 降级为 `var` 并剥离注释，`sentiment-score-test.mjs` 的注释锚点改为 `function SentimentCard(`，`error-text-test.mjs` / `screener-meta-test.mjs` 的锚点去掉 `const` 前缀（后者 end 锚点按整条声明语句对齐，避免 dangling `var`）。
- CI 新增 `client-bundle` job：`npm ci`（lockfile 已入库，npm 缓存恢复）→ `npm run build` → `git diff --exit-code`，提交过时产物直接红。

## [0.10.0] - 2026-10-09

### Added

- **个股 F10 财务摘要**：个股详情弹窗在资金流向之后新增「财务摘要」卡片——最近 8 个报告期的 营收/归母净利（亿元）+ 同比、ROE（加权）、销售毛利率、资产负债率、基本每股收益，最新报告期在前。数据走东财 F10 datacenter 报表（`RPT_F10_FINANCE_MAINFINADATA`，字段形状已对 live API 核验），新 `fetchEmF10Main()`（双主机回退 + 退避重试，SECUCODE 过滤支持 sh/sz/bj）与 `GET /api/leekbox/f10` 路由（财报低频变化：每 code 缓存 1 小时，LRU 上限 80 只）；取数失败静默——财务面是增强信息，不挡主行情。

### Changed

- **自选股 / 预警写操作串行化**：add/remove/import 与预警 add/remove 都是"读→改→写"三步，原子改名只能防文件写坏、防不了并发丢更新。新增 `makeListLock()` 写锁（Promise 链），自选股与预警各自的 mutation 全部串行执行——每个读改写周期看到上一个的结果，抛错的 mutation 不断链。`/watchlist/add` 的参数校验与 `/import` 的解析留在锁外，400 分流不受影响；预警的去重/上限检查移入锁内（否则两个并发 add 会双双通过检查）。

### Tests

- 新增 `p1-f10-longhu-test.mjs` 并接入 `npm test`（14 → 15 个）：F10 字段映射与 live API 形状逐字段对齐（含 bj 代码 `.BJ` SECUCODE、负同比保留符号、中文错误文案）、`/f10` 每 code 缓存命中零重取、`/longhu` 榜单行形状与当日数据首试即中。
- `p0-position-alerts-test.mjs` 补第 6 节：20 个并发 add（不同代码）全部落盘且每个响应反映自己的新增——写锁的并发不变量回归。

## [0.9.0] - 2026-10-08

### Added

- **当日分时图**：个股详情弹窗的「分时」周期不再复用 1 分钟 K 线柄，改为走专用 `GET /api/leekbox/minute`（此前该路由已取数但前端从未消费），新 `MinuteChart` 组件画出标准分时形态：价格线 + 均价线（成交量加权累计均价 Σ价×量/Σ量，不依赖 amount 字段的单位约定）+ 成交量柱（按逐刻涨跌着色）+ 昨收虚线基准，右侧标注相对昨收的涨跌幅，悬停浮窗带时间/价/均/幅/量。
- **资金流向柱状图**：个股详情弹窗在资金流分明细表之上新增 `FflowChart`——最近 15 日主力净流入柱状图（流入红/流出绿，零轴基准，悬停高亮并显示当日净流入额）；明细表保留最近 8 日。
- **持仓成本与实时盈亏**：自选股条目支持 `qty`（股数）与 `cost`（成本价）字段——表格新增 持仓/成本（点击单元格内联编辑：Enter/失焦保存、Esc 取消、清空即清除，服务端校验）与 盈亏（按现价实时计算浮动盈亏额 + 收益率）两列；设有完整持仓时表格上方显示汇总条（持仓只数 / 市值 / 成本 / 浮动盈亏 / 总收益率）。导出 CSV/JSON 携带持仓字段，导入（CSV `code,name,group,qty,cost` 列与 JSON 行）同样解析；坏 qty/cost 字段丢弃而不拒绝整只股票。
- **价格预警**：自选股表格行内 🔔 按钮为个股设置预警（价格涨到 / 价格跌破 / 涨幅达到 / 跌幅达到），新存储文件 `.leekbox-alerts.json`（与自选股同一套"临时文件 + 原子改名"写法）与三条路由（`GET /api/leekbox/alerts` 列表、`POST .../add`、`POST .../remove`；全量校验：类型白名单 / 代码归一化 / 指数拒绝 / 目标价与涨跌幅阈值范围 / 去重 / 100 条上限，错误文案中文）。新 `AlertWatcher` 挂在面板内与行情同一时钟轮询（仅交易时段、批量合并取价），触发后右下角 toast + 浏览器通知（权限在用户添加预警的手势内惰性申请）+ WebAudio 蜂鸣，并自动移除该条（一次性）；预警卡片在自选页统一管理（列表 + 删除）。`/health` 顺带带上预警条数。

### Fixed

- **显式清除持仓被误判为无效**：`POST /watchlist/add` 传 `qty: null`（清除已存股数）原先与解析失败落入同一 400 分支，持仓一旦设置就无法清除；现区分"显式 null = 清除"与"校验失败 = 400"。

### Tests

- 新增 2 个无网络回归测试并接入 `npm test`（12 → 14 个）：`p0-position-alerts-test.mjs`（真实路由 handler 端到端：持仓存/改/清/校验 400、CSV/JSON 导入导出携带持仓字段、预警增删/去重/全量校验/非回环 403、health 双计数）、`p0-minute-fflow-test.mjs`（stub 上游驱动真实 minute/fflow handler，锁定新图表消费的数据形状契约）。

## [0.8.13] - 2026-10-07

### Changed

- **版本号对齐发布**：`v0.8.12` 的 tag 是在 CI 修复提交（`ad52a79`）之后才创建的，那次发版号的 release 说明里虽然写了 CI 修复，但版本号本身没有独立覆盖它的发布记录。本次 bump 到 `0.8.13` 把 CI 修复单独作为一个可见版本发布；代码与 `v0.8.12` 完全一致（两者 diff 仅含版本号与 CHANGELOG）。

## [0.8.12] - 2026-10-07

### Changed

- **选股模块按职责拆分**：原 722 行的 `lib/screener.js` 一个文件承担了股票池、K线取数、指标数学、信号、策略、结果缓存、进度与编排 8 件事。现拆为 5 个文件，`lib/screener.js` 保留为对外门面（`runScreener` / `screenerProgress` / `screenerCacheStats` / `klineCacheStats` / `screenerMeta` 签名与返回字段不变）：
  - `lib/indicators.js` — 纯指标数学，无 I/O、无状态
  - `lib/signals.js` — 信号与策略的唯一定义处（权重/分组/文案/策略组成）+ 打分
  - `lib/screener-cache.js` — 结果缓存与日K缓存（含自适应 TTL）
  - `lib/screener-validate.js` — 参数归一化 + 带 `error.code` 的校验异常
  - `lib/screener.js` — 编排层（股票池 / 取数 / 过滤 / 排序 / 进度）
- **路由不再自己抄一份参数表**：`POST /api/leekbox/screener` 原先在 `lib/index.js` 里重复实现了一遍字段清洗与默认值（与引擎各存一份，易漂移），现统一由 `screener-validate.js` 归一化，路由只做白名单过滤。

### Added

- **`GET /api/leekbox/screener/meta`**：下发信号/策略元数据（key、label、weight、group、desc、策略组成）。前端据此渲染勾选面板，服务端新增信号或改权重时界面自动跟随；客户端保留离线兜底副本，接口不可用时仍能渲染面板。

### Fixed

- **自适应 K 线 TTL 的批次计数永不归零**：`adjustKlineTTL()` 在查找次数不足 `TTL_BATCH_SIZE` 时提前 `return`，导致 `ttlHits`/`ttlMisses` 跨批次持续累积、`reuseEma` 永远算不出来。现改为累积到满一批才评估并归零，并补上"冷启动批次不得缩短 TTL"的回归测试。
- **结果缓存统计语义**：写入缓存时累加的是 `misses`，把"写"记成了"未命中"。现拆出 `stores`（`misses` 字段为兼容旧监控面板保留同值），并新增 `evictions`。
- **结果缓存淘汰不是 LRU**：原先按插入顺序 `shift()`，命中不回迁位置，热键会被冷键挤掉。现用 `Map` 实现真正的 LRU，并顺手摘除过期条目。
- **KDJ 与 BOLL 的 O(n²) 计算**：`kdj()` 每根 K 线都 slice 一次窗口再 spread 求 min/max，`boll()` 每个下标重算一遍方差。现分别改用单调队列与滚动 sum/sumSq，降为 O(n)；经 7.2 万采样点对比，最大绝对误差 2.5e-11（仅浮点累加误差）。`boll()` 同时把浮点误差导致的负方差钳到 0，避免 `sqrt(负数)` 顺着信号链污染评分。
- **路由靠正则匹配中文文案判 400**：`/^(未知|multi 模式)/` 一旦改动提示语就会让 400 静默退化成 502。现改为按 `error.code`（`screener_invalid_params` / `screener_already_running`）分流。

### Tests

- 新增 `indicators-equiv-test.mjs`（把重构前的 O(n²) 实现内联为参照物，4.5 万采样点逐点对比 kdj/boll；含"旧高点滑出窗口"的决定性断言与反证）、`kline-ttl-coldstart-test.mjs`（必须在全新进程验：复用率 EMA 是模块级状态）、`screener-meta-test.mjs`（抽取客户端真实 `buildScreenMeta` 源码跑断言，含"服务端新增信号自动出现在面板"与路由错误码分流端到端），并接入 `npm test`。
- CI 的 `node --check` 补全 4 个新模块（7 → 11 个），无网络套件补全 3 个新测试（9 → 12 个）——原先新模块与新测试都不在 CI 覆盖范围内。

## [0.8.11] - 2026-10-02

### Added

- **P0 宇宙增量刷新**：`GET /api/leekbox/universe?since=<builtAt>` 返回自上基线版本以来的增量（`added` 携带完整成形行、`removed` 为代码列表），基线缺失或超出保留的 10 个快照时以 412 `{ needsFullRefresh: true, currentBuiltAt }` 提示客户端回退全量；默认返回全量行，`?rows=false` 可只要元数据。`lib/search-index.js` 新增 `indexHistory` 快照环与 `getInstrumentIndexDelta()`（412 错误消息为中文、技术细节留 `reason`，与全仓错误文案约定一致）。
- **P1 选股结果缓存**：`runScreener` 按归一化参数（require/strategies 排序后序列化）做 LRU 结果缓存（上限 500 条、TTL 15 分钟），命中直接返回 `cacheHit: true` + "Cached result (N stocks)"，不再重复打行情源；新增 `screenerCacheStats()` 结构化出口（total/hits/misses/hitRate）。
- **P1 部分结果实时流出**：K 线抓取重构为逐到达评分（`fetchKlinesConcurrent(codes, onEach)`），每根序列取到即刻过 `scoreRow` 并推入 `_progress.partial`，前端轮询 progress 即可增量渲染，无需等整轮扫描结束。
- **P2 选股进度 SSE 流**：`GET /api/leekbox/screener/stream` 以 250ms 尾随共享进度快照（单飞扫描保证无需任务 id），变化即发 `progress` 事件，扫描结束发 `done`（失败发 `error`）；含 15s 心跳注释帧与 5 分钟硬寿命上限，防代理断连与空闲泄漏。

### Tests

- 新增 4 个无网络回归测试并接入 `npm test` 与 CI：`p0-universe-delta-test.mjs`（快照环 + 增量/412）、`p1-screener-cache-test.mjs`（缓存命中零 fetch + 深比较）、`p1-p2-stream-test.mjs`（partial 单调增长直至收敛）、`p2-sse-route-test.mjs`（真实路由 handler 端到端：progress/done 帧、非回环 403）。

## [0.8.7] - 2026-10-02

### Fixed

- **成交额显示缩小 100 倍**：A 股榜单表格列头「成交额」使用 `fmtAmount()` 时未乘 10000（服务端返回万元），导致显示为"50.00 万”而非“50.00 亿”，现统一转换为元单位。
- **自选股 >50 只行情静默丢失**：`/quote` 服务端保护栅栏限制单次请求 50 码，但自选列表无上限；此前超长部分永远无报价，现分片并发 fetch 再合并结果。
- **板块列表无法翻页**：sector 数据硬编码 `page=1&size=30`；新增 `sectorPage`/`sectorPageSize` 状态与分页 UI（首页/上一页/下一页/末页 + 每页条数选择）。
- **快速切换 stale response**：sector/longhu 加载时未做请求顺序守卫，板块 tab/龙虎榜 tab 快速切换会覆盖旧数据；news 双击"加载更多”也易重复请求。分别引入 `loadSeq`/`newsLoadSeq` 计数器守卫所有异步响应，more() 增加 loading 防抖判断。
- **ScreenerTab 定时器泄漏**：组件卸载时清空调度器未执行，持续轮询 `/progress`；现通过 ref 记录 ID 并在 useEffect cleanup 中清除。

### Security / CI / Tooling

- **CI 补全语法检查与行为测试**：加入 `lib/search-index.js` 至 `node --check`；PR/推送自动跑 4 个 stubbed 回归测试（verify-fixes/pinyin/news-dedup/sentiment-score/error-text）排除有网络依赖的 screener-test.mjs/rank-fallback-test.mjs。
- **本地脚本完善**：package.json 新增 `check`/`test` 二脚本。

## [0.8.10] - 2026-10-02

### Changed

- **K 线缓存 TTL 改为自适应**：原先是固定的 10 分钟常量，现按实测复用率动态调整（区间 5–30 分钟，起步 10 分钟）。连续扫描大量命中缓存说明扫描间隔够近，TTL 每次 ×1.25 上调；复用率掉下来说明缓存在过期数据上浪费请求，×0.8 下调。**冷启动不会被误缩**：首次扫描必然全 miss，若此时就缩 TTL 会形成"越缩越 miss"的死亡螺旋，因此下调前要求复用率 EMA 已见过真实复用（`MIN_BATCH_REUSES`），每 200 次 lookup 才评估一次以免单轮扫描抖动控制器。
- 新增 `klineCacheStats()` 导出，供 `/meta` 与调试读取当前 TTL、批内命中率与复用率 EMA。缓存评估走结构化出口而非日志，日志通道保持干净。

## [0.8.9] - 2026-10-02

### Fixed

- **选股池并发翻页产生重复行**：`buildUniverse` 以 5 页并发拉取，成交额排名在翻页间隙漂移会让同一只股票落进两页。重复行既浪费 K 线请求（每股一次），又让 `slice(limit)` 少给几只票。现按 code 去重并保留首次出现的条目（页序即金额序，即排名更靠前的那次）。
- **`/rank` 日志通道**：失败分支此前把用户可见文案写进 `console.error`，与全仓约定的日志通道不一致。现改走注入的 `logger.warn`，内容用 `errorDetail()` 的技术细节（host/node/sort），中文用户文案仍只在响应的 `error` 字段里。

### CI / Tooling

- **verify-fixes.mjs C 段不再碰真实网络**：`/search` 冷启动超时用例此前会打到东财 suggest 线上接口，CI 里既慢又可能因限流抖动。现在 push2（指数构建）挂起以触发 3s 超时、suggest 返回桩数据、其余源一律抛错，并断言 hits 的形状（code/name/market）。挂起请求的计时器在段尾统一清除，避免 60s 计时器把测试进程拖住。
- **screener-test.mjs 补断言与退出码**：此前只有 `console.log`，无论结果如何都返回 0，CI 看不出失败。现引入 `check()` 计数 scanned/candidates/computed/matched 之间的子集关系与逐行必填字段，失败置 `process.exitCode = 1`。耗时断言改用实测墙钟时间——`result.elapsed` 是 `"35s"` 这样的带单位字符串，拿它和毫秒阈值比较永远为 false。
- **CI 加固**：`syntax-check`/`unit-tests`/`manifest` 拆成三个并行 job，各自加 `timeout-minutes`；`concurrency` 配 `cancel-in-progress` 让同分支的新推送作废旧运行；权限收紧为 `contents: read`；`setup-node` 开启 npm 缓存。

### Release

- 纠正 v0.8.9 标签发布时 package.json 未同步 bump 的版本不一致（当时仍停在 0.8.8），本版补上。
- 纠正 v0.8.9 把 `/rank` 的 `reason` 字段一并改成中文用户文案的失误：`reason` 是给排查用的技术细节通道（`errorDetail()`），应与 `logger.warn` 写进日志的内容一致；浏览器渲染的是 `error` 字段，`reason` 里塞中文并没有帮助用户，反而丢了定位上游哪个 host 挂掉的信息。现在 `error` 中文 / `reason` 技术细节 / 日志同一条技术细节，三者各归其位。

## [0.8.8] - 2026-10-02

### Fixed

- **v0.8.7 release 版本不一致**：release commit 漏 bump package.json 版本号，导致 tag v0.8.7 对应的实际代码仍是 0.8.6；同时 CHANGELOG 错误声称新增 `audit` 脚本。本发布纠正两者：版本 bump 到 0.8.8，CHANGELOG 更正为仅含 check/test 二脚本。
- **资金流向字段错位**：lib/emrank.js 的 fflow kline 响应体中资金流顺序应为 date/main/xl/big/middle/small，原代码将 middle↔xl/big 位置互换，导致用户端柱状图中"中单/小单"完全颠倒；现已按 EM API 实际顺序修正映射。

## [0.8.6] - 2026-09-23

### Fixed

- **数据取不到时报英文文案**：客户端把响应体里的 `error` 字段**原样渲染**到红色错误条上，而服务端一路抛的都是英文——`rank feed unavailable`、`all news feeds unavailable`、`instrument index: first page failed`、`expected ?code=sh600519` 等等。用户在行情页/板块页/快讯页/自选页看到的报错全是英文，既不知道是哪个榜挂了，也不知道要不要重试。现在从两端一起堵住：
  - **服务端新增报错约定**（`lib/fetch-utils.js` 的 `feedError(message, detail)` / `userMessage(error)` / `errorDetail(error)`）：`message` 是给用户看的中文，一句话说清"什么没取到、要不要重试"；`detail` 是 host / node / sort / 上游字段名这类排查用的技术细节，**只进日志**（`fail()` 会写进响应的 `reason` 字段，界面不渲染它）。`lib/emrank.js`、`lib/index.js`、`lib/search-index.js`、`lib/screener.js` 里所有能透到浏览器的文案按这条约定改完，报错还会**点名是哪一个榜**：`主板榜暂时取不到：行情主源不可用，备用源没有这一项。请稍后重试或换个榜单看`、`主力净流入榜暂时取不到：…`，而不是原来那句看不出所以然的 `rank feed unavailable`。
  - **服务端出口兜底**：`/rank`、`fail()` 等所有失败出口一律过 `userMessage()`——漏翻的英文（Node 内建 `ENOENT`/`ECONNRESET`、第三方库异常、上游直接透传）会被换成通用中文，真正原因留在 `reason` 里。也就是说**即使以后再有人写出英文文案，界面也不会漏出去**。
  - **客户端兜住浏览器自己的报错**（`lib/client.js` 新增 `describeError()`）：以前 `fetch` 断网抛的 `TypeError: Failed to fetch`、超时中止抛的 `The operation was aborted.`、以及非 JSON 响应的兜底 `HTTP 502`，都会原封不动显示给用户。现在统一映射为「网络连接失败，请检查网络后重试」/「请求超时，请稍后重试」/「服务返回异常（HTTP 502）」，被替换掉的原文写进 `console.warn` 便于排查。`api()` 现在是最后一道闸：服务端漏翻的英文也会在这里被换成中文并带上状态码。13 处错误展示点（指数/榜单/板块/龙虎榜/自选/选股/快讯/个股详情/K线弹窗/导出）全部改走 `describeError`。
  - **选股"任务已在运行"改用错误码判定**：`/screener` 路由此前靠正则匹配英文 `already running` 决定回 409；文案改中文后这类匹配会静默失效，改为 `error.code === "screener_already_running"`（保留正则兜底）。

### Added

- `error-text-test.mjs`：报错文案中文化的回归测试（59 项断言，无网络）。静态扫描服务端所有 4xx/5xx 响应的 `error` 字段必须是中文（动态拼接的必须过 `userMessage()`），抽取 `lib/client.js` 里**真实的那份** `describeError` 源码跑行为断言（断网/超时/HTTP 码/中文透传/未知英文），并断言"任何输出都不含纯英文"、客户端无 `setError(e.message)` 直通。

### Changed

- `verify-fixes.mjs`：新增 D3/D4 —— 直接驱动 `/rank` 路由断言**上游整体挂掉时 `error` 是纯中文、`reason` 保留技术细节**（这条正是本次修复的端到端验证）。同时修掉一个测试自身的坑：`lib/emrank.js` 的 clist 冷却窗口是模块级状态，前半段跑过真实网络后它一直生效，把后面用 stub 的 D1/D2 挡在 `fetch` 之前，导致「行映射」用例被误判成失败、脚本中途抛错（此前靠 60s 冷却自然到期，稳定性看运气）。现在 `lib/emrank.js` 导出 `resetClistCooldownForTests()`，测试显式复位，全套 21 项断言可稳定跑完。

## [0.8.5] - 2026-09-22

### Fixed

- **行情页整页取不到数（`rank feed unavailable`）**：东财对 clist 路由做**按出口 IP 的限流**——该路由返回 nginx 502（直连则是 TCP reset），而**同一主机**的其它路由（`ulist.np` / `stock/get` / `push2ex`）照常 200。实测 2026-09-22：push2 / push2delay / 全部编号镜像连续 20 分钟以上 502，而同一个 URL 经第三方中转（不同出口 IP）返回 200 且数据完整——所以既不是源站宕机，也不是参数写错。clist 是 rank / 板块 / 选股股票池 / 涨跌家数的共同上游，一处被限流就全线断供。
  - 新增 `lib/sinarank.js` 备用源（新浪 `Market_Center`，返回同一套 legacy 行形状），`fetchEmRankPage` / `fetchEmSectorPage` 改为「东财优先 → 新浪兜底」。单位已用东财 `stock/get` 逐字段校准：`volume` 股→手（÷100）、`amount` 元→万元（÷1e4）、`mktcap`/`nmc` 本就是万元（1:1）、价格/涨跌幅/换手/pe/pb 1:1。覆盖 `hs_a / sh_a / sz_a / cyb / kcb / etf`。
  - 新增 clist 熔断（60s 冷却）：clist 一挂就跳过重试，避免每次刷新都白等超时；冷却到期自动回探，东财一恢复就切回（它是 `主力净流入` 的唯一来源）。
  - **备用源覆盖不到的部分明确报错而不是返回错数据**：`main` / `non_main` / `cb` / `lof` 四个池子新浪没有对应 node，`sort=netflow` 新浪没有该列，板块的 `f62` 排序同理——这些请求会带上原因失败。
  - `/rank` 路由原本是**空 `catch`**，上游为什么挂完全看不到；现在记录原因并在响应里带 `reason` 字段。
- **涨跌家数改走指数快照，单次请求取代 56 页全市场翻页**：`fetchEmBreadth` 此前逐页翻完 clist 全市场（`pz=100` → 56 个请求/次，14 并发），这个请求量正是触发上述 IP 限流的原因。现改用 `ulist.np` 的 `f104/f105/f106`（上证指数 + 深证成指 + 北证50 = 沪 + 深 + 北交所全量，实测 2319 + 2902 + 345 = 5566 家），**1 个请求**搞定，同时不再依赖被限流的 clist。失败语义不变：取不到就抛错，绝不返回假的 0/0。

### Added

- `rank-fallback-test.mjs`：16 项断言。含以 `stock/get` 为真值的单位校验（价格/成交量/成交额/总市值/流通市值逐字段比对），以及"覆盖不到的池子必须报错而非返回错数据"的负向断言。

## [0.8.4] - 2026-09-11

### Fixed

- **7x24 快讯跨源重复**：跨源去重此前只做"去标点后前 24 字符精确前缀"匹配——两家源对同一事件的措辞稍有差异（多"中国"二字、换动词、多一句补充）即漏判，同一事件以不同来源标签重复出现。现在改为三层判定：①全文归一化精确匹配 → ②前缀包含（一源截断/扩写另一源的标题）→ ③10 分钟时间窗内的字符二元组相似度（共享二元组 ≥ 6 且 Jaccard ≥ 0.55 或包含率 ≥ 0.75），窗外与对立方向（增加/减少）的相似模板仍保留为独立条目；合并保留首个（信息最全）副本，被丢弃副本的重要标记（如金十星标）继承给保留项。前端「加载更多」追加分页时再按 id+归一化文本过滤，避免源流移动导致翻页边界重复。新增 `news-dedup-test.mjs` 回归（12 项断言，纯 stub 无网络）。

## [0.8.3] - 2026-09-11

### Fixed

- **拼音首字母搜索大面积失配**：`x` 档边界字由`昔`改为`夕`（此前`西`整族 xi 音字被归入 w 桶——陕西煤业/山西汾酒/江西铜业/西藏矿业等搜不到），边界判定改为闭区间语义（边界字自身不再落错桶）；多音字按股票名实际读音索引——`行`→háng（招商银行 `zsyh`、34/36 银行股此前全错）、`长`→cháng（长江电力 `cjdl`）、`厦`→xià（厦门）、`藏`→zàng（西藏）；`重`双读音（重庆 chóng / 三一重工 zhòng 都常见）引入第二变读音 `abbr2` 参与同级匹配，两种拼法均能命中。新增 `pinyin-test.mjs` 回归（41 名称/边界用例 + 11 匹配用例）。
- **选股股票池静默截断**：`buildUniverse` 此前把单个分页失败当作"列表结束"——54 页中第 7 页一次瞬时 502 会把全市场 5400 只截成 600 只并当成功缓存；现在失败页跳过并自动补抓一轮、按页序拼接（保住"成交额前 N"语义），仅真正的空页/短页终止遍历，全源不可用时明确报错而非返回"0 只匹配"。
- **选股熔断后孤儿 worker**：限流中止 throw 后其余 4 个 worker 此前继续消费队列（继续轰击已限流的源站、可与新扫描并发写进度）；现在 trip 时先置 `aborted` 标志，幸存 worker 立即收工。
- **选股参数静默空结果**：未知技术信号键（`macd`≠`macdGold`）、未知策略键、multi 模式空策略列表此前会爬完全市场后返回 `matched:0` 的"成功"；现在在进入任何网络请求前 fail fast，`/screener` 路由返回 400 与具体原因；`minStrategyHits` 钳位到 `[1, 已选策略数]`，不再出现恒空或退化为"全部命中"。
- **指数弹窗可加自选**：上证/深证/北证指数代码弹出的详情窗此前按个股渲染——提供 ☆ 加自选（服务端照单全收，指数被写进自选股文件）并显示无意义的涨停/跌停；现在指数窗显示「指数」标签并隐藏加自选/涨跌停，服务端 `/watchlist/add` 对指数代码返回 400、导入一律记为无效（`sz000001` 平安银行等深市个股不受影响）。
- **确认框永久卡死**：确认框开着时关闭面板，模块级 `confirmState` 不复位——此后所有 `lkbConfirm` 静默返回 false，星标/覆盖导入直到刷新页面都无反应；现在面板卸载时取消挂起的确认框。
- **搜索冷启动长时间阻塞**：本地索引未就绪时 `/search` 会无超时等待索引构建（源站挂起时实测 12s 未返回，最坏 ~3 分钟），而路由里的 2.5s 行情 race 罩不住它；现在索引等待加 3s 超时，超时降级走原有 searchadapter 兜底，构建仍在后台继续。
- **主力净流入榜名不副实**：`sort=netflow` 排序生效但 `f62` 从未进入 fields/行映射/响应/表格——整榜"按隐形数字排序"；现在全链路打通：clist fields 增加 `f62`，行映射 `netflow`，`/rank` 透传，榜单表格新增「主力净流入」列（红绿着色，基金/转债无此数据显示"—"）。

### Added

- **测试脚本**：`pinyin-test.mjs`（拼音首字母回归）与 `verify-fixes.mjs`（本轮 8 项修复的 18 项行为断言，全 stub 无网络依赖）。

## [0.8.2] - 2026-09-10

### Docs

- **声明宿主要求**：README（中/英）新增「环境要求」小节——DeepSeek Harness (DSH) **≥ 0.1.1-rc.1**（`dsh.engines.dsh`），仅运行于 **web profile**（`dsh.client.platform: "web"`），浏览器端经同源 `/api/leekbox/*` 访问（仅限 loopback）。仅文档变更，代码无改动。

## [0.8.1] - 2026-09-10

### Changed

- **行情数据只在交易时段轮询**：新增 `useTradingInterval`（交易判定复用 `marketOpenLabel`：
  周一~周五 9:30–11:30 / 13:00–15:00），大盘指数（30s）、行情榜单（60s）、市场情绪（60s）、
  自选行情（15s）与个股详情弹窗报价（10s）全部改为仅交易中自动刷新；非交易时段不再重复
  请求，打开页面/弹窗时的一次拉取即为终值。定时器保持空转，跨开盘边界（如 09:15 打开
  面板）会在 09:30 自动进入轮询。7x24 快讯轮询与面板自选星标同步不受影响。

## [0.8.0] - 2026-09-10

### Added

- **大盘页新增「市场情绪」温度计卡**：大盘页新增独立情绪卡（置于指数卡之后）——左
  侧半圆分段仪表盘呈现综合情绪温度 0~100°（市场宽度 40% + 涨停强
  度 25% + 封板率 20% + 连板高度 15% 加权，单路数据缺失按剩余权重归一），五档色
  弧段（冰点绿→沸腾红）当前档位满亮、其余压暗，游标点随分数平滑转动，配大号分数
  与冰点→沸腾五档着色徽标（含解读 tooltip）；右侧为无框编辑式数据行（细分隔线代
  替灰格子）：上涨/下跌（附红绿占比微条）、涨停/跌停、炸板、封板率（≥70% 染红、
  <50% 染绿）、最高板。60 秒自动刷新，复用 localStorage 即写即显缓存，全量暗色
  主题适配。服务端 `/api/leekbox/sentiment` 响应补充 `date` 字段（涨停池数据日期）。

### Changed

- **行情页视觉重绘**：三个榜单页签改用与选股页同款的胶囊分段控件（并合并原先重复
  的两套 `.lkb-seg` 样式）；市场/榜单/板块筛选 chip 改为描边样式，悬停与选中反馈
  更清晰；榜单表格表头改小号加字距排版，行悬停出现左侧主题色指示条，股票榜前三名
  显示金/银/铜奖牌色排名（与选股页排名语言一致）；翻页/切榜时数据行错峰淡入（同
  键刷新不重播，不闪屏）；输入框聚焦光环、置顶区底部分隔线等细节统一。数据与交互
  逻辑不变。

### Removed

- **行情页市场情绪信息条**：顶部「上涨/下跌宽度条 + 涨停 / 跌停 / 炸板 / 全市场」
  单元格整块移除，情绪看板统一收敛到大盘页温度计卡；行情页连板梯队与涨停池列表
  保留，服务端 `/api/leekbox/sentiment` 不变。

### Fixed

- **涨跌家数不再显示假的 0**：夜间/源站异常时 `push2` clist 全部超时，
  `fetchEmBreadth` 此前会静默返回 `up:0, down:0` 被温度计照常渲染。现在首页两轮
  全失败直接抛错，`/sentiment` 路由降级为 `null`，前端显示"—"且情绪分自动按剩余
  权重归一；同时 clist 单次超时 5s→8s、镜像顺序调整（push2delay 提前）、失败后
  60 秒内快速失败，不再拖慢轮询。

## [0.7.5] - 2026-09-09

### Changed

- **行情页 UI 重构（报价板风格）**：市场情绪由六个同形胶囊改为信息条——新增涨跌
  家数宽度条（红绿占比一秒读出强弱，悬停显示具体家数），涨停/跌停/炸板/全市场改
  为大号等宽数字单元格；筛选行增加「市场 / 榜单 / 板块 / 排序」分组标签，板块文
  案精简；股票/板块/龙虎三张榜单的涨跌幅改为红绿色块单元格（一行一个主信号），
  股票榜新增跨页连续名次列；大盘指数卡片增加方向色条与涨跌箭头；全部带暗色主题
  适配。
- **行情页情绪数据提速**：服务端涨跌停池与全市场涨跌家数两路数据源由串行改为并
  发；涨跌家数分页抓取并发 8→14 页/批、单页超时 8s→5s（约 55 页批次从 7 轮降到
  4 轮）；去掉一次只为取全市场总数的冗余榜单请求（复用宽度数据自带 total）；宽
  度抓取失败降级为空值，不再拖垮整条情绪数据。客户端情绪数据写入 localStorage，
  重开面板先渲染上次数据再后台刷新（即写即显），不再长时间显示"—"。

## [0.7.4] - 2026-09-09

### Removed

- **移除 K 线图上的压力位/支撑位画线**：0.7.2 引入的两条常驻曲线观感不佳（既不
  贴蜡烛形态也非标准 S/R 表达），撤下；压力位/支撑位仅保留悬停浮窗数值展示。
  算法回归 0.7.3 定义：收盘价上方最近摆动高点/下方最近摆动低点（60 根窗口、左
  右各 2 根确认，枢轴点回退 + 区间极值兜底，无未来函数，恒保证 `压力位 ≥ 收盘
  ≥ 支撑位`），不再为画线做任何平滑或改写。

## [0.7.3] - 2026-09-08

### Fixed

- **修复悬停 K 线时整个插件窗口崩溃退出**：0.7.2 浮窗代码中 `mas.map(fn, h(...))` 的
  第二个 `h(...)` 实为 `map()` 的第二参数（thisArg 位），在渲染时被立即求值，其内部引
  用的 `series`/`mi` 不在该作用域，首次悬停触发浮窗分支渲染时抛出 `ReferenceError`
  导致 React 整树卸载。改为 `mas.flatMap((series, mi) => [h(...), h(...)])` 返回元素对
  数组；补充回归测试验证浮窗 10 个数值格（开高低收量/MA×3/压撑×2）完整求值。

## [0.7.2] - 2026-09-08

### Changed

- **K 线悬停信息改为跟随鼠标的浮窗**：移除图上方的固定图例条，鼠标悬停任意 K 线时
  在光标旁弹出浮窗（靠近右/下边缘自动翻转，不遮挡十字光标），内容含日期、开/高/
  低/收（涨跌着色）、量、MA5/MA10/MA20（均线配色）、压力位/支撑位。
- **压力位/支撑位改为图上常驻曲线**（类似 MA 线画法）：逐日滚动计算（每日只用截
  至当日的数据），红色为压力位、绿色为支撑位，随十字光标在历史各日平滑变化。

## [0.7.1] - 2026-09-08

### Added

- **K 线悬停浮窗新增压力位/支撑位**：十字光标悬停任意一根 K 线时，图例在 MA5/10/
  20 之后追加 `压力位`（红）/`支撑位`（绿）两项，并在价格图上以两条虚线横线同步标
  注，随悬停日实时更新（日/周/月/5分/30分周期均生效）。
  - 算法只用截至悬停日的数据（无未来函数）：取最近 60 根 K 线检测摆动高低点（左
    右各 2 根确认的局部极值），压力位 = 收盘价上方最近的摆动高点，支撑位 = 下方
    最近的摆动低点；
  - 无摆动点时回退经典枢轴点公式（前一日 `P=(H+L+C)/3`，`R1=2P−L`，`S1=2P−H`）；
  - 区间极值兜底，保证恒有 `压力位 ≥ 收盘 ≥ 支撑位`。

## [0.7.0] - 2026-09-08

### Changed

- **行情搜索重做**：结果展示与性能全面重构。
  - 服务端新增本地全市场搜索索引（`lib/search-index.js`）：沪深京 A 股 + ETF/
    LOF/可转债约 8 千只标的一次性快照（东方财富 push2 clist，多镜像重试 + 分块
    并发），缓存 6 小时并后台热更新，插件挂载时即开始预热。代码前缀、名称关键
    字、拼音首字母（`Intl.Collator` 中文拼音排序推导，零依赖）搜索均在 ~1ms
    内从内存返回；全拼输入（如 `maotai`）由腾讯 smartbox 兜底；索引未就绪时回
    退原东方财富 searchadapter（响应新增 `source`/`meta` 字段标注来源与耗时）。
  - 搜索结果附带实时行情：每次搜索对结果集发起一次腾讯批量行情请求，命中条目
    直接带 `price/changePct/turnoverRate/amount`，无需二次点击。
  - 客户端搜索结果展示重做：搜索框增加放大镜/清空按钮，下拉式结果卡（不再把
    下方榜单压下去）——每条结果带类型徽章（股票/ETF/LOF/转债）、沪/深/北市场标
    识、实时价格 + 涨跌幅着色、加自选 ☆；骨架屏加载态、无结果提示、Esc/Enter
    快捷键、点击外部自动收起；防抖 350ms → 120ms 并带竞态序号保护。
- 修复北交所代码归一：`920xxx` 之前被 `9 → 沪市` 规则错误映射为 `sh`，服务端
  `normalizeCode` 与客户端 `normCode` 现在都将其映射到 `bj`（43/83/87/88 已覆盖）。

- 修复所有列表（搜索结果/榜单/条件选股）☆ 状态永不点亮的问题：自选股服务端
  存储的是规范化代码（`sh603626`），而 UI 行携带裸代码（`603626`）直接比对导致
  永不匹配——新增 `isWatched()` 两侧统一过 `normCode` 比对；☆ 点击成功后立即
  广播 `leekbox:watchlist-changed` 事件，面板即时刷新自选列表（不再等 20s 轮询）。

- 彻底移除原生 `window.confirm`（☆ 移出自选、覆盖导入确认）：原生同步模态框会
  抢占窗口焦点，在本嵌入式 WebView 中取消后渲染进程鼠标捕获状态可能卡死（搜索框
  点不聚焦，需最小化窗口恢复）。改为插件内自绘确认对话框（`lkbConfirm`，保持
  Promise<boolean> 契约）：Esc=取消 / Enter=确定 / 点遮罩取消，暗色主题适配，
  不抢焦点、不阻塞渲染。

### Fixed

- 搜索下拉卡与搜索框在部分皮肤（如 stellar-diva，将 `--dsw-alias-bg-base` 重映射
  为随透明度可到 0 的玻璃色）下完全透明的问题：两层叠打底色（别名色 over 实色，
  暗色模式用 `#151517`）；同时修正 `.lkb-searchInput` 左内边距被后置 `.lkb-input`
  规则覆盖导致放大镜图标压住 placeholder 的层叠问题。
- 搜索结果无行情时不再显示 "— —" 占位横杠（价格/涨跌幅字段缺失时直接隐藏）。
- 重新聚焦搜索框时，若已有关键词则立即恢复展示上次搜索结果。

## [0.6.2] - 2026-09-07

### Added

- 主板 / 非主板池切换（market board pool toggle): the stocks rank tab gains
  two new pools beside 沪深A股 — 主板 (SH main board 600/601/603/605 + SZ main
  board 000/001/002/003, mid-board merged) and 非主板 (ChiNext 300/301 + STAR
  688). The two pools exactly partition 沪深A股 (3486 + 2070 = 5556), so the
  rank lists can now be filtered by board without leaving the tab. Routed
  through the existing `node` parameter as `main` / `non_main` Eastmoney
  universe selectors.

## [0.6.1] - 2026-09-01

### Fixed

- Watchlist entries added via the ☆ star button (search results, rank tables,
  screener results) were stored with the stock code as their name, so the
  watchlist table rendered the code twice (名称显示两个编号). The star button
  now sends the stock name along with the code, the watchlist table prefers
  the live quote name as a display fallback, and `/watchlist/add` also
  refreshes the stored name of existing entries when a real name is provided.

## [0.6.0] - 2026-09-02

### Added

- Multi-strategy intersection screener mode (多策略交叉选股): run 7 preset
  strategies (MACD金叉 / 均线多头 / 放量突破 / 超卖反弹 / 趋势转强 / 创60日新高 /
  强势连涨) simultaneously and show stocks that hit ≥ N strategies, sorted by
  hit count then score. The screener tab now has a mode toggle between
  "评分选股" (standard weighted-score) and "多策略交叉" (multi-strategy
  intersection). A new `minStrategyHits` parameter controls the hit threshold.

## [0.5.0] - 2026-08-31

### Added

- Market sentiment thermometer (市场情绪温度计): the market tab now shows
  up/down/limit-up/limit-down/broken-board counts, a consecutive-board ladder
  (连板梯队, 2板/3板/… with counts), the highest board, and an expandable
  limit-up pool list (name, board count, industry; click to open the detail
  popup). New `/api/leekbox/sentiment` payload with `up/down/flat`, `broken`,
  `ladder`, `maxBoard` and `ztList` from the Eastmoney topic pools plus
  whole-market breadth.
- ETF / 可转债 / LOF support:
  - Rank pool selector in the market tab: 沪深A股 / ETF·场内基金 / 可转债 /
    LOF (Eastmoney `b:MK0021` / `b:MK0354` / `m:1+t:5,m:0+t:10`), reusing the
    existing rank route with a `node` parameter.
  - `normalizeCode` now accepts 5-digit codes (ETF/LOF) and maps 11xxxx
    (沪市可转债) to `sh`, so ETF/bond codes work in watchlist, quote, kline
    and search.
  - Search now returns A-share stocks, on-exchange funds (ETF/LOF, Classify
    `Fund`) and convertible bonds (Classify `Bond`) instead of stocks only.

## [0.4.0] - 2026-08-31

### Added

- Watchlist import/export: export the watchlist as a JSON backup (group-aware,
  re-importable) or as UTF-8 CSV for Excel/WPS; import from JSON, CSV or plain
  pasted text (one stock per line, `code[,name[,group]]`, quoted cells and a
  `code`/`代码` header row tolerated). Two modes: merge (skip duplicates,
  default) and replace (with a client-side confirmation). Imported codes are
  normalized the same way as manual adds, invalid lines are reported back.
- Toolbar row in the watchlist tab with 导入 / 覆盖导入 / 导出 JSON / 导出 CSV
  buttons and a status line; the toolbar is also available when the watchlist
  is empty.

### Fixed

- `normalizeCode` had its function body jammed onto the signature line.
- `writeWatchlist` failure path contained dead code (a no-op `require` check)
  that never cleaned up the leftover `.tmp` file; it now unlinks it.
- Row-level open-detail clicks no longer fire when the click lands on an
  interactive child: changing the group `<select>` in the watchlist (or any
  future select/button inside a quote row) no longer pops the detail window.

## [0.2.0] - 2026-08-26

### Added

- Stock detail popup windows (THS-style): draggable, stackable, ESC / backdrop
  layer-by-layer close; opened by clicking a stock name in any tab including the
  watchlist.
- Candlestick K-line chart with forward-adjusted data (qfq), MA5/10/20 overlays,
  volume subchart, last-price dashed line and a hover crosshair legend.
- Multi-source 7x24 news feed: Sina zhibo + Eastmoney fast news + Jin10 flashes,
  merged newest-first with per-source filter chips and source badges.
- Important-news highlighting: official flags (Jin10 star / Sina focus) plus a
  keyword fallback (突发/重磅/重大/紧急/超预期).
- Screener UI redesign: segmented pool picker, range inputs, grouped technical
  signals with per-group counters, gradient run button, rank medals and score
  tier pills in results.

### Changed

- Main panel window title shortened to 韭菜盒子.

### Removed

- Intraday minute chart from the stock detail view (per user preference).

## [0.1.0] - 2026-08-25

### Added

- Initial release: realtime indices board, quote search + ranking tables,
  persisted watchlist, multi-signal screener with weighted scoring,
  Sina-only 7x24 news feed, stock detail page with minute chart and K-line.
