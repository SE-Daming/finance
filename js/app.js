/* 理财看板 —— 纯前端，无构建依赖
 * 数据源：腾讯财经公开行情接口
 *   实时行情: https://qt.gtimg.cn/q=sh000001,sz399001,...  （返回 JS 变量赋值，
 *             用 <script charset="GBK"> 注入，天然无跨域问题）
 *   日K历史:  https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_callback=xx
 * 代码前缀：sh=沪市  sz=深市  wh=外汇  hf_=外盘期货
 */
(function () {
  'use strict';

  var API_QUOTE = 'https://qt.gtimg.cn/q=';
  var API_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

  /* 大盘指数 */
  var INDICES = ['sh000001', 'sz399001', 'sh000300'];
  /* 外汇 · 贵金属 */
  var FX_METALS = ['whUSDCNY', 'whEURUSD', 'hf_GC', 'hf_SI'];
  var KLINE_CODE = 'sh000001'; // 迷你走势图：上证指数
  var KLINE_DAYS = 30;

  var WATCH_KEY = 'finance-watch-list';
  var DEFAULT_WATCH = ['161725', '510300'];

  /* 持仓数据源：改 data/holdings.md 即可，无需动代码 */
  var HOLDINGS_URL = 'data/holdings.md';
  /* 区间收益：由 tools/update-returns.mjs 预生成的小 JSON，页面不直接拉净值 */
  var RETURNS_URL = 'data/returns.json';

  /* ---------- 底层：脚本注入（无跨域） ---------- */

  function injectScript(url, charset, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      if (charset) s.charset = charset;
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; s.remove(); reject(new Error('请求超时')); }
      }, timeoutMs || 8000);
      s.onload = function () {
        if (!done) { done = true; clearTimeout(timer); s.remove(); resolve(); }
      };
      s.onerror = function () {
        if (!done) { done = true; clearTimeout(timer); s.remove(); reject(new Error('网络请求失败')); }
      };
      s.src = url;
      document.head.appendChild(s);
    });
  }

  /* ---------- 行情解析 ---------- */

  /* 按代码类型解析腾讯行情串 */
  function parseQuote(code, raw) {
    if (code.indexOf('hf_') === 0) {              // 外盘期货：逗号分隔
      var h = raw.split(',');
      return { name: h[13] || code, price: parseFloat(h[0]), pct: parseFloat(h[1]), dec: 2 };
    }
    if (code.indexOf('wh') === 0) {               // 外汇
      var w = raw.split('~');
      return { name: w[1], price: parseFloat(w[3]), pct: parseFloat(w[13]), dec: 4 };
    }
    var f = raw.split('~');                       // 股票/指数/基金
    return { name: f[1], price: parseFloat(f[3]), pct: parseFloat(f[32]), dec: 2 };
  }

  /* 一次性拉取全部代码：返回 { code: {name, price, pct, dec} } */
  function fetchQuotes(codes) {
    codes.forEach(function (c) { delete window['v_' + c]; });
    var url = API_QUOTE + codes.join(',') + '&r=' + Date.now();
    return injectScript(url, 'GBK').then(function () {
      var map = {};
      codes.forEach(function (c) {
        var raw = window['v_' + c];
        if (raw) {
          map[c] = parseQuote(c, raw);
          delete window['v_' + c];
        }
      });
      if (!Object.keys(map).length) throw new Error('未返回行情数据');
      return map;
    });
  }

  /* 6 位代码猜市场：5/6/9 开头为沪市，其余按深市 */
  function toTencentCode(code6) {
    return (/^[569]/.test(code6) ? 'sh' : 'sz') + code6;
  }

  /* 近 N 个交易日收盘价 */
  function fetchCloses(code, days) {
    var cb = 'financeKline_' + Date.now();
    return new Promise(function (resolve, reject) {
      window[cb] = function (json) {
        try {
          var d = json.data[code];
          var arr = (d && (d.day || d.qfqday)) || [];
          if (!arr.length) throw new Error('K线为空');
          resolve(arr.map(function (k) { return parseFloat(k[2]); }));
        } catch (e) {
          reject(new Error('K线数据解析失败'));
        } finally {
          delete window[cb];
        }
      };
      injectScript(API_KLINE + '?_callback=' + cb +
        '&param=' + code + ',day,,,' + days + ',qfq&r=' + Date.now())
        .catch(function () { reject(new Error('K线请求失败')); });
    });
  }

  /* ---------- 渲染工具 ---------- */

  function trendClass(v) {
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  function fmtPct(v) {
    if (typeof v !== 'number' || isNaN(v)) return '--';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtPrice(q) {
    if (!q || typeof q.price !== 'number' || isNaN(q.price)) return '--';
    return q.price.toFixed(q.dec);
  }

  function sparklineSVG(closes) {
    if (!closes || closes.length < 2) return '';
    var w = 100, h = 30;
    var min = Math.min.apply(null, closes);
    var max = Math.max.apply(null, closes);
    var range = (max - min) || 1;
    var pts = closes.map(function (v, i) {
      var x = (i / (closes.length - 1)) * w;
      var y = h - 2 - ((v - min) / range) * (h - 4);
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    var rising = closes[closes.length - 1] >= closes[0];
    var color = rising ? 'var(--up)' : 'var(--down)';
    var last = pts[pts.length - 1].split(',');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" ' +
      'stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="1.6" fill="' + color + '"/>' +
      '</svg>';
  }

  /* ---------- 持仓：解析并可视化 data/holdings.md ---------- */

  /* 兜底的仓位分布配色（刻意避开红绿，那两色在别处表示涨跌） */
  var ALLOC_COLORS = ['#3b6fd4', '#4aa8a0', '#8b6fd4', '#e08a3c',
                      '#c0568f', '#6b8f3c', '#7a8fa6', '#b8792e'];

  /* 表格各列宽度，和 CSS 里 .holdings-table 的 min-width 对齐；认不出的列给 100 */
  var COL_WIDTHS = {
    '类别': 92, '基金名称': 200, '代码': 88, '定投开始调整': 184,
    '每日定投金额': 100, '累计定投': 104, '成本': 96, '持有金额': 100,
    '持有收益': 96, '收益率': 88
  };
  /* 需要右对齐、等宽数字的列 */
  var NUM_COLS = ['每日定投金额', '累计定投', '成本', '持有金额', '持有收益', '收益率'];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 比对表头时抹掉空格和两种斜杠，容忍手写差异 */
  function normKey(s) {
    return String(s).replace(/[\s　／/]/g, '');
  }

  /* "1504.94" / "+8.89" 取数；"—"、空、非数 一律返回 null */
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

  function fmtMoney(n) {
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtSigned(n) { return (n > 0 ? '+' : '') + fmtMoney(n); }
  function fmtRate(r) { return (r > 0 ? '+' : '') + (r * 100).toFixed(2) + '%'; }
  function clsOf(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }

  /* 表头 → 各要紧列的列号，认不出的给 -1 */
  function colIndex(header) {
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

  function cellOf(row, i) { return i < 0 || row[i] == null ? '' : row[i]; }

  /* 一行的四个数：市值 / 收益 / 成本 / 收益率
   * 市值优先取「持有金额」；只填了「投入本金」+「持有收益」时反推市值 = 本金 + 收益 */
  function metrics(row, ci) {
    var profit = num(cellOf(row, ci.profit));
    var capital = num(cellOf(row, ci.capital));
    var amount = num(cellOf(row, ci.amount));
    var derivedProfit = false;

    /* 只填了「持仓收益率」、没填「持有收益」的行：由市值反推收益
     * 收益 = 市值 × r ÷ (1 + r)，也就是先拿 成本 = 市值 ÷ (1 + r) */
    if (profit == null && amount != null) {
      var rIn = num(cellOf(row, ci.rateIn));
      var pct = rIn == null ? null : rIn / 100;
      if (pct != null && pct !== -1) {          // -100% 时分母为 0，反推不出来
        profit = amount - amount / (1 + pct);
        derivedProfit = true;
      }
    }

    if (amount == null && capital != null && profit != null) amount = capital + profit;

    var cost = (amount != null && profit != null) ? amount - profit : capital;
    var rate = (cost == null || cost === 0 || profit == null) ? null : profit / cost;
    return {
      amount: amount, profit: profit, capital: capital,
      cost: cost, rate: rate, derivedProfit: derivedProfit
    };
  }

  /* 取文档里所有 markdown 表：[{ header: [...], rows: [[...], ...] }, ...] */
  function parseMdTables(md) {
    var lines = md.split(/\r?\n/).map(function (l) { return l.trim(); });

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

  /* 表头里出现这些列名之一，才认作持仓表——免得认到文档开头的说明表 */
  var HOLDINGS_COLS = ['类别', '基金名称', '持有金额', '持有收益', '每日定投金额', '投入本金'];

  function pickHoldingsTable(md) {
    var tables = parseMdTables(md);
    for (var i = 0; i < tables.length; i++) {
      var hit = tables[i].header.some(function (h) {
        return HOLDINGS_COLS.indexOf(normKey(h)) !== -1;
      });
      if (hit) return tables[i];
    }
    return tables[0] || { header: [], rows: [] };
  }

  /* 按表头名字找列号，找不到返回 -1 */
  function colIdx(header, name) {
    var want = normKey(name);
    for (var i = 0; i < header.length; i++) {
      if (normKey(header[i]) === want) return i;
    }
    return -1;
  }

  /* 汇总模型
   * funds  —— 表里的每一只基金
   * groups —— 按「类别」汇总出来的分类（仓位分布 / 收益贡献 / 定投节奏都看它）
   * 只填了「每日定投金额」、没填金额和收益的行，当成纯定投计划行：只进定投合计 */
  function buildModel(tbl) {
    var ci = colIndex(tbl.header);
    var funds = [], groups = [], groupOf = {}, excluded = [];
    var sum = { amount: 0, profit: 0, cost: 0, daily: 0 };

    tbl.rows.forEach(function (row) {
      var cat = cellOf(row, ci.cat);
      if (normKey(cat) === '总计') return;      // 兼容旧数据里手写的总计行，不参与计算

      var x = metrics(row, ci);
      var daily = parseDaily(cellOf(row, ci.daily));
      var isPlan = x.amount == null && x.profit == null && daily != null;

      var fund = {
        raw: row,
        cat: cat,
        name: cellOf(row, ci.name),
        codes: cellOf(row, ci.code),
        plan: cellOf(row, ci.plan),
        daily: daily,
        cumulative: num(cellOf(row, ci.cumulative)),
        capital: x.capital,
        amount: x.amount,
        profit: x.profit,
        cost: x.cost,
        rate: x.rate,
        derivedProfit: x.derivedProfit,
        isPlan: isPlan
      };
      funds.push(fund);

      var g = groupOf[cat];
      if (!g) {
        g = groupOf[cat] = {
          cat: cat, funds: [], amount: 0, profit: 0, cost: 0, daily: 0, capital: 0,
          cumulative: 0,
          /* 颜色按分类首次出现的顺序固定，保证各图里同一分类同色 */
          color: ALLOC_COLORS[groups.length % ALLOC_COLORS.length]
        };
        groups.push(g);
      }
      g.funds.push(fund);
      if (daily != null) g.daily += daily;
      if (fund.cumulative != null) g.cumulative += fund.cumulative;
      if (x.capital != null) g.capital += x.capital;

      if (x.amount != null) {
        g.amount += x.amount;
        if (x.profit != null) { g.profit += x.profit; g.cost += x.amount - x.profit; }
      } else if (!isPlan) {
        excluded.push(cat);                     // 既没市值也没本金 → 不计入总额
      }
    });

    groups.forEach(function (g) {
      g.rate = g.cost ? g.profit / g.cost : null;
      g.count = g.funds.filter(function (f) { return f.amount != null; }).length;
      sum.amount += g.amount;
      sum.profit += g.profit;
      sum.cost += g.cost;
      sum.daily += g.daily;
    });

    return {
      funds: funds,
      groups: groups,
      excluded: excluded,
      sum: sum,
      ci: ci,
      totalRate: sum.cost ? sum.profit / sum.cost : null
    };
  }

  /* 顶部四个数字 */
  function renderOverview(m) {
    var s = m.sum;
    var stats = [
      { label: '持有金额', value: fmtMoney(s.amount), cls: '' },
      { label: '累计成本', value: fmtMoney(s.cost), cls: '' },
      { label: '累计收益', value: fmtSigned(s.profit), cls: clsOf(s.profit) },
      { label: '收益率', value: m.totalRate == null ? '—' : fmtRate(m.totalRate),
        cls: m.totalRate == null ? 'flat' : clsOf(m.totalRate) },
      { label: '每日定投', value: fmtMoney(s.daily), unit: '元/天', cls: '' }
    ];

    var html = stats.map(function (st) {
      return '<div class="hd-stat">' +
        '<div class="hd-stat-label">' + esc(st.label) + '</div>' +
        '<div class="hd-stat-value ' + st.cls + '">' + st.value +
        (st.unit ? '<small>' + esc(st.unit) + '</small>' : '') + '</div>' +
        '</div>';
    }).join('');

    var note = m.excluded.length
      ? '<p class="hd-note">未计入总额：' + m.excluded.map(esc).join('、') +
        '（该行既没填持有金额，也没有投入本金）</p>'
      : '';

    return '<div class="hd-overview">' + html + '</div>' + note;
  }

  /* 持仓概览：每个类别一张小卡，一眼看清市值 / 盈亏 / 占比 / 定投 */
  function renderCards(m) {
    var rows = m.groups.filter(function (g) { return g.amount > 0 || g.daily > 0; });
    if (!rows.length) return '';

    var total = m.sum.amount || 1;

    var html = rows.map(function (g) {
      var pct = g.amount > 0 ? g.amount / total * 100 : null;
      var cls = g.cost ? clsOf(g.profit) : 'flat';

      var foot = [];
      if (pct != null) foot.push('<span>占仓 ' + pct.toFixed(1) + '%</span>');
      if (g.count) foot.push('<span>' + g.count + ' 只</span>');
      if (g.daily > 0) foot.push('<span>定投 ' + fmtMoney(g.daily) + ' 元/天</span>');
      else if (g.capital > 0) foot.push('<span>已投 ' + fmtMoney(g.capital) + ' 元</span>');
      if (g.cumulative > 0) foot.push('<span>累计 ' + fmtMoney(g.cumulative) + ' 元</span>');

      return '<article class="hd-card">' +
        '<div class="hd-card-top">' +
          '<span class="hd-card-cat" title="' + esc(g.cat) + '">' + esc(g.cat) + '</span>' +
          '<span class="hd-card-code">' + (g.daily > 0 ? fmtMoney(g.daily) + ' 元/天' : '一次性') +
          '</span>' +
        '</div>' +
        '<div class="hd-card-amount">' + (g.amount > 0 ? fmtMoney(g.amount) : '—') + '</div>' +
        '<div class="hd-card-profit ' + cls + '">' +
          (g.cost ? fmtSigned(g.profit) : '—') +
          (g.rate == null ? '' : '<span class="hd-card-rate">' + fmtRate(g.rate) + '</span>') +
        '</div>' +
        (pct == null ? '' : '<div class="hd-card-meter"><span style="width:' +
          pct.toFixed(1) + '%"></span></div>') +
        (foot.length ? '<div class="hd-card-foot">' + foot.join('') + '</div>' : '') +
        '</article>';
    }).join('');

    return '<div class="hd-section">持仓概览</div>' +
      '<div class="hd-cards">' + html + '</div>';
  }

  /* 每月 / 每年定投额按交易日折算，A 股一年约 250 个交易日 */
  var TRADING_DAYS_MONTH = 21;
  var TRADING_DAYS_YEAR = 250;

  /* 定投节奏：每日合计折成月 / 年，再按类别看定投的钱流向哪 */
  function renderDca(m) {
    var rows = m.groups.filter(function (g) { return g.daily > 0; });
    if (!rows.length) return '';

    var total = m.sum.daily || 1;

    var stats = [
      { label: '每日定投', value: fmtMoney(total), unit: '元/天' },
      { label: '每月约', value: fmtMoney(total * TRADING_DAYS_MONTH), unit: '元' },
      { label: '每年约', value: fmtMoney(total * TRADING_DAYS_YEAR), unit: '元' }
    ].map(function (st) {
      return '<div class="hd-stat">' +
        '<div class="hd-stat-label">' + esc(st.label) + '</div>' +
        '<div class="hd-stat-value">' + st.value + '<small>' + esc(st.unit) + '</small></div>' +
        '</div>';
    }).join('');

    var segs = '', legend = '';
    rows.forEach(function (g) {
      var pct = g.daily / total * 100;
      segs += '<span style="width:' + pct.toFixed(2) + '%;background:' + g.color + '"></span>';
      legend += '<span class="hd-alloc-item"><i style="background:' + g.color + '"></i>' +
        esc(g.cat) + '<b>' + fmtMoney(g.daily) + ' 元/天</b>' +
        '<em>' + pct.toFixed(0) + '%</em></span>';
    });

    var lumps = m.groups.filter(function (g) { return !(g.daily > 0) && g.capital > 0; });
    var note = lumps.length
      ? '<p class="hd-note">非定投：' + lumps.map(function (g) {
          return esc(g.cat) + ' 已投 ' + fmtMoney(g.capital) + ' 元';
        }).join('、') + '</p>'
      : '';

    return '<div class="hd-section">定投节奏</div>' +
      '<div class="hd-overview">' + stats + '</div>' +
      '<div class="hd-alloc-bar hd-dca-bar">' + segs + '</div>' +
      '<div class="hd-alloc-legend">' + legend + '</div>' +
      '<p class="hd-note">每月 / 每年按 ' + TRADING_DAYS_MONTH + '、' + TRADING_DAYS_YEAR +
      ' 个交易日估算</p>' + note;
  }

  /* 收益贡献：以 0 为中心向左右延伸的横条，长度按绝对值归一 */
  function renderBars(m) {
    var rows = m.groups.filter(function (g) { return g.cost > 0; })
      .slice().sort(function (a, b) { return b.profit - a.profit; });
    if (!rows.length) return '';

    var maxAbs = rows.reduce(function (mx, g) {
      return Math.max(mx, Math.abs(g.profit));
    }, 0) || 1;

    var html = rows.map(function (g) {
      var cls = clsOf(g.profit);
      var w = Math.max(Math.abs(g.profit) / maxAbs * 48, 1).toFixed(2);   // 最小 1% 保证可见
      var pos = g.profit >= 0 ? 'left:50%' : 'right:50%';
      var rate = g.rate == null ? '' :
        '<span class="hd-rate ' + clsOf(g.rate) + '">' + fmtRate(g.rate) + '</span>';

      return '<div class="hd-bar-row">' +
        '<div class="hd-bar-name" title="' + esc(g.cat) + '（' + g.count + ' 只）">' + esc(g.cat) + '</div>' +
        '<div class="hd-bar-track"><span class="hd-bar-fill ' + cls + '" style="' +
          pos + ';width:' + w + '%"></span></div>' +
        '<div class="hd-bar-val"><span class="' + cls + '">' + fmtSigned(g.profit) + '</span>' + rate + '</div>' +
        '</div>';
    }).join('');

    return '<div class="hd-section">收益贡献</div>' +
      '<div class="hd-bars">' + html + '</div>';
  }

  /* 仓位分布：按持有金额占比的一根堆叠条 + 图例 */
  function renderAlloc(m) {
    var rows = m.groups.filter(function (g) { return g.amount > 0; });
    if (!rows.length) return '';

    var total = m.sum.amount || 1;
    var segs = '', legend = '';

    rows.forEach(function (g) {
      var pct = g.amount / total * 100;

      segs += '<span style="width:' + pct.toFixed(2) + '%;background:' + g.color + '"></span>';
      legend += '<span class="hd-alloc-item"><i style="background:' + g.color + '"></i>' +
        esc(g.cat) + '<b>' + pct.toFixed(1) + '%</b></span>';
    });

    return '<div class="hd-section">仓位分布</div>' +
      '<div class="hd-alloc-bar">' + segs + '</div>' +
      '<div class="hd-alloc-legend">' + legend + '</div>';
  }

  /* 明细表：原样渲染表格所有列，插入「成本」「收益率」两个计算列，并按类别分组
   * 「投入本金」是给看板算账用的输入列，不单独渲染；「小计」「合计」行由看板算出来 */
  function renderTable(tbl, m) {
    var ci = m.ci;

    var cols = [];
    tbl.header.forEach(function (h, i) {
      /* 「投入本金」「持仓收益率」是给看板算账用的输入列，不单独渲染 */
      if (i === ci.capital || i === ci.rateIn) return;
      if (i === ci.amount) cols.push({ title: '成本', cost: true });
      cols.push({ title: h, src: i });
      if (i === ci.profit) cols.push({ title: '收益率', rate: true });
    });
    if (ci.profit < 0) cols.push({ title: '收益率', rate: true });

    function numCls(title) {
      return NUM_COLS.indexOf(normKey(title)) !== -1 ? 'hd-num' : '';
    }

    function computed(v, isRate) {
      var cls = ['hd-computed'];
      if (isRate) {
        cls.push(v == null ? 'flat' : clsOf(v));
        return '<td class="' + cls.join(' ') + '">' + (v == null ? '—' : fmtRate(v)) + '</td>';
      }
      return '<td class="' + cls.join(' ') + '">' + (v == null ? '—' : fmtMoney(v)) + '</td>';
    }

    var colgroup = '<colgroup>' + cols.map(function (c) {
      return '<col style="width:' + (COL_WIDTHS[normKey(c.title)] || 110) + 'px">';
    }).join('') + '</colgroup>';

    var thead = '<tr>' + cols.map(function (c) {
      var cls = [numCls(c.title)];
      if (c.rate || c.cost) cls.push('hd-computed');
      cls = cls.filter(Boolean);
      return '<th' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + esc(c.title) + '</th>';
    }).join('') + '</tr>';

    /* 一只基金一行；同一类别的后续行不再重复类别名 */
    function fundRow(f, first) {
      var tds = cols.map(function (c) {
        if (c.cost || c.rate) return computed(c.cost ? f.cost : f.rate, !!c.rate);

        if (c.src === ci.cat && !first) return '<td class="hd-grp-name"></td>';

        var cls = [numCls(c.title)];
        var val = cellOf(f.raw, c.src);

        if (c.src === ci.amount && num(val) == null && f.amount != null) {
          return '<td class="hd-num hd-derived" title="由「投入本金 + 持有收益」推算">' +
            fmtMoney(f.amount) + '</td>';
        }
        if (c.src === ci.profit) {
          var p = num(val);
          if (p == null && f.derivedProfit && f.profit != null) {
            return '<td class="hd-num hd-derived ' + clsOf(f.profit) +
              '" title="由「持有金额 × 持仓收益率」反推">' + fmtSigned(f.profit) + '</td>';
          }
          if (p != null) cls.push(clsOf(p));
        }
        cls = cls.filter(Boolean);
        return '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + esc(val) + '</td>';
      }).join('');
      return '<tr class="hd-fund-row' + (f.isPlan ? ' hd-plan-row' : '') + '">' + tds + '</tr>';
    }

    /* 小计 / 合计行：只有类别、名称标签、定投、成本、市值、收益、收益率有值 */
    function aggRow(label, agg, nameText, rowCls) {
      var tds = cols.map(function (c) {
        if (c.cost || c.rate) return computed(c.cost ? agg.cost : agg.rate, !!c.rate);

        var cls = [numCls(c.title)];
        var text = '';
        if (c.src === ci.cat) text = label;
        else if (c.src === ci.name) text = nameText;
        else if (c.src === ci.daily) text = agg.daily > 0 ? fmtMoney(agg.daily) + ' 元/天' : '—';
        else if (c.src === ci.amount) text = agg.amount > 0 ? fmtMoney(agg.amount) : '—';
        else if (c.src === ci.profit) {
          text = fmtSigned(agg.profit);
          if (agg.cost > 0) cls.push(clsOf(agg.profit));
        }
        cls = cls.filter(Boolean);
        return '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + esc(text) + '</td>';
      }).join('');
      return '<tr class="' + rowCls + '">' + tds + '</tr>';
    }

    var tbody = '';
    m.groups.forEach(function (g) {
      g.funds.forEach(function (f, i) { tbody += fundRow(f, i === 0); });
      tbody += aggRow(g.cat, g, '小计', 'hd-subtotal');
    });
    tbody += aggRow('合计', {
      amount: m.sum.amount, profit: m.sum.profit, cost: m.sum.cost,
      rate: m.totalRate, daily: m.sum.daily
    }, '', 'total-row');

    var fundCount = m.funds.filter(function (f) { return !f.isPlan; }).length;
    return '<div class="hd-section">持仓明细 · ' + fundCount + ' 只</div>' +
      '<div class="table-wrap"><table class="holdings-table">' + colgroup +
      '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>';
  }

  /* 基金区间收益：读 data/returns.json（预生成，见 tools/update-returns.mjs）
   * 各基金的净值日期不一样（QDII 普遍晚一天），所以日期挂在每行的 title 上 */
  var RETURN_COLS = [
    { key: 'r1d', label: '1日' }, { key: 'r1w', label: '1周' },
    { key: 'r1m', label: '1月' }, { key: 'r3m', label: '3月' },
    { key: 'r6m', label: '6月' }, { key: 'r1y', label: '1年' }
  ];

  function returnCell(v) {
    if (v == null) return '<td class="hd-num flat">—</td>';
    return '<td class="hd-num ' + clsOf(v) + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</td>';
  }

  function renderReturns(m, data) {
    var byCode = (data && data.funds) || {};
    var rows = '', shown = 0;

    m.groups.forEach(function (g) {
      var first = true;
      g.funds.forEach(function (f) {
        var code = String(f.codes || '').trim();
        var r = /^\d{6}$/.test(code) ? byCode[code] : null;
        if (!r) return;                      // 没代码 / 没取到净值 → 不出现，也不占位
        shown++;
        rows += '<tr title="净值日期 ' + esc(r.navDate || '—') + '">' +
          '<td class="hd-grp-name">' + (first ? esc(g.cat) : '') + '</td>' +
          '<td class="rt-name" title="' + esc(f.name) + '">' + esc(f.name) + '</td>' +
          RETURN_COLS.map(function (c) { return returnCell(r[c.key]); }).join('') +
          '</tr>';
        first = false;
      });
    });

    if (!shown) return '';

    var head = '<tr><th>类别</th><th>基金名称</th>' +
      RETURN_COLS.map(function (c) { return '<th class="hd-num">' + c.label + '</th>'; }).join('') +
      '</tr>';

    return '<div class="hd-section">基金区间收益 · 截至 ' + esc(data.asOf || '—') + '</div>' +
      '<div class="table-wrap"><table class="returns-table">' +
      '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hd-note">按官方日涨跌幅逐日复利，已含分红再投。QDII 净值晚一天，' +
      '每行悬停可看自己的净值日期；本区块由 <code>node tools/update-returns.mjs</code> ' +
      '预生成，不是实时行情。</p>';
  }

  function renderHoldings(tbl, returns) {
    var m = buildModel(tbl);
    return renderOverview(m) + renderCards(m) + renderAlloc(m) +
      renderBars(m) + renderDca(m) + renderReturns(m, returns) + renderTable(tbl, m);
  }

  /* ---------- 卡片状态机 ---------- */

  var loaders = {};
  function setState(el, state, message) {
    el.dataset.state = state;
    if (state === 'loading') {
      el.innerHTML = '<span class="spinner"></span>';
    } else if (state === 'error') {
      el.innerHTML =
        '<span>' + (message || '数据加载失败') + '</span>' +
        '<button class="error-retry" type="button">重试</button>';
      el.querySelector('.error-retry').addEventListener('click', function () {
        loadCard(el.closest('.card'));
      });
    }
  }

  function loadCard(card) {
    var body = card.querySelector('.card-body');
    setState(body, 'loading');
    loaders[card.id](body).catch(function (err) {
      setState(body, 'error', '数据加载失败（' + err.message + '）');
    });
  }

  /* ---------- 各卡片 ---------- */

  /* 大盘指数 + 上证走势 */
  loaders['card-index'] = function (el) {
    return Promise.all([
      fetchQuotes(INDICES),
      fetchCloses(KLINE_CODE, KLINE_DAYS)
    ]).then(function (results) {
      var quotes = results[0], closes = results[1];
      var blocks = INDICES.map(function (code) {
        var q = quotes[code];
        if (!q) return '';
        return '<div class="index-block">' +
          '<div class="quote-name">' + q.name + '</div>' +
          '<div class="quote-price ' + trendClass(q.pct) + '">' + fmtPrice(q) + '</div>' +
          '<div class="quote-change ' + trendClass(q.pct) + '">' + fmtPct(q.pct) + '</div>' +
          '</div>';
      }).join('');
      el.innerHTML =
        '<div class="index-row">' + blocks + '</div>' +
        '<div class="spark-label">上证指数 · 近' + closes.length + '个交易日</div>' +
        sparklineSVG(closes);
      el.dataset.state = 'ok';
    });
  };

  /* 外汇 · 贵金属 */
  loaders['card-fx'] = function (el) {
    return fetchQuotes(FX_METALS).then(function (quotes) {
      var rows = FX_METALS.map(function (code) {
        var q = quotes[code];
        if (!q) return '';
        return '<div class="quote-row">' +
          '<div><span class="quote-name">' + q.name + '</span></div>' +
          '<div><div class="quote-price">' + fmtPrice(q) + '</div>' +
          '<div class="quote-change ' + trendClass(q.pct) + '">' + fmtPct(q.pct) + '</div></div>' +
          '</div>';
      }).join('');
      el.innerHTML = '<div class="quote-list">' + rows + '</div>';
      el.dataset.state = 'ok';
    });
  };

  /* 自选基金 / ETF / 股票（localStorage 持久化） */

  function getWatchList() {
    try {
      var saved = JSON.parse(localStorage.getItem(WATCH_KEY));
      if (Array.isArray(saved) && saved.every(function (c) { return /^\d{6}$/.test(c); })) {
        return saved;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return DEFAULT_WATCH.slice();
  }

  function setWatchList(list) {
    localStorage.setItem(WATCH_KEY, JSON.stringify(list));
  }

  loaders['card-watch'] = function (el) {
    var list = getWatchList();
    if (!list.length) {
      el.innerHTML = '<p class="hint">暂无自选，输入 6 位代码添加</p>';
      el.dataset.state = 'ok';
      return Promise.resolve();
    }
    var codes = list.map(toTencentCode);
    return fetchQuotes(codes).then(function (quotes) {
      var rows = list.map(function (code6) {
        var tc = toTencentCode(code6);
        var q = quotes[tc];
        var name = q ? q.name + '<span class="quote-code">' + code6 + '</span>' : '代码 ' + code6;
        var info = q
          ? '<div class="quote-price">' + fmtPrice(q) + '</div>' +
            '<div class="quote-change ' + trendClass(q.pct) + '">' + fmtPct(q.pct) + '</div>'
          : '<div class="quote-change">无数据</div>';
        return '<div class="quote-row">' +
          '<div><span class="quote-name">' + name + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:4px">' + info +
          '<button class="remove-btn" type="button" data-code="' + code6 + '" title="移除">✕</button></div>' +
          '</div>';
      }).join('');
      el.innerHTML = '<div class="quote-list">' + rows + '</div>';
      el.dataset.state = 'ok';
      el.querySelectorAll('.remove-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          setWatchList(getWatchList().filter(function (c) { return c !== btn.dataset.code; }));
          loadCard(btn.closest('.card'));
        });
      });
    });
  };

  /* ---------- 基金持仓 ---------- */

  loaders['card-holdings'] = function (el) {
    return Promise.all([
      fetch(HOLDINGS_URL, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }),
      /* 区间收益是预生成的，缺文件或格式坏了都只该少一个区块，不该拖垮整张持仓卡 */
      fetch(RETURNS_URL, { cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
    ]).then(function (results) {
      var tbl = pickHoldingsTable(results[0]);
      if (!tbl.rows.length) throw new Error('没找到持仓表格');
      el.innerHTML = renderHoldings(tbl, results[1]);
      el.dataset.state = 'ok';
    });
  };

  /* ---------- 刷新 ---------- */

  /* 持仓来自 md 文件，只在手动刷新时重读，不跟着 60 秒轮询 */
  var LIVE_CARDS = ['card-index', 'card-fx', 'card-watch'];

  function refreshAll(includeHoldings) {
    LIVE_CARDS.forEach(function (id) {
      loadCard(document.getElementById(id));
    });
    if (includeHoldings) loadCard(document.getElementById('card-holdings'));
    document.getElementById('update-time').textContent =
      '数据更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  document.getElementById('refresh-btn').addEventListener('click', function () { refreshAll(true); });

  document.getElementById('watch-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('watch-input');
    var code = input.value.trim();
    if (!/^\d{6}$/.test(code)) { input.value = ''; return; }
    var list = getWatchList();
    if (list.indexOf(code) === -1) {
      list.push(code);
      setWatchList(list);
      loadCard(document.getElementById('card-watch'));
    }
    input.value = '';
  });

  refreshAll(true);
  setInterval(function () { refreshAll(false); }, 60 * 1000);
})();
