/* 回测引擎：纯计算，不碰网络也不碰文件。
 *
 * 和 js/nav-math.js 一样用 UMD 包装，Node 里 require、浏览器里也能直接 <script> 加载，
 * 目的是算法只有一份、可以单独测。
 *
 * 防前视偏差是这里的硬约束：
 *   信号只能用到「第 i 天收盘为止」的数据，调仓在「第 i+1 天开盘」成交。
 *   引擎不检查这一点——它靠约定：targets[i] 必须只由 series[0..i] 算出。
 *
 * 净值口径：series[i].c 必须是**全收益**口径（复权价或全收益指数）。
 *   用价格指数回测会把分红当亏损丢掉——中证红利上这个差是数量级的。
 *   反过来说，用全收益回测，「空仓期间错过的股息」会自动体现在净值里，不用另加一项。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Backtest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TRADING_DAYS = 243;

  function yearsBetween(d0, d1) {
    return (Date.parse(d1) - Date.parse(d0)) / (365.25 * 24 * 3600 * 1000);
  }

  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }

  /* 净值曲线 → 指标。equity: [number]，dates: [string] */
  function metrics(equity, dates) {
    var n = equity.length;
    var last = equity[n - 1];
    var yrs = yearsBetween(dates[0], dates[n - 1]);
    var cagr = yrs > 0 ? Math.pow(last, 1 / yrs) - 1 : 0;

    var mdd = 0, peak = equity[0];
    for (var i = 0; i < n; i++) {
      if (equity[i] > peak) peak = equity[i];
      var dd = equity[i] / peak - 1;
      if (dd < mdd) mdd = dd;
    }

    var rets = [];
    for (var j = 1; j < n; j++) rets.push(equity[j] / equity[j - 1] - 1);
    var sd = std(rets);
    var sharpe = sd > 0 ? mean(rets) / sd * Math.sqrt(TRADING_DAYS) : 0;

    return {
      total: last - 1,
      cagr: cagr,
      mdd: mdd,
      sharpe: sharpe,
      calmar: mdd < 0 ? cagr / -mdd : null,
      vol: sd * Math.sqrt(TRADING_DAYS),
      days: n,
      years: yrs,
    };
  }

  /* 择时回测
   * series: [{d, o, c, ...}] 升序，c 为全收益收盘（o 可为空）
   * targets: [number] targets[i] ∈ [0,1]，第 i 天收盘后决定的目标仓位
   * cfg: { costPerSide, exec }
   *   exec = 'nextClose'（默认）信号在 T 日收盘出，T+1 日收盘成交
   *          数据只需要收盘价，永远可用，也最保守
   *        = 'nextOpen'  T 日收盘出信号，T+1 日开盘成交（需要开盘价）
   *        = 'sameClose' T 日收盘出信号，当日收盘就成交（0 延迟，偏乐观，只作对照）
   *
   * 注意：'nextClose' 下，第 i 天的收益用的是「第 i−1 天收盘时建立的仓位」，
   * 也就是第 i−2 天收盘发出的信号——比 'nextOpen' 多滞后一天，但不会用到当天收盘价去成交。 */
  function runTiming(series, targets, cfg) {
    cfg = cfg || {};
    var cost = cfg.costPerSide == null ? 0.0006 : cfg.costPerSide;
    var exec = cfg.exec || 'nextClose';
    var n = series.length;
    var equity = [1];
    var positions = [0];
    var pos = 0;                       // 当前仓位（0~1）
    var value = 1;
    var costPaid = 0;
    var changed = 0;
    var posDays = 0;
    var heldDiv = 0, missedDiv = 0;    // 归因用：持仓期吃到的分红 / 空仓期错过的分红

    function rebalance(target, atOpen) {
      if (target == null) target = pos;
      var turn = Math.abs(target - pos);
      if (turn > 1e-9) {
        var c = turn * cost;
        value *= 1 - c;
        costPaid += c;
        changed++;
      }
      pos = target;
    }

    for (var i = 1; i < n; i++) {
      var useOpen = exec === 'nextOpen' && series[i].o != null && series[i].o > 0;

      /* 归因用的分红按「当天实际承担仓位的时段」计，两种成交假设都按仓位是否过半算 */
      if (series[i].div != null) {
        if (pos > 0.5) heldDiv += series[i].div; else missedDiv += series[i].div;
      }

      if (useOpen) {
        /* 隔夜：昨天收盘的仓位承担 c_{i-1} → o_i */
        value *= 1 + pos * (series[i].o / series[i - 1].c - 1);
        rebalance(targets[i - 1], true);          // 开盘调仓
        value *= 1 + pos * (series[i].c / series[i].o - 1);   // 日内
      } else {
        /* 收盘成交：整天用旧仓位，收盘时才调仓 */
        value *= 1 + pos * (series[i].c / series[i - 1].c - 1);
        rebalance(exec === 'sameClose' ? targets[i] : targets[i - 1], false);
      }

      equity.push(value);
      positions.push(pos);
      if (pos > 0.5) posDays++;
    }

    var m = metrics(equity, series.map(function (x) { return x.d; }));
    m.costPaid = costPaid;
    m.trades = changed;
    m.exposure = n > 1 ? posDays / (n - 1) : 0;
    m.divHeld = heldDiv;
    m.divMissed = missedDiv;
    m.exec = useOpenCheck(series, exec) ? exec : 'nextClose';
    return { equity: equity, positions: positions, metrics: m };
  }

  /* 声称用开盘价，但序列里没有开盘价时，实际只能是 nextClose——如实报告 */
  function useOpenCheck(series, exec) {
    return exec === 'nextOpen' && series.some(function (x) { return x.o > 0; });
  }

  /* 把一条已跑完的净值曲线切到子区间重算指标（信号仍在全样本上算，只有评价区间变——
   * 这样样本外那一半不会被「起始仓位」和「指标预热」污染） */
  function slice(result, series, fromD, toD) {
    var eq = [], pos = [], sub = [], dates = [];
    for (var i = 0; i < series.length; i++) {
      if (series[i].d < fromD || series[i].d > toD) continue;
      eq.push(result.equity[i]);
      pos.push(result.positions[i]);
      sub.push(series[i]);
      dates.push(series[i].d);
    }
    if (eq.length < 2) return null;
    /* 归一化到区间起点 = 1，指标才反映这一段的收益 */
    var base = eq[0];
    var norm = eq.map(function (x) { return x / base; });
    var m = metrics(norm, dates);
    m.costPaid = result.metrics.costPaid;   // 成本只在全样本上统计，避免切分处虚高
    m.trades = countTrades(pos);
    m.exposure = mean(pos);
    var trips = roundTrips(norm, pos);
    m.roundTrips = trips.length;
    m.winRate = trips.length ? trips.filter(function (x) { return x > 0; }).length / trips.length : null;
    m.avgWin = mean(trips.filter(function (x) { return x > 0; }));
    m.avgLoss = mean(trips.filter(function (x) { return x < 0; }));
    m.profitFactor = m.avgLoss < 0 ? m.avgWin / -m.avgLoss : null;
    return m;
  }

  /* 仓位序列里的进出场次数 */
  function countTrades(positions) {
    var n = 0;
    for (var i = 1; i < positions.length; i++) if (positions[i] !== positions[i - 1]) n++;
    return n;
  }

  /* 一轮「空仓→持仓→空仓」的收益列表，用来算胜率和盈亏比 */
  function roundTrips(equity, positions) {
    var out = [], start = -1;
    for (var i = 1; i < positions.length; i++) {
      if (positions[i - 1] <= 0.5 && positions[i] > 0.5) start = i;
      else if (positions[i - 1] > 0.5 && positions[i] <= 0.5 && start >= 0) {
        out.push(equity[i] / equity[start] - 1);
        start = -1;
      }
    }
    if (start >= 0) out.push(equity[positions.length - 1] / equity[start] - 1);   // 还没平仓的算浮动
    return out;
  }

  /* 定投回测
   * mult: [number] mult[i] 是第 i 天投入的倍数（0 = 这期不投，1 = 正常，2 = 加倍）
   * cfg: { everyDays, amount, costPerSide, annualFee } */
  function runDca(series, mult, cfg) {
    cfg = cfg || {};
    var every = cfg.everyDays || 21;        // 约每月
    var amount = cfg.amount == null ? 1 : cfg.amount;
    var cost = cfg.costPerSide == null ? 0.001 : cfg.costPerSide;   // 场外申购费 0.1%
    var annualFee = cfg.annualFee == null ? 0.002 : cfg.annualFee;  // C 类销售服务费 0.2%/年

    var shares = 0, invested = 0, value = 0, costPaid = 0;
    var flows = [];                          // [{t, amt}] 用于 IRR
    var lastBuy = -Infinity;
    var equity = [];

    for (var i = 0; i < series.length; i++) {
      /* 销售服务费按日计提（年化 → 日） */
      shares *= 1 - annualFee / TRADING_DAYS;
      value = shares * series[i].c;

      var buy = false;
      if (series[i].buyDay && (i - lastBuy >= every)) buy = true;
      if (buy) {
        var amt = amount * (mult[i] == null ? 1 : mult[i]);
        if (amt > 0) {
          var fee = amt * cost;
          costPaid += fee;
          shares += (amt - fee) / series[i].c;
          invested += amt;
          flows.push({ d: series[i].d, amt: amt });
          lastBuy = i;
        }
      }
      value = shares * series[i].c;
      equity.push(value);
    }

    /* 资金加权收益率（IRR，年化）：解 sum(amt_j × (1+r)^((T−t_j)/年)) = 终值 */
    var T = series[series.length - 1].d;
    var f = function (r) {
      var s = 0;
      for (var k = 0; k < flows.length; k++) {
        var y = yearsBetween(flows[k].d, T);
        s += flows[k].amt * Math.pow(1 + r, y);
      }
      return s - value;
    };
    var lo = -0.99, hi = 2, irr = null;
    if (flows.length && value > 0) {
      var flo = f(lo), fhi = f(hi);
      if (flo * fhi < 0) {
        for (var it = 0; it < 200; it++) {
          var mid = (lo + hi) / 2;
          if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
        }
        irr = (lo + hi) / 2;
      }
    }

    return {
      equity: equity,
      invested: invested,
      finalValue: value,
      irr: irr,
      costPaid: costPaid,
      contributions: flows.length,
    };
  }

  /* 买入持有：在全收益序列上满仓不动 */
  function buyHold(series, cfg) {
    return runTiming(series, series.map(function () { return 1; }), cfg);
  }

  return {
    TRADING_DAYS: TRADING_DAYS,
    yearsBetween: yearsBetween,
    mean: mean,
    std: std,
    metrics: metrics,
    runTiming: runTiming,
    runDca: runDca,
    buyHold: buyHold,
    slice: slice,
    countTrades: countTrades,
    roundTrips: roundTrips,
  };
});
