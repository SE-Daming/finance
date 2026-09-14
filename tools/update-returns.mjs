/* 生成 data/returns.json —— 各基金的区间收益率 + 推算持仓
 *
 * 这是「离线的那一份」：页面上的「同步净值」按钮能在浏览器里算同样的东西，但那是要
 * 用户点一下、还要下几 MB 净值的。这里预生成一份放在仓库里，页面首屏就有的看，
 * 不用等点击，也不怕哪天接口抽风。
 *
 * 算法都在 js/nav-math.js 里，脚本和页面共用同一份，这里只负责取数据和读写文件。
 *
 * 用法：node tools/update-returns.mjs
 * 数据源：https://fund.eastmoney.com/pingzhongdata/{6位代码}.js
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const NavMath = require('../js/nav-math.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS = join(ROOT, 'data', 'holdings.md');
const OUTPUT = join(ROOT, 'data', 'returns.json');

/* 交易日历取自上证指数（和 js/app.js 的 CAL_DAYS 保持一致） */
const KLINE_CODE = 'sh000001';
const CAL_DAYS = 40;

/* 表头里出现其中之一，才认作持仓表（和前端 pickHoldingsTable 同一套规则） */
const MARKER_COLS = ['类别', '基金名称', '持有金额', '持有收益', '每日定投金额', '投入本金', '累计定投'];

const normKey = (s) => String(s == null ? '' : s).replace(/[\s　／/]/g, '');

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

    /* 市值 / 成本按 NavMath 里那套规则推，和看板显示的完全一致 */
    const snap = NavMath.snapshotOf(
      num(cell(row, ci.amount)), num(cell(row, ci.profit)),
      num(cell(row, ci.capital)), num(cell(row, ci.rateIn))
    );

    funds.push({
      code,
      name: cell(row, ci.name).trim(),
      daily: parseDaily(cell(row, ci.daily)) || 0,
      cumulative: num(cell(row, ci.cumulative)),
      amount: snap.amount,
      cost: snap.cost,
    });
  }
  return { funds, snapshotDate };
}

/* ---------- 拉净值 ---------- */

function parseTrend(text) {
  const nameMatch = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  const trendMatch = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!trendMatch) throw new Error('没找到净值走势数据');
  return { name: nameMatch ? nameMatch[1] : '', trend: NavMath.normalizeTrend(JSON.parse(trendMatch[1])) };
}

async function fetchTrend(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseTrend(await res.text());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 接口偶尔会抖，抖一次就丢一只基金，重试几把 */
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

/* ---------- 拉交易日历 ---------- */

/* 上证指数的日K日期就是 A 股交易日（周末、节假日都不在里面）。
 * 推算持仓按它一天推进一期定投——用真实日历而不是「周一到周五」，节假日才不会被算成定投日。 */
async function fetchTradingDays(code, days) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${days},qfq`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const d = json.data && json.data[code];
  const arr = (d && (d.day || d.qfqday)) || [];
  return arr.map((k) => k[0]);
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
    const { name, trend } = await fetchTrendRetry(f.code);
    return { ...f, name: name || f.name, trend };
  } catch (err) {
    return { ...f, error: err.message };
  }
});

/* 缺一只就不写文件：宁可让看板停在上一份完整数据上，也不能发出一个少了几只的版本——
 * 缺的那只会在页面上丢掉区间收益、持仓还会退回手写快照 */
const failedList = results.filter((r) => r.error);
if (failedList.length) {
  console.error(`\n✗ ${failedList.length}/${results.length} 只基金拉不到净值，本次不写 data/returns.json：`);
  for (const r of failedList) console.error(`    ${r.code} ${r.name} —— ${r.error}`);
  console.error('  看板会继续用上一份完整数据，重新跑一次本脚本即可。');
  process.exit(1);
}

/* 交易日历拉不到不算失败：buildPayload 会退回只用各基金自己的净值日，
 * 代价只是「今天净值还没公布」这一期不算数，页面点一下「同步净值」就能补上，不值得整个重跑 */
let calendar = [];
try {
  calendar = await fetchTradingDays(KLINE_CODE, CAL_DAYS);
} catch (err) {
  console.warn(`⚠ 交易日历拉不到（${err.message}），本次退回按各基金净值日推算，少算的是最新这一天。`);
}

const payload = NavMath.buildPayload(results, snapshotDate, calendar);

/* 结果表，顺便肉眼核对：同类基金的区间收益应该很接近 */
const pct = (v) => (v == null ? '  —   ' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
console.log('代码     1日      1周      1月      3月      6月      1年      净值日期    基金名称');
console.log('─'.repeat(110));
for (const r of results) {
  const d = payload.funds[r.code];
  console.log(
    r.code + '  ' +
    [d.r1d, d.r1w, d.r1m, d.r3m, d.r6m, d.r1y].map((v) => pct(v).padStart(7)).join(' ') + '  ' +
    (d.navDate || '    —     ') + '  ' + d.name
  );
}

/* 推算持仓的对比表：快照 → 推算 */
const proj = results.filter((r) => payload.funds[r.code].projected);
if (proj.length) {
  const money = (v) => (v == null ? '—' : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  console.log(`\n推算持仓（快照 → ${payload.projection.asOf}，按 A 股交易日推进）`);
  console.log('代码     快照市值     推算市值     差额      快照收益率  推算收益率   净值截至    基金名称');
  console.log('─'.repeat(110));
  let sumSnap = 0, sumProj = 0;
  for (const r of proj) {
    const p = payload.funds[r.code].projected;
    sumSnap += r.amount;
    sumProj += p.amount;
    const snapRate = r.cost ? (r.amount - r.cost) / r.cost : null;
    console.log(
      r.code + '  ' + money(r.amount).padStart(12) + ' ' + money(p.amount).padStart(12) + ' ' +
      money(p.amount - r.amount).padStart(9) + '  ' +
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

await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`\n✓ 写入 data/returns.json：${results.length} 只，净值截至 ${payload.asOf}` +
  (proj.length ? `；推算持仓 ${proj.length} 只，定投算到 ${payload.projection.asOf}` : ''));
