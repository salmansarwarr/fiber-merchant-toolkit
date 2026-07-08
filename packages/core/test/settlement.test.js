'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockTransport } = require('./mockRpcTransport');
const { csvEscape, toCsv, exportCsv, reconcileWithListPayments } = require('../src/settlement');
const { SettlementStore } = require('../src/store');

const HASH_A = '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f';
const HASH_B = '0xc38040fc3bd0950a9631a51cfb52549c7ae7f9e643c12c5f34bb44c49076557e';

// ---------------------------------------------------------------------------
// csvEscape
// ---------------------------------------------------------------------------
test('csvEscape leaves plain fields untouched', () => {
  assert.equal(csvEscape('Open'), 'Open');
  assert.equal(csvEscape('12.5'), '12.5');
});

test('csvEscape quotes and escapes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('a\r\nb'), '"a\r\nb"');
});

test('csvEscape renders null/undefined as an empty field, not the literal string', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

// ---------------------------------------------------------------------------
// toCsv
// ---------------------------------------------------------------------------
test('toCsv produces a UTF-8 BOM, CRLF line endings, and the exact expected header', () => {
  const csv = toCsv([]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('\r\n'));
  assert.ok(!csv.slice(1).includes('\n\n')); // no bare LFs sneaking in
  assert.equal(csv, '\uFEFFdate,payment_hash,amount_rusd,status,receipt_id\r\n');
});

test('toCsv snapshot: renders known records into the exact expected CSV', () => {
  const csv = toCsv([
    {
      paymentHash: HASH_A,
      receiptId: 'r-1',
      amountRUSD: '12.5',
      status: 'Paid',
      createdAt: '2026-07-01T00:00:00.000Z',
      paidAt: '2026-07-01T00:05:00.000Z',
    },
    {
      paymentHash: HASH_B,
      receiptId: null,
      amountRUSD: '3',
      status: 'Open',
      createdAt: '2026-07-05T00:00:00.000Z',
    },
  ]);

  const expected =
    '\uFEFF' +
    'date,payment_hash,amount_rusd,status,receipt_id\r\n' +
    `2026-07-01T00:05:00.000Z,${HASH_A},12.5,Paid,r-1\r\n` +
    `2026-07-05T00:00:00.000Z,${HASH_B},3,Open,\r\n`;

  assert.equal(csv, expected);
});

test('toCsv uses paidAt for the date column when present, createdAt otherwise', () => {
  const csv = toCsv([
    { paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-01-01T00:00:00.000Z', paidAt: '2026-01-02T00:00:00.000Z' },
    { paymentHash: HASH_B, amountRUSD: '1', status: 'Open', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
  const lines = csv.split('\r\n');
  assert.ok(lines[1].startsWith('2026-01-02T00:00:00.000Z'));
  assert.ok(lines[2].startsWith('2026-01-03T00:00:00.000Z'));
});

test('toCsv escapes a record field containing a comma', () => {
  const csv = toCsv([
    { paymentHash: HASH_A, receiptId: 'a,b', amountRUSD: '1', status: 'Open', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.ok(csv.includes('"a,b"'));
});

// ---------------------------------------------------------------------------
// exportCsv (store + toCsv together)
// ---------------------------------------------------------------------------
test('exportCsv on an empty range returns a header-only CSV', () => {
  const store = new SettlementStore(':memory:');
  const csv = exportCsv(store, { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
  assert.equal(csv, '\uFEFFdate,payment_hash,amount_rusd,status,receipt_id\r\n');
  store.close();
});

test('exportCsv reflects only records within the requested range', () => {
  const store = new SettlementStore(':memory:');
  store.upsert({ paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-06-01T00:00:00.000Z' });
  store.upsert({ paymentHash: HASH_B, amountRUSD: '2', status: 'Paid', createdAt: '2026-08-01T00:00:00.000Z' });

  const csv = exportCsv(store, { from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' });
  assert.ok(csv.includes(HASH_A));
  assert.ok(!csv.includes(HASH_B));
  store.close();
});

// ---------------------------------------------------------------------------
// reconcileWithListPayments
// ---------------------------------------------------------------------------
test('reconcileWithListPayments splits hashes into found/missing based on real confirmed field shape', async () => {
  const rpc = createMockTransport({
    list_payments: () => ({
      payments: [
        { payment_hash: HASH_A, status: 'Success', created_at: '0x1', last_updated_at: '0x1', failed_error: null, fee: '0x0', custom_records: null },
      ],
      last_cursor: HASH_A,
    }),
  });

  const result = await reconcileWithListPayments(rpc, [HASH_A, HASH_B]);
  assert.deepEqual(result.found, [{ paymentHash: HASH_A, status: 'Success', failedError: null }]);
  assert.deepEqual(result.missing, [HASH_B]);
});

test('reconcileWithListPayments surfaces failedError for a found-but-failed payment', async () => {
  const rpc = createMockTransport({
    list_payments: () => ({
      payments: [
        {
          payment_hash: HASH_A,
          status: 'Failed',
          created_at: '0x1',
          last_updated_at: '0x1',
          failed_error: 'Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient, required amount: 1',
          fee: '0x0',
          custom_records: null,
        },
      ],
      last_cursor: HASH_A,
    }),
  });

  const result = await reconcileWithListPayments(rpc, [HASH_A]);
  assert.equal(result.found[0].status, 'Failed');
  assert.match(result.found[0].failedError, /Insufficient balance/);
});

test('reconcileWithListPayments sends list_payments with an explicit positional [params], not []', async () => {
  const seenParams = [];
  const rpc = createMockTransport({
    list_payments: (params) => {
      seenParams.push(params);
      return { payments: [], last_cursor: null };
    },
  });

  await reconcileWithListPayments(rpc, [HASH_A]);
  // createMockTransport's handler receives whatever reconcileWithListPayments
  // passed as the second argument to rpc.call — confirming it's `[{}]` (an
  // array), matching the real confirmed request shape, not a bare `{}`.
  assert.deepEqual(seenParams[0], [{}]);
});

test('reconcileWithListPayments treats an empty list_payments result as all missing', async () => {
  const rpc = createMockTransport({
    list_payments: () => ({ payments: [], last_cursor: null }),
  });

  const result = await reconcileWithListPayments(rpc, [HASH_A, HASH_B]);
  assert.deepEqual(result.found, []);
  assert.deepEqual(result.missing, [HASH_A, HASH_B]);
});