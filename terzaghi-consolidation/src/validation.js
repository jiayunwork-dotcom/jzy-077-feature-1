'use strict';

/**
 * 输入校验：所有非法输入在进入计算前被拒绝，并给出结构化错误说明。
 * 规则：
 *   cv、H、t、u0  —— 必须为正的有限数（零或负值拒绝）；
 *   mv、deltaSigma —— 必须为非负的有限数（负值拒绝）；
 *   drainage      —— 仅接受 'single' | 'double'；
 *   depths        —— 可选，数值数组，每个元素落在 [0, H]；
 *   gridPoints    —— 可选，2 ~ 10000 的整数（未给 depths 时生效，默认 21）；
 *   maxTerms      —— 可选，1 ~ 1e6 的整数（级数截断项数上限）。
 */

const { DRAINAGE_VALUES } = require('./timeFactor');

const DEFAULT_GRID_POINTS = 21;
const DEFAULT_MAX_TERMS = 100000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * 校验并归一化请求体。
 * @returns {{ errors: Array<{field: string, message: string}>, value: object|null }}
 */
function validateConsolidationInput(body) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      errors: [{ field: '(body)', message: '请求体必须是 JSON 对象' }],
      value: null,
    };
  }

  const { cv, H, drainage, u0, mv, deltaSigma, t } = body;

  // —— 必须为正的物理量 ——
  const positiveFields = [
    ['cv', cv, '固结系数 cv'],
    ['H', H, '土层厚度 H'],
    ['t', t, '时间 t'],
    ['u0', u0, '初始超静孔压 u0'],
  ];
  for (const [field, v, label] of positiveFields) {
    if (!isFiniteNumber(v)) {
      errors.push({ field, message: `${label} 必须是有限数值` });
    } else if (v <= 0) {
      errors.push({ field, message: `${label} 必须为正数（收到 ${v}）` });
    }
  }

  // —— 必须为非负的物理量 ——
  const nonNegativeFields = [
    ['mv', mv, '体积压缩系数 mv'],
    ['deltaSigma', deltaSigma, '附加应力 Δσ'],
  ];
  for (const [field, v, label] of nonNegativeFields) {
    if (!isFiniteNumber(v)) {
      errors.push({ field, message: `${label} 必须是有限数值` });
    } else if (v < 0) {
      errors.push({ field, message: `${label} 不允许为负值（收到 ${v}）` });
    }
  }

  // —— 排水条件 ——
  if (!DRAINAGE_VALUES.includes(drainage)) {
    errors.push({
      field: 'drainage',
      message: `排水条件只能是 ${DRAINAGE_VALUES.join(' 或 ')}（收到 ${JSON.stringify(drainage)}）`,
    });
  }

  // —— 深度网格：depths 与 gridPoints 二选一，depths 优先 ——
  let depths = null;
  let gridPoints = DEFAULT_GRID_POINTS;
  if (body.depths !== undefined) {
    if (!Array.isArray(body.depths) || body.depths.length === 0) {
      errors.push({ field: 'depths', message: 'depths 必须是非空数值数组' });
    } else if (body.depths.length > 10000) {
      errors.push({ field: 'depths', message: 'depths 最多 10000 个点' });
    } else if (isFiniteNumber(H) && H > 0) {
      const bad = body.depths.find((z) => !isFiniteNumber(z) || z < 0 || z > H);
      if (bad !== undefined) {
        errors.push({
          field: 'depths',
          message: `深度点必须全部落在 [0, H] 区间内，发现非法值 ${JSON.stringify(bad)}`,
        });
      } else {
        depths = body.depths.slice();
      }
    }
  } else if (body.gridPoints !== undefined) {
    if (!isPositiveInt(body.gridPoints) || body.gridPoints < 2 || body.gridPoints > 10000) {
      errors.push({ field: 'gridPoints', message: 'gridPoints 必须是 2 ~ 10000 的整数' });
    } else {
      gridPoints = body.gridPoints;
    }
  }

  // —— 级数项数上限（可选覆盖） ——
  let maxTerms = DEFAULT_MAX_TERMS;
  if (body.maxTerms !== undefined) {
    if (!isPositiveInt(body.maxTerms) || body.maxTerms > 1e6) {
      errors.push({ field: 'maxTerms', message: 'maxTerms 必须是 1 ~ 1000000 的整数' });
    } else {
      maxTerms = body.maxTerms;
    }
  }

  if (errors.length > 0) return { errors, value: null };

  return {
    errors: [],
    value: { cv, H, drainage, u0, mv, deltaSigma, t, depths, gridPoints, maxTerms },
  };
}

module.exports = {
  validateConsolidationInput,
  DEFAULT_GRID_POINTS,
  DEFAULT_MAX_TERMS,
};
