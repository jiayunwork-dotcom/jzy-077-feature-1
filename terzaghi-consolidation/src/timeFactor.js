'use strict';

/**
 * 排水条件与时间因子换算 —— 全服务唯一出处。
 *
 * 排水路径长度 H_dr 与层厚 H 的关系只允许在这里定义：
 *   - 单面排水（single）：H_dr = H      （顶面排水、底面不透水）
 *   - 双面排水（double）：H_dr = H / 2  （上下均排水，对称半层）
 *
 * 时间因子 Tv = Cv * t / H_dr^2 也只在这里组合。
 * 深度剖面级数解与平均固结度级数解都必须通过本模块取得
 * H_dr 与 Tv，严禁各自另写一份换算。
 */

const DRAINAGE = Object.freeze({
  SINGLE: 'single',
  DOUBLE: 'double',
});

const DRAINAGE_VALUES = Object.freeze(Object.values(DRAINAGE));

function isValidDrainage(drainage) {
  return DRAINAGE_VALUES.includes(drainage);
}

/**
 * 排水路径长度（最长排水距离）。
 * @param {number} H 土层厚度
 * @param {'single'|'double'} drainage 排水条件
 * @returns {number} 排水路径长度 H_dr
 */
function drainagePathLength(H, drainage) {
  if (drainage === DRAINAGE.SINGLE) return H;
  if (drainage === DRAINAGE.DOUBLE) return H / 2;
  throw new RangeError(`未知的排水条件: ${drainage}`);
}

/**
 * 时间因子 Tv = Cv * t / H_dr^2。
 * Cv 与 t 的单位需自洽（如 Cv 取 m²/年、t 取 年）。
 */
function timeFactor(cv, t, H, drainage) {
  const hdr = drainagePathLength(H, drainage);
  return (cv * t) / (hdr * hdr);
}

module.exports = {
  DRAINAGE,
  DRAINAGE_VALUES,
  isValidDrainage,
  drainagePathLength,
  timeFactor,
};
