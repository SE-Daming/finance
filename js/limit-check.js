/* 「这个定投计划买得进吗」的判定，tools/update-limits.mjs（控制台）和 js/app.js（页面）共用。
 *
 * 分开写两份的理由和 nav-math.js 一样：同一个判定写两遍，控制台和页面迟早给出不同结论。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LimitCheck = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 接口用 100000000000 表示「不限购」 */
  var UNLIMITED = 1e9;

  /* plan: 每日定投金额（0 表示这只没定投）；limit: {sgzt, max} 或 null（没取到）
   * 返回 { key, txt }：key 给 CSS 用（bad / warn / ok / flat），txt 是给人看的话 */
  function verdict(plan, limit) {
    if (!limit) return { key: 'flat', txt: '未取到' };
    /* buy 是最可靠的信号，先看它：有些基金把申购状态写成「限大额」、限额写成 "--"，
     * 可 BUY 已经是 false 了——光看申购状态根本看不出来买不进 */
    if (limit.buy === false) return { key: 'bad', txt: '买不进' };
    if (limit.sgzt === '暂停申购') return { key: 'bad', txt: '买不进' };
    if (limit.max == null) {
      /* 到这儿 buy 是 true。真是开放申购就写不限购；「限大额」却没给数字的别替它下结论 */
      return limit.sgzt === '开放申购'
        ? { key: 'ok', txt: '不限购' }
        : { key: 'flat', txt: '上限不明' };
    }
    if (plan > 0 && plan > limit.max) return { key: 'bad', txt: '超出上限，当期作废' };
    if (plan > 0 && plan >= limit.max) return { key: 'warn', txt: '顶格' };
    return { key: 'ok', txt: '正常' };
  }

  var NOTE = '顶格＝计划金额正好顶到基金单日上限，一点余量都没有——上限再降一点，当期就作废。' +
    '买不进＝基金暂停申购，定投会静默失败：App 里计划状态照样显示「正常」，钱一分没买。';

  return { UNLIMITED: UNLIMITED, verdict: verdict, NOTE: NOTE };
});
