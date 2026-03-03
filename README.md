# agentkit

用于集成 Goat Network 的技能与应用 SDK。

## 目录结构

- `skills/`：可复用技能模块
- `apps/`：应用实现与集成入口
- `examples/`：示例代码与最小可运行样例
- `docs/`：设计文档与使用说明

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

可选环境变量：
- `GOAT_MAINNET_RPC_URL`
- `GOAT_TESTNET_RPC_URL`

> 兼容层里仍保留了 goatx402 merchant-core 直连方法，供联调或迁移使用。

## 后续建议

1. 用真实商户凭证联调 `/api/v1/orders` / `status` / `calldata-signature`
2. 对接 merchant callback 签名流（EIP-712）
3. 为 skills 和 apps 统一接口定义
