'use strict';

/**
 * 平均固结度与沉降计算。
 *
 * 平均固结度（按孔压定义，初始孔压均匀时应变定义与之等价）：
 *   U_avg(Tv) = 1 − Σ_{m=0}^{∞} (2/M²) · exp(−M² · Tv)，M = (2m+1)π/2
 *
 * 与深度剖面共用同一个 Tv（来自 timeFactor.js），本模块不自行换算。
 *
 * 沉降：
 *   最终沉降 S∞ = mv · Δσ · H   （mv 体积压缩系数，Δσ 附加应力，H 层厚）
 *   t 时刻沉降 S(t) = U_avg(Tv) · S∞
 *   沉降比例 S(t)/S∞ = U_avg(Tv)
 */

const HALF_PI = Math.PI / 2;
const ENVELOPE_TOLERANCE = 1e-15;
const DEFAULT_MAX_TERMS = 100000;

/**
 * 平均固结度 U_avg(Tv)。
 * @param {number} tv 时间因子（来自 timeFactor.timeFactor）
 * @returns {number} 夹在 [0, 1]
 */
function averageConsolidation(tv, maxTerms = DEFAULT_MAX_TERMS) {
  if (tv <= 0) return 0; // Tv = 0：固结尚未开始，精确为零
  let sum = 0;
  for (let m = 0; m < maxTerms; m += 1) {
    const M = (2 * m + 1) * HALF_PI;
    const envelope = (2 / (M * M)) * Math.exp(-M * M * tv);
    sum += envelope;
    if (envelope < ENVELOPE_TOLERANCE) break;
  }
  return Math.min(1, Math.max(0, 1 - sum));
}

/** 最终沉降量 S∞ = mv · Δσ · H。 */
function finalSettlement(mv, deltaSigma, H) {
  return mv * deltaSigma * H;
}

/** t 时刻沉降 S(t) = U_avg · S∞。 */
function settlementAt(uAvg, sFinal) {
  return uAvg * sFinal;
}

module.exports = {
  averageConsolidation,
  finalSettlement,
  settlementAt,
};
