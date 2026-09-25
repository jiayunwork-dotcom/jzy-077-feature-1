'use strict';

/**
 * 反算路径 HTTP 路由：POST /consolidation/invert-cv。
 * 与正向路由（routes.js）平级、职责分离：本文件不挂载任何正向接口，
 * 正向接口的输入输出与拒绝方式保持原样。
 *
 *   400 —— 结构/取值校验失败（VALIDATION_ERROR）；
 *   422 —— 结构合法但物理上不可行/不可辨识（INFEASIBLE_*），
 *           明确告知落在可行区间之外，绝不返回硬凑的固结系数；
 *   200 —— 反算结果（含 cv、拟合质量指标、feasible/converged 判定）。
 */

const express = require('express');
const { validateInverseInput } = require('./inverseValidation');
const { invertConsolidationCoefficient } = require('./inverseService');

const router = express.Router();

router.post('/invert-cv', (req, res) => {
  const { errors, value } = validateInverseInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '反算输入参数校验失败',
        details: errors,
      },
    });
  }

  const result = invertConsolidationCoefficient(value);
  if (!result.feasible) {
    return res.status(422).json({
      error: {
        code: result.code,
        message: result.message,
        details: result.offenders.map((o) => ({
          field: `observations[${o.index}]`,
          t: o.t,
          settlement: o.settlement,
          message: `观测点 t=${o.t}, s=${o.settlement}，最终沉降量 S∞=${result.finalSettlement}`,
        })),
      },
      finalSettlement: result.finalSettlement,
    });
  }

  return res.json(result);
});

module.exports = router;
