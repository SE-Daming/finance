/* 基金净值相关的纯计算：区间收益 + 推算持仓。
 *
 * 浏览器（js/app.js 的「同步净值」按钮）和 Node（tools/update-returns.mjs）共用这一份。
 * 同一套金额算法写成两份，迟早会算出不一样的数——那不是靠小心就能避免的事，所以这里
 * 用一层「两边都能吃」的包装共用同一份代码：页面直接 <script> 加载，Node 用 require 读，
 * 不引入任何构建步骤。
 *
 * 净值数据来自天天基金 https://fund.eastmoney.com/pingzhongdata/{6位代码}.js
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 区间窗口：键名 → 天数/月数（月按日历月算） */
  var WINDOWS = [
    ['r1w', { days: 7 }],
    ['r1m', { months: 1 }],
    ['r3m', { months: 3 }],
    ['r6m', { months: 6 }],
    ['r1y', { months: 12 }]
  ];

  var NOTE = '区间收益按官方日涨跌幅逐日复利，已含分红再投。';

  var PROJ_NOTE = '推算按 A 股交易日推进：当天净值还没公布的，用最近的已知净值当买入价估算，' +
    '净值出来后自动纠正。';

  /* 复权曲线一次存多少天的点。看板最多让人看 360 天，留点余量：
   * 窗口起点那天本身也得有净值，不然「最近 360 天」实际就只剩 359 天。 */
  var SERIES_DAYS = 370;

  var round2 = function (v) { return Math.round(v * 100) / 100; };

  /* 曲线点存 4 位小数，不是为了好看：只存 2 位的话，曲线值到 190 多时单点是 ±0.005 的
   * 误差，两点一比就是 0.005% 的偏差——「最近 7 天」的涨跌会和「基金区间收益」的 1周
   * 差出 0.01 个百分点，看起来像算错了。4 位刚好压到显示精度以下。 */
  var round4 = function (v) { return Math.round(v * 10000) / 10000; };

  /* 时间戳是北京时间当天零点，直接用 toISOString 会倒回前一天，所以先补 8 小时 */
  function toDate(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /* pingzhongdata 的 Data_netWorthTrend → [{date, eq, nav}]，按日期升序
   * eq 是官方日涨跌幅（%），nav 是单位净值；两个都缺的行直接丢掉 */
  function normalizeTrend(raw) {
    if (!raw || typeof raw.length !== 'number') throw new Error('没有净值走势数据');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i];
      if (!d || typeof d.x !== 'number' || typeof d.equityReturn !== 'number') continue;
      if (!(d.y > 0)) continue;
      out.push({ date: toDate(d.x), eq: d.equityReturn, nav: d.y });
    }
    if (out.length < 2) throw new Error('净值走势不足两天');
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }

  /* 一行的四个数 → 市值 / 收益 / 成本 / 收益率。看板和 Node 都走这里，规则只有一份：
   *   市值优先取「持有金额」；只填了「投入本金」+「持有收益」时反推市值 = 本金 + 收益
   *   只填了「持仓收益率」没填「持有收益」时，由市值反推收益：
   *     收益 = 市值 × r ÷ (1 + r)，也就是先取 成本 = 市值 ÷ (1 + r)
   * 成本 = 市值 − 收益；没有收益可推时退回「投入本金」 */
  function snapshotOf(amount, profit, capital, rateIn) {
    var derivedProfit = false;

    if (profit == null && amount != null) {
      var pct = rateIn == null ? null : rateIn / 100;
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

  /* 从 fromIdx 复利到 toIdx：区间收益 = Π(1 + eq/100) − 1
   * 不拿首尾净值相除——除息日净值会跳水，那样算出来是假暴跌，而 eq 已含分红再投 */
  function compound(trend, fromIdx, toIdx) {
    var acc = 1;
    for (var i = fromIdx; i <= toIdx; i++) acc *= 1 + trend[i].eq / 100;
    return (acc - 1) * 100;
  }

  /* 找最后一个日期 ≤ target 的下标；找不到（基金比窗口还年轻）返回 -1 */
  function lastIndexUpTo(trend, target) {
    var lo = 0, hi = trend.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (trend[mid].date <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function shiftMonths(dateStr, months) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1 - months, p[2])).toISOString().slice(0, 10);
  }

  function shiftDays(dateStr, days) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] - days)).toISOString().slice(0, 10);
  }

  /* ---------- 区间最大回撤 ----------
   *
   * 复权净值曲线：把官方日涨跌幅逐日复利成一条曲线，只留最后 keepDays 个自然日的点。
   *
   * 为什么不直接画 nav（单位净值）：分红除息那天单位净值会跳水，曲线上凭空多出一段回撤。
   * eq 已经含分红再投，和「区间收益」是同一套口径，回撤也得跟它一致，否则同一只基金
   * 上面写着涨、下面标着巨幅回撤，自己跟自己打架。
   * 曲线绝对值没有意义（起点是这只基金的第一天），只有比值有意义，所以起点固定 100。
   */
  function equityCurve(trend, keepDays) {
    if (!trend || !trend.length) return [];
    var from = keepDays > 0 ? shiftDays(trend[trend.length - 1].date, keepDays) : trend[0].date;
    var idx = 100, out = [];
    for (var i = 0; i < trend.length; i++) {
      var t = trend[i];
      idx = idx * (1 + (t.eq || 0) / 100);
      if (t.date >= from) out.push([t.date, round4(idx)]);
    }
    return out;
  }

  /* 区间最大回撤 / 最大涨幅：只看最近 nDays 个自然日，窗口内逐点算
   *   dd = (窗口内此前最高 − 当日) ÷ 窗口内此前最高，取最大
   *   ru = (当日 − 窗口内此前最低) ÷ 窗口内此前最低，取最大
   *
   * 峰值只认**窗口内**的点。拿窗口之前的最高点来算，得出的其实是「从以前某个高点跌到今天
   * 跌了多少」，不是这 N 天里的回撤——窗口里明明在涨，也会被标成深回撤。涨幅同理。
   *
   * 涨幅是回撤的镜像，但不是把回撤取反：一边先高后低，一边先低后高，找的是两段不同的行情。
   * 只用「首尾涨跌」也代替不了它们——净涨 2% 的窗口里可能先跌 15% 再涨 17%，那 15% 和 17%
   * 才是持有人真正扛过的和错过的。
   *
   * 返回（全部是比率，不是百分数）：
   *   mdd        窗口内最大回撤
   *   peakDate/troughDate  那一段的高点和低点。mdd=0（只涨没跌）时都是 null
   *   mru        窗口内最大涨幅（先低后高）。mru=0（只跌没涨）时是 0
   *   runLowDate/runHighDate  那一段的低点和高点
   *   ret        窗口首尾涨跌幅。和 mdd/mru 都是两回事：跌完又涨回来，ret 可能是 0 而 mdd 很深
   *   curDD      当前值距窗口内最高点还有多少
   *   from/to    窗口实际的首尾日期；days 是它覆盖的自然日数
   *   enough     false 表示这只基金历史还不够 nDays 天（新基金），算的是它有的那些天 */
  function drawdown(series, nDays) {
    if (!series || series.length < 2) return null;

    var endDate = series[series.length - 1][0];
    var want = shiftDays(endDate, nDays);          // shiftDays 是往前推，参数正数
    var win = [];
    for (var i = 0; i < series.length; i++) {
      if (series[i][0] >= want) win.push(series[i]);
    }
    if (win.length < 2) return null;

    var peak = win[0][1], peakDate = win[0][0];
    var mdd = 0, mPeak = null, mTrough = null;
    var low = win[0][1], lowDate = win[0][0];
    var mru = 0, mLow = null, mHigh = null;
    for (var j = 1; j < win.length; j++) {
      var d = win[j][0], v = win[j][1];

      /* 涨幅先算、再更新低点：这样「低点」一定早于「高点」，不会拿同一天跟自己比出 0% */
      if (low > 0) {
        var ru = v / low - 1;
        if (ru > mru) { mru = ru; mLow = lowDate; mHigh = d; }
      }
      if (v < low) { low = v; lowDate = d; }

      if (v > peak) { peak = v; peakDate = d; }
      if (peak > 0) {
        var dd = (peak - v) / peak;
        if (dd > mdd) { mdd = dd; mPeak = peakDate; mTrough = d; }
      }
    }

    var first = win[0][1], last = win[win.length - 1][1];
    return {
      mdd: mdd,
      peakDate: mPeak,
      troughDate: mTrough,
      mru: mru,
      runLowDate: mLow,
      runHighDate: mHigh,
      ret: first > 0 ? last / first - 1 : null,
      curDD: peak > 0 ? (peak - last) / peak : 0,
      from: win[0][0],
      to: endDate,
      days: Math.round((Date.parse(endDate) - Date.parse(win[0][0])) / 86400000) + 1,
      enough: series[0][0] <= want
    };
  }

  /* 各区间收益。最新净值日不一定是今天（QDII 晚一天、节假日顺延），所以一起返回 */
  function computeReturns(trend) {
    var n = trend.length;
    if (n < 2) throw new Error('净值走势不足两天');

    var lastIdx = n - 1;
    var navDate = trend[lastIdx].date;
    var out = { navDate: navDate, r1d: round2(trend[lastIdx].eq), start: {} };

    for (var i = 0; i < WINDOWS.length; i++) {
      var win = WINDOWS[i][1];
      var target = win.days ? shiftDays(navDate, win.days) : shiftMonths(navDate, win.months);
      var idx = lastIndexUpTo(trend, target);
      out[WINDOWS[i][0]] = idx >= 0 ? round2(compound(trend, idx + 1, lastIdx)) : null;
      /* 该区间真正复利的起点。长假之后 7 天窗口里可能只公布了一期净值，于是「1周」
       * 和「1日」数字相同——那不是算错，把起点摆出来页面上就不用猜了 */
      out.start[WINDOWS[i][0]] = idx >= 0 && idx + 1 <= lastIdx ? trend[idx + 1].date : null;
    }
    return out;
  }

  /* ---------- 推算持仓 ----------
   *
   * 拿快照当锚，用净值把持仓滚到最新交易日：
   *
   *   锚点净值 nav0 = 快照日期当天（或之前最近一天）的净值
   *   份额 shares = 快照市值 ÷ nav0          ← 快照那天的份额
   *   快照日期之后每过一个交易日，就按每日定投买进 金额 ÷ 当日净值 份，成本同步累加
   *   推算市值 = 最终份额 × 最新净值
   *
   * 「快照日期之后」而不是「锚点净值日之后」：快照里的份额和成本已经是截至快照日期的数，
   * QDII 净值晚一天时两者会差一个交易日，拿锚点净值日当界会把那一期定投重复算一遍。
   *
   * 为什么不能只拿「快照市值 × 区间涨幅」：那等于假设新投的钱在期初就到位了。
   * 定投是一天天买进去的，越晚买的钱吃到的涨幅越少——尤其回调行情里差别明显。
   *
   * 误差来源：实际扣款未必每个交易日都成功（QDII 有额度限制、美股节假日与 A 股不同步），
   * 所以推算值会慢慢偏离真实持仓。从基金 App 复制一份新快照覆盖 holdings.md 的表格、
   * 把「快照日期」改成复制的那天，就能重新锚定。
   */
  /* days 是交易日历（升序，来自 buildPayload 的并集），不是净值日。
   * 钱按交易日扣，净值却往往晚一天才公布（QDII 要等美股收盘），按净值日推进的话，
   * 今天投进去的钱得等明天净值出来才认，数字一整天不动。所以当天没净值就沿用最近的
   * 已知净值当买入价——等真净值出来，份额会从锚点整个重算，估算自动被纠正，不会越错越远。 */
  function project(trend, snap, days) {
    if (snap.amount == null || snap.cost == null) return null;
    if (!snap.snapshotDate) return null;

    var anchorIdx = lastIndexUpTo(trend, snap.snapshotDate);
    if (anchorIdx < 0) return null;                 // 基金比快照日期还年轻
    var nav0 = trend[anchorIdx].nav;
    if (!(nav0 > 0)) return null;

    var shares = snap.amount / nav0;
    var cost = snap.cost;
    var cumulative = snap.cumulative == null ? null : snap.cumulative;
    var daily = snap.daily > 0 ? snap.daily : 0;
    var anchorDate = trend[anchorIdx].date;

    /* 定投从「快照日期」之后开始补，不是从锚点净值日之后。
     *
     * 快照里的份额和成本已经是截至快照日期的数，所以只该补它之后的期数。拿锚点净值日当界
     * 会多算一期：QDII 净值普遍晚一天，快照日期是周五时锚点净值日还停在周四，那个周五
     * 就落在两者之间——钱确实扣了（App 的总成本里有），可推算又会补一次。
     *
     * 这里刻意不用 anchorDate：它只负责把快照市值换算成份额（latestNav 是几号，市值就是按
     * 几号的净值算的），而定投该补到哪天，取决于用户是从哪天抄的数字。 */
    var cutoff = snap.snapshotDate;

    if (daily && days && days.length) {
      var navIdx = anchorIdx;
      for (var i = 0; i < days.length; i++) {
        var d = days[i];
        if (d <= cutoff) continue;
        /* 买入价 = 不晚于 d 的最新净值；d 当天还没公布的，就沿用前一天的 */
        while (navIdx + 1 < trend.length && trend[navIdx + 1].date <= d) navIdx++;
        shares += daily / trend[navIdx].nav;
        cost += daily;
        if (cumulative != null) cumulative += daily;
      }
    }

    var lastIdx = trend.length - 1;
    var amount = shares * trend[lastIdx].nav;
    var profit = amount - cost;

    return {
      amount: round2(amount),
      cost: round2(cost),
      profit: round2(profit),
      /* rate 不在这里取整：取整后再乘 100 会和「没推算时」的显示差 0.01% */
      rate: cost ? profit / cost : null,
      cumulative: cumulative == null ? null : round2(cumulative),
      navDate: trend[lastIdx].date,
      anchorDate: anchorDate
    };
  }

  /* entries: [{code, name, trend, amount, cost, daily, cumulative}]
   * amount/cost/daily/cumulative 是快照那一行的数（来自 snapshotOf）；snapshotDate 为空
   * 或没有 amount/cost 时，这只基金只算区间收益。
   * calendar 是 A 股交易日（上证指数日K的日期）；拿不到就传空数组，退回用各基金的净值日。
   * 看板读的 data/returns.json 和「同步净值」按钮算出来的都是这个结构，前端一视同仁 */
  function buildPayload(entries, snapshotDate, calendar) {
    /* 交易日历 = 外部给的 + 各基金的净值日，取并集再去重排序。
     * 并集是有意的：外部日历负责补上「今天是交易日、但净值还没公布」这一天（其余来源都补不了），
     * 各基金的净值日负责兜住更早的整段区间。这样任何一方缺了都不至于把定投算漏，
     * 而重复的日期也不会让某一天被数两次——用户要的就是「一天一次，不多不少」。 */
    var dayMap = {};
    (calendar || []).forEach(function (d) { if (d) dayMap[d] = 1; });
    entries.forEach(function (e) {
      e.trend.forEach(function (t) { dayMap[t.date] = 1; });
    });
    var days = Object.keys(dayMap).sort();

    var funds = {};
    var navDates = [], projCount = 0;

    entries.forEach(function (e) {
      var r = computeReturns(e.trend);
      var p = snapshotDate
        ? project(e.trend, {
            amount: e.amount, cost: e.cost, daily: e.daily,
            cumulative: e.cumulative, snapshotDate: snapshotDate
          }, days)
        : null;

      funds[e.code] = {
        name: e.name || '',
        navDate: r.navDate,
        r1d: r.r1d, r1w: r.r1w, r1m: r.r1m,
        r3m: r.r3m, r6m: r.r6m, r1y: r.r1y,
        start: r.start,               // 各区间实际起点日期，见 computeReturns
        series: equityCurve(e.trend, SERIES_DAYS),   // 复权曲线，见 equityCurve
        projected: p || null          // 没有就是 null，别省掉这个键：前端按形状取值
      };
      if (r.navDate) navDates.push(r.navDate);
      if (p) projCount++;
    });

    var payload = {
      asOf: navDates.sort().pop() || null,
      note: '由 js/nav-math.js 计算。' + NOTE,
      funds: funds
    };
    if (snapshotDate && projCount) {
      payload.projection = {
        snapshotDate: snapshotDate,
        /* 推算推进到哪一天 = 日历的最后一天。注意它和上面 asOf（最新净值日）不是一回事了：
         * asOf 是「净值公布到哪天」，这里是「定投算到哪天」，前者通常会晚一步 */
        asOf: days.length ? days[days.length - 1] : null,
        funds: projCount
      };
    }
    return payload;
  }

  return {
    WINDOWS: WINDOWS,
    NOTE: NOTE,
    PROJ_NOTE: PROJ_NOTE,
    SERIES_DAYS: SERIES_DAYS,
    toDate: toDate,
    round2: round2,
    normalizeTrend: normalizeTrend,
    snapshotOf: snapshotOf,
    compound: compound,
    lastIndexUpTo: lastIndexUpTo,
    shiftMonths: shiftMonths,
    shiftDays: shiftDays,
    equityCurve: equityCurve,
    drawdown: drawdown,
    computeReturns: computeReturns,
    project: project,
    buildPayload: buildPayload
  };
});
