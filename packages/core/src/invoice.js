'use strict';

/**
 * invoice.js — Feature 1: RUSD invoice creation (Phase 3).
 *
 * Calls `new_invoice` on a real fnn node and returns a flattened, decoded
 * shape. Every field name/path here traces back to the captured samples in
 * docs/rpc-samples.md (see plan Section 1.10 and 1.4), not to README prose.
 */

const { toSmallestUnitHex, fromSmallestUnitHex } = require('./amount');

// RUSD UDT type script — Section 1.5, confirmed byte-for-byte against a live
// node's node_info.udt_cfg_infos as well as both captured new_invoice samples.
const RUSD_UDT_TYPE_SCRIPT = Object.freeze({
  code_hash: '0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a',
  hash_type: 'type',
  args: '0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b',
});

const AMOUNT_PATTERN = /^\d+(\.\d{1,8})?$/;
const ZERO_PATTERN = /^0(\.0+)?$/;

function assertValidAmount(amount) {
  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
    throw new RangeError(
      `invalid amount "${amount}": must be a decimal string with at most 8 decimal places`
    );
  }
  if (ZERO_PATTERN.test(amount)) {
    throw new RangeError(`invalid amount "${amount}": must be greater than zero`);
  }
}

/**
 * Creates an RUSD invoice via `new_invoice`.
 *
 * @param {{call: (method: string, params?: object) => Promise<any>}} rpc
 *   Anything shaped like RpcClient or mockRpcTransport's `createMockTransport(...)`.
 * @param {object} opts
 * @param {string} opts.amount - human decimal RUSD amount, e.g. "12.5"
 * @param {string} [opts.description] - forwarded to `new_invoice` if provided
 * @param {'Fibt'|'Fibb'|'Fibd'} [opts.currency] - defaults to 'Fibt' (testnet), per Section 1.4
 * @param {number} [opts.expirySeconds] - NOT YET SUPPORTED, see note below
 * @returns {Promise<{invoiceAddress: string, paymentHash: string, amount: string, amountSmallestUnit: string, expiresAt: string|null}>}
 */
async function createInvoice(rpc, opts = {}) {
  const { amount, description, currency = 'Fibt', expirySeconds } = opts;

  assertValidAmount(amount);

  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('description must be a string if provided');
  }

  if (expirySeconds !== undefined) {
    // Plan Section 6 flagged this as unconfirmed: it's not yet known whether
    // new_invoice accepts an expiry-related param at all on v0.8.1, or what
    // it would be named if so (the Phase 0 samples all used server
    // defaults). Rather than guess a field name and silently send something
    // the RPC ignores — or worse, rejects — this throws until it's been
    // confirmed against a real node and this function updated accordingly.
    throw new Error(
      'createInvoice: `expirySeconds` is not yet supported. Whether/how new_invoice ' +
        'accepts an expiry override has not been confirmed against a real fnn node ' +
        '(see plan Section 6). Omit this option; the invoice will use the node\'s ' +
        'default final_htlc_minimum_expiry_delta, reflected in the returned `expiresAt`.'
    );
  }

  const amountSmallestUnit = toSmallestUnitHex(amount);

  const params = {
    currency,
    amount: amountSmallestUnit,
    udt_type_script: RUSD_UDT_TYPE_SCRIPT,
  };
  if (description !== undefined) {
    params.description = description;
  }

  const result = await rpc.call('new_invoice', params);
  return parseInvoiceResponse(result);
}

/**
 * Flattens the real (deeply nested) new_invoice response shape into the
 * shape the rest of the app works with. Exported separately from
 * createInvoice so Phase 4 (get_invoice polling returns a similar/related
 * shape) and tests can reuse it without re-issuing an RPC call.
 *
 * @param {object} result - the raw `result` field of a new_invoice response
 */
function parseInvoiceResponse(result) {
  const invoiceAddress = result && result.invoice_address;
  const invoice = result && result.invoice;
  const data = invoice && invoice.data;
  const paymentHash = data && data.payment_hash;
  const amountSmallestUnit = invoice && invoice.amount;

  if (!invoiceAddress || !paymentHash || !amountSmallestUnit) {
    throw new Error(
      'unexpected new_invoice response shape: missing invoice_address, ' +
        'invoice.data.payment_hash, or invoice.amount — see plan Section 1.10 ' +
        'for the expected field paths, and docs/rpc-samples.md for real examples'
    );
  }

  const amount = fromSmallestUnitHex(amountSmallestUnit);
  const expiresAt = computeExpiresAt(data);

  return {
    invoiceAddress,
    paymentHash,
    amount,
    amountSmallestUnit,
    expiresAt,
  };
}

/**
 * No absolute expiry is returned by new_invoice (Section 1.10) — only a
 * creation timestamp and a relative delta, both hex, both observed to be in
 * milliseconds against the captured samples (data.timestamp of
 * "0x19f330d64ea" decodes to a 2026-07-05 date matching the capture date;
 * final_htlc_minimum_expiry_delta of "0x927c00" decodes to 9,600,000ms /
 * 160 minutes, a plausible HTLC expiry window).
 */
function computeExpiresAt(data) {
  const timestampHex = data && data.timestamp;
  const attrs = (data && data.attrs) || [];
  const deltaAttr = attrs.find(
    (attr) => attr && Object.prototype.hasOwnProperty.call(attr, 'final_htlc_minimum_expiry_delta')
  );

  if (!timestampHex || !deltaAttr) {
    return null;
  }

  const timestampMs = BigInt(timestampHex);
  const deltaMs = BigInt(deltaAttr.final_htlc_minimum_expiry_delta);
  return new Date(Number(timestampMs + deltaMs)).toISOString();
}

const PAYMENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Fetches an invoice's status via `get_invoice`.
 *
 * Field path confirmed against a real fnn v0.8.1 node on 2026-07-06 (see the
 * Phase 3 addendum in docs/rpc-samples.md): `result.status` is a top-level
 * sibling of `result.invoice`, e.g. `"status": "Open"` — not nested inside
 * `invoice` or `invoice.data`. `get_invoice` takes the same jsonrpsee
 * positional-struct convention as `new_invoice`; passing a bare hash string
 * instead of `{payment_hash: "0x..."}` fails with "expected struct
 * InvoiceParams" (also confirmed against the real node).
 *
 * @param {{call: (method: string, params?: object) => Promise<any>}} rpc
 * @param {string} paymentHash - 0x-prefixed 32-byte hex string
 * @returns {Promise<string>} the raw status string (e.g. "Open") — the full
 *   set of possible values hasn't been enumerated against a real node yet
 *   (only "Open" has been observed), so this deliberately doesn't validate
 *   or normalize against a known enum.
 */
async function getInvoiceStatus(rpc, paymentHash) {
  if (typeof paymentHash !== 'string' || !PAYMENT_HASH_PATTERN.test(paymentHash)) {
    throw new TypeError('paymentHash must be a 0x-prefixed 32-byte hex string');
  }

  const result = await rpc.call('get_invoice', { payment_hash: paymentHash });

  if (!result || typeof result.status !== 'string') {
    throw new Error(
      'unexpected get_invoice response shape: missing top-level `status` field — ' +
        'see the Phase 3 addendum in docs/rpc-samples.md for the expected shape'
    );
  }

  return result.status;
}

module.exports = {
  RUSD_UDT_TYPE_SCRIPT,
  createInvoice,
  parseInvoiceResponse,
  getInvoiceStatus,
};