'use strict';

/**
 * store.js — SQLite-backed local settlement ledger (Phase 5).
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync), added in Node 22.5.0 —
 * no native-addon dependency (avoids `better-sqlite3`-style build/portability
 * issues), consistent with this project's minimal-dependency approach in
 * Phases 2–3. Requires Node >=22.5.0; still experimental upstream as of this
 * writing (Node emits an ExperimentalWarning on first use — harmless, but
 * worth knowing about if you see it in logs).
 *
 * DESIGN DECISION (plan Section 8's option (a) vs (b)): this store is the
 * authoritative source of settlement data — not `list_payments`. Section 1's
 * correction confirmed `list_payments` exists on v0.8.1, but only its
 * *empty-result* shape has actually been captured (`{payments: [],
 * last_cursor: null}` — docs/rpc-samples.md). The field shape of a
 * *populated* result (what each payment record actually looks like) has
 * never been observed, so building this store's authority on top of an
 * unconfirmed shape would repeat the exact mistake the Phase 3 params bug
 * already taught. `list_payments` is used only as a best-effort, optional
 * reconciliation check in settlement.js — not something this store depends
 * on to function.
 */

const { DatabaseSync } = require('node:sqlite');
const { toSmallestUnitHex } = require('./amount');

const PAYMENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function assertValidPaymentHash(paymentHash) {
  if (typeof paymentHash !== 'string' || !PAYMENT_HASH_PATTERN.test(paymentHash)) {
    throw new TypeError('paymentHash must be a 0x-prefixed 32-byte hex string');
  }
}

function assertValidIsoDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO 8601 date string`);
  }
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    paymentHash: row.payment_hash,
    receiptId: row.receipt_id,
    amountRUSD: row.amount_rusd,
    status: row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

class SettlementStore {
  /**
   * @param {string} [dbPath] - defaults to an in-memory database. Pass a
   *   file path for a persistent ledger.
   */
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_hash TEXT PRIMARY KEY,
        receipt_id   TEXT,
        amount_rusd  TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        paid_at      TEXT
      )
    `);
  }

  /**
   * Inserts a new payment record, or updates an existing one (matched by
   * paymentHash) — same shape either way, so callers don't need to check
   * existence first.
   *
   * @param {object} record
   * @param {string} record.paymentHash - 0x-prefixed 32-byte hex string
   * @param {string} [record.receiptId]
   * @param {string} record.amountRUSD - decimal string, validated via amount.js
   * @param {string} record.status
   * @param {string} record.createdAt - ISO 8601 date string
   * @param {string} [record.paidAt] - ISO 8601 date string, once settled
   */
  upsert(record = {}) {
    const { paymentHash, receiptId, amountRUSD, status, createdAt, paidAt } = record;

    assertValidPaymentHash(paymentHash);
    if (receiptId !== undefined && typeof receiptId !== 'string') {
      throw new TypeError('receiptId must be a string if provided');
    }
    // Reuses amount.js's own validation rather than duplicating its regex.
    toSmallestUnitHex(amountRUSD);
    if (typeof status !== 'string' || status.trim().length === 0) {
      throw new TypeError('status must be a non-empty string');
    }
    assertValidIsoDate(createdAt, 'createdAt');
    if (paidAt !== undefined) {
      assertValidIsoDate(paidAt, 'paidAt');
    }

    const stmt = this.db.prepare(`
      INSERT INTO payments (payment_hash, receipt_id, amount_rusd, status, created_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(payment_hash) DO UPDATE SET
        receipt_id  = excluded.receipt_id,
        amount_rusd = excluded.amount_rusd,
        status      = excluded.status,
        created_at  = excluded.created_at,
        paid_at     = excluded.paid_at
    `);
    stmt.run(
      paymentHash,
      receiptId === undefined ? null : receiptId,
      amountRUSD,
      status,
      createdAt,
      paidAt === undefined ? null : paidAt
    );
  }

  /** Looks up a single record by paymentHash, or null if not found. */
  get(paymentHash) {
    assertValidPaymentHash(paymentHash);
    const stmt = this.db.prepare('SELECT * FROM payments WHERE payment_hash = ?');
    return rowToRecord(stmt.get(paymentHash));
  }

  /**
   * Lists records with `createdAt` in the inclusive range [from, to].
   * ISO 8601 date strings compare correctly as plain strings, so this is a
   * straightforward lexicographic range query.
   *
   * @param {object} opts
   * @param {string} opts.from - ISO 8601 date string (inclusive)
   * @param {string} opts.to - ISO 8601 date string (inclusive)
   */
  listByDateRange({ from, to } = {}) {
    assertValidIsoDate(from, 'from');
    assertValidIsoDate(to, 'to');
    if (from > to) {
      throw new RangeError('`from` must not be after `to`');
    }
    const stmt = this.db.prepare(
      'SELECT * FROM payments WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
    );
    return stmt.all(from, to).map(rowToRecord);
  }

  /** Returns every record — mainly for tests/debugging. */
  listAll() {
    const stmt = this.db.prepare('SELECT * FROM payments ORDER BY created_at ASC');
    return stmt.all().map(rowToRecord);
  }

  close() {
    this.db.close();
  }
}

module.exports = { SettlementStore };
