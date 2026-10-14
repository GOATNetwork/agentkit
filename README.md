# GOAT AgentKit — Overview

## One-Liner

The GOAT Network counterpart to Coinbase AgentKit — a TypeScript SDK enabling AI Agents to autonomously execute on-chain operations on the GOAT chain.

---

## Repository Structure

```
agentkit/
├── core/           # Runtime engine (policy, validation, idempotency, retry, metrics, timeout, hooks)
├── plugins/        # 16 feature modules (129 Actions)
├── adapters/       # 5 AI framework adapters
├── providers/      # Action registry + tool manifest generation
├── networks/       # GOAT chain adapter layer (mainnet / testnet)
├── packages/       # Independent packages (create-goat-agent CLI)
├── bin/            # End-user CLI binaries (agentkit-gns, agentkit-giftcard, agentkit-paykit)
├── examples/       # Minimal runnable examples
├── tests/          # Unit + integration tests
└── docs/           # Design documents
```

### Four-Layer Architecture

| Layer         | Responsibility                                                                        | Key File                            |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| **Core**      | Runtime engine: Policy → Validation → Idempotency → Retry → Metrics → Timeout → Hooks | `core/runtime/execution-runtime.ts` |
| **Plugins**   | Concrete implementations of on-chain operations (each plugin is a group of Actions)   | `plugins/*/actions/*.ts`            |
| **Adapters**  | Convert Actions into tool formats for each AI framework                               | `adapters/*/tools.ts`               |
| **Providers** | Action registration, discovery, and JSON Schema tool manifest generation              | `providers/action-provider.ts`      |

---

## Quick Start

### Option 1: CLI Scaffolding (recommended)

```bash
npm create goat-agent
# Follow prompts: project name → preset (minimal/defi/full) → network
cd my-agent && pnpm start
```

### Option 1b: End-User CLIs (no project setup)

```bash
# GOAT Name Service — register / renew / lookup .goat names
npx -p @goatnetwork/agentkit agentkit-gns --help

# x402 Giftcard purchase — browse brands, pay cross-chain, track orders
npx -p @goatnetwork/agentkit agentkit-giftcard --help

# Public GOAT Flow PayKit — crypto, products, MPP, card links and recovery
npx -p @goatnetwork/agentkit agentkit-paykit --help
```

The GNS and giftcard CLIs read configuration from environment variables (`GOAT_PRIVATE_KEY`, `GNS_API_BASE_URL`, `GIFTCARD_API_BASE_URL`, `DEMO_MOCK`, …) and ship interactive `doctor` subcommands for env diagnosis.

### Option 2: Manual Installation

```bash
npm install @goatnetwork/agentkit
```

```typescript
import { ActionProvider } from '@goatnetwork/agentkit/providers';
import { PolicyEngine, ExecutionRuntime } from '@goatnetwork/agentkit/core';
import { NoopWalletProvider } from '@goatnetwork/agentkit/core';
import { walletBalanceAction, transferErc20Action, NoopWalletReadAdapter } from '@goatnetwork/agentkit/plugins';

const wallet = new NoopWalletProvider(); // Replace with EvmWalletProvider or ViemWalletProvider for production

const provider = new ActionProvider();
provider.register(walletBalanceAction(new NoopWalletReadAdapter()));
provider.register(transferErc20Action(wallet));

const policy = new PolicyEngine({
  allowedNetworks: ['goat-testnet'],
  maxRiskWithoutConfirm: 'low',
  writeEnabled: true,
});

const runtime = new ExecutionRuntime(policy, { maxRetries: 2, retryDelayMs: 200 });

const result = await runtime.run(
  provider.get('wallet.balance'),
  { traceId: 'trace-1', network: 'goat-testnet', now: Date.now() },
  { address: '0xabc...' },
);

console.log(result.ok ? result.output : result.error);
```

### Export to AI Frameworks

```typescript
provider.openAITools(); // OpenAI Function Calling
provider.langChainToolDefs(); // LangChain Tools
provider.mcpTools(); // Model Context Protocol
provider.vercelAITools(); // Vercel AI SDK
provider.openAIAgentsTools(); // OpenAI Agents SDK
```

---

## Feature Modules (Plugins)

### Core On-Chain Operations

| Plugin       | Actions | Functionality                                                                                                                                  |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **wallet**   | 10      | ERC20 transfer / approve / balance / contract read & write / deploy / token symbol resolution                                                  |
| **bridge**   | 7       | Bridge.sol real contract: withdraw / cancel / refund / replace-by-fee / deposit-status / withdrawal-status / get-params                        |
| **dex**      | 7       | OKU (Uniswap V3): swap / quote / get-pool / add-liquidity / remove-liquidity / collect-fees / get-position                                     |
| **x402**     | 8       | Agent payment protocol: payment.create / submit-signature / transfer / status / cancel / native order / hosted checkout / payment proof        |
| **paykit**   | 7       | Public GOAT Flow discovery / custom and product ERC-20 payments / session status / MPP pay and resume / hosted card links                      |
| **giftcard** | 8       | x402 giftcard purchase: list-brands / get-brand / list-categories / list-supported-tokens / create-order / pay-order / get-order / list-orders |

### Merchant, Identity & Names

| Plugin            | Actions | Functionality                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **x402-merchant** | 31      | Merchant portal management: auth (register / login / refresh / invite) / dashboard / profile / orders / balance / addresses / callback-contracts / API keys / webhooks / invite-codes / audit-logs                                                                                                                  |
| **erc8004**       | 9       | ERC-8004 Trustless Agents: register-agent / set-agent-uri / get-metadata / set-metadata / get-agent-wallet / give-feedback / revoke-feedback / get-reputation / get-clients                                                                                                                                         |
| **gns**           | 15      | GOAT Name Service (`.goat` names): check-availability / estimate-price / commit / wait-for-commitment / register / renew / get-name-details / get-my-names / set-address / set-profile-records / set-primary-name + cross-chain x402 register flow (create-order / submit-signature / pay-order / get-order-status) |

GOAT Testnet3 ERC-8004 upgrade note: the `goat-testnet` Identity Registry now uses
`0x54B8d8E2455946f2A5B8982283f2359812e815ce`, replacing
`0x556089008Fc0a60cD09390Eca93477ca254A5522` from versions 0.1.2–0.2.3. It pairs with
the unchanged Reputation Registry `0xd9140951d8aE6E5F625a02F5908535e16e3af964`.
Mainnet addresses, ABIs and action arguments are unchanged. Existing registrations
are not migrated: agent IDs are scoped to their registry, and an old numeric ID
may identify another agent or no agent under the new default. Keep historical
registrations associated with the old contract; register in the new Identity
Registry before using the corrected pair. New registration files use
`eip155:48816:0x54B8d8E2455946f2A5B8982283f2359812e815ce` as `agentRegistry`.

### Protocols & Assets

| Plugin         | Actions | Functionality                                                                                                                                                                                       |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **layerzero**  | 3       | LayerZero V2 OFT cross-chain: quote-send / send / quote-oft                                                                                                                                         |
| **bitvm2**     | 10      | BitVM2 BTC bridge + staking: bridge.deposit / bridge.withdraw / bridge.status / stake.register-pubkey / stake.approve / stake.stake / stake.lock / pegbtc.balance / pegin.request / pegout.initiate |
| **erc721**     | 3       | NFT: mint / transfer / balance                                                                                                                                                                      |
| **wgbtc**      | 3       | Wrapped GBTC: wrap / unwrap / balance                                                                                                                                                               |
| **goat-token** | 3       | Governance: delegate / get-votes / get-delegates                                                                                                                                                    |
| **faucet**     | 2       | Testnet tokens: request-funds / get-chains                                                                                                                                                          |
| **bitcoin**    | 3       | On-chain BTC light client: block-hash / latest-height / network-name                                                                                                                                |

**Total: 129 Actions across 16 plugins** + `customActionProvider()` for unlimited custom extensions.

---

## AI Framework Adapters

| Adapter                  | Target Framework        |
| ------------------------ | ----------------------- |
| `openai/tools.ts`        | OpenAI Function Calling |
| `langchain/tools.ts`     | LangChain Tools         |
| `mcp/tools.ts`           | Model Context Protocol  |
| `vercel-ai/tools.ts`     | Vercel AI SDK           |
| `openai-agents/tools.ts` | OpenAI Agents SDK       |

Define an Action once, automatically available across all five frameworks.

---

## Key Features

### 1. x402 Agent Payment Protocol + Merchant Portal

The core differentiating capability of AgentKit. Four complementary plugin sets:

**Payer side** (x402 — 8 actions): The Agent acts as the "payer", completing payments with merchant gateways via EIP-712 signatures:

- `HttpMerchantGatewayAdapter` — interfaces with merchant APIs
- `EvmPayerWalletAdapter` — local signing and authorization
- Full EIP-712 signing flow example (`examples/x402-payment-flow/`)

**Merchant side** (x402-merchant — 31 actions): Full merchant portal management via `MerchantPortalClient` HTTP adapter — auth, dashboard, orders, balance, webhooks, API keys, callback contracts, invite codes, and audit logs. Per-request token isolation via `ActionContext.accessToken` with `sensitiveOutputFields` redaction for hook/log safety.

**Public payment links** (paykit — 7 actions): Merchant discovery, custom and product ERC-20 payments, session status, GOAT Flow MPP payment and verification recovery, and human-completed hosted card checkout. See the PayKit guide below.

**Real-world consumer flow** (giftcard — 8 actions): A turnkey reference for "Agent pays cross-chain → user receives off-chain good". Browse brands and categories, create a giftcard order, pay the order via x402 from a source chain wallet (USDC/USDT on Polygon/Base/Arbitrum/Optimism/BSC/Metis), and poll until `FULFILLED`. Includes an EIP-712 auth signer with Redis-backed single-flight to avoid duplicate token requests under concurrent load. Backed by the `agentkit-giftcard` CLI for end users.

This is the implementation of the Coinbase x402 protocol on GOAT Network, enabling Agents to complete on-chain payments without a human account.

### 2. GOAT Name Service (`.goat` names)

The gns plugin (15 actions) provides a complete `.goat` namespace stack:

- **Read paths**: `checkAvailability`, `getNameDetails`, `getMyNames`, `estimatePrice`
- **Two-phase ENS-style registration**: `commit` → `waitForCommitment` (min/max commitment age verified on-chain) → `register` (with permit or pre-approve) → `renew`
- **Profile management**: `setAddress`, `setProfileRecords` (text + addr multicall), `setPrimaryName` (reverse record)
- **Cross-chain x402 registration**: pay for a `.goat` registration in USDC/USDT on Polygon / Base / Arbitrum / Optimism / BSC / Metis; the GNS backend settles on goat-mainnet after payment confirmation. Actions: `x402.createOrder` → `x402.submitSignature` → `x402.payOrder` → `x402.getOrderStatus`. The on-chain commit binds the **GOAT-side stablecoin address resolved by canonical symbol** (via the SDK's `GNS_PAYMENT_TOKENS` table, mirroring the backend's `paymentTokenAddressFromSymbol`) and the **priced `totalWei` from `/names/quote`**; `createOrder` forwards the same value as `commitMaxAmountWei` so the backend's strict-equality re-derivation passes. The `agentkit-gns x402-register` CLI orchestrates the full sequence: `x402.config` preflight → `estimatePrice` → `commit` → `waitForCommitment` (polls until `block.timestamp ≥ revealAt`; the on-chain `minCommitmentAge` is 60s and the CLI's overall wait deadline defaults to 180s) → `createOrder` → `submitSignature` → `payOrder` → poll `getOrderStatus` until `INVOICED` (the adaptor callback executed on GOAT and the name is actually registered — `PAYMENT_CONFIRMED` only means the source-chain transfer landed). **`payOrder` defense-in-depth**: the action takes payment routing fields (chain id, source-chain token contract, payToAddress, amount, expiry, calldataSignRequest) from the createOrder response as inputs and cross-checks them against three trust anchors before broadcasting — the status-endpoint `OrderProof`, the backend's signed `calldataSignRequest.message.{owner, payer}` (mandatory; refuse if absent), and the merchant's `x402Config` token allowlist for the source chain. The status gate requires explicit `CHECKOUT_VERIFIED` (backend lifecycle never emits `PAYMENT_PENDING`) and fail-closes on terminal failure states. 3-way payer binding enforces `wallet ≡ payer ≡ signed message.payer` so a mis-wired payer adapter cannot broadcast from a different signer than the chain-validated wallet.

The `commit` action returns the 32-byte secret as a top-level `sensitiveOutputFields` value, so default hook/log paths redact it and `--reveal-secrets` is required to emit it (the CLI uses the dedicated `print-secret` action for that). The `register` action re-derives the commitment hash on-chain and rejects any `(secret / token / amount / years / owner / resolver / data / reverseRecord / referrer)` divergence vs the original commit, preventing parameter drift between phases. Backed by the `agentkit-gns` CLI for end users.

### 3. Production-Grade Runtime Engine

Execution pipeline: **Policy Gate → Schema Validation (Zod) → Idempotency → Retry → Timeout → Metrics → Hooks**

- **Policy Engine**: Risk-gated action execution by risk level
- **Idempotency**: Dual-mode memory / Redis, with Lua script atomic lock release for Redis
- **Metrics**: Built-in Prometheus export (`/metrics`), aggregated by action labels
- **ExecutionHooks**: `onActionStart` / `onActionSuccess` / `onActionError` / `onPolicyBlocked` observation callbacks
- **Timeout**: `Promise.race` implementation, supporting per-action and global defaults

### 4. Dual WalletProvider

- `EvmWalletProvider` (ethers.js) — full-featured, including `writeContract` / `deployContract`, `getLatestBlockTimestamp()` for on-chain readiness checks
- `ViemWalletProvider` (viem) — modern EVM client
- `NoopWalletProvider` — development/testing placeholder; defaults to `chainId 48816` (GOAT Testnet3)

All three implement an optional `getChainId()` so chain-bound actions (e.g. `giftcard.payOrder`, `gns.x402.payOrder`) can verify the wallet is on the source chain the order expects, refusing to broadcast on mismatch.

### 5. Token Registry + Symbol Resolution

`networks/goat/tokens.ts` maintains a GOAT chain token mapping table. The `wallet.resolve_token` action supports operating with symbols (e.g., `USDC`) directly, without manually looking up contract addresses.

### 6. CLIs

Four independent CLI entry points:

- **`npm create goat-agent`** — interactive project scaffolder (`packages/create-goat-agent/`), three presets:
  - **minimal** — wallet plugin only (10 actions)
  - **defi** — wallet + wgbtc + bridge + bitcoin (27 actions)
  - **full** — the bundled wallet, DeFi, merchant, and identity plugins
- **`agentkit-gns`** (`bin/gns.mjs`) — register / renew / lookup `.goat` names, with `--reveal-secrets`, region selection, env-driven wallet (`GOAT_PRIVATE_KEY`), and a `doctor` subcommand for env diagnostics. The `x402-register` subcommand additionally accepts `--wait-timeout <sec>` (default `180`) and `--poll-interval <sec>` (default `10`) for the post-commit reveal-window poll, and preflight-validates `(--pay-chain, --pay-token, --pay-token-contract)` against the merchant's x402 config before any GOAT-chain spend.
- **`agentkit-giftcard`** (`bin/giftcard.mjs`) — browse brands, place orders, pay cross-chain, poll for fulfillment. Hard-refuses to use `NoopWalletProvider` for real payments outside `DEMO_MOCK=true`.

- **`agentkit-paykit`** — public PayKit discovery, payments, hosted card links and durable recovery (see below).

### 7. Dual Cross-Chain Channels

- **Bridge.sol** — GOAT native bridge (with full lifecycle: cancel / refund / replace-by-fee)
- **LayerZero V2 OFT** — general-purpose cross-chain protocol

---

## Highlights

1. **High Action density**: 129 Actions across 16 plugins covering wallet, DEX, bridge, NFT, governance, payments, merchant management, agent identity, cross-chain, `.goat` naming, and x402 giftcard purchase — surpassing Coinbase Base AgentKit (50+)
2. **x402 payment is the killer feature**: Native Agent payment capability with full EIP-712 signing flow + 31-action merchant portal management + a real consumer flow (8-action giftcard purchase paying cross-chain in USDC/USDT), benchmarked against Coinbase but deployed on a Bitcoin L2
3. **Solid runtime engineering**: Idempotency + policy gateway + Prometheus metrics + execution hooks + sensitive-input redaction + revealed-output gating — this is not a demo-grade SDK
4. **Five-framework one-shot adaptation**: OpenAI / LangChain / MCP / Vercel AI / OpenAI Agents — define once, available everywhere
5. **Developer-friendly**: CLI scaffolder (`create-goat-agent`) + three end-user CLIs (`agentkit-gns`, `agentkit-giftcard`, `agentkit-paykit`) + complete examples + `customActionProvider` custom extensions + dual WalletProvider
6. **Unique Bitcoin ecosystem positioning**: Through BitVM2 + Bridge.Sol + BTC light client, building an Agent economy on a Bitcoin L2 — a track that Base AgentKit does not cover
7. **ERC-8004 Trustless Agent identity + `.goat` naming**: On-chain agent registration, metadata, reputation, and a full ENS-style `.goat` namespace (commit-reveal registration, profile records, primary names, cross-chain x402-paid registration) — verifiable Agent identity with a human-readable name layer

## GOAT Flow PayKit

This integration pins `goatflow-paykit@0.4.0`, `goatflow-sdk@0.3.0`, and
`goatflow-sdk-server@0.4.0`. Contracts were checked against the canonical
`GOATNetwork/x402` release (`db5be43`) and the local `fix/paykit-flow` source
(`c7367ba`), with backend behavior checked in `goat-x402` (`33fe42a`).
The local source repositories are reference inputs, not runtime file dependencies.

### Public links and payment units

Use a trusted merchant link such as
`https://flow-quickpay.goat.network/paykit/<merchant>` (testnet:
`https://flow-quickpay.testnet3.goat.network/paykit/<merchant>`). Legacy
`/quickpay/<merchant>`, `/agent.md`, and `/manifest.json` links also work. Requests
stay on the link's origin; advertised endpoint URLs and redirects cannot move a
payment to another host. HTTPS is required except on loopback.

| Action                           | Input amount                                                                                    | Result                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `goat.paykit.inspect`            | None                                                                                            | Tokens, products, supported chains and MPP routes        |
| `goat.paykit.pay`                | Human decimal `amount`                                                                          | Public x402 payment confirmation                         |
| `goat.paykit.payProduct`         | Merchant `productKey`; price verified from the manifest                                         | Public x402 payment confirmation                         |
| `goat.paykit.sessionStatus`      | `sessionId` or journal `operationId`; optional original `expectedFingerprint` with operation ID | Current public session state; no transfer                |
| `goat.paykit.payMpp`             | Manifest route; optional base-unit `maxAmountWei` cap                                           | GOAT Flow `Payment-Receipt`                              |
| `goat.paykit.resumeMpp`          | Journal `operationId`, optional original `expectedFingerprint`                                  | Verification of the existing transaction; no new payment |
| `goat.paykit.createCardCheckout` | Product key or human decimal amount                                                             | Hosted link with `human_action_required: true`           |

Public x402 success is `PAYMENT_CONFIRMED`. Native merchant order settlement can
continue to `INVOICED`; these are distinct state machines. MPP here is the
**GOAT Flow MPP profile**, not a generic MPP client. Receipt decoding is not
independent signature verification; protected merchant resources verify receipts.

### CLI

```bash
# Read-only; no wallet or merchant credentials required
agentkit-paykit inspect https://flow-quickpay.testnet3.goat.network/paykit/acme --json

# Configure PAYKIT_PRIVATE_KEY and PAYKIT_RPC_4217 (or PAYKIT_RPC_URL) in your environment.
# Use a chain and token returned by inspect. GOAT_PRIVATE_KEY is a key fallback.
agentkit-paykit pay-x402 https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --chain-id 4217 --token USDC --amount 1 --idempotency-key invoice-101 --auto-confirm --json

# Check the same payment without submitting it again
agentkit-paykit status https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --operation-id invoice-101 --json

agentkit-paykit pay-product https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --chain-id 4217 --token USDC --product mug --idempotency-key purchase-102 --auto-confirm

agentkit-paykit pay-mpp https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --chain-id 4217 --route GET:api:data --idempotency-key request-103 --auto-confirm --reveal-secrets --json
agentkit-paykit resume-mpp https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --operation-id request-103 --reveal-secrets --json

# A human completes this link; the agent never handles card credentials.
agentkit-paykit create-card-checkout https://flow-quickpay.testnet3.goat.network/paykit/acme \
  --product mug --idempotency-key card-104 --auto-confirm --reveal-secrets --json
```

Each write needs a stable intent key and confirmation (`--auto-confirm` for unattended
use). The interactive prompt shows the payer address and which key variable supplied
it, the chain, token and amount (or product, route and cap), and the intent key.
Product and MPP prompts read the merchant manifest once before approval to quote the
price; if that quote cannot be loaded, no payment is attempted. The approved payment
runs against that same manifest, so a price the merchant changes after approval fails
the session or challenge terms checks before anything is signed. An intent the journal
already holds as completed or in flight (including a request claimed just before a crash)
is replayed or reported without a quote, so it
does not depend on the merchant being available. `--rpc-url` overrides RPC environment settings. The private journal lives in
`~/.agentkit/paykit`, configurable with `PAYKIT_STATE_DIR` or `--state-dir`.
For payment commands, `--chain-id 4217` selects the SDK action context `eip155:4217`.
If a replay error names a journaled action context, use that chain ID with `--chain-id`.
SDK callers must use the lowercase `eip155:` prefix and a positive decimal chain ID;
mixed-case prefixes, hexadecimal, exponent, whitespace-padded and leading-zero spellings are rejected.
Session handles, checkout URLs and receipt bodies are redacted from normal output (the emergency receipt exception below prevents loss when all storage fails);
`--reveal-secrets` exposes them to the caller while runtime logs stay redacted.
Exit codes: 0 success, 1 input/confirmation error, 4 policy block, 10 upstream or
recovery-required failure, 99 other runtime errors. Timeout and abort results can
still carry `recovery.operationId` and a known transaction hash.
If cancellation cleanup finishes a payment and its completed result is durable,
the CLI reports success with exit code 0 and the usual output redaction.
Runtime `timeoutMs` and CLI `--timeout-ms` must be integers from 1 through
2,147,483,647 milliseconds; larger values are rejected rather than clamped by Node.
The SDK also accepts `timeoutMs: 0` to disable the timeout for a call, overriding
`defaultTimeoutMs`. A zero or omitted `defaultTimeoutMs` disables the default;
caller cancellation still applies. The CLI flag requires a positive timeout.

### SDK and recovery

```typescript
import { PaykitService, createPaykitActions, FilePaymentRecoveryStore } from '@goatnetwork/agentkit/plugins';

const paykit = new PaykitService({
  wallet, // EvmWalletProvider or ViemWalletProvider for x402
  mppSigner: signer, // ethers signer for MPP, including replacement tracking
  recoveryStore: new FilePaymentRecoveryStore('/private/agent-state/paykit'),
  allowedChainIds: [4217],
});
for (const action of createPaykitActions(paykit)) provider.register(action);

const result = await runtime.run(
  provider.get('goat.paykit.pay'),
  { traceId: 'invoice-101', network: 'eip155:4217', now: Date.now() },
  { url: merchantUrl, chainId: 4217, tokenSymbol: 'USDC', amount: '1', idempotencyKey: 'invoice-101' },
  { confirmed: true, timeoutMs: 120_000 },
);
// On failure retain result.recovery privately; use sessionStatus or resumeMpp.
// For MPP resume, pass expectedFingerprint: result.recovery.fingerprint to pin the intent.
```

The policy allowlist must contain the action context's `eip155:<chainId>`; GOAT
contexts `goat-mainnet` and `goat-testnet` also bind to their actual chain IDs.
The wallet chain, payer and payment terms are checked before sending. A real
`broadcastErc20` capability is required; existing `transferErc20` methods retain
their wait-for-mining behavior for GNS and giftcard callers. Noop wallets cannot pay.
PayKit, core wallet transfers, approvals, contract writes/deployments, and the legacy EVM payer adapter require a signer capable of signing a populated transaction
without sending it. They prepare, check cancellation, sign, check cancellation, then
broadcast the signed bytes. A wallet exposing only `sendTransaction` is insufficient. Migrate to a local signer or an account
that supports raw `signTransaction`; unsupported signers report `WALLET_SIGN_FAILED` before submission.
Read-only `callContract` remains available without raw signing.
Ethers `NonceManager` reservations are preserved for sequential and concurrent writes,
including CommonJS/ESM consumers and calls sharing the manager with ethers directly. As with ethers, a reservation
remains consumed if preparation or signing fails or is cancelled. Reconcile outstanding
transactions before calling `NonceManager.reset()`; resetting while other reservations
are active can reuse a nonce.
Viem preparation also forwards a local account's configured nonce manager, preserving
its reservations when sharing the account with native viem calls.
Viem confirmation rejects reverted receipts and replacements that change the call.
A successful fee-bump replacement returns and checkpoints its mined hash.
Ethers wallets follow the same rules: ethers v6 rejects `wait()` even for a successful
fee bump, so AgentKit returns and checkpoints the mined replacement hash instead of
reporting a failure, and attributes cancelled, different-call or reverted
replacements to the replacement hash in recovery data.

Fresh-payment manifest, token/product, amount and memo validation runs before claiming
the key. A journal claim is persisted before a remote creation or transfer.
For x402, card checkout and MPP, an intent reservation and a separate immutable
request claim protect concurrent callers. A matching `prepared` reservation with
no request evidence can be retried after storage is repaired. Before any creation
request, one caller atomically claims the right to send. The x402 claim also contains
the exact session POST body for status recovery. Once a request claim exists,
retries require reconciliation even if the primary record could not be updated;
they never start another payer or card checkout. A `requesting` record without
request evidence is not treated as safe to retry. MPP resume consults the same request
marker, so it reports `requesting` and reconciliation guidance when a challenge/hash
checkpoint was not saved. Completed request snapshots omit creation bodies when read
through the store. File journals retain the older ordinary checkpoint, including its
session POST body; publishing a compact completion file does not erase that data. A repeated key with
different terms is rejected; an uncertain prior result produces `RECOVERY_REQUIRED`
instead of another transfer or checkout. This remains enforced when runtime retries
are enabled. After a broadcast, status failures, aborts and timeouts preserve the
known hash. The CLI cancels new work at its timeout, then waits for any in-flight
submission and journal writes before reporting recovery and closing the provider.
This cleanup can outlast `--timeout-ms`. The first Ctrl-C requests cancellation and prints
a draining notice; a second Ctrl-C force exits with code 130. Recover the same intent
from its journal before retrying after a forced exit. Built-in wallets persist `signedTxHash`
before the broadcast RPC. This identifies the signed transaction even if the response
is lost; it does not prove submission or inclusion. MPP recovery can verify this
candidate hash without sending again. Custom wallets should implement the
`onSignedTransaction` checkpoint to offer the same protection.

SDK callers also receive a non-serialized `result.settled` promise after an interrupted
action. Await it before closing the wallet provider to obtain the final recovery data:

```ts
if (!result.ok) {
  const recovery = result.settled ? await result.settled : result.recovery;
  // Save recovery privately and inspect/verify the existing payment.
}
```

Runtime cancellation returns promptly during reads; accepted broadcast RPCs continue
until their hash can be retained. Core wallet write and legacy transfer confirmation errors carry
the already-broadcast hash in `error.recovery`. Runtime-mode idempotency locks remain held
until execution settles: a valid late success is cached, and a settled failure without
recovery evidence releases the key. A failed execution with a recovery checkpoint retains
its key, including confirmation cancellation after broadcast and failed cache writes.
Repeating that key returns `IDEMPOTENCY_CONFLICT` instead of executing another transfer.
This guard uses the store's existing TTL and durability; save the returned recovery handle
and reconcile the transaction before retrying, even after the key expires. An in-memory
runtime store does not preserve this guard across a process restart. Configure the idempotency store TTL to cover the full execution and settlement
window; these locks retain the existing TTL contract (default 3,600 seconds).
Runtime completion includes the acquired ownership token. Stores must atomically
cache when the key is absent, expired, or still in progress under that token, while
preserving a different unexpired owner or any unexpired completed result. A late
success with no successor is cached even after its lock expires; it cannot overwrite
a newer run's active lock or cached result. Expiry still allows reacquisition while
an action runs, so choose a TTL that covers the full execution window.
An otherwise retryable timeout can retry if cancellation finishes with failure
during the configured retry backoff and no recovery evidence is present. An
unfinished attempt is never retried concurrently. A validated success observed
during backoff returns success, with one success hook and latency observation. This also
applies when a success is already known at the timeout boundary and retries are disabled.
Unlike earlier timeout behavior, an action that ignores `ctx.signal` keeps its key
locked until execution settles or the store TTL expires. Its `settled` promise can
remain pending indefinitely; TTL expiry does not settle or cancel the action.
Action implementations should forward `ctx.signal` into wallet and network calls.
The built-in wallet write actions and HTTP actions (PayKit, x402, merchant, GNS,
giftcard and faucet) forward cancellation to their adapters. The current wallet
read and typed-data signing interfaces do not accept a signal: contract/balance
reads, chain detection and remote signing can therefore delay settlement in actions
that await them directly. This includes GNS contract preflight, giftcard/GNS payer
checks, and read actions in the wallet, Bitcoin, bridge, DEX, ERC-721, ERC-8004,
GOAT token, LayerZero and WGBTC plugins. Giftcard authentication also awaits its
cache/Redis calls and any shared authentication already in progress without
per-caller cancellation. BitVM2's signal-free deposit/withdraw/status methods are
currently in-process placeholders, not remote bridge requests. Custom adapters
must honor the signal themselves; raw transaction submission and recovery journal
writes intentionally finish after cancellation to retain transaction evidence.
A validated success after the caller has received `ABORTED` or `TIMEOUT` emits `onActionSuccess` and the success log with
`afterInterruption: true`, plus `runtime.success` and `runtime.late_success` metrics.
The earlier abort/timeout error describes the caller's wait; the late event describes
the actual execution outcome, with the same trace and normal output redaction.
Completed x402 journal replay
needs the payer address but does not request the live wallet chain.
Completed MPP replay through `payMpp`/`pay-mpp` uses the recorded payment terms,
without fetching the live manifest or asking the provider for its network. A removed,
disabled or re-chained merchant route therefore does not prevent replay. It still
requires an `mppSigner` with a provider and the original payer address, and enforces
the action-context chain and `allowedChainIds`. Reading a remote signer's address
may itself need network access. The CLI still requires a valid key and RPC URL
configuration for `pay-mpp`; `resume-mpp` needs the key but no RPC URL.
For a lost x402 session-create response, `status --operation-id <key>` replays the
exact journaled request with its original server idempotency key to recover the
session handle, then reads its status. It needs no wallet and never transfers,
even if the original request never arrived and the replay creates an unpaid session.
Older journal entries without the saved request still need a known session ID or merchant reconciliation.
Keep the same journal and key across restarts; deleting the journal or using a new
key removes this local duplicate-payment protection. A request marker that conflicts
with the primary journal requires reconciliation with the merchant, even if the
primary still says `prepared`. Do not retry creation or send another payment in
that state. Likewise, a missing or invalid MPP journal chain ID requires restoring
or reconciling the record; retrying the same command cannot repair it.

Native Flow order and checkout creation validate timeout configuration and cancellation
before reserving a reference. A prepared reference remains retryable until a separate
atomic request claim exists. Once that claim exists, reconcile ambiguous creation failures;
only the explicit `topup:` server replay contract permits another creation request.
Native Flow order and checkout creation also retry a failed completion write once,
without repeating the remote request. If both writes fail, the error retains the
completed order or checkout in `recovery.result` with a `persistenceError` diagnostic.
Save that result privately and reconcile the journal before retrying.
A created order must contain exactly one accept entry for the requested chain, amount
and (if given) token contract, and its `token_symbol` must match the requested symbol.
A returned `calldataSignRequest` is accepted only for a callback order created with
non-empty calldata: its struct type must match the order flow, `payer` must equal
`fromAddress`, `orderId` and `calldataHash` must equal the hashes of the order ID and
submitted calldata, and the domain chain must be the order's destination chain.
Its token and amount are pay-to terms and are verified by the server, not locally.

MPP payments require the manifest route to name a valid token contract and reject a
challenge for any other token; a route identified only by symbol fails before the
intent key is claimed.

The SDK defaults to a single-process `InMemoryPaymentRecoveryStore`, capped at 10,000
records (configurable in its constructor; all PayKit and native Flow creation rails use two records per intent, including the request claim). At capacity it blocks new intents while
allowing existing recovery and replay; it never evicts keys that prevent duplicate
payments. Completed snapshots drop creation bodies, challenge credentials and decoded
receipt copies. Receipts, checkout links and native order response terms needed for
replay remain available. This limits record count, not the byte size of an individual
server response. Use the file
store for a single host, or implement atomic `claim/get/put` in a shared durable
`PaymentRecoveryStore` for multiple workers. `get` may return `undefined` or `null` for
a missing key; a file containing JSON `null` is still a corrupt record. Completion is terminal: `put` must preserve
the first completed record across all writers and return that record when ignoring a
stale update. Returned completions must match the caller's intent fingerprint before
they can be adopted. Journal reads validate structure and chain IDs consistently across
built-in and caller-supplied stores: x402 and MPP records require a positive safe
integer chain ID, and MPP records require a valid payer address. A completed primary record must contain its result; only compact
internal request markers may omit it. Corrupt reads return `RECOVERY_REQUIRED`
without exposing the unvalidated record in recovery data. Restore or reconcile the
journal before retrying; a missing result is never reported as successful replay.
The file store publishes a separate immutable `.complete.json` file;
`get` prioritizes it over the ordinary checkpoint, so a delayed payment cannot erase a
receipt saved by recovery. The older checkpoint may retain private request evidence.
Back up the entire journal directory, including completion files; do not mix older
writers that cannot read completion files with this version. Runtime idempotency caching alone does
not substitute for the payment journal. Journaled write actions use `idempotencyMode: 'action'`
so a runtime cache hit cannot bypass payment-term or key-conflict checks.
Card checkout creation has no server replay
contract; a lost creation response needs merchant reconciliation. MPP recovery
needs the original payer key, challenge and hash; it calls verify only, subject to
the server's expiry/retry budget (at most 16 verification attempts per action).
MPP resume and x402 status recovery check surviving request markers for inconsistent
intents before exposing journaled results or replaying a session-creation POST.
To compare against the original payment terms, pass the original
recovery handle's `fingerprint` as `expectedFingerprint` (CLI: `--expected-fingerprint`).
For x402 status, this requires `operationId` / `--operation-id`. The fingerprint is
a deterministic hash of payment terms, not a secret, authentication credential or
unique attempt identifier. It detects changed terms, not a malicious rewrite that preserves them.
A mismatch, including a missing primary or a changed rail, origin or merchant in a
pinned lookup, returns `RECOVERY_REQUIRED` without exposing the replacement record.
An in-flight x402 primary must have its request marker before operation-ID status
recovery can proceed. Restore the entire journal if that marker is missing; a
completed emergency journal may contain only the primary result. Prepared-primary
marker contradictions and status lookups without recorded session/request evidence
require reconciliation without publishing that primary. These errors identify the
requested operation ID, without claiming a verified phase. Reconcile the journal
with merchant status and transaction history; a previously saved handle or emergency
journal helps if available, but is not assumed to exist.
Operation-ID-only recovery trusts a consistent journal; it cannot detect replacement
of the primary and all corroborating records together. After a journal conflict,
use the saved fingerprint or the emergency journal containing your own result;
do not take the expected fingerprint from the disputed primary record.
Before submission, journal writes must succeed. After a known broadcast, x402 status
polling and MPP verification retry failed checkpoints once and then proceed even if
storage is still unavailable, preserving the transaction evidence and storage diagnostic.
This allows payment confirmation or receipt retrieval while it is still available.
Successful checkpoint writes clear temporary persistence warnings in memory and on
disk, even if payment confirmation later fails. Adopted completions remain terminal
in memory, without repeated polling checkpoints after adoption. Semantically invalid
x402 status data (such as a changed session, chain or token) stops polling with the
specific validation error. Body-read failures, empty/non-JSON bodies and transient
transport failures retain the SDK's bounded retry policy.
Recovery callbacks in the runtime, built-in wallet actions, PayKit and native Flow
receive detached snapshots as best-effort notifications. Synchronous throws and
async rejections are isolated; callbacks are not awaited and cannot block a journal
write or replace a storage error. Use the recovery store for durable persistence;
wallet `onSignedTransaction` and `onBroadcast` callbacks remain awaited write boundaries.
Observer accessors are read inside the same isolation boundary, and method observers
retain their original context as `this`, including on direct native Flow calls.
Invocation does not access an observer's `call` or `bind` properties, so callable
proxies and functions with a null prototype are supported too.
Custom-store reads are copied before journal updates, so an in-memory completion
cannot mutate the store's cached record before the completion write succeeds.
Native Flow request cancellation reports `ABORTED`; unverified-recovery messages use
the caller's order or checkout reference while recovery handles retain the scoped storage key.
PayKit session status and native Flow reads distinguish caller cancellation (`ABORTED`)
from the payment API's request deadline (`ADAPTER_REQUEST_FAILED`, “Payment API request timed out”),
both before headers and during JSON body reads. Socket/body-read failures remain upstream
errors; only JSON syntax failures are described as invalid JSON. These transport failures
remain retryable by the x402 SDK's bounded poller. Classified errors reaching AgentKit's
journaled write-failure boundary retain their diagnostic and gain the rail's recovery
guidance when needed, including post-broadcast cancellation and rejected creation responses.
Completed operations, journal reconciliation/conflict errors, and errors explicitly marked
with `recoveryGuidance` keep their existing instructions instead of receiving an
"operation incomplete" suffix. Read-only failures do not gain write-recovery guidance.
AgentKit's shared JSON response reader reads response text and parses JSON itself, discarding parser exceptions because
their messages or stacks may quote private response contents. It does not call a fetch
implementation's `response.json()`, which may wrap parser errors under another name.
This sanitization does not cover parsing inside the upstream SDKs (including manifests, MPP challenges and receipts); SDK wrappers
may also replace or suppress the underlying transport/body-read diagnostic.
Saved x402 session-create bodies are checked for valid object JSON and a valid token
address at the journal read boundary, before any recovery POST. Corruption reports
`RECOVERY_REQUIRED` without attaching the stored request or its parser exception.
PayKit/native Flow journal snapshots omit undefined object fields, including optional
order IDs and nested result fields, and normalize undefined array entries to `null`
following JSON conventions. An undefined patch field does not erase earlier evidence.
Successful checkpoints omit `persistenceError`, and compact request markers omit `result`.
For all three rails, a failed completion checkpoint is retried once. If it still
fails, the operation reports the storage failure and retains its completed result
(x402 payment, card checkout link or verified MPP receipt) and persistence diagnostic
in private recovery data. SDK callers should save that data securely and repair
storage before reuse. An in-memory `complete` phase alone does not guarantee replay.
If a store returns another intent's completion or an invalid checkpoint after the payment completed, the
operation reports `RECOVERY_REQUIRED`, preserves only this caller's completed result,
and directs reconciliation; changing the key and paying again is not a remedy.
The CLI reports the persistence error and writes a private emergency journal in a
new directory (directory mode 0700, files 0600). Set `--emergency-dir` or
`PAYKIT_EMERGENCY_DIR` to a private parent on a different filesystem from the primary
journal to withstand a full primary filesystem. Provision this parent before use;
on POSIX it must belong to the current user with private permissions (mode 0700).
For payment, checkout creation and MPP resume commands, the CLI rejects a configured
parent equal to or inside the primary journal, resolving symlinks for the comparison.
Applicable key, RPC URL and emergency-directory validation run before any payment
confirmation prompt; an RPC provider is constructed only after approval, and the
only pre-approval request is the product/MPP manifest quote for an interactive prompt. `inspect`
and `status` skip emergency-directory preflight because they do not save emergency
results. A shared filesystem produces
a warning rather than rejection: it can help with directory permission failures, but
not disk exhaustion. A parent containing the primary directory is allowed because
the generated emergency copy is a separate sibling directory. That location is tried first, then
the system temporary directory. The temporary parent must already exist and be
accessible; recovery never provisions a missing `TMPDIR`. On POSIX it must be owned
by the current user or root, with the sticky bit set if group- or world-writable.
The temporary fallback is validated only if the configured location cannot save
the result. An unavailable or unsafe fallback is then skipped with a storage warning;
a successful configured save does not report errors for an unused fallback.
Temporary-directory aliases are resolved for deduplication and volatile-storage
warnings. A configured directory inside the canonical temporary root is also labelled
as temporary, including when reached through a symlink. Temporary storage often shares the primary filesystem;
it is not an independent disk-capacity guarantee. The CLI returns a successfully saved directory
as `recovery.emergencyStateDir`, with a redacted completed result unless
`--reveal-secrets` is set. Keep or move this directory to durable private storage;
`resume-mpp --state-dir <emergencyStateDir> --expected-fingerprint <originalFingerprint> --reveal-secrets` retrieves the completed
receipt without another transfer or verification request. For x402 and card, replay
the original command with this emergency `--state-dir`, the same key and terms, and
`--reveal-secrets` to retrieve the saved result without another creation or payment.
If emergency storage also fails, the CLI marks `receiptRevealedForRecovery` (MPP)
or `resultRevealedForRecovery` (x402/card) and returns the only result so the operator
can save it. Failed attempt paths are listed in `failedEmergencyStateDirs`, including
directories that may contain readable partial records after a failed link or fsync;
their durability is unconfirmed. A configuration rejected during recovery is recorded
in `emergencyStorageWarnings` and skipped; it is not reported as an attempted write.
This exception to default redaction never puts secrets into runtime
logs or hooks.
`sessionStatus` and `resumeMpp` have risk level `recovery`, ranked with `low` for
confirmation policy and blocked by `writeEnabled: false`: status recovery may replay
a session-creation POST, and MPP verification consumes the challenge. Neither sends
another transfer. Inspect remains a read action.

On POSIX filesystems, file journals flush completed temporary records, atomically
publish claims without replacement, and sync the containing directory. A failed
pre-publication write leaves the operation key unused. Only newly created directory
entries require parent syncing; existing ancestors need traversal permission, not
read access. Provision and persist the state directory before starting concurrent
workers; existing ancestors are treated as operator-provisioned durable storage.

Windows defaults to `{ durability: 'file' }`: atomic publication and file flushing
remain enabled, but Node cannot provide directory-entry power-loss durability there.
Select `{ durability: 'directory' }` to require directory syncing, or provide a store
with the necessary platform guarantees. Directory-sync errors are never silently
ignored in that mode. Empty or corrupt published records still fail closed with
`RECOVERY_REQUIRED`. Keep completed keys
for as long as they can be reused. Archive a journal only when its keys are permanently
retired; automatic TTL/LRU eviction would remove payment deduplication.
An empty `PAYKIT_STATE_DIR` uses the default `~/.agentkit/paykit`; an explicitly blank
directory is rejected instead of resolving to the current working directory.
Journal and emergency directory values are trimmed before resolving paths; interior
spaces in directory names are preserved.

PayKit actions are invoked through `ExecutionRuntime.run` (or the agent/CLI entry
points that use it). The runtime validates and parses each input once, then passes
that parsed value to the low-level `execute` callback. Calling `execute` directly
bypasses runtime validation and policy; direct service methods retain their own
payment preflight checks. The CLI previews input validation before wallet setup,
but passes the original input to the runtime so transformations are not compounded.
Schemas used for CLI preview should keep refinements and transforms pure.
Native Flow and TOTP actions follow the same runtime parsing boundary. Direct
Flow callers should use `createOrder` and `createCheckout`, which validate their
inputs; the `FromParsedInput` methods are low-level entry points for runtime actions.

### Authenticated merchant orders and checkout

`GoatFlowGatewayAdapter` targets `https://flow-api.goat.network` or
`https://flow-api.testnet3.goat.network` with an API key and secret. The three new
actions are `goat.x402.order.create`, `goat.x402.checkout.create`, and
`goat.x402.payment.proof`. Its constructor requires a separate trusted
`checkoutOrigin` before creating hosted links. Pass a durable recovery store for
restart protection, just as for PayKit.

Native order amounts (`amountWei`, or legacy `payment.create.amount`) are integer
base units. Native creation requires an explicit payer, source chain and unique
`dappOrderId` (legacy `idempotencyKey`); the old `to` field is not a payer fallback.
On `GoatAdapter.x402CreatePayment`, `to` is now optional and deprecated: native
Flow gets its recipient from the merchant configuration and uses `fromAddress`
as payer. The live smoke script requires `GOATFLOW_SMOKE_PAYER` and no longer uses
`GOATFLOW_SMOKE_TO` as a payer. Adapter configuration comparisons retain a digest,
not a serialized extra copy of the API secret.
`GoatAdapter.x402CreatePayment` now uses this validated adapter. Only order creation
accepts HTTP 402 as success. Missing order IDs and unknown states fail closed.
`GoatAdapter` retains its recovery store across credential/URL changes and accepts
`{ recoveryStore, recoveryNamespace }` for durable restart protection. Its default
namespace is per GOAT network; use a stable, separate namespace for each merchant
when sharing a store. Secret rotation preserves existing intent guards. Reusing a
key after changing the API key or origin fails with `IDEMPOTENCY_CONFLICT`, requiring
reconciliation; it does not silently create another order under the new configuration.
Direct `GoatFlowGatewayAdapter` callers can opt into the same stable
`recoveryNamespace`; otherwise their namespace remains tied to origin and API key.
All native Flow and PayKit rails share intent/request claims, completion retry and
request-marker compaction through the same journal implementation.
The custom-route `HttpMerchantGatewayAdapter` remains available for existing
merchant gateways and is separate from the native HMAC adapter.

Hosted checkout accepts DIRECT/DELEGATE, crypto/fiat rails, decimal prices or
fixed-wei DELEGATE terms, redirects, line items and metadata. Nested values are
JSON strings on the HMAC wire. `clientReferenceId` is required by AgentKit as a
local operation guard; remotely it is a unique correlation reference, **not** a
replay guarantee. Order `recoverExistingOrder` is restricted to `topup:` references;
it permits exact server-side replay after an ambiguous creation, including when
enabled on a retry. Changing the payment terms still fails locally.
Create-time callback calldata requires fixed-wei DELEGATE terms; a public
`callback_template` is only a UI hint, so the callback contract must validate buyer
inputs. The server's proof `signature` is a plain checksum, exposed with
`cryptographicAttestation: false`; use on-chain verification for independent proof.
The released HMAC format is preserved, including its legacy unescaped `k=v&...`
encoding. Changing that protocol requires a coordinated backend migration.

Merchant portal bearer authentication remains separate from public PayKit and
merchant HMAC credentials. Self-service registration now permits DIRECT only and
passwords of 8–72 UTF-8 bytes. Login may return `{ mfa_required, mfa_token }`;
complete it with `goat.x402.merchant.auth.totp-verify` and `{ mfa_token, code }`, then
pass the resulting access token through `ActionContext.accessToken`.
