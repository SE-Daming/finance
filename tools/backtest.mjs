/* 中证红利 000922 择时回测
 *
 * 数据：data/backtest/（先跑 node tools/backtest-data.mjs 生成）
 * 引擎：js/backtest.js
 *
 * 必须说清楚的几件事：
 *  1. 全程用**全收益**指数 H00922。用价格指数会把分红当亏损丢掉，中证红利上这是数量级的差别。
 *     反过来说，「空仓期间错过的股息」自动体现在净值里——但我会单独统计出来，
 *     因为那是判断一条择时规则值不值的关键数字。
 *  2. 中证官网的指数接口**只给收盘价**（open/high/low 全是 null），所以全样本只能用
 *     「T 日收盘出信号 → T+1 日收盘成交」。这比开盘成交多滞后一天，但也更保守。
 *  3. 参数扫描**只用于看稳健性**，不用于挑最优。报告里全部列出，包括跑输的。
 *
 * 用法：node tools/backtest.mjs
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

/* 成本：ETF 万1佣金 + 0.05% 滑点，单边 */
const COST = 0.0006;

/* 成交假设：指数接口没有开盘价，只能用收盘成交 */
const EXEC = 'nextClose';

/* 样本切分：2005-2015 训练 / 2016-2026 验证 */
const SPLIT = '2016-01-01';

/* ---------- 组装主序列 ---------- */
const [tr, pr, bond, dy] = await Promise.all([
  load('csi_tr'), load('csi_pr'), load('cn10y'), load('div_yield'),
]);
const bondMap = new Map(bond.map((x) => [x.d, x.y]));
const dyMap = new Map(dy.map((x) => [x.d, x.dy]));
const prMap = new Map(pr.map((x) => [x.d, x.c]));
const trMap = new Map(tr.map((x) => [x.d, x.c]));

/* 每日分红（占价格的比例，%），用于归因 */
const series = [];
for (let i = 0; i < tr.length; i++) {
  const x = tr[i];
  let div = null;
  if (i > 0) {
    const p0 = prMap.get(tr[i - 1].d), p1 = prMap.get(x.d);
    const t0 = trMap.get(tr[i - 1].d), t1 = x.c;
    if (p0 && p1 && t0 && t1) div = (t1 * p0 / t0 - p1) / p1 * 100;
  }
  series.push({
    d: x.d, c: x.c,
    pe: Number.isFinite(x.pe) && x.pe > 0 ? x.pe : null,
    dy: dyMap.has(x.d) ? dyMap.get(x.d) : null,
    bond: bondMap.has(x.d) ? bondMap.get(x.d) : null,
    div,
  });
}
/* 国债收益率只在交易日有，向前填充（它是慢变量） */
let lastBond = null;
for (const s of series) { if (s.bond != null) lastBond = s.bond; else s.bond = lastBond; }

console.log(`主序列 ${series.length} 天：${series[0].d} ~ ${series[series.length - 1].d}`);
console.log(`成本假设：单边 ${(COST * 100).toFixed(2)}%（万1佣金 + 0.05%滑点）`);
console.log(`成交假设：${EXEC}（T 日收盘出信号 → T+1 日收盘成交；指数接口没有开盘价）`);
const firstDy = series.find((s) => s.dy != null);
const withPe = series.filter((s) => s.pe != null);
console.log(`数据覆盖：股息率 ${firstDy ? firstDy.d : '—'} 起，` +
  `PE ${withPe.length ? withPe[0].d : '—'} 起（中证官网 PE 只回溯到 2011）\n`);

/* ---------- 工具：滚动均线、滚动分位、滚动高点 ---------- */
function sma(key, n) {
  const out = new Array(series.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i][key];
    if (v != null) { sum += v; cnt++; }
    if (i >= n) { const old = series[i - n][key]; if (old != null) { sum -= old; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}
/* 滚动分位：当前值在过去 W 天里的百分位（0~100）。W=null 表示扩张窗口 */
function percentile(key, W) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (series[i][key] == null) continue;
    const from = W == null ? 0 : Math.max(0, i - W + 1);
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
function rollingHigh(n) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (i < n - 1) continue;
    let mx = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (series[j].c > mx) mx = series[j].c;
    out[i] = mx;
  }
  return out;
}

/* ---------- 策略工厂：都返回 targets[]，只用当日及以前的数据 ---------- */
const STRATEGIES = [];

/* S1 单均线 */
for (const n of [60, 120, 200]) {
  const ma = sma('c', n);
  STRATEGIES.push({
    id: `S1 均线${n}`, fam: 'S1 单均线',
    targets: series.map((x, i) => (ma[i] == null ? 0 : (x.c > ma[i] ? 1 : 0))),
  });
}

/* S2 双均线 */
for (const [f, s] of [[10, 60], [20, 60], [20, 120], [30, 200]]) {
  const mf = sma('c', f), ms = sma('c', s);
  STRATEGIES.push({
    id: `S2 双均线${f}/${s}`, fam: 'S2 双均线',
    targets: series.map((x, i) => (mf[i] == null || ms[i] == null ? 0 : (mf[i] > ms[i] ? 1 : 0))),
  });
}

/* S3 估值分位：便宜买、贵卖。股息率越高越便宜，所以方向相反 */
for (const [key, label] of [['pe', 'PE'], ['dy', '股息率']]) {
  for (const [W, wl] of [[1215, '5年'], [2430, '10年'], [null, '全历史']]) {
    const pct = percentile(key, W);
    for (const [lo, hi] of [[20, 80], [30, 70], [10, 90]]) {
      const cheapIsLow = key === 'pe';
      let cur = 0;
      const filled = series.map((x, i) => {
        const p = pct[i];
        if (p == null) return cur;
        const cheapPct = cheapIsLow ? p : 100 - p;
        if (cheapPct < lo) cur = 1;
        else if (cheapPct > hi) cur = 0;
        return cur;                      /* 中间维持原仓位 */
      });
      STRATEGIES.push({ id: `S3 ${label}分位${wl} ${lo}/${hi}`, fam: 'S3 估值分位', targets: filled });
    }
  }
}

/* S4 回撤买入 + 年线卖出 */
{
  const ma200 = sma('c', 200);
  for (const n of [60, 120, 250]) {
    const hi = rollingHigh(n);
    for (const X of [5, 10, 15]) {
      let cur = 0;
      const filled = series.map((x, i) => {
        if (hi[i] == null || ma200[i] == null) return cur;
        const dd = (x.c / hi[i] - 1) * 100;
        if (dd <= -X) cur = 1;              // 回撤够了就买
        else if (x.c < ma200[i]) cur = 0;   // 跌破年线就卖
        return cur;
      });
      STRATEGIES.push({ id: `S4 回撤${X}%买/MA200卖 (高点${n}日)`, fam: 'S4 回撤买入', targets: filled });
    }
  }
}

/* S5 股债性价比：股息率 − 10年国债 */
for (const th of [0, 1, 2]) {
  STRATEGIES.push({
    id: `S5 股息率−国债 > ${th}%`, fam: 'S5 股债性价比',
    targets: series.map((x) => (x.dy == null || x.bond == null ? 0 : ((x.dy - x.bond) > th ? 1 : 0))),
  });
}

/* ---------- 基准 ---------- */
const bh = BT.buyHold(series, { costPerSide: COST, exec: EXEC });

/* ---------- 输出 ---------- */
const WINDOWS = [
  ['全样本', '2004-12-31', '2026-10-09'],
  ['训练 05-15', '2004-12-31', '2015-12-31'],
  ['验证 16-26', SPLIT, '2026-10-09'],
];

const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

function fmtRow(label, m) {
  return label.padEnd(28) +
    pct(m.cagr).padStart(9) +
    pct(m.mdd).padStart(10) +
    num(m.sharpe).padStart(7) +
    num(m.calmar).padStart(7) +
    pct(m.total).padStart(10) +
    String(m.trades).padStart(6) +
    pct(m.exposure, 0).padStart(7) +
    (m.winRate == null ? '—' : pct(m.winRate, 0)).padStart(7) +
    (m.profitFactor == null ? '—' : num(m.profitFactor)).padStart(8);
}
const HEAD = '策略'.padEnd(28) + '年化'.padStart(9) + '最大回撤'.padStart(10) +
  '夏普'.padStart(7) + '卡玛'.padStart(7) + '总收益'.padStart(10) +
  '换手'.padStart(6) + '持仓'.padStart(7) + '胜率'.padStart(7) + '盈亏比'.padStart(8);

const results = {};
console.log('='.repeat(118));
console.log('基准');
console.log('='.repeat(118));
console.log(HEAD);
for (const [wl, a, b] of WINDOWS) {
  const m = BT.slice(bh, series, a, b);
  console.log(fmtRow(`买入持有 · ${wl}`, m));
  results[`买入持有 · ${wl}`] = m;
}

for (const fam of ['S1 单均线', 'S2 双均线', 'S3 估值分位', 'S4 回撤买入', 'S5 股债性价比']) {
  const group = STRATEGIES.filter((s) => s.fam === fam);
  console.log('\n' + '='.repeat(118));
  console.log(fam);
  console.log('='.repeat(118));
  console.log(HEAD);
  for (const st of group) {
    const r = BT.runTiming(series, st.targets, { costPerSide: COST, exec: EXEC });
    for (const [wl, a, b] of WINDOWS) {
      const m = BT.slice(r, series, a, b);
      console.log(fmtRow(st.id + (wl === '全样本' ? '' : ` [${wl}]`), m));
      results[st.id + ' · ' + wl] = m;
    }
    results[st.id + ' · 归因'] = { divHeld: r.metrics.divHeld, divMissed: r.metrics.divMissed, cost: r.metrics.costPaid };
    console.log('');
  }
}

/* ---------- 归因 ---------- */
console.log('='.repeat(118));
console.log('归因（全样本累计，单位：百分点）—— 择时值不值，先看这里');
console.log('='.repeat(118));
console.log('策略'.padEnd(28) + '持仓期吃到的分红'.padStart(18) + '空仓期错过的分红'.padStart(20) + '累计成本'.padStart(12));
for (const st of STRATEGIES) {
  const a = results[st.id + ' · 归因'];
  console.log(st.id.padEnd(28) + num(a.divHeld).padStart(18) + num(a.divMissed).padStart(20) +
    num(a.cost * 100).padStart(12));
}
console.log('买入持有'.padEnd(28) + num(bh.metrics.divHeld).padStart(18) + num(0).padStart(20) +
  num(bh.metrics.costPaid * 100).padStart(12));

console.log('\n说明：验证期（2016 年起）才是判断依据，训练期只用来看规律是否稳定。');
console.log('      全样本 22 年含 2005-2013 的指数回溯段（000922 发布前），那段偏乐观。');

/* ---------- 成交假设敏感性：这是指数数据唯一能回答「成交价有多重要」的方式 ---------- */
console.log('\n' + '='.repeat(118));
console.log('成交假设敏感性：sameClose（信号当日收盘成交，偏乐观）vs nextClose（次日收盘，正文采用）');
console.log('='.repeat(118));
console.log('策略'.padEnd(28) + 'sameClose 年化'.padStart(16) + 'nextClose 年化'.padStart(16) +
  '差（年化）'.padStart(12) + '   验证期 same/next');
for (const st of STRATEGIES.filter((s) => ['S1 均线60', 'S1 均线200', 'S2 双均线10/60',
  'S3 股息率分位10年 20/80', 'S5 股息率−国债 > 0%'].includes(s.id))) {
  const a = BT.runTiming(series, st.targets, { costPerSide: COST, exec: 'sameClose' });
  const b = BT.runTiming(series, st.targets, { costPerSide: COST, exec: 'nextClose' });
  const ma = BT.slice(a, series, '2004-12-31', '2026-10-09');
  const mb = BT.slice(b, series, '2004-12-31', '2026-10-09');
  const va = BT.slice(a, series, SPLIT, '2026-10-09');
  const vb = BT.slice(b, series, SPLIT, '2026-10-09');
  console.log(st.id.padEnd(28) + pct(ma.cagr).padStart(16) + pct(mb.cagr).padStart(16) +
    pct(ma.cagr - mb.cagr).padStart(12) + `   ${pct(va.cagr)} / ${pct(vb.cagr)}`);
}
const bhS = BT.runTiming(series, series.map(() => 1), { costPerSide: COST, exec: 'sameClose' });
const bhN = BT.runTiming(series, series.map(() => 1), { costPerSide: COST, exec: 'nextClose' });
console.log('买入持有'.padEnd(28) +
  pct(BT.slice(bhS, series, '2004-12-31', '2026-10-09').cagr).padStart(16) +
  pct(BT.slice(bhN, series, '2004-12-31', '2026-10-09').cagr).padStart(16) +
  pct(0).padStart(12) + '   （买入持有不受成交假设影响，作对照）');
