'use strict';

/**
 * 固结核算编排：把排水路径/时间因子、深度剖面级数解、平均固结度与沉降
 * 串成一次完整计算。排水路径长度与时间因子只从 timeFactor.js 取得，
 * 深度剖面与平均固结度共用同一个 Tv，保证两种边界下结果同源。
 */

const { drainagePathLength, timeFactor } = require('./timeFactor');
const {
  distanceFromDrainageFace,
  porePressureRatio,
} = require('./profileSeries');
const {
  averageConsolidation,
  finalSettlement,
  settlementAt,
} = require('./consolidationDegree');

function buildDepthGrid(H, depths, gridPoints) {
  if (depths) return depths;
  const n = gridPoints;
  const grid = new Array(n);
  for (let i = 0; i < n; i += 1) grid[i] = (H * i) / (n - 1);
  return grid;
}

/**
 * @param {object} p 经 validation 归一化后的参数
 * @returns 孔压剖面、平均固结度与沉降结果
 */
function computeConsolidation(p) {
  const { cv, H, drainage, u0, mv, deltaSigma, t, depths, gridPoints, maxTerms } = p;

  // 唯一出处：排水路径长度与时间因子
  const hdr = drainagePathLength(H, drainage);
  const tv = timeFactor(cv, t, H, drainage);

  // 平均固结度与沉降（与深度剖面共用同一个 tv）
  const uAvg = averageConsolidation(tv, maxTerms);
  const sFinal = finalSettlement(mv, deltaSigma, H);
  const sT = settlementAt(uAvg, sFinal);

  // 深度剖面：每个深度点的孔压消散比例
  const profile = buildDepthGrid(H, depths, gridPoints).map((z) => {
    const s = distanceFromDrainageFace(z, H, drainage);
    const ratio = porePressureRatio(s, hdr, tv, maxTerms); // u/u0
    return {
      depth: z,
      distanceFromDrainageFace: s,
      porePressureRatio: ratio,
      dissipationRatio: 1 - ratio,
      excessPorePressure: u0 * ratio,
    };
  });

  return {
    parameters: { cv, H, drainage, u0, mv, deltaSigma, t },
    drainagePathLength: hdr,
    timeFactor: tv,
    averageConsolidation: uAvg,
    finalSettlement: sFinal,
    settlement: sT,
    settlementRatio: sFinal > 0 ? sT / sFinal : uAvg,
    profile,
  };
}

module.exports = { computeConsolidation };
