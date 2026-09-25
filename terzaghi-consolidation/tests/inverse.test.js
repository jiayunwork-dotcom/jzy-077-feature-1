'use strict';

/**
 * 反算路径测试（直接驱动模块层）：
 *  1. 反算内部每试一个候选 cv 都走现有正向核算，且结果与正向接口逐位一致
 *     （注入替身 forward，统计调用并断言反算不触碰平行公式）；
 *  2. 回代核对：反算 cv 再走正向，在观测时刻的沉降与实测残差落在可报告区间；
 *  3. 噪声数据下仍能恢复生成用的真 cv，拟合指标结构完整；
 *  4. 物理单调性：cv 增大时同一观测时刻经正向核算得到的沉降单调不减
 *     （经 forwardEvaluator 适配器，单/双面排水多组钉死）；
 *  5. 脏数据与不可行组合的结构化拒绝：
 *     零/负时间、负沉降 → 校验拒绝；目标达到/超过 S∞、S∞=0、全零目标
 *     → 可行性拒绝，绝不返回贴上界硬凑的 cv。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeConsolidation } = require('../src/consolidationService');
const { createForwardEvaluator } = require('../src/forwardEvaluator');
const { invertCv } = require('../src/cvSearch');
const {
  invertConsolidationCoefficient,
  REJECTION,
  BACKCHECK_RELATIVE_LIMIT,
} = require('../src/inverseService');
const { validateInverseInput } = require('../src/inverseValidation');

const FIXED = {
  H: 6,
  drainage: 'single',
  mv: 0.0008,
  deltaSigma: 120,
  maxTerms: 100000,
};
const S_FINAL = 0.0008 * 120 * 6; // 0.576
const TRUE_CV = 1.5;

function forwardParams(cv, t) {
  return {
    cv,
    H: FIXED.H,
    drainage: FIXED.drainage,
    u0: 100,
    mv: FIXED.mv,
    deltaSigma: FIXED.deltaSigma,
    t,
    depths: [0],
    gridPoints: 2,
    maxTerms: FIXED.maxTerms,
  };
}

/** 用现有正向核算生成一组"现场观测"（cv = TRUE_CV）。 */
function synthObservations(cv, times, noiseSeed = null) {
  return times.map((t, i) => {
    const exact = computeConsolidation(forwardParams(cv, t)).settlement;
    if (noiseSeed === null) return { t, settlement: exact };
    // 确定性小扰动（±2% 以内），避免测试依赖随机源
    const jitter = ((((i + 1) * 37) % 100) / 100 - 0.5) * 0.04 * noiseSeed;
    return { t, settlement: Math.max(0, exact * (1 + jitter)) };
  });
}

const TIMES = [0.5, 1, 2, 4, 8];

// —— 1. 搜索只经注入的 forward 取值，且与正向服务逐位一致 ——
test('反算每评估一个候选 cv 都只调用注入的正向适配器，数值与 computeConsolidation 严丝合缝', () => {
  const base = createForwardEvaluator(FIXED);
  const observations = synthObservations(TRUE_CV, TIMES);

  const calls = []; // { cv, t, settlement, timeFactor, uAvg }
  const countingForward = {
    finalSettlement: base.finalSettlement,
    get callCount() {
      return calls.length;
    },
    evaluate(cv, obsList) {
      return obsList.map((obs) => {
        const r = base.evaluate(cv, [obs])[0];
        // 与"正向接口"逐位对拍
        const direct = computeConsolidation(forwardParams(cv, obs.t));
        assert.equal(r.settlement, direct.settlement, '适配器沉降必须与正向服务逐位一致');
        assert.equal(r.timeFactor, direct.timeFactor, '适配器时间因子必须与正向服务逐位一致');
        assert.equal(r.averageConsolidation, direct.averageConsolidation);
        calls.push({ cv, t: obs.t });
        return r;
      });
    },
  };

  const result = invertCv(countingForward, { H: FIXED.H, drainage: FIXED.drainage }, observations);

  assert.ok(calls.length > 50, `搜索应发起大量候选评估，实际 ${calls.length}`);
  // 每次调用的 t 必须来自观测序列、cv 必须为正有限数
  for (const c of calls) {
    assert.ok(TIMES.includes(c.t), '搜索只能在观测时刻评估正向模型');
    assert.ok(Number.isFinite(c.cv) && c.cv > 0);
  }
  // 每个候选 cv 都对全部观测时刻各评估一次
  const byCv = new Map();
  for (const c of calls) {
    const key = c.cv.toPrecision(15);
    if (!byCv.has(key)) byCv.set(key, new Set());
    byCv.get(key).add(c.t);
  }
  for (const [, ts] of byCv) {
    assert.equal(ts.size, TIMES.length, '每个候选 cv 必须在全部观测时刻走正向核算');
  }

  // 无噪声合成数据：必须把真 cv 找回来
  assert.ok(
    Math.abs(Math.log10(result.cv / TRUE_CV)) < 1e-6,
    `反算 cv=${result.cv} 应贴近真值 ${TRUE_CV}`,
  );
});

// —— 2. 回代核对：残差落在明确、可报告的区间 ——
test('反算 cv 回代正向：观测时刻沉降与实测残差落在可报告区间，拟合指标齐全', () => {
  const observations = synthObservations(TRUE_CV, TIMES);
  const outcome = invertConsolidationCoefficient({ ...FIXED, observations });

  assert.equal(outcome.ok, true);
  const { result } = outcome;
  assert.equal(result.feasible, true);
  assert.equal(result.converged, true);
  assert.ok(Math.abs(Math.log10(result.cv / TRUE_CV)) < 1e-6);

  assert.equal(result.finalSettlement, S_FINAL);
  assert.equal(result.residuals.length, TIMES.length);

  // 逐点回代：再独立走一遍现有正向核算，残差必须为零级（< 1e-12·S∞）
  for (let i = 0; i < TIMES.length; i += 1) {
    const direct = computeConsolidation(forwardParams(result.cv, TIMES[i]));
    assert.equal(result.residuals[i].predictedSettlement, direct.settlement,
      '回代沉降必须就是正向接口在该时刻的输出');
    assert.ok(Math.abs(result.residuals[i].residual) < 1e-12 * S_FINAL,
      `t=${TIMES[i]} 回代残差 ${result.residuals[i].residual} 超出零级区间`);
  }

  // 可报告区间判定与显式阈值
  assert.equal(result.fit.withinReportableRange, true);
  assert.equal(result.fit.backcheckRelativeLimit, BACKCHECK_RELATIVE_LIMIT);
  assert.ok(result.fit.nrmse <= BACKCHECK_RELATIVE_LIMIT);
  assert.ok(result.fit.maxAbsResidual <= S_FINAL * BACKCHECK_RELATIVE_LIMIT);
  assert.ok(result.fit.rmse >= 0);
  assert.ok(result.fit.rSquared !== null && result.fit.rSquared > 0.999999);
  assert.ok(result.forwardEvaluations > 0);
  assert.equal(result.search.method, 'log10-grid-scan+golden-section');
});

// —— 3. 噪声观测：恢复真值、指标如实反映拟合质量 ——
test('含 ±2% 噪声的观测：反算 cv 仍贴近真值，RMSE/NRMSE/R² 如实量化', () => {
  const observations = synthObservations(TRUE_CV, TIMES, 1);
  const { result } = invertConsolidationCoefficient({ ...FIXED, observations });

  assert.ok(
    Math.abs(Math.log10(result.cv / TRUE_CV)) < 0.05,
    `噪声下 cv=${result.cv} 偏离真值过多`,
  );
  assert.ok(result.fit.rmse > 0, '有噪声时 RMSE 应为正');
  assert.ok(result.fit.nrmse > 0 && result.fit.nrmse < 0.05);
  assert.ok(result.fit.rSquared > 0.99);
  assert.equal(result.fit.observationCount, TIMES.length);
  // 回代序列与结果内回代明细一致
  for (let i = 0; i < TIMES.length; i += 1) {
    assert.equal(result.residuals[i].observedSettlement, observations[i].settlement);
    const direct = computeConsolidation(forwardParams(result.cv, TIMES[i])).settlement;
    assert.ok(Math.abs(result.residuals[i].predictedSettlement - direct) < 1e-15);
  }
});

// —— 4. 物理单调性：cv↑ ⇒ 同一观测时刻 S 单调不减（钉死） ——
test('固结系数增大时，同一观测时刻经正向核算的沉降单调不减', () => {
  const cvSeq = [];
  for (let k = -3; k <= 6; k += 1) cvSeq.push(10 ** (k / 2)); // 0.003…1000

  for (const drainage of ['single', 'double']) {
    const fwd = createForwardEvaluator({ ...FIXED, drainage });
    for (const t of [0.05, 0.5, 2, 10, 100]) {
      let prev = -Infinity;
      for (const cv of cvSeq) {
        const [e] = fwd.evaluate(cv, [{ t }]);
        // 同一时刻：时间因子与平均固结度也随 cv 单调不减
        assert.ok(e.settlement >= prev - 1e-15,
          `${drainage} t=${t}：cv=${cv} 沉降 ${e.settlement} 小于前值 ${prev}，单调性被破坏`);
        assert.ok(e.averageConsolidation >= 0 && e.averageConsolidation <= 1);
        prev = e.settlement;
      }
      // 端点常识：最小 cv 时沉降应很小，最大 cv 时逼近 S∞
      const lo = fwd.evaluate(cvSeq[0], [{ t }])[0].settlement;
      const hi = fwd.evaluate(cvSeq[cvSeq.length - 1], [{ t }])[0].settlement;
      assert.ok(lo < hi, `${drainage} t=${t}：搜索跨度两端沉降应严格拉开`);
      assert.ok(hi <= S_FINAL + 1e-15);
    }
  }
});

// —— 5a. 结构脏数据：零/负时间、负沉降 → 400 级结构化拒绝 ——
test('脏数据：观测时间含零或负、累计沉降含负，被结构化校验拒绝', () => {
  const dirty = [
    ['t 为零', { t: 0, settlement: 0.1 }],
    ['t 为负', { t: -1, settlement: 0.1 }],
    ['t 非数值', { t: '3月', settlement: 0.1 }],
    ['settlement 为负', { t: 1, settlement: -0.02 }],
    ['settlement 非数值', { t: 1, settlement: '一公分' }],
    ['观测点不是对象', 'x'],
  ];
  for (const [label, badObs] of dirty) {
    const body = { ...FIXED, observations: [synthObservations(TRUE_CV, [1])[0], badObs] };
    const { errors, value } = validateInverseInput(body);
    assert.equal(value, null, `${label} 不应产出归一化值`);
    assert.ok(errors.length > 0, `${label} 必须给出结构化错误`);
    assert.ok(errors.some((e) => e.field.startsWith('observations[')), `${label} 错误字段应定位到观测点`);
  }

  // observations 本身缺失/为空/非数组
  for (const bad of [undefined, [], 'obs', null]) {
    const { errors, value } = validateInverseInput({ ...FIXED, observations: bad });
    assert.equal(value, null);
    assert.ok(errors.some((e) => e.field === 'observations'));
  }

  // 固定参数非法同样拒绝
  assert.ok(validateInverseInput({ ...FIXED, H: 0, observations: [{ t: 1, settlement: 0.1 }] }).errors.length > 0);
  assert.ok(validateInverseInput({ ...FIXED, drainage: 'both', observations: [{ t: 1, settlement: 0.1 }] }).errors.length > 0);
  assert.ok(validateInverseInput({ ...FIXED, mv: -1, observations: [{ t: 1, settlement: 0.1 }] }).errors.length > 0);
});

// —— 5b. 物理不可行：目标达到/超过 S∞ → 拒绝，绝不贴上界硬凑 ——
test('不可行：任一目标沉降达到或超过最终沉降 S∞ 时结构化拒绝且不返回 cv', () => {
  // 恰好等于 S∞
  const outcomeEq = invertConsolidationCoefficient({
    ...FIXED,
    observations: [{ t: 1, settlement: S_FINAL }],
  });
  assert.equal(outcomeEq.ok, false);
  assert.equal(outcomeEq.rejection.code, REJECTION.TARGET_EXCEEDS_FINAL);
  assert.equal(outcomeEq.rejection.feasible, false);
  assert.ok(outcomeEq.rejection.details[0].requiredConsolidationDegree >= 1);
  assert.equal(outcomeEq.rejection.details[0].cv, undefined);

  // 超过 S∞
  const over = invertConsolidationCoefficient({
    ...FIXED,
    observations: [
      synthObservations(TRUE_CV, [1, 2])[0],
      synthObservations(TRUE_CV, [1, 2])[1],
      { t: 3, settlement: S_FINAL * 1.05 },
    ],
  });
  assert.equal(over.ok, false);
  assert.equal(over.rejection.code, REJECTION.TARGET_EXCEEDS_FINAL);
  assert.equal(over.rejection.details.length, 1);
  assert.equal(over.rejection.details[0].index, 2);

  // 贴上界容差带内（U→1 需要 cv→∞）同样拒绝，而不是返回一个贴着上界的 cv
  const near = invertConsolidationCoefficient({
    ...FIXED,
    observations: [{ t: 50, settlement: S_FINAL * (1 - 1e-12) }],
  });
  assert.equal(near.ok, false);
  assert.equal(near.rejection.code, REJECTION.TARGET_EXCEEDS_FINAL);
});

// —— 5c. S∞ = 0 的物理退化 ——
test('不可行：mv 或 Δσ 为零导致 S∞=0 时，正观测拒绝、全零观测判不可辨识', () => {
  const positive = invertConsolidationCoefficient({
    ...FIXED, mv: 0,
    observations: [{ t: 1, settlement: 0.01 }],
  });
  assert.equal(positive.ok, false);
  assert.equal(positive.rejection.code, REJECTION.ZERO_FINAL_WITH_POSITIVE);
  assert.equal(positive.rejection.finalSettlement, 0);

  const allZero = invertConsolidationCoefficient({
    ...FIXED, deltaSigma: 0,
    observations: [{ t: 1, settlement: 0 }, { t: 2, settlement: 0 }],
  });
  assert.equal(allZero.ok, false);
  assert.equal(allZero.rejection.code, REJECTION.UNIDENTIFIABLE_ALL_ZERO);
});

test('不可辨识：S∞>0 但全部观测沉降为零 → 结构化拒绝而非返回 cv=0', () => {
  const outcome = invertConsolidationCoefficient({
    ...FIXED,
    observations: [{ t: 1, settlement: 0 }, { t: 2, settlement: 0 }],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rejection.code, REJECTION.UNIDENTIFIABLE_ALL_ZERO);
  assert.equal(outcome.rejection.finalSettlement, S_FINAL);
});

// —— 6. 双面排水反算与正向同源 ——
test('双面排水：反算 cv 与正向核算同源，回代残差为零级', () => {
  const fixed = { ...FIXED, drainage: 'double' };
  const dblTimes = [0.5, 1, 2, 4];
  const dbl = dblTimes.map((t) => ({
    t,
    settlement: computeConsolidation({ ...forwardParams(2.2, t), drainage: 'double' }).settlement,
  }));

  const { result } = invertConsolidationCoefficient({ ...fixed, observations: dbl });
  assert.ok(Math.abs(Math.log10(result.cv / 2.2)) < 1e-6,
    `双面排水反算 cv=${result.cv} 应贴近 2.2`);
  assert.equal(result.finalSettlement, S_FINAL); // S∞ 与排水条件无关
  for (const r of result.residuals) assert.ok(Math.abs(r.residual) < 1e-12 * S_FINAL);
});
