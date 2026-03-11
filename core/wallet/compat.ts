import type { WalletProvider } from './wallet-provider';
import type { PayerWalletAdapter, CalldataSignRequest, TransferTokenInput, TransferTokenResult } from '../../plugins/x402/adapters/types';
import type { WalletReadAdapter, BalanceQueryInput, BalanceQueryOutput } from '../../plugins/wallet/adapters/types';

export class WalletProviderPayerAdapter implements PayerWalletAdapter {
  constructor(private readonly wallet: WalletProvider) {}

  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async signCalldataTypedData(request: CalldataSignRequest): Promise<string> {
    return this.wallet.signTypedData(request.domain, request.types, request.message);
  }

  async transferToken(input: TransferTokenInput, signal?: AbortSignal): Promise<TransferTokenResult> {
    const result = await this.wallet.transferErc20(input.tokenAddress, input.to, input.amount, { signal });
    return { txHash: result.txHash };
  }
}

export class WalletProviderReadAdapter implements WalletReadAdapter {
  constructor(private readonly wallet: WalletProvider) {}

  async getBalance(input: BalanceQueryInput): Promise<BalanceQueryOutput> {
    if (input.tokenAddress) {
      const balance = await this.wallet.getErc20Balance(input.tokenAddress, input.address);
      return { address: input.address, tokenAddress: input.tokenAddress, balance };
    }
    const balance = await this.wallet.getBalance(input.address);
    return { address: input.address, balance };
  }
}
