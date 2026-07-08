'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toSmallestUnitHex, fromSmallestUnitHex } = require('../src/amount');

// ---------------------------------------------------------------------------
// Property test: round-trip for canonical amounts (no trailing fractional
// zeros, since fromSmallestUnitHex always returns canonical form — see
// boundary case below for the non-canonical-input behavior this implies).
// ---------------------------------------------------------------------------
test('round-trips ~1000 random canonical amounts through hex and back', () => {
  for (let i = 0; i < 1000; i += 1) {
    const whole = Math.floor(Math.random() * 1_000_000);
    const decimalDigits = Math.floor(Math.random() * 9); // 0..8
    let frac = '';
    for (let d = 0; d < decimalDigits; d += 1) {
      frac += Math.floor(Math.random() * 10);
    }
    // Strip trailing zeros from the generated fraction so the input is
    // already canonical, matching what fromSmallestUnitHex will produce.
    frac = frac.replace(/0+$/, '');

    const input = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
    const hex = toSmallestUnitHex(input);
    const output = fromSmallestUnitHex(hex);

    assert.equal(output, input, `round-trip failed for "${input}" (hex: ${hex})`);
  }
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------
test('smallest representable unit round-trips', () => {
  const hex = toSmallestUnitHex('0.00000001');
  assert.equal(hex, '0x1');
  assert.equal(fromSmallestUnitHex(hex), '0.00000001');
});

test('zero round-trips as "0", not "0.00000000"', () => {
  assert.equal(toSmallestUnitHex('0'), '0x0');
  assert.equal(fromSmallestUnitHex('0x0'), '0');
});

test('whole numbers round-trip without a decimal point', () => {
  assert.equal(toSmallestUnitHex('5'), '0x1dcd6500');
  assert.equal(fromSmallestUnitHex('0x1dcd6500'), '5');
});

test('trailing fractional zeros are canonicalized away on the way back out', () => {
  // "1.50000000" is valid input (8 decimal places), but fromSmallestUnitHex
  // always returns the canonical form — it will never reproduce trailing
  // zeros, since the hex value alone can't distinguish "1.5" from
  // "1.50000000". Callers that care about display formatting must handle
  // that themselves.
  const hex = toSmallestUnitHex('1.50000000');
  assert.equal(fromSmallestUnitHex(hex), '1.5');
});

test('more than 8 decimal places throws RangeError', () => {
  assert.throws(() => toSmallestUnitHex('1.123456789'), RangeError);
});

test('non-string input throws TypeError', () => {
  assert.throws(() => toSmallestUnitHex(1.5), TypeError);
  assert.throws(() => toSmallestUnitHex(null), TypeError);
  assert.throws(() => toSmallestUnitHex(undefined), TypeError);
  assert.throws(() => fromSmallestUnitHex(100), TypeError);
});

test('negative, empty, and malformed strings throw RangeError', () => {
  assert.throws(() => toSmallestUnitHex('-1'), RangeError);
  assert.throws(() => toSmallestUnitHex(''), RangeError);
  assert.throws(() => toSmallestUnitHex('1.5.5'), RangeError);
  assert.throws(() => toSmallestUnitHex('1e10'), RangeError);
  assert.throws(() => toSmallestUnitHex('1,000'), RangeError);
  assert.throws(() => fromSmallestUnitHex('123'), RangeError); // missing 0x prefix
  assert.throws(() => fromSmallestUnitHex('0xzz'), RangeError);
});

// ---------------------------------------------------------------------------
// Snapshot test against real captures in docs/rpc-samples.md
// ---------------------------------------------------------------------------
test('matches the real invoice amount captured in docs/rpc-samples.md', () => {
  // Both captured new_invoice samples (plain and RUSD) show
  // "amount": "0x2540be400" for a 100-unit invoice at 8 decimals.
  assert.equal(toSmallestUnitHex('100'), '0x2540be400');
  assert.equal(fromSmallestUnitHex('0x2540be400'), '100');
});

test('matches the real RUSD auto_accept_amount captured in docs/rpc-samples.md', () => {
  // node_info's udt_cfg_infos[0].auto_accept_amount for RUSD is
  // "0x3b9aca00", documented in Section 1.5 as "10 RUSD, 8 decimals".
  assert.equal(toSmallestUnitHex('10'), '0x3b9aca00');
  assert.equal(fromSmallestUnitHex('0x3b9aca00'), '10');
});