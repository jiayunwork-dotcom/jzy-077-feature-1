'use strict';

/**
 * 反算专用的正向核算适配器。
 *
 * 这是反算路径访问正向物理模型的【唯一入口】：给定候选固结系数 cv 与
 * 一组观测时刻，逐个调用现有 consolidationService.computeConsolidation
 * （即 POST /api/v1/consolidation 背后的同一套正向核算），取出每个时刻
 * 的时间因子、平均固结度与沉降，以及与 cv 无关的最终沉降 S∞。
 *
 * 反算逻辑严禁在这里之外另写 Tv / U_avg / S(t) 的平行实现——
 * 同一个 cv 喂给反算与喂给正向接口，结果必须逐位同源。
 */

const { computeConsolidation } = require('./consolidationService');

/** u0 不影响平均固结度与沉降，反算不涉及孔压剖面，给一个合法占位值即可。 */
const U0_PLACEHOLDER = 1;

/** 正向核算需要一个深度网格；反算只取平均量，单点网格即可，不影响沉降结果。 */
const EVALUATION_DEPTHS = [0];

/**
 * 为一次反算绑定正向核算器。
 * @param {object} fixed 与 cv 无关的参数 { H, drainage, mv, deltaSigma, maxTerms }
 * @returns {{ evaluate: (function(number, Array<{t:number}>): Array<object>),
 *            callCount: number, finalSettlement: number }}
 *   evaluate(cv, observations) 返回每个观测时刻的正向核算摘录
 *   （finalSettlement / timeFactor / averageConsolidation / settlement）；
 *   callCount 如实记录累计发起的正向核算次数（含构造时的 S∞ 探测）。
 */
function createForwardEvaluator(fixed) {
  const { H, drainage, mv, deltaSigma, maxTerms } = fixed;
  let callCount = 0;

  function evaluateOne(cv, t) {
    callCount += 1;
    const result = computeConsolidation({
      cv,
      H,
      drainage,
      u0: U0_PLACEHOLDER,
      mv,
      deltaSigma,
      t,
      depths: EVALUATION_DEPTHS,
      gridPoints: 2,
      maxTerms,
    });
    return {
      t,
      finalSettlement: result.finalSettlement,
      timeFactor: result.timeFactor,
      averageConsolidation: result.averageConsolidation,
      settlement: result.settlement,
    };
  }

  function evaluate(cv, observations) {
    return observations.map((obs) => evaluateOne(cv, obs.t));
  }

  // S∞ 与 cv、t 无关：走一次真实正向核算把它取回来，
  // 反算侧不自行书写 mv·Δσ·H 这份式子。
  const probe = evaluateOne(1, 1);

  return {
    evaluate,
    get callCount() {
      return callCount;
    },
    finalSettlement: probe.finalSettlement,
  };
}

module.exports = { createForwardEvaluator, U0_PLACEHOLDER, EVALUATION_DEPTHS };
