'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function rowToRecord(row) {
  if (!row) return null;
  return {
    paymentHash: row.payment_hash,
    amountRUSD: row.amount_rusd,
    status: row.status,
    createdAt: row.created_at,
    receiptId: row.receipt_id || undefined,
    paidAt: row.paid_at || undefined,
  };
}

class SqliteStore {
  /** @param {string} dbPath - file path, or ':memory:' */
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        payment_hash TEXT PRIMARY KEY,
        amount_rusd  TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        receipt_id   TEXT,
        paid_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at);
    `);

    this._getStmt = this.db.prepare('SELECT * FROM invoices WHERE payment_hash = ?');
    this._upsertStmt = this.db.prepare(`
      INSERT INTO invoices (payment_hash, amount_rusd, status, created_at, receipt_id, paid_at)
      VALUES (@paymentHash, @amountRUSD, @status, @createdAt, @receiptId, @paidAt)
      ON CONFLICT(payment_hash) DO UPDATE SET
        amount_rusd = excluded.amount_rusd,
        status      = excluded.status,
        created_at  = excluded.created_at,
        receipt_id  = excluded.receipt_id,
        paid_at     = excluded.paid_at
    `);
    this._rangeStmt = this.db.prepare(
      'SELECT * FROM invoices WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
    );
  }

  get(paymentHash) {
    return rowToRecord(this._getStmt.get(paymentHash));
  }

  upsert(record) {
    this._upsertStmt.run({
      paymentHash: record.paymentHash,
      amountRUSD: record.amountRUSD,
      status: record.status,
      createdAt: record.createdAt,
      receiptId: record.receiptId ?? null,
      paidAt: record.paidAt ?? null,
    });
    return record;
  }

  listByDateRange({ from, to } = {}) {
    return this._rangeStmt.all(from, to).map(rowToRecord);
  }

  close() {
    this.db.close();
  }
}

module.exports = { SqliteStore };