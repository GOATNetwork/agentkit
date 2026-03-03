export interface FaucetResult {
  success: boolean;
  txHash?: string;
  message?: string;
  raw?: unknown;
}

export interface FaucetAdapter {
  getChains(): Promise<unknown>;
  requestFunds(input: { chain: string; address: string; tokenAddress?: string }): Promise<FaucetResult>;
}

export class NoopFaucetAdapter implements FaucetAdapter {
  async getChains() {
    return { chains: ['goat-testnet'] };
  }

  async requestFunds(input: { chain: string; address: string; tokenAddress?: string }): Promise<FaucetResult> {
    return {
      success: true,
      txHash: `0xnoop_faucet_${Date.now()}`,
      message: `Noop faucet request for ${input.address} on ${input.chain}`,
    };
  }
}
