'use strict';

/**
 * 深度剖面孔压解析级数解（太沙基一维固结，初始超静孔压沿深度均匀分布）。
 *
 * 统一在"距排水面距离 s ∈ [0, H_dr]"的坐标上求解：
 *   排水面 s = 0 处 u = 0，不透水面（或对称面）s = H_dr 处 du/ds = 0。
 *
 * 孔压比（未消散比例）：
 *   u(s, Tv) / u0 = Σ_{m=0}^{∞} (2/M) · sin(M · s/H_dr) · exp(−M² · Tv)
 *   其中 M = (2m+1)π/2，Tv 由 timeFactor.js 统一给出。
 *
 * 孔压消散比例（点固结度）：U(s, Tv) = 1 − u/u0。
 *
 * 本模块不自行换算 H_dr 或 Tv，一律由调用方从 timeFactor.js 取得后传入。
 */

const HALF_PI = Math.PI / 2;

/** 级数截断的包络容差：当 (2/M)·exp(−M²Tv) 小于该值时停止求和。 */
const ENVELOPE_TOLERANCE = 1e-13;

/** 默认最大项数。小 Tv 下级数收敛慢，该项数可覆盖 Tv ≥ ~1e-8 的情形。 */
const DEFAULT_MAX_TERMS = 100000;

/**
 * 将物理深度 z（自层顶起算，0 ≤ z ≤ H）映射为距排水面的距离 s。
 * 单面排水：顶面排水，s = z；
 * 双面排水：上下对称，s = min(z, H − z)。
 */
function distanceFromDrainageFace(z, H, drainage) {
  if (drainage === 'double') return Math.min(z, H - z);
  return z;
}

/**
 * 孔压比 u/u0 的级数解。
 * @param {number} s 距排水面距离，0 ≤ s ≤ hdr
 * @param {number} hdr 排水路径长度（来自 timeFactor.drainagePathLength）
 * @param {number} tv 时间因子（来自 timeFactor.timeFactor）
 * @param {number} [maxTerms] 级数最大项数
 * @returns {number} u/u0，截断误差由包络容差控制，结果夹在 [0, 1]
 */
function porePressureRatio(s, hdr, tv, maxTerms = DEFAULT_MAX_TERMS) {
  if (tv <= 0) return 1; // t = 0 时刻初始条件：全层 u = u0
  const x = s / hdr;
  let sum = 0;
  for (let m = 0; m < maxTerms; m += 1) {
    const M = (2 * m + 1) * HALF_PI;
    const envelope = (2 / M) * Math.exp(-M * M * tv);
    sum += envelope * Math.sin(M * x);
    // 包络随 m 严格递减，包络小于容差后剩余尾项有界，可截断
    if (envelope < ENVELOPE_TOLERANCE) break;
  }
  // 截断带来的 Gibbs 型微小越界按物理意义夹回 [0, 1]
  return Math.min(1, Math.max(0, sum));
}

/**
 * 点固结度（孔压消散比例）U(s, Tv) = 1 − u/u0。
 */
function dissipationRatio(s, hdr, tv, maxTerms = DEFAULT_MAX_TERMS) {
  return 1 - porePressureRatio(s, hdr, tv, maxTerms);
}

module.exports = {
  ENVELOPE_TOLERANCE,
  DEFAULT_MAX_TERMS,
  distanceFromDrainageFace,
  porePressureRatio,
  dissipationRatio,
};
