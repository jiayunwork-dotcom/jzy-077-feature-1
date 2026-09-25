# terzaghi-consolidation

太沙基一维固结核算服务（Node.js 20 + Express）。输入固结系数、层厚、排水条件、
初始超静孔压、体积压缩系数与附加应力，输出指定时刻的孔压消散剖面、平均固结度与沉降。

## 理论约定

- 初始超静孔压沿深度均匀分布；
- 排水路径长度（唯一定义于 `src/timeFactor.js`）：
  - 单面排水 `single`：H_dr = H（顶面排水、底面不透水）
  - 双面排水 `double`：H_dr = H / 2（上下排水，对称半层）
- 时间因子 `Tv = Cv · t / H_dr²`（同样只在 `src/timeFactor.js` 定义）；
- 深度剖面（s 为距排水面距离，M = (2m+1)π/2）：

  `u/u0 = Σ (2/M)·sin(M·s/H_dr)·exp(−M²·Tv)`，消散比例 `U(s) = 1 − u/u0`
- 平均固结度：`U_avg = 1 − Σ (2/M²)·exp(−M²·Tv)`（与剖面共用同一个 Tv）；
- 沉降：`S∞ = mv·Δσ·H`，`S(t) = U_avg·S∞`，沉降比例 `S(t)/S∞ = U_avg`；
- 级数按包络 `(2/M)·exp(−M²Tv) < 1e-13` 自适应截断，默认上限 100000 项，
  避免小时间因子处截断过早。

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/timeFactor.js` | 排水路径长度与时间因子换算（全服务唯一出处） |
| `src/profileSeries.js` | 深度剖面孔压级数解 |
| `src/consolidationDegree.js` | 平均固结度级数解与沉降 |
| `src/consolidationService.js` | 编排一次完整正向核算 |
| `src/validation.js` | 正向输入校验（结构化错误） |
| `src/forwardEvaluator.js` | 反算访问正向模型的唯一适配器（逐观测时刻调 `computeConsolidation`） |
| `src/cvSearch.js` | 手写固结系数搜索（对数粗扫 + 黄金分割，不含任何物理公式） |
| `src/inverseService.js` | 反算编排：可行性拦截、搜索、回代核对、拟合指标 |
| `src/inverseValidation.js` | 反算输入校验（与正向校验互相独立） |
| `src/routes.js` / `src/inverseRoutes.js` / `src/app.js` / `src/server.js` | HTTP 层，正/反路径各走各的模块 |

## API

`POST /api/v1/consolidation`，Content-Type: application/json

```json
{
  "cv": 1.5,            // 固结系数（与 t 单位自洽，如 m²/年）
  "H": 6,               // 层厚
  "drainage": "single", // "single" | "double"
  "u0": 100,            // 初始超静孔压（均匀分布）
  "mv": 0.0008,         // 体积压缩系数
  "deltaSigma": 120,    // 附加应力
  "t": 2,               // 时刻
  "gridPoints": 21,     // 可选，等距深度网格点数（默认 21）
  "depths": [0, 3, 6],  // 可选，显式深度网格（优先于 gridPoints）
  "maxTerms": 100000    // 可选，级数项数上限
}
```

响应（节选）：

```json
{
  "drainagePathLength": 6,
  "timeFactor": 0.0833,
  "averageConsolidation": 0.3254,
  "finalSettlement": 0.576,
  "settlement": 0.1874,
  "settlementRatio": 0.3254,
  "profile": [
    { "depth": 0, "distanceFromDrainageFace": 0, "porePressureRatio": 0,
      "dissipationRatio": 1, "excessPorePressure": 0 }
  ]
}
```

校验失败返回 `400`：

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "输入参数校验失败",
  "details": [ { "field": "cv", "message": "固结系数 cv 必须为正数（收到 0）" } ] } }
```

校验规则：`cv`、`H`、`t`、`u0` 必须为正；`mv`、`deltaSigma` 不允许为负；
`drainage` 仅接受 `single`/`double`。

## 反算 API：由现场沉降观测反推固结系数

`POST /api/v1/inverse/cv`，Content-Type: application/json

```json
{
  "H": 6,
  "drainage": "single",
  "mv": 0.0008,
  "deltaSigma": 120,
  "observations": [
    { "t": 0.5, "settlement": 0.064 },
    { "t": 2,   "settlement": 0.187 },
    { "t": 8,   "settlement": 0.452 }
  ],
  "maxTerms": 100000
}
```

反算不另写任何固结公式：每评估一个候选 cv，都通过 `forwardEvaluator`
逐个观测时刻调用与 `POST /consolidation` 完全相同的
`computeConsolidation`，取其时间因子、平均固结度与沉降，最小化
`SSE = Σ (S_fwd(cv, t_i) − s_i)²`。搜索利用"cv↑ ⇒ 同时刻 S 单调不减"
的物理单调性：先在 log₁₀(cv) 上以 0.1 个数量级为步长向两侧单调粗扫，
直到高端全部过预测、低端全部欠预测夹住谷底，再在胜出格两侧用黄金分割
细化到 log₁₀(cv) 公差 1e-11（见 `src/cvSearch.js`）。

响应 `200`：

```json
{
  "feasible": true,
  "converged": true,
  "cv": 1.5000000000001,
  "log10Cv": 0.17609...,
  "finalSettlement": 0.576,
  "fit": {
    "observationCount": 3,
    "rmse": 1.2e-13,
    "maxAbsResidual": 1.7e-13,
    "meanAbsResidual": 1.1e-13,
    "nrmse": 2.1e-13,
    "rSquared": 1.0,
    "withinReportableRange": true,
    "backcheckRelativeLimit": 1e-7
  },
  "residuals": [
    { "index": 0, "t": 0.5, "observedSettlement": 0.064,
      "predictedSettlement": 0.064, "residual": -3e-17,
      "timeFactor": 0.0208, "averageConsolidation": 0.1111 }
  ],
  "search": { "method": "log10-grid-scan+golden-section",
    "gridStepDecades": 0.1, "goldenIterations": 50,
    "goldenConverged": true },
  "forwardEvaluations": 300,
  "parameters": { "H": 6, "drainage": "single", "mv": 0.0008,
    "deltaSigma": 120, "observationCount": 3, "maxTerms": 100000 }
}
```

- 拟合质量看 `fit`：`rmse`（沉降量纲）、`nrmse = RMSE / S∞`（无量纲）、
  `maxAbsResidual`、`rSquared`（观测无方差时为 `null`）；
- 回代核对：结果中的 `cv` 被独立再走一遍正向，在观测时刻重算沉降，
  `residuals[]` 逐点给出实测/预测/残差及该时刻 Tv、U_avg；
  当 `nrmse` 与最大相对残差均 ≤ 1e-7 时 `withinReportableRange = true`；
- 注意：观测与模型形状不自洽（如真实加载比记录晚、多阶段加载）时，
  搜索仍会返回 SSE 最小的 cv，但 `fit` 会如实显示拟合很差——以指标为准。

### 结构化拒绝

| 情形 | 状态码 | error.code / reason |
| --- | --- | --- |
| 观测时间 t 为零/负或非数值、沉降为负、序列为空等结构问题 | 400 | `VALIDATION_ERROR` |
| 任一观测沉降达到或超过最终沉降 S∞（需 cv→∞，贴上界 1e-9 容差带同拒） | 422 | `INFEASIBLE_OBSERVATIONS` / `TARGET_EXCEEDS_FINAL_SETTLEMENT` |
| mv 或 Δσ 为零使 S∞ = 0，却存在正沉降观测 | 422 | `INFEASIBLE_OBSERVATIONS` / `ZERO_FINAL_SETTLEMENT_WITH_POSITIVE_OBSERVATIONS` |
| 全部观测沉降为零（任意 cv 都零残差，不可辨识） | 422 | `INFEASIBLE_OBSERVATIONS` / `UNIDENTIFIABLE_ALL_ZERO_OBSERVATIONS` |

不可行/不可辨识时响应体不含 `cv`，并在 `error.details` 中列出肇事观测点
（含所需平均固结度 `settlement / S∞`），绝不返回贴着上界硬凑的固结系数。

## 运行与测试

```bash
npm ci
npm test          # node:test：正向覆盖时间因子两端极限、双面快于单面、
                  # 深度单调性、Cv↔t 等价换算、非法输入拒绝；
                  # 反算覆盖候选 cv 全部经现有正向核算且逐位一致、
                  # 回代残差落可报告区间、cv↑沉降单调不减、
                  # 脏数据/超最终沉降/不可辨识三类结构化拒绝
npm start         # 默认监听 3000，可用 PORT 覆盖
```

## Docker

```bash
docker build -t terzaghi-consolidation .
docker run -p 3000:3000 terzaghi-consolidation
```
