# Merchant Integration Runbook (x402 Payer Mode)

## 1) 必备接口
商户侧需提供以下接口（可参考 `docs/x402-merchant-gateway.openapi.yaml`）：
- `POST /x402/create-order`
- `GET /x402/order-status/{paymentId}`
- `POST /x402/submit-signature`
- `POST /x402/cancel-order`

## 2) 字段对齐检查
- create 响应必须包含：`paymentId`
- 建议包含：`payToAddress`, `tokenAddress`
- callback 场景建议包含：`calldataSignRequest`

## 3) AgentKit 配置
在 `.env` 中配置：
- `MERCHANT_API_BASE_URL`
- `MERCHANT_API_KEY`（如需要）
- 路由可选覆盖：
  - `MERCHANT_CREATE_ORDER_PATH`
  - `MERCHANT_ORDER_STATUS_PATH`
  - `MERCHANT_SUBMIT_SIGNATURE_PATH`
  - `MERCHANT_CANCEL_ORDER_PATH`

## 4) 幂等存储
- 开发环境：`AGENTKIT_IDEMPOTENCY_MODE=memory`
- 生产建议：`AGENTKIT_IDEMPOTENCY_MODE=redis` + `AGENTKIT_REDIS_URL`

## 5) 联调顺序（建议）
1. `payment.create`
2. callback 场景执行 `payment.submitSignature`
3. 执行 `payment.transfer`
4. 轮询 `payment.status`
5. 失败/超时场景验证 `payment.cancel`

## 6) 验收清单
- [ ] create 返回 paymentId
- [ ] transfer 返回 txHash
- [ ] status 可追踪到 settled/failed
- [ ] cancel 在可取消状态下成功
- [ ] runtime 错误包含 `errorCode`
- [ ] `pnpm run test:integration` 全绿
