# GOAT AgentKit — Repo Analysis & Overview

> 分析日期：2026-03-06
> 版本：0.1.0 | ~8,300 LOC (TypeScript) | 155 源文件

## 一句话定位

GOAT Network 版 Coinbase AgentKit —— 让 AI Agent 能在 GOAT 链上自主执行链上操作的 TypeScript SDK。

---

## 整体结构

```
agentkit/
├── core/           # 运行时引擎（策略、校验、幂等、重试、指标、超时、钩子）
├── plugins/        # 11 个功能模块（51 个 Action）
├── adapters/       # 5 个 AI 框架适配器
├── providers/      # Action 注册表 + 工具清单生成
├── networks/       # GOAT 链适配层（mainnet / testnet）
├── bin/            # CLI 脚手架（create-goat-agent）
├── examples/       # 最小可运行样例
├── tests/          # 单元测试 + 集成测试
└── docs/           # 设计文档
```

### 四层架构

| 层 | 职责 | 关键文件 |
|----|------|----------|
| **Core** | 运行时引擎：Policy → Validation → Idempotency → Retry → Metrics → Timeout → Hooks | `core/runtime/execution-runtime.ts` |
| **Plugins** | 链上操作的具体实现（每个 plugin 是一组 Action） | `plugins/*/actions/*.ts` |
| **Adapters** | 将 Action 转换为各 AI 框架的 tool 格式 | `adapters/*/tools.ts` |
| **Providers** | Action 注册、发现与 JSON Schema 工具清单生成 | `providers/action-provider.ts` |

---

## 功能模块（Plugins）

### 核心链上操作

| Plugin | Action 数 | 功能 |
|--------|-----------|------|
| **wallet** | 10 | ERC20 转账/授权/余额查询/合约读写/部署/token 符号解析 |
| **bridge** | 7 | Bridge.sol 真实合约：withdraw / cancel / refund / replace-by-fee / deposit-status / withdrawal-status / get-params |
| **dex** | 7 | OKU (Uniswap V3)：swap / quote / get-pool / add-liquidity / remove-liquidity / collect-fees / get-position |
| **x402** | 5 | Agent 支付协议：payment.create / submit-signature / transfer / status / cancel |

### 协议与资产

| Plugin | Action 数 | 功能 |
|--------|-----------|------|
| **layerzero** | 3 | LayerZero V2 OFT 跨链：quote-send / send / quote-oft |
| **bitvm2** | 3 | BTC 桥：bridge.deposit / bridge.withdraw / bridge.status |
| **erc721** | 3 | NFT：mint / transfer / balance |
| **wgbtc** | 3 | Wrapped GBTC：wrap / unwrap / balance |
| **goat-token** | 3 | 治理：delegate / get-votes / get-delegates |
| **faucet** | 2 | 测试币：request-funds / get-chains |
| **bitcoin** | 3 | 链上 BTC light client：block-hash / latest-height / network-name |

**合计：51 个 Action** + `customActionProvider()` 支持无限自定义扩展。

---

## AI 框架适配器

| 适配器 | 对接框架 |
|--------|----------|
| `openai/tools.ts` | OpenAI Function Calling |
| `langchain/tools.ts` | LangChain Tools |
| `mcp/tools.ts` | Model Context Protocol |
| `vercel-ai/tools.ts` | Vercel AI SDK |
| `openai-agents/tools.ts` | OpenAI Agents SDK |

Action 定义一次，五个框架自动适配。

---

## 特色 Feature

### 1. x402 Agent 支付协议

AgentKit 的核心差异化能力。Agent 作为"付款方"，通过 EIP-712 签名与商户网关完成支付：

- `HttpMerchantGatewayAdapter` —— 对接商户 API
- `EvmPayerWalletAdapter` —— 本地签名/授权
- 完整的 EIP-712 签名流示例（`examples/x402-payment-flow/`）

这是 Coinbase x402 协议在 GOAT Network 上的落地实现，让 Agent 无需人类账户即可完成链上支付。

### 2. 生产级运行时引擎

执行链路：**Policy Gate → Schema Validation (Zod) → Idempotency → Retry → Timeout → Metrics → Hooks**

- **Policy Engine**：风控网关，按 Action 风险等级拦截
- **Idempotency**：内存 / Redis 双模式，Redis 使用 Lua 脚本原子释放锁
- **Metrics**：内置 Prometheus 导出（`/metrics`），按 action 标签聚合
- **ExecutionHooks**：`onActionStart` / `onActionSuccess` / `onActionError` / `onPolicyBlocked` 观测回调
- **Timeout**：`Promise.race` 实现，支持 per-action 和全局默认

### 3. 双 WalletProvider

- `EvmWalletProvider`（ethers.js）—— 全功能，含 `writeContract` / `deployContract`
- `ViemWalletProvider`（viem）—— 现代 EVM 客户端
- `NoopWalletProvider` —— 开发/测试占位

### 4. Token Registry + 符号解析

`networks/goat/tokens.ts` 维护 GOAT 链 token 映射表，`wallet.resolve_token` action 支持用符号（如 `USDC`）直接操作，无需手动查合约地址。

### 5. CLI 脚手架

`create-goat-agent` 提供三种项目模板：
- **minimal** —— 最小启动
- **defi** —— DeFi 场景（含 DEX + Bridge）
- **full** —— 全功能

### 6. 双通道跨链

- **Bridge.sol** —— GOAT 原生桥（含 cancel / refund / replace-by-fee 等完整生命周期）
- **LayerZero V2 OFT** —— 通用跨链协议

---

## 亮点总结

1. **Action 密度高**：51 个 Action 覆盖钱包、DEX、桥、NFT、治理、支付、跨链，与 Coinbase Base AgentKit（50+）数量持平
2. **x402 支付是杀手级特性**：Agent 原生支付能力，完整 EIP-712 签名流，对标 Coinbase 但落地在 Bitcoin L2
3. **运行时工程质量扎实**：幂等 + 策略网关 + Prometheus 指标 + 执行钩子，不是 demo 级 SDK
4. **五框架一键适配**：OpenAI / LangChain / MCP / Vercel AI / OpenAI Agents，定义一次全平台可用
5. **开发者友好**：CLI 脚手架 + 完整示例 + `customActionProvider` 自定义扩展 + 双 WalletProvider
6. **Bitcoin 生态定位独特**：通过 BitVM2 + Bridge.Sol + BTC light client，在 Bitcoin L2 上构建 Agent 经济，这是 Base AgentKit 没有的赛道

---

## 与 Coinbase Base AgentKit 的主要差距

| 维度 | GOAT AgentKit | Coinbase Base AgentKit |
|------|---------------|----------------------|
| Action 数量 | 51 | 50+ |
| AI 框架适配 | 5 | 7 |
| WalletProvider | 2（EVM + Viem） | 9（含 CDP / AA / Privy / Solana） |
| 多链支持 | GOAT mainnet / testnet | Base / ETH / Arb / Polygon / Optimism / Solana |
| 社交集成 | ❌ | Twitter / Farcaster |
| 借贷协议 | ❌ | Compound / Morpho / Moonwell |
| 独有能力 | x402 支付 + BitVM2 + BTC oracle | CDP 托管钱包 + 多链 |

**核心运行时已对齐，差距主要在生态集成广度**，其中很多取决于 GOAT 链自身生态的成熟度。
