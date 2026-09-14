/* 生成 data/returns.json —— 各基金的区间收益率 + 推算持仓
 *
 * 页面本身不联网取净值：天天基金的净值接口每家整包 250~560 KB，二十多只就是
 * 8 MB，页面里拉不动。所以改成在这里预生成一个小 JSON，页面只读那几 KB。
 *
 * 用法：node tools/update-returns.mjs
 * 数据源：https://fund.eastmoney.com/pingzhongdata/{6位代码}.js
 *
 * 两件事：
 *   1. 区间收益 —— 用官方日涨跌幅（equityReturn）逐日复利，而不是拿首尾单位
 *      净值相除：后者遇到分红会把净值砸下去，算出假的暴跌。equityReturn 本身
 *      已含分红再投。
 *   2. 推算持仓 —— 以 holdings.md 的「快照日期」为锚，用净值序列把市值滚到
 *      最新净值日，期间按「每日定投金额」逐日买入。见 project() 的注释。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS = join(ROOT, 'data', 'holdings.md');
const OUTPUT = join(ROOT, 'data', 'returns.json');

/* 表头里出现其中之一，才认作持仓表（和前端 pickHoldingsTable 同一套规则） */
const MARKER_COLS = ['类别', '基金名称', '持有金额', '持有收益', '每日定投金额', '投入本金', '累计定投'];
/* 区间窗口：键名 → 天数/月数（月按日历月算） */
const WINDOWS = [
  ['r1w', { days: 7 }],
  ['r1m', { months: 1 }],
  ['r3m', { months: 3 }],
  ['r6m', { months: 6 }],
  ['r1y', { months: 12 }],
];

const normKey = (s) => String(s == null ? '' : s).replace(/[\s　／/]/g, '');
const round2 = (v) => Math.round(v * 100) / 100;

/* "1504.94" / "+8.89" / "-1.00%" 取数；"—"、空、非数 一律 null */
function num(s) {
  const t = String(s == null ? '' : s).replace(/[^0-9.+-]/g, '');
  if (!/[0-9]/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

/* 从 "50 元/天" 取每日金额；"按两笔各 500 计" 取不到 → null */
function parseDaily(s) {
  const m = String(s == null ? '' : s).match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*天/);
  return m ? parseFloat(m[1]) : null;
}

/* ---------- 读 holdings.md ---------- */

function parseMdTables(md) {
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const cells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());

  const tables = [];
  let cur = null;
  for (const line of lines) {
    if (line.charAt(0) !== '|') { cur = null; continue; }
    const c = cells(line);
    if (c.every((x) => x === '')) continue;
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
    if (cur) cur.rows.push(c);
    else tables.push((cur = { header: c, rows: [] }));
  }
  return tables;
}

function pickHoldingsTable(md) {
  const tables = parseMdTables(md);
  for (const t of tables) {
    if (t.header.some((h) => MARKER_COLS.includes(normKey(h)))) return t;
  }
  return { header: [], rows: [] };
}

function colIdx(header, name) {
  const want = normKey(name);
  return header.findIndex((h) => normKey(h) === want);
}

/* 「快照日期：2026-09-13」——整行匹配，免得正文里提到也命中 */
const SNAPSHOT_RE = /^\s*快照日期[：:]\s*(\d{4}-\d{2}-\d{2})\s*$/m;

async function readHoldings() {
  const md = await readFile(HOLDINGS, 'utf8');
  const tbl = pickHoldingsTable(md);
  if (!tbl.rows.length) throw new Error('data/holdings.md 里没找到持仓表格');

  const ci = {
    code: colIdx(tbl.header, '代码'),
    name: colIdx(tbl.header, '基金名称'),
    daily: colIdx(tbl.header, '每日定投金额'),
    cumulative: colIdx(tbl.header, '累计定投'),
    capital: colIdx(tbl.header, '投入本金'),
    amount: colIdx(tbl.header, '持有金额'),
    profit: colIdx(tbl.header, '持有收益'),
    rateIn: colIdx(tbl.header, '持仓收益率'),
  };
  if (ci.code < 0) throw new Error('持仓表里没有「代码」列，无法取净值');

  const snapMatch = md.match(SNAPSHOT_RE);
  const snapshotDate = snapMatch ? snapMatch[1] : null;

  const cell = (row, i) => (i < 0 || row[i] == null ? '' : row[i]);
  const funds = [];
  const seen = new Set();
  for (const row of tbl.rows) {
    const code = cell(row, ci.code).trim();
    if (!/^\d{6}$/.test(code)) continue;          // 空 / "—" 的行跳过
    if (seen.has(code)) continue;
    seen.add(code);

    let amount = num(cell(row, ci.amount));
    const profit = num(cell(row, ci.profit));
    const capital = num(cell(row, ci.capital));
    const rateIn = num(cell(row, ci.rateIn));
    if (amount == null && capital != null && profit != null) amount = capital + profit;

    /* 快照成本：和前端 metrics() 同一套算法 */
    let cost = null;
    if (amount != null) {
      if (profit != null) cost = amount - profit;
      else if (rateIn != null && rateIn !== -100) cost = amount / (1 + rateIn / 100);
    }

    funds.push({
      code,
      name: cell(row, ci.name).trim(),
      daily: parseDaily(cell(row, ci.daily)) || 0,
      cumulative: num(cell(row, ci.cumulative)),
      snapAmount: amount,
      snapCost: cost,
    });
  }
  return { funds, snapshotDate };
}

/* ---------- 拉净值 ---------- */

/* 时间戳是北京时间当天零点，直接用 toISOString 会倒回前一天，所以先补 8 小时 */
const toDate = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function fetchTrend(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  const nameMatch = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  const trendMatch = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!trendMatch) throw new Error('没找到净值走势数据');

  const raw = JSON.parse(trendMatch[1]);
  const trend = raw
    .filter((d) => d && typeof d.x === 'number' && typeof d.equityReturn === 'number' && d.y > 0)
    .map((d) => ({ date: toDate(d.x), eq: d.equityReturn, nav: d.y }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { name: nameMatch ? nameMatch[1] : '', trend };
}

/* 从 fromIdx 复利到 toIdx：区间收益 = Π(1 + eq/100) − 1 */
function compound(trend, fromIdx, toIdx) {
  let acc = 1;
  for (let i = fromIdx; i <= toIdx; i++) acc *= 1 + trend[i].eq / 100;
  return (acc - 1) * 100;
}

/* 找最后一个日期 ≤ target 的下标；找不到（基金比窗口还年轻）返回 -1 */
function lastIndexUpTo(trend, target) {
  let lo = 0, hi = trend.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trend[mid].date <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function shiftMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

function shiftDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

function computeReturns(trend) {
  const n = trend.length;
  if (n < 2) return { navDate: n ? trend[0].date : null };

  const lastIdx = n - 1;
  const navDate = trend[lastIdx].date;
  const out = { navDate, r1d: round2(trend[lastIdx].eq) };

  for (const [key, win] of WINDOWS) {
    const target = win.days ? shiftDays(navDate, win.days) : shiftMonths(navDate, win.months);
    const idx = lastIndexUpTo(trend, target);
    out[key] = idx >= 0 ? round2(compound(trend, idx + 1, lastIdx)) : null;
  }
  return out;
}

/* ---------- 推算持仓 ----------
 *
 * 拿快照当锚，用净值把持仓滚到今天：
 *
 *   锚点净值 nav0 = 快照日期当天（或之前最近一天）的净值
 *   份额 shares = 快照市值 ÷ nav0          ← 快照那天的份额
 *   之后每有一个净值日，就按每日定投买进 金额 ÷ 当日净值 份，成本同步累加
 *   推算市值 = 最终份额 × 最新净值
 *
 * 为什么不能只拿「快照市值 × 区间涨幅」：那等于假设新投的钱在期初就到位了。
 * 定投是一天天买进去的，越晚买的钱吃到的涨幅越少——尤其回调行情里差别明显。
 *
 * 误差来源：实际扣款未必每个净值日都成功（QDII 有额度限制、美股节假日与 A 股
 * 不同步），所以推算值会慢慢偏离真实持仓。定期从 App 复制一份新快照、更新
 * holdings.md 的「快照日期」就能重新锚定。
 */
function project(trend, snap) {
  if (snap.snapAmount == null || snap.snapCost == null) return null;

  const anchorIdx = lastIndexUpTo(trend, snap.snapshotDate);
  if (anchorIdx < 0) return null;                 // 基金比快照日期还年轻
  const nav0 = trend[anchorIdx].nav;
  if (!(nav0 > 0)) return null;

  let shares = snap.snapAmount / nav0;
  let cost = snap.snapCost;
  let cumulative = snap.cumulative;

  for (let i = anchorIdx + 1; i < trend.length; i++) {
    if (snap.daily > 0) {
      shares += snap.daily / trend[i].nav;
      cost += snap.daily;
      if (cumulative != null) cumulative += snap.daily;
    }
  }

  const lastIdx = trend.length - 1;
  const amount = shares * trend[lastIdx].nav;
  const profit = amount - cost;

  return {
    amount: round2(amount),
    cost: round2(cost),
    profit: round2(profit),
    /* rate 不在这里取整：取整后再乘 100 会和「没推算时」的显示差 0.01% */
    rate: cost ? profit / cost : null,
    cumulative: cumulative == null ? null : round2(cumulative),
    navDate: trend[lastIdx].date,
    anchorDate: trend[anchorIdx].date,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 接口偶尔会抖，抖一次就丢一只基金。每日定时任务没人看着，重试几把 */
async function fetchTrendRetry(code, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchTrend(code);
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

/* 一次拉几只，别把人家接口打爆 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/* ---------- 主流程 ---------- */

const { funds, snapshotDate } = await readHoldings();
console.log(`从 holdings.md 读到 ${funds.length} 只基金，开始拉净值…`);
console.log(snapshotDate ? `快照日期：${snapshotDate}\n` : '（没有「快照日期」，本次只算区间收益，不推算持仓）\n');

const results = await mapLimit(funds, 5, async (f) => {
  try {
    const { trend } = await fetchTrendRetry(f.code);
    const r = computeReturns(trend);
    const projected = snapshotDate
      ? project(trend, { ...f, snapshotDate })
      : null;
    return { ...f, ...r, projected };
  } catch (err) {
    return { ...f, error: err.message };
  }
});

/* 缺一只就不写文件：宁可让看板停在上一份完整数据上，也不能发出一个少了几只的版本——
 * 缺的那只会在页面上丢掉区间收益、持仓还会退回手写快照。定时任务没人盯着，静默降级最危险 */
const failedList = results.filter((r) => r.error);
if (failedList.length) {
  console.error(`\n✗ ${failedList.length}/${results.length} 只基金拉不到净值，本次不写 data/returns.json：`);
  for (const r of failedList) console.error(`    ${r.code} ${r.name} —— ${r.error}`);
  console.error('  看板会继续用上一份完整数据，明天定时任务会再试。');
  process.exit(1);
}

/* 结果表，顺便肉眼核对：同类基金的区间收益应该很接近 */
const pct = (v) => (v == null ? '  —   ' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
console.log('代码     1日      1周      1月      3月      6月      1年      净值日期    基金名称');
console.log('─'.repeat(110));
for (const r of results) {
  console.log(
    r.code + '  ' +
    [r.r1d, r.r1w, r.r1m, r.r3m, r.r6m, r.r1y].map((v) => pct(v).padStart(7)).join(' ') + '  ' +
    (r.navDate || '    —     ') + '  ' + r.name
  );
}

/* 推算持仓的对比表：快照 → 推算 */
const proj = results.filter((r) => r.projected);
if (proj.length) {
  const money = (v) => (v == null ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  console.log('\n推算持仓（快照 → 最新净值日）');
  console.log('代码     快照市值     推算市值     差额      快照收益率  推算收益率   截止        基金名称');
  console.log('─'.repeat(110));
  let sumSnap = 0, sumProj = 0;
  for (const r of proj) {
    const p = r.projected;
    sumSnap += r.snapAmount;
    sumProj += p.amount;
    const snapRate = r.snapCost ? (r.snapAmount - r.snapCost) / r.snapCost : null;
    console.log(
      r.code + '  ' + money(r.snapAmount).padStart(12) + ' ' + money(p.amount).padStart(12) + ' ' +
      money(p.amount - r.snapAmount).padStart(9) + '  ' +
      (snapRate == null ? '   —   ' : pct(snapRate * 100)).padStart(9) + '  ' +
      (p.rate == null ? '   —   ' : pct(p.rate * 100)).padStart(9) + '  ' +
      p.navDate + '  ' + r.name
    );
  }
  console.log('─'.repeat(110));
  console.log('合计        ' + money(sumSnap).padStart(12) + ' ' + money(sumProj).padStart(12) + ' ' +
    money(sumProj - sumSnap).padStart(9));
} else if (snapshotDate) {
  console.log('\n没有可推算的持仓（表里缺「持有金额」或「持有收益/持仓收益率」）。');
}

const asOf = results.map((r) => r.navDate).filter(Boolean).sort().pop() || null;

/* 故意不写「生成时间」：每日定时任务靠 git diff 判断要不要提交，一个每次都变的
 * 时间戳会让它天天提交空变更。要知道什么时候生成的，看那条提交的时间即可 */
const payload = {
  asOf,
  note: '由 tools/update-returns.mjs 生成。区间收益按官方日涨跌幅逐日复利，已含分红再投。',
  funds: Object.fromEntries(results.map((r) => [r.code, {
    name: r.name, navDate: r.navDate,
    r1d: r.r1d, r1w: r.r1w, r1m: r.r1m, r3m: r.r3m, r6m: r.r6m, r1y: r.r1y,
    projected: r.projected || null,
  }])),
};

if (snapshotDate && proj.length) {
  payload.projection = {
    snapshotDate,
    asOf: proj.map((r) => r.projected.navDate).sort().pop(),
    funds: proj.length,
  };
}

await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\n✓ 写入 data/returns.json：${results.length} 只，` +
  `净值截至 ${asOf}${proj.length ? `，其中 ${proj.length} 只带推算持仓` : ''}`);
