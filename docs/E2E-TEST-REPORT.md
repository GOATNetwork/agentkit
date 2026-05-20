# GNS + Giftcard End-to-End Test Report

**Date:** 2026-05-20
**Branch:** `feat/gns-giftcard-foundation`
**Repo:** `/home/r/projects/github/agentkit` (+ sibling `agent-skills` skill bundles)

## Environment note

This run was executed **without any funded wallet or private key** in the
environment (`GOAT_PRIVATE_KEY` / `PAYMENT_CHAIN_PRIVATE_KEY` unset). Therefore:

- **Read-only flows** (search, lookup, price, brand/chain catalogs, doctor) were
  run **LIVE** against the real GNS testnet3 API (`https://gns-api.testnet3.goat.network/api`)
  and the production giftcard API (`https://giftcard-api.goat.network`). No wallet needed.
- **Write flows** (commit / register / x402 payOrder / giftcard payOrder) were run
  in **`DEMO_MOCK=true` + `--dry-run`** mode to validate wiring (plan derivation,
  input validation, brand/product resolution) **without sending any transaction**.
- The full on-chain write E2E (which requires a funded testnet wallet) is documented
  as a runbook in **Section 5**, referencing `docs/WALLET-SECURITY.md` for key setup.

CLI exit-code convention (`bin/_lib/command-runner.ts`):
`0 SUCCESS`, `1 USER_INPUT`, `4 POLICY_BLOCKED`, `5 CHAIN_OR_STATE`, `10 ADAPTER`, `99 UNKNOWN`.

---

## Section 1: GNS read-only live results

API base: `https://gns-api.testnet3.goat.network/api` (network `goat-testnet`). All real network calls.

| Command | Exit | Result |
|---------|:----:|--------|
| `node bin/gns.mjs --network goat-testnet search alice --json` | 0 | `available:false, status:"registered"` for `alice.goat`. Live API hit, ~4s. |
| `node bin/gns.mjs --network goat-testnet lookup alice.goat --json` | **99** | **FAILED — `INVALID_OUTPUT`: "socialLinks: Expected object, received array".** Code defect, not env (see note below). |
| `node bin/gns.mjs --network goat-testnet price alice.goat --years 1 --token USDC --json` | 0 | `currency:"tUSDC", registrationFee:"3", total:"3", totalWei:"3000000000000000000", durationSeconds:"31536000"`. |
| `node bin/gns.mjs --network goat-testnet doctor --json` | 0 | `api.ok:true (status 404 on health probe — expected, treated as reachable)`; `wallet.configured:false` ("GOAT_PRIVATE_KEY not set"). |
| `node scripts/sync-skill-manifests.mjs` | 0 | Wrote `dist-manifests/gns.manifest.json` + `dist-manifests/giftcard.manifest.json`. |

**Skill bundle helper** (`agent-skills/packages/skill-gns-registry/scripts/gns-api.mjs`, `--network testnet3`):

| Command | Exit | Result |
|---------|:----:|--------|
| `gns-api.mjs --network testnet3 search alice` | 0 | `alice.goat → status:"registered"`, route `/name?name=alice.goat`. Live API. |
| `gns-api.mjs --network testnet3 config` | 0 | merchant `ENS_ON_GOAT`, `receiveType:DELEGATE`, chain `48816 (GOAT Testnet3)` token `TUSDT` @ `0x030B2C744Fa080D97c0033214dEF6384f763aB21`. |

### Defect found (genuine, reproducible) — `lookup` output-schema mismatch

`node bin/gns.mjs lookup alice.goat` fails output validation. The live API
(`GET /api/names/details?name=alice.goat`) returns `socialLinks` as a **JSON array**
(`"socialLinks": []` when empty), but the action's Zod output schema declares it as
an object:

- `plugins/gns/actions/get-name-details.ts:39` → `socialLinks: z.record(z.string()).optional()`
- `plugins/gns/adapters/types.ts:59` → `socialLinks?: Record<string, string>`

Because the runtime validates output (pipeline step 5), an empty `[]` (or any array)
trips `INVALID_OUTPUT` and the CLI exits `99`. This is a **code bug**, not an environment
limitation. Suggested fix: accept either shape, e.g.
`z.union([z.record(z.string()), z.array(z.any())]).optional()` (or normalize the array→object
in the adapter `mapNameDetails`). All other GNS read paths validate cleanly against the live API.

---

## Section 2: Giftcard read-only live results

API base: `https://giftcard-api.goat.network` (production). All real network calls.

| Command | Exit | Result |
|---------|:----:|--------|
| `node bin/giftcard.mjs list-brands --country US --json` | 0 | Live catalog returned. Real US brands incl. **Airbnb** `id 0a84cf2b-4fc7-43e7-886c-c8f531f8aefb`, Apple `ece9f490-...`, DoorDash `2613525c-...`, Starbucks `09112610-...`, Uber `b9fa819e-...`. |
| `node bin/giftcard.mjs list-chains --json` | 0 | Supported pay chains/tokens: chain 1 (USDC/USDT), 10, 56, **2345 (GOAT)** USDC `0x3022b8...`, **8453 (Base)** USDC `0x833589...`, etc. |
| `node bin/giftcard.mjs doctor --json` | 0 | `api.ok:true (status 404 health probe — reachable)`; `wallet.configured:false` ("GOAT_PRIVATE_KEY not set"). |
| `skill-giftcard-purchase/scripts/giftcard-api.mjs supported-tokens` | 0 | Same supported-token list as `list-chains` (chains 1/10/56/2345/8453, USDC + USDT). Live API. |

No defects observed in the giftcard read paths.

---

## Section 3: Write-path DEMO_MOCK validation (no tx sent)

Run with `DEMO_MOCK=true` + `--dry-run`. The wiring (input validation, plan derivation,
brand→product resolution) executed; no signer was used and no transaction was broadcast.

| Command | Exit | Planned steps printed |
|---------|:----:|------------------------|
| `gns register alice-demo.goat --years 1 --token USDC --owner 0x..01 --dry-run` | 0 | `["estimatePrice", "commit", "waitForCommitment", "register"]` — owner `0x..01`, years 1, token USDC. |
| `gns x402-register alice-demo.goat --pay-chain 8453 --pay-token USDC --years 1 --dry-run` | 0 | `["commit", "x402.createOrder", "x402.submitSignature", "x402.payOrder", "x402.getOrderStatus"]` — payChain 8453 (Base), payToken USDC. |
| `giftcard buy --brand 0a84cf2b-...(Airbnb) --face-value 50 --pay-chain 8453 --pay-token USDC --dry-run` | 0 | `["createOrder", "payOrder", "poll getOrder until FULFILLED"]` — resolved live to product `565f7b76-4f3f-4653-aabf-083a1026c7e9`, faceValue 50, payChain 8453, payToken USDC. |

Note: the giftcard `buy` dry-run still performed a **live** `getBrand` call to resolve the
product id from the supplied brand id (trace `goat.giftcard.getBrand` succeeded), confirming
the read→write handoff is wired correctly even in dry-run.

---

## Section 4: Automated integration + skill test results

**agentkit integration suites** (`npx vitest run`):

```
Test Files  4 passed (4)
     Tests  14 passed (14)
```
Files: `gns-flow.test.ts`, `gns-x402-flow.test.ts`, `giftcard-flow.test.ts`,
`giftcard-idempotency.test.ts`. Includes the GNS commit→wait→register binding-mismatch
guard and the giftcard idempotency path. All green.

**Skill bundle suites** (`node --test`):

| Suite | tests | pass | fail |
|-------|:-----:|:----:|:----:|
| `skill-gns-registry/test/*.mjs` | 21 | 21 | 0 |
| `skill-giftcard-purchase/test/*.mjs` | 21 | 21 | 0 |

**Total automated: 56 tests, 56 passing, 0 failing.** (These do not exercise the live
`lookup` output schema, which is why the Section 1 defect is not caught by CI today.)

---

## Section 5: Full on-chain E2E runbook (requires a funded testnet wallet)

A human with a funded **testnet3** wallet can complete the real write E2E. Set up the
signing key per `docs/WALLET-SECURITY.md` — recommended is 1Password `op run` so the key
never touches disk or shell history. There is intentionally **no `--private-key` flag**;
keys come only from env (`GOAT_PRIVATE_KEY`, optionally `PAYMENT_CHAIN_PRIVATE_KEY`).

### 0. Prerequisites
- A dedicated low-balance hot wallet (never a personal/mainnet key — `docs/WALLET-SECURITY.md` §4).
- Fund it with testnet GOAT gas + test USDC/USDT from the faucet.
- `.env` with **references** (not secrets), e.g.:
  ```bash
  GOAT_PRIVATE_KEY=op://Private/GOAT agent testnet/private_key
  GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network
  GOAT_NETWORK=goat-testnet
  GNS_API_BASE_URL=https://gns-api.testnet3.goat.network/api
  GIFTCARD_API_BASE_URL=https://giftcard-api.goat.network
  ```
- Verify wiring first: `op run --env-file=.env -- node bin/gns.mjs doctor --json`
  → expect `wallet.configured:true`.

### 1. GNS native register (commit → wait 60s → register)
The flow auto-handles the commit reveal delay; the controller enforces a minimum
commitment age (~60s on testnet3).
```bash
op run --env-file=.env -- node bin/gns.mjs register myname.goat \
  --years 1 --token USDC --owner <your-address> --auto-confirm
```
Internally: `estimatePrice → commit (tx 1) → waitForCommitment (~60s) → register (tx 2)`,
then optional set-records / set-primary. Capture both tx hashes from the JSON output.

### 2. Cross-chain x402 register (paid from another EVM chain, e.g. Base 8453)
Requires a source-chain ERC-20 balance; set `PAYMENT_CHAIN_PRIVATE_KEY`/`PAYMENT_CHAIN_RPC_URL`/
`PAYMENT_CHAIN_ID` if the payer differs from the GOAT signer.
```bash
op run --env-file=.env -- node bin/gns.mjs x402-register myname2.goat \
  --pay-chain 8453 --pay-token USDC --years 1 --auto-confirm
```
Flow: `commit → x402.createOrder → x402.submitSignature (EIP-712) → x402.payOrder (source-chain transfer) → x402.getOrderStatus (poll to settled) → register`.

### 3. Giftcard buy (createOrder → payOrder → poll FULFILLED)
```bash
op run --env-file=.env -- node bin/giftcard.mjs buy \
  --brand 0a84cf2b-4fc7-43e7-886c-c8f531f8aefb \  # Airbnb (or any id from `list-brands`)
  --face-value 50 --pay-chain 8453 --pay-token USDC --auto-confirm
```
Flow: `createOrder → payOrder (ERC-20 transfer on the pay chain) → poll getOrder until FULFILLED`.
The card code/pin/link are sensitive — they are redacted by default; use `--reveal-secrets`
on `status`/`list-orders` only in a trusted terminal.

### Explorer verification
For every on-chain step, confirm the tx on the testnet3 block explorer:

- **https://explorer.testnet3.goat.network** — search the tx hash(es) from the JSON output.
- For GNS register: verify the registrar/controller `register` tx is confirmed, then
  `node bin/gns.mjs lookup myname.goat` should show `status:"registered"` with your `owner`.
  (Note the Section 1 `lookup` schema bug may surface; `search` will still confirm registration.)
- For x402 / giftcard: verify the source-chain ERC-20 transfer tx on that chain's explorer
  (e.g. Base) plus the GOAT-side settlement, and that the order reaches `FULFILLED`.

> Keep confirmation gates on (`requiresConfirmation:true`, `riskLevel:high`). Only pass
> `--auto-confirm` in a trusted/unattended context per `docs/WALLET-SECURITY.md` §4.

---

## Section 6: Verdict

**Proven by this run (no wallet required):**
- GNS testnet3 API is live and reachable; `search`, `price`, and `doctor` work end-to-end
  through the full runtime pipeline (validation → policy → execute → output validation).
- Giftcard production API is live and reachable; `list-brands`, `list-chains`/`supported-tokens`,
  and `doctor` work end-to-end, returning real brand and supported-token data.
- Both sibling skill-bundle helpers (`gns-api.mjs`, `giftcard-api.mjs`) work against the live APIs.
- Write-path **wiring** is validated via `DEMO_MOCK` dry-runs: all three flows (native register,
  cross-chain x402 register, giftcard buy) derive correct step plans and resolve dependencies
  (incl. live brand→product lookup) without sending a transaction.
- Automated suites: **56/56 tests pass** (14 agentkit integration + 21 + 21 skill tests).
- Skill manifests regenerate cleanly.

**One genuine defect found:** `gns lookup` fails `INVALID_OUTPUT` because the live API returns
`socialLinks` as an array while the output schema expects an object
(`plugins/gns/actions/get-name-details.ts:39`). This is a code bug, reproducible against the
live testnet, and is not covered by current CI. Fix recommended before relying on `lookup`.

**Still blocked on a funded wallet (NOT exercised here):**
- Actual on-chain transactions: GNS `commit`/`register` (and the ~60s reveal wait),
  cross-chain x402 ERC-20 payment + settlement, and giftcard `payOrder` + fulfillment.
- Real signer behavior (EIP-712 signing, gas estimation against a funded account) and
  block-explorer confirmation. These require the Section 5 runbook with a funded testnet3 key.

**Bottom line:** the read-only surface and the entire write-path wiring are verified and
healthy against live infrastructure; the only outstanding code issue is the `lookup`
`socialLinks` schema mismatch. Money-moving steps remain to be validated by a human with a
funded testnet wallet using the Section 5 runbook.
