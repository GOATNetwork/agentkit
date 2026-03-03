# AgentKit Architecture (Initial Skeleton)

## Current implemented skeleton

- Core
  - `core/schema/action.ts`
  - `core/policy/policy-engine.ts`
  - `core/errors/error-codes.ts`
  - `core/errors/error.ts`
  - `core/metrics/metrics.ts`
  - `core/metrics/prometheus.ts`
  - `core/runtime/schema-validator.ts` (Zod + fallback JSON schema)
  - `core/runtime/execution-runtime.ts` (policy gate + retry + idempotency + structured logs + metrics)
  - `core/runtime/logger.ts`
  - `core/runtime/idempotency/store.ts`
  - `core/runtime/idempotency/redis-store.ts`
  - `core/runtime/idempotency/factory.ts`
- Networks
  - `networks/goat/config.ts`
  - `networks/goat/adapter.ts` (testnet/mainnet RPC ping + BitVM2 stubs; x402 merchant-core calls kept for compatibility)
- Providers
  - `providers/action-provider.ts`
  - `providers/tool-manifest.ts`
- Framework Adapters
  - `adapters/openai/tools.ts`
  - `adapters/langchain/tools.ts`
- Plugins
  - `plugins/x402/adapters/types.ts`
  - `plugins/x402/adapters/http-merchant-gateway.ts`
  - `plugins/x402/adapters/noop-payer-wallet.ts`
  - `plugins/x402/adapters/evm-payer-wallet.ts`
  - `plugins/x402/actions/payment.create.ts`
  - `plugins/x402/actions/payment.submit-signature.ts`
  - `plugins/x402/actions/payment.status.ts`
  - `plugins/x402/actions/payment.transfer.ts`
  - `plugins/x402/actions/payment.cancel.ts`
  - `plugins/bitvm2/actions/bridge.deposit.ts`
  - `plugins/bitvm2/actions/bridge.withdraw.ts`
  - `plugins/wallet/actions/balance.ts`
  - `plugins/bitvm2/actions/bridge.status.ts`
- Example
  - `examples/minimal-agent/index.ts`
  - `examples/minimal-agent/error-path.ts`
  - `examples/x402-payment-flow/init-merchant-gateway.ts`
  - `examples/x402-payment-flow/eip712-full-flow.ts`

## Next implementation steps

1. 接入 Redis 实例并验证 `RedisIdempotencyStore`（当前已提供实现）
2. 扩展集成测试到真实 HTTP merchant mock server 场景
3. Add OpenAI/LangChain adapter glue code
4. Add wallet.balance + chain client integration tests
