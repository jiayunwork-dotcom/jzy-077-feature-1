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
| `src/consolidationService.js` | 编排一次完整核算 |
| `src/validation.js` | 输入校验（结构化错误） |
| `src/routes.js` / `src/app.js` / `src/server.js` | HTTP 层 |

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

## 运行与测试

```bash
npm ci
npm test          # node:test，覆盖时间因子两端极限、双面快于单面、
                  # 深度单调性、Cv↔t 等价换算、非法输入拒绝
npm start         # 默认监听 3000，可用 PORT 覆盖
```

## Docker

```bash
docker build -t terzaghi-consolidation .
docker run -p 3000:3000 terzaghi-consolidation
```
