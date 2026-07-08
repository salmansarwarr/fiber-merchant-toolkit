'use strict';

/**
 * amount.js — BigInt-only conversion between human decimal amount strings and
 * hex-encoded smallest-unit u128 values, per plan Section 1.6 ("Amounts are
 * u128 hex strings — all amount handling must go through BigInt").
 *
 * Default is 8 decimals, matching the RUSD auto_accept_amount observed in
 * docs/rpc-samples.md (0x3b9aca00 == 1000000000 smallest units == 10 RUSD)
 * and the invoice `amount` field 0x2540be400 == 10000000000 smallest units
 * == 100 (whole units).
 *
 * Deliberately narrow: no floats anywhere in the conversion path, since
 * float math on values this size silently loses precision.
 */

const DEFAULT_DECIMALS = 8;

/**
 * Validates that `amount` is a plain non-negative decimal string with no
 * more than `decimals` fractional digits. Throws TypeError for non-strings,
 * RangeError for strings that don't match the expected shape.
 */
function assertValidAmountString(amount, decimals) {
  if (typeof amount !== 'string') {
    throw new TypeError(`amount must be a string, got ${typeof amount}`);
  }
  if (amount.length === 0) {
    throw new RangeError('amount must not be an empty string');
  }
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(amount)) {
    throw new RangeError(
      `invalid amount "${amount}": must be a non-negative decimal string ` +
        `with at most ${decimals} decimal place(s), e.g. "1", "0.5", "0" ` +
        `(no leading "+"/"-", no scientific notation, no thousands separators)`
    );
  }
}

/**
 * Converts a human-readable decimal string (e.g. "1.5") into a 0x-prefixed
 * hex-encoded smallest-unit integer (e.g. "0x8f0d180" for 8 decimals).
 *
 * @param {string} amount - non-negative decimal string
 * @param {number} [decimals] - number of decimal places the smallest unit represents
 * @returns {string} 0x-prefixed lowercase hex string
 */
function toSmallestUnitHex(amount, decimals = DEFAULT_DECIMALS) {
  assertValidAmountString(amount, decimals);

  const [wholePart, fracPart = ''] = amount.split('.');
  const paddedFrac = fracPart.padEnd(decimals, '0');
  const digits = `${wholePart}${paddedFrac}`;

  // BigInt() rejects leading zeros in some engines' string coercion paths;
  // stripping them explicitly keeps this robust regardless.
  const normalized = digits.replace(/^0+(?=\d)/, '');
  const value = BigInt(normalized);

  return `0x${value.toString(16)}`;
}

/**
 * Converts a 0x-prefixed hex-encoded smallest-unit integer back into a
 * canonical human-readable decimal string. Output is canonical, not
 * necessarily identical to whatever string originally produced the hex
 * value — trailing fractional zeros are dropped (e.g. "1.50000000" round
 * trips to "1.5", not back to "1.50000000"). See amount.test.js for the
 * exact boundary behavior this implies.
 *
 * @param {string} hex - 0x-prefixed hex string
 * @param {number} [decimals] - number of decimal places the smallest unit represents
 * @returns {string} canonical non-negative decimal string
 */
function fromSmallestUnitHex(hex, decimals = DEFAULT_DECIMALS) {
  if (typeof hex !== 'string') {
    throw new TypeError(`hex amount must be a string, got ${typeof hex}`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new RangeError(`invalid hex amount "${hex}": must be a 0x-prefixed hex string`);
  }

  const value = BigInt(hex);
  const digits = value.toString(10).padStart(decimals + 1, '0');
  const wholePart = digits.slice(0, digits.length - decimals) || '0';
  const rawFracPart = digits.slice(digits.length - decimals);
  const fracPart = rawFracPart.replace(/0+$/, '');

  return fracPart.length > 0 ? `${wholePart}.${fracPart}` : wholePart;
}

module.exports = {
  DEFAULT_DECIMALS,
  toSmallestUnitHex,
  fromSmallestUnitHex,
};