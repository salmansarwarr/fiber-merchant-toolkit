'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createMockTransport } = require('./mockRpcTransport');
const {
  waitForPayment,
  canonicalizeJson,
  generateSigningKeyPair,
  buildReceipt,
  verifyReceipt,
  renderReceiptPdf,
} = require('../src/receipt');

const SAMPLE_PAYMENT_HASH = '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f';

function makeReceiptOpts(overrides = {}) {
  const { privateKey } = generateSigningKeyPair();
  return {
    merchantName: 'Test Merchant',
    description: 'a widget',
    amountRUSD: '12.5',
    paymentHash: SAMPLE_PAYMENT_HASH,
    privateKey,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalizeJson
// ---------------------------------------------------------------------------
test('canonicalizeJson sorts object keys recursively and is whitespace-free', () => {
  const a = canonicalizeJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalizeJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});

test('canonicalizeJson handles arrays and null', () => {
  assert.equal(canonicalizeJson([3, 1, { b: 1, a: 2 }]), '[3,1,{"a":2,"b":1}]');
  assert.equal(canonicalizeJson(null), 'null');
});

// ---------------------------------------------------------------------------
// buildReceipt / verifyReceipt — sign/verify round trip
// ---------------------------------------------------------------------------
test('sign/verify round trip succeeds for an untampered receipt', () => {
  const { receipt, signatureHex, publicKeyJwk } = buildReceipt(makeReceiptOpts());
  assert.equal(verifyReceipt(receipt, signatureHex, publicKeyJwk), true);
});

test('buildReceipt accepts a PEM-encoded private key string, not just a KeyObject', () => {
  const { privateKey } = generateSigningKeyPair();
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const { receipt, signatureHex, publicKeyJwk } = buildReceipt(makeReceiptOpts({ privateKey: pem }));
  assert.equal(verifyReceipt(receipt, signatureHex, publicKeyJwk), true);
});

test('buildReceipt rejects a non-Ed25519 private key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => buildReceipt(makeReceiptOpts({ privateKey })), TypeError);
});

test('buildReceipt fills in receiptId and timestamp when not provided', () => {
  const { receipt } = buildReceipt(makeReceiptOpts());
  assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => new Date(receipt.timestamp).toISOString());
});

test('buildReceipt honors an explicit receiptId and timestamp', () => {
  const { receipt } = buildReceipt(
    makeReceiptOpts({ receiptId: 'fixed-id', timestamp: '2026-01-01T00:00:00.000Z' })
  );
  assert.equal(receipt.receiptId, 'fixed-id');
  assert.equal(receipt.timestamp, '2026-01-01T00:00:00.000Z');
});

test('description defaults to null, not undefined, when omitted (so canonical JSON is stable)', () => {
  const opts = makeReceiptOpts();
  delete opts.description;
  const { receipt } = buildReceipt(opts);
  assert.equal(receipt.description, null);
});

// ---------------------------------------------------------------------------
// Tamper detection — the test that proves "can't be forged"
// ---------------------------------------------------------------------------
test('verification fails if any field is altered after signing', () => {
  const { receipt, signatureHex, publicKeyJwk } = buildReceipt(makeReceiptOpts());

  for (const field of Object.keys(receipt)) {
    const tampered = { ...receipt, [field]: `${receipt[field]}-tampered` };
    assert.equal(
      verifyReceipt(tampered, signatureHex, publicKeyJwk),
      false,
      `tampering with "${field}" should invalidate the signature`
    );
  }
});

test('verification fails if a field is added or removed', () => {
  const { receipt, signatureHex, publicKeyJwk } = buildReceipt(makeReceiptOpts());

  const withExtraField = { ...receipt, extra: 'sneaky' };
  assert.equal(verifyReceipt(withExtraField, signatureHex, publicKeyJwk), false);

  const { amountRUSD, ...withoutAmount } = receipt;
  assert.equal(verifyReceipt(withoutAmount, signatureHex, publicKeyJwk), false);
});

test('verification fails against a different signature or a different public key', () => {
  const a = buildReceipt(makeReceiptOpts());
  const b = buildReceipt(makeReceiptOpts()); // different keypair

  assert.equal(verifyReceipt(a.receipt, b.signatureHex, a.publicKeyJwk), false);
  assert.equal(verifyReceipt(a.receipt, a.signatureHex, b.publicKeyJwk), false);
});

test('verifyReceipt throws (rather than returning false) for malformed inputs', () => {
  const { receipt, signatureHex, publicKeyJwk } = buildReceipt(makeReceiptOpts());
  assert.throws(() => verifyReceipt(null, signatureHex, publicKeyJwk), TypeError);
  assert.throws(() => verifyReceipt(receipt, 'not-hex!!', publicKeyJwk), TypeError);
  assert.throws(() => verifyReceipt(receipt, signatureHex, { garbage: true }), TypeError);
});

// ---------------------------------------------------------------------------
// buildReceipt — negative validation
// ---------------------------------------------------------------------------
test('rejects missing/empty merchantName', () => {
  assert.throws(() => buildReceipt(makeReceiptOpts({ merchantName: '' })), TypeError);
  assert.throws(() => buildReceipt(makeReceiptOpts({ merchantName: '   ' })), TypeError);
  assert.throws(() => buildReceipt(makeReceiptOpts({ merchantName: undefined })), TypeError);
});

test('rejects an invalid amountRUSD via amount.js validation', () => {
  assert.throws(() => buildReceipt(makeReceiptOpts({ amountRUSD: '-1' })), RangeError);
  assert.throws(() => buildReceipt(makeReceiptOpts({ amountRUSD: 'abc' })), RangeError);
});

test('rejects an invalid paymentHash', () => {
  assert.throws(() => buildReceipt(makeReceiptOpts({ paymentHash: '0x123' })), TypeError);
});

// ---------------------------------------------------------------------------
// waitForPayment
// ---------------------------------------------------------------------------
function noWaitSleep() {
  return Promise.resolve();
}

test('waitForPayment resolves once status becomes Paid', async () => {
  const statuses = ['Open', 'Open', 'Paid'];
  const rpc = createMockTransport({
    get_invoice: () => ({ status: statuses.shift() }),
  });

  const result = await waitForPayment(rpc, SAMPLE_PAYMENT_HASH, {
    timeoutMs: 10_000,
    intervalMs: 1,
    sleepFn: noWaitSleep,
  });

  assert.equal(result, 'Paid');
});

test('waitForPayment throws on a terminal failure status (Cancelled/Expired)', async () => {
  const rpc = createMockTransport({ get_invoice: () => ({ status: 'Cancelled' }) });
  await assert.rejects(
    () => waitForPayment(rpc, SAMPLE_PAYMENT_HASH, { timeoutMs: 10_000, intervalMs: 1, sleepFn: noWaitSleep }),
    /will never be paid/
  );
});

test('waitForPayment throws on timeout rather than hanging, against a hash that never pays', async () => {
  const rpc = createMockTransport({ get_invoice: () => ({ status: 'Open' }) });

  await assert.rejects(
    () => waitForPayment(rpc, SAMPLE_PAYMENT_HASH, { timeoutMs: 5, intervalMs: 1, sleepFn: noWaitSleep }),
    /timed out/
  );
});

test('waitForPayment validates timeoutMs/intervalMs before calling the RPC', async () => {
  const rpc = createMockTransport({ get_invoice: () => ({ status: 'Open' }) });

  await assert.rejects(() => waitForPayment(rpc, SAMPLE_PAYMENT_HASH, { timeoutMs: 0 }), RangeError);
  await assert.rejects(() => waitForPayment(rpc, SAMPLE_PAYMENT_HASH, { intervalMs: -1 }), RangeError);
  assert.equal(rpc.calls.length, 0);
});

// ---------------------------------------------------------------------------
// renderReceiptPdf
// ---------------------------------------------------------------------------
const { PDFParse } = require('pdf-parse');

/** Extracts plain text from a rendered PDF buffer for content assertions. */
async function extractPdfText(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

test('renderReceiptPdf produces a non-empty buffer with a valid PDF header', async () => {
  const receiptPackage = buildReceipt(makeReceiptOpts());
  const pdf = await renderReceiptPdf(receiptPackage);

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 100);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});

/** Strips whitespace so line-wrapped text (e.g. the long signature hex) still matches. */
function normalizeForSearch(s) {
  return s.replace(/\s+/g, '');
}

test('renderReceiptPdf actually renders the receipt fields into the document text', async () => {
  const receiptPackage = buildReceipt(makeReceiptOpts());
  const pdf = await renderReceiptPdf(receiptPackage);
  const text = normalizeForSearch(await extractPdfText(pdf));

  assert.match(text, /PaymentReceipt/);
  assert.ok(text.includes(normalizeForSearch(receiptPackage.receipt.merchantName)));
  assert.ok(text.includes(normalizeForSearch(receiptPackage.receipt.description)));
  assert.ok(text.includes(receiptPackage.receipt.amountRUSD));
  assert.ok(text.includes(receiptPackage.receipt.paymentHash));
  assert.ok(text.includes(receiptPackage.receipt.receiptId));
  assert.ok(text.includes(receiptPackage.signatureHex));
});

test('renderReceiptPdf omits the description line entirely when there is none', async () => {
  const opts = makeReceiptOpts();
  delete opts.description;
  const receiptPackage = buildReceipt(opts);
  const pdf = await renderReceiptPdf(receiptPackage);
  const text = await extractPdfText(pdf);

  assert.ok(!/Description:/.test(text));
});

test('renderReceiptPdf throws for a malformed receipt package', async () => {
  await assert.rejects(async () => renderReceiptPdf({}), TypeError);
  await assert.rejects(async () => renderReceiptPdf(undefined), TypeError);
});