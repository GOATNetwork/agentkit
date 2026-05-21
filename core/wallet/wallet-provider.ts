export interface WalletCallOptions {
  signal?: AbortSignal;
}

export interface WalletProvider {
  getAddress(): Promise<string>;
  getNetwork(): Promise<string>;
  /**
   * Returns the numeric chainId of the chain the wallet is currently
   * connected to.
   *
   * Examples:
   *   - `2345`  for GOAT Mainnet
   *   - `48816` for GOAT Testnet3
   *   - `8453`  for Base
   *
   * Cross-chain actions (e.g. x402 source-chain payment) compare this
   * against the authoritative chainId from the API order. The string
   * returned by `getNetwork()` is a logical network *key* (used by
   * policy allowlists) and is NOT a substitute for the numeric chainId.
   *
   * **Optional on the interface, required in practice.** Marked
   * optional so adding the method in 0.x does not force third-party
   * `WalletProvider` implementations to update. All built-in providers
   * (`EvmWalletProvider`, `ViemWalletProvider`, `NoopWalletProvider`)
   * implement it. Actions that need chain binding should narrow-cast
   * to a concrete provider, or check `typeof wallet.getChainId ===
   * 'function'` and throw `INVALID_INPUT` with a clear message
   * otherwise.
   */
  getChainId?(): Promise<number>;
  getBalance(address?: string): Promise<string>;
  getErc20Balance(tokenAddress: string, owner?: string): Promise<string>;
  transferNative(to: string, amountWei: string, options?: WalletCallOptions): Promise<{ txHash: string }>;
  transferErc20(tokenAddress: string, to: string, amount: string, options?: WalletCallOptions): Promise<{ txHash: string }>;
  approveErc20(tokenAddress: string, spender: string, amount: string, options?: WalletCallOptions): Promise<{ txHash: string }>;
  signTypedData(domain: Record<string, unknown>, types: Record<string, unknown[]>, value: Record<string, unknown>): Promise<string>;
  callContract(contractAddress: string, abi: string[], functionName: string, args: unknown[]): Promise<unknown>;
  writeContract(contractAddress: string, abi: string[], functionName: string, args: unknown[], value?: string, options?: WalletCallOptions): Promise<{ txHash: string }>;
  deployContract(abi: string[], bytecode: string, args?: unknown[], value?: string, options?: WalletCallOptions): Promise<{ txHash: string; contractAddress: string }>;
}
