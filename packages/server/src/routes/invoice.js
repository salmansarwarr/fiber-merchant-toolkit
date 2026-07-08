'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createInvoice } = require('@fiber-merchant-toolkit/core');

const AMOUNT_PATTERN = /^\d+(\.\d{1,8})?$/;
const ZERO_PATTERN = /^0(\.0+)?$/;
const MAX_DESCRIPTION_LENGTH = 512;

/**
 * @param {{
 *   rpc: {call: Function},
 *   store: {upsert: Function},
 *   currency?: string,
 *   rateLimitWindowMs?: number,
 *   rateLimitMax?: number,
 * }} deps
 */
function createInvoiceRouter(deps) {
  const {
    rpc,
    store,
    currency = process.env.FNN_CURRENCY || 'Fibt',
    rateLimitWindowMs = 15 * 60 * 1000, // 15 minutes
    rateLimitMax = 20,
  } = deps;

  const router = express.Router();

  const limiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many invoice requests — please try again later.' },
  });

  router.post('/', limiter, async (req, res) => {
    const { amount, description } = req.body || {};

    // --- input validation (reject before hitting the RPC) ---
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      return res.status(400).json({
        error: 'amount must be a decimal string with at most 8 decimal places (e.g. "12.5")',
      });
    }
    if (ZERO_PATTERN.test(amount)) {
      return res.status(400).json({ error: 'amount must be greater than zero' });
    }
    if (description !== undefined && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string if provided' });
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({
        error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      });
    }

    // --- call core ---
    let invoice;
    try {
      invoice = await createInvoice(rpc, { amount, description, currency });
    } catch (err) {
      // RpcError has a .code; treat it as a bad-gateway — caller's request was
      // valid, the upstream node returned a well-formed error.
      if (err && typeof err.code === 'number') {
        return res.status(502).json({ error: `RPC error ${err.code}: ${err.message}` });
      }
      // Validation errors from createInvoice itself (e.g. expirySeconds) are
      // surfaced as 400. Everything else is a 502.
      if (err instanceof RangeError || err instanceof TypeError) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(502).json({ error: `Upstream error: ${err.message}` });
    }

    // --- record in ledger ---
    try {
      store.upsert({
        paymentHash: invoice.paymentHash,
        amountRUSD: invoice.amount,
        status: 'Open',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // Non-fatal — the invoice was created on the node; log and continue.
      console.error('[invoice route] store.upsert failed:', err.message);
    }

    return res.status(201).json({
      invoiceAddress: invoice.invoiceAddress,
      paymentHash: invoice.paymentHash,
      amount: invoice.amount,
      expiresAt: invoice.expiresAt,
    });
  });

  return router;
}

module.exports = { createInvoiceRouter };
