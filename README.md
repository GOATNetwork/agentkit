# GOAT AgentKit — Overview

## One-Liner

The GOAT Network counterpart to Coinbase AgentKit — a TypeScript SDK enabling AI Agents to autonomously execute on-chain operations on the GOAT chain.

---

## Repository Structure

```
agentkit/
├── core/           # Runtime engine (policy, validation, idempotency, retry, metrics, timeout, hooks)
├── plugins/        # 13 feature modules (95 Actions)
├── adapters/       # 5 AI framework adapters
├── providers/      # Action registry + tool manifest generation
├── networks/       # GOAT chain adapter layer (mainnet / testnet)
├── packages/       # Independent packages (create-goat-agent CLI)
├── examples/       # Minimal runnable examples
├── tests/          # Unit + integration tests
└── docs/           # Design documents
```

### Four-Layer Architecture

| Layer | Responsibility | Key File |
|-------|---------------|----------|
| **Core** | Runtime engine: Policy → Validation → Idempotency → Retry → Metrics → Timeout → Hooks | `core/runtime/execution-runtime.ts` |
| **Plugins** | Concrete implementations of on-chain operations (each plugin is a group of Actions) | `plugins/*/actions/*.ts` |
| **Adapters** | Convert Actions into tool formats for each AI framework | `adapters/*/tools.ts` |
| **Providers** | Action registration, discovery, and JSON Schema tool manifest generation | `providers/action-provider.ts` |

---

## Quick Start

### Option 1: CLI Scaffolding (recommended)

```bash
npm create goat-agent
# Follow prompts: project name → preset (minimal/defi/full) → network
cd my-agent && pnpm start
```

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
provider.openAITools();        // OpenAI Function Calling
provider.langChainToolDefs();  // LangChain Tools
provider.mcpTools();           // Model Context Protocol
provider.vercelAITools();      // Vercel AI SDK
provider.openAIAgentsTools();  // OpenAI Agents SDK
```

---

## Feature Modules (Plugins)

### Core On-Chain Operations

| Plugin | Actions | Functionality |
|--------|---------|---------------|
| **wallet** | 10 | ERC20 transfer / approve / balance / contract read & write / deploy / token symbol resolution |
| **bridge** | 7 | Bridge.sol real contract: withdraw / cancel / refund / replace-by-fee / deposit-status / withdrawal-status / get-params |
| **dex** | 7 | OKU (Uniswap V3): swap / quote / get-pool / add-liquidity / remove-liquidity / collect-fees / get-position |
| **x402** | 5 | Agent payment protocol: payment.create / submit-signature / transfer / status / cancel |

### Merchant & Identity

| Plugin | Actions | Functionality |
|--------|---------|---------------|
| **x402-merchant** | 30 | Merchant portal management: auth (register / login / refresh / invite) / dashboard / profile / orders / balance / addresses / callback-contracts / API keys / webhooks / invite-codes / audit-logs |
| **erc8004** | 9 | ERC-8004 Trustless Agents: register-agent / set-agent-uri / get-metadata / set-metadata / get-agent-wallet / give-feedback / revoke-feedback / get-reputation / get-clients |

### Protocols & Assets

| Plugin | Actions | Functionality |
|--------|---------|---------------|
| **layerzero** | 3 | LayerZero V2 OFT cross-chain: quote-send / send / quote-oft |
| **bitvm2** | 10 | BitVM2 BTC bridge + staking: bridge.deposit / bridge.withdraw / bridge.status / stake.register-pubkey / stake.approve / stake.stake / stake.lock / pegbtc.balance / pegin.request / pegout.initiate |
| **erc721** | 3 | NFT: mint / transfer / balance |
| **wgbtc** | 3 | Wrapped GBTC: wrap / unwrap / balance |
| **goat-token** | 3 | Governance: delegate / get-votes / get-delegates |
| **faucet** | 2 | Testnet tokens: request-funds / get-chains |
| **bitcoin** | 3 | On-chain BTC light client: block-hash / latest-height / network-name |

**Total: 95 Actions across 13 plugins** + `customActionProvider()` for unlimited custom extensions.

---

## AI Framework Adapters

| Adapter | Target Framework |
|---------|-----------------|
| `openai/tools.ts` | OpenAI Function Calling |
| `langchain/tools.ts` | LangChain Tools |
| `mcp/tools.ts` | Model Context Protocol |
| `vercel-ai/tools.ts` | Vercel AI SDK |
| `openai-agents/tools.ts` | OpenAI Agents SDK |

Define an Action once, automatically available across all five frameworks.

---

## Key Features

### 1. x402 Agent Payment Protocol + Merchant Portal

The core differentiating capability of AgentKit. Two complementary plugin sets:

**Payer side** (x402 — 5 actions): The Agent acts as the "payer", completing payments with merchant gateways via EIP-712 signatures:
- `HttpMerchantGatewayAdapter` — interfaces with merchant APIs
- `EvmPayerWalletAdapter` — local signing and authorization
- Full EIP-712 signing flow example (`examples/x402-payment-flow/`)

**Merchant side** (x402-merchant — 30 actions): Full merchant portal management via `MerchantPortalClient` HTTP adapter — auth, dashboard, orders, balance, webhooks, API keys, callback contracts, invite codes, and audit logs. Per-request token isolation via `ActionContext.accessToken` with `sensitiveOutputFields` redaction for hook/log safety.

This is the implementation of the Coinbase x402 protocol on GOAT Network, enabling Agents to complete on-chain payments without a human account.

### 2. Production-Grade Runtime Engine

Execution pipeline: **Policy Gate → Schema Validation (Zod) → Idempotency → Retry → Timeout → Metrics → Hooks**

- **Policy Engine**: Risk-gated action execution by risk level
- **Idempotency**: Dual-mode memory / Redis, with Lua script atomic lock release for Redis
- **Metrics**: Built-in Prometheus export (`/metrics`), aggregated by action labels
- **ExecutionHooks**: `onActionStart` / `onActionSuccess` / `onActionError` / `onPolicyBlocked` observation callbacks
- **Timeout**: `Promise.race` implementation, supporting per-action and global defaults

### 3. Dual WalletProvider

- `EvmWalletProvider` (ethers.js) — full-featured, including `writeContract` / `deployContract`
- `ViemWalletProvider` (viem) — modern EVM client
- `NoopWalletProvider` — development/testing placeholder

### 4. Token Registry + Symbol Resolution

`networks/goat/tokens.ts` maintains a GOAT chain token mapping table. The `wallet.resolve_token` action supports operating with symbols (e.g., `USDC`) directly, without manually looking up contract addresses.

### 5. CLI Scaffolding

`npm create goat-agent` — interactive project generator with three presets:
- **minimal** — wallet plugin only (10 actions)
- **defi** — wallet + wgbtc + bridge + bitcoin (27 actions)
- **full** — all 13 plugins (95 actions)

### 6. Dual Cross-Chain Channels

- **Bridge.sol** — GOAT native bridge (with full lifecycle: cancel / refund / replace-by-fee)
- **LayerZero V2 OFT** — general-purpose cross-chain protocol

---

## Highlights

1. **High Action density**: 95 Actions across 13 plugins covering wallet, DEX, bridge, NFT, governance, payments, merchant management, agent identity, and cross-chain — surpassing Coinbase Base AgentKit (50+)
2. **x402 payment is the killer feature**: Native Agent payment capability with full EIP-712 signing flow + 30-action merchant portal management, benchmarked against Coinbase but deployed on a Bitcoin L2
3. **Solid runtime engineering**: Idempotency + policy gateway + Prometheus metrics + execution hooks — this is not a demo-grade SDK
4. **Five-framework one-shot adaptation**: OpenAI / LangChain / MCP / Vercel AI / OpenAI Agents — define once, available everywhere
5. **Developer-friendly**: CLI scaffolding + complete examples + `customActionProvider` custom extensions + dual WalletProvider
6. **Unique Bitcoin ecosystem positioning**: Through BitVM2 + Bridge.Sol + BTC light client, building an Agent economy on a Bitcoin L2 — a track that Base AgentKit does not cover
7. **ERC-8004 Trustless Agent identity**: On-chain agent registration, metadata, and reputation system — enabling verifiable Agent identity and trust scoring
