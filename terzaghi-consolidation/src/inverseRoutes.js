'use strict';

/**
 * HTTP 路由（反算路径，与正向 routes.js 职责分离）：
 *   POST /inverse/cv
 *     - 结构非法（零/负时间、负沉降等）→ 400 VALIDATION_ERROR；
 *     - 结构合法但物理不可行/不可辨识       → 422 INFEASIBLE_OBSERVATIONS；
 *     - 反算成功                         → 200，含 cv、拟合指标、收敛/可行判定与回代明细。
 */

const express = require('express');
const { validateInverseInput } = require('./inverseValidation');
const { invertConsolidationCoefficient, REJECTION } = require('./inverseService');

const router = express.Router();

router.post('/inverse/cv', (req, res) => {
  const { errors, value } = validateInverseInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '反算输入校验失败',
        details: errors,
      },
    });
  }

  const outcome = invertConsolidationCoefficient(value);
  if (!outcome.ok) {
    const { rejection } = outcome;
    return res.status(422).json({
      error: {
        code: 'INFEASIBLE_OBSERVATIONS',
        reason: rejection.code,
        message: rejection.message,
        details: rejection.details,
        finalSettlement: rejection.finalSettlement,
      },
      feasible: false,
      converged: false,
    });
  }

  return res.json(outcome.result);
});

module.exports = router;
module.exports.REJECTION = REJECTION;
