'use strict';

/**
 * 反算路径 HTTP 层测试：
 *  - 合法请求 200：结构化反算结果（cv、拟合指标、feasible/converged、回代序列）；
 *  - 脏数据 400：VALIDATION_ERROR + 结构化明细（零/负时间、负沉降等）；
 *  - 物理不可行 422：INFEASIBLE_*，明确落在可行区间外，不返回 Cv；
 *  - 老正向接口行为不变（同进程内再对拍一次）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let baseUrl;

const siteBody = {
  H: 6,
  drainage: 'single',
  u0: 100,
  mv: 0.0008,
  deltaSigma: 120,
};
const S_INF = 0.576;

async function postInverse(body, raw = false) {
  const res = await fetch(`${baseUrl}/api/v1/consolidation/invert-cv`, {
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

// 与反算同源的合成观测：直接用正向接口造数据（排水条件需与反算一致）
async function syntheticObservations(cv, times, drainage = 'single') {
  const points = [];
  for (const t of times) {
    const { status, json } = await postForward({
      cv, ...siteBody, drainage, t, gridPoints: 2,
    });
    assert.equal(status, 200);
    points.push({ t, settlement: json.settlement });
  }
  return points;
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('合法反算请求：200 + cv/拟合指标/回代序列，且反算值回代正向高度吻合', async () => {
  const observations = await syntheticObservations(1.5, [0.25, 0.5, 1, 2, 4, 8]);
  const { status, json } = await postInverse({ ...siteBody, observations });
  assert.equal(status, 200);
  assert.equal(json.feasible, true);
  assert.equal(json.converged, true);
  assert.equal(json.convergedReason, null);
  assert.ok(Math.abs(json.cv - 1.5) / 1.5 < 1e-7, `反算 cv=${json.cv}`);
  assert.ok(Math.abs(json.finalSettlement - S_INF) < 1e-14);

  // 拟合质量指标齐全
  for (const k of ['sse', 'mse', 'rmse', 'normalizedRmsError', 'rSquared',
    'maxAbsResidual', 'maxAbsResidualRatio']) {
    assert.ok(Number.isFinite(json.fit[k]) || json.fit[k] === null, `缺少指标 ${k}`);
  }
  assert.ok(json.fit.normalizedRmsError < 1e-10);
  assert.ok(Math.abs(json.fit.rSquared - 1) < 1e-8);

  // 回代序列：字段齐全，残差落在明确区间
  assert.equal(json.observations.length, observations.length);
  for (const p of json.observations) {
    for (const k of ['t', 'observedSettlement', 'predictedSettlement', 'residual',
      'absoluteResidual', 'residualRatio', 'timeFactor', 'averageConsolidation']) {
      assert.ok(Number.isFinite(p[k]), `回代点缺少 ${k}`);
    }
    assert.ok(Math.abs(p.residual) < 1e-10 * S_INF);
    assert.ok(p.predictedSettlement >= 0 && p.predictedSettlement <= S_INF + 1e-12);
  }
  assert.ok(json.forwardEvaluations >= 50);
  // 无噪声多点根在浮点尺度重合时，根区间可能紧贴 cv，用容差判定
  assert.ok(json.searchBracket.lower <= json.cv * (1 + 1e-12));
  assert.ok(json.searchBracket.upper >= json.cv * (1 - 1e-12));
});

test('双面排水反算：路径与结果同样正确', async () => {
  const observations = await syntheticObservations(0.8, [0.2, 1, 3], 'double');
  const { status, json } = await postInverse({
    ...siteBody, drainage: 'double', observations,
  });
  assert.equal(status, 200);
  assert.ok(json.converged);
  assert.ok(Math.abs(json.cv - 0.8) / 0.8 < 1e-7);
});

test('脏数据：观测时间为零/负 → 400 VALIDATION_ERROR + 结构化明细', async () => {
  for (const badT of [0, -2]) {
    const { status, json } = await postInverse({
      ...siteBody,
      observations: [{ t: 1, settlement: 0.1 }, { t: badT, settlement: 0.2 }],
    });
    assert.equal(status, 400, `t=${badT}`);
    assert.equal(json.error.code, 'VALIDATION_ERROR');
    assert.ok(json.error.details.some((d) => d.field === 'observations[1].t'));
    assert.equal(json.cv, undefined);
  }
});

test('脏数据：累计沉降为负 → 400 VALIDATION_ERROR + 结构化明细', async () => {
  const { status, json } = await postInverse({
    ...siteBody,
    observations: [{ t: 1, settlement: 0.1 }, { t: 2, settlement: -0.5 }],
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
  assert.ok(json.error.details.some((d) => d.field === 'observations[1].settlement'));
});

test('脏数据：观测数组缺失/为空/元素畸形 → 400', async () => {
  for (const patch of [
    { observations: [] },
    { observations: null },
    {},
    { observations: [{ t: 1 }] },
    { observations: [{ settlement: 0.1 }] },
  ]) {
    const { status, json } = await postInverse({ ...siteBody, ...patch });
    assert.equal(status, 400, JSON.stringify(patch));
    assert.equal(json.error.code, 'VALIDATION_ERROR');
  }
});

test('不可行：实测沉降超过 S∞ → 422 结构化拒绝，不硬凑 Cv', async () => {
  const { status, json } = await postInverse({
    ...siteBody,
    observations: [{ t: 1, settlement: 0.2 }, { t: 2, settlement: S_INF * 1.05 }],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT');
  assert.ok(Array.isArray(json.error.details) && json.error.details.length === 1);
  assert.equal(json.error.details[0].field, 'observations[1]');
  assert.ok(Math.abs(json.finalSettlement - S_INF) < 1e-14);
  assert.equal(json.cv, undefined, '不可行时绝不能返回 Cv');
});

test('不可行：实测沉降恰好达到 S∞（Cv→∞）→ 422 结构化拒绝', async () => {
  const { status, json } = await postInverse({
    ...siteBody,
    observations: [{ t: 1, settlement: S_INF }],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT');
  assert.ok(/无穷|S∞/.test(json.error.message));
  assert.equal(json.cv, undefined);
});

test('不可辨识：全部沉降为零 → 422 结构化拒绝', async () => {
  const { status, json } = await postInverse({
    ...siteBody,
    observations: [{ t: 1, settlement: 0 }, { t: 2, settlement: 0 }],
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, 'INFEASIBLE_ALL_ZERO_SETTLEMENT');
  assert.equal(json.cv, undefined);
});

test('零沉降与正常点混排：200，Cv 正确', async () => {
  const rest = await syntheticObservations(1.5, [0.5, 2, 6]);
  const { status, json } = await postInverse({
    ...siteBody,
    observations: [{ t: 0.002, settlement: 0 }, ...rest],
  });
  assert.equal(status, 200);
  assert.equal(json.converged, true);
  assert.ok(Math.abs(json.cv - 1.5) / 1.5 < 1e-6);
});

test('非 JSON 请求体：400 INVALID_JSON（复用现有请求级错误处理）', async () => {
  const { status, json } = await postInverse('{oops', true);
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_JSON');
});

test('老正向接口输入输出与拒绝方式保持不变', async () => {
  const ok = await postForward({
    cv: 1, H: 4, drainage: 'single', u0: 100,
    mv: 0.001, deltaSigma: 100, t: 4, gridPoints: 9,
  });
  assert.equal(ok.status, 200);
  assert.ok(Math.abs(ok.json.averageConsolidation - 0.5622) < 1e-3);

  const bad = await postForward({ cv: -1, H: 4, drainage: 'single', u0: 100,
    mv: 0.001, deltaSigma: 100, t: 4 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VALIDATION_ERROR');
});
