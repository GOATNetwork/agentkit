# Goat AgentKit 详细蓝图（含 x402 支付 + BitVM2）

> 目标：做一个可用于 Agent 的 Goat 链 SDK，既兼容 Base AgentKit 风格，又突出 Goat 的 BTCFi 能力。

## 0. 设计目标

1. **Agent First**：所有链能力都以 Tool/Action 暴露，面向 LLM 函数调用。
2. **安全默认**：主网高风险动作必须可配置二次确认与限额。
3. **链差异内聚**：EVM 通用层复用，Goat 特性（x402、BitVM2）插件化。
4. **可运营**：具备日志、审计、重试、告警、SLA 指标。

---

## 1. 总体架构（分层）

### A. Core 基础层（通用）
- `ChainClient`：RPC / Gas / Nonce / Tx receipt
- `WalletProvider`：签名、账户、密钥托管抽象
- `SchemaEngine`：Action 输入输出 JSON Schema 校验
- `PolicyEngine`：风控策略（限额、白名单、时段、环境）
- `ExecutionRuntime`：执行、重试、幂等、错误标准化

### B. Goat 扩展层（链特化）
- `GoatNetworkAdapter`
  - network config（chainId, rpc, explorer）
  - gas token / 单位处理
- `BitVM2BridgeAdapter`
  - 跨链请求提交
  - 跨链状态跟踪（pending/proved/finalized/failed）
  - proof 生命周期钩子
- `X402PaymentAdapter`
  - 支付请求创建
  - 支付授权/签名
  - 支付状态查询与回调

### C. Protocol/DApp 适配层
- DEX 插件（quote/swap）
- Lending 插件（supply/borrow/repay）
- NFT 插件（mint/transfer）
- Bridge 插件（deposit/withdraw/status）

### D. Agent Tool 层
- `ActionProvider` 注册机制
- Tool Catalog（描述、schema、权限）
- AI 框架适配器（OpenAI/LangChain/MCP）

---

## 2. 目录蓝图（建议）

```text
agentkit/
  core/
    chain/
    wallet/
    runtime/
    policy/
    schema/
  networks/
    goat/
      adapter.ts
      config.ts
      gas.ts
      units.ts
  plugins/
    x402/
      adapter.ts
      actions/
        payment.create.ts
        payment.submit-signature.ts
        payment.status.ts
    bitvm2/
      adapter.ts
      actions/
        bridge.deposit.ts
        bridge.withdraw.ts
        bridge.status.ts
    dex/
    lending/
    nft/
  actions/
    wallet.balance.ts
    token.transfer.ts
  providers/
    action-provider.ts
    tool-catalog.ts
  adapters/
    openai/
    langchain/
    mcp/
  examples/
    minimal-agent/
    x402-payment-flow/
    bitvm2-bridge-flow/
  docs/
    architecture.md
    security.md
    runbook.md
```

---

## 3. Action 统一规范（核心）

每个 Action 至少包含：
- `name`：唯一标识（如 `goat.bridge.status`）
- `description`：面向模型的简洁说明
- `inputSchema`：JSON Schema
- `outputSchema`：JSON Schema
- `riskLevel`：`read | low | medium | high`
- `requiresConfirmation`：布尔值
- `networks`：可用网络列表
- `execute(ctx, input)`：执行函数

### 示例 Action（最小集）
1. `wallet.balance`
2. `token.transfer`
3. `goat.x402.payment.create`
4. `goat.x402.payment.status`
5. `goat.bitvm2.bridge.deposit`
6. `goat.bitvm2.bridge.status`

---

## 4. x402 支付模块设计

## 4.1 目标
支持 Agent 发起、确认、查询支付流程，适配 Goat 场景中的机器支付/服务付费。

## 4.2 关键能力
- 创建支付订单（金额、资产、收款方、过期时间）
- 返回支付凭据（payment intent / request id）
- 执行授权与签名
- 查询支付状态（created/authorized/settled/failed/expired）
- 幂等键支持（避免重复支付）

## 4.3 Action 设计
- `goat.x402.payment.create`
- `goat.x402.payment.submitSignature`
- `goat.x402.payment.status`
- `goat.x402.payment.cancel`（可选）

## 4.4 风控策略
- 默认限额（单笔、单日）
- 收款地址白名单
- 高风险支付强制二次确认
- 过期订单自动失效

---

## 5. BitVM2 模块设计

## 5.1 目标
让 Agent 能调用跨链流程，并可靠跟踪 BitVM2 相关状态。

## 5.2 关键能力
- 发起 L1 -> Goat 入金请求（deposit）
- 发起 Goat -> L1 出金请求（withdraw）
- 查询桥接状态（含 proof 阶段）
- 失败原因标准化（超时、证明失败、链上回滚）

## 5.3 Action 设计
- `goat.bitvm2.bridge.deposit`
- `goat.bitvm2.bridge.withdraw`
- `goat.bitvm2.bridge.status`
- `goat.bitvm2.bridge.estimateTime`（可选）

## 5.4 状态机（建议）
`CREATED -> PENDING_L1 -> PROVING -> PROVED -> FINALIZING -> FINALIZED`

失败支路：
`ANY -> FAILED(reason_code)`

---

## 6. 安全与治理（必须落地）

1. **策略层默认开启**：
   - testnet 默认优先
   - 主网写操作需显式允许
2. **交易确认机制**：
   - medium/high 风险 action 强制 confirm token
3. **密钥策略**：
   - 支持 KMS/HSM 或托管钱包，不建议裸私钥长期驻留
4. **审计日志**：
   - 记录 action 输入摘要、tx hash、调用者、策略命中
5. **紧急开关**：
   - 全局 pause write actions

---

## 7. 可观测性与运维

指标：
- Action 成功率、P95 延迟
- 链上确认时长
- x402 支付成功率
- BitVM2 跨链最终完成率

日志字段：
- `traceId`, `action`, `network`, `riskLevel`, `status`, `errorCode`, `txHash`

告警：
- 连续失败阈值
- 桥接卡住超时
- 支付失败率飙升

---

## 8. 版本规划（4 周 MVP）

### Week 1
- Core runtime + schema + policy
- `wallet.balance` / `token.transfer`

### Week 2
- x402 create/status + 示例
- OpenAI/LangChain 适配最小链路

### Week 3
- BitVM2 deposit/status + 状态轮询
- 错误码与重试机制

### Week 4
- 安全强化（确认机制、限额）
- 文档、runbook、端到端 demo

---

## 9. MVP 验收标准

1. Agent 能稳定调用 6 个核心 action（含 x402、BitVM2）。
2. 主网风险动作默认受策略限制。
3. 每笔写操作可追溯到审计日志与 tx hash。
4. 提供至少 2 个可运行示例：
   - x402 支付流程
   - BitVM2 跨链流程

---

## 10. 与 Base AgentKit 的关系（结论）

- **一致**：Tool/Action 思维、插件化、Agent 框架接入方式。
- **不同**：Goat 需要把 x402 与 BitVM2 作为一等公民模块，不是边缘插件。
- **建议**：保持“Base 风格 API + Goat 特化能力”，避免完全分叉造成维护负担。
