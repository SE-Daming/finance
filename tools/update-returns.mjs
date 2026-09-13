/* 生成 data/returns.json —— 各基金的区间收益率
 *
 * 页面本身不联网取净值：天天基金的净值接口每家整包 250~560 KB，二十多只就是
 * 8 MB，页面里拉不动。所以改成在这里预生成一个小 JSON，页面只读那几 KB。
 *
 * 用法：node tools/update-returns.mjs
 * 数据源：https://fund.eastmoney.com/pingzhongdata/{6位代码}.js
 *
 * 收益率用官方日涨跌幅（equityReturn）逐日复利算出来，而不是拿首尾单位净值相除：
 * 后者遇到分红会把净值砸下去，算出假的暴跌。equityReturn 本身已含分红再投。
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

/* ---------- 读 holdings.md，取出用到的基金代码 ---------- */

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

async function readFunds() {
  const md = await readFile(HOLDINGS, 'utf8');
  const tbl = pickHoldingsTable(md);
  if (!tbl.rows.length) throw new Error('data/holdings.md 里没找到持仓表格');

  const ci = { code: colIdx(tbl.header, '代码'), name: colIdx(tbl.header, '基金名称') };
  if (ci.code < 0) throw new Error('持仓表里没有「代码」列，无法取净值');

  const funds = [];
  const seen = new Set();
  for (const row of tbl.rows) {
    const code = (row[ci.code] || '').trim();
    if (!/^\d{6}$/.test(code)) continue;      // 空 / "—" 的行跳过
    if (seen.has(code)) continue;
    seen.add(code);
    funds.push({ code, name: (row[ci.name] || '').trim() });
  }
  return funds;
}

/* ---------- 拉净值并算区间收益 ---------- */

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
    .filter((d) => d && typeof d.x === 'number' && typeof d.equityReturn === 'number')
    .map((d) => ({ date: toDate(d.x), eq: d.equityReturn }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { name: nameMatch ? nameMatch[1] : '', trend };
}

/* 从 endIdx 往前复利：区间收益 = Π(1 + eq/100) − 1 */
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
  const t = new Date(Date.UTC(y, m - 1 - months, d));
  return t.toISOString().slice(0, 10);
}

function shiftDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return t.toISOString().slice(0, 10);
}

const round2 = (v) => Math.round(v * 100) / 100;

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

const funds = await readFunds();
console.log(`从 holdings.md 读到 ${funds.length} 只基金，开始拉净值…\n`);

let failed = 0;
const results = await mapLimit(funds, 5, async (f) => {
  try {
    const { trend } = await fetchTrend(f.code);
    const r = computeReturns(trend);
    return { code: f.code, name: f.name || '', ...r };
  } catch (err) {
    failed++;
    console.log(`  ✗ ${f.code} ${f.name} —— ${err.message}`);
    return { code: f.code, name: f.name || '', error: err.message };
  }
});

/* 结果表，顺便肉眼核对：同类基金的区间收益应该很接近 */
const pct = (v) => (v == null ? '  —   ' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
console.log('\n代码     1日      1周      1月      3月      6月      1年      净值日期    基金名称');
console.log('─'.repeat(110));
for (const r of results) {
  if (r.error) continue;
  console.log(
    r.code + '  ' +
    [r.r1d, r.r1w, r.r1m, r.r3m, r.r6m, r.r1y].map((v) => pct(v).padStart(7)).join(' ') + '  ' +
    (r.navDate || '    —     ') + '  ' + r.name
  );
}

const ok = results.filter((r) => !r.error);
const asOf = ok.map((r) => r.navDate).filter(Boolean).sort().pop() || null;

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  asOf,
  note: '由 tools/update-returns.mjs 生成。区间收益按官方日涨跌幅逐日复利，已含分红再投。',
  funds: Object.fromEntries(ok.map((r) => [r.code, {
    name: r.name, navDate: r.navDate,
    r1d: r.r1d, r1w: r.r1w, r1m: r.r1m, r3m: r.r3m, r6m: r.r6m, r1y: r.r1y,
  }])),
};

await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\n✓ 写入 data/returns.json：${ok.length} 只成功${failed ? `，${failed} 只失败` : ''}，净值截至 ${asOf}`);
