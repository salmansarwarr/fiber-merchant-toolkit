'use strict';

/**
 * settlement.js — Feature 3: settlement CSV export (Phase 5).
 *
 * The SettlementStore (store.js) is the authoritative data source — see its
 * file header for why `list_payments` isn't relied on for this. This module
 * also exports `reconcileWithListPayments`, a best-effort cross-check
 * against the real RPC, deliberately written to NOT assume any field shape
 * beyond what's actually been captured (see that function's docs).
 */

const CSV_BOM = '\uFEFF';
const CSV_HEADER = ['date', 'payment_hash', 'amount_rusd', 'status', 'receipt_id'];

/**
 * Escapes a single CSV field per RFC 4180: wraps in double quotes if it
 * contains a comma, double quote, or newline, doubling any internal quotes.
 * `null`/`undefined` become an empty field, not the string "null"/"undefined".
 */
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/["\r\n,]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Renders settlement records as a CSV string: UTF-8 BOM prefix, CRLF line
 * endings, RFC 4180 quoting — all required specifically for Excel
 * compatibility, per plan Section 8.
 *
 * The `date` column uses `paidAt` when present (the actual settlement
 * date), falling back to `createdAt` for records that aren't paid yet —
 * a design decision not spelled out in the plan's one-line schema note,
 * documented here since it affects what the column actually means.
 *
 * @param {Array<{paymentHash: string, receiptId?: string, amountRUSD: string, status: string, createdAt: string, paidAt?: string}>} records
 * @returns {string}
 */
function toCsv(records = []) {
  const lines = [CSV_HEADER.join(',')];

  for (const record of records) {
    const date = record.paidAt || record.createdAt;
    lines.push(
      [
        csvEscape(date),
        csvEscape(record.paymentHash),
        csvEscape(record.amountRUSD),
        csvEscape(record.status),
        csvEscape(record.receiptId),
      ].join(',')
    );
  }

  // Trailing CRLF after the last row (including the header-only case) is
  // deliberate — a common CSV convention, and harmless either way.
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * Queries the store for a date range and renders CSV — the two steps
 * described in plan Section 8 as a single convenience function.
 *
 * @param {import('./store').SettlementStore} store
 * @param {{from: string, to: string}} range - ISO 8601 date strings, inclusive
 * @returns {string} CSV
 */
function exportCsv(store, range) {
  const records = store.listByDateRange(range);
  return toCsv(records);
}

/**
 * Best-effort cross-check of known payment hashes against a real
 * `list_payments` call.
 *
 * IMPORTANT SCOPE NOTE, confirmed against a real populated response
 * (2026-07-08, see the Phase 5 addendum in docs/rpc-samples.md):
 * `list_payments` tracks payments THIS NODE HAS SENT via `send_payment` —
 * it is the sender's own payment-attempt history (including failed
 * attempts, with a `failed_error` message), NOT a list of invoices this
 * node has received or been paid for. For a merchant using this toolkit to
 * RECEIVE RUSD payments, this means `list_payments` on the merchant's own
 * node will generally NOT contain the merchant's received invoices — those
 * were paid by whoever sent them, and would show up in *that* node's
 * `list_payments`, not this one's. This function is therefore most useful
 * either (a) as a general diagnostic/debugging cross-check when you also
 * control the paying side, or (b) if the merchant's own node also
 * originates outbound payments for some other reason — not as a routine
 * part of a merchant's own settlement reconciliation. This is also why the
 * local SQLite ledger (store.js), not `list_payments`, is this project's
 * authoritative settlement data source (see Section 8's design decision).
 *
 * Confirmed response shape: `result.payments` is an array of
 * `{payment_hash, status, created_at, last_updated_at, failed_error, fee,
 * custom_records}` — this is the same `PaymentStatus` shape `get_payment`
 * returns (Phase 4 addendum), not `CkbInvoiceStatus`. `status` values seen
 * so far: `"Failed"` (with a populated `failed_error` string) and `"Success"`
 * (from Phase 4's `get_payment` sample) — `"Created"`/`"Inflight"` are
 * documented upstream but not yet observed here.
 *
 * `list_payments` requires exactly one positional struct argument even when
 * empty (`[{}]`) — see the Phase 5 addendum in docs/rpc-samples.md; this was
 * confirmed the hard way via a real `-32602 "No more params"` error.
 *
 * @param {{call: Function}} rpc
 * @param {string[]} paymentHashes
 * @param {object} [opts]
 * @param {object} [opts.params] - passed through to list_payments as-is;
 *   defaults to {} (no pagination filters — request shape for cursor/limit
 *   is still unconfirmed, see plan Section 5)
 * @returns {Promise<{found: Array<{paymentHash: string, status: string, failedError: string|null}>, missing: string[]}>}
 */
async function reconcileWithListPayments(rpc, paymentHashes, opts = {}) {
  const { params = {} } = opts;
  // list_payments requires exactly one positional struct argument, even an
  // empty one — confirmed against a real node on 2026-07-08: calling with no
  // params at all (which rpcClient.js's default heuristic turns into an
  // empty positional array `[]`) fails with `-32602 "No more params"`. So
  // this wraps explicitly in an array rather than relying on that heuristic,
  // which is correct for zero-argument methods like node_info but wrong here.
  const result = await rpc.call('list_payments', [params]);
  const payments = (result && result.payments) || [];

  const byHash = new Map(payments.map((p) => [p.payment_hash, p]));

  const found = [];
  const missing = [];
  for (const hash of paymentHashes) {
    const match = byHash.get(hash);
    if (match) {
      found.push({ paymentHash: hash, status: match.status, failedError: match.failed_error ?? null });
    } else {
      missing.push(hash);
    }
  }
  return { found, missing };
}

module.exports = {
  csvEscape,
  toCsv,
  exportCsv,
  reconcileWithListPayments,
};
