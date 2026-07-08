'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockTransport } = require('./mockRpcTransport');
const { createInvoice, parseInvoiceResponse, getInvoiceStatus, RUSD_UDT_TYPE_SCRIPT } = require('../src/invoice');

// ---------------------------------------------------------------------------
// Real captures from docs/rpc-samples.md, verbatim (id 2: plain, id 3: RUSD).
// Used so parsing is tested against actual node output, not invented fixtures.
// ---------------------------------------------------------------------------
const PLAIN_INVOICE_RESULT = {
  invoice_address:
    'fibt100000000001p4pt6skqnukgfw0pnm6vhzn9kurazcl7epjvw09k6eg20r0axrlmtpshjarj02ngyakymryg4en7pwd5j63dqcguevs89ntxtjzmxc6hz39sv80lmndhst0mfp37r77tqunwyqhrzpjtnm5qu8exez58v00ve3rf3keevz4kel666vf424jcvdw3ccnhxc9nf3sayt9z3xnt77jk75vylnmy0ursqyga25qh6nvlypa4dakrwaks5yycrfgnv6wulglpfnprppq0tkn88ttgd595ktvwjewemgjya4jelh42y0lr5l5fuu5nad892fxqfqagqhhql3a',
  invoice: {
    currency: 'Fibt',
    amount: '0x2540be400',
    signature:
      '04081d0a1400171a130c1f04011d150d1d16030e1d161014040418030908130c1a0e1c1f081f01091301030101000f0b161307070b0b080d140514160b0c0e12190e191b0812041d1512191f17150a040f1f03141f14091c1c14131d0d07050a09060009001d0800',
    data: {
      timestamp: '0x19f330d64ea',
      payment_hash: '0xcc850468cc0a2d6d889f521597a76cfc7fdbc7f556cb09f02b4fbae10ba6d76a',
      attrs: [
        { description: 'phase0-plain' },
        { final_htlc_minimum_expiry_delta: '0x927c00' },
        { payee_public_key: '03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69' },
      ],
    },
  },
};

const RUSD_INVOICE_RESULT = {
  invoice_address:
    'fibt100000000001ppn6qn73reuqzg7dwfhdvmzlr0rat8p2r7tygrav9ss9rxf4gmaa0c02vr07hk4hcfqrvjra6e4n2j5uvg9w5zr83lp3n72sqwykhcaumrrtsqyqpk25y5jegw6w2v8mqvk7etehgvfux9yvn9460fhw2p2t6angfqh7jv9mtekygg56k8t7wdqalux8d5u7md3dxzg5qr3h3l4m0hp8qugsf8fkcpwreq504pmjlkenm4lq85lmymg0sqhlwvjr320v80mptc48l0k57pnwdwkzcmjnstxsvkt0feskqnatqn8sn3ugs75zefar99n4m2532qyfkzc72ttttz3x296m2ntsjs8y4yk65qk8rpe7alwxduy75jdqa9dftwrzzu2xzq7defxuh4djq579ydlvpyq9v8jya080mu2csvqcgh6uj7q6lv6aye3zmwap36pv3aa927p8spz8hhdp',
  invoice: {
    currency: 'Fibt',
    amount: '0x2540be400',
    signature:
      '16070301191e1d1f0e060d1c041e14120d001d050d090b0e0302021c0a0602001e0d1909061c17150d1200141e05040d1f0c010400050c0712041d0f070f1b1c0a18100c001808171a1c121e001a1f0c1a1d041911021b0e1d01111a010c111d1d050a1e01071001',
    data: {
      timestamp: '0x19f330d6557',
      payment_hash: '0xff89e6562090c6c022d5d61e7c208f5a0502e97acf342c470494f8710a6e8066',
      attrs: [
        { description: 'phase0-rusd' },
        { final_htlc_minimum_expiry_delta: '0x927c00' },
        {
          udt_script:
            '0x550000001000000030000000310000001142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a0120000000878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b',
        },
        { payee_public_key: '03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// parseInvoiceResponse — snapshot tests against real captures
// ---------------------------------------------------------------------------
test('parses the real plain new_invoice sample from docs/rpc-samples.md', () => {
  const parsed = parseInvoiceResponse(PLAIN_INVOICE_RESULT);

  assert.equal(parsed.invoiceAddress, PLAIN_INVOICE_RESULT.invoice_address);
  assert.equal(parsed.paymentHash, PLAIN_INVOICE_RESULT.invoice.data.payment_hash);
  assert.equal(parsed.amountSmallestUnit, '0x2540be400');
  assert.equal(parsed.amount, '100');
  // timestamp 0x19f330d64ea (1783267943658ms) + delta 0x927c00 (9600000ms)
  assert.equal(parsed.expiresAt, new Date(1783267943658 + 9600000).toISOString());
});

test('parses the real RUSD new_invoice sample from docs/rpc-samples.md', () => {
  const parsed = parseInvoiceResponse(RUSD_INVOICE_RESULT);

  assert.equal(parsed.invoiceAddress, RUSD_INVOICE_RESULT.invoice_address);
  assert.equal(parsed.paymentHash, RUSD_INVOICE_RESULT.invoice.data.payment_hash);
  assert.equal(parsed.amountSmallestUnit, '0x2540be400');
  assert.equal(parsed.amount, '100');
  assert.ok(parsed.expiresAt); // present; exact value checked in the plain-invoice test above
});

test('throws a clear error on an unexpected/malformed response shape', () => {
  assert.throws(() => parseInvoiceResponse({}), /unexpected new_invoice response shape/);
  assert.throws(
    () => parseInvoiceResponse({ invoice_address: 'x', invoice: {} }),
    /unexpected new_invoice response shape/
  );
});

test('returns expiresAt: null if timestamp/delta attrs are absent, rather than throwing', () => {
  const parsed = parseInvoiceResponse({
    invoice_address: 'x',
    invoice: { amount: '0x1', data: { payment_hash: '0xabc', attrs: [] } },
  });
  assert.equal(parsed.expiresAt, null);
});

// ---------------------------------------------------------------------------
// createInvoice — request shape sent to new_invoice
// ---------------------------------------------------------------------------
test('sends the exact expected params to new_invoice, including currency and udt_type_script', async () => {
  const rpc = createMockTransport({
    new_invoice: () => RUSD_INVOICE_RESULT,
  });

  await createInvoice(rpc, { amount: '100', description: 'test invoice' });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].method, 'new_invoice');
  assert.deepEqual(rpc.calls[0].params, {
    currency: 'Fibt',
    amount: '0x2540be400',
    udt_type_script: RUSD_UDT_TYPE_SCRIPT,
    description: 'test invoice',
  });
});

test('omits `description` from params entirely when not provided', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });

  await createInvoice(rpc, { amount: '100' });

  assert.ok(!Object.prototype.hasOwnProperty.call(rpc.calls[0].params, 'description'));
});

test('honors an explicit currency override (e.g. mainnet Fibb)', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });

  await createInvoice(rpc, { amount: '100', currency: 'Fibb' });

  assert.equal(rpc.calls[0].params.currency, 'Fibb');
});

test('createInvoice returns the flattened shape end to end', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });

  const invoice = await createInvoice(rpc, { amount: '100' });

  assert.deepEqual(Object.keys(invoice).sort(), [
    'amount',
    'amountSmallestUnit',
    'expiresAt',
    'invoiceAddress',
    'paymentHash',
  ]);
  assert.equal(invoice.amount, '100');
});

// ---------------------------------------------------------------------------
// getInvoiceStatus — snapshot-tested against a real captured get_invoice
// response (docs/rpc-samples.md, Phase 3 addendum, captured 2026-07-06)
// ---------------------------------------------------------------------------
const GET_INVOICE_RESULT = {
  invoice_address:
    'fibt11pa5fw6y6c5zgfw0pnm6vk500hd506q7kv73fj0p3vl78gckp305d4x9yd2rf4685x25dfhu8eckdw0rpkasnavegdt5mp8aus9gyevkchnj2825y9pwu2wwhsfe7nqfqjq73c59m4xdhc47e00zkstj306kccnwctuelzne67kr2e7q432yw6ajxauj6rlnlw8zwry55xd8n7jv58d7kklhdg5a7ve8a4tzy2je9yza0m43qvqtq6s2f4hvayqws0qw3037t3pg3wu552a8g3up63sf4ul808r2p7ngjaqnjj2tvket0qtfkx0phkjxrcxqd52fjpqlreedtq3xxt7da0klespv48837y9uzz94cfdxmsvdeqpn0mmgaku8gsv49rf425wv9crezc796n90csvnvwpktlu3j8rfspltwme9',
  invoice: {
    currency: 'Fibt',
    amount: '0x1',
    signature:
      '06000d140a091201001f0319190d0b001106060b1e0d1d0f161f1910010c150707111e04051c0202051518090d061b100c0d190001130f1b1b081d161c0708100c15050309150a140e0c0518031902181e051a13050f18100c130c0e01160b1f1c11120703091001',
    data: {
      timestamp: '0x19f343ee379',
      payment_hash: '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f',
      attrs: [
        { final_htlc_minimum_expiry_delta: '0x927c00' },
        {
          udt_script:
            '0x550000001000000030000000310000001142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a0120000000878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b',
        },
        { payee_public_key: '03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69' },
      ],
    },
  },
  status: 'Open',
};

test('getInvoiceStatus reads the real top-level `status` field and sends the correct params shape', async () => {
  const rpc = createMockTransport({
    get_invoice: () => GET_INVOICE_RESULT,
  });

  const status = await getInvoiceStatus(
    rpc,
    '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f'
  );

  assert.equal(status, 'Open');
  assert.equal(rpc.calls.length, 1);
  assert.deepEqual(rpc.calls[0].params, {
    payment_hash: '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f',
  });
});

test('getInvoiceStatus rejects a malformed payment hash without calling the RPC', async () => {
  const rpc = createMockTransport({ get_invoice: () => GET_INVOICE_RESULT });
  const bad = ['not-a-hash', '0x123', '', undefined, null, 42, '0x' + 'g'.repeat(64)];

  for (const paymentHash of bad) {
    await assert.rejects(() => getInvoiceStatus(rpc, paymentHash), TypeError);
  }
  assert.equal(rpc.calls.length, 0);
});

test('getInvoiceStatus throws a clear error if `status` is missing from the response', async () => {
  const rpc = createMockTransport({ get_invoice: () => ({ invoice: {} }) });
  await assert.rejects(
    () =>
      getInvoiceStatus(rpc, '0xb6298db73b246449c081ecd1c551ec2ba500f4c882c4570f090e6f4f33d4774f'),
    /unexpected get_invoice response shape/
  );
});
test('rejects a zero amount without calling the RPC', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });
  await assert.rejects(() => createInvoice(rpc, { amount: '0' }), RangeError);
  await assert.rejects(() => createInvoice(rpc, { amount: '0.00000000' }), RangeError);
  assert.equal(rpc.calls.length, 0);
});

test('rejects malformed amount strings without calling the RPC', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });
  const badAmounts = ['-1', 'abc', '1.123456789', '1e10', '', '1,000', undefined, null, 42];

  for (const amount of badAmounts) {
    await assert.rejects(() => createInvoice(rpc, { amount }));
  }
  assert.equal(rpc.calls.length, 0);
});

test('rejects a non-string description without calling the RPC', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });
  await assert.rejects(() => createInvoice(rpc, { amount: '1', description: 123 }), TypeError);
  assert.equal(rpc.calls.length, 0);
});

test('rejects `expirySeconds` as explicitly unsupported, without calling the RPC', async () => {
  const rpc = createMockTransport({ new_invoice: () => RUSD_INVOICE_RESULT });
  await assert.rejects(
    () => createInvoice(rpc, { amount: '1', expirySeconds: 3600 }),
    /not yet supported/
  );
  assert.equal(rpc.calls.length, 0);
});