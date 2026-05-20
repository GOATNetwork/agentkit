# 测试网 Register 全流程 E2E 操作手册（1Password `op run`）

一份可逐步复制粘贴的指引，用于在 **GOAT Testnet3 上跑通完整的 GNS `.goat` 域名注册流程**，签名私钥从 1Password 注入（永不落盘）。同时覆盖跨链 x402 变体与礼品卡购买。

> 配套文档：`docs/WALLET-SECURITY.md`（密钥配置）、`docs/E2E-TEST-REPORT.md`（无钱包已验证的部分）。所有命令在仓库根目录 `/home/r/projects/github/agentkit`、分支 `feat/gns-giftcard-foundation` 下执行。

---

## 0. 一次性准备

1. **专用测试网钱包。** 生成一个全新的 EVM 私钥，**仅用于测试**——绝不要用个人/主网钱包。（如 `cast wallet new`，或任意钱包导出。）
2. **在 GOAT Testnet3（chainId 48816）上充值：**
   - 原生 gas（testnet GOAT/BTC）+ 测试 USDC 或 USDT。用 GOAT testnet 水龙头（见 `https://gns.testnet3.goat.network` / GOAT 文档）。注册大约需要 ~3 tUSDC，外加一点 gas。
3. **把私钥存入 1Password。** 新建一个 item，例如：
   - Item：`GOAT agent testnet` → 字段 `private_key` = `0x...`
4. **确认 1Password CLI 已登录：** `op whoami`。

---

## 1. 创建 `.env`（只写引用，密钥不落盘）

```bash
cat > .env <<'EOF'
# 1Password 引用 —— op run 在启动时解析，密钥不落盘：
GOAT_PRIVATE_KEY=op://Private/GOAT agent testnet/private_key

GOAT_NETWORK=goat-testnet
GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network
GNS_API_BASE_URL=https://gns-api.testnet3.goat.network/api
GIFTCARD_API_BASE_URL=https://giftcard-api.goat.network
EOF
```

`.env` 已被 gitignore。它存的是 `op://` **引用**，不是私钥本体。

---

## 2. 预检（只读 —— 不需要密钥，先跑这步确认接线正常）

```bash
# 这些不需要 op run —— 都是匿名 GET：
node bin/gns.mjs --network goat-testnet doctor --json
node bin/gns.mjs --network goat-testnet search myagentname --json
node bin/gns.mjs --network goat-testnet price myagentname.goat --years 1 --token USDC --json
```

确认：`doctor` 显示 API 可达；`search` 显示目标名字为 `available`；`price` 返回报价（约 3 tUSDC）。选一个 available 的名字。

---

## 3. Register 流程 Dry-run（不发交易，验证计划）

```bash
DEMO_MOCK=true node bin/gns.mjs register myagentname.goat \
  --years 1 --token USDC --reverse \
  --description "My AI agent" --url https://example.com \
  --dry-run --json
```

期望 exit 0，并打印计划：
`['estimatePrice','commit','waitForCommitment','register','setProfileRecords','setPrimaryName']`。

---

## 4. 真实 Register —— 通过 `op run` 跑完整流程

这一条命令会依次执行 **commit → 轮询 60 秒揭示窗口 → register → 写入 profile 记录 → 设为主名**。轮询循环（为了让流程在单次调用内完成而新增）最多等待 `--wait-timeout` 秒。

```bash
op run --env-file=.env -- node bin/gns.mjs register myagentname.goat \
  --years 1 --token USDC --reverse \
  --description "My AI agent" --url https://example.com \
  --wait-timeout 180 --poll-interval 10
```

你会按顺序看到：
1. **estimatePrice** —— 回显报价。
2. **commit** —— 一个 commit 交易哈希。（这是链上承诺；secret 在本地生成、保留在进程内，日志里被脱敏。）
3. **waitForCommitment 轮询** —— `commit not yet revealable; polling again in 10s (timeout in Ns)` 重复约 60 秒，直到揭示窗口打开。
4. **register** —— 注册交易哈希；约 400k gas。
5. **setProfileRecords** —— resolver multicall 交易（因为你传了 `--description`/`--url`）。
6. **setPrimaryName** —— 反向记录交易（因为你传了 `--reverse`）。

每个高风险链上动作（commit、register 都是 `requiresConfirmation`）都会提示你确认。只有在你信任输入、希望无人值守时，才加 `--auto-confirm`。

**如果超时**仍未等到揭示窗口（出块慢），直接重跑同一条命令——链上 commit 在 `maxCommitmentAge`（24 小时）内有效。（想干净重试就再跑一次 register，需要时它会重新 commit。）

---

## 5. 链上验证

```bash
op run --env-file=.env -- node bin/gns.mjs lookup myagentname.goat --json
op run --env-file=.env -- node bin/gns.mjs my-names YOUR_WALLET_ADDRESS --json
```

- `lookup` 应显示 `status: registered`、你的 owner 地址、到期时间（约 1 年后）、你的 description/url 记录，以及 `primaryName: true`。
- 在浏览器交叉核对 register 交易：
  `https://explorer.testnet3.goat.network/tx/<register-tx-hash>`。
- 名字可解析：`lookup` 返回 resolver 地址 + 记录。

---

## 6. 跨链 x402 变体（从非 GOAT 链付款）

如果你想从比如 Base testnet 的 USDC 付款，而不是 GOAT 侧的 tUSDC，用 x402 流程。这需要**两个**私钥（GOAT 用于 adaptor 签名，源链用于 ERC-20 转账）：

```bash
# 在 .env 里追加：
#   PAYMENT_CHAIN_PRIVATE_KEY=op://Private/Base agent testnet/private_key
#   PAYMENT_CHAIN_RPC_URL=https://sepolia.base.org   (或你的 Base testnet RPC)
#   PAYMENT_CHAIN_ID=84532

op run --env-file=.env -- node bin/gns.mjs x402-register myagentname.goat \
  --pay-chain 84532 --pay-token USDC --years 1
```

流程：在 GOAT 上 commit → `x402.createOrder` → 用 GOAT 绑定的 signer 对 calldata 签名 → `x402.submitSignature` → 切换到源链 signer → `x402.payOrder`（在付款链上做 ERC-20 转账）→ 轮询 `x402.getOrderStatus` 直到 `PAYMENT_CONFIRMED`。后端 adaptor 随后在 GOAT 上完成注册结算。

---

## 7. 礼品卡购买 E2E（生产 API，可从任意支持链付款）

```bash
# 浏览（不需要密钥）：
node bin/giftcard.mjs list-brands --country US --json
node bin/giftcard.mjs list-chains --json
node bin/giftcard.mjs get-brand <brand-id-from-list> --json

# 购买（需要在所选付款链上有 funded 钱包；鉴权自动完成）：
op run --env-file=.env -- node bin/giftcard.mjs buy \
  --brand <brand-id> --face-value 50 --pay-chain 8453 --pay-token USDC
```

流程：createOrder（adapter 通过 EIP-712 → Bearer 自动鉴权）→ payOrder（在 `--pay-chain` 上 ERC-20 转账）→ 轮询 getOrder 直到 `FULFILLED` → 打印卡码。加 `--reveal-secrets` 可明文打印卡码/PIN（只在交互式终端用——见 `docs/WALLET-SECURITY.md` 里关于 stdout 被采集的注意事项）。

---

## 8. 故障排查

| 现象 | 原因 / 解决 |
|------|-------------|
| `doctor` 的 API 检查失败 | RPC/API 被限流或宕机；重试，或在 `.env` 里设你自己的 RPC。 |
| `register` 反复提示 "commit not yet revealable" 然后超时 | 测试网出块慢；调高 `--wait-timeout 300` 重跑。 |
| `register` revert `nameNotAvailable` | 在你 `search` 和 `commit` 之间被别人抢注了。换个名字。 |
| `INVALID_INPUT: insufficient allowance` | 钱包还没给 controller 授权付款代币；流程在可用时走 permit——确认代币支持 EIP-2612，或预先 approve。 |
| x402 payOrder / giftcard buy 报 `chain_mismatch` | 你的 `PAYMENT_CHAIN_*` 钱包所在 chainId 与 `--pay-chain` 不一致。修正对应链的 RPC/key。 |
| `op run` 解析不了引用 | `op whoami` 确认已登录；检查 item/字段路径与 vault 完全一致。 |
| FULFILLED 后没显示卡码 | 重跑 `giftcard status <order-id> --reveal-secrets`。 |

---

## 9. 这套流程证明了什么

一次成功的运行，在真实测试网基础设施上跑通了：名称可用性 → 报价 → commit/reveal 时序 → 链上注册（ERC-721 mint）→ resolver 记录写入 → 反向记录（主名）；在 x402 路径下还包括完整的跨链结算。这就是完整的 GNS 业务流程。礼品卡运行则跑通了：目录 → EIP-712 鉴权 → 创建订单 → 链上稳定币付款 → 履约 → 发卡。
