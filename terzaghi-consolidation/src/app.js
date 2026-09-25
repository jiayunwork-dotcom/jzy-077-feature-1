'use strict';

const express = require('express');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', routes);

  // JSON 解析失败等请求级错误 → 结构化 400
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: '请求体不是合法的 JSON',
          details: [],
        },
      });
    }
    if (err) {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: '服务内部错误', details: [] },
      });
    }
    return next();
  });

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: '接口不存在', details: [] },
    });
  });

  return app;
}

module.exports = { createApp };
