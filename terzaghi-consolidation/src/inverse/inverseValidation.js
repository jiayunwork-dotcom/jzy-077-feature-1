'use strict';

/**
 * 反算路径输入校验。与正向校验（src/validation.js）分开，互不影响：
 * 正向接口的规则与拒绝方式一个字不动，本模块只服务反算请求。
 *
 * 规则：
 *   H、u0        —— 必须为正的有限数（与正向一致）；
 *   mv、Δσ       —— 必须为正的有限数（反算要靠 S∞ = mv·Δσ·H 判定可行性，
 *                    S∞ = 0 时沉降恒为零、反算无意义，结构化拒绝）；
 *   drainage     —— 仅接受 'single' | 'double'；
 *   observations —— 非空数组，元素 { t, settlement }：
 *                     · t 必须为正（零或负的观测时间拒绝）；
 *                     · settlement 必须非负（负累计沉降拒绝）；
 *   maxTerms     —— 可选，1 ~ 1e6 的整数。
 *
 * 物理可行性在归一化之后由 service 层判定（目标沉降是否超过 S∞），
 * 本模块只做结构与取值校验。
 */

const { DRAINAGE_VALUES } = require('../timeFactor');

const DEFAULT_MAX_TERMS = 100000;
const MAX_OBSERVATIONS = 10000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
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

  const { H, drainage, u0, mv, deltaSigma, observations } = body;

  // —— 必须为正的土性参数 ——
  const positiveFields = [
    ['H', H, '土层厚度 H'],
    ['u0', u0, '初始超静孔压 u0'],
    ['mv', mv, '体积压缩系数 mv'],
    ['deltaSigma', deltaSigma, '附加应力 Δσ'],
  ];
  for (const [field, v, label] of positiveFields) {
    if (!isFiniteNumber(v)) {
      errors.push({ field, message: `${label} 必须是有限数值` });
    } else if (v <= 0) {
      errors.push({ field, message: `${label} 必须为正数（收到 ${v}）；反算依赖非零最终沉降量 S∞` });
    }
  }

  // —— 排水条件 ——
  if (!DRAINAGE_VALUES.includes(drainage)) {
    errors.push({
      field: 'drainage',
      message: `排水条件只能是 ${DRAINAGE_VALUES.join(' 或 ')}（收到 ${JSON.stringify(drainage)}）`,
    });
  }

  // —— 观测序列 ——
  let normalizedObservations = null;
  if (!Array.isArray(observations) || observations.length === 0) {
    errors.push({ field: 'observations', message: 'observations 必须是非空数组，至少包含一个观测点' });
  } else if (observations.length > MAX_OBSERVATIONS) {
    errors.push({ field: 'observations', message: `observations 最多 ${MAX_OBSERVATIONS} 个点` });
  } else {
    normalizedObservations = [];
    for (let i = 0; i < observations.length; i += 1) {
      const o = observations[i];
      if (o === null || typeof o !== 'object' || Array.isArray(o)) {
        errors.push({ field: `observations[${i}]`, message: '观测点必须是 { t, settlement } 对象' });
        continue;
      }
      const { t, settlement } = o;
      let bad = false;
      if (!isFiniteNumber(t)) {
        errors.push({ field: `observations[${i}].t`, message: '观测时间 t 必须是有限数值' });
        bad = true;
      } else if (t <= 0) {
        errors.push({
          field: `observations[${i}].t`,
          message: `观测时间必须从加载后为正（收到 ${t}），零或负值无法参与反算`,
        });
        bad = true;
      }
      if (!isFiniteNumber(settlement)) {
        errors.push({ field: `observations[${i}].settlement`, message: '累计沉降 settlement 必须是有限数值' });
        bad = true;
      } else if (settlement < 0) {
        errors.push({
          field: `observations[${i}].settlement`,
          message: `累计沉降不允许为负值（收到 ${settlement}）`,
        });
        bad = true;
      }
      if (!bad) normalizedObservations.push({ t, settlement });
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
    value: {
      H,
      drainage,
      u0,
      mv,
      deltaSigma,
      observations: normalizedObservations,
      maxTerms,
    },
  };
}

module.exports = { validateInverseInput, DEFAULT_MAX_TERMS, MAX_OBSERVATIONS };
