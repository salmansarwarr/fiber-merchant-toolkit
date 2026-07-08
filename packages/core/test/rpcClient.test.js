'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcClient, RpcError, RpcTransportError } = require('../src/rpcClient');

/** Builds a fake `fetch` that returns a canned Response-like object. */
function jsonResponse(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return jsonBody;
    },
    async text() {
      return JSON.stringify(jsonBody);
    },
  };
}

/** Fake fetch that returns undecodable JSON (throws in .json()). */
function undecodableResponse(status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      throw new SyntaxError('Unexpected end of JSON input');
    },
    async text() {
      return '<truncated>';
    },
  };
}

/** Fake fetch that always rejects (simulated network error). */
function makeRejectingFetch(message = 'ECONNREFUSED') {
  return async () => {
    throw new Error(message);
  };
}

test('sends params as a positional array, not a bare named object (jsonrpsee dispatch requirement)', async () => {
  const seenBodies = [];
  const fetchImpl = async (url, init) => {
    seenBodies.push(JSON.parse(init.body));
    return jsonResponse(200, { jsonrpc: '2.0', id: seenBodies.length, result: { ok: true } });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl });

  await client.call('node_info', {});
  await client.call('new_invoice', { amount: '0x1' });
  await client.call('list_payments'); // no params argument at all

  assert.equal(seenBodies[0].jsonrpc, '2.0');
  assert.equal(seenBodies[0].method, 'node_info');
  assert.deepEqual(seenBodies[0].params, [], 'an empty object argument becomes an empty positional array');
  assert.equal(seenBodies[0].id, 1);

  assert.equal(seenBodies[1].method, 'new_invoice');
  assert.deepEqual(
    seenBodies[1].params,
    [{ amount: '0x1' }],
    'a non-empty object argument is wrapped as a single positional element'
  );
  assert.equal(seenBodies[1].id, 2);

  assert.deepEqual(seenBodies[2].params, [], 'an omitted params argument also becomes an empty positional array');
});

test('passes an already-positional array through unchanged', async () => {
  const seenBodies = [];
  const fetchImpl = async (url, init) => {
    seenBodies.push(JSON.parse(init.body));
    return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl });

  await client.call('some_positional_method', ['0x1', '0x2']);
  assert.deepEqual(seenBodies[0].params, ['0x1', '0x2']);
});

test('returns `result` on a successful response', async () => {
  const fetchImpl = async () => jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { pubkey: 'abc' } });
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl });

  const result = await client.call('node_info');
  assert.deepEqual(result, { pubkey: 'abc' });
});

test('throws RpcError and does NOT retry on a well-formed JSON-RPC error', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'missing field `pubkey`' },
    });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl, maxRetries: 5, retryDelayMs: 1 });

  await assert.rejects(() => client.call('open_channel', {}), RpcError);
  assert.equal(callCount, 1, 'a JSON-RPC error response must never be retried');
});

test('retries on HTTP 5xx and eventually succeeds', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount < 3) return jsonResponse(503, { error: 'service unavailable' });
    return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl, maxRetries: 5, retryDelayMs: 1 });

  const result = await client.call('node_info');
  assert.deepEqual(result, { ok: true });
  assert.equal(callCount, 3);
});

test('does NOT retry on HTTP 4xx', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse(400, { error: 'bad request' });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl, maxRetries: 5, retryDelayMs: 1 });

  await assert.rejects(() => client.call('node_info'), RpcTransportError);
  assert.equal(callCount, 1);
});

test('retries on network errors and eventually throws RpcTransportError after exhausting retries', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    throw new Error('ECONNREFUSED');
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl, maxRetries: 2, retryDelayMs: 1 });

  await assert.rejects(() => client.call('node_info'), RpcTransportError);
  assert.equal(callCount, 3); // initial attempt + 2 retries
});

test('retries on an undecodable response body (Section 1.13 failure mode), then succeeds', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) return undecodableResponse(200);
    return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { synced: true } });
  };
  const client = new RpcClient({ url: 'http://127.0.0.1:8227', fetchImpl, maxRetries: 5, retryDelayMs: 1 });

  const result = await client.call('get_tip_block_number');
  assert.deepEqual(result, { synced: true });
  assert.equal(callCount, 2);
});

test('aborts and retries on a timeout', async () => {
  let callCount = 0;
  const fetchImpl = async (url, init) => {
    callCount += 1;
    if (callCount === 1) {
      // Simulate a hang that only resolves after the caller aborts.
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }
    return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } });
  };
  const client = new RpcClient({
    url: 'http://127.0.0.1:8227',
    fetchImpl,
    timeoutMs: 20,
    maxRetries: 3,
    retryDelayMs: 1,
  });

  const result = await client.call('node_info');
  assert.deepEqual(result, { ok: true });
  assert.equal(callCount, 2);
});

test('constructor requires a url', () => {
  assert.throws(() => new RpcClient({}), TypeError);
});