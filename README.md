# agentkit

Skills and application SDK for integrating with Goat Network.

## Directory Structure

- `core/`: Runtime engine, policy engine, error types, metrics, logging
- `plugins/`: Feature modules (x402, wallet, bitvm2, erc721, wgbtc, faucet, goat-token, bridge, bitcoin, dex, layerzero)
- `adapters/`: AI framework integrations (OpenAI, LangChain, MCP, Vercel AI SDK, OpenAI Agents SDK)
- `providers/`: Action registry and tool manifest generation (Zod → JSON Schema)
- `networks/`: Goat chain adapter layer
- `examples/`: Example code and minimal runnable samples
- `docs/`: Design documents and usage guides
- `bin/`: CLI scaffolding (`create-goat-agent`)

## x402 (Agent as Payer)

The default design follows the "payer mode":
- The agent calls **merchant-wrapped APIs** (`MerchantGatewayAdapter`) rather than calling the goatx402 merchant-core API directly.
- The agent handles signing/authorization data locally via `PayerWalletAdapter`.

Default adapters provided:
- `HttpMerchantGatewayAdapter` (connects to merchant API, supports custom routing)
- `NoopPayerWalletAdapter` (local development placeholder)

Merchant API contract template:
- `docs/x402-merchant-gateway.openapi.yaml`

Initialization example:
- `examples/x402-payment-flow/init-merchant-gateway.ts`

EIP-712 full signing flow example:
- `examples/x402-payment-flow/eip712-full-flow.ts`
- Run: `pnpm run example:x402-eip712`

Error code path example (INVALID_INPUT):
- `examples/minimal-agent/error-path.ts`
- Run: `pnpm run example:error-path`

Idempotency store initialization example (switchable between memory/redis):
- `examples/minimal-agent/runtime-with-store.ts`
- Run: `pnpm run example:runtime-store`

Prometheus metrics example:
- `examples/minimal-agent/metrics-prometheus.ts`
- Run: `pnpm run example:metrics`
- Metrics endpoint: `/metrics` (default port `9464`)
- Metrics are exported with labels such as action name (suitable for Grafana aggregation)

Payer core actions (current):
- `goat.x402.payment.create`
- `goat.x402.payment.submitSignature` (callback scenario)
- `goat.x402.payment.transfer` (wallet transfer payment itself)
- `goat.x402.payment.status`
- `goat.x402.payment.cancel`

Base parity sprint plan:
- `docs/base-parity-sprint-plan-2026-02-28.md`

Merchant integration runbook:
- `docs/merchant-integration-runbook.md`

Integration tests:
- Run: `pnpm run test:integration`
- Coverage: x402 main flow + runtime idempotency

Redis idempotency integration tests (requires local Redis):
- Run: `pnpm run test:redis`
- Coverage: Full RedisIdempotencyStore pipeline, including Lua compare-and-delete atomic release
- Prerequisite: Local Redis reachable (default `redis://127.0.0.1:6379`, overridable via `AGENTKIT_REDIS_URL`)
- Note: `test:integration` automatically skips these tests when Redis is unavailable; `test:redis` requires Redis to be available and will fail otherwise

Optional environment variables:
- `GOAT_MAINNET_RPC_URL`
- `GOAT_TESTNET_RPC_URL`

> The compatibility layer still retains direct goatx402 merchant-core methods for integration testing or migration purposes.

## Next Steps

1. End-to-end integration with real merchant credentials against `/api/v1/orders` / `status` / `calldata-signature`
2. Integrate merchant callback signing flow (EIP-712)
3. Unify interface definitions across plugins and adapters
