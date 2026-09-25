'use strict';

/**
 * 固结系数反算编排。职责与正向编排（consolidationService.js）严格分开：
 *
 *   校验 → 物理可行性闸门 → 一维搜索（cvSearch，内部只经正向适配器评估）
 *        → 拿反算 Cv 回代现有正向核算，逐点重算沉降 → 汇总拟合质量指标。
 *
 * 本文件不出现任何 Tv / 固结度 / 沉降公式；所有沉降量均来自
 * forwardEvaluator → consolidationService.computeConsolidation。
 */

const { createForwardEvaluator } = require('./forwardEvaluator');
const { searchConsolidationCoefficient } = require('./cvSearch');

/** 目标沉降相对 S∞ 的可达容差：达到该值即视为要求 Cv→∞，不可行。 */
const FINAL_REACH_TOLERANCE = 1e-12;

/**
 * 物理可行性与可辨识性闸门。
 * 平均固结度封顶 1，沉降不可能超过 S∞ = mv·Δσ·H；另需至少一个
 * 严格落在 (0, S∞) 内的观测点，否则 Cv 不可辨识。
 *
 * @returns {{ feasible: boolean, code: string|null, message: string|null, offenders: number[] }}
 */
function checkFeasibility(observations, finalSettlement) {
  // 1) 目标沉降达到/超过物理最终沉降：给定参数下无解（根在 Cv→∞ 或不存在）
  const atOrBeyond = [];
  for (let i = 0; i < observations.length; i += 1) {
    if (observations[i].settlement >= finalSettlement * (1 - FINAL_REACH_TOLERANCE)) {
      atOrBeyond.push(i);
    }
  }
  if (atOrBeyond.length > 0) {
    const over = observations.some(
      (o) => o.settlement > finalSettlement * (1 + FINAL_REACH_TOLERANCE),
    );
    return {
      feasible: false,
      code: 'INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT',
      message: over
        ? `存在实测沉降超过给定参数下的最终沉降量 S∞=${finalSettlement} 的观测点，目标落在物理可行区间之外`
        : `存在实测沉降已达到最终沉降量 S∞=${finalSettlement} 的观测点，对应固结系数需趋于无穷大，无法反算有限值`,
      offenders: atOrBeyond,
      finalSettlement,
    };
  }

  // 2) 全部观测沉降为零：任意 Cv→0 都能拟合，Cv 不可辨识
  if (observations.every((o) => o.settlement === 0)) {
    return {
      feasible: false,
      code: 'INFEASIBLE_ALL_ZERO_SETTLEMENT',
      message: '所有观测点的累计沉降均为零，任意固结系数在 Cv→0 时都能拟合，固结系数不可辨识',
      offenders: [],
      finalSettlement,
    };
  }

  return { feasible: true, code: null, message: null, offenders: [], finalSettlement };
}

/**
 * 回代反算 Cv：在每个观测时刻重新走一遍正向核算，
 * 预测量必须与正向接口对同一 (cv, t) 的输出逐位一致。
 */
function backSubstitute(evaluator, cv, observations) {
  return observations.map((o) => {
    const forward = evaluator.evaluate(cv, o.t);
    const predicted = forward.settlement;
    const residual = predicted - o.settlement; // 预测 − 实测
    return {
      t: o.t,
      observedSettlement: o.settlement,
      predictedSettlement: predicted,
      residual,
      absoluteResidual: Math.abs(residual),
      residualRatio: residual / evaluator.finalSettlement,
      timeFactor: forward.timeFactor,
      averageConsolidation: forward.averageConsolidation,
    };
  });
}

function summarizeFit(points, sInf) {
  const n = points.length;
  const sse = points.reduce((a, p) => a + p.residual * p.residual, 0);
  const mse = sse / n;
  const rmse = Math.sqrt(mse);

  const meanObserved = points.reduce((a, p) => a + p.observedSettlement, 0) / n;
  const ssTot = points.reduce(
    (a, p) => a + (p.observedSettlement - meanObserved) ** 2, 0,
  );
  // 观测无离散度（只有一个点或各点沉降相同）时 R² 无定义
  const rSquared = ssTot > 0 ? 1 - sse / ssTot : null;

  const maxAbsResidual = points.reduce((a, p) => Math.max(a, p.absoluteResidual), 0);

  return {
    sse,
    mse,
    rmse,
    normalizedRmsError: rmse / sInf,        // RMSE / S∞：无量纲，一眼判断可信度
    rSquared,
    maxAbsResidual,
    maxAbsResidualRatio: maxAbsResidual / sInf,
  };
}

/**
 * 主入口：由经 inverseValidation 归一化的请求执行反算。
 * 可行返回 { feasible: true, ... }；不可行返回结构化拒绝描述。
 */
function invertConsolidationCoefficient(input) {
  const { H, drainage, u0, mv, deltaSigma, observations, maxTerms } = input;

  const evaluator = createForwardEvaluator({ H, drainage, u0, mv, deltaSigma, maxTerms });
  const sInf = evaluator.finalSettlement;

  const gate = checkFeasibility(observations, sInf);
  if (!gate.feasible) {
    return {
      feasible: false,
      converged: false,
      code: gate.code,
      message: gate.message,
      finalSettlement: sInf,
      offenders: gate.offenders.map((i) => ({
        index: i,
        t: observations[i].t,
        settlement: observations[i].settlement,
      })),
    };
  }

  // 等权最小二乘（观测沉降同量纲，单位与 S∞ 自洽）
  const weighted = observations.map((o) => ({ ...o, weight: 1 }));
  const search = searchConsolidationCoefficient(evaluator, weighted);

  // 回代：反算 Cv 在观测时刻重算沉降（逐点走现有正向核算）
  const points = backSubstitute(evaluator, search.cv, observations);
  const fit = summarizeFit(points, sInf);

  let convergedReason = null;
  if (!search.converged) {
    if (search.numericalFloorHit) {
      convergedReason = 'NUMERICAL_FLOOR：最优谷沿 Cv→0 方向一直下坡到数值下阈，数据可能只反映固结尚未启动';
    } else if (search.numericalCeilingHit) {
      convergedReason = 'NUMERICAL_CEILING：最优谷沿 Cv→∞ 方向一直下坡到数值上阈';
    } else {
      convergedReason = 'SEARCH_TOLERANCE_NOT_MET';
    }
  }

  return {
    feasible: true,
    converged: search.converged,
    convergedReason,
    cv: search.cv,
    finalSettlement: sInf,
    searchBracket: search.bracket,
    forwardEvaluations: search.evaluations,
    fit,
    observations: points,
    parameters: { H, drainage, u0, mv, deltaSigma, maxTerms },
  };
}

module.exports = {
  invertConsolidationCoefficient,
  checkFeasibility,
  FINAL_REACH_TOLERANCE,
};
