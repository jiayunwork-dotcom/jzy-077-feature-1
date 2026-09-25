'use strict';

/**
 * 反算专用的"正向核算适配器"。
 *
 * 反算路径评估任何一个候选固结系数时，必须也只能通过本模块调用现有正向
 * 编排 consolidationService.computeConsolidation —— 与对外正向接口
 * POST /api/v1/consolidation 走的是同一份时间因子、级数解与沉降计算，
 * 本文件绝不另写任何 Tv / 平均固结度 / 沉降的平行公式。
 *
 * 同一个 cv 喂给反算内部评估与喂给正向接口，得到的 timeFactor、
 * averageConsolidation、settlement 逐位一致（测试钉死）。
 */

const consolidationService = require('../consolidationService');

/**
 * 构造一组固定土性与排水条件下的正向评估器。
 * @param {object} site 经反算校验归一化后的场地参数
 *   { H, drainage, u0, mv, deltaSigma, maxTerms }
 * @returns {{
 *   finalSettlement: number,
 *   settlement: (cv: number, t: number) => number,
 *   evaluate: (cv: number, t: number) => object
 * }}
 */
function createForwardEvaluator(site) {
  const { H, drainage, u0, mv, deltaSigma, maxTerms } = site;

  // S∞ = mv·Δσ·H 也不自己算：用一个任意正 cv、正 t 跑一次正向核算取其结果，
  // 保证最终沉降与正向接口同源。
  const probe = consolidationService.computeConsolidation({
    cv: 1,
    H,
    drainage,
    u0,
    mv,
    deltaSigma,
    t: 1,
    depths: null,
    gridPoints: 2, // 反算只关心整体量，剖面取最少两点，避免无谓计算
    maxTerms,
  });
  const finalSettlement = probe.finalSettlement;

  /**
   * 候选 cv 在时刻 t 的沉降，值直接取自现有正向核算结果。
   */
  function settlement(cv, t) {
    const r = consolidationService.computeConsolidation({
      cv,
      H,
      drainage,
      u0,
      mv,
      deltaSigma,
      t,
      depths: null,
      gridPoints: 2,
      maxTerms,
    });
    return r.settlement;
  }

  /**
   * 候选 cv 在时刻 t 的完整正向核算结果（含 Tv、平均固结度、沉降）。
   * 回代核对时使用，保证反算报告里的预测量与正向接口逐位一致。
   */
  function evaluate(cv, t) {
    return consolidationService.computeConsolidation({
      cv,
      H,
      drainage,
      u0,
      mv,
      deltaSigma,
      t,
      depths: null,
      gridPoints: 2,
      maxTerms,
    });
  }

  return { finalSettlement, settlement, evaluate };
}

module.exports = { createForwardEvaluator };
