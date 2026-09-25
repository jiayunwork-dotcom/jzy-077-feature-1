'use strict';

/**
 * 物理关系钉死测试（直接测计算模块，不经过 HTTP）：
 *  1. Tv = 0：平均固结度精确为零，各深度消散比例全为零；
 *  2. Tv 足够大：平均固结度收敛到 1，消散比例整体逼近 100%；
 *  3. 同层厚、同 Cv、同时刻：双面排水平均固结度必须高于单面排水；
 *  4. 离排水面越远的点，消散比例不比近的点更快（单调性）；
 *  5. Cv 翻倍 ≡ t 翻倍：时间因子与固结度完全一致（验证 Tv 只有一处实现）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { drainagePathLength, timeFactor } = require('../src/timeFactor');
const {
  distanceFromDrainageFace,
  porePressureRatio,
  dissipationRatio,
} = require('../src/profileSeries');
const { averageConsolidation } = require('../src/consolidationDegree');
const { computeConsolidation } = require('../src/consolidationService');

const baseParams = {
  cv: 1.5,
  H: 6,
  drainage: 'single',
  u0: 100,
  mv: 0.0008,
  deltaSigma: 120,
  t: 2,
  depths: null,
  gridPoints: 41,
  maxTerms: 100000,
};

// —— 1. Tv = 0 的下极限 ——
test('Tv = 0：平均固结度精确为零，各深度消散比例全为零', () => {
  assert.equal(averageConsolidation(0), 0);

  const H = 6;
  const hdr = drainagePathLength(H, 'single');
  for (let i = 0; i <= 20; i += 1) {
    const z = (H * i) / 20;
    const s = distanceFromDrainageFace(z, H, 'single');
    assert.equal(dissipationRatio(s, hdr, 0), 0, `z=${z} 处消散比例应为 0`);
    assert.equal(porePressureRatio(s, hdr, 0), 1, `z=${z} 处孔压比应为 1`);
  }

  // 服务层同样成立（t=0 会被 HTTP 校验拒绝，这里直接驱动计算层）
  const result = computeConsolidation({ ...baseParams, t: 0 });
  assert.equal(result.timeFactor, 0);
  assert.equal(result.averageConsolidation, 0);
  assert.equal(result.settlement, 0);
  for (const p of result.profile) assert.equal(p.dissipationRatio, 0);
});

// —— 2. Tv 足够大的上极限 ——
test('Tv 足够大：平均固结度收敛到 1，消散比例整体逼近 100%', () => {
  const tv = 10;
  assert.ok(Math.abs(1 - averageConsolidation(tv)) < 1e-9);

  const H = 6;
  for (const drainage of ['single', 'double']) {
    const hdr = drainagePathLength(H, drainage);
    for (let i = 0; i <= 40; i += 1) {
      const z = (H * i) / 40;
      const s = distanceFromDrainageFace(z, H, drainage);
      const u = dissipationRatio(s, hdr, tv);
      assert.ok(u > 1 - 1e-9, `${drainage} 排水 z=${z} 处消散比例应逼近 1，实际 ${u}`);
    }
  }
});

// —— 3. 双面排水快于单面排水（多组参数） ——
test('同层厚同 Cv 同时刻：双面排水平均固结度必须高于单面排水', () => {
  const cases = [
    { cv: 0.5, H: 4, t: 1 },
    { cv: 1.5, H: 6, t: 2 },
    { cv: 2.0, H: 10, t: 5 },
    { cv: 3.0, H: 8, t: 0.5 },
    { cv: 0.1, H: 20, t: 30 },
  ];
  for (const c of cases) {
    const single = computeConsolidation({ ...baseParams, ...c, drainage: 'single' });
    const dbl = computeConsolidation({ ...baseParams, ...c, drainage: 'double' });
    // 双面排水路径长度减半、时间因子放大 4 倍
    assert.equal(dbl.drainagePathLength, single.drainagePathLength / 2);
    assert.ok(Math.abs(dbl.timeFactor - 4 * single.timeFactor) < 1e-12);
    assert.ok(
      dbl.averageConsolidation > single.averageConsolidation,
      `参数 ${JSON.stringify(c)}：双面 ${dbl.averageConsolidation} 应大于单面 ${single.averageConsolidation}`,
    );
  }
});

// —— 4. 深度单调性：离排水面越远，消散不能更快 ——
test('离排水面越远的点消散比例不比近的点快', () => {
  const H = 6;
  const n = 61;
  for (const t of [0.05, 0.5, 2, 8]) {
    // 单面排水：沿全层单调不增
    {
      const hdr = drainagePathLength(H, 'single');
      let prev = Infinity;
      for (let i = 0; i <= n; i += 1) {
        const z = (H * i) / n;
        const tv = timeFactor(baseParams.cv, t, H, 'single');
        const u = dissipationRatio(z, hdr, tv);
        assert.ok(u <= prev + 1e-12, `单面排水 t=${t} z=${z} 单调性被破坏`);
        prev = u;
      }
    }
    // 双面排水：沿上半层（到对称面）单调不增，且剖面对称
    {
      const hdr = drainagePathLength(H, 'double');
      const tv = timeFactor(baseParams.cv, t, H, 'double');
      let prev = Infinity;
      for (let i = 0; i <= n / 2; i += 1) {
        const z = (H * i) / n;
        const s = distanceFromDrainageFace(z, H, 'double');
        const u = dissipationRatio(s, hdr, tv);
        assert.ok(u <= prev + 1e-12, `双面排水 t=${t} z=${z} 上半层单调性被破坏`);
        prev = u;
      }
      for (let i = 0; i <= n; i += 1) {
        const z = (H * i) / n;
        const s1 = distanceFromDrainageFace(z, H, 'double');
        const s2 = distanceFromDrainageFace(H - z, H, 'double');
        const u1 = dissipationRatio(s1, hdr, tv);
        const u2 = dissipationRatio(s2, hdr, tv);
        assert.ok(Math.abs(u1 - u2) < 1e-12, `双面排水 t=${t} z=${z} 剖面应对称`);
      }
    }
  }
});

// —— 5. Cv 翻倍 ≡ t 翻倍：时间因子唯一实现 ——
test('Cv 翻倍与时间翻倍得到完全相同的时间因子与固结度', () => {
  for (const drainage of ['single', 'double']) {
    const a = computeConsolidation({ ...baseParams, drainage, cv: 1.5, t: 2 });
    const b = computeConsolidation({ ...baseParams, drainage, cv: 3.0, t: 2 }); // Cv 翻倍
    const c = computeConsolidation({ ...baseParams, drainage, cv: 1.5, t: 4 }); // t 翻倍

    assert.equal(a.timeFactor, timeFactor(1.5, 2, baseParams.H, drainage));
    assert.equal(b.timeFactor, c.timeFactor, 'Cv 翻倍与 t 翻倍的时间因子应严格相等');
    assert.equal(b.averageConsolidation, c.averageConsolidation);
    assert.equal(b.settlement, c.settlement);
    assert.deepEqual(
      b.profile.map((p) => p.dissipationRatio),
      c.profile.map((p) => p.dissipationRatio),
      'Cv 翻倍与 t 翻倍的深度剖面应逐点一致',
    );
  }
});
