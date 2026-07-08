'use strict';

/**
 * invoice.integration.test.js — the real-node leg of Phase 3, and the piece
 * that also closes out Phase 2's outstanding item (Section 12 requires at
 * least one test per phase to run against a real fnn node, not just mocks).
 *
 * This is NOT run against a live node automatically — I don't have network
 * access to your fnn instance from this sandbox (it's on your machine at
 * 127.0.0.1:8227/8327, not reachable here, and this container's egress is
 * allowlisted to package registries only). Every test below skips itself
 * with a clear reason if FNN_RPC_URL isn't set, so `npm test` stays green
 * with no live node running.
 *
 * To actually run this against your Phase 0 setup:
 *   FNN_RPC_URL=http://127.0.0.1:8227 npm test
 *
 * What it does when it runs for real:
 *   1. Calls node_info — this alone satisfies Phase 2's outstanding
 *      real-node check, independent of whether invoice creation works.
 *   2. Creates a tiny real RUSD invoice via createInvoice().
 *   3. Calls get_invoice (via getInvoiceStatus()) with the returned payment
 *      hash and asserts the node reports it "Open" — field path confirmed
 *      against a real node on 2026-07-06, see docs/rpc-samples.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcClient } = require('../src/rpcClient');
const { createInvoice, getInvoiceStatus } = require('../src/invoice');

const FNN_RPC_URL = process.env.FNN_RPC_URL;

test('real node: node_info responds (closes out Phase 2\'s outstanding real-node check)', async (t) => {
  if (!FNN_RPC_URL) {
    t.skip('set FNN_RPC_URL (e.g. http://127.0.0.1:8227) to run against a real fnn node');
    return;
  }

  const rpc = new RpcClient({ url: FNN_RPC_URL });
  const info = await rpc.call('node_info');

  assert.ok(info.pubkey, 'node_info response should include a pubkey');
  assert.ok(
    Array.isArray(info.udt_cfg_infos),
    'node_info response should include udt_cfg_infos'
  );
});

test('real node: creates a tiny RUSD invoice and confirms it shows Open via get_invoice', async (t) => {
  if (!FNN_RPC_URL) {
    t.skip('set FNN_RPC_URL (e.g. http://127.0.0.1:8227) to run against a real fnn node');
    return;
  }

  const rpc = new RpcClient({ url: FNN_RPC_URL });

  const invoice = await createInvoice(rpc, {
    amount: '0.00000001', // smallest possible unit, to avoid touching real liquidity
    description: 'phase3-integration-test',
  });

  assert.match(invoice.invoiceAddress, /^fibt/);
  assert.match(invoice.paymentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(invoice.amount, '0.00000001');

  // Field path confirmed against a real node on 2026-07-06 — result.status
  // is a top-level sibling of result.invoice, not nested under it. See the
  // Phase 3 addendum in docs/rpc-samples.md for the raw captured response.
  const status = await getInvoiceStatus(rpc, invoice.paymentHash);
  assert.equal(status, 'Open');
});