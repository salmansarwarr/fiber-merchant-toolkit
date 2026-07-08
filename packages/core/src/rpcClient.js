'use strict';

/**
 * rpcClient.js — JSON-RPC 2.0 POST client targeting a real fnn RPC port.
 *
 * Retry policy (per plan Section 5 / Phase 2):
 *   - Retry on network errors, request timeouts, HTTP 5xx, and undecodable
 *     response bodies. Section 1.13 documents a real observed failure mode
 *     where fnn's own funding flow occasionally gets a truncated/undecodable
 *     body from a shared public CKB RPC endpoint — from the outside this is
 *     indistinguishable from a transient network blip, so it's treated the
 *     same way here.
 *   - NEVER retry a well-formed JSON-RPC error response (HTTP 2xx body with
 *     an `error` field). Retrying those risks duplicate invoice/payment side
 *     effects on the fnn node, which is worse than surfacing the error.
 *   - HTTP 4xx (non-5xx) failures are not retried either — they indicate a
 *     malformed request on our end, not a transient condition.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Thrown for a well-formed JSON-RPC `{error: {...}}` response. Never retried. */
class RpcError extends Error {
  constructor(code, message, data) {
    super(`RPC error ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** Thrown for network/timeout/HTTP-status/decode failures, after retries are exhausted. */
class RpcTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RpcTransportError';
    if (cause !== undefined) this.cause = cause;
  }
}

class RpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.url - fnn RPC endpoint, e.g. http://127.0.0.1:8227
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries] - retry attempts after the first try (0 = no retries)
   * @param {number} [opts.retryDelayMs] - base delay, multiplied by attempt number (linear backoff)
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
   */
  constructor({
    url,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
  } = {}) {
    if (!url) {
      throw new TypeError('RpcClient requires a `url`');
    }
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this._fetch = fetchImpl;
    this._nextId = 0;
  }

  /**
   * Calls a Fiber JSON-RPC method and returns `result` on success.
   *
   * fnn's RPC methods are implemented in jsonrpsee with a signature of the
   * shape `fn method_name(&self, params: SomeParams)` — i.e. every method
   * takes exactly zero or one argument, and that argument happens to be
   * named `params` in the Rust source. jsonrpsee supports two calling
   * conventions: positional (JSON array) or named (JSON object, matched
   * against Rust argument *names*). Sending a named object here would
   * require the object to have a literal `params` key wrapping the real
   * fields — confirmed against a real node: `new_invoice` failed with
   * `RpcError -32602 "missing field \`params\`"` when the JS object was
   * sent directly as the JSON-RPC `params` value. Sending positionally
   * (`params: [theObject]`) avoids needing to know or match the Rust
   * argument name at all, and is what this client does.
   *
   * @param {string} method
   * @param {object|Array} [params] - the method's argument object. An
   *   array is passed through unchanged (already positional); an object
   *   is wrapped as a single positional element; empty/undefined becomes
   *   an empty positional array (zero arguments).
   * @returns {Promise<any>}
   */
  async call(method, params = {}) {
    const id = ++this._nextId;
    const rpcParams = this._toPositionalParams(params);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: rpcParams });

    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let httpResponse;

      try {
        httpResponse = await this._postWithTimeout(body);
      } catch (err) {
        lastError = new RpcTransportError(
          `network error calling ${method}: ${err.message}`,
          err
        );
        if (attempt < this.maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw lastError;
      }

      if (httpResponse.status >= 500) {
        lastError = new RpcTransportError(
          `HTTP ${httpResponse.status} calling ${method}`
        );
        if (attempt < this.maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw lastError;
      }

      if (!httpResponse.ok) {
        const text = await this._safeText(httpResponse);
        // 4xx: not retryable, indicates a bad request on our end.
        throw new RpcTransportError(
          `HTTP ${httpResponse.status} calling ${method}${text ? `: ${text}` : ''}`
        );
      }

      let json;
      try {
        json = await httpResponse.json();
      } catch (err) {
        // Undecodable body — per Section 1.13, treat as transient/retryable.
        lastError = new RpcTransportError(
          `failed to decode response body calling ${method}: ${err.message}`,
          err
        );
        if (attempt < this.maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw lastError;
      }

      if (json && json.error) {
        // Well-formed JSON-RPC error — never retry.
        throw new RpcError(json.error.code, json.error.message, json.error.data);
      }

      return json ? json.result : undefined;
    }

    // Unreachable in practice (the loop always returns or throws), but keeps
    // control flow analysis honest.
    throw lastError;
  }

  _toPositionalParams(params) {
    if (params === undefined || params === null) return [];
    if (Array.isArray(params)) return params;
    if (typeof params === 'object' && Object.keys(params).length === 0) return [];
    return [params];
  }

  async _postWithTimeout(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this._fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async _safeText(response) {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  _backoff(attempt) {
    const delay = this.retryDelayMs * (attempt + 1);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

module.exports = { RpcClient, RpcError, RpcTransportError };