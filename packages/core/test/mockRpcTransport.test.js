'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockTransport } = require('./mockRpcTransport');

test('resolves a registered handler and logs the call', async () => {
  const rpc = createMockTransport({
    node_info: () => ({ pubkey: 'abc' }),
  });

  const result = await rpc.call('node_info', {});
  assert.deepEqual(result, { pubkey: 'abc' });
  assert.deepEqual(rpc.calls, [{ method: 'node_info', params: {} }]);
});

test('supports plain-value handlers as well as functions', async () => {
  const rpc = createMockTransport({
    list_payments: { payments: [], last_cursor: null },
  });

  const result = await rpc.call('list_payments');
  assert.deepEqual(result, { payments: [], last_cursor: null });
});

test('rejects for an unregistered method', async () => {
  const rpc = createMockTransport({});
  await assert.rejects(() => rpc.call('new_invoice', {}), /no handler registered/);
});

test('a handler that throws propagates as a rejection (e.g. simulating RpcError)', async () => {
  const rpc = createMockTransport({
    open_channel: () => {
      throw new Error('missing field `pubkey`');
    },
  });

  await assert.rejects(() => rpc.call('open_channel', {}), /missing field/);
});