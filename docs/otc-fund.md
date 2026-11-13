# 场外基金模块（dsh-portfolio）

> 本文档是 `dsh-portfolio`（持仓看板）新增子系统的**实现契约**：数据源实测结论、持久化格式、
> HTTP 接口、轮询窗口、指标口径，以及与原始方案不一致的地方（含原因）。
> 代码：`lib/otc-fund.js`、`lib/otc-fund-store.js`、`lib/otc-fund-poller.js`、
> `src/client/otc-fund-tab.js`、`src/client/fund-detail.js`。

---

## 1. 数据源：实测结论（重要）

原方案指定的两个接口**在 2026-11-03 实测已失效**。照抄网络上的旧教程会直接踩空，
这里记录实测结果，避免后人重复排查。

| 接口 | 状态 | 实测现象 |
|---|---|---|
| `http://fundgz.1234567.com.cn/js/{code}.js?callback=jsonpgz` | ✗ **失效** | 所有代码（161616 / 000001 / 110022 / 005827 / 161725）均返回**东财 404 页面 HTML**（`<title>页面未找到 - 东方财富网</title>`），不是 JSONP |
| `http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=..&page=1&per=20` | ✗ **失效** | 返回字面量 `var apidata=`（长度 12 字节，无 `content` / `records`） |
| `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo` | △ **估值字段为空** | 可达，但估值字段 `GSZ/GSZZL/GZTIME` 返回 `null`（今日未发布）；净值字段 `DWJZ/PDATE` 可用 |
| `https://fund.eastmoney.com/{code}.html` | ✗ 不可用 | 前端 SPA 壳，服务端不渲染任何净值/估值 |
| `https://api.fund.eastmoney.com/FundGuZhi/GetFundGZList` | △ 暂无数据 | 返回 `{"Data":null,"ErrCode":-1,"ErrMsg":"暂无数据"}` |
| `https://fund.eastmoney.com/pingzhongdata/{code}.js` | ✓ **可用（主源）** | 含基金名、单位净值全历史、累计净值、阶段收益、经理、规模等 |

### 1.1 主源：pingzhongdata

```
GET https://fund.eastmoney.com/pingzhongdata/{code}.js?v={小时级时间戳}
Headers: User-Agent: <浏览器 UA>
         Referer: https://fund.eastmoney.com/{code}.html
```

- 响应是 **UTF-8 带 BOM**，必须先剥掉 `\uFEFF`，否则第一个 `var` 解析不到。
- 不带 UA / Referer 会被回 404 页面，因此两个头是**必需**的，不是可选优化。
- 内容是一段 JS 赋值脚本，关键变量：

| 变量 | 含义 | 结构 |
|---|---|---|
| `fS_name` / `fS_code` | 基金名 / 代码 | 字符串 |
| `Data_netWorthTrend` | 单位净值全历史 | `[{"x":<epoch ms>,"y":<单位净值>,"equityReturn":<日涨跌>,"unitMoney":""}, ...]` |
| `Data_ACWorthTrend` | 累计净值 | `[[<epoch ms>, <累计净值>], ...]` |
| `Data_fluctuationScale` | 规模走势 | `{"categories":[...],"series":[{"y":<亿元>,"mom":"..."}, ...]}`（**series 与 categories 平行**，不是 `{name,data}` 嵌套） |
| `Data_currentFundManager` | 现任经理 | `[{"name":"...","workTime":"..."}, ...]` |
| `syl_1n/6y/3y/1y` | 近 1 年 / 6 月 / 3 月 / 1 月收益 | 字符串 |

**时间戳口径**：`x` 是「北京日期零点」对应的 UTC 毫秒（如 `2026-11-02` → `1793548800000`）。
解析时必须 `+08:00` 后再读 UTC 字段，不能用宿主本地时区（宿主可能在 UTC 机器上跑）。

**解析方式**：用**括号配平扫描**取值（`parseScalar` + `readLiteral`），不要用
`=\s*([\s\S]*?);` 之类的正则 —— 字段值里本身会带分号与方括号（如
`unitMoney:"每份派现金0.1元"`、基金名含 `;`），非贪婪正则会提前截断，贪婪正则会把
后面的变量一起吃进来。字符串标量也必须按引号配对读取，否则名称里的分号会截断。

### 1.2 估值（盘中估算）与降级链

估值是**可选增强**，按优先级依次尝试，任一路成功即用；全部失败时
`estimateAvailable=false`，`estimateNav` 回落到**已披露净值**，界面显示「已披露」
而不是「估值」。这条降级路径是刻意设计的，不是缺陷。

```
1. GetFundGZList   （批量榜；按 FCODE 命中即用）
2. fundgz JSONP    （站点已下线，解析失败即熔断 10 分钟）
3. FundMNFInfo     （App 接口，取 GSZ/GSZZL/GZTIME）
4. 回落到 latestNav，estimateAvailable=false
```

每一路都带**熔断**：某一路失败后进入冷却期（JSONP 10 分钟 / 榜单 5 分钟），
避免每只基金每次都空等一次超时。榜单结果按 60 秒（盘中）/ 10 分钟（盘后）缓存，
并用单飞合并并发请求。

> 实测备注：2026-11-03 盘中（09:22、09:36 采样）估值榜始终「暂无数据」，
> 即当日全市场均未发布估值。界面此时统一显示「已披露 + 净值日期」，符合预期。

### 1.3 净值兜底

pingzhongdata 不可用时，用 App 接口的官方净值（`DWJZ` / `PDATE`）兜底，
并把 `stale` 标为 `true`；两个源都挂掉则抛中文错误、路由回 502——
**绝不返回一行 0 冒充数据**。

---

## 2. 持久化：`$DSH_HOME/.leekbox-otc-fund.json`

沿用 dsh-leekbox 既有文件风格（`.leekbox-*.json`），不引入 localStorage，
不与 `storage-domain` 混用。

```json
{
  "holdings": {
    "161616": {
      "name": "融通医疗",
      "shares": 10838.90,
      "costNav": 1.9513,
      "lateDisclosure": false
    }
  },
  "order": ["161616"],
  "navSnapshots": {
    "161616": {
      "latestNav": 1.606,
      "latestDate": "2026-11-02",
      "estimateNav": null,
      "estimateTime": "",
      "stale": false,
      "updatedAt": "2026-11-03T09:53:36.000Z"
    }
  },
  "navHistory": {
    "161616:2026-11-02": { "code": "161616", "date": "2026-11-02", "nav": 1.606 }
  }
}
```

| 字段 | 作用 |
|---|---|
| `holdings` | 用户持仓；`shares` 份额、`costNav` 成本净值、`lateDisclosure` 迟到披露标记 |
| `order` | 用户拖拽出的自定义顺序（代码数组）。**不能省掉、不能用 `holdings` 的键序代替**——`holdings` 是字典，`Object.keys()` 对 `"161616"` 这类整数样式键按**数值升序**返回，而不是插入顺序，靠它保存拖拽结果会静默错乱 |
| `navSnapshots` | 轮询器最近一次拉到的净值/估值快照。**当前只写不读**（见下） |
| `navHistory` | 只追加的历史净值点，键为 `{code}:{date}`，**天然幂等**（同日重复写不产生重复行） |

`order` 的三条不变式（读时归一，见 `normalizeOtcFund`）：

1. 只保留 `holdings` 里真实存在的代码（删掉的基金从顺序里摘掉）；
2. 去重；
3. `upsert` 新代码追加到**末尾**、`delete` 从顺序里摘除 —— 都不打乱已有相对顺序。

snapshot 的 `codes` 排序：先按 `order` 里出现过的（且仍在持仓里的）排，剩下没被列进
`order` 的持仓按原顺序补齐在后面 —— **绝不丢行**。

> **`navSnapshots` 目前是只写不读的**：snapshot 端点每次走实时取数链（带缓存与单飞），
> 并不回读这个字段。它的存在价值是留一份**持久化的"最后已知净值"**，便于事后排查、
> 以及将来做"上游全挂时回退到昨夜净值"的降级（届时应把该行标 `stale`）。
> 不要误以为删掉它能省掉一次上游请求 —— 它现在不参与读路径。

**写入约定**：临时文件 + `renameSync` 原子替换（只防半截文件，不防丢更新）；
读-改-写序列用 promise 队列串行化（`withOtcFundLock`），否则并发 mutate 会丢更新。
写入失败返回 `false`，路由据此回 `{ok:false}` —— 不谎报成功。

---

## 3. HTTP 接口

五条路由挂载在 `/api/leekbox/*` 命名空间下，**复用同一套本机信任围栏**
（loopback 地址 + Host 同源 + Origin 本机 + JSON content-type），不自建 `http.Server`。
路由常量集中在 `lib/otc-fund.js` 的 `FUND_ROUTES`，由 `lib/index.js` 展开进 `ROUTES` 总表。

### 3.1 `GET /api/leekbox/otc-fund/snapshot`

可选查询参数：`?codes=161616,005827`（显式查询，最多 50 只；不传则读持仓文件）。

```json
{
  "funds": [
    {
      "code": "161616",
      "name": "融通医疗保健行业混合A/B",
      "shares": 10838.9,
      "costNav": 1.9513,
      "latestNav": 1.606,
      "latestDate": "2026-11-02",
      "estimateNav": 1.606,
      "estimateTime": "",
      "distanceToCostPct": -17.7,
      "unwindProgressPct": -17.7,
      "unwound": false,
      "neededRisePct": 21.5,
      "marketValue": 17407.2734,
      "pnl": -3742.66884,
      "estimateAvailable": false,
      "stale": false
    }
  ],
  "summary": {
    "fundMarketValue": 17407.27,
    "fundTotalPnl": -3742.67,
    "fundTotalCost": 21149.95,
    "fundTotalReturnPct": -17.7
  },
  "updatedAt": "2026-11-03T09:53:36+08:00"
}
```

行的键集合是**固定 16 个**（`code`、`name`、`shares`、`costNav`、`latestNav`、`latestDate`、
`estimateNav`、`estimateTime`、`distanceToCostPct`、`unwindProgressPct`、`unwound`、
`neededRisePct`、`marketValue`、`pnl`、`estimateAvailable`、`stale`），由测试逐键锁定。

- `updatedAt` 固定带 `+08:00` 偏移，浏览器不需要猜时区。
- 行情计算**全部在 Host 半**，Browser 半只渲染，不做计算。
- 单只基金取数失败只影响该行（`stale:true`、数值为 `null`），不会让整页 502。
- **逐行** `marketValue` / `pnl` 是**原始乘积不做舍入**（如 `17407.2734`），
  方便精确比对与求和；**汇总**金额才四舍五入到「分」。
  界面对逐行值自行格式化，不要指望 Host 先帮你抹平浮点尾巴。
- `summary` 固定**四个键**，全部是基金侧口径（**不含股票侧盈亏**）：`fundMarketValue`、
  `fundTotalCost`、`fundTotalPnl`、`fundTotalReturnPct`。本模块不读自选股文件、
  不抓股票行情（早期版本的 `combinedTotalPnl` 会为此额外拉一次腾讯行情，已整体移除）。
  - `fundTotalCost` = Σ(份额 × 成本净值)，与自选页汇总条「成本」同口径；
  - `fundTotalReturnPct` = `fundTotalPnl / fundTotalCost` × 100（两位小数），
    成本未知或为 0 时不给（不除零），与自选页「收益率」同口径。
    界面上的汇总条因此与自选页同构：**市值 / 成本 / 浮动盈亏 / 收益率**。

#### 汇总口径：不知道就说不知道，不给 0

`summary` 的每一项**只有全部输入都算得出来时才给数字**，否则给 `null`
（`fundTotalCost` 只依赖份额与成本净值，取不到净值不影响它）：

| 情形 | `fundMarketValue` / `fundTotalPnl` | `fundTotalCost` | `fundTotalReturnPct` |
|---|---|---|---|
| 没有持仓（确实没买） | `0` ← 这是"知道" | `0` | `null`（成本 0 不做除法） |
| 有持仓，但全部取不到净值 | `null` | 正常给数 | `null` |
| 有持仓，只有部分取到净值 | `null`（**部分和不冒充总额**） | 正常给数 | `null` |
| 全部齐全 | 正常给数 | 正常给数 | 正常给数 |

理由：把"已取到的那几只的和"当总额展示会**低报浮亏**；把"取不到"显示成 `0.00`
会被读成"仓位没了"。界面遇到 `null` 显示 `—`（`fmtAmount(null)` 即返回 `—`），
而不是 `0.00`。同理，**`shares` 缺失时给 `null` 而不是 `0`** —— 0 份会被算成 0 市值、
0 浮盈，把"不知道持多少"伪装成"没有仓位"。

### 3.2 `POST /api/leekbox/otc-fund/mutate`

```json
{ "action": "upsert", "code": "161616", "name": "融通医疗", "shares": 10838.90, "costNav": 1.9513 }
{ "action": "delete", "code": "161616" }
{ "action": "reorder", "codes": ["005827", "161616"] }
```

- 需要 `content-type: application/json`（跨站表单发不出该类型，这道锁挡 CSRF）。
- 不需要二次确认；写入成功后立刻触发一次该基金净值拉取，让界面下一步就拿到新值。
- 返回 `{"ok":true}`；失败返回 `{"ok":false,"error":"<中文>"}`。
- 校验：`shares` 有限且 `0 ≤ shares ≤ 1e10`；`costNav` 有限且 `> 0`（上限 `1e7`）；
  `name` 截断到 40 字。非法输入 400，不静默吞掉。
- `upsert` 的新代码追加到 `order` **末尾**，不打乱用户已排好的顺序。

#### `action: "reorder"` —— 自定义排序

`reorder` 在 `code` 校验**之前**分叉（它不针对单只基金），提交的是**整份顺序**而不是
"把某只移到某只前后"：客户端已持有完整列表，整份提交幂等，重试 / 并发 / 拖拽中断都
不会留下半截顺序。

| 情形 | 状态码 | 说明 |
|---|---|---|
| `codes` 不是数组 | 400 | 排序请求需要 `codes` 数组 |
| 有重复项 | 400 | 顺序里不能有重复代码 |
| 长度与当前持仓数不一致，或含不存在的代码 | 409 | 「基金持仓已变化，请刷新后重试」——不静默只排一部分 |
| 存储层没有 `reorderHoldings` | 501 | 旧存储模块降级保护 |

成功返回 `{"ok":true}`；顺序写在持仓文件的 `order` 键里（见 §2）。

### 3.3 `GET /api/leekbox/otc-fund/history`

详情页的数据源：一只基金的**历史净值** + **阶段涨幅**。

```json
{
  "code": "161616",
  "name": "融通医疗保健行业混合A/B",
  "latestNav": 1.557,
  "latestDate": "2026-11-03",
  "estimateNav": 1.557,
  "estimateTime": "",
  "estimateAvailable": false,
  "stageReturns": { "d1": -3.05, "m1": -15.88, "m3": -8.09, "m6": -7.76, "y1": -10.1, "y3": -18.52, "since": 42.84 },
  "navHistory": [ { "date": "2014-07-11", "nav": 1.09 } ],
  "updatedAt": "2026-11-04T14:02:11+08:00"
}
```

- `stageReturns` 七个区间：`d1` 日涨幅、`m1/m3/m6/y1/y3` 近 N 月/年、`since` 区间以来
  （历史窗口首尾）。**口径固定在 Host**，客户端只渲染，避免两边漂移。
- 每一项是**相对 N 天前净值的涨幅（%）**，与逐行盈亏同口径；历史不足该区间时给 `null`
  而不是 `0`（同「不知道就说不知道」）。
- `navHistory` 为升序 `{date, nav}`，最多保留最近 **3000** 个点（约 12 年），足够算「近 3 年 / 区间以来」。
- 该接口只在打开基金详情（右栏或钻取子页）时按需拉取，不进 30 秒轮询；档案本身走
  `otcFundProfile` 缓存。
- 响应除上表字段外还带 `tracked`（该基金是否在持仓里）与 `fund`（持仓行的完整快照，
  口径与 snapshot 的 `funds[i]` 一致）。份额 / 成本必须从**持仓文件**读，不能信调用方
  传进来的参数：从行情页搜索打开时只有 `{code, name}`，靠它算会让「我的持仓」整片显示 `—`。

### 3.4 `GET /api/leekbox/otc-fund/search`

行情页搜索框查场外基金用。`?q=<代码|名称|拼音首字母>`，空 `q` 直接返回 `{"results":[]}`。

```json
{ "results": [ { "code": "161616", "name": "融通医疗保健行业混合A/B", "type": "混合型-偏股" } ] }
```

- 源为东财 `FundSearchAPI`（`m=1` 返回纯 JSON，不带 JSONP 回调），缓存 5 分钟。
- 该接口对拼音/代码也会返回**股票**（`CATEGORYDESC` 形如「沪市」/「深市」），这里只留
  `CATEGORYDESC` 含「基金」的行，否则股票会被误标成基金。
- 单次最多 20 条。

### 3.5 `GET /api/leekbox/otc-fund/positions`

基金详情页的「最新披露前十大重仓股」。`?code=161616`。

```json
{
  "code": "161616",
  "positions": [
    { "code": "600276", "name": "恒瑞医药", "weight": 8.12, "changeType": "增持",
      "changeVsPrev": 0.34, "exchange": "sh", "price": 52.3, "changePct": 1.24 }
  ],
  "updatedAt": "2026-11-04T14:02:11+08:00"
}
```

- 持仓数据属基金侧，但实时价格来自行情源 —— 行情经 `deps.quoteProvider` 注入，
  本模块不直接抓行情，保持「这里只做场外基金数据」的边界。
- 实时涨跌只对 A 股有意义：港股不在 A 股行情链路里，`price` / `changePct` 给 `null`
  而不编造数值。
- 取不到持仓返回 502，不让整页失败。

### 3.6 错误码

| 码 | 含义 |
|---|---|
| 400 | 参数非法（代码非 6 位数字 / 份额成本越界 / JSON 损坏 / 不支持的 action / `reorder` 的 `codes` 不是数组或有重复项） |
| 403 | 非本机请求，或写请求来自其他站点 |
| 405 | 方法不支持 |
| 409 | `reorder` 提交的顺序与当前持仓集合不一致（持仓已变化，请刷新后重试） |
| 415 | 写请求不是 `application/json` |
| 501 | 存储模块不支持 `reorder`（旧版本降级保护） |
| 502 | 上游取数失败或落盘失败（`error` 为中文文案，`reason` 为技术细节） |

---

## 4. 披露窗口轮询（`lib/otc-fund-poller.js`）

场外基金净值由基金公司在**盘后到凌晨**陆续披露，因此按「披露窗口」伸缩节奏，
而不是整天固定间隔空转。

| 窗口 | 时段（北京时间） | 间隔 |
|---|---|---|
| `closed` | 06:00 – 18:00 | 不轮询 |
| `evening` | 18:00 – 20:00 | 30 分钟 |
| `prime` | 20:00 – 23:00 | 5–10 分钟（区间内随机，避免整点撞车） |
| `late` | **23:00 – 01:00（跨零点）** | 15 分钟 |
| `night` | 01:00 – 06:00 | 60 分钟 |

**跨零点**：`late` 窗口的右边界（01:00）小于左边界（23:00）。写成
`from <= m && m < to` 会让它**永不命中**——这是本模块最容易写错的一处，
实现上写成 `m >= 23:00 || m < 01:00`，两端半开（23:00 含、01:00 不含），
并由 `otc-fund-poller-test.mjs` 做逐分钟扫描验证「全区间无空档」。
所有时刻判定都走 UTC+8，与宿主机时区无关。

**`lateDisclosure`（迟到披露）**：个别基金披露特别晚。对标记了该字段的基金，
在 `night` 窗口把整体节奏从 60 分钟收紧到 15 分钟，**收敛范围仅限 night 窗口**，
不放大 evening / prime / late 的节奏（即「不全局放宽」）。

> **与原方案的偏差（已修正）**：原方案措辞容易被读成「23:00–01:00 只轮询标记过的基金」。
> 最初实现正是这样写的，结果是**未被标记的基金在 23:00 之后静默停止轮询**，
> 而基金公司披露时刻本就参差，漏一次就要等第二天 —— 把「额外照顾」做成了「减少覆盖」。
> 现语义为：**所有窗口都轮询全部持仓**，`lateDisclosure` 只影响 `night` 窗口的节奏。

**定时器治理**：整条链是**单个自续期 `setTimeout`**（不是 `setInterval`，因为每个窗口
间隔不同，且必须每次重新判窗口、不能在边界上吃缓存）；句柄登记在集合里，
`dispose()` 一次性清空并置标志位，正在跑的 refresh 回来后会看到标志位而不再续期。
`dispose()` 幂等。单只失败、读持仓失败都不会让轮询链静默消失。

---

## 5. 指标口径

```
nav              = estimateAvailable ? estimateNav : latestNav
distanceToCostPct= (nav - costNav) / costNav * 100        （四舍五入 2 位小数）
unwindProgressPct= distanceToCostPct                      （两者同值）
unwound          = distanceToCostPct >= 0
neededRisePct    = unwound ? 0 : (costNav - nav) / nav * 100   （四舍五入 2 位小数）
marketValue      = shares * nav                           （不舍入）
pnl              = shares * (nav - costNav)                （不舍入）
```

### `距成本线` 与 `解套需涨` 是两个数，别互相换算

两者**分母不同**，所以数值不相等，也不存在简单的换算关系：

| | 公式 | 含义 |
|---|---|---|
| `distanceToCostPct` | `(nav - costNav) / costNav` | 现在相对成本**亏/赚了多少**（分母是成本） |
| `neededRisePct` | `(costNav - nav) / nav` | 从现价**还要涨多少才回本**（分母是现价） |

真实例子（005827）：净值 1.3817、成本 2.7618 → 亏 **-49.97%**，但要涨 **+99.88%**
才回本。把 `-49.97%` 直接当成"再涨 50% 就解套"是错的 —— 差了近一倍。
两者满足恒等关系 `neededRise = -d / (1 + d/100)`（`d` 为 `distanceToCostPct`）。

- **缺成本净值或净值时，`distanceToCostPct` / `unwindProgressPct` / `neededRisePct`
  返回 `null`，不返回 0**。0 会被界面读成「已解套」，那是假数据。
- 已解套时 `neededRisePct` 是 **`0`（不需要再涨）**，不是负数。
- `costNav <= 0` 或 `nav <= 0` 时不做除法：正常写入路径（API 与 store）都拒绝
  `costNav <= 0`，这里再挡一次，免得手改文件算出 `-100%` 这种垃圾。
- 百分比统一 2 位小数；金额（`summary` 的三个数）到「分」。
- 逐行的 `marketValue` / `pnl` 保持原始乘积不做舍入，便于测试精确比对与求和；
  汇总金额才舍入到分。

> **与交易纪律的关系**：`fund-holdings` skill 的规则是「净值 ≥ 成本线 → 一次性全部赎回」，
> 且明确**只认官方已披露净值、禁止用盘中估值触发交易**。本模块的 `unwound` 与
> `distanceToCostPct` 用的 `nav` **会**在盘中取估值（界面用「估值 / 已披露」徽标区分），
> 因此它适合**看盘与预警，不能直接当作交易触发信号**：真要执行赎回判断时，
> 必须以 `latestNav`（已披露净值）为准，并核对该基金当日是否已披露。

---

## 6. 界面（`src/client/otc-fund-tab.js`）

- 在原有「大盘 / 行情 / 自选 / 选股 / 快讯 / 分析」之后新增**「基金」**标签页，
  原有标签与交互**不改动**。
- 列表行：代码、名称、最新净值（`估值` / `已披露` 徽标 + 时点或净值日期）、
  盈亏百分比（`distanceToCostPct`）、成本、份额、浮盈；
  `stale:true` 显示「数据未更新」。
- 成本 / 份额两列可**点单元格内联编辑**（与自选页持仓、成本列同一套交互）→ `POST mutate`。
- **点基金行 → 右栏联动详情**（页面化后没有浮窗：右栏常驻详情 + ⤢ 钻取子页）：
  单位净值 / 日涨幅、**阶段涨幅**（近 1 月 / 3 月 / 6 月 / 1 年 / 3 年 / 区间以来）、
  净值走势（可切区间，叠加**成本线**）、我的持仓（份额 / 成本 / 市值 / 浮盈 / 盈亏比例）、
  底部**删除持仓**。旧的行内编辑表单已彻底删除。右栏档位收敛周期，完整版（钻取子页）
  另加**阶段涨幅**与**最新披露前十大重仓股**。
- **点表头按列排序**：基金名 / 最新净值 / 盈亏 / 成本 / 份额 / 浮盈 六列，三态
  （升 → 降 → 取消），输出 `aria-sort` 与 ▲/▼/⇅ 箭头，表头可聚焦并支持 Enter / 空格。
- **拖拽行自定义顺序**：顺序整份提交到 `action:"reorder"`，持久化在 `order` 键。
  **按列排序期间拖拽停用**（否则"看到的顺序"与"存下的顺序"会打架），提示条写明原因。
  保存失败时回退本地顺序并提示，不让界面显示一个没存进去的顺序。
- 顶部汇总条：市值 / 成本 / 浮动盈亏 / 收益率（与自选页同构）；只在「基金」
  标签页显示，不反向修改自选标签页。
- 标签页活跃时每 30 秒拉一次 snapshot（读 Host 缓存，成本低）；不活跃时不建表。
- 鼠标悬停在行上出现轻量预览浮窗（`src/client/hover-preview.js`，与自选/行情/选股/大盘
  五个列表同一套）。

---

## 7. 与方案不一致之处汇总

| 方案原文 | 实际实现 | 原因 |
|---|---|---|
| 主源 `fundgz` JSONP，降级到 `FundMNFInfo` | 主源改为 `pingzhongdata`；估值链 4 路 | 方案指定的两个接口均已失效（实测） |
| 历史源 `F10DataApi.aspx?type=lsjz` | 改用 `pingzhongdata` 的 `Data_netWorthTrend` | 该接口返回空 `var apidata=` |
| ~~「`combinedTotalPnl` 复用 dsh-leekbox 已有盈亏汇总逻辑」~~ | **该字段已整体移除**（Host 不再读 watchlist、不再抓股票行情）。若日后需要，上游没有现成函数可调，得自己在 Host 半合并 | 上游的盈亏在客户端算，Host 半没有可复用的汇总函数；且该字段的取数代价是每次 snapshot 多拉一次腾讯行情 |
| `lateDisclosure` 在 23:00–01:00 额外轮询 | 所有窗口轮询全部持仓；`lateDisclosure` 仅收紧 `night` 窗口节奏 | 原写法会让未标记基金在 23:00 后静默停止轮询 |
| 未规定缺失数据的表示 | 缺失一律 `null`，绝不填 0 | 与上游 README「绝不返回假的 0/0」一致 |
| 净值历史仅用于 P1 曲线 | 存储层只追加 `{date, nav}`，端点不返回全量历史 | 保持 snapshot payload 精简；曲线数据由客户端按需扩展 |
| 未规定自定义排序的存储方式 | 持仓文件新增 `order` 键（代码数组），**不用 `holdings` 的字典键序** | 整数样式键（`"161616"`）在 `Object.keys()` 里按数值升序返回，靠字典顺序保存拖拽结果会静默错乱 |
| 未规定排序提交粒度 | 整份顺序提交（`codes` 数组），集合不一致回 409 | 客户端已持完整列表，整份提交幂等，重试/并发/拖拽中断都不留半截顺序 |

---

## 8. 测试

| 套件 | 覆盖 |
|---|---|
| `otc-fund-test.mjs` | pingzhongdata 解析（BOM、括号配平、时区、脏点过滤）、估值链与熔断、净值兜底、指标口径、路由契约/鉴权/降级、缓存与单飞 |
| `otc-fund-store-test.mjs` | 文件读写、原子替换、畸形容忍、并发不丢更新、幂等追加、`order` 累积/摘除/过滤与 `reorderHoldings` 的四种拒绝 |
| `otc-fund-poller-test.mjs` | 五窗口边界、**跨零点逐分钟扫描**、`lateDisclosure` 节奏、dispose 清理、失败不中断 |
| `sort-test.mjs` | 纯函数（三态排序、空值沉底、稳定排序、`moveItem`、`mergeSubsetOrder`）、真调 reorder 路由（409/400/落盘）、真调 store 的 `order` 语义、渲染级断言（`aria-sort` / 箭头 / 键盘） |
| `client-bundle-test.mjs` | 产物 id / React external / 模块导入导出配对（已随重命名更新） |

三个基金套件均为**离线**（网络由 fetch 桩接管），不依赖东财当日是否可用；
`OTC_FUND_LIVE=1` 可额外跑一次真连冒烟。
