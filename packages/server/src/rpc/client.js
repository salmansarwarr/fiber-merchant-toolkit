'use strict';

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Minimal HTTP JSON-RPC 2.0 client for the fnn node. No auth — plain POST.
 *
 * @param {{url: string, timeoutMs?: number}} opts
 */
class RpcClient {
  constructor({ url, timeoutMs = 15000 } = {}) {
    if (!url) throw new TypeError('RpcClient requires a `url`');
    this.url = url;
    this.timeoutMs = timeoutMs;
    this._id = 0;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>} the `result` field of the RPC response
   */
  async call(method, params) {
    const id = ++this._id;
    // jsonrpsee (fnn's RPC framework) expects positional params: even a
    // single struct argument must be wrapped in an array, e.g.
    // "params": [{...}] — a bare object gets rejected as -32602 Invalid
    // params. See docs/rpc-samples.md re: get_invoice's InvoiceParams.
    const wrappedParams = params === undefined ? [] : [params];
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: wrappedParams });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new RpcError(-32000, `RPC request timed out after ${this.timeoutMs}ms`);
      }
      throw new RpcError(-32000, `RPC transport error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      throw new RpcError(-32000, `RPC response was not valid JSON (HTTP ${res.status})`);
    }

    if (payload.error) {
      const { code, message, data } = payload.error;
      throw new RpcError(code, message || 'RPC error', data);
    }

    if (!res.ok) {
      throw new RpcError(res.status, `HTTP ${res.status}: ${res.statusText}`);
    }

    return payload.result;
  }
}

module.exports = { RpcClient, RpcError };