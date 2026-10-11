/* 回测数据抓取：把四个来源拉下来缓存到 data/backtest/，之后回测完全离线可跑。
 *
 * 四个来源（都实地验证过）：
 *   1. 中证红利全收益 H00922 + 价格 000922 —— 中证指数官网 index-perf
 *      全收益自带分红，是回测的正确口径；价格指数只用来反推股息率
 *   2. 股息率 —— 不外部取，用「全收益 ÷ 价格」的比值变化反推（实测中位数 3.8%，落在合理区间）
 *   3. 中证红利ETF 515080 前复权 —— 东财 push2his，用来验证「扣掉费用还能不能赚」
 *   4. 10 年期国债收益率 —— 东财 datacenter RPTA_WEB_TREASURYYIELD 的 EMM00166466
 *      （列名是 EMM 编码，靠恒等式 EMM00166466 − EMM00588704 = EMM01276014 证死的）
 *
 * 用法：node tools/backtest-data.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, 'data', 'backtest');
const UA = 'Mozilla/5.0';                       // 短 UA：东财的接口认这个
const BEGIN = '20041231';
const END = '20261009';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 中证指数官网 ---------- */
async function csindex(code) {
  const u = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${code}` +
    `&startDate=${BEGIN}&endDate=${END}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.data || !j.data.length) throw new Error(`没有数据（${j.msg || ''}）`);
  return j.data.map((d) => ({
    d: `${d.tradeDate.slice(0, 4)}-${d.tradeDate.slice(4, 6)}-${d.tradeDate.slice(6, 8)}`,
    o: d.open, h: d.high, l: d.low, c: d.close, pe: d.peg,
  })).filter((x) => x.c > 0);
}

/* ---------- 2. 东财 push2his（ETF 前复权） ---------- */
async function etfKline(secid) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=0&end=20500101`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' } });
  const j = await r.json();
  const k = (j.data && j.data.klines) || [];
  if (!k.length) throw new Error('没有 K 线');
  return k.map((s) => {
    const p = s.split(',');
    return { d: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] };
  });
}

/* ---------- 3. 10 年期国债收益率（分页） ---------- */
async function cn10y() {
  const out = [];
  let page = 1, pages = 1;
  while (page <= pages) {
    const u = `https://datacenter.eastmoney.com/api/data/get?type=RPTA_WEB_TREASURYYIELD` +
      `&sty=ALL&st=SOLAR_DATE&sr=-1&p=${page}&ps=500`;
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' } });
    const j = await r.json();
    if (!j.result || !j.result.data) throw new Error('没有数据');
    pages = j.result.pages;
    for (const row of j.result.data) {
      const y = row.EMM00166466;                 // 已证：中国 10 年期国债收益率
      if (typeof y === 'number' && y > 0) out.push({ d: row.SOLAR_DATE.slice(0, 10), y });
    }
    process.stdout.write(`\r  国债收益率 第 ${page}/${pages} 页，累计 ${out.length} 天`);
    page++;
    await sleep(250);
  }
  console.log('');
  return out.sort((a, b) => (a.d < b.d ? -1 : 1));
}

/* ---------- 4. 场外基金净值（做费用校验用） ---------- */
async function fundNav(code) {
  const r = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, { headers: { 'User-Agent': UA } });
  const t = await r.text();
  const m = t.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) throw new Error('没有净值走势');
  const toD = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
  return JSON.parse(m[1]).filter((x) => x.y > 0).map((x) => ({ d: toD(x.x), nav: x.y, r: x.equityReturn }));
}

/* ---------- 跑 ---------- */
await mkdir(OUTDIR, { recursive: true });
const meta = { fetchedAt: new Date().toISOString(), sources: {} };
const save = async (name, obj, note) => {
  await writeFile(join(OUTDIR, `${name}.json`), JSON.stringify(obj), 'utf8');
  meta.sources[name] = note;
  console.log(`  ✓ ${name}.json`);
};

console.log('抓取回测数据 →', OUTDIR, '\n');

console.log('[1/5] 中证红利全收益 H00922');
const tr = await csindex('H00922');
console.log(`  ${tr.length} 天，${tr[0].d} ~ ${tr[tr.length - 1].d}`);
await save('csi_tr', tr, '中证红利全收益指数 H00922，2004-12-31 起，中证指数官网');

console.log('[2/5] 中证红利价格 000922');
const pr = await csindex('000922');
console.log(`  ${pr.length} 天，${pr[0].d} ~ ${pr[pr.length - 1].d}`);
await save('csi_pr', pr, '中证红利价格指数 000922，同上');

console.log('[3/5] 中证红利ETF 515080（前复权）');
const etf = await etfKline('1.515080');
console.log(`  ${etf.length} 根，${etf[0].d} ~ ${etf[etf.length - 1].d}`);
await save('etf_515080', etf, '中证红利ETF招商 515080 前复权日线，东财 push2his');

console.log('[4/5] 10 年期国债收益率');
const bond = await cn10y();
console.log(`  ${bond.length} 天，${bond[0].d} ~ ${bond[bond.length - 1].d}`);
await save('cn10y', bond, '中国 10 年期国债收益率，东财 RPTA_WEB_TREASURYYIELD 的 EMM00166466');

console.log('[5/5] 基金/ETF 自身净值（费用与可交易性验证）');
const funds = {};
/* 515080 也走净值口径，不走东财日K的「前复权」：同区间 515080 的前复权 ×2.604、
 * 而它自己的累计净值只有 ×2.013，前复权把收益虚增了约 29%（月月分红类 ETF 上尤其离谱）。
 * 拿它回测会得出「ETF 年化 15%」这种假结论，所以统一用净值 + 日涨跌幅。 */
for (const code of ['515080', '007801', '009051', '009052']) {
  funds[code] = await fundNav(code);
  console.log(`  ${code}: ${funds[code].length} 点，${funds[code][0].d} ~ ${funds[code][funds[code].length - 1].d}`);
  await sleep(300);
}
await save('funds_nav', funds, '基金自身净值 + 日涨跌幅（分红已含），pingzhongdata。回测一律用它，不用日K前复权');

/* 派生：股息率 = 过去 243 个交易日的已实现分红 ÷ 当前价格指数
 *
 * 不能逐日做差。全收益和价格的日收益之差只有 0.016%/天（4%÷243），而指数点位只给到
 * 两位小数（5000 点上下即 0.02% 的粒度），逐日做差会被四舍五入噪声整个淹没——
 * 实测中位数 0.01%、区间 ±200%，全是噪声。
 *
 * 正确做法：先把每日分红还原成「点数」，再做 243 日滚动求和，最后除以当前点位。
 * 每日分红（点数） D_t = TR_t × PR_{t-1} / TR_{t-1} − PR_t
 *   （分红再投口径下 TR_t = TR_{t-1} × (PR_t + D_t) / PR_{t-1}）
 * 单日 D 的噪声约 ±0.005 点，243 日累积后随机误差按 √243 抵消，量级可忽略。 */
const prMap = new Map(pr.map((x) => [x.d, x.c]));
const trMap = new Map(tr.map((x) => [x.d, x.c]));
const dailyDiv = [];                       // [{d, dpt, pr}]，dpt 是当日分红（指数点数）
for (let i = 1; i < tr.length; i++) {
  const d = tr[i].d, dPrev = tr[i - 1].d;
  const p0 = prMap.get(dPrev), p1 = prMap.get(d);
  const t0 = trMap.get(dPrev), t1 = trMap.get(d);
  if (!p0 || !p1 || !t0 || !t1) continue;
  dailyDiv.push({ d, dpt: t1 * p0 / t0 - p1, pr: p1 });
}
const WINDOW = 243;
const dy = [];
let sum = 0;
for (let i = 0; i < dailyDiv.length; i++) {
  sum += dailyDiv[i].dpt;
  if (i >= WINDOW) sum -= dailyDiv[i - WINDOW].dpt;
  if (i >= WINDOW - 1) dy.push({ d: dailyDiv[i].d, dy: sum / dailyDiv[i].pr * 100 });
}
await save('div_yield', dy, `股息率（年化%）= 过去 ${WINDOW} 个交易日已实现分红 ÷ 当前价格指数，自行反推`);
await writeFile(join(OUTDIR, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8');

/* ---------- 体检 ---------- */
console.log('\n=== 数据体检 ===');
const align = (a, b, key) => {
  const bm = new Map(b.map((x) => [x.d, x]));
  return a.filter((x) => bm.has(x.d)).length;
};
console.log(`全收益 与 价格 共同交易日: ${align(tr, pr)}`);
console.log(`全收益 与 国债   共同交易日: ${align(tr, bond)}`);
const dymed = dy.map((x) => x.dy).sort((a, b) => a - b);
console.log(`股息率 中位数 ${dymed[Math.floor(dymed.length / 2)].toFixed(2)}%，` +
  `区间 ${dymed[0].toFixed(2)}% ~ ${dymed[dymed.length - 1].toFixed(2)}%`);
const yv = bond.map((x) => x.y);
console.log(`10年国债 区间 ${Math.min(...yv).toFixed(2)}% ~ ${Math.max(...yv).toFixed(2)}%，` +
  `最新 ${bond[bond.length - 1].y.toFixed(2)}%`);
console.log(`\n✓ 缓存写入 ${OUTDIR}`);
