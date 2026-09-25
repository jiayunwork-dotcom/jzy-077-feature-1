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
| `src/consolidationService.js` | 编排一次完整（正向）核算 |
| `src/validation.js` | 正向输入校验（结构化错误） |
| `src/routes.js` / `src/app.js` / `src/server.js` | HTTP 层 |
| `src/inverse/forwardEvaluator.js` | 反算唯一的正向出口：每个候选 Cv 都实调 `computeConsolidation` |
| `src/inverse/cvSearch.js` | 固结系数一维搜索（单调求根 + 对数网格 + 邻域细化，无第三方拟合库） |
| `src/inverse/inverseService.js` | 反算编排：可行性闸门 → 搜索 → 回代正向核算 → 拟合质量指标 |
| `src/inverse/inverseValidation.js` | 反算输入校验（结构化错误） |
| `src/inverse/inverseRoutes.js` | 反算 HTTP 路由（与正向路由平级、互不干扰） |

## 固结系数反算

`POST /api/v1/consolidation/invert-cv`，喂入一组现场累计沉降观测，反算最贴合的
固结系数 Cv。反算本质是在现有正向模型外套一层一维搜索：**搜索过程中评估的
每一个候选 Cv 都老老实实调用 `consolidationService.computeConsolidation`**
（经 `src/inverse/forwardEvaluator.js` 这唯一出口），不另写任何时间因子、固结度
或沉降的平行公式。同一个 Cv 喂给反算内部与正向接口，Tv、平均固结度、沉降逐位一致。

搜索利用"S 关于 Cv 单调不减"这一物理性质（由测试钉死）：

1. 对每个观测点的单调方程 S(Cv;t)=s 用对数二分精确定根，限定全局最优所在区间；
2. 根区间上按对数等距网格扫描（64 点/十倍程），谷贴端点时按十倍程自适应延展；
3. 最优网格单元内做逐次二分邻域细化（对尖锐 V 底配宽平台稳健），到机器精度尺度。

请求：

```json
{
  "H": 6,
  "drainage": "single",
  "u0": 100,
  "mv": 0.0008,
  "deltaSigma": 120,
  "observations": [
    { "t": 0.5, "settlement": 0.054 },
    { "t": 2,   "settlement": 0.188 },
    { "t": 8,   "settlement": 0.41 }
  ],
  "maxTerms": 100000
}
```

成功响应（200）：

```json
{
  "feasible": true,
  "converged": true,
  "convergedReason": null,
  "cv": 1.5,
  "finalSettlement": 0.576,
  "searchBracket": { "lower": 0.49, "upper": 2.03 },
  "forwardEvaluations": 740,
  "fit": {
    "sse": 0.0, "mse": 0.0, "rmse": 0.0,
    "normalizedRmsError": 0.0,
    "rSquared": 1.0,
    "maxAbsResidual": 0.0,
    "maxAbsResidualRatio": 0.0
  },
  "observations": [
    { "t": 0.5, "observedSettlement": 0.054, "predictedSettlement": 0.054,
      "residual": 0.0, "absoluteResidual": 0.0, "residualRatio": 0.0,
      "timeFactor": 0.0208, "averageConsolidation": 0.0937 }
  ],
  "parameters": { "H": 6, "drainage": "single", "u0": 100, "mv": 0.0008,
                  "deltaSigma": 120, "maxTerms": 100000 }
}
```

拟合质量指标：

- `rmse` / `normalizedRmsError`：残差均方根与无量纲版（RMSE / S∞），
  一眼看出本次反算可不可信；
- `maxAbsResidual` / `maxAbsResidualRatio`：最差单点偏差及其占 S∞ 比例；
- `rSquared`：决定系数（仅一个有效观测点时为 `null`，不编造）；
- `observations[].residual` 为预测−实测，回代预测量与正向接口逐位一致。

结构化拒绝（绝不硬凑一个 Cv）：

- `400 VALIDATION_ERROR`：观测时间含零/负值、累计沉降为负、观测序列缺失/畸形、
  土性参数非法（反算要求 mv、Δσ 严格为正，否则 S∞=0 无法反算）；
- `422 INFEASIBLE_TARGET_AT_OR_BEYOND_FINAL_SETTLEMENT`：存在实测沉降达到/超过
  给定参数下的最终沉降 S∞ —— 平均固结度封顶 1，目标落在物理可行区间之外；
- `422 INFEASIBLE_ALL_ZERO_SETTLEMENT`：观测沉降全为零，任意 Cv→0 都能拟合，
  Cv 不可辨识。

零沉降观测点与正常点混排是合法输入（搜索区间自动向 Cv→0 方向延展）。

## API（正向）

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

## 运行与测试

```bash
npm ci
npm test          # node:test，覆盖：
                  #  - 正向：时间因子两端极限、双面快于单面、深度单调性、
                  #    Cv↔t 等价换算、非法输入拒绝；
                  #  - 反算：每个候选 Cv 实调正向核算且逐位一致、回代残差、
                  #    Cv 增大沉降单调不减、反算精度、噪声稳健性、
                  #    脏数据/超 S∞/全零沉降的结构化拒绝、HTTP 行为
npm start         # 默认监听 3000，可用 PORT 覆盖
```

## Docker

```bash
docker build -t terzaghi-consolidation .
docker run -p 3000:3000 terzaghi-consolidation
```
