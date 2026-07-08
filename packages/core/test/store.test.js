'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettlementStore } = require('../src/store');

const HASH_A = '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f';
const HASH_B = '0xc38040fc3bd0950a9631a51cfb52549c7ae7f9e643c12c5f34bb44c49076557e';
const HASH_C = '0x9925e70f60501a4a3d37f1deefcbfd677814e306f189642d19a916d379b6aefb';

function makeStore() {
  return new SettlementStore(':memory:');
}

test('upsert then get round-trips a record', () => {
  const store = makeStore();
  store.upsert({
    paymentHash: HASH_A,
    receiptId: 'r-1',
    amountRUSD: '12.5',
    status: 'Open',
    createdAt: '2026-07-01T00:00:00.000Z',
  });

  const record = store.get(HASH_A);
  assert.deepEqual(record, {
    paymentHash: HASH_A,
    receiptId: 'r-1',
    amountRUSD: '12.5',
    status: 'Open',
    createdAt: '2026-07-01T00:00:00.000Z',
    paidAt: null,
  });
  store.close();
});

test('get returns null for an unknown paymentHash', () => {
  const store = makeStore();
  assert.equal(store.get(HASH_A), null);
  store.close();
});

test('upsert on an existing paymentHash updates the record rather than duplicating it', () => {
  const store = makeStore();
  store.upsert({
    paymentHash: HASH_A,
    amountRUSD: '1',
    status: 'Open',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  store.upsert({
    paymentHash: HASH_A,
    receiptId: 'r-1',
    amountRUSD: '1',
    status: 'Paid',
    createdAt: '2026-07-01T00:00:00.000Z',
    paidAt: '2026-07-01T00:05:00.000Z',
  });

  assert.equal(store.listAll().length, 1);
  const record = store.get(HASH_A);
  assert.equal(record.status, 'Paid');
  assert.equal(record.paidAt, '2026-07-01T00:05:00.000Z');
  store.close();
});

test('listByDateRange returns exactly the expected subset', () => {
  const store = makeStore();
  store.upsert({ paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-07-01T00:00:00.000Z' });
  store.upsert({ paymentHash: HASH_B, amountRUSD: '2', status: 'Paid', createdAt: '2026-07-05T00:00:00.000Z' });
  store.upsert({ paymentHash: HASH_C, amountRUSD: '3', status: 'Paid', createdAt: '2026-07-10T00:00:00.000Z' });

  const rows = store.listByDateRange({ from: '2026-07-02T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z' });
  assert.deepEqual(
    rows.map((r) => r.paymentHash),
    [HASH_B]
  );
  store.close();
});

test('listByDateRange range is inclusive on both ends', () => {
  const store = makeStore();
  store.upsert({ paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-07-01T00:00:00.000Z' });
  store.upsert({ paymentHash: HASH_B, amountRUSD: '2', status: 'Paid', createdAt: '2026-07-10T00:00:00.000Z' });

  const rows = store.listByDateRange({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z' });
  assert.equal(rows.length, 2);
  store.close();
});

test('listByDateRange returns an empty array for a range with no matches', () => {
  const store = makeStore();
  store.upsert({ paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-01-01T00:00:00.000Z' });

  const rows = store.listByDateRange({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' });
  assert.deepEqual(rows, []);
  store.close();
});

test('listByDateRange rejects an inverted range', () => {
  const store = makeStore();
  assert.throws(
    () => store.listByDateRange({ from: '2026-07-10T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }),
    RangeError
  );
  store.close();
});

test('upsert rejects an invalid paymentHash, amountRUSD, status, or date', () => {
  const store = makeStore();
  const base = { amountRUSD: '1', status: 'Open', createdAt: '2026-07-01T00:00:00.000Z' };

  assert.throws(() => store.upsert({ ...base, paymentHash: '0x123' }), TypeError);
  assert.throws(() => store.upsert({ ...base, paymentHash: HASH_A, amountRUSD: 'abc' }), RangeError);
  assert.throws(() => store.upsert({ ...base, paymentHash: HASH_A, status: '' }), TypeError);
  assert.throws(() => store.upsert({ ...base, paymentHash: HASH_A, createdAt: 'not-a-date' }), TypeError);
  store.close();
});

test('listAll returns records ordered by createdAt ascending', () => {
  const store = makeStore();
  store.upsert({ paymentHash: HASH_B, amountRUSD: '1', status: 'Paid', createdAt: '2026-07-05T00:00:00.000Z' });
  store.upsert({ paymentHash: HASH_A, amountRUSD: '1', status: 'Paid', createdAt: '2026-07-01T00:00:00.000Z' });

  assert.deepEqual(
    store.listAll().map((r) => r.paymentHash),
    [HASH_A, HASH_B]
  );
  store.close();
});