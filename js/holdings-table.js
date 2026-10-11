/* data/holdings.md 的解析：认表、按表头名找列、取数、读快照日期。
 *
 * tools/update-returns.mjs 和 tools/update-limits.mjs 共用这一份（Node 用 require 读）。
 * 和 js/nav-math.js 同样的包装方式：不引入构建步骤。
 *
 * 浏览器那边（js/app.js）目前还留着自己的一份等价实现。合并它是独立的一步，
 * 不和「加新功能」混在一次改动里——线上路径不动，改动就只在 Node 侧。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoldingsTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 表头里出现其中之一，才认作持仓表（免得认到文档开头的说明表） */
  var MARKER_COLS = ['类别', '基金名称', '持有金额', '持有收益', '每日定投金额', '投入本金', '累计定投'];

  /* 「快照日期：2026-09-13」——整行匹配，免得正文里提到也命中 */
  var SNAPSHOT_RE = /^\s*快照日期[：:]\s*(\d{4}-\d{2}-\d{2})\s*$/m;

  /* 比对表头时抹掉空格和两种斜杠，容忍手写差异 */
  function normKey(s) {
    return String(s == null ? '' : s).replace(/[\s　／/]/g, '');
  }

  /* 取文档里所有 markdown 表：[{ header: [...], rows: [[...], ...] }, ...] */
  function parseMdTables(md) {
    var lines = String(md).split(/\r?\n/).map(function (l) { return l.trim(); });

    function cells(line) {
      return line.replace(/^\|/, '').replace(/\|$/, '')
        .split('|').map(function (s) { return s.trim(); });
    }

    var tables = [], cur = null;
    lines.forEach(function (line) {
      if (line.charAt(0) !== '|') { cur = null; return; }   // 表格到此为止
      var c = cells(line);
      if (c.every(function (x) { return x === ''; })) return;
      if (c.every(function (x) { return /^:?-{2,}:?$/.test(x); })) return;  // 分隔行
      if (cur) cur.rows.push(c);
      else tables.push((cur = { header: c, rows: [] }));
    });
    return tables;
  }

  function pickHoldingsTable(md) {
    var tables = parseMdTables(md);
    for (var i = 0; i < tables.length; i++) {
      var hit = tables[i].header.some(function (h) {
        return MARKER_COLS.indexOf(normKey(h)) !== -1;
      });
      if (hit) return tables[i];
    }
    return { header: [], rows: [] };
  }

  /* 按表头名字找列号，找不到返回 -1 */
  function colIdx(header, name) {
    var want = normKey(name);
    for (var i = 0; i < header.length; i++) {
      if (normKey(header[i]) === want) return i;
    }
    return -1;
  }

  function cellOf(row, i) { return i < 0 || row[i] == null ? '' : row[i]; }

  /* "1504.94" / "+8.89" / "-1.00%" 取数；"—"、空、非数 一律 null */
  function num(s) {
    var t = String(s == null ? '' : s).replace(/[^0-9.+-]/g, '');
    if (!/[0-9]/.test(t)) return null;
    var n = parseFloat(t);
    return isNaN(n) ? null : n;
  }

  /* 从 "50 元/天" 取每日金额；"按两笔各 500 计" 取不到 → null */
  function parseDaily(s) {
    var m = String(s == null ? '' : s).match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*天/);
    return m ? parseFloat(m[1]) : null;
  }

  function snapshotDateOf(md) {
    var m = String(md).match(SNAPSHOT_RE);
    return m ? m[1] : null;
  }

  /* 各要紧列的列号，认不出的给 -1 */
  function columns(header) {
    return {
      cat: colIdx(header, '类别'),
      name: colIdx(header, '基金名称'),
      code: colIdx(header, '代码'),
      plan: colIdx(header, '定投开始/调整'),
      daily: colIdx(header, '每日定投金额'),
      cumulative: colIdx(header, '累计定投'),
      capital: colIdx(header, '投入本金'),
      amount: colIdx(header, '持有金额'),
      profit: colIdx(header, '持有收益'),
      rateIn: colIdx(header, '持仓收益率')
    };
  }

  /* 读持仓表 → { header, ci, rows, snapshotDate, codes }
   * rows 只保留有 6 位代码的行，按出现顺序、已去重（没有代码的行取不到净值，两个脚本都跳过） */
  function readFunds(md) {
    var tbl = pickHoldingsTable(md);
    if (!tbl.rows.length) throw new Error('data/holdings.md 里没找到持仓表格');
    var ci = columns(tbl.header);
    if (ci.code < 0) throw new Error('持仓表里没有「代码」列，无法取净值');

    var rows = [], codes = [], seen = {};
    for (var i = 0; i < tbl.rows.length; i++) {
      var row = tbl.rows[i];
      var code = cellOf(row, ci.code).trim();
      if (!/^\d{6}$/.test(code) || seen[code]) continue;
      seen[code] = 1;
      codes.push(code);
      rows.push(row);
    }
    return {
      header: tbl.header, ci: ci, rows: rows, codes: codes,
      snapshotDate: snapshotDateOf(md)
    };
  }

  return {
    MARKER_COLS: MARKER_COLS,
    SNAPSHOT_RE: SNAPSHOT_RE,
    normKey: normKey,
    parseMdTables: parseMdTables,
    pickHoldingsTable: pickHoldingsTable,
    colIdx: colIdx,
    cellOf: cellOf,
    num: num,
    parseDaily: parseDaily,
    snapshotDateOf: snapshotDateOf,
    columns: columns,
    readFunds: readFunds
  };
});
