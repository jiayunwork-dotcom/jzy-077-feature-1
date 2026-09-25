'use strict';

/**
 * HTTP 路由：POST /consolidation。
 * 校验失败返回 400 + 结构化错误；校验通过返回完整核算结果。
 */

const express = require('express');
const { validateConsolidationInput } = require('./validation');
const { computeConsolidation } = require('./consolidationService');

const router = express.Router();

router.post('/consolidation', (req, res) => {
  const { errors, value } = validateConsolidationInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '输入参数校验失败',
        details: errors,
      },
    });
  }
  return res.json(computeConsolidation(value));
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;
