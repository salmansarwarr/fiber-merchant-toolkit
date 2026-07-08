'use strict';

/**
 * A fake JSON-RPC 2.0 transport for unit tests.
 *
 * Real rpcClient.js (Phase 2) will accept an injectable transport function
 * of shape `(method, params) => Promise<result>` (exact signature TBD when
 * Phase 2 lands). This mock lets every later phase's unit tests run without
 * a live fnn node or the CKB testnet RPC, per Section 12 ("unit tests pass
 * with a mocked RPC transport").
 *
 * Usage:
 *   const { createMockTransport } = require('./mockRpcTransport');
 *   const transport = createMockTransport({
 *     new_invoice: () => ({ invoice_address: '...', invoice: { ... } }),
 *   });
 */
function createMockTransport(handlers = {}) {
  const calls = [];

  async function call(method, params) {
    calls.push({ method, params });

    if (!(method in handlers)) {
      throw new Error(`mockRpcTransport: no handler registered for method "${method}"`);
    }

    const handler = handlers[method];
    const result = typeof handler === 'function' ? handler(params) : handler;
    return result;
  }

  return { call, calls };
}

module.exports = { createMockTransport };