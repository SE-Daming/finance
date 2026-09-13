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

  /* ---------- 刷新 ---------- */

  function refreshAll() {
    ['card-index', 'card-fx', 'card-watch'].forEach(function (id) {
      loadCard(document.getElementById(id));
    });
    document.getElementById('update-time').textContent =
      '数据更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  document.getElementById('refresh-btn').addEventListener('click', refreshAll);

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

  refreshAll();
  setInterval(refreshAll, 60 * 1000);
})();
