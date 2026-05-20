# Testnet Register E2E Runbook (1Password `op run`)

A guided, copy-pasteable walkthrough to run the **full GNS `.goat` registration
flow on GOAT Testnet3** end-to-end, with the signing key sourced from 1Password
(never written to disk). Also covers the cross-chain x402 variant and the
giftcard purchase.

> Companion docs: `docs/WALLET-SECURITY.md` (key setup), `docs/E2E-TEST-REPORT.md`
> (what's already proven without a wallet). Run everything from the repo root
> `/home/r/projects/github/agentkit` on branch `feat/gns-giftcard-foundation`.

---

## 0. One-time prerequisites

1. **A dedicated testnet wallet.** Generate a fresh EVM private key used only
   for this — never a personal/mainnet key. (e.g. `cast wallet new`, or any
   wallet export.)
2. **Fund it on GOAT Testnet3 (chainId 48816):**
   - Native gas (testnet GOAT/BTC) + test USDC or USDT. Use the GOAT testnet
     faucet (see `https://gns.testnet3.goat.network` / GOAT docs). You need a
     few test-USDC (registration is ~3 tUSDC) plus a little gas.
3. **Store the key in 1Password.** Create an item, e.g.:
   - Item: `GOAT agent testnet`  → field `private_key` = `0x...`
4. **Verify the 1Password CLI is signed in:** `op whoami`.

---

## 1. Create the `.env` (references only — no secrets on disk)

```bash
cat > .env <<'EOF'
# 1Password reference — op run resolves this at launch, nothing hits disk:
GOAT_PRIVATE_KEY=op://Private/GOAT agent testnet/private_key

GOAT_NETWORK=goat-testnet
GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network
GNS_API_BASE_URL=https://gns-api.testnet3.goat.network/api
GIFTCARD_API_BASE_URL=https://giftcard-api.goat.network
EOF
```

`.env` is gitignored. It contains an `op://` **reference**, not the key.

---

## 2. Pre-flight (read-only — no key needed, run first to confirm wiring)

```bash
# These do not need op run — they are unauthenticated GETs:
node bin/gns.mjs --network goat-testnet doctor --json
node bin/gns.mjs --network goat-testnet search myagentname --json
node bin/gns.mjs --network goat-testnet price myagentname.goat --years 1 --token USDC --json
```

Confirm: `doctor` shows the API reachable; `search` shows your desired name is
`available`; `price` returns a quote (~3 tUSDC). Pick a name that is available.

---

## 3. Dry-run the register flow (no transaction, validates the plan)

```bash
DEMO_MOCK=true node bin/gns.mjs register myagentname.goat \
  --years 1 --token USDC --reverse \
  --description "My AI agent" --url https://example.com \
  --dry-run --json
```

Expect exit 0 and a printed plan:
`['estimatePrice','commit','waitForCommitment','register','setProfileRecords','setPrimaryName']`.

---

## 4. Real register — full flow via `op run`

This single command runs **commit → poll the 60s reveal window → register →
set profile records → set primary name**. The poll loop (added so the flow
completes in one invocation) waits up to `--wait-timeout` seconds.

```bash
op run --env-file=.env -- node bin/gns.mjs register myagentname.goat \
  --years 1 --token USDC --reverse \
  --description "My AI agent" --url https://example.com \
  --wait-timeout 180 --poll-interval 10
```

What you'll see, in order:
1. **estimatePrice** — quote echoed.
2. **commit** — a commit tx hash. (This is the on-chain commitment; the secret
   is generated locally and kept in-process, redacted from logs.)
3. **waitForCommitment polling** — `commit not yet revealable; polling again in
   10s (timeout in Ns)` repeated for ~60s until the reveal window opens.
4. **register** — the registration tx hash; ~400k gas.
5. **setProfileRecords** — resolver multicall tx (because you passed
   `--description`/`--url`).
6. **setPrimaryName** — reverse-record tx (because you passed `--reverse`).

You'll be prompted to confirm each high-risk on-chain action (commit, register
are `requiresConfirmation`). Add `--auto-confirm` only if you trust the inputs
and want it unattended.

**If it times out** waiting for the reveal window (slow block production), just
re-run the same command — the on-chain commit persists up to `maxCommitmentAge`
(24h), and re-running picks a fresh secret + new commit only if needed. (For a
clean retry, simply run register again; it will commit anew.)

---

## 5. Verify on-chain

```bash
op run --env-file=.env -- node bin/gns.mjs lookup myagentname.goat --json
op run --env-file=.env -- node bin/gns.mjs my-names "$(op read 'op://Private/GOAT agent testnet/private_key' >/dev/null; echo YOUR_WALLET_ADDRESS)" --json
```

- `lookup` should show `status: registered`, your owner address, the expiry
  (~1 year out), your description/url records, and `primaryName: true`.
- Cross-check the register tx on the explorer:
  `https://explorer.testnet3.goat.network/tx/<register-tx-hash>`.
- The name resolves: `lookup` returns the resolver address + records.

---

## 6. Cross-chain x402 variant (pay from a non-GOAT chain)

If you'd rather pay from, say, Base testnet USDC instead of GOAT-side tUSDC,
use the x402 flow. This needs **two** keys (GOAT for the adaptor signature,
the source chain for the ERC-20 transfer):

```bash
# Add to .env:
#   PAYMENT_CHAIN_PRIVATE_KEY=op://Private/Base agent testnet/private_key
#   PAYMENT_CHAIN_RPC_URL=https://sepolia.base.org   (or your Base testnet RPC)
#   PAYMENT_CHAIN_ID=84532

op run --env-file=.env -- node bin/gns.mjs x402-register myagentname.goat \
  --pay-chain 84532 --pay-token USDC --years 1
```

Flow: commit on GOAT → `x402.createOrder` → sign the calldata with the
GOAT-bound signer → `x402.submitSignature` → switch to the source-chain signer →
`x402.payOrder` (ERC-20 transfer on the pay chain) → poll
`x402.getOrderStatus` until `PAYMENT_CONFIRMED`. The backend adaptor then
settles the registration on GOAT.

---

## 7. Giftcard purchase E2E (production API, pay from any supported chain)

```bash
# Browse (no key):
node bin/giftcard.mjs list-brands --country US --json
node bin/giftcard.mjs list-chains --json
node bin/giftcard.mjs get-brand <brand-id-from-list> --json

# Buy (needs a funded wallet on the chosen pay chain; auth is automatic):
op run --env-file=.env -- node bin/giftcard.mjs buy \
  --brand <brand-id> --face-value 50 --pay-chain 8453 --pay-token USDC
```

Flow: createOrder (adapter auto-auths via EIP-712 → Bearer) → payOrder
(ERC-20 transfer on `--pay-chain`) → polls getOrder until `FULFILLED` → prints
the card code. Add `--reveal-secrets` to print the card code/PIN in the clear
(only do this on an interactive terminal — see the stdout-capture caveat in
`docs/WALLET-SECURITY.md`).

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `doctor` API check fails | RPC/API rate-limited or down; retry, or set your own RPC in `.env`. |
| `register` says "commit not yet revealable" repeatedly then times out | Slow testnet blocks; raise `--wait-timeout 300` and re-run. |
| `register` reverts `nameNotAvailable` | Someone registered it between your `search` and `commit`. Pick another name. |
| `INVALID_INPUT: insufficient allowance` | Your wallet hasn't approved the controller for the payment token; the flow uses permit when available — ensure the token supports EIP-2612, or pre-approve. |
| `chain_mismatch` on x402 payOrder / giftcard buy | Your `PAYMENT_CHAIN_*` wallet is on a different chainId than `--pay-chain`. Fix the RPC/key for the right chain. |
| `op run` can't resolve the reference | `op whoami` to confirm sign-in; check the item/field path matches your vault exactly. |
| Card code not shown after FULFILLED | Re-run `giftcard status <order-id> --reveal-secrets`. |

---

## 9. What this proves

A successful run exercises, on real testnet infrastructure: name availability →
pricing → commit/reveal timing → on-chain registration (ERC-721 mint) → resolver
record writes → reverse-record (primary name) → and, in the x402 path, the full
cross-chain settlement. That is the complete GNS business flow. The giftcard run
exercises catalog → EIP-712 auth → order creation → on-chain stablecoin payment →
fulfillment → card delivery.
