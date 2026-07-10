# Fiber Merchant Toolkit

A Node.js toolkit for merchants accepting **RUSD** (a UDT stablecoin) payments over the **Fiber Network** — a CKB-based Lightning-style payment channel network. Handles the post-payment merchant workflow: invoice creation, signed payment receipts, and settlement CSV export.

Built and verified against a real, running **fnn v0.8.1** node (not just documentation) — see [`docs/rpc-samples.md`](./docs/rpc-samples.md) for captured ground-truth RPC responses and [Verified facts and corrections](#verified-facts--corrections-from-real-node-testing) below for places where upstream docs were wrong.

---

## Features

1. **Invoice creation** — generate RUSD-denominated Fiber invoices (`invoice.js`)
2. **Payment receipts** — poll for payment, then produce a signed (Ed25519), tamper-evident PDF receipt (`receipt.js`)
3. **Settlement export** — query a local SQLite ledger and export CSV settlement reports for a date range, with best-effort reconciliation against the node's own payment history (`settlement.js`, `store.js`)

A thin Express server (`packages/server`) exposes these as HTTP endpoints, and a plain HTML/JS frontend (`packages/web`) provides a merchant-facing UI.

---

## Project structure

```
fiber-merchant-toolkit/
  packages/
    core/               # reusable npm package, no HTTP concerns
      src/
        rpcClient.js     # JSON-RPC 2.0 client over fetch, targets the real fnn RPC port
        amount.js        # BigInt-only decimal <-> hex smallest-unit conversion
        invoice.js       # Feature 1 — RUSD invoice creation
        receipt.js       # Feature 2 — poll, sign, PDF receipt
        settlement.js    # Feature 3 — CSV export + best-effort list_payments reconciliation
        store.js         # SQLite-backed local invoice/receipt ledger
        index.js         # package entry point
      test/              # unit tests (mocked RPC) + integration tests (real node, gated)
    server/               # thin Express wrapper over core
      src/index.js
      test/
    web/                  # static frontend (plain HTML/fetch, no framework)
      index.html
      test/
  docs/
    rpc-samples.md        # real captured RPC responses — ground truth for all field names/shapes
  .env.example
  .gitignore
  package.json             # npm workspaces (core, server, web)
```

---

## Status

All phases complete, verified against a real two-node local fnn v0.8.1 testnet.

| Phase | Scope                                                | Status                          |
| ----- | ---------------------------------------------------- | ------------------------------- |
| 0     | Real fnn v0.8.1 node setup, RPC ground-truth capture | ✅ Complete                     |
| 1     | Repo scaffolding, npm workspaces, mock RPC transport | ✅ Complete                     |
| 2     | `rpcClient.js`, `amount.js`                          | ✅ Complete, real-node verified |
| 3     | Feature 1 — invoice creation                         | ✅ Complete, real-node verified |
| 4     | Feature 2 — payment receipts                         | ✅ Complete, real-node verified |
| 5     | Feature 3 — settlement CSV export                    | ✅ Complete, real-node verified |
| 6     | Express server                                       | ✅ Complete                     |
| 7     | Frontend                                             | ✅ Complete                     |
| 8     | Security & deployment                                | ✅ Complete                     |

`packages/core` unit test suite: 90 tests total (84 passing + 6 skipped when `FNN_RPC_URL`/`FNN_RPC_URL_2` aren't set locally).

---

## Requirements

- **Node.js ≥ 22.5.0** (required by `store.js`, which uses the built-in `node:sqlite` module — no native SQLite dependency)
- A running `fnn` v0.8.1 node (or two, for full integration testing) — see [Running a local fnn node](#running-a-local-fnn-node)

---

## Getting started

```bash
npm install
npm test
```

This runs the full unit test suite (mocked RPC transport, no live node required) across all three workspaces.

### Running integration tests against a real node

Integration tests are gated behind environment variables and skipped otherwise:

```bash
FNN_RPC_URL=http://127.0.0.1:8227 \
FNN_RPC_URL_2=http://127.0.0.1:8327 \
npm run test:core
```

- `FNN_RPC_URL` — required for invoice/settlement integration tests
- `FNN_RPC_URL_2` — required additionally for receipt integration tests (cross-node payment flow)

### Running the server

```bash
cp .env.example .env   # fill in RPC URL, signing key, etc.
npm run start --workspace=packages/server
```

Endpoints:

- `POST /invoice` — create an invoice
- `GET /receipt/:hash` — `404` unknown hash, `202 {status:"Open"}` if unpaid, `200` PDF if paid
- `GET /export?from=&to=` — CSV settlement export for a date range
- `GET /healthz` — health check

---

## Running a local fnn node

For development/integration testing, a two-node local testnet setup was used throughout:

```
Node 1: RPC 127.0.0.1:8227, P2P 0.0.0.0:8228, dir ~/fnn-node
Node 2: RPC 127.0.0.1:8327, P2P 0.0.0.0:8329, dir ~/fnn-node-2
```

1. Build `fnn` v0.8.1 from source (`git checkout v0.8.1 && cargo build --release`).
2. Use the v0.8.1 `config/testnet/config.yml`, with unique RPC **and** P2P ports per node.
3. Create CKB keypairs in **user-owned** directories (avoid `sudo` — it causes root-owned-directory permission issues).
4. Start both nodes with `FIBER_SECRET_KEY_PASSWORD` set.
5. Connect the peers via `connect_peer` using the base58 libp2p `PeerId` from each node's startup log (**not** the hex `pubkey` from `node_info`).
6. Fund with testnet RUSD via the [Stable++ faucet](https://testnet0815.stablepp.xyz/faucet) → claim into a JoyID wallet → transfer to the node's testnet CKB address.
7. Open channels with `open_channel` (note: takes `pubkey`, not `peer_id`).

Full verified log of this process is in Section 2 of the original build plan and `docs/rpc-samples.md`.

---

## Verified facts & corrections (from real-node testing)

Several assumptions from upstream docs/READMEs did not match the real fnn v0.8.1 node and were corrected during development:

- **`list_payments` exists** on v0.8.1, despite being missing/unclear in some docs — but it tracks **payments a node has sent**, not invoices it has received. This is why settlement export uses a local SQLite ledger as the source of truth, with `list_payments` used only for best-effort reconciliation.
- **`new_invoice` requires a `currency` field** (`Fibb`/`Fibt`/`Fibd`), separate from `udt_type_script`.
- **Invoice response shape is deeply nested** — e.g. `result.invoice.data.payment_hash`, not a top-level field. No absolute expiry timestamp is returned; it must be computed client-side from `data.timestamp + final_htlc_minimum_expiry_delta` (both milliseconds).
- **`open_channel` takes `pubkey`, not `peer_id`** — the develop-branch RPC README is out of sync with v0.8.1 here.
- **`accept_channel` enforces the reserve minimum on the acceptor too**, not just the channel opener.
- **fnn's JSON-RPC methods take positional params**, even for single-argument calls (`params: [obj]`, not a named object) — because they're jsonrpsee handlers matching on Rust argument position, not name. Some methods with all-optional fields (like `list_payments`) still require an explicit empty struct (`[{}]`) rather than an empty array.
- **RUSD (UDT) payments currently cannot complete** on this test network — upstream fnn checks a gossip-derived `outbound_liquidity` figure (see [nervosnetwork/fiber#1133](https://github.com/nervosnetwork/fiber/pull/1133)) that is never populated for UDT channels on this network, regardless of real channel balance. Confirmed via a control test: plain CKB-native payments succeed immediately between the same two nodes. This is an upstream network limitation, not a bug in this codebase — revisit if a newer fnn release changes UDT liquidity gossip behavior.

See `docs/rpc-samples.md` for the full set of captured request/response samples backing every field name and shape used in the code.

---

## Security notes

- Private signing key and RPC URL are supplied via environment variables and are never committed; `.env.example` is committed in their place.
- Run HTTPS in front of the Express server in production.
- The fnn RPC port should not be exposed beyond localhost/trusted hosts, per the upstream RPC README's warning.
- Preimages, private keys, and raw RPC payloads containing them are never logged.
- Receipts are signed with Ed25519 (Node's built-in `crypto` module, no external signing dependency) and are independently verifiable via `verifyReceipt()` using the published public key (JWK), which travels alongside each receipt.

---

## Testing philosophy

Every module is testable in isolation via an injectable mock RPC transport (`packages/core/test/mockRpcTransport.js`), so unit tests never require a live node. Each phase additionally has an integration test suite, gated behind `FNN_RPC_URL`/`FNN_RPC_URL_2`, that has been run at least once against a real two-node fnn testnet — not just mocks. Field names and response shapes used anywhere in the code trace back to a real captured sample in `docs/rpc-samples.md`, not assumed names from README prose.
