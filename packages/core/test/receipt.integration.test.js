'use strict';

/**
 * receipt.integration.test.js — the real-node leg of Phase 4.
 *
 * What this covers, against real nodes:
 *   - waitForPayment() correctly times out (not hangs) against a real,
 *     never-paid invoice.
 *   - The full buildReceipt -> verifyReceipt -> renderReceiptPdf pipeline
 *     against a real invoice's paymentHash/amount.
 *   - waitForPayment() resolving "Paid" for a REAL payment, end to end,
 *     across two local nodes.
 *
 * IMPORTANT: RUSD (UDT) payments are currently blocked by an upstream fnn
 * limitation, confirmed via direct testing on 2026-07-07 — see the Phase 4
 * addendum in docs/rpc-samples.md for the full diagnosis. In short: fnn's
 * route-builder appears to check a gossip-derived `outbound_liquidity`
 * figure that UDT channels never populate on this network (confirmed: 0 of
 * 500 channels in the local graph carry a non-null funding_udt_type_script),
 * so any RUSD send_payment fails with "max outbound liquidity 0" regardless
 * of the channel's real committed balance. A control payment over the plain
 * CKB-native channel succeeded immediately, isolating the problem to UDT
 * channels specifically — not this toolkit's RPC calls, channel setup, or
 * node connectivity.
 *
 * Because of that, the cross-node "real payment" test below deliberately
 * uses a CKB-native invoice as a stand-in for RUSD. This is a legitimate
 * substitution for what it's actually testing: waitForPayment/getInvoiceStatus
 * poll CkbInvoiceStatus, which is documented upstream as shared across all
 * currencies/UDT types — the same status machine regardless of denomination.
 * So this test genuinely confirms the code this project ships (the polling
 * loop, the status values, the receipt pipeline), even though it can't
 * exercise an actual RUSD-denominated payment until fnn's UDT liquidity
 * gossip is fixed upstream.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcClient } = require('../src/rpcClient');
const { createInvoice } = require('../src/invoice');
const { waitForPayment, buildReceipt, verifyReceipt, renderReceiptPdf, generateSigningKeyPair } = require('../src/receipt');
const { PDFParse } = require('pdf-parse');

const FNN_RPC_URL = process.env.FNN_RPC_URL;
// The second local node (e.g. http://127.0.0.1:8327) — only needed for the
// cross-node real-payment test below.
const FNN_RPC_URL_2 = process.env.FNN_RPC_URL_2;

/** See the identical helper + explanation in receipt.test.js. */
async function extractPdfText(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

test('real node: waitForPayment times out (not hangs) on a real, never-paid invoice', async (t) => {
  if (!FNN_RPC_URL) {
    t.skip('set FNN_RPC_URL (e.g. http://127.0.0.1:8227) to run against a real fnn node');
    return;
  }

  const rpc = new RpcClient({ url: FNN_RPC_URL });
  const invoice = await createInvoice(rpc, {
    amount: '0.00000001',
    description: 'phase4-integration-timeout-test',
  });

  await assert.rejects(
    () => waitForPayment(rpc, invoice.paymentHash, { timeoutMs: 3000, intervalMs: 500 }),
    /timed out/
  );
});

test('real node: end-to-end receipt build + verify + PDF, using a real invoice\'s paymentHash', async (t) => {
  if (!FNN_RPC_URL) {
    t.skip('set FNN_RPC_URL (e.g. http://127.0.0.1:8227) to run against a real fnn node');
    return;
  }

  // This does NOT wait for real payment (see file header) — it uses a real,
  // freshly created invoice's paymentHash to prove the receipt/PDF pipeline
  // works end to end against real data shapes, short of the payment itself.
  const rpc = new RpcClient({ url: FNN_RPC_URL });
  const invoice = await createInvoice(rpc, {
    amount: '5',
    description: 'phase4-integration-receipt-test',
  });

  const { privateKey } = generateSigningKeyPair();
  const receiptPackage = buildReceipt({
    merchantName: 'Phase 4 Integration Test',
    description: 'end-to-end receipt pipeline check',
    amountRUSD: invoice.amount,
    paymentHash: invoice.paymentHash,
    privateKey,
  });

  assert.equal(verifyReceipt(receiptPackage.receipt, receiptPackage.signatureHex, receiptPackage.publicKeyJwk), true);

  const pdf = await renderReceiptPdf(receiptPackage);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');

  const text = await extractPdfText(pdf);

  // JSON and PDF reference the same payment hash, per the plan's own check.
  assert.ok(text.includes(invoice.paymentHash));
});

test('real cross-node payment: waitForPayment resolves "Paid" end to end (CKB-native — see file header for why)', async (t) => {
  if (!FNN_RPC_URL || !FNN_RPC_URL_2) {
    t.skip(
      'set both FNN_RPC_URL and FNN_RPC_URL_2 (your two local fnn nodes, e.g. ' +
        'http://127.0.0.1:8227 and http://127.0.0.1:8327) to run this cross-node payment test'
    );
    return;
  }

  const payer = new RpcClient({ url: FNN_RPC_URL });
  const payee = new RpcClient({ url: FNN_RPC_URL_2 });

  // Plain CKB-native invoice, not via createInvoice() (which always attaches
  // the RUSD udt_type_script) — see file header for why RUSD can't be used
  // here yet. This is a raw RPC call rather than a library function because
  // "send a payment" isn't part of this toolkit's actual feature set (a
  // merchant toolkit receives payments; it doesn't send them) — it's purely
  // a test fixture to produce a real Paid transition to poll for.
  const invoiceResult = await payee.call('new_invoice', { currency: 'Fibt', amount: '0x1' });
  const paymentHash = invoiceResult.invoice.data.payment_hash;
  const invoiceAddress = invoiceResult.invoice_address;

  await payer.call('send_payment', { invoice: invoiceAddress });

  const status = await waitForPayment(payee, paymentHash, { timeoutMs: 20_000, intervalMs: 1000 });
  assert.equal(status, 'Paid');
});