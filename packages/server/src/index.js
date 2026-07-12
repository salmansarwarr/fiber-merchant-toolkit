'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createInvoiceRouter } = require('./routes/invoice');
const { createReceiptRouter } = require('./routes/receipt');
const { createExportRouter } = require('./routes/export');
const { RpcClient } = require('./rpc/client');
const { SqliteStore } = require('./store/sqliteStore');
const dotenv = require('dotenv');
dotenv.config();

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

  // Serve the static frontend (index.html + app.js)
  const staticDir = deps.staticDir || path.join(__dirname, '..', '..', 'web');
  app.use(express.static(staticDir));

  return app;
}

function loadSigningKey() {
  const raw = process.env.RECEIPT_SIGNING_PRIVATE_KEY;
  if (!raw) return null;
  return raw.replace(/\\n/g, '\n');
}

if (require.main === module) {
  const rpc = new RpcClient({ url: process.env.FNN_RPC_URL || 'http://127.0.0.1:8227' });
  const store = new SqliteStore(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db'));
  const signingKey = loadSigningKey();

  const app = createApp({
    rpc,
    store,
    signingKey,
    merchantName: process.env.MERCHANT_NAME || 'Merchant',
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`fiber-merchant-toolkit server listening on port ${port}`);
  });
}

module.exports = { createApp };