'use strict';

const request = require('supertest');
const crypto = require('crypto');
const { createApp } = require('../src/index');
const { RpcClient, SettlementStore } = require('@fiber-merchant-toolkit/core');

const RPC_URL = process.env.FNN_RPC_URL;
const SKIP = !RPC_URL;

(SKIP ? describe.skip : describe)('server integration (requires FNN_RPC_URL)', () => {
  let app;
  let store;
  let createdHash;

  beforeAll(() => {
    const rpc = new RpcClient({ url: RPC_URL });
    store = new SettlementStore(':memory:');
    const { privateKey } = process.env.RECEIPT_SIGNING_PRIVATE_KEY
      ? { privateKey: process.env.RECEIPT_SIGNING_PRIVATE_KEY }
      : crypto.generateKeyPairSync('ed25519');

    app = createApp({
      rpc,
      store,
      signingKey: privateKey,
      merchantName: process.env.MERCHANT_NAME || 'Integration Test Merchant',
      currency: process.env.FNN_CURRENCY || 'Fibt',
      rateLimitMax: 1000, // don't interfere with the test
    });
  });

  test('POST /invoice creates an invoice on the real node', async () => {
    const res = await request(app)
      .post('/invoice')
      .send({ amount: '1', description: 'server integration test' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invoiceAddress');
    expect(res.body).toHaveProperty('paymentHash');
    expect(res.body.paymentHash).toMatch(/^0x[0-9a-f]{64}$/);

    createdHash = res.body.paymentHash;
  });

  test('GET /receipt/:hash returns 202 (Open) for a freshly created invoice', async () => {
    // createdHash comes from the previous test — Jest runs tests in order.
    if (!createdHash) return;
    const res = await request(app).get(`/receipt/${createdHash}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('Open');
  });

  test('GET /export returns a valid CSV', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date().toISOString();
    const res = await request(app).get(`/export?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    // Should contain at least the header row.
    expect(res.text).toContain('date,payment_hash');
    if (createdHash) {
      expect(res.text).toContain(createdHash);
    }
  });
});