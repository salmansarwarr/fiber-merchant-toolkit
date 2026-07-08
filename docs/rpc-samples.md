# Fiber RPC Samples — captured against real fnn v0.8.1 testnet node, 2026-07-04/05

## Corrections vs. original plan assumptions (fiber-merchant-toolkit-plan.md)

1. **`new_invoice` REQUIRES a `currency` field** (enum: `Fibb` mainnet / `Fibt` testnet / `Fibd` devnet).
   Section 1.4 was wrong that there's "no currency parameter" — that's separate from `udt_type_script`,
   which still controls CKB vs. UDT denomination.
2. **`list_payments` EXISTS** on v0.8.1 and returns `{payments: [], last_cursor: null}` for an empty node.
   Section 1.3's "no list_payments" is incorrect for this build — Feature 3 can potentially use/reconcile
   against it rather than requiring the local-ledger design as mandatory.
3. **`open_channel` takes `pubkey`, not `peer_id`** as the README (develop branch) states.
4. **Invoice response shape** nests payment data:
   - `result.invoice_address` — top level, snake_case
   - `result.invoice.data.payment_hash` — nested under invoice.data, NOT top-level
   - `result.invoice.amount` — nested under invoice, NOT top-level
   - No absolute expiry timestamp is returned — only `final_htlc_minimum_expiry_delta` (relative delta)
     and `data.timestamp` (creation time). `createInvoice`'s return shape in Section 6 needs to drop
     `expiresAt` or compute it client-side from timestamp + delta.
   - RUSD invoices encode `udt_script` as a raw molecule-serialized hex blob in `attrs`, not as a
     structured `{code_hash, hash_type, args}` object.
5. **`accept_channel` requires the acceptor to also meet the reserve minimum** (99 CKB observed on this
   testnet config) — both sides need this reserve, not just the channel opener.
6. **Known transient failure mode during channel funding:** `fund` -> `build_and_balance_tx` calls
   `get_block_by_number(0)` (full genesis block, ~2.3MB) to resolve default cell deps. Against the shared
   public `testnet.ckbapp.dev` endpoint this occasionally returns an undecodable/truncated body
   ("error decoding response body"), aborting the funding attempt after 5 retries. Confirmed transient —
   retrying `open_channel` fresh succeeds. Worth building retry/backoff awareness of this specific
   failure mode into `rpcClient.js`, and considering a dedicated/self-hosted CKB RPC node if it recurs
   often in later phases.

## RUSD acquisition (testnet)

RUSD is not available from a simple faucet — it's minted via the Stable++ over-collateralization protocol.
For Fiber testnet development specifically, use:
- RUSD faucet: https://testnet0815.stablepp.xyz/faucet
- The faucet cannot fund an arbitrary address directly — claim via a JoyID wallet, then transfer from
  JoyID to the target fnn node's testnet address.

## Verified two-node local setup (this session)

- Node 1: RPC 127.0.0.1:8227, P2P 0.0.0.0:8228
- Node 2: RPC 127.0.0.1:8327, P2P 0.0.0.0:8329
- CKB channel: 1 CKB funding, channel_id 0x70dcdf2eaec06b03b639f99b67bf4db368cd07b61bf2dbdcd1b971a1cc0fb01f — ChannelReady
- RUSD channel: 10 RUSD funding, channel_id 0x42eecd28448e5244a701a1cbc51dfa61469a4d24426f66a10dcf246ab0235e46 — ChannelReady

## Raw captured samples

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "version": "0.8.1",
    "commit_hash": "b560023 2026-04-16",
    "pubkey": "03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69",
    "features": [
      "GOSSIP_QUERIES_REQUIRED",
      "BASIC_MPP_REQUIRED",
      "TRAMPOLINE_ROUTING_REQUIRED"
    ],
    "node_name": null,
    "addresses": [],
    "chain_hash": "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
    "open_channel_auto_accept_min_ckb_funding_amount": "0x2540be400",
    "auto_accept_channel_ckb_funding_amount": "0x24e160300",
    "default_funding_lock_script": {
      "code_hash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
      "hash_type": "type",
      "args": "0xd4580f933094d5b4f75b77d037f5aa29929f123c"
    },
    "tlc_expiry_delta": "0xdbba00",
    "tlc_min_value": "0x0",
    "tlc_fee_proportional_millionths": "0x3e8",
    "channel_count": "0x5",
    "pending_channel_count": "0x0",
    "peers_count": "0x2",
    "udt_cfg_infos": [
      {
        "name": "RUSD",
        "script": {
          "code_hash": "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
          "hash_type": "type",
          "args": "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
        },
        "auto_accept_amount": "0x3b9aca00",
        "cell_deps": [
          {
            "type_id": {
              "code_hash": "0x00000000000000000000000000000000000000000000000000545950455f4944",
              "hash_type": "type",
              "args": "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f"
            }
          }
        ]
      }
    ]
  }
}
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "invoice_address": "fibt100000000001p4pt6skqnukgfw0pnm6vhzn9kurazcl7epjvw09k6eg20r0axrlmtpshjarj02ngyakymryg4en7pwd5j63dqcguevs89ntxtjzmxc6hz39sv80lmndhst0mfp37r77tqunwyqhrzpjtnm5qu8exez58v00ve3rf3keevz4kel666vf424jcvdw3ccnhxc9nf3sayt9z3xnt77jk75vylnmy0ursqyga25qh6nvlypa4dakrwaks5yycrfgnv6wulglpfnprppq0tkn88ttgd595ktvwjewemgjya4jelh42y0lr5l5fuu5nad892fxqfqagqhhql3a",
    "invoice": {
      "currency": "Fibt",
      "amount": "0x2540be400",
      "signature": "04081d0a1400171a130c1f04011d150d1d16030e1d161014040418030908130c1a0e1c1f081f01091301030101000f0b161307070b0b080d140514160b0c0e12190e191b0812041d1512191f17150a040f1f03141f14091c1c14131d0d07050a09060009001d0800",
      "data": {
        "timestamp": "0x19f330d64ea",
        "payment_hash": "0xcc850468cc0a2d6d889f521597a76cfc7fdbc7f556cb09f02b4fbae10ba6d76a",
        "attrs": [
          {
            "description": "phase0-plain"
          },
          {
            "final_htlc_minimum_expiry_delta": "0x927c00"
          },
          {
            "payee_public_key": "03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69"
          }
        ]
      }
    }
  }
}
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "invoice_address": "fibt100000000001ppn6qn73reuqzg7dwfhdvmzlr0rat8p2r7tygrav9ss9rxf4gmaa0c02vr07hk4hcfqrvjra6e4n2j5uvg9w5zr83lp3n72sqwykhcaumrrtsqyqpk25y5jegw6w2v8mqvk7etehgvfux9yvn9460fhw2p2t6angfqh7jv9mtekygg56k8t7wdqalux8d5u7md3dxzg5qr3h3l4m0hp8qugsf8fkcpwreq504pmjlkenm4lq85lmymg0sqhlwvjr320v80mptc48l0k57pnwdwkzcmjnstxsvkt0feskqnatqn8sn3ugs75zefar99n4m2532qyfkzc72ttttz3x296m2ntsjs8y4yk65qk8rpe7alwxduy75jdqa9dftwrzzu2xzq7defxuh4djq579ydlvpyq9v8jya080mu2csvqcgh6uj7q6lv6aye3zmwap36pv3aa927p8spz8hhdp",
    "invoice": {
      "currency": "Fibt",
      "amount": "0x2540be400",
      "signature": "16070301191e1d1f0e060d1c041e14120d001d050d090b0e0302021c0a0602001e0d1909061c17150d1200141e05040d1f0c010400050c0712041d0f070f1b1c0a18100c001808171a1c121e001a1f0c1a1d041911021b0e1d01111a010c111d1d050a1e01071001",
      "data": {
        "timestamp": "0x19f330d6557",
        "payment_hash": "0xff89e6562090c6c022d5d61e7c208f5a0502e97acf342c470494f8710a6e8066",
        "attrs": [
          {
            "description": "phase0-rusd"
          },
          {
            "final_htlc_minimum_expiry_delta": "0x927c00"
          },
          {
            "udt_script": "0x550000001000000030000000310000001142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a0120000000878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
          },
          {
            "payee_public_key": "03aaa9c8ca7667e7d5738b3beb75f647c13c143333fea3fcf882ec201549010e69"
          }
        ]
      }
    }
  }
}
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "payments": [],
    "last_cursor": null
  }
}
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "channels": [
      {
        "channel_id": "0x42eecd28448e5244a701a1cbc51dfa61469a4d24426f66a10dcf246ab0235e46",
        "is_public": true,
        "is_acceptor": false,
        "is_one_way": false,
        "channel_outpoint": "0x93774e2082948e2148757a912ee26fd872ec4a859e8427ab07f64e1363c2707f00000000",
        "pubkey": "03cc241e54ed971a27acfcf40df7674837578b54df61127e148a593a814215a669",
        "funding_udt_type_script": {
          "code_hash": "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
          "hash_type": "type",
          "args": "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
        },
        "state": {
          "state_name": "ChannelReady"
        },
        "local_balance": "0x3b9aca00",
        "offered_tlc_balance": "0x0",
        "remote_balance": "0x0",
        "received_tlc_balance": "0x0",
        "pending_tlcs": [],
        "latest_commitment_transaction_hash": "0x50aa9eb1a32b3079d59f823018539fb7002b52154bd86216a67f670a1862927d",
        "created_at": "0x19f330aee7c",
        "enabled": true,
        "tlc_expiry_delta": "0xdbba00",
        "tlc_fee_proportional_millionths": "0x3e8",
        "shutdown_transaction_hash": null,
        "failure_detail": null
      },
      {
        "channel_id": "0x70dcdf2eaec06b03b639f99b67bf4db368cd07b61bf2dbdcd1b971a1cc0fb01f",
        "is_public": true,
        "is_acceptor": false,
        "is_one_way": false,
        "channel_outpoint": "0xcbd168ed841a4cba357e8aa5968c9f37a19e5810f94f97578d432d3cb457f1d200000000",
        "pubkey": "03cc241e54ed971a27acfcf40df7674837578b54df61127e148a593a814215a669",
        "funding_udt_type_script": null,
        "state": {
          "state_name": "ChannelReady"
        },
        "local_balance": "0x5f5e100",
        "offered_tlc_balance": "0x0",
        "remote_balance": "0x0",
        "received_tlc_balance": "0x0",
        "pending_tlcs": [],
        "latest_commitment_transaction_hash": "0x2a084e96a9526b7226fe1e0facd8e8a78578fce28234d4f9e11fabe9e6752d14",
        "created_at": "0x19f32f91fa1",
        "enabled": true,
        "tlc_expiry_delta": "0xdbba00",
        "tlc_fee_proportional_millionths": "0x3e8",
        "shutdown_transaction_hash": null,
        "failure_detail": null
      }
    ]
  }
}
