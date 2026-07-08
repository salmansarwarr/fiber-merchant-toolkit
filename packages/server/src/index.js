'use strict';

const express = require('express');

// Phase 1 scaffolding only. Real routes (POST /invoice, GET /receipt/:hash,
// GET /export) land in Phase 6 (see fiber-merchant-toolkit-plan.md, Section 9).
// createApp() exists now so tests can exercise a real Express instance with
// supertest from day one, without needing a live fnn node.

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`fiber-merchant-toolkit server listening on port ${port}`);
  });
}

module.exports = { createApp };
