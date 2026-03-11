import { Contract, type Provider } from 'ethers';
import type { BalanceQueryInput, BalanceQueryOutput, WalletReadAdapter } from './types';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export class EvmWalletReadAdapter implements WalletReadAdapter {
  constructor(private readonly provider: Provider) {}

  async getBalance(input: BalanceQueryInput): Promise<BalanceQueryOutput> {
    if (!input.tokenAddress) {
      const balance = await this.provider.getBalance(input.address);
      return { address: input.address, balance: balance.toString() };
    }

    const token = new Contract(input.tokenAddress, ERC20_ABI, this.provider);
    const balance = await token.balanceOf(input.address);
    return {
      address: input.address,
      tokenAddress: input.tokenAddress,
      balance: balance.toString(),
    };
  }
}
