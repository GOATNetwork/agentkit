export interface FaucetResult {
  success: boolean;
  txHash?: string;
  message?: string;
  raw?: unknown;
}

export interface FaucetAdapter {
  getChains(signal?: AbortSignal): Promise<unknown>;
  requestFunds(input: { chain: string; address: string; tokenAddress?: string }, signal?: AbortSignal): Promise<FaucetResult>;
}

export class NoopFaucetAdapter implements FaucetAdapter {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NoopFaucetAdapter must not be used in production. Provide a real FaucetAdapter implementation.');
    }
  }

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
