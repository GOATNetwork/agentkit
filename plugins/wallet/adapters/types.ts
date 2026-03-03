export interface BalanceQueryInput {
  address: string;
  tokenAddress?: string;
}

export interface BalanceQueryOutput {
  address: string;
  tokenAddress?: string;
  balance: string;
}

export interface WalletReadAdapter {
  getBalance(input: BalanceQueryInput): Promise<BalanceQueryOutput>;
}

export class NoopWalletReadAdapter implements WalletReadAdapter {
  async getBalance(input: BalanceQueryInput): Promise<BalanceQueryOutput> {
    return {
      address: input.address,
      tokenAddress: input.tokenAddress,
      balance: '0',
    };
  }
}
