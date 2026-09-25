'use strict';

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;

createApp().listen(PORT, () => {
  console.log(`terzaghi-consolidation listening on port ${PORT}`);
});
