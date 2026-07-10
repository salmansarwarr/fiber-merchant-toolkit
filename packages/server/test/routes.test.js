'use strict';



const request = require('supertest');
const { createApp } = require('../src/index');

// ---------------------------------------------------------------------------
// Helper: build a minimal mock RPC transport
// ---------------------------------------------------------------------------

function makeRpc(handlers = {}) {
  return {
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      if (method in handlers) {
        const h = handlers[method];
        if (typeof h === 'function') return h(params);
        if (h instanceof Error) throw h;
        return h;
      }
      throw new Error(`Unexpected RPC call: ${method}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal mock store
// ---------------------------------------------------------------------------

function makeStore(records = {}) {
  const db = { ...records };
  return {
    upsertCalls: [],
    upsert(record) {
      this.upsertCalls.push(record);
      db[record.paymentHash] = record;
    },
    get(hash) {
      return db[hash] || null;
    },
    listByDateRange({ from, to }) {
      if (from > to) throw new RangeError('`from` must not be after `to`');
      return Object.values(db).filter((r) => r.createdAt >= from && r.createdAt <= to);
    },
    listAll() { return Object.values(db); },
  };
}

// Canonical payment hash for tests
const HASH = '0xaabbccdd' + '0'.repeat(56);
const HASH2 = '0x11223344' + '0'.repeat(56);

// ---------------------------------------------------------------------------
// POST /invoice
// ---------------------------------------------------------------------------

describe('POST /invoice', () => {
  const goodInvoiceResult = {
    invoice_address: 'fibt1testaddress',
    invoice: {
      currency: 'Fibt',
      amount: '0x2540be400',
      data: {
        timestamp: '0x19f330d64ea',
        payment_hash: HASH,
        attrs: [
          { final_htlc_minimum_expiry_delta: '0x927c00' },
          { payee_public_key: '03aaa' },
        ],
      },
    },
  };

  function makeApp(rpcOverrides = {}) {
    return createApp({
      rpc: makeRpc({ new_invoice: goodInvoiceResult, ...rpcOverrides }),
      store: makeStore(),
      currency: 'Fibt',
      rateLimitWindowMs: 60_000,
      rateLimitMax: 1000, // high limit so tests never hit it
    });
  }

  test('valid input returns 201 with invoice fields', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/invoice')
      .send({ amount: '12.5', description: 'Test payment' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      invoiceAddress: 'fibt1testaddress',
      paymentHash: HASH,
      amount: '100',
    });
    expect(res.body).toHaveProperty('expiresAt');
  });

  test('valid input without description also returns 201', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: '0.00000001' });
    expect(res.status).toBe(201);
    expect(res.body.paymentHash).toBe(HASH);
  });

  test('missing amount returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ description: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('non-string amount returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: 12.5 });
    expect(res.status).toBe(400);
  });

  test('zero amount returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/greater than zero/);
  });

  test('too many decimal places returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: '1.123456789' });
    expect(res.status).toBe(400);
  });

  test('negative amount returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: '-1' });
    expect(res.status).toBe(400);
  });

  test('description over 512 chars returns 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/invoice')
      .send({ amount: '1', description: 'x'.repeat(513) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/512/);
  });

  test('non-string description returns 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/invoice').send({ amount: '1', description: 42 });
    expect(res.status).toBe(400);
  });

  test('RPC error returns 502', async () => {
    const rpcError = Object.assign(new Error('RPC error -32000: node overloaded'), { code: -32000 });
    const app = createApp({
      rpc: makeRpc({ new_invoice: rpcError }),
      store: makeStore(),
      rateLimitWindowMs: 60_000,
      rateLimitMax: 1000,
    });
    const res = await request(app).post('/invoice').send({ amount: '5' });
    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// GET /receipt/:hash
// ---------------------------------------------------------------------------

describe('GET /receipt/:hash', () => {
  const record = {
    paymentHash: HASH,
    amountRUSD: '100',
    status: 'Open',
    createdAt: new Date().toISOString(),
  };

  test('malformed hash returns 400', async () => {
    const app = createApp({ rpc: makeRpc(), store: makeStore() });
    const res = await request(app).get('/receipt/not-a-hash');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0x-prefixed/);
  });

  test('unknown hash returns 404', async () => {
    const app = createApp({ rpc: makeRpc(), store: makeStore() });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(404);
  });

  test('known hash with Open status returns 202', async () => {
    const app = createApp({
      rpc: makeRpc({ get_invoice: { status: 'Open', invoice: { data: {} } } }),
      store: makeStore({ [HASH]: record }),
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('Open');
  });

  test('Cancelled status returns 410', async () => {
    const app = createApp({
      rpc: makeRpc({ get_invoice: { status: 'Cancelled', invoice: { data: {} } } }),
      store: makeStore({ [HASH]: record }),
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(410);
    expect(res.body.status).toBe('Cancelled');
  });

  test('Expired status returns 410', async () => {
    const app = createApp({
      rpc: makeRpc({ get_invoice: { status: 'Expired', invoice: { data: {} } } }),
      store: makeStore({ [HASH]: record }),
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(410);
  });

  test('Paid status without signing key returns 503', async () => {
    const app = createApp({
      rpc: makeRpc({ get_invoice: { status: 'Paid', invoice: { data: {} } } }),
      store: makeStore({ [HASH]: record }),
      signingKey: null,
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/signing key/i);
  });

  test('Paid status with signing key returns 200 PDF', async () => {
    // Use a real generated keypair — receipt.js needs an actual Ed25519 key.
    const crypto = require('crypto');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');

    const app = createApp({
      rpc: makeRpc({ get_invoice: { status: 'Paid', invoice: { data: {} } } }),
      store: makeStore({ [HASH]: record }),
      signingKey: privateKey,
      merchantName: 'Test Merchant',
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // Check it starts with the PDF magic bytes.
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('RPC error on get_invoice returns 502', async () => {
    const rpcErr = Object.assign(new Error('node down'), { code: -32000 });
    const app = createApp({
      rpc: makeRpc({ get_invoice: rpcErr }),
      store: makeStore({ [HASH]: record }),
    });
    const res = await request(app).get(`/receipt/${HASH}`);
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /export
// ---------------------------------------------------------------------------

describe('GET /export', () => {
  const CSV_BOM = '\uFEFF';
  const storeWith2Records = makeStore({
    [HASH]: {
      paymentHash: HASH,
      amountRUSD: '10',
      status: 'Paid',
      createdAt: '2026-07-06T00:00:00.000Z',
      paidAt: '2026-07-06T01:00:00.000Z',
    },
    [HASH2]: {
      paymentHash: HASH2,
      amountRUSD: '20',
      status: 'Open',
      createdAt: '2026-07-07T00:00:00.000Z',
    },
  });

  function makeExportApp(store = makeStore()) {
    return createApp({ rpc: makeRpc(), store });
  }

  test('missing from returns 400', async () => {
    const app = makeExportApp();
    const res = await request(app).get('/export?to=2026-07-31');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/);
  });

  test('missing to returns 400', async () => {
    const app = makeExportApp();
    const res = await request(app).get('/export?from=2026-07-01');
    expect(res.status).toBe(400);
  });

  test('invalid from returns 400', async () => {
    const app = makeExportApp();
    const res = await request(app).get('/export?from=not-a-date&to=2026-07-31');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/);
  });

  test('invalid to returns 400', async () => {
    const app = makeExportApp();
    const res = await request(app).get('/export?from=2026-07-01&to=oops');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to/);
  });

  test('inverted range returns 400', async () => {
    const app = makeExportApp();
    const res = await request(app).get('/export?from=2026-07-31&to=2026-07-01');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from.*not.*after|inverted/i);
  });

  test('valid range with no records returns 200 with header-only CSV', async () => {
    const app = makeExportApp(makeStore());
    const res = await request(app).get('/export?from=2026-01-01&to=2026-01-02');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/settlement\.csv/);
    const text = res.text;
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toContain('date,payment_hash,amount_rusd,status,receipt_id');
    // Only the header + CRLF after it
    const lines = text.slice(CSV_BOM.length).split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test('valid range returns 200 CSV with matching records', async () => {
    const app = makeExportApp(storeWith2Records);
    const res = await request(app).get('/export?from=2026-07-06&to=2026-07-07T23:59:59.999Z');
    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).toContain(HASH);
    expect(text).toContain(HASH2);
  });

  test('valid range returns only in-range records', async () => {
    const app = makeExportApp(storeWith2Records);
    // Only the July 6 record is in range
    const res = await request(app).get('/export?from=2026-07-06&to=2026-07-06T23:59:59.999Z');
    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).toContain(HASH);
    expect(text).not.toContain(HASH2);
  });
});

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  test('returns 200 with no deps injected', async () => {
    const app = createApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('returns 200 even when rpc+store are present', async () => {
    const app = createApp({ rpc: makeRpc(), store: makeStore() });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
});