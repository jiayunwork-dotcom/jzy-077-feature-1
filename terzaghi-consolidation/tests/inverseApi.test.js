'use strict';

/**
 * 反算 HTTP 层测试：POST /api/v1/inverse/cv
 *  - 合法观测返回结构化反算结果（cv、拟合指标、feasible/converged、回代明细）；
 *  - 结构脏数据 → 400 VALIDATION_ERROR；
 *  - 物理不可行/不可辨识 → 422 INFEASIBLE_OBSERVATIONS（带 reason），绝不返回 cv；
 *  - 原正向路径行为不受影响（冒烟一条）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let baseUrl;

const fixed = {
  H: 6,
  drainage: 'single',
  mv: 0.0008,
  deltaSigma: 120,
};
const S_FINAL = 0.576;

// 观测由正向接口按真 cv=1.5 生成（反算应能把它找回来）
async function syntheticBody(noise = 0) {
  const times = [0.5, 1, 2, 4];
  const observations = [];
  for (let i = 0; i < times.length; i += 1) {
    const { json } = await postForward({
      cv: 1.5, H: fixed.H, drainage: fixed.drainage, u0: 100,
      mv: fixed.mv, deltaSigma: fixed.deltaSigma, t: times[i],
    });
    const jitter = noise === 0 ? 0 : ((((i + 1) * 37) % 100) / 100 - 0.5) * 0.04 * noise;
    observations.push({ t: times[i], settlement: json.settlement * (1 + jitter) });
  }
  return { ...fixed, observations };
}

async function postInverse(body, raw = false) {
  const res = await fetch(`${baseUrl}/api/v1/inverse/cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function postForward(body) {
  const res = await fetch(`${baseUrl}/api/v1/consolidation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('合法观测：200 返回反算 cv、拟合质量指标与可行/收敛判定', async () => {
  const { status, json } = await postInverse(await syntheticBody());
  assert.equal(status, 200);
  assert.equal(json.feasible, true);
  assert.equal(json.converged, true);
  assert.ok(Number.isFinite(json.cv) && json.cv > 0);
  assert.ok(Math.abs(Math.log10(json.cv / 1.5)) < 0.05,
    `观测由 cv≈1.5 的沉降量级构造，反算得 ${json.cv}`);
  assert.ok(Math.abs(json.finalSettlement - S_FINAL) < 1e-12);

  // 拟合指标齐全
  for (const k of ['rmse', 'maxAbsResidual', 'meanAbsResidual', 'nrmse', 'rSquared']) {
    assert.ok(k === 'rSquared' || Number.isFinite(json.fit[k]), `fit.${k} 应为有限数`);
  }
  assert.equal(json.fit.withinReportableRange, true);
  assert.ok(json.fit.nrmse < 0.02, '本表观测含少量舍入，NRMSE 应很小');
  assert.equal(json.residuals.length, 4);
  assert.ok(json.forwardEvaluations > 0);
  assert.equal(json.parameters.observationCount, 4);
  assert.ok(json.search.method.includes('golden-section'));
});

test('回代明细逐点带时间因子/平均固结度，且 predicted ≤ S∞', async () => {
  const { json } = await postInverse(await syntheticBody());
  for (const r of json.residuals) {
    for (const k of ['t', 'observedSettlement', 'predictedSettlement', 'residual',
      'timeFactor', 'averageConsolidation']) {
      assert.ok(Number.isFinite(r[k]), `回代明细缺字段 ${k}`);
    }
    assert.ok(r.predictedSettlement <= S_FINAL + 1e-12);
    assert.ok(r.averageConsolidation >= 0 && r.averageConsolidation <= 1);
  }
});

test('脏数据：零/负时间、负沉降、观测序列为空 → 400 结构化错误', async () => {
  const cases = [
    ['t=0', { t: 0, settlement: 0.1 }],
    ['t<0', { t: -2, settlement: 0.1 }],
    ['沉降为负', { t: 1, settlement: -0.05 }],
  ];
  for (const [label, bad] of cases) {
    const body = await syntheticBody();
    body.observations.push(bad);
    const { status, json } = await postInverse(body);
    assert.equal(status, 400, `${label} 应 400`);
    assert.equal(json.error.code, 'VALIDATION_ERROR');
    assert.ok(json.error.details.some((d) => d.field.includes('observations')));
    assert.equal(json.cv, undefined, `${label} 不得返回 cv`);
  }

  const empty = await postInverse({ ...fixed, observations: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'VALIDATION_ERROR');

  const malformed = await postInverse('{broken', true);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error.code, 'INVALID_JSON');
});

test('不可行：目标沉降达到/超过 S∞ → 422 带 reason，不硬凑 cv', async () => {
  const body = { ...fixed, observations: [{ t: 3, settlement: S_FINAL }] };
  const { status, json } = await postInverse(body);
  assert.equal(status, 422);
  assert.equal(json.error.code, 'INFEASIBLE_OBSERVATIONS');
  assert.equal(json.error.reason, 'TARGET_EXCEEDS_FINAL_SETTLEMENT');
  assert.ok(Math.abs(json.error.finalSettlement - S_FINAL) < 1e-12);
  assert.equal(json.feasible, false);
  assert.equal(json.cv, undefined);
  assert.ok(json.error.details[0].requiredConsolidationDegree >= 1 - 1e-9);

  const over = await postInverse({
    ...fixed,
    observations: [{ t: 1, settlement: 0.1 }, { t: 2, settlement: S_FINAL + 0.01 }],
  });
  assert.equal(over.status, 422);
  assert.equal(over.json.error.reason, 'TARGET_EXCEEDS_FINAL_SETTLEMENT');
  assert.equal(over.json.error.details[0].index, 1);
});

test('退化与不可辨识：S∞=0 正观测、全零观测 → 422 对应 reason', async () => {
  const zeroFinal = await postInverse({
    ...fixed, mv: 0, observations: [{ t: 1, settlement: 0.01 }],
  });
  assert.equal(zeroFinal.status, 422);
  assert.equal(zeroFinal.json.error.reason, 'ZERO_FINAL_SETTLEMENT_WITH_POSITIVE_OBSERVATIONS');

  const allZero = await postInverse({
    ...fixed, observations: [{ t: 1, settlement: 0 }, { t: 2, settlement: 0 }],
  });
  assert.equal(allZero.status, 422);
  assert.equal(allZero.json.error.reason, 'UNIDENTIFIABLE_ALL_ZERO_OBSERVATIONS');
});

test('原正向路径不受反算路径影响：冒烟仍按原契约工作', async () => {
  const { status, json } = await postForward({
    cv: 1, H: 4, drainage: 'single', u0: 100,
    mv: 0.001, deltaSigma: 100, t: 4, gridPoints: 9,
  });
  assert.equal(status, 200);
  assert.ok(Math.abs(json.timeFactor - 0.25) < 1e-15);
  assert.ok(Math.abs(json.averageConsolidation - 0.5622) < 1e-3);
  assert.ok(Array.isArray(json.profile));

  // 正向路径仍保持原拒绝方式
  const bad = await postForward({ cv: 0, H: 4, drainage: 'single', u0: 100, mv: 1, deltaSigma: 1, t: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VALIDATION_ERROR');
});
