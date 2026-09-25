'use strict';

/**
 * 反算编排：在现有正向核算（forwardEvaluator → consolidationService）
 * 外面套一层手写一维搜索（cvSearch），找出与现场累计沉降观测整体最贴近的
 * 固结系数，并给出回代核对与拟合质量指标。
 *
 * 本模块不实现任何固结物理公式；每评估一个候选 cv，全部通过
 * forwardEvaluator 调用现有 computeConsolidation。
 *
 * 物理可行性（在搜索前拦截，结构化拒绝，绝不贴上界硬凑）：
 *   - 任一观测沉降达到/超过最终沉降 S∞（U_avg 封顶 1）：可行区间之外；
 *   - S∞ = 0（mv 或 Δσ 为零）却存在正的观测沉降：同样无可行解；
 *   - 全部观测沉降都为零：任意 cv 都能零残差拟合，反算不可辨识。
 */

const { createForwardEvaluator } = require('./forwardEvaluator');
const { invertCv } = require('./cvSearch');

/** 距上界 S∞ 的相对容差：落在该带内视为"贴上界"，同样拒绝（需要 cv→∞）。 */
const CEILING_RELATIVE_TOLERANCE = 1e-9;

/** 回代残差可报告区间：|残差| / S∞ 不超过该值，即认为回代与观测吻合。 */
const BACKCHECK_RELATIVE_LIMIT = 1e-7;

/** 结构化拒绝原因（与 HTTP 状态码的映射在路由层）。 */
const REJECTION = Object.freeze({
  TARGET_EXCEEDS_FINAL: 'TARGET_EXCEEDS_FINAL_SETTLEMENT',
  ZERO_FINAL_WITH_POSITIVE: 'ZERO_FINAL_SETTLEMENT_WITH_POSITIVE_OBSERVATIONS',
  UNIDENTIFIABLE_ALL_ZERO: 'UNIDENTIFIABLE_ALL_ZERO_OBSERVATIONS',
});

/**
 * 执行一次固结系数反算。
 * @param {object} p validateInverseInput 归一化后的参数
 * @returns {{ ok:true, result:object } | { ok:false, rejection:object }}
 */
function invertConsolidationCoefficient(p) {
  const { H, drainage, mv, deltaSigma, observations, maxTerms } = p;

  const forward = createForwardEvaluator({ H, drainage, mv, deltaSigma, maxTerms });
  const sFinal = forward.finalSettlement;

  // —— 物理可行性检查（搜索前拦截） ——
  if (sFinal === 0) {
    const positive = observations
      .map((obs, index) => ({ obs, index }))
      .filter(({ obs }) => obs.settlement > 0);
    if (positive.length > 0) {
      return reject(
        REJECTION.ZERO_FINAL_WITH_POSITIVE,
        `mv·Δσ·H = 0，该参数组合下最终沉降为零，正向模型任何时刻沉降都为零，` +
          `但 ${positive.length} 个观测点记录了正的累计沉降，观测落在可行区间之外。`,
        positive.map(({ obs, index }) => ({
          index,
          t: obs.t,
          settlement: obs.settlement,
          finalSettlement: 0,
        })),
        sFinal,
      );
    }
    return reject(
      REJECTION.UNIDENTIFIABLE_ALL_ZERO,
      '最终沉降为零且全部观测沉降均为零：任意固结系数都给出零沉降，反算无唯一解。',
      [],
      sFinal,
    );
  }

  const atOrAboveCeiling = observations
    .map((obs, index) => ({ obs, index }))
    .filter(({ obs }) => obs.settlement >= sFinal * (1 - CEILING_RELATIVE_TOLERANCE));
  if (atOrAboveCeiling.length > 0) {
    return reject(
      REJECTION.TARGET_EXCEEDS_FINAL,
      `平均固结度封顶为 1，沉降不可能达到/超过最终沉降 S∞ = ${sFinal}；` +
        `${atOrAboveCeiling.length} 个观测点达到或超过该物理上界，需要固结系数趋于无穷，` +
        '该观测组合落在给定参数的可行区间之外，请核对 mv、Δσ、H 或观测沉降。',
      atOrAboveCeiling.map(({ obs, index }) => ({
        index,
        t: obs.t,
        settlement: obs.settlement,
        finalSettlement: sFinal,
        requiredConsolidationDegree: obs.settlement / sFinal,
      })),
      sFinal,
    );
  }

  if (observations.every((obs) => obs.settlement === 0)) {
    return reject(
      REJECTION.UNIDENTIFIABLE_ALL_ZERO,
      '全部观测点的累计沉降均为零：任意固结系数在零沉降目标下都等价，无法唯一反算，' +
        '请补充固结已明显推进时段的观测点。',
      [],
      sFinal,
    );
  }

  // —— 搜索：每个候选 cv 都经 forwardEvaluator 走现有正向核算 ——
  const inverted = invertCv(forward, { H, drainage }, observations);

  // —— 回代核对：拿反算出的 cv 独立再走一遍正向，在观测时刻重算沉降 ——
  const backcheck = forward.evaluate(inverted.cv, observations);
  const residuals = observations.map((obs, i) => ({
    index: i,
    t: obs.t,
    observedSettlement: obs.settlement,
    predictedSettlement: backcheck[i].settlement,
    residual: obs.settlement - backcheck[i].settlement,
    timeFactor: backcheck[i].timeFactor,
    averageConsolidation: backcheck[i].averageConsolidation,
  }));

  const fit = buildFitMetrics(observations, residuals, sFinal);
  const withinReportableRange =
    fit.nrmse <= BACKCHECK_RELATIVE_LIMIT && fit.maxAbsResidual <= sFinal * BACKCHECK_RELATIVE_LIMIT;

  return {
    ok: true,
    result: {
      feasible: true,
      converged: inverted.search.goldenConverged,
      cv: inverted.cv,
      log10Cv: inverted.bestX,
      finalSettlement: sFinal,
      fit: { ...fit, withinReportableRange, backcheckRelativeLimit: BACKCHECK_RELATIVE_LIMIT },
      residuals,
      search: inverted.search,
      forwardEvaluations: forward.callCount,
      parameters: { H, drainage, mv, deltaSigma, observationCount: observations.length, maxTerms },
    },
  };
}

/**
 * 拟合质量指标：
 *   rmse               —— 残差均方根（沉降量纲）；
 *   maxAbsResidual     —— 最大绝对残差；
 *   meanAbsResidual    —— 平均绝对残差；
 *   nrmse              —— RMSE / S∞（相对最终沉降的规模指标，S∞>0 恒有定义）；
 *   rSquared           —— 决定系数（观测无方差时为 null，不硬造）。
 */
function buildFitMetrics(observations, residuals, sFinal) {
  const n = observations.length;
  const observed = observations.map((o) => o.settlement);
  const meanObserved = observed.reduce((a, b) => a + b, 0) / n;

  let sse = 0;
  let absSum = 0;
  let maxAbs = 0;
  let sst = 0;
  for (let i = 0; i < n; i += 1) {
    const r = residuals[i].residual;
    sse += r * r;
    absSum += Math.abs(r);
    if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
    const d = observed[i] - meanObserved;
    sst += d * d;
  }

  const rmse = Math.sqrt(sse / n);
  return {
    observationCount: n,
    rmse,
    maxAbsResidual: maxAbs,
    meanAbsResidual: absSum / n,
    nrmse: rmse / sFinal,
    rSquared: sst > 0 ? 1 - sse / sst : null,
    meanObservedSettlement: meanObserved,
  };
}

function reject(code, message, details, sFinal) {
  return {
    ok: false,
    rejection: { code, message, details, finalSettlement: sFinal, feasible: false, converged: false },
  };
}

module.exports = {
  invertConsolidationCoefficient,
  REJECTION,
  CEILING_RELATIVE_TOLERANCE,
  BACKCHECK_RELATIVE_LIMIT,
};
