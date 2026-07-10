'use strict';
const express = require('express');
const { createInvoiceRouter } = require('./routes/invoice');
const { createReceiptRouter } = require('./routes/receipt');
const { createExportRouter } = require('./routes/export');

/**
 * @param {{
 *   rpc: {call: Function},
 *   store: {get: Function, upsert: Function, listByDateRange: Function},
 *   currency?: string,
 *   rateLimitWindowMs?: number,
 *   rateLimitMax?: number,
 *   signingKey?: import('crypto').KeyObject|string|null,
 *   merchantName?: string,
 * }} [deps]
 */
function createApp(deps = {}) {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  if (deps.rpc && deps.store) {
    app.use('/invoice', createInvoiceRouter(deps));
    app.use('/receipt', createReceiptRouter(deps));
    app.use('/export', createExportRouter(deps));
  }

  return app;
}

if (require.main === module) {
  // TODO: construct real rpc/store/signingKey instances here before going live.
  const app = createApp(/* { rpc, store, signingKey, merchantName } */);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`fiber-merchant-toolkit server listening on port ${port}`);
  });
}

module.exports = { createApp };