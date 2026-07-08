'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcClient } = require('../src/rpcClient');
const { reconcileWithListPayments } = require('../src/settlement');

// Node 1 — the PAYER for the known CKB payment below. list_payments must be
// queried on the sending node, not the receiving one.
const FNN_RPC_URL = process.env.FNN_RPC_URL;

const KNOWN_SENT_PAYMENT_HASH = '0x9925e70f60501a4a3d37f1deefcbfd677814e306f189642d19a916d379b6aefb';

test('real node: list_payments finds a known payment when queried on the SENDING node', async (t) => {
  if (!FNN_RPC_URL) {
    t.skip(
      'set FNN_RPC_URL to Node 1 (e.g. http://127.0.0.1:8227 — the node that actually sent ' +
      'the known payment) to run against a real fnn node'
    );
    return;
  }

  const rpc = new RpcClient({ url: FNN_RPC_URL });
  const { found, missing } = await reconcileWithListPayments(rpc, [KNOWN_SENT_PAYMENT_HASH]);

  console.log('reconcileWithListPayments result:', { found, missing });

  assert.deepEqual(missing, []);
  assert.equal(found.length, 1);
  assert.equal(found[0].paymentHash, KNOWN_SENT_PAYMENT_HASH);
  assert.equal(found[0].status, 'Success');
});