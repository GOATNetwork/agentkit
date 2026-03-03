# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agentkit is a plugin-based action execution SDK for integrating with Goat Network. It provides a runtime that orchestrates action execution with policy gates, schema validation, idempotency caching, retries, and Prometheus metrics. The README and docs are in Chinese; code and comments are in English.

## Commands

```bash
# Run integration tests (vitest)
pnpm run test:integration

# Run examples
pnpm run example:minimal        # Full x402 + BitVM2 action demo
pnpm run example:error-path     # Error handling paths
pnpm run example:runtime-store  # Idempotency store (memory/redis)
pnpm run example:metrics        # Prometheus metrics endpoint
pnpm run example:export-tools   # Tool manifest export
pnpm run example:x402-eip712    # EIP-712 payment signature flow
```

ESLint and Prettier are configured. TypeScript is compiled via `tsx` (runtime) and `typescript` (type checking).

```bash
# Lint source files
pnpm run lint

# Format source files
pnpm run format

# Check formatting without writing
pnpm run format:check
```

## Architecture

### 4-Layer Structure

1. **Core** (`core/`) — Runtime engine, policy engine, error types, metrics, logging
2. **Plugins** (`plugins/`) — Feature modules that define actions (see Plugin Inventory below)
3. **Adapters** (`adapters/`) — AI framework integrations (OpenAI function calling, LangChain tools, MCP, Vercel AI SDK, OpenAI Agents SDK)
4. **Providers** (`providers/`) — Action registry and tool manifest generation (Zod → JSON Schema)

Supporting directories: `networks/` (Goat chain adapter), `examples/`, `tests/integration/`, `docs/`, `bin/` (CLI scaffolding).

### Key Runtime Flow

`ExecutionRuntime.execute(actionName, input, opts)` is the central orchestrator:
1. Schema validation (Zod or JSON Schema fallback)
2. Policy engine evaluation (network allowlist, risk level confirmation gates, write-op enable)
3. Idempotency cache check (TTL-based, in-memory or Redis)
4. Action handler invocation with retries (exponential backoff)
5. Prometheus metrics recording (counters + histograms, labeled by action/error)
6. Structured JSON logging

### Action Definition Pattern

Actions implement the `Action` interface from `core/schema/action.ts` with:
- `name`: dotted identifier (e.g., `goat.x402.payment.create`)
- `inputSchema` / `outputSchema`: Zod schemas
- `riskLevel`: `read | low | medium | high` (high requires explicit confirmation)
- `handler(input, context)`: async execution logic

### Adapter Pattern

External integrations use adapter interfaces with swappable implementations:
- `MerchantGatewayAdapter` → `HttpMerchantGatewayAdapter` (production) / mock (tests)
- `PayerWalletAdapter` → `EvmPayerWalletAdapter` (ethers.js) / `NoopPayerWalletAdapter` (dev)
- `GoatAdapter` → Goat chain RPC + HMAC-SHA256 merchant-core signing

### Error Handling

All errors flow through `AgentkitRuntimeError` with typed codes: `INVALID_INPUT`, `POLICY_BLOCKED`, `ACTION_NOT_FOUND`, `ADAPTER_REQUEST_FAILED`, `WALLET_SIGN_FAILED`, `WALLET_TRANSFER_FAILED`, `TIMEOUT`, `INTERNAL_ERROR`.

### Plugin Inventory (51 actions across 11 plugins)

| Plugin | Directory | Actions | Notes |
|--------|-----------|---------|-------|
| **x402** | `plugins/x402/` | 5 — `payment.create`, `payment.status`, `payment.submit-signature`, `payment.transfer`, `payment.cancel` | EIP-712 payment flow via MerchantGatewayAdapter |
| **Wallet** | `plugins/wallet/` | 10 — `balance`, `get_details`, `get_allowance`, `contract_read`, `contract_write`, `transfer_native`, `transfer_erc20`, `approve_erc20`, `deploy_contract`, `resolve_token` | Generic EVM wallet operations |
| **BitVM2** | `plugins/bitvm2/` | 3 — `bridge.deposit`, `bridge.withdraw`, `bridge.status` | Stubbed BitVM2 bridge via GoatAdapter |
| **ERC721** | `plugins/erc721/` | 3 — `balance`, `transfer`, `mint` | NFT operations |
| **WGBTC** | `plugins/wgbtc/` | 3 — `wrap`, `unwrap`, `balance` | Wrapped GOAT BTC (predeployed `0xBC10…0000`) |
| **Faucet** | `plugins/faucet/` | 2 — `request_funds`, `get_chains` | Testnet faucet via FaucetAdapter |
| **GoatToken** | `plugins/goat-token/` | 3 — `delegate`, `get_votes`, `get_delegates` | Governance token (predeployed `0xbC10…0001`), ERC20Votes |
| **Bridge** | `plugins/bridge/` | 7 — `withdraw`, `cancel`, `refund`, `replace_by_fee`, `deposit_status`, `withdrawal_status`, `get_params` | On-chain BTC bridge (predeployed `0xBC10…0003`), `withdraw` is payable |
| **Bitcoin** | `plugins/bitcoin/` | 3 — `block_hash`, `latest_height`, `network_name` | Bitcoin block oracle / light client (predeployed `0xbC10…0005`), all read-only |
| **DEX** | `plugins/dex/` | 7 — `quote`, `swap`, `get_pool`, `add_liquidity`, `remove_liquidity`, `collect_fees`, `get_position` | OKU (Uniswap V3) on goat-mainnet; `swap`/`add_liquidity` are payable |
| **LayerZero** | `plugins/layerzero/` | 3 — `quote_send`, `send`, `quote_oft` | LayerZero V2 OFT cross-chain transfers (EID 30361); `send` is payable |

### Predeployed Contract Addresses

| Contract | Address |
|----------|---------|
| WGBTC | `0xBC10000000000000000000000000000000000000` |
| GoatToken | `0xbC10000000000000000000000000000000000001` |
| Bridge | `0xBC10000000000000000000000000000000000003` |
| Bitcoin | `0xbC10000000000000000000000000000000000005` |
| OKU SwapRouter02 | `0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455` |
| OKU QuoterV2 | `0x5911cB3633e764939edc2d92b7e1ad375Bb57649` |
| OKU PositionManager | `0x743E03cceB4af2efA3CC76838f6E8B50B63F184c` |
| OKU V3Factory | `0xcb2436774C3e191c85056d248EF4260ce5f27A9D` |
| LayerZero Endpoint V2 | `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B` |

### WalletProvider

`core/wallet/wallet-provider.ts` defines the interface; three implementations exist:
- `EvmWalletProvider` — production (ethers.js Signer + Provider)
- `ViemWalletProvider` — production alternative (viem WalletClient + PublicClient)
- `NoopWalletProvider` — dev/test mock

`writeContract` supports an optional `value?: string` parameter for payable contract calls (used by `bridge.withdraw`). `deployContract` deploys contracts on-chain given ABI + bytecode.

### ExecutionHooks

The runtime supports optional `ExecutionHooks` for analytics/observability callbacks:
- `onActionStart(event)` — fired at each attempt start
- `onActionSuccess(event)` — fired on success
- `onActionError(event)` — fired on final retry exhaustion
- `onPolicyBlocked(event)` — fired when policy denies

Pass hooks via `ExecutionConfig.hooks` when constructing `ExecutionRuntime`.

### Token Registry

`networks/goat/tokens.ts` provides a centralized symbol→address mapping for Goat predeployed contracts (`WGBTC`, `GOAT`, `BRIDGE`, `BITCOIN`). The `wallet.resolve_token` action exposes this to agents.

### Environment Variables

See `.env.example` for full list. Key variables:
- `AGENTKIT_IDEMPOTENCY_MODE` — `memory` (default) or `redis`
- `AGENTKIT_REDIS_URL` — Redis connection when mode=redis
- `AGENTKIT_METRICS_PORT` — Prometheus port (default 9464)
- `MERCHANT_API_BASE_URL` / `MERCHANT_API_KEY` — Merchant gateway config
- `GOAT_MAINNET_RPC_URL` / `GOAT_TESTNET_RPC_URL` — Goat chain RPC endpoints

### CLI Scaffolding (`create-goat-agent`)

`bin/create-goat-agent.ts` is an interactive CLI that scaffolds new agent projects. Three presets:
- **minimal** — wallet plugin only (10 actions)
- **defi** — wallet + wgbtc + bridge + bitcoin
- **full** — all 9 plugins (41 actions)

Run via `pnpm create-goat-agent` or `npx create-goat-agent`. The `generateProject()` function is exported for testing.
