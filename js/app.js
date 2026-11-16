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
  /* 交易日历要取多少个交易日：只需覆盖「快照 → 今天」这段尾巴。
   * 更早的区间由各基金自己的净值日兜底（见 nav-math.js 的 buildPayload），
   * 所以这里给足 40 天足够，不用跟着快照日期一起涨 */
  var CAL_DAYS = 40;

  var WATCH_KEY = 'finance-watch-list';
  var DEFAULT_WATCH = ['161725', '510300'];

  /* 持仓数据源：改 data/holdings.md 即可，无需动代码 */
  var HOLDINGS_URL = 'data/holdings.md';
  /* 区间收益 + 推算持仓：仓库里预生成的一份，首屏直接有得看 */
  var RETURNS_URL = 'data/returns.json';
  /* 申购状态 + 单日限额，同样预生成。那个接口认短 User-Agent，浏览器改不了 UA，
   * 页面里 fetch 一定拿不到，所以只能这样取（见 tools/update-limits.mjs 的说明） */
  var LIMITS_URL = 'data/limits.json';
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

  /* 近 N 个交易日的日K原始数组，每行 [日期, 开, 收, 高, 低, 成交量] */
  function fetchKline(code, days) {
    var cb = 'financeKline_' + Date.now();
    return new Promise(function (resolve, reject) {
      window[cb] = function (json) {
        try {
          var d = json.data[code];
          var arr = (d && (d.day || d.qfqday)) || [];
          if (!arr.length) throw new Error('K线为空');
          resolve(arr);
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

  /* 近 N 个交易日收盘价 */
  function fetchCloses(code, days) {
    return fetchKline(code, days).then(function (arr) {
      return arr.map(function (k) { return parseFloat(k[2]); });
    });
  }

  /* A 股交易日历（也就是上证指数的日K日期），推算持仓按它一天推进一期定投。
   * 用真实日历而不是「周一到周五」：节假日休市那天没有定投，按工作日算会永远多算。 */
  function fetchTradingDays() {
    return fetchKline(KLINE_CODE, CAL_DAYS).then(function (arr) {
      return arr.map(function (k) { return k[0]; });
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
        /* 算不出市值 → 不计入总额。只记下是哪一行，文案里不去断言它缺了什么 */
        excluded.push({ cat: cat, name: cellOf(row, ci.name) });
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

    /* 文案只说「算不出市值」这件事，不替用户判断缺的是哪一格：填了「投入本金」
     * 但没填「持有收益」的行同样算不出市值，那时候说「也没有投入本金」就是错的 */
    var note = m.excluded.length
      ? '<p class="hd-note">未计入总额：' + m.excluded.map(function (e) {
          return esc(e.name || e.cat);
        }).join('、') +
        '——市值算不出来，需要「持有金额」，或者「投入本金」和「持有收益」两个都填。</p>'
      : '';

    /* 有推算持仓时，上面这几个数字都不是表里写的快照了，必须说清楚 */
    var pj = derived && derived.projection;
    var projNote = pj
      ? '<p class="hd-note">市值 / 成本 / 收益按 <b>快照日期 ' + esc(pj.snapshotDate) +
        '</b> 的数字，加每日定投计划、按 A 股交易日推算到 <b>' + esc(pj.asOf) +
        '</b>，不是实时持仓。' + esc(NavMath.PROJ_NOTE) +
        '跑偏了就从基金 App 复制一份新数字，覆盖 ' +
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

  /* 申购限额：读预生成的 data/limits.json（见 tools/update-limits.mjs）
   * 存在的意义只有一个——把「定投其实买不进去」这件事摆到脸上：限购失败是静默的，
   * App 里计划状态照样是「正常」，钱一分没买。判定规则在 js/limit-check.js，脚本共用同一份 */
  function renderLimits(m, data) {
    var byCode = (data && data.funds) || null;
    if (!byCode || !Object.keys(byCode).length) return '';

    var rows = [];
    m.groups.forEach(function (g) {
      g.funds.forEach(function (f) {
        var code = String(f.codes || '').trim();
        if (!/^\d{6}$/.test(code)) return;
        var L = byCode[code] || null;
        rows.push({
          cat: g.cat, name: f.name, code: code, plan: f.daily, L: L,
          v: LimitCheck.verdict(f.daily, L)
        });
      });
    });
    if (!rows.length) return '';

    /* 有问题的排前面：这块是给人看「哪里买不进」的，不该让人自己往下翻 */
    var order = { bad: 0, warn: 1, flat: 2, ok: 3 };
    rows.sort(function (a, b) { return order[a.v.key] - order[b.v.key]; });

    var capTxt = function (L) {
      if (!L) return '—';
      if (L.max != null) return fmtMoney(L.max) + ' 元/天';
      /* max 为空有两种：真的不限购，和「限大额但接口没给数字」。后者写成「不限」会让人
       * 以为想买多少买多少——判定那列已经在说「上限不明」了，这列得跟上 */
      return L.maxKnown === false ? '不明' : '不限';
    };

    var body = rows.map(function (r) {
      return '<tr class="lim-row-' + r.v.key + '">' +
        '<td class="hd-grp-name">' + esc(r.cat) + '</td>' +
        '<td class="rt-name" title="' + esc(r.name) + '">' + esc(r.name) + '</td>' +
        '<td class="hd-num">' + esc(r.code) + '</td>' +
        '<td>' + esc(r.L ? r.L.sgzt : '—') + '</td>' +
        '<td class="hd-num">' + capTxt(r.L) + '</td>' +
        '<td class="hd-num">' + (r.plan > 0 ? fmtMoney(r.plan) + ' 元/天' : '—') + '</td>' +
        '<td class="lim-' + r.v.key + '">' + esc(r.v.txt) + '</td>' +
        '</tr>';
    }).join('');

    var bad = rows.filter(function (r) { return r.v.key === 'bad'; }).length;
    var warn = rows.filter(function (r) { return r.v.key === 'warn'; }).length;
    var summary = [];
    if (bad) summary.push(bad + ' 只买不进 / 超限');
    if (warn) summary.push(warn + ' 只顶格');
    if (!summary.length) summary.push('全部正常');

    var asOf = data.asOf ? Date.parse(data.asOf) : NaN;
    return '<div class="hd-section">申购限额 · ' + esc(summary.join('，')) + '</div>' +
      '<div class="table-wrap"><table class="limits-table"><colgroup>' +
      '<col style="width:92px"><col style="width:196px"><col style="width:82px">' +
      '<col style="width:92px"><col style="width:104px"><col style="width:104px">' +
      '<col style="width:158px"></colgroup><thead><tr>' +
      '<th>类别</th><th>基金名称</th><th class="hd-num">代码</th>' +
      '<th>申购状态</th><th class="hd-num">单日上限</th>' +
      '<th class="hd-num">计划定投</th><th>判定</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="hd-note">' + esc(LimitCheck.NOTE) +
      ' 申购状态由 <code>tools/update-limits.mjs</code> 预生成' +
      (isNaN(asOf) ? '' : '，取数时间 ' + fmtWhen(asOf)) +
      '——这个接口认短 User-Agent，浏览器里改不了 UA 拿不到，所以要重新跑脚本才会更新。' +
      (data.failed && data.failed.length
        ? ' 本次有 ' + data.failed.length + ' 只没取到：' +
          data.failed.map(function (f) { return esc(f.code); }).join('、') + '。'
        : '') +
      '</p>';
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
        /* 悬停能看见接口认的是哪只基金——代码填错时会取到别人的净值，这是唯一能当场发现的地方。
         * 顺便列出各区间起点：长假后「1周」可能和「1日」同值，看起点就知道那一周里
         * 只公布了一期净值，不是算错 */
        var starts = RETURN_COLS.map(function (c) {
          return r.start && r.start[c.key] ? c.label + ' 自 ' + r.start[c.key] : '';
        }).filter(Boolean).join(' · ');
        var tip = '净值日期 ' + (r.navDate || '—') +
          (starts ? ' · 区间起点 ' + starts : '') +
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
      '每行悬停可看自己的净值日期和各区间起点。长假之后「1周」可能和「1日」相同——' +
      '那一周里只公布了一期净值，不是算错。' + src + '，不是实时行情。</p>';
  }

  function renderHoldings(tbl, returns) {
    var m = buildModel(tbl, returns);
    return renderOverview(m, returns) + renderCards(m) + renderAlloc(m) +
      renderBars(m) + renderDca(m) + renderLimits(m, holdings.limits) +
      renderReturns(m, returns) + renderTable(tbl, m);
  }

  /* ---------- 区间最大跌幅 / 涨幅 ----------
   *
   * 只看最近 N 天：窗口内的最高点 → 之后的低点，最大跌幅（回撤）；
   * 反过来，窗口内的最低点 → 之后的高点，最大涨幅。
   *
   * 为什么不给「成立以来最大回撤」：那个数对「现在该不该加仓」没有信息量。一只涨了三年的
   * 基金今天的回撤是 0，可它历史最大回撤有 30%——三年前发生的事和眼下的决定无关。
   * 也不等于区间涨跌幅：跌完又涨回来，涨跌幅可能接近 0，但中途那一段是真真切切跌过的，
   * 加仓的人扛的就是那一段。涨幅同理：只写「区间涨 +2%」会把「先跌 15% 再涨 17%」那种
   * 一路上都在纠结的行情说成岁月静好。
   *
   * 曲线用复权的（NavMath.equityCurve），和上面的「基金区间收益」同一套口径，
   * 不会出现「收益为正、回撤却很深」的假象（除息日单位净值跳水不是回撤）。
   *
   * 换窗口只是在浏览器里换个 N：一只能看 360 天的复权曲线已经在 data/returns.json 里了
   * （或「同步净值」现算的那份），不用重新拉几 MB 净值。临时想看别的基金，输入代码现拉一只。
   */

  var DD_WINDOWS = [7, 30, 60, 90, 180, 240, 360];
  var DD_KEY = 'finance-dd-custom';
  var DD_DEFAULT_DAYS = 90;

  var dd = {
    days: DD_DEFAULT_DAYS,
    scope: 'all',    // 'all' 或某个类别名
    custom: [],      // 自己加的代码，存在浏览器本地
    cache: {},       // 现拉的：code → {name, series}
    failed: {},      // 现拉失败的：code → 原因
    pick: null,      // 曲线上画哪几只；null 表示还没选过（用默认两只）
    rows: [],        // 最近一次渲染的可见行，切曲线时用来判断当前选了谁
    data: null,      // returns.json，或「同步净值」的结果
    tbl: null        // 持仓表，用来给每只基金配上类别
  };

  function getDdCustom() {
    try {
      var saved = JSON.parse(localStorage.getItem(DD_KEY));
      if (Array.isArray(saved)) {
        return saved.filter(function (c) { return /^\d{6}$/.test(c); });
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return [];
  }

  function setDdCustom(list) {
    try { localStorage.setItem(DD_KEY, JSON.stringify(list)); } catch (e) { /* 存不下就算了 */ }
  }

  /* 待比较的基金 = 持仓表里有代码的行 + 自己加的代码。
   * 没有复权曲线的（还没跑 update-returns.mjs、或代码取不到净值）先不出现——
   * 拿一个 0% 顶上去比不出现更误导，谁知道是「没跌过」还是「没数据」 */
  function ddRows() {
    var byCode = (dd.data && dd.data.funds) || {};
    var rows = [], seen = {};

    function add(cat, name, code, series, own) {
      if (seen[code] || !series || series.length < 2) return;
      seen[code] = 1;
      rows.push({ cat: cat, name: name || code, code: code, series: series, own: !!own });
    }

    if (dd.tbl) {
      var ci = colIndex(dd.tbl.header);
      dd.tbl.rows.forEach(function (row) {
        var code = String(cellOf(row, ci.code)).trim();
        var f = byCode[code];
        add(cellOf(row, ci.cat), cellOf(row, ci.name), code, f && f.series, false);
      });
    }

    dd.custom.forEach(function (code) {
      var c = dd.cache[code], f = byCode[code];
      add('自选', (c && c.name) || (f && f.name), code,
        c ? c.series : (f && f.series), true);
    });

    return rows;
  }

  function ddPct(v) { return (v * 100).toFixed(2) + '%'; }

  /* 「区间涨跌」拆成正负两列：净涨只填涨幅、净跌只填跌幅，另一边留空。
   * 三个数说的是同一件事——涨跌是带符号的净额，拆开是为了扫一眼看出方向，不用先解那个减号。
   * 不拆成「上涨日累计 / 下跌日累计」：那个数跟净涨跌不是加法关系（复利），
   * 并排放着会让人以为加起来对不上是算错了。
   *
   * 四舍五入到 0 的那点零头（不到 0.005%）落在涨幅格显示 0.00%，免得写出「-0.00%」这种怪东西。 */
  function ddUpDown(ret) {
    if (ret == null) return { up: null, dn: null };
    var pct = Math.round(ret * 10000) / 100;
    if (pct > 0) return { up: ret, dn: null };
    if (pct < 0) return { up: null, dn: -ret };
    return { up: 0, dn: null };
  }

  /* 只留月-日：这一列是给人看「哪一段跌的」，年份在这没信息量 */
  function ddDate(d) { return d ? d.slice(5) : '—'; }

  function ddFailedNote() {
    var codes = Object.keys(dd.failed);
    if (!codes.length) return '';
    return '<p class="hd-note">这些代码没取到净值：' +
      codes.map(function (c) {
        return '<code>' + esc(c) + '</code>（' + esc(dd.failed[c]) + '）';
      }).join('、') + '</p>';
  }

  /* 「范围」下拉的选项跟着有数据的类别走，不写死：持仓表里加了新类别，这里自动就多一项 */
  function paintDdScope(rows) {
    var sel = document.getElementById('dd-scope');
    if (!sel) return;

    var cats = [];
    rows.forEach(function (r) { if (cats.indexOf(r.cat) === -1) cats.push(r.cat); });
    if (dd.scope !== 'all' && cats.indexOf(dd.scope) === -1) dd.scope = 'all';

    sel.innerHTML = '<option value="all">全部</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    sel.value = dd.scope;
  }

  /* 这块最容易让人以为算错了的地方：同一只基金，「区间收益」的 1月 和这里的 30 天
   * 数字对不上。不是算错——前者按日历月回溯（一个月前的同一天），后者按天数回溯，
   * 起算点差一个交易日，差的就是那一天。
   *
   * 不写死日期（数据一更新就过期），而是拿一只净值日正好等于 asOf 的基金当场推：
   *   月窗口的起算收盘 = 不晚于「一个月前」的那个净值日
   *   这里 N 天的起算收盘 = 不早于「N 天前」的那个净值日（就是表里的「窗口起点」）
   * 7 天和上面的 1周 是同一个口径，直接说数字应当一致。 */
  var DD_MONTH_PAIR = { 30: ['1月', 1], 90: ['3月', 3], 180: ['6月', 6], 360: ['1年', 12] };

  function ddAlignNote(rows) {
    var asOf = dd.data && dd.data.asOf;
    if (!asOf) return '';
    if (dd.days === 7) return ' 「7 天」和上面「1周」是同一个窗口，两个数应当完全一样。';

    var pair = DD_MONTH_PAIR[dd.days];
    if (!pair) return '';

    var target = NavMath.shiftMonths(asOf, pair[1]);
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i].d;
      var f = dd.data.funds[rows[i].r.code];
      var s = f && f.series;
      if (!s || d.to !== asOf) continue;          // 用一只净值日已到 asOf 的基金当例子

      var base = null;
      for (var j = 0; j < s.length; j++) if (s[j][0] <= target) base = s[j][0];
      if (!base || base === d.from) return '';

      return ' 跟上面「' + pair[0] + '」对一下就知道差在哪：它从 ' + ddDate(base) + ' 收盘起算，' +
        '这里的 ' + dd.days + ' 天从 ' + ddDate(d.from) + ' 收盘起算——中间那几天的涨跌，' +
        '一边算了一边没算。';
    }
    return '';
  }

  /* ---------- 窗口内的曲线 ----------
   *
   * 表格只能给数字，而这块最容易看拧的恰恰是两件事：
   *   「区间涨跌」和「最大回撤」不是一回事——跌完又涨回来，涨跌接近 0，回撤照样很深
   *   起点差一天，同一个窗口的数字就差一截（「1月」按日历月、「30 天」按天数）
   * 画出来就一眼看明白：曲线从窗口起点归零，纵轴是百分比，和表格里的数字直接对得上；
   * 虚线标出每只回撤最深的那一段（窗口内高点到低点），那一段就是「最大回撤」。
   *
   * 默认画 008164 和 025857：一只跌完涨回来、一只真的在跌，一涨一跌正好当反例。
   * 点表格的行可以换基金。选了什么存在浏览器本地，刷新还在。
   */

  var DD_PICK_KEY = 'finance-dd-pick';
  var DD_PICK_DEFAULT = ['008164', '025857'];
  var DD_PICK_MAX = 4;
  /* 刻意避开红绿：这两个颜色在别处表示涨跌，曲线本身不分好坏 */
  var DD_CHART_COLORS = ['#3b6fd4', '#c0568f', '#4aa8a0', '#e08a3c'];

  function getDdPick() {
    try {
      var saved = JSON.parse(localStorage.getItem(DD_PICK_KEY));
      if (Array.isArray(saved)) {
        return saved.filter(function (c) { return /^\d{6}$/.test(c); }).slice(0, DD_PICK_MAX);
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return null;                       // 没存过 → 用默认那两只
  }

  function setDdPick(list) {
    try { localStorage.setItem(DD_PICK_KEY, JSON.stringify(list)); } catch (e) { /* 存不下就算了 */ }
  }

  /* 曲线上画哪几只：点过就用他点的，没点过用默认两只。
   * 点过的那几只被「范围」筛掉了就不画——换成别的基金，会让人以为自己的选择没生效 */
  function ddPicked(rows) {
    var byCode = {};
    rows.forEach(function (x) { byCode[x.r.code] = x; });

    if (dd.pick == null) {
      var def = DD_PICK_DEFAULT
        .map(function (c) { return byCode[c]; })
        .filter(Boolean);
      return (def.length ? def : rows.slice(0, 2)).slice(0, DD_PICK_MAX);
    }
    return dd.pick
      .map(function (c) { return byCode[c]; })
      .filter(Boolean)
      .slice(0, DD_PICK_MAX);
  }

  function ddTogglePick(code) {
    var cur = ddPicked(dd.rows || []).map(function (x) { return x.r.code; });
    var at = cur.indexOf(code);
    if (at >= 0) cur.splice(at, 1);
    else {
      cur.push(code);
      if (cur.length > DD_PICK_MAX) cur.shift();   // 满了就顶掉最早加的那只
    }
    dd.pick = cur;
    setDdPick(cur);
    renderDD();
  }

  /* SVG 只画折线和网格：viewBox 固定 0~100，preserveAspectRatio="none" 让它自动占满宽度，
   * 线宽用 vector-effect 保持 1px 不跟着拉伸。点、文字用绝对定位的 HTML——
   * 放进会拉伸的 SVG 里会变成椭圆和胖字。 */
  function ddChart(rows) {
    var picked = ddPicked(rows);
    if (!picked.length) {
      /* 用户把曲线全删了 / 选的那几只被「范围」筛掉了：留一句话，别让图无声消失 */
      if (dd.pick && !dd.pick.length) {
        return '<p class="dd-chart-cap">点表格里任意一行，把它的窗口曲线画出来看看。</p>';
      }
      if (dd.pick && dd.pick.length) {
        return '<p class="dd-chart-cap">曲线里选的那几只不在当前「范围」里，点表格里的行换一批。</p>';
      }
      return '';
    }

    var x0 = picked[0].d.from, x1 = picked[0].d.to;
    picked.forEach(function (x) {
      if (x.d.from < x0) x0 = x.d.from;
      if (x.d.to > x1) x1 = x.d.to;
    });
    var t0 = Date.parse(x0), t1 = Date.parse(x1);
    var tSpan = (t1 - t0) || 1;

    var lo = 0, hi = 0, lanes = [];
    picked.forEach(function (x, i) {
      var base = null, pts = [];
      x.r.series.forEach(function (p) {
        if (p[0] < x.d.from || p[0] > x.d.to) return;
        if (base == null) base = p[1];
        var v = (p[1] / base - 1) * 100;              // 相对窗口起点涨了/跌了多少（%）
        pts.push({ date: p[0], v: v, x: ((Date.parse(p[0]) - t0) / tSpan) * 100 });
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
      if (pts.length < 2) return;
      lanes.push({ row: x, pts: pts, color: DD_CHART_COLORS[i % DD_CHART_COLORS.length] });
    });
    if (!lanes.length) return '';

    /* 纵轴留一点白，浅跌浅涨时不至于贴着边框 */
    var pad = Math.max((hi - lo) * 0.14, 0.5);
    var ymin = lo - pad, ymax = hi + pad;
    function yf(v) { return 100 - ((v - ymin) / (ymax - ymin)) * 100; }

    /* 刻度步长取 0.5 / 1 / 2 / 2.5 / 5 / 10…，让刻度别超过 6 条 */
    var steps = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    var step = 100;
    for (var s = 0; s < steps.length; s++) {
      if ((ymax - ymin) / steps[s] <= 6) { step = steps[s]; break; }
    }

    var grid = '', yticks = '';
    for (var t = Math.ceil(ymin / step) * step; t <= ymax + 1e-9; t += step) {
      var ty = yf(t);
      /* stroke 之类写成属性而不是只靠 CSS：万一 CSS 没加载上（版本没对齐、缓存没刷），
         折线默认是黑色填充，会画成一坨黑块。属性优先级低于 CSS，正常时照样听 CSS 的 */
      grid += '<line x1="0" y1="' + ty.toFixed(2) + '" x2="100" y2="' + ty.toFixed(2) + '"' +
        ' stroke="#eef1f7" stroke-width="1"' +
        ' class="dd-grid' + (Math.abs(t) < 1e-9 ? ' dd-grid-zero' : '') +
        '" vector-effect="non-scaling-stroke"/>';
      /* 浮点累加会攒出 4.999999999，先收一下 */
      var tv = Math.round(t * 100) / 100;
      yticks += '<span class="dd-ytick" style="top:' + ty.toFixed(2) + '%">' +
        (tv > 0 ? '+' : '') + tv + '%</span>';
    }

    var lines = '', marks = '', legend = '';

    function at(lane, date) {
      for (var i = 0; i < lane.pts.length; i++) if (lane.pts[i].date === date) return lane.pts[i];
      return null;
    }

    lanes.forEach(function (ln) {
      var d = ln.row.d;
      lines += '<polyline class="dd-line" fill="none" stroke="' + ln.color + '" stroke-width="1.8"' +
        ' vector-effect="non-scaling-stroke" points="' +
        ln.pts.map(function (p) { return p.x.toFixed(2) + ',' + yf(p.v).toFixed(2); }).join(' ') +
        '"/>';

      var pk = at(ln, d.peakDate), tr = at(ln, d.troughDate);
      if (pk && tr && d.mdd > 0) {
        /* 高点到低点那一段：竖虚线 + 两个点 + 跌幅标注，正好是表里的「最大回撤」 */
        marks += '<i class="dd-drop" style="left:' + tr.x.toFixed(2) + '%;top:' + yf(pk.v).toFixed(2) +
          '%;height:' + (yf(tr.v) - yf(pk.v)).toFixed(2) + '%;border-left-color:' + ln.color + '"></i>' +
          '<i class="dd-dot" style="left:' + pk.x.toFixed(2) + '%;top:' + yf(pk.v).toFixed(2) +
          '%;color:' + ln.color + '" title="' + esc(pk.date + ' 高点') + '"></i>' +
          '<i class="dd-dot dd-trough" style="left:' + tr.x.toFixed(2) + '%;top:' + yf(tr.v).toFixed(2) +
          '%;color:' + ln.color + '" title="' + esc(tr.date + ' 低点') + '"></i>';

        /* 标注压在谷点正下方——放右边会和曲线打架；贴着左右边缘时往里收，别被裁掉 */
        var shift = tr.x < 6 ? 'translate(-6px,11px)'
          : tr.x > 94 ? 'translate(calc(-100% + 6px),11px)'
          : 'translate(-50%,11px)';
        marks += '<span class="dd-mtag" style="left:' + tr.x.toFixed(2) + '%;top:' +
          yf(tr.v).toFixed(2) + '%;color:' + ln.color + ';transform:' + shift + '">-' +
          ddPct(d.mdd) + '</span>';
      }

      /* 低点到高点那一段：点线 + 涨幅标注，和上面那条虚线正好互为镜像。
       * 只画线不画点——高点常常和跌段的起点是同一天，两个点叠在一起谁也看不清。
       * 标注压在高点「上方」：跌段那条压在下方的谷底，两条分开就不打架了。 */
      var lp = at(ln, d.runLowDate), hp = at(ln, d.runHighDate);
      if (lp && hp && d.mru > 0) {
        marks += '<i class="dd-rise" style="left:' + hp.x.toFixed(2) + '%;top:' +
          yf(hp.v).toFixed(2) + '%;height:' + (yf(lp.v) - yf(hp.v)).toFixed(2) +
          '%;border-left-color:' + ln.color + '"></i>';

        var shiftUp = hp.x < 6 ? 'translate(-6px,-15px)'
          : hp.x > 94 ? 'translate(calc(-100% + 6px),-15px)'
          : 'translate(-50%,-15px)';
        marks += '<span class="dd-mtag dd-mtag-up" style="left:' + hp.x.toFixed(2) + '%;top:' +
          yf(hp.v).toFixed(2) + '%;color:' + ln.color + ';transform:' + shiftUp + '">+' +
          ddPct(d.mru) + '</span>';
      }

      /* 图例用「跌 / 涨」两个汉字代替正负号：两个数并排时，光靠 +/- 和颜色分不清哪个是哪个 */
      legend += '<span><i style="background:' + ln.color + '"></i>' + esc(ln.row.r.name) +
        ' <b>跌 ' + ddPct(d.mdd) + '</b>' +
        ' <b class="dd-lg-up">涨 ' + ddPct(d.mru) + '</b>' +
        ' <em>区间 ' + (d.ret == null ? '—' : fmtRate(d.ret)) + '</em></span>';
    });

    /* 横轴只标起止和中间两格，日期取第一只基金的真实净值日（位置按日期算）。
     * 窗口短的时候中间两格会挤在相邻的交易日上，离得太近就丢掉一个 */
    var f0 = lanes[0].pts, n0 = f0.length - 1;
    var ends = [0, n0], mids = [Math.round(0.34 * n0), Math.round(0.67 * n0)];
    var keep = ends.slice();
    mids.forEach(function (k) {
      if (keep.indexOf(k) !== -1) return;
      var far = keep.every(function (q) { return Math.abs(f0[q].x - f0[k].x) >= 15; });
      if (far) keep.push(k);
    });
    keep.sort(function (a, b) { return f0[a].x - f0[b].x; });
    var xticks = keep.map(function (k) {
      var p = f0[k], mid = ends.indexOf(k) === -1;
      return '<span class="dd-xtick' + (mid ? ' dd-xt-mid' : '') +
        '" style="left:' + p.x.toFixed(2) + '%">' + ddDate(p.date) + '</span>';
    }).join('');

    return '<div class="dd-chart">' +
      '<div class="dd-chart-lg">' + legend + '</div>' +
      '<div class="dd-plot"><svg class="dd-svg" viewBox="0 0 100 100" preserveAspectRatio="none"' +
        ' width="100%" height="230">' +
        grid + lines + '</svg>' + yticks + marks + '</div>' +
      '<div class="dd-xaxis">' + xticks + '</div>' +
      '<p class="dd-chart-cap">曲线是窗口内的复权净值，起点＝0%。<b>竖虚线</b>标的是每只跌得最猛的一段：' +
        '从窗口内高点跌到低点，跌幅就是表里的「最大跌幅」；<b>竖点线</b>是反过来那段——先低后高，' +
        '涨了多少就是「最大涨幅」。两条都和首尾的「区间涨跌」不是一回事：跌完又涨回来的那只，' +
        '涨跌可以是正的，中间那两段照样又深又长。' +
        '点表格里的行可以换基金（最多 ' + DD_PICK_MAX + ' 只）。</p>' +
      '</div>';
  }

  function renderDD() {
    var el = document.querySelector('#card-dd .card-body');
    if (!el) return;

    var all = ddRows();
    paintDdScope(all);

    var rows = all
      .filter(function (r) { return dd.scope === 'all' || r.cat === dd.scope; })
      .map(function (r) { return { r: r, d: NavMath.drawdown(r.series, dd.days) }; })
      .filter(function (x) { return x.d; });

    if (!rows.length) {
      el.innerHTML = '<p class="hint">还没有可比较的净值数据。持仓里的基金要有 ' +
        '<code>data/returns.json</code> 里的复权曲线（跑一次 <code>node tools/update-returns.mjs</code>），' +
        '也可以在上面直接输代码临时拉。</p>' + ddFailedNote();
      el.dataset.state = 'ok';
      return;
    }

    /* 跌得深的排前面：这块首先是用来找「谁在这个窗口里最难受」的。
     * 跌幅打平时再比涨幅——同一条跌幅下涨得多，说明它更折腾 */
    rows.sort(function (a, b) {
      if (b.d.mdd !== a.d.mdd) return b.d.mdd - a.d.mdd;
      if (b.d.mru !== a.d.mru) return b.d.mru - a.d.mru;
      return a.r.code < b.r.code ? -1 : 1;
    });

    var worst = rows[0];
    var best = null;
    rows.forEach(function (x) { if (!best || x.d.mru > best.d.mru) best = x; });

    /* 曲线里画了哪几只，表里就标一下：行首一个小圆点，颜色和曲线一致，点行可以切换 */
    var picked = ddPicked(rows);
    dd.rows = rows;
    var pickColor = {};
    picked.forEach(function (x, i) {
      pickColor[x.r.code] = DD_CHART_COLORS[i % DD_CHART_COLORS.length];
    });

    var body = rows.map(function (x) {
      var d = x.d, r = x.r;
      var color = pickColor[r.code];
      var split = ddUpDown(d.ret);

      /* 历史还不够 N 天时算的是「它有的那些天」，跟老基金的数字不可比，标出来 */
      var shortTag = d.enough ? '' :
        '<span class="dd-short" title="这只基金成立还不到 ' + dd.days + ' 天，按它已有的 ' +
        d.days + ' 天算">不足</span>';

      var trCls = [];
      if (!d.enough) trCls.push('dd-short-row');
      if (color) trCls.push('dd-on');

      return '<tr data-code="' + esc(r.code) + '"' +
        (trCls.length ? ' class="' + trCls.join(' ') + '"' : '') + '>' +
        '<td class="hd-grp-name">' + esc(r.cat) + '</td>' +
        '<td class="rt-name" title="' + esc(r.name) + '">' +
          (color ? '<i class="dd-swatch" style="background:' + color + '"></i>' : '') +
          esc(r.name) + shortTag + '</td>' +
        '<td class="hd-num">' + esc(r.code) +
          (r.own ? '<button class="remove-btn dd-remove" type="button" data-code="' +
            esc(r.code) + '" title="不再看这只">✕</button>' : '') +
        '</td>' +
        '<td class="hd-num dd-mdd' + (d.mdd > 0 ? '' : ' dd-zero') + '">' +
          (d.mdd > 0 ? '-' : '') + ddPct(d.mdd) + '</td>' +
        '<td class="hd-num dd-mru' + (d.mru > 0 ? '' : ' dd-zero') + '">' +
          (d.mru > 0 ? '+' : '') + ddPct(d.mru) + '</td>' +
        /* 涨跌拆两列，净额不再单占一列：净涨只填左边、净跌只填右边，另一边是条浅灰破折号。
         * 带符号的净涨跌挂在两格的 title 上，鼠标一悬停就有；单摆一列要 90px，
         * 而这 90px 得从「基金名称」里抠，名字就只剩七八个字了。 */
        '<td class="hd-num ' + (split.up == null ? 'dd-dash' : clsOf(split.up)) + '"' +
          (d.ret == null ? '' : ' title="窗口净涨跌 ' + esc(fmtRate(d.ret)) + '"') + '>' +
          (split.up == null ? '—' : fmtRate(split.up)) + '</td>' +
        '<td class="hd-num ' + (split.dn == null ? 'dd-dash' : 'down') + '"' +
          (d.ret == null ? '' : ' title="窗口净涨跌 ' + esc(fmtRate(d.ret)) + '"') + '>' +
          (split.dn == null ? '—' : '-' + ddPct(split.dn)) + '</td>' +
        '<td class="hd-num">' + (d.peakDate
          ? '<span title="' + esc(d.peakDate + ' 高点 → ' + d.troughDate + ' 低点') + '">' +
            ddDate(d.peakDate) + ' → ' + ddDate(d.troughDate) + '</span>'
          : '—') + '</td>' +
        '<td class="hd-num">' + (d.runLowDate
          ? '<span title="' + esc(d.runLowDate + ' 低点 → ' + d.runHighDate + ' 高点') + '">' +
            ddDate(d.runLowDate) + ' → ' + ddDate(d.runHighDate) + '</span>'
          : '—') + '</td>' +
        '<td class="hd-num' + (d.curDD > 0 ? ' down' : ' flat') + '">' +
          (d.curDD > 0 ? '-' : '') + ddPct(d.curDD) + '</td>' +
        /* 窗口起点单独摆出来：上面的「1月 / 3月」是日历月，这里的 N 天差的是起点这一天 */
        '<td class="hd-num" title="' + esc(d.from + ' 收盘 → ' + d.to + ' 收盘') + '">' +
          ddDate(d.from) + '</td>' +
        '</tr>';
    }).join('');

    var head = '<tr><th>类别</th><th>基金名称</th><th class="hd-num">代码</th>' +
      '<th class="hd-num">最大跌幅</th><th class="hd-num">最大涨幅</th>' +
      '<th class="hd-num">区间涨幅</th><th class="hd-num">区间跌幅</th>' +
      '<th class="hd-num">高 → 低</th><th class="hd-num">低 → 高</th>' +
      '<th class="hd-num">距峰值</th><th class="hd-num">窗口起点</th></tr>';

    el.innerHTML =
      '<div class="hd-section">最近 ' + dd.days + ' 天 · ' + rows.length + ' 只 · 跌最深 ' +
        esc(worst.r.name) + ' -' + ddPct(worst.d.mdd) +
        (best && best.d.mru > 0
          ? ' · 涨最猛 ' + esc(best.r.name) + ' +' + ddPct(best.d.mru) : '') +
        '</div>' +
      ddChart(rows) +
      '<div class="table-wrap"><table class="dd-table"><colgroup>' +
        '<col style="width:86px"><col><col style="width:78px">' +
        '<col style="width:80px"><col style="width:80px">' +
        '<col style="width:78px"><col style="width:78px">' +
        '<col style="width:116px"><col style="width:116px">' +
        '<col style="width:72px"><col style="width:70px"></colgroup>' +
        '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="hd-note">只看窗口内：<b>峰只取窗口里的点</b>，谷是峰之后的低点。' +
        '拿窗口之前的最高点来算，得出的其实是「从以前某个高点跌到今天跌了多少」，' +
        '窗口里明明在涨也会被标成深回撤。' +
        '「最大涨幅」是它的镜像：窗口里<b>先低后高</b>的那一段，低点在前、高点在后，' +
        '不是把跌幅取个反——净涨 2% 的窗口里可能先跌 15% 再涨 17%，那才是真实走过的路。' +
        '回撤和涨幅都按<b>复权净值</b>算（含分红再投）。' +
        '「区间涨幅 / 区间跌幅」是窗口首尾的涨跌幅按方向拆成两列——净涨只填左边、净跌只填右边，' +
        '另一边空着，扫一眼就知道方向；两列带符号相减就是净涨跌（鼠标停在那两格上也能看到）。' +
        '和上面「基金区间收益」的 1月 / 3月 / 6月 / 1年 差一点点是正常的：那几列按<b>日历月</b>回溯，' +
        '这里按<b>天数</b>回溯，起算点通常差一个交易日（每行最后一列就是这里的起算点）。' +
        ddAlignNote(rows) +
        '带「不足」的是成立还不到 ' + dd.days + ' 天的基金，窗口没铺满，别直接和老基金比。' +
        '净值截至 ' + esc((dd.data && dd.data.asOf) || '—') + '，QDII 普遍比 A 股晚一天。</p>' +
      ddFailedNote();

    el.dataset.state = 'ok';

    el.querySelectorAll('.dd-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        dd.custom = dd.custom.filter(function (c) { return c !== btn.dataset.code; });
        setDdCustom(dd.custom);
        delete dd.cache[btn.dataset.code];
        renderDD();
      });
    });

    /* 点一行 = 把这只加进/移出上面的曲线。✕ 是删自选，别让它连带切换 */
    el.querySelectorAll('.dd-table tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.dd-remove')) return;
        ddTogglePick(tr.dataset.code);
      });
    });
  }

  /* 现拉这几只的复权曲线。returns.json 里已经有的不拉——一次一只基金整包几百 KB */
  function ddFetchSeries(codes, el) {
    var byCode = (dd.data && dd.data.funds) || {};
    var todo = codes.filter(function (c) {
      if (dd.cache[c]) return false;
      var f = byCode[c];
      return !(f && f.series && f.series.length > 1);
    });
    if (!todo.length) return Promise.resolve();

    if (el) el.dataset.state = 'loading';
    return loadTrends(todo).then(function (res) {
      todo.forEach(function (code) { delete dd.failed[code]; });
      Object.keys(res.trends).forEach(function (code) {
        var t = res.trends[code];
        dd.cache[code] = { name: t.name, series: NavMath.equityCurve(t.trend, NavMath.SERIES_DAYS) };
      });
      res.failed.forEach(function (f) { dd.failed[f.code] = f.msg; });
    });
  }

  function ddLoad(el) {
    dd.custom = getDdCustom();
    dd.pick = getDdPick();
    return Promise.all([
      fetchMd(),
      fetch(RETURNS_URL, { cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
    ]).then(function (res) {
      dd.tbl = pickHoldingsTable(res[0]);
      /* 点过「同步净值」的话那份比仓库里的新，而且同样带复权曲线 */
      dd.data = holdings.derived || res[1];
      renderDD();
      return ddFetchSeries(dd.custom, el).then(renderDD);
    });
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

  var holdings = { md: '', tbl: null, snapshotDate: null, derived: null, limits: null, syncing: false };

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
        .catch(function () { return null; }),
      /* 申购限额同理：缺文件只是少一块「买不进」的警告 */
      fetch(LIMITS_URL, { cache: 'no-cache' })
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
      holdings.limits = results[2] || null;

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

  /* v2：v1 缓存里的 payload 没有复权曲线（series），留着会让「区间最大回撤」整块空掉。
   * v3：曲线点从 2 位小数改成 4 位（见 nav-math.js 的 round4），老缓存会让「7 天」和
   *     「1周」差出 0.01 个百分点。换个键等于让老缓存自然作废，比在里面加版本判断简单。 */
  var SYNC_KEY = 'finance-nav-sync-v3';
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

    /* 交易日历和净值一起拉。日历失败不算同步失败：退回只用各基金自己的净值日，
     * 少算的只是「今天净值还没公布」那一期，等净值出来下次同步自动补上，不会算错 */
    var calPromise = fetchTradingDays().catch(function () { return []; });

    Promise.all([
      loadTrends(entries.map(function (e) { return e.code; }), function (done, total) {
        setSyncStatus('同步中 ' + done + '/' + total, 'busy');
      }),
      calPromise
    ]).then(function (both) {
      var res = both[0], calendar = both[1];
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
      var payload = NavMath.buildPayload(ok, holdings.snapshotDate, calendar);
      payload.sync = { at: Date.now(), ms: Date.now() - t0, failed: res.failed };

      holdings.derived = payload;
      try {
        localStorage.setItem(SYNC_KEY, JSON.stringify({
          hash: hashStr(holdings.md), at: payload.sync.at, data: payload
        }));
      } catch (e) { /* 存不下就算了（比如隐私模式），本次照样能用 */ }

      paintHoldings();

      /* 同步结果里也带复权曲线（buildPayload 一起算的），回撤那块跟着换数据重画 */
      dd.data = payload;
      if (dd.tbl) renderDD();

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
    if (includeHoldings) {
      loadCard(document.getElementById('card-holdings'));
      loadCard(document.getElementById('card-dd'));
    }
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

  /* 区间最大回撤：换窗口 / 换范围只是重算，不用发请求（曲线早就在手里了） */
  (function () {
    loaders['card-dd'] = ddLoad;

    var win = document.getElementById('dd-window');
    if (win) {
      win.addEventListener('change', function () {
        dd.days = DD_WINDOWS.indexOf(+win.value) === -1 ? DD_DEFAULT_DAYS : +win.value;
        renderDD();
      });
    }
    var scope = document.getElementById('dd-scope');
    if (scope) {
      scope.addEventListener('change', function () {
        dd.scope = scope.value || 'all';
        renderDD();
      });
    }
    var form = document.getElementById('dd-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('dd-input');
        var code = input.value.trim();
        input.value = '';
        if (!/^\d{6}$/.test(code)) return;

        if (dd.custom.indexOf(code) === -1) {
          dd.custom.push(code);
          setDdCustom(dd.custom);
        }
        /* 卡片还没加载过（比如有人刷新时它失败了）就整张重来，别在半空里拼 */
        if (!dd.tbl) { loadCard(document.getElementById('card-dd')); return; }

        renderDD();   // 新代码还没数据就不出现，先把已有的画出来
        ddFetchSeries(dd.custom, document.querySelector('#card-dd .card-body'))
          .then(renderDD, renderDD);
      });
    }
  })();

  refreshAll(true);
  setInterval(function () { refreshAll(false); }, 60 * 1000);
})();
