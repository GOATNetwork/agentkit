# AgentKit 追平 Base 体验冲刺计划（2 周）

## 目标
在 2 周内把当前 Goat AgentKit 从“可用骨架”推进到“可联调、可观测、可稳定运行”的工程化版本。

## Week 1（打基础）

### Day 1-2: Framework Adapter 层
- [ ] 增加 `adapters/openai/` 工具注册适配
- [ ] 增加 `adapters/langchain/` 工具注册适配
- [ ] 输出 tool manifest（从 ActionProvider 自动导出）

### Day 3: 钱包能力补齐
- [ ] 新增 `wallet.balance` action（native + ERC20）
- [ ] 增加统一 decimals 处理工具

### Day 4: 错误码体系
- [ ] 新增 `core/errors/error-codes.ts`
- [ ] adapter/action/runtime 统一错误码返回

### Day 5: 可观测性
- [ ] traceId 贯穿 action -> adapter
- [ ] 增加基础 metrics（成功率、耗时、失败码）

## Week 2（生产化）

### Day 6-7: 幂等持久化
- [ ] 抽象 IdempotencyStore 接口
- [ ] 新增内存实现 + Redis 实现
- [ ] runtime 支持存储注入

### Day 8-9: 集成测试
- [ ] x402 主流程测试（create/signature/transfer/status/cancel）
- [ ] 失败路径测试（签名失败、路由失败、超时）

### Day 10: 商户联调包
- [ ] 输出 merchant adapter 对接清单
- [ ] 提供 Postman/OpenAPI 示例请求
- [ ] 发布联调 runbook

## 本次先做（立即开始）
1. 建立错误码基础文件
2. 建立 OpenAI/LangChain 适配目录与占位实现
3. 建立 Tool Manifest 导出函数
