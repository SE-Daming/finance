/* 真实载体验证：把「指数 + 无摩擦」的结论放到真能买的东西上再看一遍
 *
 * 指数回测有三个不真实的地方：不能真买、没有费用、没有跟踪误差。这个脚本换成
 * 基金自己的净值曲线（分红已含在日涨跌幅里，销售服务费/管理费也已扣在净值里）重跑。
 *
 * 为什么**不用**东财日K的「前复权」序列：
 *   同区间 515080 的前复权 ×2.604，而它自己的累计净值只有 ×2.013——前复权把收益虚增了约 29%。
 *   拿它回测会得出「ETF 年化 15%」这种假结论（我第一次跑就中招了）。
 *   月月分红的 ETF 上这个偏差最大，所以统一用净值 + 日涨跌幅复利。
 *
 * 成交价对结论的影响，在 tools/backtest.mjs 里用 sameClose / nextClose 对照回答
 * （指数只有收盘价，本来也没法测开盘成交）。
 *
 * 用法：node tools/backtest-etf.mjs
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const BT = require('../js/backtest.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'backtest');
const load = async (n) => JSON.parse(await readFile(join(CACHE, `${n}.json`), 'utf8'));

const [funds, dy, bond, tr] = await Promise.all([
  load('funds_nav'), load('div_yield'), load('cn10y'), load('csi_tr'),
]);
const dyMap = new Map(dy.map((x) => [x.d, x.dy]));
const bondMap = new Map(bond.map((x) => [x.d, x.y]));

/* 把估值/股息率/国债按日期挂到基金序列上 */
function enrich(rows) {
  let lastBond = null;
  return rows.map((r) => {
    if (bondMap.has(r.d)) lastBond = bondMap.get(r.d);
    return { d: r.d, c: r.c, dy: dyMap.has(r.d) ? dyMap.get(r.d) : null, bond: lastBond };
  });
}

function sma(series, n) {
  const out = new Array(series.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i].c != null) { sum += series[i].c; cnt++; }
    if (i >= n) { sum -= series[i - n].c; cnt--; }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}
function percentile(series, key, W) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (series[i][key] == null) continue;
    const from = Math.max(0, i - W + 1);
    let below = 0, tot = 0;
    for (let j = from; j <= i; j++) {
      if (series[j][key] == null) continue;
      tot++;
      if (series[j][key] < series[i][key]) below++;
    }
    if (tot >= 243) out[i] = below / tot * 100;
  }
  return out;
}

function makeStrategies(series) {
  const ma200 = sma(series, 200);
  const pctDy = percentile(series, 'dy', 2430);
  const out = [];
  out.push({ id: 'S1 均线200', targets: series.map((x, i) => (ma200[i] == null ? 0 : (x.c > ma200[i] ? 1 : 0))) });
  let cur = 0;
  out.push({
    id: 'S3 股息率分位10年 20/80',
    targets: series.map((x, i) => {
      const p = pctDy[i];
      if (p == null) return cur;
      const cheap = 100 - p;
      if (cheap < 20) cur = 1; else if (cheap > 80) cur = 0;
      return cur;
    }),
  });
  out.push({
    id: 'S5 股息率−国债 > 0%',
    targets: series.map((x) => (x.dy == null || x.bond == null ? 0 : ((x.dy - x.bond) > 0 ? 1 : 0))),
  });
  return out;
}

const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const LINE = (label, m) => label.padEnd(32) + pct(m.cagr).padStart(9) + pct(m.mdd).padStart(10) +
  num(m.sharpe).padStart(7) + num(m.calmar).padStart(7) + pct(m.total).padStart(10) +
  String(m.trades).padStart(6) + pct(m.exposure, 0).padStart(7);
const HEAD = '策略'.padEnd(32) + '年化'.padStart(9) + '最大回撤'.padStart(10) + '夏普'.padStart(7) +
  '卡玛'.padStart(7) + '总收益'.padStart(10) + '换手'.padStart(6) + '持仓'.padStart(7);

const LABELS = {
  '515080': '场内 中证红利ETF招商 515080',
  '007801': '场外 大成中证红利指数C 007801',
  '009051': '场外 易方达中证红利ETF联接A 009051',
  '009052': '场外 易方达中证红利ETF联接C 009052',
};

/* 场外/ETF 都按「T 日收盘出信号 → T+1 日收盘成交」，成本 单边 0.1%（申购费上限） */
const COST = 0.001;

for (const code of ['515080', '007801', '009051', '009052']) {
  const nav = funds[code];
  if (!nav || nav.length < 300) { console.log(`${code}: 数据不足，跳过`); continue; }
  const series = enrich(nav.map((x) => ({ d: x.d, c: x.c })));
  /* 用日涨跌幅复利成全收益序列（分红已含），不要用单位净值首尾相除 */
  let acc = 1;
  series.forEach((s, i) => { if (i > 0) acc *= 1 + (nav[i].r || 0) / 100; s.c = acc; });

  const first = nav[0].d, last = nav[nav.length - 1].d;
  console.log('='.repeat(104));
  console.log(`${LABELS[code]}   区间 ${first} ~ ${last}，${nav.length} 个净值点`);
  console.log(`成本：单边 ${(COST * 100).toFixed(1)}%（申购费上限；销售服务费/管理费已扣在净值里）`);
  console.log('='.repeat(104));
  console.log(HEAD);
  const bh = BT.runTiming(series, series.map(() => 1), { costPerSide: COST, exec: 'nextClose' });
  console.log(LINE('买入持有', BT.slice(bh, series, first, last)));
  console.log('');
  for (const st of makeStrategies(series)) {
    const r = BT.runTiming(series, st.targets, { costPerSide: COST, exec: 'nextClose' });
    console.log(LINE(st.id, BT.slice(r, series, first, last)));
  }
  console.log('');
}

console.log('提醒：这几段都只有 6~7 年，且正好是红利资产的大年。任何「持有红利」的策略在这段都好看，');
console.log('      不要拿这段的年化外推。');
