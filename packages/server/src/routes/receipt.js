'use strict';

const express = require('express');
const { getInvoiceStatus } = require('@fiber-merchant-toolkit/core');
const { buildReceipt, renderReceiptPdf } = require('@fiber-merchant-toolkit/core');

const PAYMENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PAID_STATUS = 'Paid';
const TERMINAL_FAILURE_STATUSES = ['Cancelled', 'Expired'];

/**
 * @param {{
 *   rpc: {call: Function},
 *   store: {get: Function, upsert: Function},
 *   signingKey?: import('crypto').KeyObject|string|null,
 *   merchantName?: string,
 * }} deps
 */
function createReceiptRouter(deps) {
  const { rpc, store, signingKey = null, merchantName = 'Merchant' } = deps;

  const router = express.Router();

  router.get('/:hash', async (req, res) => {
    const { hash } = req.params;

    // --- validate hash format ---
    if (!PAYMENT_HASH_PATTERN.test(hash)) {
      return res.status(400).json({
        error: 'hash must be a 0x-prefixed 32-byte hex string',
      });
    }

    // --- confirm this invoice is in our ledger ---
    const record = store.get(hash);
    if (!record) {
      return res.status(404).json({ error: 'invoice not found' });
    }

    // --- poll the node for current status ---
    let status;
    try {
      status = await getInvoiceStatus(rpc, hash);
    } catch (err) {
      if (err && typeof err.code === 'number') {
        return res.status(502).json({ error: `RPC error ${err.code}: ${err.message}` });
      }
      return res.status(502).json({ error: `Upstream error: ${err.message}` });
    }

    // --- terminal failure ---
    if (TERMINAL_FAILURE_STATUSES.includes(status)) {
      // Update the ledger so subsequent calls don't re-poll unnecessarily.
      try {
        store.upsert({ ...record, status });
      } catch (_) { /* best-effort */ }
      return res.status(410).json({ status });
    }

    // --- not yet paid ---
    if (status !== PAID_STATUS) {
      return res.status(202).json({ status });
    }

    // --- paid — generate and stream the PDF ---
    if (!signingKey) {
      return res.status(503).json({
        error: 'signing key not configured — set RECEIPT_SIGNING_PRIVATE_KEY to enable PDF receipts',
      });
    }


    let pdfBuffer;
    try {
      const receiptPkg = buildReceipt({
        merchantName,
        description: record.receiptId ? undefined : undefined, // description not stored separately
        amountRUSD: record.amountRUSD,
        paymentHash: hash,
        privateKey: signingKey,
        // Use a stable receiptId if already recorded, otherwise generate one.
        receiptId: record.receiptId || undefined,
      });

      // If the store didn't have a receiptId yet, persist it now.
      if (!record.receiptId) {
        try {
          store.upsert({
            ...record,
            status: 'Paid',
            receiptId: receiptPkg.receipt.receiptId,
            paidAt: receiptPkg.receipt.timestamp,
          });
        } catch (_) { /* best-effort */ }
      }

      pdfBuffer = await renderReceiptPdf(receiptPkg);
    } catch (err) {
      return res.status(500).json({ error: `Failed to generate receipt: ${err.message}` });
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="receipt-${hash.slice(0, 10)}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    return res.status(200).send(pdfBuffer);
  });

  return router;
}

module.exports = { createReceiptRouter };