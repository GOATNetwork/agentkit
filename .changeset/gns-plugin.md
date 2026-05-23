---
'@goatnetwork/agentkit': minor
---

Add `gns` plugin: 15 actions for GOAT Name Service (.goat name registration, renewal, profile records, primary name, and cross-chain x402 payment) plus typed `HttpGnsApiAdapter` and vendored contract registry. Adds `EvmWalletProvider.getLatestBlockTimestamp()` for on-chain readiness checks.

**Wallet interface additions (backwards-compatible).**

- `WalletProvider.getChainId()` is added as an OPTIONAL method on the
  base interface. Built-in providers (`EvmWalletProvider`,
  `ViemWalletProvider`, `NoopWalletProvider`) implement it. Third-party
  `WalletProvider` implementations are NOT required to add it — actions
  that need it (e.g. cross-chain x402 payOrder, giftcard payOrder)
  narrow-cast or runtime-check and throw `INVALID_INPUT` if the
  capability is missing. If you keep a custom provider, no code change
  is required to consume this version; if you call the new chain-bind
  actions you'll need to implement `getChainId()`.

- `NoopWalletProvider` constructor gained an optional second argument
  `{ networkName?, chainId? }`. Default `chainId` is `48816`
  (GOAT Testnet3); default `networkName` is `'goat-testnet'`. Existing
  `new NoopWalletProvider()` calls now report chainId 48816 via the
  new `getChainId()`. Test pinning this default lives in
  `tests/unit/wallet-chain-id.test.ts`.
