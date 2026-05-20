# Wallet & Private Key Security Guide

How to configure signing keys for the agentkit GNS / giftcard write flows
safely. **Yes, 1Password works well** — it is the recommended option for both
local development and CI. This guide covers 1Password plus the alternatives,
ranked by safety.

> TL;DR: never put a raw private key in a committed `.env`, in shell history,
> or in a CLI flag. Inject it at runtime from a secret manager (1Password is
> great), keep testnet and mainnet keys in separate items, and use a
> dedicated low-balance hot wallet for agents — never your main wallet.

---

## 1. How agentkit reads keys today

The SDK never reads keys on its own. Keys enter only through the **example
scripts** and the **CLI** (`bin/_lib/wallet-from-env.ts`), via environment
variables:

| Env var | Used for |
|---------|----------|
| `GOAT_PRIVATE_KEY` | GOAT-side signing (commit / register / resolver writes, x402 auth on chainId 2345) |
| `PAYMENT_CHAIN_PRIVATE_KEY` | source-chain ERC-20 transfer for cross-chain x402 / giftcard payOrder (falls back to `GOAT_PRIVATE_KEY` if unset) |
| `GOAT_MAINNET_RPC_URL` / `GOAT_TESTNET_RPC_URL` | RPC endpoints (no secret) |
| `PAYMENT_CHAIN_RPC_URL` / `PAYMENT_CHAIN_ID` | source-chain RPC + chainId |
| `DEMO_MOCK=true` | bypass real signing entirely (NoopWalletProvider) — for dry runs |

Because everything is an env var, you can source keys from any secret manager
without changing code. The key is **never** persisted by agentkit; it lives
only in the process environment for the lifetime of the command.

---

## 2. Recommended: 1Password

### 2a. Local development — `op run` (best for interactive use)

Store the key as a field in a 1Password item, then reference it from a
**non-secret** `.env` template. `op run` injects the real value into the
process environment at launch and never writes it to disk.

1. Put the key in 1Password (item e.g. `GOAT agent testnet`, field `private_key`).
2. Create `.env` with **secret references**, not the secret itself (this file is
   safe to commit if you want, though `.env` is gitignored by default):
   ```bash
   # .env  — contains REFERENCES, not secrets
   GOAT_PRIVATE_KEY=op://Private/GOAT agent testnet/private_key
   GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network
   GOAT_NETWORK=goat-testnet
   ```
3. Run any command through `op run`:
   ```bash
   op run --env-file=.env -- pnpm example:gns-register
   op run --env-file=.env -- node bin/gns.mjs register alice.goat --years 1 --token USDC
   ```
   `op run` resolves every `op://...` reference, injects the real value into the
   subprocess environment, and the secret never touches disk or shell history.

### 2b. One-off read — `op read`

```bash
GOAT_PRIVATE_KEY=$(op read "op://Private/GOAT agent testnet/private_key") \
  node bin/gns.mjs lookup alice.goat
```
Good for quick commands. The value is still exposed in the process env (and
briefly in the `op` subprocess), so prefer `op run` for anything scripted.

### 2c. CI / automation — 1Password Service Account

For unattended runs (CI, a scheduled agent), use a **Service Account token**
instead of an interactive login:

```bash
export OP_SERVICE_ACCOUNT_TOKEN=ops_xxx   # stored as a CI secret, not in the repo
op run --env-file=.env -- pnpm test:e2e
```
Scope the service account to a single vault that holds **only** the agent's
testnet key. Rotate the token on a schedule.

---

## 3. Alternatives (if you don't use 1Password)

Ranked best → acceptable:

1. **OS keychain via a launcher** — macOS Keychain (`security find-generic-password`),
   `pass` (GPG-backed), `gopass`. Same pattern as `op read`: resolve into an env
   var at launch.
2. **Cloud secret managers** — AWS Secrets Manager / GCP Secret Manager / Vault.
   Fetch at process start, inject as env var. Best for server deployments.
3. **`.env` file (gitignored), local dev only** — acceptable for a *throwaway
   testnet* key on your own machine. The repo already gitignores `.env`. Never
   do this for a mainnet key. `chmod 600 .env`.
4. **Hardware wallet / external signer** — for mainnet, prefer a signer that
   never exposes the raw key (Ledger, a remote KMS signer). agentkit's
   `WalletProvider` is an interface — you can implement a `WalletProvider` that
   delegates `signTypedData` / `writeContract` to a KMS or hardware signer and
   pass it in instead of an `EvmWalletProvider` built from a raw key. This is
   the safest mainnet path.

---

## 4. Hard rules (any backend)

- **Dedicated hot wallet.** Create a fresh key used *only* by the agent, funded
  with the minimum needed. Never reuse a personal wallet or a treasury key.
- **Separate testnet and mainnet keys.** Different 1Password items / vaults.
  A leaked testnet key costs nothing; a reused key that's also on mainnet is a
  loss. The plan's network model makes this easy — testnet defaults are baked
  in, mainnet is opt-in.
- **Never as a CLI flag.** Flags land in shell history and `ps` output. agentkit
  intentionally has **no `--private-key` flag** — keys come only from env.
- **Never logged.** The runtime redacts `secret` and card fields from hook
  events (`sensitiveInputFields` / `sensitiveOutputFields`), and the CLI sends
  its logger to stderr while keeping stdout clean. Don't add `console.log(key)`.
- **Never committed.** `.env`, `.docs/`, and `dist-manifests/` are gitignored.
  Double-check with `git status` before committing.
- **Scope RPC URLs too.** Use your own RPC API keys; the public defaults are
  rate-limited and fine for testing but not for production throughput.
- **Confirmation gates stay on.** Write actions are `requiresConfirmation: true`
  and `riskLevel: high`. Don't pass `--auto-confirm` in an unattended context
  unless you fully trust the inputs.

---

## 5. Quick start for the E2E tests in this repo

For **read-only** testing you need **no key at all** — availability checks,
price quotes, brand catalog, and supported-token lists are all unauthenticated
GETs against the production / testnet APIs.

For **write** testing (commit/register, payOrder) on **testnet3**:

```bash
# 1. Put a funded testnet key in 1Password (item: "GOAT agent testnet").
#    Fund it with testnet GOAT gas + test USDC/USDT from the faucet.
# 2. .env with references:
cat > .env <<'EOF'
GOAT_PRIVATE_KEY=op://Private/GOAT agent testnet/private_key
GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network
GOAT_NETWORK=goat-testnet
GNS_API_BASE_URL=https://gns-api.testnet3.goat.network/api
GIFTCARD_API_BASE_URL=https://giftcard-api.goat.network
EOF
# 3. Run through op:
op run --env-file=.env -- node bin/gns.mjs register alice.goat --years 1 --token USDC
```

Without a key, run the same flows with `DEMO_MOCK=true` to validate the wiring
end-to-end without sending a transaction:

```bash
DEMO_MOCK=true node bin/gns.mjs x402-register alice.goat --pay-chain 8453 --pay-token USDC --years 1 --dry-run
```
