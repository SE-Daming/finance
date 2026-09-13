# 我的理财看板

个人理财数据看板（占位骨架版），部署于 GitHub Pages：
<https://se-daming.github.io/finance/>

## 功能

- **大盘指数**：上证指数、深证成指、沪深300 实时行情 + 上证近 30 个交易日迷你走势
- **外汇 · 贵金属**：美元人民币、欧元美元、COMEX 黄金、COMEX 白银
- **自选基金 / ETF / 股票**：输入 6 位场内代码添加（如 `161725`、`510300`、`600519`），保存在浏览器 localStorage，可随时移除
- 占位模块：资产总览、收支记录（待接入个人记账数据）

## 技术

纯 HTML / CSS / JavaScript，零依赖、无构建步骤。数据来自腾讯财经公开行情接口，
通过 `<script>` 注入获取（免跨域），每 60 秒自动刷新。

所有资源使用相对路径引用，可部署在任意子路径下。

## 本地运行

```bash
# 任意静态服务器均可，例如：
npx http-server -p 8080
# 然后访问 http://localhost:8080
```

## 数据接口说明

| 用途 | 接口 |
| --- | --- |
| 实时行情 | `https://qt.gtimg.cn/q=sh000001,sz399001,whUSDCNY,hf_GC` |
| 日 K 收盘价 | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_callback=cb&param=sh000001,day,,,30,qfq` |

代码前缀：`sh` 沪市、`sz` 深市、`wh` 外汇、`hf_` 外盘期货（COMEX）。
实时行情返回 GBK 编码的 JS 变量（`v_sh000001="..."`），注入 `<script>` 时需指定 `charset="GBK"`；
字段以 `~` 分隔，股票/指数取 `[1]名称 [3]最新价 [32]涨跌幅`。

行情接口为公开接口，仅供个人参考，不构成投资建议。
