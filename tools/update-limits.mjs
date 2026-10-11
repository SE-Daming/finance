/* 生成 data/limits.json —— 各基金的申购状态与单日限额
 *
 * 为什么必须预生成、不能在页面里现拉：天天基金那个接口（fundmobapi）确实带
 * Access-Control-Allow-Origin: *，但**认短 User-Agent，带完整 Chrome UA 会回
 * ErrCode 61136403**。浏览器不允许改 User-Agent，所以页面里 fetch 一定拿不到数据。
 * 网页版（fund.eastmoney.com/xxx.html）里倒是有申购状态，可它不带 CORS 头，浏览器读不了。
 * 三条路都试过了，结论是页面只能读同源的预生成文件——和 data/returns.json 一个道理。
 *
 * 用法：node tools/update-limits.mjs
 * 数据源：https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HT = require('../js/holdings-table.js');
const LimitCheck = require('../js/limit-check.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS = join(ROOT, 'data', 'holdings.md');
const OUTPUT = join(ROOT, 'data', 'limits.json');

const API = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation';
/* 短 UA 是必须的，别换成完整的 Chrome UA——那会被接口当成爬虫挡掉 */
const UA = 'Mozilla/5.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一次查几只，别把人家接口打爆 */
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

const toNum = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function fetchLimit(code, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${API}?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0`,
        { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.Success || !json.Datas) throw new Error(json.ErrMsg || '接口没返回数据');
      return json.Datas;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

/* 接口给的原始字段 → 页面要的形状。MAXSG 超过 1e9 表示不限购，写进 JSON 没意义，归一成 null */
function normalize(d) {
  const max = toNum(d.MAXSG);
  return {
    name: d.SHORTNAME || '',
    sgzt: d.SGZT || '',                       // 申购状态：开放申购 / 限大额 / 暂停申购
    shzt: d.SHZT || '',                       // 赎回状态，顺手记下
    /* buy 是「能不能买」最可靠的信号：有些基金申购状态写着「限大额」、限额写着 "--"，
     * 但 BUY 已经是 false。光看 sgzt 和 max 都会漏判，所以单独存下来 */
    buy: d.BUY === true,
    min: toNum(d.MINSG),
    max: max == null || max >= LimitCheck.UNLIMITED ? null : max,
  };
}

/* ---------- 主流程 ---------- */

const md = await readFile(HOLDINGS, 'utf8');
const t = HT.readFunds(md);
const ci = t.ci;
/* 计划金额要和页面算的一致：同一个 parseDaily，同一份 holdings.md */
const plan = {};
const rows = t.rows;
for (const row of rows) {
  plan[HT.cellOf(row, ci.code).trim()] = HT.parseDaily(HT.cellOf(row, ci.daily)) || 0;
}

console.log(`从 holdings.md 读到 ${t.codes.length} 只基金，开始查申购状态…\n`);

const results = await mapLimit(t.codes, 5, async (code) => {
  try {
    return { code, data: normalize(await fetchLimit(code)) };
  } catch (err) {
    return { code, error: err.message };
  }
});

const failed = results.filter((r) => r.error);
const funds = {};
for (const r of results) if (r.data) funds[r.code] = r.data;

/* 和 update-returns.mjs 不同：那边缺一只就不写文件（缺了会让钱算少），
 * 这边缺一只只是少一行警告，写出能拿到的那些更有用，缺的记在 failed 里让页面标出来 */
if (failed.length) {
  console.warn(`⚠ ${failed.length}/${results.length} 只没查到申购状态，先写出其余部分：`);
  for (const r of failed) console.warn(`    ${r.code} —— ${r.error}`);
  console.warn('');
}

const payload = {
  asOf: new Date().toISOString(),
  note: '各基金的申购状态与单日限额，来自天天基金 fundmobapi（tools/update-limits.mjs 预生成）。' +
    '接口认短 User-Agent，浏览器里取不到，所以只能像这样预生成。',
  funds,
};
if (failed.length) payload.failed = failed.map((r) => ({ code: r.code, error: r.error }));
await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

/* 结果表：有问题（买不进 / 超限 / 顶格）排前面 */
const order = { bad: 0, warn: 1, flat: 2, ok: 3 };
const list = t.codes.map((code) => {
  const L = funds[code] || null;
  return { code, name: (L && L.name) || '', L, plan: plan[code] || 0, v: LimitCheck.verdict(plan[code] || 0, L) };
}).sort((a, b) => order[a.v.key] - order[b.v.key]);

const capTxt = (L) => (L == null ? '—' : (L.max == null ? '不限' : L.max + ' 元/天'));
console.log('代码     申购状态     单日上限     计划      判定        基金名称');
console.log('─'.repeat(92));
for (const r of list) {
  console.log(
    r.code + '  ' + String(r.L ? r.L.sgzt : '—').padEnd(11) + ' ' +
    capTxt(r.L).padStart(10) + ' ' +
    (r.plan > 0 ? r.plan + ' 元/天' : '—').padStart(10) + '   ' +
    r.v.txt.padEnd(12) + ' ' + r.name
  );
}
const bad = list.filter((r) => r.v.key === 'bad').length;
const warn = list.filter((r) => r.v.key === 'warn').length;
console.log('─'.repeat(92));
console.log(`买不进 / 超限 ${bad} 只，顶格 ${warn} 只，共 ${list.length} 只`);

console.log(`\n✓ 写入 data/limits.json：${Object.keys(funds).length} 只，取数时间 ${payload.asOf}`);
if (bad || warn) console.log('  ⚠ 标了「买不进 / 超限」的基金，定投当期不会成交，holdings.md 的「每日定投金额」应该留 —');
