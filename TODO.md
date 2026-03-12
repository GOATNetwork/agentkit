# Goat AgentKit vs Coinbase Base AgentKit 差距分析

## 当前 Goat AgentKit 状态
- **51 个 Action**（X402×5 + Wallet×10 + BitVM2×3 + ERC721×3 + WGBTC×3 + Faucet×2 + GoatToken×3 + Bridge×7 + Bitcoin×3 + DEX×7 + LayerZero×3 + customActionProvider 支持自定义）
- **5 个 AI 框架适配**（OpenAI / LangChain / MCP / Vercel AI SDK / OpenAI Agents SDK）
- **2 个 WalletProvider**（EVM ethers.js + Viem；含 `writeContract` / `deployContract` 支持）
- **2 条网络**（goat-mainnet / goat-testnet）
- **ESLint + Prettier** 已配置
- **Timeout 执行** 已实现（`timeoutMs` / `defaultTimeoutMs`）
- **ExecutionHooks** — runtime 回调（onActionStart / onActionSuccess / onActionError / onPolicyBlocked）
- **Token Registry** — 符号→地址映射（`networks/goat/tokens.ts`）

## Coinbase Base AgentKit 对照
- **50+ Action**，36 个 ActionProvider 目录
- **7 个 AI 框架适配**（含 Vercel AI SDK、OpenAI Agents SDK、Pydantic AI 等）
- **9 个 WalletProvider**（CDP / Viem / Privy / ZeroDev / Solana Keypair…）
- **多链支持**（Base / Ethereum / Arbitrum / Polygon / Optimism / Solana）

---

## P0 — 架构层差距（影响扩展性）

| # | 差距 | Base AgentKit 做法 | 当前 Goat 状态 | 工作量 |
|---|------|-------------------|---------------|--------|
| 1 | **Decorator 注册模式** | `@CreateAction` 装饰器自动注册 + analytics | 手动 factory function | 中 — 可保持 factory 模式，但应考虑加入 analytics hook |
| 2 | **supportsNetwork 在 Provider 级别** | 每个 ActionProvider 有 `supportsNetwork(network)` | Action 有 `networks[]` 字段 + `listForNetwork()` | ✅ 已有，思路不同但功能等价 |
| 3 | **customActionProvider** | 用户无需子类即可注册自定义 action | ✅ 已实现 `customActionProvider()` helper | ~~小~~ ✅ 已完成 |
| 4 | **Monorepo 分包** | `@coinbase/agentkit` + `@coinbase/agentkit-langchain` 等独立包 | 单包 + subpath exports | 中 — 当前阶段 subpath 够用 |
| 5 | **Linter / Formatter** | ESLint + Prettier | ✅ 已配置 ESLint (flat config) + Prettier | ~~小~~ ✅ 已完成 |

## P1 — 核心能力差距

| # | 差距 | Base AgentKit 做法 | 当前 Goat 状态 | 优先级 |
|---|------|-------------------|---------------|--------|
| 6 | **ERC721 (NFT)** | mint / transfer / get_balance | ✅ `erc721.balance` / `erc721.transfer` / `erc721.mint` | ~~高~~ ✅ 已完成 |
| 7 | **WETH wrap/unwrap** | 独立 action provider | ✅ `wgbtc.wrap` / `wgbtc.unwrap` / `wgbtc.balance` | ~~中~~ ✅ 已完成 |
| 8 | **Faucet / 测试币** | `request_faucet_funds` 支持 base-sepolia | ✅ `faucet.request_funds` / `faucet.get_chains` | ~~中~~ ✅ 已完成 |
| 9 | **get_wallet_details** | 返回地址 + 网络 + 余额 + provider 名 | ✅ `wallet.get_details` 聚合 address/network/balance | ~~小~~ ✅ 已完成 |
| 10 | **ERC20 getAllowance** | 查询已授权额度 | ✅ `wallet.get_allowance` action | ~~小~~ ✅ 已完成 |
| 11 | **ERC20 token address 解析** | 符号 → 合约地址映射（USDC / CBBTC 等） | ✅ `wallet.resolve_token` + `networks/goat/tokens.ts` | ~~小~~ ✅ 已完成 |
| 12 | **Smart contract 部署** | Agent 可链上部署合约 | ✅ `wallet.deploy_contract` action + `deployContract` on WalletProvider | ~~中~~ ✅ 已完成 |
| 13 | **通用 contract write** | WalletProvider 可直接发送 calldata | ✅ `wallet.contract_write` action + `writeContract` on WalletProvider | ~~中~~ ✅ 已完成 |
| 14 | **Timeout 执行** | - | ✅ `timeoutMs` + `defaultTimeoutMs` + `Promise.race` 实现 | ~~中~~ ✅ 已完成 |

## P2 — DeFi / 协议集成差距

| # | 差距 | Base AgentKit | Goat AgentKit | 备注 |
|---|------|--------------|---------------|------|
| 15 | **DEX / Swap** | 0x / SushiSwap / Jupiter / Enso | ✅ `dex.quote` / `dex.swap` / `dex.get_pool` / `dex.add_liquidity` / `dex.remove_liquidity` / `dex.collect_fees` / `dex.get_position` (OKU Uniswap V3) | ~~高~~ ✅ 已完成 |
| 16 | **借贷协议** | Compound V3 / Morpho / Moonwell | ❌ | 需 Goat 链上协议支持 |
| 17 | **跨链桥** | Across Protocol | ✅ Bridge.sol 真实合约集成（withdraw/cancel/refund/rbf/status）+ BitVM2 stub + LayerZero V2 OFT（quote_send/send/quote_oft） | Bridge + LayerZero 双通道 |
| 18 | **流支付** | Superfluid | ❌ | |
| 19 | **价格/TVL 查询** | DefiLlama / Allora | Bitcoin oracle（block hash/height/network）| 已接入链上 Bitcoin light client |

## P3 — AI 框架 & 社交集成

| # | 差距 | Base AgentKit | Goat AgentKit |
|---|------|--------------|---------------|
| 20 | **Vercel AI SDK 适配** | ✅ | ✅ `toVercelAITools` + `ActionProvider.vercelAITools()` |

| 21 | **OpenAI Agents SDK** | ✅ (Python) | ✅ `toOpenAIAgentsTools` + `ActionProvider.openAIAgentsTools()` |
| 22 | **Twitter / X** | 发推/回复/媒体上传 | ❌ |
| 23 | **Farcaster** | 发 cast / 查 profile | ❌ |
| 24 | **CLI 脚手架 (create-goat-agent)** | ✅ | ✅ `packages/create-goat-agent/`（独立 npm 包，minimal / defi / full 三种预设） |

## P4 — 钱包提供者多样性

| # | 差距 | Base AgentKit | Goat AgentKit |
|---|------|--------------|---------------|
| 25 | **CDP Server Wallet** | CdpEvmWalletProvider | ❌ |
| 26 | **Smart Wallet (AA)** | CdpSmartWalletProvider / ZeroDev | ❌ |
| 27 | **Viem 集成** | ViemWalletProvider | ✅ `ViemWalletProvider`（viem WalletClient + PublicClient） |
| 28 | **Privy 嵌入式钱包** | PrivyWalletProvider | ❌ |
| 29 | **Solana 支持** | SVM WalletProvider + SPL tokens | ❌ |

---

## 建议优先级排序

### 短期可实现（1-2 周） — ✅ 全部完成
1. ✅ `customActionProvider` helper — `providers/custom-action-provider.ts`
2. ✅ `wallet.get_details` 聚合 action — `plugins/wallet/actions/get-details.ts`
3. ✅ `wallet.get_allowance` + `wallet.contract_write` action — `plugins/wallet/actions/get-allowance.ts` + `contract-write.ts`
4. ✅ ERC721 基础 action（mint / transfer / balance）— `plugins/erc721/`
5. ✅ ESLint + Prettier 配置 — `eslint.config.js` + `.prettierrc.json`
6. ✅ Timeout 执行（Promise.race）— `core/runtime/execution-runtime.ts`

### 中期（2-4 周）
7. ✅ Vercel AI SDK 适配器 — `adapters/vercel-ai/tools.ts`
8. ✅ Faucet action — `plugins/faucet/`
9. ✅ WETH(WGBTC) wrap/unwrap — `plugins/wgbtc/`
10. ✅ GoatToken 治理插件（delegate / getVotes / getDelegates）— `plugins/goat-token/`
11. ✅ Bridge.sol 真实合约集成（withdraw/cancel/refund/rbf/depositStatus/withdrawalStatus/getParams）— `plugins/bridge/`
12. ✅ Bitcoin oracle 插件（blockHash / latestHeight / networkName）— `plugins/bitcoin/`
13. ✅ 通用 contract deploy action — `wallet.deploy_contract`
14. ✅ Viem WalletProvider — `core/wallet/viem-wallet-provider.ts`
15. ✅ ExecutionHooks — `core/runtime/execution-hooks.ts`
16. ✅ Token Registry — `networks/goat/tokens.ts` + `wallet.resolve_token`

### 长期 / 取决于 Goat 生态
17. DEX 集成（取决于 Goat 链上 DEX 部署情况）
13. 借贷协议集成
14. 社交集成（Twitter / Farcaster）
15. 多 WalletProvider（Viem / AA / Privy）
16. Solana / 多链扩展

---

**总结：** 核心运行时（Policy → Validation → Idempotency → Retry → Metrics → Timeout → Hooks）已经与 Base AgentKit 对齐。短期 6 项全部完成，中期全部完成。Action 数量从 13 增至 51（含 customActionProvider 支持无限自定义），AI 框架适配 5 个（含 OpenAI Agents SDK），WalletProvider 2 个（Evm + Viem），已覆盖 Goat Network 四大预部署合约 + OKU DEX (Uniswap V3) + LayerZero V2 OFT 跨链。新增 Token Registry 符号解析、Contract Deploy、ExecutionHooks 观测回调、`create-goat-agent` CLI 脚手架。剩余差距主要在 **生态集成广度**（借贷协议、社交、多链），其中很多取决于 Goat 链自身的生态成熟度。
