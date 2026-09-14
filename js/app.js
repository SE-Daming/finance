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
  /* 区间收益 + 推算持仓：仓库里预生成的一份，首屏直接有得看 */
  var RETURNS_URL = 'data/returns.json';
  /* 基金净值：天天基金，每只一个 <script>，执行后净值挂在全局变量上 */
  var NAV_URL = 'https://fund.eastmoney.com/pingzhongdata/';

  /* ---------- 底层：脚本注入（无跨域） ---------- */

  /* capture 在脚本 onload 里**同步**执行，用来把全局变量当场取走。
   * 必须同步：onload 和脚本执行在同一个任务里，中间插不进别的脚本；晚一步
   * （比如放到 .then 里）就可能读到下一只基金覆盖上去的值 */
  function injectScript(url, charset, timeoutMs, capture) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      if (charset) s.charset = charset;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true; s.remove(); reject(new Error('请求超时'));
      }, timeoutMs || 8000);
      s.onload = function () {
        if (done) return;
        done = true; clearTimeout(timer);
        var box = {};
        try { box.value = capture ? capture() : undefined; }
        catch (e) { box.error = e; }
        s.remove();
        if (box.error) reject(box.error); else resolve(box.value);
      };
      s.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); s.remove(); reject(new Error('网络请求失败'));
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

  /* 一行的四个数：市值 / 收益 / 成本 / 收益率。规则在 NavMath.snapshotOf 里，
   * 和 Node 那边（tools/update-returns.mjs）共用同一份——页面显示的市值、推算持仓
   * 的起点都从这里来，两边算得不一样就全乱了 */
  function metrics(row, ci) {
    return NavMath.snapshotOf(
      num(cellOf(row, ci.amount)), num(cellOf(row, ci.profit)),
      num(cellOf(row, ci.capital)), num(cellOf(row, ci.rateIn))
    );
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

  /* 推算持仓：tools/update-returns.mjs 以 holdings.md 的「快照日期」为锚，用净值 +
   * 每日定投计划算出今天的市值/成本/收益。有推算值就用它，表里写的快照退居锚点 */
  function projOf(derived, code) {
    var c = String(code == null ? '' : code).trim();
    if (!/^\d{6}$/.test(c)) return null;
    var f = derived && derived.funds && derived.funds[c];
    return (f && f.projected) || null;
  }

  /* 汇总模型
   * funds  —— 表里的每一只基金
   * groups —— 按「类别」汇总出来的分类（仓位分布 / 收益贡献 / 定投节奏都看它）
   * 只填了「每日定投金额」、没填金额和收益的行，当成纯定投计划行：只进定投合计
   * 传了 derived（returns.json）时，有推算持仓的行用推算值替换表里的快照 */
  function buildModel(tbl, derived) {
    var ci = colIndex(tbl.header);
    var funds = [], groups = [], groupOf = {}, excluded = [];
    var sum = { amount: 0, profit: 0, cost: 0, daily: 0 };

    tbl.rows.forEach(function (row) {
      var cat = cellOf(row, ci.cat);
      if (normKey(cat) === '总计') return;      // 兼容旧数据里手写的总计行，不参与计算

      var x = metrics(row, ci);
      var daily = parseDaily(cellOf(row, ci.daily));
      var isPlan = x.amount == null && x.profit == null && daily != null;
      var proj = isPlan ? null : projOf(derived, cellOf(row, ci.code));

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
        projected: false,
        isPlan: isPlan
      };

      if (proj) {
        fund.amount = proj.amount;
        fund.profit = proj.profit;
        fund.cost = proj.cost;
        fund.rate = proj.rate;
        fund.projected = true;
        fund.derivedProfit = false;             // 已经不是从表里的收益率反推的了
        if (proj.cumulative != null) fund.cumulative = proj.cumulative;
      }
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
      if (fund.capital != null) g.capital += fund.capital;

      if (fund.amount != null) {
        g.amount += fund.amount;
        if (fund.profit != null) {
          g.profit += fund.profit;
          g.cost += fund.cost != null ? fund.cost : fund.amount - fund.profit;
        }
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

  /* 顶部五个数字 */
  function renderOverview(m, derived) {
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

    /* 有推算持仓时，上面这几个数字都不是表里写的快照了，必须说清楚 */
    var pj = derived && derived.projection;
    var projNote = pj
      ? '<p class="hd-note">市值 / 成本 / 收益按 <b>快照日期 ' + esc(pj.snapshotDate) +
        '</b> 的数字，加每日定投计划、用基金每日净值推算到 <b>' + esc(pj.asOf) +
        '</b>，不是实时持仓。跑偏了就从基金 App 复制一份新数字，覆盖 ' +
        '<code>data/holdings.md</code> 的表格，再把那里的「快照日期」改成你复制的那一天。</p>'
      : '';

    return '<div class="hd-overview">' + html + '</div>' + note + projNote;
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

    /* 一只基金一行；同一类别的后续行不再重复类别名
     * 「持有金额」「持有收益」「累计定投」三列优先用模型里的值——有推算持仓时那是
     * 滚到今天的数，表里写的只是锚点；没有推算值时，表里写了数字就原样显示 */
    function fundRow(f, first) {
      function td(c, text, extraCls, title) {
        var cls = [numCls(c.title)].concat(extraCls || []).filter(Boolean);
        return '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') +
          (title ? ' title="' + title + '"' : '') + '>' + text + '</td>';
      }

      var tds = cols.map(function (c) {
        if (c.cost || c.rate) return computed(c.cost ? f.cost : f.rate, !!c.rate);

        if (c.src === ci.cat && !first) return '<td class="hd-grp-name"></td>';

        var val = cellOf(f.raw, c.src);

        if (c.src === ci.amount) {
          if (f.projected) return td(c, f.amount == null ? '—' : fmtMoney(f.amount));
          if (num(val) == null && f.amount != null) {
            return td(c, fmtMoney(f.amount), ['hd-num', 'hd-derived'],
              '由「投入本金 + 持有收益」推算');
          }
        } else if (c.src === ci.cumulative) {
          if (f.projected && f.cumulative != null) return td(c, fmtMoney(f.cumulative));
        } else if (c.src === ci.profit) {
          if (f.projected) {
            return td(c, f.profit == null ? '—' : fmtSigned(f.profit), [clsOf(f.profit)]);
          }
          var p = num(val);
          if (p == null && f.derivedProfit && f.profit != null) {
            return td(c, fmtSigned(f.profit), [clsOf(f.profit), 'hd-derived'],
              '由「持有金额 × 持仓收益率」反推');
          }
          if (p != null) return td(c, esc(val), [clsOf(p)]);
        }

        return td(c, esc(val));
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
        /* 悬停能看见接口认的是哪只基金——代码填错时会取到别人的净值，这是唯一能当场发现的地方 */
        var tip = '净值日期 ' + (r.navDate || '—') +
          (r.name && r.name !== f.name ? ' · 接口返回：' + r.name : '');
        rows += '<tr title="' + esc(tip) + '">' +
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

    /* 说清楚这块数字是哪来的：现算的、还是仓库里那份预生成的 */
    var src = data.sync
      ? '本区块是 ' + fmtWhen(data.sync.at) + ' 点「同步净值」时现算的'
      : '本区块是仓库里预生成的一份，点右上角「同步净值」可以拉到最新的';

    return '<div class="hd-section">基金区间收益 · 截至 ' + esc(data.asOf || '—') + '</div>' +
      '<div class="table-wrap"><table class="returns-table">' +
      '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hd-note">按官方日涨跌幅逐日复利，已含分红再投。QDII 净值晚一天，' +
      '每行悬停可看自己的净值日期。' + src + '，不是实时行情。</p>';
  }

  function renderHoldings(tbl, returns) {
    var m = buildModel(tbl, returns);
    return renderOverview(m, returns) + renderCards(m) + renderAlloc(m) +
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

  var holdings = { md: '', tbl: null, snapshotDate: null, derived: null, syncing: false };

  function fetchMd() {
    return fetch(HOLDINGS_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  /* 「快照日期：2026-09-13」——整行匹配，免得正文里提到也命中 */
  var SNAPSHOT_RE = /^\s*快照日期[：:]\s*(\d{4}-\d{2}-\d{2})\s*$/m;

  function paintHoldings() {
    var el = document.querySelector('#card-holdings .card-body');
    el.innerHTML = renderHoldings(holdings.tbl, holdings.derived);
    el.dataset.state = 'ok';
  }

  loaders['card-holdings'] = function (el) {
    return Promise.all([
      fetchMd(),
      /* 区间收益缺文件或格式坏了只该少一个区块，不该拖垮整张持仓卡 */
      fetch(RETURNS_URL, { cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
    ]).then(function (results) {
      var md = results[0];
      if (!md) throw new Error('持仓文件读取失败');

      var tbl = pickHoldingsTable(md);
      if (!tbl.rows.length) throw new Error('没找到持仓表格');

      holdings.md = md;
      holdings.tbl = tbl;
      holdings.snapshotDate = (md.match(SNAPSHOT_RE) || [])[1] || null;

      /* 上次同步的结果优先：它比仓库里那份新。持仓表改过（比如换了新快照）就作废，
       * 否则会拿旧快照的数去滚 */
      var cached = readSyncCache(hashStr(md));
      holdings.derived = cached ? cached.data : results[1];
      paintHoldings();
      setSyncStatus(cached
        ? '上次同步 ' + fmtWhen(cached.at)
        : (holdings.derived ? '预生成数据' : ''), '');
    });
  };

  /* ---------- 同步净值 ----------
   *
   * 净值走 <script> 注入：pingzhongdata 是个普通脚本，执行完把净值挂在全局变量上，
   * 注入天然没有跨域问题——不用 CORS、不用代理、不用服务端配合，浏览器自己就能算。
   * 代价是每只基金整包 100~550 KB、二十多只合计好几 MB，所以只在点按钮时拉一次，
   * 结果存 localStorage，之后打开页面直接用缓存。
   */

  var SYNC_KEY = 'finance-nav-sync';
  /* 一次拉几只。二十多只并发全开会把连接占满，太贪反而慢 */
  var SYNC_CONCURRENCY = 4;
  var NAV_RETRIES = 2;

  /* 持仓表的哈希。表一变（换了新快照、加了基金）同步缓存就作废 */
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function fmtWhen(ms) {
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  /* 一秒以下写成「0 秒」看着像没干活，所以分档 */
  function fmtDur(ms) {
    return ms < 1000 ? Math.round(ms) + ' 毫秒' : (ms / 1000).toFixed(1) + ' 秒';
  }

  function readSyncCache(hash) {
    try {
      var c = JSON.parse(localStorage.getItem(SYNC_KEY));
      /* asOf 有值才认：一次都没成功的同步会写出 funds 为空的缓存，那种不如不要 */
      if (c && c.hash === hash && c.at && c.data && c.data.asOf && c.data.funds) return c;
    } catch (e) { /* 缓存坏了就当没有 */ }
    return null;
  }

  function setSyncStatus(text, cls) {
    var el = document.getElementById('sync-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'hd-sync' + (cls ? ' ' + cls : '');
  }

  /* 拉一只基金的净值。文件名就是 6 位代码，执行后：
   *   Data_netWorthTrend 净值走势  fS_name 基金全名  fS_code 代码 */
  function loadTrend(code) {
    return injectScript(NAV_URL + code + '.js', null, 20000, function () {
      var raw = window.Data_netWorthTrend;
      var name = window.fS_name;
      var got = window.fS_code;
      /* 取到就立刻把引用置空：一只一千多个净值点，二十多只全挂在 window 上太占内存。
       * 注意只能置 null 不能 delete——脚本里是 var 声明的，属性不可配置，严格模式下
       * delete 会直接抛 TypeError */
      window.Data_netWorthTrend = null;
      window.fS_name = null;
      window.fS_code = null;
      /* 万一注入的脚本互相踩了（理论上不会），至少能当场发现，而不是把别家的净值当自己的算 */
      if (String(got) !== code) throw new Error('返回的是 ' + (got || '别的东西') + '，不是 ' + code);
      return { name: name || '', trend: NavMath.normalizeTrend(raw) };
    });
  }

  function loadTrendRetry(code, tries) {
    return loadTrend(code).catch(function (err) {
      if (tries <= 1) throw err;
      return new Promise(function (r) { setTimeout(r, 700); })
        .then(function () { return loadTrendRetry(code, tries - 1); });
    });
  }

  /* 并发数受限地拉一批，返回 { trends: {code: {...}}, failed: [{code, msg}] } */
  function loadTrends(codes, onProgress) {
    var trends = {}, failed = [];
    var next = 0, done = 0;

    function worker() {
      if (next >= codes.length) return Promise.resolve();
      var code = codes[next++];
      return loadTrendRetry(code, NAV_RETRIES).then(function (t) {
        trends[code] = t;
      }, function (err) {
        failed.push({ code: code, msg: err.message });
      }).then(function () {
        done++;
        if (onProgress) onProgress(done, codes.length);
        return worker();
      });
    }

    var n = Math.min(SYNC_CONCURRENCY, codes.length);
    var running = [];
    for (var i = 0; i < n; i++) running.push(worker());
    return Promise.all(running).then(function () {
      return { trends: trends, failed: failed };
    });
  }

  /* 持仓表 → 待同步的基金清单。和 tools/update-returns.mjs 读的是同一批：
   * 有 6 位代码的行都算，不管表里有没有填金额 */
  function fundEntries(tbl) {
    var ci = colIndex(tbl.header);
    var out = [], seen = {};
    tbl.rows.forEach(function (row) {
      var code = String(cellOf(row, ci.code)).trim();
      if (!/^\d{6}$/.test(code) || seen[code]) return;
      seen[code] = true;
      var x = metrics(row, ci);
      out.push({
        code: code,
        name: cellOf(row, ci.name),
        amount: x.amount, cost: x.cost,
        daily: parseDaily(cellOf(row, ci.daily)) || 0,
        cumulative: num(cellOf(row, ci.cumulative))
      });
    });
    return out;
  }

  function syncNav() {
    if (holdings.syncing || !holdings.tbl) return;

    var entries = fundEntries(holdings.tbl);
    if (!entries.length) { setSyncStatus('表里没有 6 位基金代码', 'bad'); return; }

    holdings.syncing = true;
    var btn = document.getElementById('sync-btn');
    btn.disabled = true;
    var t0 = Date.now();
    setSyncStatus('同步中 0/' + entries.length, 'busy');

    loadTrends(entries.map(function (e) { return e.code; }), function (done, total) {
      setSyncStatus('同步中 ' + done + '/' + total, 'busy');
    }).then(function (res) {
      var ok = entries.filter(function (e) { return res.trends[e.code]; })
        .map(function (e) {
          var t = res.trends[e.code];
          return {
            code: e.code,
            name: t.name || e.name,      // 接口给的全名，留着核对代码有没有写错
            trend: t.trend,
            amount: e.amount, cost: e.cost, daily: e.daily, cumulative: e.cumulative
          };
        });

      /* 一只都没成功：什么都别动。空结果覆盖上去会把现有的数全抹掉，比不同步还糟 */
      if (!ok.length) {
        setSyncStatus('同步失败：' + entries.length + ' 只都没取到净值（' +
          (res.failed[0] ? res.failed[0].msg : '') + '）', 'bad');
        return;
      }

      /* 宁缺毋滥只对无人值守的定时任务成立。这里是用户等着看的，二十多只拉到十九只
       * 也要把十九只摆出来，缺了谁明确写出来就行——但绝不静默 */
      var payload = NavMath.buildPayload(ok, holdings.snapshotDate);
      payload.sync = { at: Date.now(), ms: Date.now() - t0, failed: res.failed };

      holdings.derived = payload;
      try {
        localStorage.setItem(SYNC_KEY, JSON.stringify({
          hash: hashStr(holdings.md), at: payload.sync.at, data: payload
        }));
      } catch (e) { /* 存不下就算了（比如隐私模式），本次照样能用 */ }

      paintHoldings();

      if (res.failed.length) {
        setSyncStatus('同步完成，但 ' + res.failed.length + ' 只没取到：' +
          res.failed.map(function (f) { return f.code; }).join('、'), 'bad');
      } else {
        setSyncStatus('刚刚同步 · ' + fmtDur(payload.sync.ms), '');
      }
    }).catch(function (err) {
      setSyncStatus('同步失败：' + err.message, 'bad');
    }).then(function () {
      holdings.syncing = false;
      btn.disabled = false;
    });
  }

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

  document.getElementById('sync-btn').addEventListener('click', syncNav);

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
