'use strict';

/**
 * 反算路径输入校验（与正向校验互相独立，不改动正向 validation.js）。
 *
 * 规则：
 *   H             —— 必须为正的有限数；
 *   drainage      —— 仅接受 'single' | 'double'；
 *   mv、deltaSigma —— 必须为非负的有限数；
 *   observations  —— 非空数组，每个观测点 { t, settlement }：
 *                      * t 必须为正的有限数（零或负时间拒绝）；
 *                      * settlement 必须为非负的有限数（负沉降拒绝）；
 *   maxTerms      —— 可选，1 ~ 1e6 的整数，透传给正向核算。
 *
 * 物理可行性（目标沉降是否超过最终沉降 S∞）不属于结构校验，
 * 由 inverseService 在计算阶段给出单独的结构化拒绝。
 */

const { DRAINAGE_VALUES } = require('./timeFactor');

const DEFAULT_MAX_TERMS = 100000;
const MAX_OBSERVATIONS = 10000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * 校验并归一化反算请求体。
 * @returns {{ errors: Array<{field: string, message: string}>, value: object|null }}
 */
function validateInverseInput(body) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      errors: [{ field: '(body)', message: '请求体必须是 JSON 对象' }],
      value: null,
    };
  }

  const { H, drainage, mv, deltaSigma, observations } = body;

  if (!isFiniteNumber(H)) {
    errors.push({ field: 'H', message: '土层厚度 H 必须是有限数值' });
  } else if (H <= 0) {
    errors.push({ field: 'H', message: `土层厚度 H 必须为正数（收到 ${H}）` });
  }

  if (!DRAINAGE_VALUES.includes(drainage)) {
    errors.push({
      field: 'drainage',
      message: `排水条件只能是 ${DRAINAGE_VALUES.join(' 或 ')}（收到 ${JSON.stringify(drainage)}）`,
    });
  }

  for (const [field, v, label] of [
    ['mv', mv, '体积压缩系数 mv'],
    ['deltaSigma', deltaSigma, '附加应力 Δσ'],
  ]) {
    if (!isFiniteNumber(v)) {
      errors.push({ field, message: `${label} 必须是有限数值` });
    } else if (v < 0) {
      errors.push({ field, message: `${label} 不允许为负值（收到 ${v}）` });
    }
  }

  // —— 观测序列：结构与取值范围 ——
  let normalizedObservations = null;
  if (!Array.isArray(observations) || observations.length === 0) {
    errors.push({ field: 'observations', message: 'observations 必须是非空数组，至少含一个观测点' });
  } else if (observations.length > MAX_OBSERVATIONS) {
    errors.push({ field: 'observations', message: `observations 最多 ${MAX_OBSERVATIONS} 个观测点` });
  } else {
    normalizedObservations = [];
    for (let i = 0; i < observations.length; i += 1) {
      const obs = observations[i];
      if (obs === null || typeof obs !== 'object' || Array.isArray(obs)) {
        errors.push({ field: `observations[${i}]`, message: '观测点必须是 { t, settlement } 对象' });
        continue;
      }
      const { t, settlement } = obs;
      let bad = false;
      if (!isFiniteNumber(t)) {
        errors.push({ field: `observations[${i}].t`, message: '观测时间 t 必须是有限数值' });
        bad = true;
      } else if (t <= 0) {
        errors.push({ field: `observations[${i}].t`, message: `观测时间 t 必须为正数（收到 ${t}），零或负时间没有物理意义` });
        bad = true;
      }
      if (!isFiniteNumber(settlement)) {
        errors.push({ field: `observations[${i}].settlement`, message: '累计沉降 settlement 必须是有限数值' });
        bad = true;
      } else if (settlement < 0) {
        errors.push({ field: `observations[${i}].settlement`, message: `累计沉降 settlement 不允许为负值（收到 ${settlement}）` });
        bad = true;
      }
      if (!bad) normalizedObservations.push({ t, settlement });
    }
  }

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
    value: { H, drainage, mv, deltaSigma, observations: normalizedObservations, maxTerms },
  };
}

module.exports = { validateInverseInput, DEFAULT_MAX_TERMS, MAX_OBSERVATIONS };
