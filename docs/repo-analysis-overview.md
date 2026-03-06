# GOAT AgentKit — Repo Analysis & Overview

> Analysis date: 2026-03-06
> Version: 0.1.0 | ~8,300 LOC (TypeScript) | 155 source files

## One-Liner

The GOAT Network counterpart to Coinbase AgentKit — a TypeScript SDK enabling AI Agents to autonomously execute on-chain operations on the GOAT chain.

---

## Repository Structure

```
agentkit/
├── core/           # Runtime engine (policy, validation, idempotency, retry, metrics, timeout, hooks)
├── plugins/        # 11 feature modules (51 Actions)
├── adapters/       # 5 AI framework adapters
├── providers/      # Action registry + tool manifest generation
├── networks/       # GOAT chain adapter layer (mainnet / testnet)
├── bin/            # CLI scaffolding (create-goat-agent)
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

## Feature Modules (Plugins)

### Core On-Chain Operations

| Plugin | Actions | Functionality |
|--------|---------|---------------|
| **wallet** | 10 | ERC20 transfer / approve / balance / contract read & write / deploy / token symbol resolution |
| **bridge** | 7 | Bridge.sol real contract: withdraw / cancel / refund / replace-by-fee / deposit-status / withdrawal-status / get-params |
| **dex** | 7 | OKU (Uniswap V3): swap / quote / get-pool / add-liquidity / remove-liquidity / collect-fees / get-position |
| **x402** | 5 | Agent payment protocol: payment.create / submit-signature / transfer / status / cancel |

### Protocols & Assets

| Plugin | Actions | Functionality |
|--------|---------|---------------|
| **layerzero** | 3 | LayerZero V2 OFT cross-chain: quote-send / send / quote-oft |
| **bitvm2** | 3 | BTC bridge: bridge.deposit / bridge.withdraw / bridge.status |
| **erc721** | 3 | NFT: mint / transfer / balance |
| **wgbtc** | 3 | Wrapped GBTC: wrap / unwrap / balance |
| **goat-token** | 3 | Governance: delegate / get-votes / get-delegates |
| **faucet** | 2 | Testnet tokens: request-funds / get-chains |
| **bitcoin** | 3 | On-chain BTC light client: block-hash / latest-height / network-name |

**Total: 51 Actions** + `customActionProvider()` for unlimited custom extensions.

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

### 1. x402 Agent Payment Protocol

The core differentiating capability of AgentKit. The Agent acts as the "payer", completing payments with merchant gateways via EIP-712 signatures:

- `HttpMerchantGatewayAdapter` — interfaces with merchant APIs
- `EvmPayerWalletAdapter` — local signing and authorization
- Full EIP-712 signing flow example (`examples/x402-payment-flow/`)

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

`create-goat-agent` offers three project templates:
- **minimal** — bare-bones starter
- **defi** — DeFi scenario (includes DEX + Bridge)
- **full** — all features

### 6. Dual Cross-Chain Channels

- **Bridge.sol** — GOAT native bridge (with full lifecycle: cancel / refund / replace-by-fee)
- **LayerZero V2 OFT** — general-purpose cross-chain protocol

---

## Highlights

1. **High Action density**: 51 Actions covering wallet, DEX, bridge, NFT, governance, payments, and cross-chain — on par with Coinbase Base AgentKit (50+)
2. **x402 payment is the killer feature**: Native Agent payment capability with full EIP-712 signing flow, benchmarked against Coinbase but deployed on a Bitcoin L2
3. **Solid runtime engineering**: Idempotency + policy gateway + Prometheus metrics + execution hooks — this is not a demo-grade SDK
4. **Five-framework one-shot adaptation**: OpenAI / LangChain / MCP / Vercel AI / OpenAI Agents — define once, available everywhere
5. **Developer-friendly**: CLI scaffolding + complete examples + `customActionProvider` custom extensions + dual WalletProvider
6. **Unique Bitcoin ecosystem positioning**: Through BitVM2 + Bridge.Sol + BTC light client, building an Agent economy on a Bitcoin L2 — a track that Base AgentKit does not cover
