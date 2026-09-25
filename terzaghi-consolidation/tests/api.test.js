'use strict';

/**
 * HTTP 层测试：
 *  - 合法请求返回结构完整的核算结果，并与太沙基经典数表对拍；
 *  - 各类非法输入一律 400 + 结构化错误，绝不给出看似合理的数字。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let baseUrl;

const validBody = {
  cv: 1.5,
  H: 6,
  drainage: 'single',
  u0: 100,
  mv: 0.0008,
  deltaSigma: 120,
  t: 2,
  gridPoints: 13,
};

async function post(body, raw = false) {
  const res = await fetch(`${baseUrl}/api/v1/consolidation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('合法请求：返回时间因子、剖面、平均固结度与沉降，数值与经典解对拍', async () => {
  // 构造 Tv = cv·t/H² = 1.5·2/36 = 1/12，换一组整齐参数直接对拍 Tv = 0.25：
  // cv=1, H=4, t=4, single → Tv = 4/16 = 0.25，经典数表 U ≈ 0.5622
  const { status, json } = await post({
    cv: 1, H: 4, drainage: 'single', u0: 100,
    mv: 0.001, deltaSigma: 100, t: 4, gridPoints: 9,
  });
  assert.equal(status, 200);
  assert.equal(json.drainagePathLength, 4);
  assert.ok(Math.abs(json.timeFactor - 0.25) < 1e-15);
  assert.ok(Math.abs(json.averageConsolidation - 0.5622) < 1e-3,
    `Tv=0.25 时 U 应约 0.5622，实际 ${json.averageConsolidation}`);

  // 沉降：S∞ = mv·Δσ·H = 0.001·100·4 = 0.4，S(t) = U·S∞
  assert.ok(Math.abs(json.finalSettlement - 0.4) < 1e-15);
  assert.ok(Math.abs(json.settlement - json.averageConsolidation * 0.4) < 1e-12);
  assert.ok(Math.abs(json.settlementRatio - json.averageConsolidation) < 1e-12);

  // 剖面：9 个深度点，排水面 z=0 处消散比例为 1，孔压为 0
  assert.equal(json.profile.length, 9);
  assert.equal(json.profile[0].depth, 0);
  assert.ok(Math.abs(json.profile[0].dissipationRatio - 1) < 1e-12);
  assert.ok(Math.abs(json.profile[0].excessPorePressure) < 1e-9);
  // 每点字段齐全
  for (const p of json.profile) {
    for (const k of ['depth', 'porePressureRatio', 'dissipationRatio', 'excessPorePressure']) {
      assert.ok(Number.isFinite(p[k]), `剖面点缺少字段 ${k}`);
    }
  }
});

test('合法请求：depths 显式网格优先于 gridPoints，双面排水路径长度减半', async () => {
  const { status, json } = await post({ ...validBody, drainage: 'double', depths: [0, 1.5, 3, 4.5, 6] });
  assert.equal(status, 200);
  assert.equal(json.drainagePathLength, 3); // H/2
  assert.deepEqual(json.profile.map((p) => p.depth), [0, 1.5, 3, 4.5, 6]);
  // 对称性：U(1.5) = U(4.5)
  assert.ok(Math.abs(json.profile[1].dissipationRatio - json.profile[3].dissipationRatio) < 1e-12);
});

test('非法输入：cv/H/t 为零或负值、mv/Δσ 为负值，一律 400 + 结构化错误', async () => {
  const badCases = [
    ['cv 为零', { cv: 0 }],
    ['cv 为负', { cv: -2 }],
    ['H 为零', { H: 0 }],
    ['H 为负', { H: -1 }],
    ['t 为零', { t: 0 }],
    ['t 为负', { t: -3 }],
    ['u0 为零', { u0: 0 }],
    ['u0 为负', { u0: -50 }],
    ['mv 为负', { mv: -0.5 }],
    ['deltaSigma 为负', { deltaSigma: -10 }],
    ['cv 非数值', { cv: 'abc' }],
    ['缺少 cv', { cv: undefined }],
    ['排水条件非法', { drainage: 'both' }],
    ['深度超出层厚', { depths: [0, 3, 6.5] }],
    ['深度为负', { depths: [-0.1, 3] }],
    ['gridPoints 非法', { gridPoints: 1 }],
  ];
  for (const [label, patch] of badCases) {
    const body = { ...validBody };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete body[k]; else body[k] = v;
    }
    const { status, json } = await post(body);
    assert.equal(status, 400, `${label} 应返回 400`);
    assert.equal(json.error.code, 'VALIDATION_ERROR', `${label} 应返回 VALIDATION_ERROR`);
    assert.ok(Array.isArray(json.error.details) && json.error.details.length > 0,
      `${label} 应带结构化错误明细`);
    // 绝不能泄漏出看似合理的计算结果
    assert.equal(json.averageConsolidation, undefined);
    assert.equal(json.profile, undefined);
  }
});

test('非法输入：请求体不是合法 JSON 时返回结构化 400', async () => {
  const { status, json } = await post('{not json', true);
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_JSON');
});

test('mv 或 Δσ 取零属合法输入：最终沉降为零，沉降比例仍等于平均固结度', async () => {
  const { status, json } = await post({ ...validBody, mv: 0 });
  assert.equal(status, 200);
  assert.equal(json.finalSettlement, 0);
  assert.equal(json.settlement, 0);
  assert.ok(Math.abs(json.settlementRatio - json.averageConsolidation) < 1e-12);
});
