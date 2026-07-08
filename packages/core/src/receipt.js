'use strict';

/**
 * receipt.js — Feature 2: payment receipt (Phase 4).
 *
 * Three pieces, per plan Section 7:
 *   1. waitForPayment — bounded polling loop on get_invoice.
 *   2. buildReceipt / verifyReceipt — Ed25519-signed canonical JSON receipt.
 *   3. renderReceiptPdf — pdfkit rendering of an already-signed receipt
 *      package. The PDF is a *view* of the signed data; it is never itself
 *      signed or used to re-derive anything — the JSON + signature is the
 *      source of truth.
 *
 * STATUS CONFIRMATION (see plan Section 12, requirement 3 — field names must
 * trace to a captured sample): "Open" and "Paid" have both now been observed
 * against a real fnn node (docs/rpc-samples.md, Phase 3 and Phase 4
 * addenda). "Cancelled", "Expired", and the intermediate "Received" status
 * are still this plan's own assumptions (Section 7 / upstream fnn RPC docs),
 * not yet confirmed against a real node. Also note: real RUSD (UDT) payments
 * are currently blocked by an upstream fnn limitation — the real "Paid"
 * observation above came from a CKB-native invoice, used as a stand-in since
 * CkbInvoiceStatus is documented upstream as shared across all currencies.
 * See the Phase 4 addendum in docs/rpc-samples.md for the full diagnosis.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { toSmallestUnitHex } = require('./amount');
const { getInvoiceStatus } = require('./invoice');

const PAYMENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// --- waitForPayment ---------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2_000;

// PAID_STATUS confirmed against a real fnn node on 2026-07-07 (see the Phase
// 4 addendum in docs/rpc-samples.md) — observed for a native-CKB invoice,
// since RUSD payments are currently blocked by an upstream fnn/UDT-liquidity
// limitation (also documented there). CkbInvoiceStatus is shared across
// currencies per fnn's own RPC docs, so "Paid" is treated as confirmed for
// RUSD too. TERMINAL_FAILURE_STATUSES ("Cancelled"/"Expired") and the
// "Received" intermediate status remain unconfirmed against a real node.
const PAID_STATUS = 'Paid';
const TERMINAL_FAILURE_STATUSES = ['Cancelled', 'Expired'];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls get_invoice (via getInvoiceStatus) until the invoice is paid,
 * throws on a terminal failure status or on timeout. Runs as a plain bounded
 * loop — the caller decides whether to run it in a background job, a
 * long-lived request, or a test; this function has no opinion on that.
 *
 * @param {{call: Function}} rpc
 * @param {string} paymentHash - 0x-prefixed 32-byte hex string
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - default 60_000
 * @param {number} [opts.intervalMs] - default 2_000
 * @param {(ms: number) => Promise<void>} [opts.sleepFn] - injectable for tests
 * @returns {Promise<string>} resolves with the terminal status (always "Paid")
 */
async function waitForPayment(rpc, paymentHash, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, sleepFn = defaultSleep } = opts;

  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive number');
  }
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('intervalMs must be a positive number');
  }

  const start = Date.now();
  let lastStatus;

  for (;;) {
    lastStatus = await getInvoiceStatus(rpc, paymentHash);

    if (lastStatus === PAID_STATUS) {
      return lastStatus;
    }

    if (TERMINAL_FAILURE_STATUSES.includes(lastStatus)) {
      throw new Error(
        `invoice ${paymentHash} will never be paid: status is "${lastStatus}" ` +
          '(note: this status value is assumed per plan Section 7 and has not been ' +
          'confirmed against a real node — only "Open" has been observed so far)'
      );
    }

    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for payment on ${paymentHash} ` +
          `(last observed status: "${lastStatus}")`
      );
    }

    await sleepFn(intervalMs);
  }
}

// --- canonical JSON + signing ------------------------------------------------

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * whitespace. Sufficient for our flat receipt shape (strings/null only, no
 * floats), so this doesn't attempt full RFC 8785 number canonicalization.
 * Exported so tests (and anyone auditing a receipt) can reproduce exactly
 * what was signed.
 */
function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeEd25519PrivateKey(privateKey) {
  let keyObject;
  try {
    keyObject = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  } catch (err) {
    throw new TypeError(`invalid privateKey: ${err.message}`);
  }
  if (keyObject.type !== 'private' || keyObject.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('privateKey must be an Ed25519 private key');
  }
  return keyObject;
}

/**
 * Generates a fresh Ed25519 keypair. Convenience for tests/local setup —
 * production key loading (env vars, never committed) is a Phase 8 concern,
 * not this module's.
 */
function generateSigningKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

/**
 * Builds and signs a payment receipt.
 *
 * @param {object} opts
 * @param {string} opts.merchantName
 * @param {string} [opts.description]
 * @param {string} opts.amountRUSD - decimal string, validated via amount.js
 * @param {string} opts.paymentHash - 0x-prefixed 32-byte hex string
 * @param {crypto.KeyObject|string|Buffer} opts.privateKey - Ed25519 private key
 *   (a KeyObject, or anything crypto.createPrivateKey accepts, e.g. a PEM string)
 * @param {string} [opts.receiptId] - defaults to crypto.randomUUID()
 * @param {string} [opts.timestamp] - defaults to new Date().toISOString()
 * @returns {{receipt: object, signatureHex: string, publicKeyJwk: object}}
 */
function buildReceipt(opts = {}) {
  const { merchantName, description, amountRUSD, paymentHash, privateKey, receiptId, timestamp } = opts;

  if (typeof merchantName !== 'string' || merchantName.trim().length === 0) {
    throw new TypeError('merchantName must be a non-empty string');
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('description must be a string if provided');
  }
  // Reuses amount.js's own validation (throws RangeError/TypeError) rather
  // than duplicating its regex here.
  toSmallestUnitHex(amountRUSD);
  if (typeof paymentHash !== 'string' || !PAYMENT_HASH_PATTERN.test(paymentHash)) {
    throw new TypeError('paymentHash must be a 0x-prefixed 32-byte hex string');
  }

  const signingKey = normalizeEd25519PrivateKey(privateKey);

  const receipt = {
    amountRUSD,
    description: description === undefined ? null : description,
    merchantName,
    paymentHash,
    receiptId: receiptId === undefined ? crypto.randomUUID() : receiptId,
    timestamp: timestamp === undefined ? new Date().toISOString() : timestamp,
  };

  const canonicalJson = canonicalizeJson(receipt);
  const signature = crypto.sign(null, Buffer.from(canonicalJson, 'utf8'), signingKey);
  const publicKeyJwk = crypto.createPublicKey(signingKey).export({ format: 'jwk' });

  return {
    receipt,
    signatureHex: signature.toString('hex'),
    publicKeyJwk,
  };
}

/**
 * Verifies a receipt's signature. Returns false for any mismatch (tampered
 * field, wrong key, wrong signature) rather than throwing, EXCEPT for
 * malformed inputs (wrong types), which throw — a malformed input is a
 * caller bug, not "this receipt failed verification".
 *
 * @param {object} receipt - the exact object returned as `.receipt` from buildReceipt
 * @param {string} signatureHex
 * @param {object} publicKeyJwk
 * @returns {boolean}
 */
function verifyReceipt(receipt, signatureHex, publicKeyJwk) {
  if (receipt === null || typeof receipt !== 'object') {
    throw new TypeError('receipt must be an object');
  }
  if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]+$/.test(signatureHex)) {
    throw new TypeError('signatureHex must be a non-empty hex string');
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  } catch (err) {
    throw new TypeError(`invalid publicKeyJwk: ${err.message}`);
  }

  const canonicalJson = canonicalizeJson(receipt);
  return crypto.verify(null, Buffer.from(canonicalJson, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'));
}

// --- PDF rendering ------------------------------------------------------------

/**
 * Renders a signed receipt package as a PDF buffer. Pure rendering — reads
 * from the already-signed `receipt`/`signatureHex`/`publicKeyJwk`, never
 * recomputes or re-signs anything. If the PDF and the JSON+signature ever
 * disagree, the JSON+signature is what's authoritative; the PDF is just a
 * human-readable view of it.
 *
 * @param {{receipt: object, signatureHex: string, publicKeyJwk: object}} receiptPackage
 * @returns {Promise<Buffer>}
 */
function renderReceiptPdf(receiptPackage) {
  const { receipt, signatureHex, publicKeyJwk } = receiptPackage || {};
  if (!receipt || typeof signatureHex !== 'string' || !publicKeyJwk) {
    throw new TypeError('renderReceiptPdf requires { receipt, signatureHex, publicKeyJwk }');
  }

  return new Promise((resolve, reject) => {
    // compress: false is deliberate — receipts are tiny (a few KB), and an
    // uncompressed content stream means the rendered text (including the
    // payment hash and signature) is directly greppable in the raw PDF
    // bytes, which is a nice property for a document meant to be audited.
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const row = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(String(value));
    };

    doc.fontSize(18).font('Helvetica-Bold').text('Payment Receipt', { align: 'center' });
    doc.moveDown(1.5);

    row('Merchant', receipt.merchantName);
    if (receipt.description) row('Description', receipt.description);
    row('Amount (RUSD)', receipt.amountRUSD);
    row('Payment Hash', receipt.paymentHash);
    row('Receipt ID', receipt.receiptId);
    row('Timestamp', receipt.timestamp);

    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica').text('This receipt is cryptographically signed. The fields above are ' +
      'the exact signed payload; verify independently using the signature and public key below.');
    doc.moveDown(0.5);
    doc.text(`Signature (Ed25519, hex): ${signatureHex}`, { width: 495 });
    doc.moveDown(0.5);
    doc.text(`Public key (JWK): ${JSON.stringify(publicKeyJwk)}`, { width: 495 });

    doc.end();
  });
}

module.exports = {
  waitForPayment,
  canonicalizeJson,
  generateSigningKeyPair,
  buildReceipt,
  verifyReceipt,
  renderReceiptPdf,
};