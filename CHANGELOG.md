# @goatnetwork/agentkit

## 0.2.3

### Patch Changes

- 126ea25: fix: point GoatAdapter x402 payment endpoints at the GOAT Flow API domains

  The GoatX402 API was renamed to GOAT Flow and moved domains. `GoatAdapter` now
  selects its base URL per network — `https://flow-api.goat.network` for
  goat-mainnet and `https://flow-api.testnet3.goat.network` for goat-testnet —
  instead of the retired `https://api.goatx402.com`. The `GOAT_X402_BASE_URL`
  override still takes precedence and now has trailing slashes normalized so
  `${base}/api/v1/...` never produces a double slash. Env var names, request
  paths, and the HMAC signing contract are unchanged.
