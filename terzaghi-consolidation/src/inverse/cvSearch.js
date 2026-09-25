'use strict';

/**
 * 固结系数一维搜索（反算专用数值内核，本文件不含任何固结物理公式）。
 *
 * 所有候选固结系数的拟合优劣都只通过传入的 forwardEvaluator 评估，
 * 即逐个调用现有正向核算 consolidationService.computeConsolidation；
 * 本模块不自行换算时间因子、不写级数近似、不引第三方拟合库。
 *
 * 搜索利用的物理性质（由测试钉死）：同一观测时刻，正向沉降 S(Cv) 关于
 * Cv 单调不减 —— Cv→0 时 S→0，Cv→∞ 时 S→S∞。因此：
 *
 *   1. 对每个观测点 (t_i, s_i)，单调方程 S(Cv; t_i) = s_i 至多一个根，
 *      用二分法（不是瞎猜的局部搜索）精确定位 r_i；
 *   2. 加权平方误差 E(Cv) = Σ w_i (S(Cv;t_i) − s_i)² 中，每项是单调阶跃
 *      与常数之差的平方，其"下坡—谷底—上坡"结构把全局最优限制在
 *      [min r_i, max r_i] 附近；
 *   3. 在根区间上按对数等距网格扫描定位全局谷所在的网格单元，再在该单元
 *      内做逐次二分网格细化（邻域探针 + 夹逼），对尖锐 V 底配宽平台的
 *      情形同样稳健，细化到机器精度尺度。
 *
 * 若最优谷贴着根区间端点（混入了零沉降或已达最终沉降的观测），网格按
 * 十倍程向外自适应延展，直到误差不再下降或撞上数值上下阈，绝不返回
 * 贴着边界硬凑的 Cv。
 */

/** 网格密度：每个十倍程（log10）的评估点数。 */
const GRID_POINTS_PER_DECADE = 64;

/** 邻域细化的最大迭代次数（每轮区间缩半，2^-120 ≈ 1e-36，远超双精度）。 */
const REFINE_MAX_ITERATIONS = 120;

/** 细化停机：ln(Cv) 区间宽度（Cv 相对精度约 e^-23 ≈ 1e-10）。 */
const REFINE_TOLERANCE_LOG = 1e-10;

/** 根区间外沿十倍程延展的最多次数（上下两个方向）。 */
const MAX_DECADE_EXTENSIONS = 12;

/** 求根阶段对数空间二分迭代次数（2^-80 个 ln 单位，远超双精度所需）。 */
const BISECTION_ITERATIONS = 80;

/** 数值上下阈：以最小/最大观测时刻的时间因子判据（Tv 取自正向输出）。 */
const TV_FLOOR = 1e-10;
const TV_CEIL = 1e2;


/**
 * 搜索结果：
 * @typedef {object} CvSearchResult
 * @property {number} cv 最优固结系数
 * @property {boolean} converged 是否在有限区间内收敛（未撞数值阈、细化达标）
 * @property {boolean} numericalFloorHit 最优谷贴着 Tv 下阈（Cv→0 方向）
 * @property {boolean} numericalCeilingHit 最优谷贴着 Tv 上阈（Cv→∞ 方向）
 * @property {number} sse 最优加权平方误差
 * @property {number} evaluations 正向核算评估总次数
 * @property {{ lower: number, upper: number }} bracket 最终搜索的 Cv 区间
 * @property {number[]} roots 每个观测点的单调根（0 表示零沉降，Infinity 表示已达 S∞）
 */

/**
 * 对单个观测点求单调根 S(Cv; t) = target。
 * 先从 cv=1 出发十倍几何放大夹住根，再在 ln(Cv) 空间单调二分
 * （与量纲尺度无关，单观测点也到机器精度）。夹逼两端始终是正有限数，
 * 绝不引入 0 / ±Infinity 作为对数坐标端点（避免中点 NaN 与 exp 下溢）。
 * @returns {number} 根；target<=0 记 0；target>=S∞ 记 Infinity
 */
function findMonotonicRoot(evaluator, t, target, sInf, counters) {
  if (target <= 0) return 0;
  // 正向平均固结度被夹在 1，target 达到 S∞（允许 1e-12 相对舍入）即要求 Cv→∞
  if (target >= sInf * (1 - 1e-12)) return Infinity;

  // 夹逼：保持 S(e^logLo) < target ≤ S(e^logHi)
  let logLo;
  let logHi = 0; // cv = 1
  counters.evaluations += 1;
  if (evaluator.settlement(1, t) < target) {
    // 根在 (1, ∞)：向上十倍放大，下界先落为 1（有限正数）
    logLo = 0;
    do {
      logHi += Math.LN10;
      counters.evaluations += 1;
    } while (evaluator.settlement(Math.exp(logHi), t) < target);
  } else {
    // 根在 (0, 1)：向下十倍放大，直到下界沉降低于目标
    logHi = 0;
    logLo = -Math.LN10; // cv = 0.1
    counters.evaluations += 1;
    while (evaluator.settlement(Math.exp(logLo), t) >= target) {
      logHi = logLo;
      logLo -= Math.LN10;
      counters.evaluations += 1;
      if (Math.exp(logLo) === 0) {
        // 再降一个十倍程就双精度下溢：根已在数值零邻域，其沉降对任何
        // 实际残差都不可分辨，直接返回当前正下界
        return Math.exp(logHi);
      }
    }
  }

  // ln 坐标单调二分：S(e^x) 关于 x 单调不减
  for (let k = 0; k < BISECTION_ITERATIONS; k += 1) {
    const mid = (logLo + logHi) / 2;
    counters.evaluations += 1;
    if (evaluator.settlement(Math.exp(mid), t) < target) logLo = mid;
    else logHi = mid;
  }
  return Math.exp(logHi);
}

/**
 * 执行固结系数搜索。
 * @param {object} evaluator createForwardEvaluator 的产物
 * @param {Array<{t: number, settlement: number, weight: number}>} observations
 * @returns {CvSearchResult}
 */
function searchConsolidationCoefficient(evaluator, observations) {
  const sInf = evaluator.finalSettlement;
  const counters = { evaluations: 0 };

  const weightedSSE = (cv) => {
    let acc = 0;
    for (let i = 0; i < observations.length; i += 1) {
      const o = observations[i];
      counters.evaluations += 1;
      const d = evaluator.settlement(cv, o.t) - o.settlement;
      acc += o.weight * d * d;
    }
    return acc;
  };

  // —— 第一步：每个观测点的单调根 ——
  const roots = observations.map((o) =>
    findMonotonicRoot(evaluator, o.t, o.settlement, sInf, counters));

  // 严格为正的有限根才构成初始根区间；根 0（零沉降）与 Infinity（已达 S∞）
  // 只是端点延展的方向提示，绝不能进入 ln() 坐标（log 0 = −∞ 会污染网格）
  const positiveRoots = roots.filter((r) => Number.isFinite(r) && r > 0);
  const hasZeroRoot = roots.some((r) => r === 0);
  const hasInfiniteRoot = roots.some((r) => !Number.isFinite(r));

  // 纯边界数据（全零 / 全最终沉降）由 service 层在调用前挡掉，这里兜底拒绝
  if (positiveRoots.length === 0) {
    return {
      cv: NaN,
      converged: false,
      numericalFloorHit: hasZeroRoot && !hasInfiniteRoot,
      numericalCeilingHit: hasInfiniteRoot && !hasZeroRoot,
      sse: NaN,
      evaluations: counters.evaluations,
      bracket: { lower: NaN, upper: NaN },
      roots,
    };
  }

  let lower = Math.min(...positiveRoots);
  let upper = Math.max(...positiveRoots);
  if (!(upper > lower)) {
    // 所有有限根重合（单观测点）：以该根为中心在 ln 坐标给一个对称小区间
    lower = lower / Math.E;
    upper = upper * Math.E;
  }

  // —— 第二步：对数网格扫描，含端点方向的自适应十倍程延展 ——
  const tMin = Math.min(...observations.map((o) => o.t));
  const tMax = Math.max(...observations.map((o) => o.t));

  function tvAt(cv, t) {
    counters.evaluations += 1;
    return evaluator.evaluate(cv, t).timeFactor;
  }

  function scan(logLo, logHi) {
    const decades = (logHi - logLo) / Math.LN10;
    const cells = Math.max(8, Math.ceil(decades * GRID_POINTS_PER_DECADE));
    let bestX = logLo;
    let bestF = weightedSSE(Math.exp(logLo));
    let bestIndex = 0;
    for (let i = 1; i <= cells; i += 1) {
      const x = logLo + ((logHi - logLo) * i) / cells;
      const f = weightedSSE(Math.exp(x));
      if (f < bestF) {
        bestF = f;
        bestX = x;
        bestIndex = i;
      }
    }
    return { bestX, bestF, bestIndex, cells };
  }

  let logLo = Math.log(lower);
  let logHi = Math.log(upper);

  /**
   * 只扫描一个新增十倍程条带 [edge, edge ± LN10]（与已扫描区间同密度），
   * 与当前最优比较。不重扫整个区间，避免宽区间 + 极小 Tv 时的级数开销失控。
   */
  function scanStrip(edgeLog, direction, currentBest) {
    const cells = GRID_POINTS_PER_DECADE;
    let bestX = currentBest.bestX;
    let bestF = currentBest.bestF;
    let bestI = -1;
    for (let i = 1; i <= cells; i += 1) {
      // i=1 贴着原区间外沿，i=cells 是新条带的外边界
      const x = direction < 0
        ? edgeLog - Math.LN10 + Math.LN10 * i / cells
        : edgeLog + Math.LN10 * i / cells;
      const f = weightedSSE(Math.exp(x));
      if (f < bestF) {
        bestF = f;
        bestX = x;
        bestI = i;
      }
    }
    return { bestX, bestF, atOuterEdge: bestI === cells };
  }

  let scanResult = scan(logLo, logHi);
  let totalCells = scanResult.cells;

  // 向 Cv→0 方向延展：有零沉降观测，或谷压在最低端点；每步只扫新条带
  let floorHit = false;
  if (hasZeroRoot || scanResult.bestIndex === 0) {
    for (let ext = 0; ext < MAX_DECADE_EXTENSIONS; ext += 1) {
      // 先探外沿（用最晚点判 Tv 下阈，它 Tv 最大、最先跌穿）：
      // 跌穿下阈则整段条带都不会改变任何沉降
      if (tvAt(Math.exp(logLo - Math.LN10), tMax) <= TV_FLOOR) { floorHit = true; break; }
      // 外沿处 SSE 已不优于当前谷：单峰结构下继续延展只会更差，立即停止。
      // 注意必须用严格"不优于"而不是相对容差——极小 Tv 处单点评估代价很高，
      // 不能在已经上坡的方向上空跑到数值阈。
      const fEdge = weightedSSE(Math.exp(logLo - Math.LN10));
      if (fEdge >= scanResult.bestF) break;
      logLo -= Math.LN10;
      totalCells += GRID_POINTS_PER_DECADE;
      const strip = scanStrip(logLo + Math.LN10, -1, scanResult);
      scanResult = { bestX: strip.bestX, bestF: strip.bestF, cells: totalCells };
      if (!strip.atOuterEdge) break; // 谷已离开外沿，停止延展
    }
  }

  // 向 Cv→∞ 方向延展：有已达 S∞ 的观测，或谷压在最高端点；每步只扫新条带
  let ceilingHit = false;
  const cellW = (logHi - logLo) / totalCells;
  if (hasInfiniteRoot || scanResult.bestX >= logHi - cellW * 1e-9) {
    for (let ext = 0; ext < MAX_DECADE_EXTENSIONS; ext += 1) {
      if (tvAt(Math.exp(logHi + Math.LN10), tMin) >= TV_CEIL) { ceilingHit = true; break; }
      const fEdge = weightedSSE(Math.exp(logHi + Math.LN10));
      if (fEdge >= scanResult.bestF) break;
      logHi += Math.LN10;
      totalCells += GRID_POINTS_PER_DECADE;
      const strip = scanStrip(logHi - Math.LN10, +1, scanResult);
      scanResult = { bestX: strip.bestX, bestF: strip.bestF, cells: totalCells };
      if (!strip.atOuterEdge) break;
    }
  }

  // —— 第三步：最优点邻域的逐次二分网格细化（对数 Cv 坐标）。
  // 单个尖锐 V 底配宽平台时，黄金分割/差分二分的初始探针可能全落在平台
  // 一侧而误判方向。这里每轮在当前最优点两侧四分点补两个正向评估，并把
  // 区间收成最优点的左右邻点：谷底被严格夹在区间内；若探针全落在平台上
  // （值相等），区间同样收窄、分辨率翻倍，下一轮自动探到 V 底。
  const cellWidth0 = (logHi - logLo) / scanResult.cells;
  let a = Math.max(logLo, scanResult.bestX - cellWidth0);
  let b = Math.min(logHi, scanResult.bestX + cellWidth0);
  let iterations = 0;
  // 当前三点：左端点 a、最优点 x、右端点 b（x ∈ (a,b)，fx 为已知最小）
  let x = scanResult.bestX;
  let fx = scanResult.bestF;
  let fa = weightedSSE(Math.exp(a));
  let fb = weightedSSE(Math.exp(b));
  for (; iterations < REFINE_MAX_ITERATIONS; iterations += 1) {
    if (b - a <= REFINE_TOLERANCE_LOG) break;
    const xq = (a + x) / 2;
    const xr = (x + b) / 2;
    const fq = weightedSSE(Math.exp(xq));
    const fr = weightedSSE(Math.exp(xr));
    // 在 5 个候选点里选最小（并列时优先当前 x，保证区间稳定收窄）
    const candidates = [
      { x: a, f: fa }, { x: xq, f: fq }, { x, f: fx },
      { x: xr, f: fr }, { x: b, f: fb },
    ];
    let bestIdx = 2;
    for (let i = 0; i < candidates.length; i += 1) {
      if (candidates[i].f < candidates[bestIdx].f) bestIdx = i;
    }
    const left = candidates[Math.max(0, bestIdx - 1)];
    const right = candidates[Math.min(candidates.length - 1, bestIdx + 1)];
    a = left.x; fa = left.f;
    b = right.x; fb = right.f;
    x = candidates[bestIdx].x; fx = candidates[bestIdx].f;
  }

  return {
    cv: Math.exp(x),
    converged: !floorHit && !ceilingHit && b - a <= REFINE_TOLERANCE_LOG * 10,
    numericalFloorHit: floorHit,
    numericalCeilingHit: ceilingHit,
    sse: fx,
    evaluations: counters.evaluations,
    bracket: { lower: Math.exp(logLo), upper: Math.exp(logHi) },
    refineIterations: iterations,
    roots,
  };
}

module.exports = {
  searchConsolidationCoefficient,
  GRID_POINTS_PER_DECADE,
  REFINE_MAX_ITERATIONS,
  BISECTION_ITERATIONS,
  TV_FLOOR,
  TV_CEIL,
};
