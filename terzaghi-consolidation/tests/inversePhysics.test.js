'use strict';

/**
 * 反算路径物理/数值测试（直接驱动计算模块，不经过 HTTP）：
 *
 *  A. 同源性（重点稽查项）：反算搜索过程中评估的每一个候选 Cv 都必须
 *     实调现有正向核算 consolidationService.computeConsolidation，
 *     且返回的沉降/Tv/固结度与正向逐位一致，不存在平行公式；
 *  B. 回代吻合：反算 Cv 回代正向后在观测时刻重算的沉降与实测残差
 *     落在明确、可报告的区间内，拟合指标可信；
 *  C. 单调性：Cv 增大时同一观测时刻正向沉降单调不减（单面/双面，
 *     跨越小 Tv、级数收敛区、饱和区）；
 *  D. 反算精度：用正向生成的合成观测（无噪声）反算，Cv 回到生成值；
 *  E. 结构化拒绝：零/负观测时间、负累计沉降、目标达到/超过 S∞、
 *     全零沉降 —— 全部被拒，绝不硬凑；
 *  F. 搜索沿单调关系定位，不撞数值阈（常规数据 converged=true）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const consolidationService = require('../src/consolidationService');
const { createForwardEvaluator } = require('../src/inverse/forwardEvaluator');
const { searchConsolidationCoefficient } = require('../src/inverse/cvSearch');
const {
  invertConsolidationCoefficient,
  checkFeasibility,
} = require('../src/inverse/inverseService');
const { validateInverseInput } = require('../src/inverse/inverseValidation');

const site = {
  H: 6,
  drainage: 'single',
  u0: 100,
  mv: 0.0008,
  deltaSigma: 120,
  maxTerms: 100000,
};
// S∞ = 0.0008·120·6 = 0.576
const S_INF = 0.576;
const CV_TRUE = 1.5;

/** 用现有正向核算在给定时刻造"实测"沉降（保证合成数据与模型同源）。 */
function forwardSettlement(cv, t, overrides = {}) {
  return consolidationService.computeConsolidation({
    cv,
    H: overrides.H ?? site.H,
    drainage: overrides.drainage ?? site.drainage,
    u0: overrides.u0 ?? site.u0,
    mv: overrides.mv ?? site.mv,
    deltaSigma: overrides.deltaSigma ?? site.deltaSigma,
    t,
    depths: null,
    gridPoints: 2,
    maxTerms: overrides.maxTerms ?? site.maxTerms,
  }).settlement;
}

function makeObservations(cv, times, overrides = {}) {
  return times.map((t) => ({ t, settlement: forwardSettlement(cv, t, overrides) }));
}

function validInput(overrides = {}) {
  return {
    ...site,
    observations: makeObservations(CV_TRUE, [0.25, 0.5, 1, 2, 4, 8]),
    ...overrides,
  };
}

// —— A1. 每个候选值都走现有正向核算，且沉降逐位一致 ——
test('搜索过程中每个候选 Cv 都实调现有正向核算，沉降/Tv/固结度逐位一致', () => {
  const observations = makeObservations(CV_TRUE, [0.5, 1, 2, 4]);
  const calls = [];
  const original = consolidationService.computeConsolidation;
  consolidationService.computeConsolidation = function spy(p) {
    const r = original(p);
    calls.push({ cv: p.cv, t: p.t, result: r });
    return r;
  };
  try {
    const evaluator = createForwardEvaluator(site);
    const search = searchConsolidationCoefficient(
      evaluator,
      observations.map((o) => ({ ...o, weight: 1 })),
    );
    // 搜索必须真的评估了大量候选（二分 + 网格 + 黄金分割），而不是直接吐常数
    assert.ok(calls.length >= 50, `正向评估次数过少：${calls.length}`);
    // 每个候选 (cv, t) 的沉降都必须与正向核算的 settlement 字段逐位相等
    const cvValues = new Set();
    for (const call of calls) {
      const direct = original({
        cv: call.cv, H: site.H, drainage: site.drainage, u0: site.u0,
        mv: site.mv, deltaSigma: site.deltaSigma, t: call.t,
        depths: null, gridPoints: 2, maxTerms: site.maxTerms,
      });
      assert.equal(call.result.settlement, direct.settlement,
        `反算内部沉降与正向不一致 cv=${call.cv} t=${call.t}`);
      assert.equal(call.result.timeFactor, direct.timeFactor);
      assert.equal(call.result.averageConsolidation, direct.averageConsolidation);
      cvValues.add(call.cv);
    }
    // 候选值确实多样（搜索在探索，不是单点）
    assert.ok(cvValues.size >= 30, `不同候选 Cv 过少：${cvValues.size}`);
    assert.ok(search.converged, '合成数据应收敛于有限区间内');
  } finally {
    consolidationService.computeConsolidation = original;
  }
});

// —— A2. 反算报告里回代的预测量与"再调一次正向接口"逐位一致 ——
test('回代预测与正向接口对同一 (cv, t) 的输出逐位一致', () => {
  const result = invertConsolidationCoefficient(validInput());
  for (const p of result.observations) {
    const direct = consolidationService.computeConsolidation({
      cv: result.cv, ...site, t: p.t,
      depths: null, gridPoints: 2, maxTerms: site.maxTerms,
    });
    assert.equal(p.predictedSettlement, direct.settlement);
    assert.equal(p.timeFactor, direct.timeFactor);
    assert.equal(p.averageConsolidation, direct.averageConsolidation);
    assert.equal(p.residual, p.predictedSettlement - p.observedSettlement);
  }
});

// —— A3. 反算模块不允许出现自己的 Tv 换算：适配器是唯一调用出口 ——
test('正向适配器的 settlement/evaluate 是正向核算的薄封装（无平行实现）', () => {
  const evaluator = createForwardEvaluator(site);
  const original = consolidationService.computeConsolidation;
  let invoked = 0;
  consolidationService.computeConsolidation = function spy(p) {
    invoked += 1;
    return original(p);
  };
  try {
    evaluator.settlement(2.25, 1.5);
    evaluator.evaluate(2.25, 1.5);
    assert.equal(invoked, 2, '每次评估必须且只需一次正向核算');
  } finally {
    consolidationService.computeConsolidation = original;
  }
});

// —— B1. 无噪声合成数据：残差为机器精度量级，指标可报告 ——
test('无噪声合成观测：反算 Cv 回到真值，逐点残差落在 1e-10·S∞ 以内', () => {
  const result = invertConsolidationCoefficient(validInput());
  assert.ok(result.feasible && result.converged);
  assert.ok(Math.abs(result.cv - CV_TRUE) / CV_TRUE < 1e-8,
    `反算 Cv=${result.cv} 偏离真值 ${CV_TRUE}`);
  for (const p of result.observations) {
    assert.ok(Math.abs(p.residual) < 1e-10 * S_INF,
      `t=${p.t} 残差 ${p.residual} 超出可报告区间`);
  }
  assert.ok(result.fit.rmse < 1e-10 * S_INF);
  assert.ok(result.fit.normalizedRmsError < 1e-10);
  assert.ok(result.fit.maxAbsResidualRatio < 1e-10);
  // R² 在无噪声完美拟合下为 1（浮点意义上）
  assert.ok(Math.abs(result.fit.rSquared - 1) < 1e-8);
});

// —— B2. 带噪声观测：残差规模与注入噪声量级相称，Cv 仍贴近真值 ——
test('带噪声观测：反算 Cv 稳健，RMSE 与噪声同量级且如实报告', () => {
  // 固定伪随机噪声（线性同余），幅度 ±1% S∞
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const observations = makeObservations(CV_TRUE, [0.25, 0.5, 1, 2, 4, 8, 12])
    .map((o) => ({ ...o, settlement: Math.max(0, o.settlement + (rnd() * 2 - 1) * 0.01 * S_INF) }));
  const result = invertConsolidationCoefficient({ ...site, observations });
  assert.ok(result.feasible && result.converged);
  assert.ok(Math.abs(result.cv - CV_TRUE) / CV_TRUE < 0.15,
    `±1% 噪声下 Cv 偏差过大：${result.cv}`);
  assert.ok(result.fit.normalizedRmsError <= 0.01 + 1e-9,
    `normalizedRmsError=${result.fit.normalizedRmsError} 超过噪声上限`);
  assert.ok(result.fit.rSquared > 0.99, `R²=${result.fit.rSquared} 过低`);
  // 报告区间非负、字段齐全
  for (const p of result.observations) {
    assert.ok(p.absoluteResidual >= 0);
    assert.ok(Math.abs(p.residualRatio - p.residual / S_INF) < 1e-15);
  }
});

// —— B3. 单观测点也能反算（R² 无定义时如实给 null，不编造） ——
test('单观测点：返回 Cv，R² 置 null 而非编造数值', () => {
  const result = invertConsolidationCoefficient({
    ...site,
    observations: makeObservations(CV_TRUE, [2]),
  });
  assert.ok(result.feasible && result.converged);
  assert.ok(Math.abs(result.cv - CV_TRUE) / CV_TRUE < 1e-8);
  assert.equal(result.fit.rSquared, null);
  assert.ok(result.fit.rmse < 1e-10 * S_INF);
});

// —— C. 单调性钉死：Cv 增大，同一观测时刻沉降单调不减 ——
test('固结系数增大时同一观测时刻正向沉降单调不减（单面/双面，宽 Tv 跨度）', () => {
  for (const drainage of ['single', 'double']) {
    for (const t of [0.01, 0.1, 1, 10, 100]) {
      const prev = -Infinity;
      let last = prev;
      // 从 Cv = 1e-6 十倍递增到 1e8，覆盖 Tv 从趋零到饱和
      for (let k = -6; k <= 8; k += 1) {
        const cv = 10 ** k;
        const s = forwardSettlement(cv, t, { drainage });
        assert.ok(s >= last - 1e-15,
          `${drainage} t=${t}：Cv=${cv} 沉降 ${s} 小于更小 Cv 的 ${last}，单调性被破坏`);
        last = s;
      }
      // 端点物理意义：Cv→0 沉降显著偏小，Cv→∞ 沉降趋 S∞
      const sLow = forwardSettlement(1e-6, t, { drainage });
      const sHigh = forwardSettlement(1e8, t, { drainage });
      assert.ok(sLow < 0.01 * S_INF, `低 Cv 沉降 ${sLow} 应显著偏小`);
      assert.ok(Math.abs(sHigh - S_INF) < 1e-8 * S_INF);
      assert.ok(sHigh > sLow);
    }
  }
});

// —— C2. 细粒度单调（相邻小步长也不允许局部起伏） ——
test('Cv 以 1% 小步长递增时沉降严格不减', () => {
  const evaluator = createForwardEvaluator(site);
  for (const t of [0.3, 3, 30]) {
    let last = -Infinity;
    let cv = 0.01;
    for (let i = 0; i < 800; i += 1) {
      const s = evaluator.settlement(cv, t);
      assert.ok(s >= last - 1e-15, `t=${t} cv=${cv} 出现局部起伏`);
      last = s;
      cv *= 1.02;
    }
  }
});

// —— D. 多组真值/排水条件反算都能回正 ——
test('不同真值 Cv 与排水条件下反算均回到生成参数', () => {
  const cases = [
    { cv: 0.12, drainage: 'single', times: [0.2, 1, 3, 9] },
    { cv: 3.7, drainage: 'single', times: [0.2, 1, 3, 9] },
    { cv: 25, drainage: 'double', times: [0.05, 0.1, 0.2, 0.4] },
    { cv: 0.0034, drainage: 'double', times: [2, 8, 20, 60] },
  ];
  for (const c of cases) {
    const input = validInput({
      drainage: c.drainage,
      observations: makeObservations(c.cv, c.times, { drainage: c.drainage }),
    });
    const result = invertConsolidationCoefficient(input);
    assert.ok(result.converged, `${JSON.stringify(c)} 未收敛`);
    assert.ok(Math.abs(result.cv - c.cv) / c.cv < 1e-7,
      `${JSON.stringify(c)} 反算得 ${result.cv}`);
  }
});

// —— D2. 搜索得到的 Cv 即正向意义下的最小二乘最优：邻域扰动不更优 ——
test('反算结果是局部最小二乘最优：±邻域扰动不会得到更小 SSE', () => {
  const observations = makeObservations(CV_TRUE, [0.25, 0.5, 1, 2, 4, 8]);
  const result = invertConsolidationCoefficient({ ...site, observations });
  const sseAt = (cv) => observations.reduce((a, o) => {
    const d = forwardSettlement(cv, o.t) - o.settlement;
    return a + d * d;
  }, 0);
  for (const factor of [0.5, 0.9, 0.99, 1.01, 1.1, 2]) {
    assert.ok(sseAt(result.cv) <= sseAt(result.cv * factor) + 1e-20,
      `factor=${factor} 处 SSE 更小，搜索未定位到最优`);
  }
});

// —— E1. 观测时间含零或负 → 结构化校验拒绝 ——
test('观测时间含零或负值：VALIDATION_ERROR 结构化拒绝', () => {
  for (const badT of [0, -1, -0.001]) {
    const { errors, value } = validateInverseInput(validInput({
      observations: [{ t: 1, settlement: 0.1 }, { t: badT, settlement: 0.2 }],
    }));
    assert.equal(value, null);
    assert.ok(errors.some((e) => e.field === 'observations[1].t' && /正/.test(e.message)),
      `t=${badT} 应被明确拒绝`);
  }
});

// —— E2. 累计沉降含负 → 结构化校验拒绝 ——
test('累计沉降含负值：VALIDATION_ERROR 结构化拒绝', () => {
  const { errors, value } = validateInverseInput(validInput({
    observations: [{ t: 1, settlement: 0.1 }, { t: 2, settlement: -0.0001 }],
  }));
  assert.equal(value, null);
  assert.ok(errors.some((e) => e.field === 'observations[1].settlement'));
});

// —— E3. 目标沉降超过物理最终沉降 → 可行性拒绝，不硬凑 ——
test('目标沉降超过 S∞：结构化拒绝，且不返回任何 Cv', () => {
  const observations = [
    { t: 1, settlement: 0.1 },
    { t: 2, settlement: S_INF * 1.02 }, // 超出物理上限
  ];
  const gate = checkFeasibility(observations, S_INF);
  assert.equal(gate.feasible, false);
  assert.equal(gate.code, 'INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT');
  assert.deepEqual(gate.offenders, [1]);

  const result = invertConsolidationCoefficient({ ...site, observations });
  assert.equal(result.feasible, false);
  assert.equal(result.converged, false);
  assert.equal(result.cv, undefined, '不可行时绝不能返回硬凑的 Cv');
  assert.ok(result.message.includes('最终沉降'));
  assert.equal(result.offenders[0].index, 1);
});

// —— E4. 目标沉降恰好等于 S∞（要求 Cv→∞）同样拒绝 ——
test('目标沉降恰好达到 S∞：明确告知需要 Cv→∞，结构化拒绝', () => {
  const observations = [{ t: 1, settlement: 0.2 }, { t: 2, settlement: S_INF }];
  const result = invertConsolidationCoefficient({ ...site, observations });
  assert.equal(result.feasible, false);
  assert.equal(result.code, 'INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT');
  assert.equal(result.cv, undefined);
});

// —— E5. 全零沉降 → Cv 不可辨识，结构化拒绝 ——
test('全部观测沉降为零：固结系数不可辨识，结构化拒绝', () => {
  const observations = [{ t: 1, settlement: 0 }, { t: 2, settlement: 0 }];
  const gate = checkFeasibility(observations, S_INF);
  assert.equal(gate.feasible, false);
  assert.equal(gate.code, 'INFEASIBLE_ALL_ZERO_SETTLEMENT');
  const result = invertConsolidationCoefficient({ ...site, observations });
  assert.equal(result.feasible, false);
  assert.equal(result.cv, undefined);
  assert.ok(/不可辨识/.test(result.message));
});

// —— E6. 零沉降与正常点混排：可行，且不把零沉降误判为脏数据 ——
test('零沉降观测点与正常点混排：正常反算且收敛于有限 Cv', () => {
  const observations = [
    { t: 0.002, settlement: 0 },
    ...makeObservations(CV_TRUE, [0.5, 2, 6]),
  ];
  const result = invertConsolidationCoefficient({ ...site, observations });
  assert.ok(result.feasible && result.converged);
  assert.ok(Math.abs(result.cv - CV_TRUE) / CV_TRUE < 1e-6);
});

// —— E7. 其余结构性非法输入 ——
test('观测数组缺失/为空/非数组、土性参数非法：结构化拒绝', () => {
  const badBodies = [
    {},
    { ...site, observations: [] },
    { ...site, observations: 'x' },
    { ...site, observations: [{ t: 1 }] },
    { ...site, observations: [{ settlement: 0.1 }] },
    { ...site, H: 0, observations: [{ t: 1, settlement: 0.1 }] },
    { ...site, mv: -1, observations: [{ t: 1, settlement: 0.1 }] },
    { ...site, mv: 0, observations: [{ t: 1, settlement: 0.1 }] }, // S∞=0 拒绝
    { ...site, drainage: 'triple', observations: [{ t: 1, settlement: 0.1 }] },
  ];
  for (const body of badBodies) {
    const { errors, value } = validateInverseInput(body);
    assert.ok(errors.length > 0, `body=${JSON.stringify(body)} 应被拒绝`);
    assert.equal(value, null);
  }
});

// —— F. 搜索区间/评估次数透明报告 ——
test('结果透明报告搜索区间与正向评估次数', () => {
  const result = invertConsolidationCoefficient(validInput());
  assert.ok(result.searchBracket.lower <= result.cv * (1 + 1e-12));
  assert.ok(result.searchBracket.upper >= result.cv * (1 - 1e-12));
  assert.ok(result.forwardEvaluations >= 50);
  assert.equal(result.convergedReason, null);
});
