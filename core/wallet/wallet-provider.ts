export interface WalletCallOptions {
  signal?: AbortSignal;
}

export interface WalletProvider {
  getAddress(): Promise<string>;
  getNetwork(): Promise<string>;
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
