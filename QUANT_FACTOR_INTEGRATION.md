# 量化因子选股功能集成报告

## 概述

成功将 aiwuchuan.com 的量化因子选股系统逆向工程并集成到 dsh-leekbox 的选股 tab 中。新增了第四种选股模式「量化因子」，提供 **35 个量化因子**（26 个布尔因子 + 9 个数值因子）和 5 个预设组合。

## 集成内容

### 1. 新增技术指标 (lib/indicators.js)

新增了以下技术指标计算函数：

- **trueRange(klines)** - 真实波幅 (True Range)
- **atr(klines, period=14)** - 平均真实波幅 (Average True Range)
- **tdSequence(closes)** - TD 序列 (DeMark Sequential)
- **candlePatterns(klines)** - K线形态识别（看涨吞没、早晨之星、长上影、长下影、十字星）
- **vwap(klines, period=20)** - 成交量加权平均价 (Volume Weighted Average Price)

### 2. 量化因子系统 (lib/signals.js)

#### 2.1 因子定义 (FACTOR_META)

新增 35 个量化因子（26 个布尔因子 + 9 个数值因子）。`FACTOR_GROUPS` 里只声明 **7 个分组**，全部是布尔因子；数值因子不属任何分组，只服务于条件 DSL，不进勾选面板。

**价格位置 (price)**
- `aboveMa5` - 站上MA5
- `aboveMa10` - 站上MA10
- `aboveMa20` - 站上MA20
- `aboveMa60` - 站上MA60
- `aboveMa120` - 站上MA120
- `nearMa20` - 贴近MA20 (收盘价在MA20上下2%以内)

**动量指标 (momentum)**
- `rsiOversold30` - RSI超卖(<30)
- `rsiOverbought70` - RSI超买(>70)
- `macdGoldenCross` - MACD金叉
- `macdDeathCross` - MACD死叉
- `kdjGoldenCross` - KDJ金叉

**波动率 (volatility)**
- `atrHigh` - ATR偏高 (ATR(14)高于20日均值1.5倍)
- `atrLow` - ATR偏低 (ATR(14)低于20日均值0.7倍)
- `bollSqueeze` - 布林收口 (布林带宽低于20日均值)

**成交量 (volume)**
- `volumeSpike` - 放量(>2倍)
- `volumeShrink` - 缩量(<0.5倍)
- `volumeMaCross` - 量能金叉 (5日均量上穿20日均量)

**形态识别 (pattern)**
- `bullishEngulfing` - 看涨吞没
- `morningStar` - 早晨之星
- `longUpperShadow` - 长上影线
- `longLowerShadow` - 长下影线
- `doji` - 十字星

**TD序列 (td)**
- `tdSetup9` - TD计数9
- `tdCountdown13` - TD计数13

**VWAP (vwap)**
- `aboveVwap` - 站上VWAP
- `belowVwap` - 跌破VWAP

**数值因子 (numeric)** - 不属于 `FACTOR_GROUPS` 的任何分组，只用于条件 DSL；
不能作为「必选因子」提交（服务端会 400），因为必选闸门是 `factors[k] === true`，
而它们取到的是数字。
- `rsiValue` - RSI值
- `macdHistValue` - MACD柱
- `volumeRatioValue` - 量比值
- `atrValue` - ATR值
- `atrPercent` - ATR%
- `changePctValue` - 涨跌幅%
- `turnoverRateValue` - 换手率%
- `priceAboveMa20Pct` - 偏离MA20%
- `bollWidth` - 布林带宽%

#### 2.2 预设组合 (FACTOR_PRESETS)

新增 5 个预设策略组合：

1. **趋势跟踪** - aboveMa20 + aboveMa60 + macdGoldenCross + volumeSpike
2. **超卖反弹** - rsiOversold30 + longLowerShadow + morningStar
3. **突破形态** - bollSqueeze + volumeSpike + aboveMa20
4. **均值回归** - nearMa20 + atrLow + volumeShrink
5. **强势动量** - rsiOverbought70 + volumeSpike + aboveMa5 + aboveMa10 + aboveMa20

#### 2.3 核心函数

- **computeQuantFactors(klines)** - 计算一只票的全部量化因子
- **evaluateFactorCondition(factors, condition)** - 评估量化因子条件
- **matchesFactorPreset(factors, presetKey)** - 检查因子集合是否满足预设策略

### 3. 参数校验 (lib/screener-validate.js)

新增 factor 模式参数校验：

- `factorPresets` - 选中的预设组合列表
- `factorRequire` - 必选因子列表
- `minFactorPresets` - 最少命中组合数（默认 1）
- `minFactorScore` - 最低因子得分（默认 0）

### 4. 筛选逻辑 (lib/screener.js)

新增 factor 模式筛选逻辑：

1. 计算所有量化因子
2. 检查必选因子是否全部满足
3. 检查预设组合命中数是否达到阈值
4. 计算因子得分（命中的因子总数）
5. 返回结果包含：
   - `score` - 因子得分
   - `factors` - 命中的因子列表
   - `matchedPresets` - 命中的预设组合列表

### 5. 缓存键 (lib/screener-cache.js)

更新缓存键以包含因子模式参数：

- `factorPresets` - 预设组合列表
- `factorRequire` - 必选因子列表
- `minFactorPresets` - 最少命中组合数
- `minFactorScore` - 最低因子得分

### 6. 前端 UI (src/client/screener-tab.js)

#### 6.1 模式切换

新增「量化因子」模式按钮，与现有的「评分选股」「多策略交叉」「事件驱动」并列。

#### 6.2 因子选择面板

- **预设组合区** - 勾选预设组合，设置最少命中组合数
- **因子分组区** - 按分组展示所有因子，勾选必选因子
- **因子得分阈值** - 设置最低因子得分

#### 6.3 结果表格

- 显示「因子」列（替代「评分」或「命中」）
- 显示「命中的因子」标签（最多显示 3 个，超出显示 +N）

#### 6.4 离线兜底

服务端元数据获取失败时，使用本地兜底数据：

- `SCREEN_FACTOR_GROUPS_FALLBACK` - 因子分组兜底
- `SCREEN_FACTOR_PRESETS_FALLBACK` - 预设组合兜底
- `FALLBACK_FACTOR_LABELS` - 因子标签兜底

## 使用方法

### 1. 安装与重载

本 fork 是 DSH 插件，没有独立的 `npm start`，也不监听固定端口：

```bash
npm run build                                   # 重新生成 lib/client.js
dsh plugin --profile web add github:HPNY/dsh-portfolio
```

改了 `lib/*.js` 后**只刷新浏览器不够**——宿主进程不会热重载服务端代码，需重启
DSH 或触发一次 profile 重新组合；否则新路由会返回 401/404 且写入静默不落盘。

### 2. 使用量化因子选股

1. 在 DSH 侧栏点「持仓看板」
2. 切到「选股」页签
3. 点击「量化因子」模式按钮
4. 选择预设组合（可选）：
   - 勾选一个或多个预设组合
   - 设置「至少命中组合数」
5. 选择必选因子（可选）：
   - 展开各分组，勾选必须满足的因子（只有 7 个布尔因子分组可选）
6. 设置因子得分阈值（可选）
7. 点击「开始选股」

### 3. 查看结果

结果表格显示：
- 排名、名称、因子得分
- 现价、涨跌幅、换手率、量比
- 命中的因子标签

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  前端 (React)                                            │
│  ┌──────────────────────────────────────────────────┐   │
│  │  screener-tab.js                                  │   │
│  │  - 模式切换 (standard/multi/factor/event)         │   │
│  │  - 因子选择面板                                    │   │
│  │  - 结果展示                                        │   │
│  └──────────────────────────────────────────────────┘   │
│                         │ POST /api/leekbox/screener    │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────┐
│  后端 (Node.js)         │                                │
│  ┌──────────────────────┴────────────────────────────┐  │
│  │  lib/screener.js                                   │  │
│  │  - runScreener()                                   │  │
│  │  - buildResultRow()                                │  │
│  │    └─ if (mode === "factor")                       │  │
│  │       ├─ computeQuantFactors(klines)               │  │
│  │       ├─ 检查必选因子                               │  │
│  │       ├─ 检查预设组合命中数                         │  │
│  │       └─ 计算因子得分                               │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  lib/signals.js                                      │  │
│  │  - FACTOR_META (35 个因子：26 布尔 + 9 数值)        │  │
│  │  - FACTOR_GROUPS (7 个布尔因子分组)                  │  │
│  │  - FACTOR_PRESETS (5 个预设组合)                     │  │
│  │  - computeQuantFactors()                             │  │
│  │  - evaluateFactorCondition()                         │  │
│  │  - matchesFactorPreset()                             │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  lib/indicators.js                                   │  │
│  │  - atr()                                             │  │
│  │  - tdSequence()                                      │  │
│  │  - candlePatterns()                                  │  │
│  │  - vwap()                                            │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## 测试验证

所有测试通过：

```bash
npm test
```

- ✅ 指标数学等价测试
- ✅ 选股缓存测试
- ✅ 元数据单一来源测试
- ✅ 客户端 bundle 契约测试
- ✅ 端到端路由测试

## 文件清单

### 修改的文件

1. `lib/indicators.js` - 新增 5 个技术指标函数
2. `lib/signals.js` - 新增量化因子系统（35 因子 = 26 布尔 + 9 数值、7 个分组、5 预设）
3. `lib/screener-validate.js` - 新增 factor 模式参数校验
4. `lib/screener.js` - 新增 factor 模式筛选逻辑
5. `lib/screener-cache.js` - 更新缓存键
6. `src/client/screener-tab.js` - 新增量化因子 UI

### 生成的文件

1. `lib/client.js` - 重新构建的客户端 bundle（当前 285kb 量级）

## 参考文档

原始逆向分析资料（`逆向分析报告.md`、`实现模板.ts`）在原作者本地，**没有随仓库分发**；
本文件与 `SUMMARY.md` 是仓库内仅有的集成说明。

## 后续优化建议

1. **条件 DSL 完善** - 当前只实现了布尔因子，可以进一步实现数值因子的条件筛选（如 RSI > 70）
2. **因子权重** - 支持为不同因子设置权重，实现加权评分
3. **因子组合保存** - 支持保存用户自定义的因子组合
4. **因子回测** - 支持对因子组合进行历史回测
5. **因子相关性分析** - 分析因子之间的相关性，避免冗余

## 总结

成功将 aiwuchuan.com 的量化因子选股系统集成到 dsh-leekbox，新增了 **35 个量化因子**（26 个布尔 + 9 个数值）、7 个布尔因子分组、5 个预设组合。前端 UI 支持因子选择和预设组合选择，后端实现了完整的筛选逻辑。所有测试通过，功能可用。

> **后续修订（v0.26.4）**：原文写的「8 个分组」是错的——`FACTOR_GROUPS` 一直只有 7 个，
> 第 8 个 `numeric` 组只存在于客户端的离线兜底表里。这处不一致会让离线状态下
> 能勾选数值因子，而引擎的必选闸门是 `factors[k] === true`、数值因子取到的是数字，
> 于是整轮选股被静默筛空。现已从兜底表删除该组，并在服务端对
> 「数值因子作必选」明确返回 400。
