# agentkit

用于集成 Goat Network 的技能与应用 SDK。

## 目录结构

- `core/`：运行时引擎、策略引擎、错误类型、指标、日志
- `plugins/`：功能模块（x402、wallet、bitvm2、erc721、wgbtc、faucet、goat-token、bridge、bitcoin、dex、layerzero）
- `adapters/`：AI 框架集成（OpenAI、LangChain、MCP、Vercel AI SDK、OpenAI Agents SDK）
- `providers/`：Action 注册表与工具清单生成（Zod → JSON Schema）
- `networks/`：Goat 链适配层
- `examples/`：示例代码与最小可运行样例
- `docs/`：设计文档与使用说明
- `bin/`：CLI 脚手架（`create-goat-agent`）

## x402（Agent 作为支付方）

当前默认按“付款方模式”设计：
- Agent 调用**商户包装后的 API**（`MerchantGatewayAdapter`），而不是直接调用 goatx402 merchant-core API。
- Agent 本地通过 `PayerWalletAdapter` 处理签名/授权数据。

默认提供：
- `HttpMerchantGatewayAdapter`（对接商户 API，支持自定义路由）
- `NoopPayerWalletAdapter`（本地开发占位）

商户接口合同模板：
- `docs/x402-merchant-gateway.openapi.yaml`

初始化示例：
- `examples/x402-payment-flow/init-merchant-gateway.ts`

EIP-712 完整签名流示例：
- `examples/x402-payment-flow/eip712-full-flow.ts`
- 运行：`pnpm run example:x402-eip712`

错误码路径示例（INVALID_INPUT）：
- `examples/minimal-agent/error-path.ts`
- 运行：`pnpm run example:error-path`

幂等存储初始化示例（memory/redis 可切换）：
- `examples/minimal-agent/runtime-with-store.ts`
- 运行：`pnpm run example:runtime-store`

Prometheus metrics 示例：
- `examples/minimal-agent/metrics-prometheus.ts`
- 运行：`pnpm run example:metrics`
- 指标地址：`/metrics`（默认端口 `9464`）
- 指标按 action 等标签导出（便于 Grafana 聚合）

支付方核心动作（当前）：
- `goat.x402.payment.create`
- `goat.x402.payment.submitSignature`（callback 场景）
- `goat.x402.payment.transfer`（钱包转账支付本体）
- `goat.x402.payment.status`
- `goat.x402.payment.cancel`

Base 对齐冲刺计划：
- `docs/base-parity-sprint-plan-2026-02-28.md`

商户联调 runbook：
- `docs/merchant-integration-runbook.md`

集成测试：
- 运行：`pnpm run test:integration`
- 覆盖：x402 主流程 + runtime 幂等

Redis 幂等集成测试（需要本地 Redis）：
- 运行：`pnpm run test:redis`
- 覆盖：RedisIdempotencyStore 全链路，包括 Lua compare-and-delete 原子释放
- 前置条件：本地 Redis 可达（默认 `redis://127.0.0.1:6379`，可通过 `AGENTKIT_REDIS_URL` 覆盖）
- 注意：`test:integration` 在无 Redis 时会自动跳过这些测试；`test:redis` 则要求 Redis 必须可用，否则直接报错

可选环境变量：
- `GOAT_MAINNET_RPC_URL`
- `GOAT_TESTNET_RPC_URL`

> 兼容层里仍保留了 goatx402 merchant-core 直连方法，供联调或迁移使用。

## 后续建议

1. 用真实商户凭证联调 `/api/v1/orders` / `status` / `calldata-signature`
2. 对接 merchant callback 签名流（EIP-712）
3. 为 plugins 和 adapters 统一接口定义
