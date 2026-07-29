# GOAT AgentKit — Overview

## One-Liner

The GOAT Network counterpart to Coinbase AgentKit — a TypeScript SDK enabling AI Agents to autonomously execute on-chain operations on the GOAT chain.

---

## Repository Structure

```
agentkit/
├── core/           # Runtime engine (policy, validation, idempotency, retry, metrics, timeout, hooks)
├── plugins/        # 15 feature modules (118 Actions)
├── adapters/       # 5 AI framework adapters
├── providers/      # Action registry + tool manifest generation
├── networks/       # GOAT chain adapter layer (mainnet / testnet)
├── packages/       # Independent packages (create-goat-agent CLI)
├── bin/            # End-user CLI binaries (agentkit-gns, agentkit-giftcard)
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
```

Both CLIs read configuration from environment variables (`GOAT_PRIVATE_KEY`, `GNS_API_BASE_URL`, `GIFTCARD_API_BASE_URL`, `DEMO_MOCK`, …) and ship interactive `doctor` subcommands for env diagnosis.

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
| **x402**     | 5       | Agent payment protocol: payment.create / submit-signature / transfer / status / cancel                                                         |
| **giftcard** | 8       | x402 giftcard purchase: list-brands / get-brand / list-categories / list-supported-tokens / create-order / pay-order / get-order / list-orders |

### Merchant, Identity & Names

| Plugin            | Actions | Functionality                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **x402-merchant** | 30      | Merchant portal management: auth (register / login / refresh / invite) / dashboard / profile / orders / balance / addresses / callback-contracts / API keys / webhooks / invite-codes / audit-logs                                                                                                                  |
| **erc8004**       | 9       | ERC-8004 Trustless Agents: register-agent / set-agent-uri / get-metadata / set-metadata / get-agent-wallet / give-feedback / revoke-feedback / get-reputation / get-clients                                                                                                                                         |
| **gns**           | 15      | GOAT Name Service (`.goat` names): check-availability / estimate-price / commit / wait-for-commitment / register / renew / get-name-details / get-my-names / set-address / set-profile-records / set-primary-name + cross-chain x402 register flow (create-order / submit-signature / pay-order / get-order-status) |

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

**Total: 118 Actions across 15 plugins** + `customActionProvider()` for unlimited custom extensions.

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

The core differentiating capability of AgentKit. Three complementary plugin sets:

**Payer side** (x402 — 5 actions): The Agent acts as the "payer", completing payments with merchant gateways via EIP-712 signatures:

- `HttpMerchantGatewayAdapter` — interfaces with merchant APIs
- `EvmPayerWalletAdapter` — local signing and authorization
- Full EIP-712 signing flow example (`examples/x402-payment-flow/`)

**Merchant side** (x402-merchant — 30 actions): Full merchant portal management via `MerchantPortalClient` HTTP adapter — auth, dashboard, orders, balance, webhooks, API keys, callback contracts, invite codes, and audit logs. Per-request token isolation via `ActionContext.accessToken` with `sensitiveOutputFields` redaction for hook/log safety.

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

Three independent CLI entry points:

- **`npm create goat-agent`** — interactive project scaffolder (`packages/create-goat-agent/`), three presets:
  - **minimal** — wallet plugin only (10 actions)
  - **defi** — wallet + wgbtc + bridge + bitcoin (27 actions)
  - **full** — all 15 plugins (118 actions)
- **`agentkit-gns`** (`bin/gns.mjs`) — register / renew / lookup `.goat` names, with `--reveal-secrets`, region selection, env-driven wallet (`GOAT_PRIVATE_KEY`), and a `doctor` subcommand for env diagnostics. The `x402-register` subcommand additionally accepts `--wait-timeout <sec>` (default `180`) and `--poll-interval <sec>` (default `10`) for the post-commit reveal-window poll, and preflight-validates `(--pay-chain, --pay-token, --pay-token-contract)` against the merchant's x402 config before any GOAT-chain spend.
- **`agentkit-giftcard`** (`bin/giftcard.mjs`) — browse brands, place orders, pay cross-chain, poll for fulfillment. Hard-refuses to use `NoopWalletProvider` for real payments outside `DEMO_MOCK=true`.

### 7. Dual Cross-Chain Channels

- **Bridge.sol** — GOAT native bridge (with full lifecycle: cancel / refund / replace-by-fee)
- **LayerZero V2 OFT** — general-purpose cross-chain protocol

---

## Highlights

1. **High Action density**: 118 Actions across 15 plugins covering wallet, DEX, bridge, NFT, governance, payments, merchant management, agent identity, cross-chain, `.goat` naming, and x402 giftcard purchase — surpassing Coinbase Base AgentKit (50+)
2. **x402 payment is the killer feature**: Native Agent payment capability with full EIP-712 signing flow + 30-action merchant portal management + a real consumer flow (8-action giftcard purchase paying cross-chain in USDC/USDT), benchmarked against Coinbase but deployed on a Bitcoin L2
3. **Solid runtime engineering**: Idempotency + policy gateway + Prometheus metrics + execution hooks + sensitive-input redaction + revealed-output gating — this is not a demo-grade SDK
4. **Five-framework one-shot adaptation**: OpenAI / LangChain / MCP / Vercel AI / OpenAI Agents — define once, available everywhere
5. **Developer-friendly**: CLI scaffolder (`create-goat-agent`) + two end-user CLIs (`agentkit-gns`, `agentkit-giftcard`) + complete examples + `customActionProvider` custom extensions + dual WalletProvider
6. **Unique Bitcoin ecosystem positioning**: Through BitVM2 + Bridge.Sol + BTC light client, building an Agent economy on a Bitcoin L2 — a track that Base AgentKit does not cover
7. **ERC-8004 Trustless Agent identity + `.goat` naming**: On-chain agent registration, metadata, reputation, and a full ENS-style `.goat` namespace (commit-reveal registration, profile records, primary names, cross-chain x402-paid registration) — verifiable Agent identity with a human-readable name layer
