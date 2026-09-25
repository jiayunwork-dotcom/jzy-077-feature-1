'use strict';

/**
 * 固结系数反算的数值搜索（手写实现，不依赖任何第三方拟合库）。
 *
 * 思路：在正向模型外套一层一维搜索，目标函数只通过注入的 forward.evaluate
 * 取值（每个候选 cv 在每个观测时刻都走一遍现有正向核算），本模块不含任何
 * Tv / U_avg / S(t) 的平行公式。
 *
 * 利用的物理单调性：对固定观测时刻 t，S(cv) = U_avg(Tv(cv,t))·S∞ 关于 cv
 * 单调不减（cv↑ ⇒ Tv↑ ⇒ U_avg↑ ⇒ S↑）。因此：
 *   - 目标函数 SSE(cv) = Σ_i (S_fwd(cv,t_i) − s_i)² 在对数坐标 x=log10(cv)
 *     上，从"所有点都欠预测"到"所有点都过预测"之间为单谷：每个残差
 *     (S_fwd−s_i) 关于 x 单调上升，SSE 下降段（残差普遍为负）转为上升段
 *     （残差普遍为正）只跨越一次谷底；
 *   - 搜索不是在局部起伏里瞎撞：先沿单调方向做等间距粗扫，扫到两端
 *     "全部欠预测 / 全部过预测"夹住谷底，再在胜出小区间内做黄金分割细化。
 *
 * 两阶段：
 *   1. 粗扫（GRID_STEP = 0.1 个对数十年）：从数据尺度中点向两侧单调扩张，
 *      直到高端全部过预测、低端全部欠预测，记录离散最优点；
 *   2. 黄金分割：在最优点相邻一格构成的括号内细化到 X_TOLERANCE。
 */

const { drainagePathLength } = require('./timeFactor');

const GRID_STEP = 0.1; // log10(cv) 粗扫步长（0.1 个数量级）
const GOLDEN_RATIO_INV = (Math.sqrt(5) - 1) / 2; // 0.618...
const X_TOLERANCE = 1e-11; // log10(cv) 收敛阈值
const MAX_GOLDEN_ITERATIONS = 100;
// 安全护栏：相对数据尺度最多向外扩张的对数十年数（cv 约 1e±300 已近双精度极限）
const MAX_EXPANSION_DECADES = 300;

/**
 * 带缓存的目标函数：同一 x 只发起一次正向核算（粗扫端点与黄金分割端点重合时复用）。
 * @returns {(x: number) => { predictions: number[], sse: number }}
 */
function createObjective(forward, observations) {
  const cache = new Map();
  return function objective(x) {
    const key = x.toFixed(15);
    const hit = cache.get(key);
    if (hit) return hit;
    const cv = 10 ** x;
    const evaluations = forward.evaluate(cv, observations);
    const predictions = evaluations.map((e) => e.settlement);
    let sse = 0;
    for (let i = 0; i < observations.length; i += 1) {
      const r = predictions[i] - observations[i].settlement;
      sse += r * r;
    }
    const record = { predictions, sse, evaluations };
    cache.set(key, record);
    return record;
  };
}

/**
 * 单调粗扫：从数据尺度中点向两侧扩张，直到括号夹住谷底。
 * @returns {{ bestX:number, gridPointCount:number }}
 */
function coarseScan(objective, observations, xStart) {
  const allOverPredicted = (rec) => rec.predictions.every((p, i) => p >= observations[i].settlement);
  const allUnderPredicted = (rec) => rec.predictions.every((p, i) => p <= observations[i].settlement);

  let bestX = xStart;
  let best = objective(xStart);

  // 向 cv 增大方向扫，直到所有观测点都被过预测（SSE 此后必单调上升）
  let xHi = xStart;
  let recHi = best;
  while (!allOverPredicted(recHi)) {
    xHi += GRID_STEP;
    if (xHi - xStart > MAX_EXPANSION_DECADES) break;
    recHi = objective(xHi);
    if (recHi.sse < best.sse) {
      best = recHi;
      bestX = xHi;
    }
  }

  // 向 cv 减小方向扫，直到所有观测点都被欠预测（SSE 此前必单调下降）
  let xLo = xStart;
  let currentLo = objective(xStart); // 命中缓存，不重复发起正向核算
  while (!allUnderPredicted(currentLo)) {
    xLo -= GRID_STEP;
    if (xStart - xLo > MAX_EXPANSION_DECADES) break;
    currentLo = objective(xLo);
    if (currentLo.sse < best.sse) {
      best = currentLo;
      bestX = xLo;
    }
  }

  return { bestX, gridPointCount: Math.round((xHi - xLo) / GRID_STEP) + 1 };
}

/**
 * 黄金分割细化（括号内目标函数单谷）。
 * @returns {{ x:number, iterations:number, bracketWidth:number }}
 */
function goldenSection(objective, a0, b0) {
  let a = a0;
  let b = b0;
  let c = b - GOLDEN_RATIO_INV * (b - a);
  let d = a + GOLDEN_RATIO_INV * (b - a);
  let fc = objective(c);
  let fd = objective(d);

  let iterations = 0;
  let converged = false;
  while (b - a > X_TOLERANCE && iterations < MAX_GOLDEN_ITERATIONS) {
    if (fc.sse < fd.sse) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN_RATIO_INV * (b - a);
      fc = objective(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN_RATIO_INV * (b - a);
      fd = objective(d);
    }
    iterations += 1;
  }
  converged = b - a <= X_TOLERANCE;

  const candidates = [
    { x: a, rec: objective(a) },
    { x: c, rec: fc },
    { x: d, rec: fd },
    { x: b, rec: objective(b) },
  ];
  candidates.sort((p, q) => p.rec.sse - q.rec.sse);
  return { x: candidates[0].x, iterations, converged, initialBracketWidth: b0 - a0 };
}

/**
 * 反算固结系数。
 * @param {object} forward createForwardEvaluator 产物（每个候选 cv 都经它走正向核算）
 * @param {object} fixed { H, drainage }
 * @param {Array<{t:number, settlement:number}>} observations 已通过结构校验且物理可行
 * @returns {{ cv:number, best:object, search:object, finalEvaluation:object }}
 */
function invertCv(forward, fixed, observations) {
  const { H, drainage } = fixed;
  const hdr = drainagePathLength(H, drainage);

  // 数据尺度中点：在最早/最晚观测时刻的几何均值处令 Tv = 1 的 cv。
  // 仅用 timeFactor 唯一出处的排水路径长度做尺度定位，不涉及任何级数解。
  const tMin = Math.min(...observations.map((o) => o.t));
  const tMax = Math.max(...observations.map((o) => o.t));
  const tGeo = Math.sqrt(tMin * tMax);
  const xStart = Math.log10((hdr * hdr) / tGeo);

  const objective = createObjective(forward, observations);
  const scan = coarseScan(objective, observations, xStart);

  // 离散最优点两侧各一格构成细化括号；单谷性保证真解落在括号内
  const refined = goldenSection(objective, scan.bestX - GRID_STEP, scan.bestX + GRID_STEP);

  const cv = 10 ** refined.x;
  const finalEvaluation = objective(refined.x);

  return {
    cv,
    bestX: refined.x,
    finalEvaluation,
    search: {
      method: 'log10-grid-scan+golden-section',
      gridStepDecades: GRID_STEP,
      gridPointCount: scan.gridPointCount,
      goldenIterations: refined.iterations,
      goldenConverged: refined.converged,
      refinedBracketWidthDecades: refined.initialBracketWidth,
      log10Start: xStart,
    },
  };
}

module.exports = {
  invertCv,
  createObjective,
  coarseScan,
  goldenSection,
  GRID_STEP,
  X_TOLERANCE,
  MAX_GOLDEN_ITERATIONS,
};
