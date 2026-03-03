# Base 链 Agent SDK 调研（2026-02-28）

## 结论（先说重点）
当前最值得参考的“Base 生态 + Agent 可调用接口”方案是 **Coinbase AgentKit（CDP AgentKit）**。

## 官方信息
- AgentKit 文档: https://docs.cdp.coinbase.com/agentkit/docs/welcome
- AgentKit 仓库: https://github.com/coinbase/agentkit
- CDP Node SDK: https://github.com/coinbase/cdp-sdk-nodejs

## 核心能力（面向 Agent）
1. 钱包与身份
   - CDP/MPC 钱包接入
   - 地址与余额查询
   - 网络配置（如 Base Mainnet / Sepolia）

2. 链上动作（Tool 化）
   - 转账（transfer）
   - 交易/兑换（trade/swap）
   - NFT 操作（mint 等）

3. 框架适配与扩展
   - 可接 LangChain / OpenAI 等 Agent 框架
   - 通过 Action Provider/插件机制扩展可调用动作

## 可借鉴给 goat-sdk 的设计点
1. **工具接口标准化**
   - 为每个动作提供统一元数据：name、description、schema、network constraints
   - 让 LLM 能稳定做函数调用

2. **插件化 Action Provider**
   - 把每条链上能力拆为插件，按需注册
   - 支持第三方扩展（社区贡献）

3. **安全层优先**
   - 抽象签名与钱包能力，避免业务层直接触私钥
   - 增加白名单/额度/风控策略（尤其自动转账动作）

4. **开发体验**
   - 提供最小可运行示例（一个 Agent + 一个 transfer/swap）
   - 提供统一错误码与重试策略

## 建议下一步（goat-sdk）
1. 先定义 `Action` 最小接口规范（TypeScript types + JSON Schema）。
2. 先做 2 个基础插件：`wallet.balance`、`token.transfer`。
3. 在 `examples/` 放一个可跑通的 Agent Demo（LangChain 或 OpenAI Responses）。
4. 在 `docs/` 增补“安全默认策略”（测试网默认、小额默认、确认机制）。
