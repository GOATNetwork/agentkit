import type { WalletProvider, WalletCallOptions } from './wallet-provider';
import type {
  PayerWalletAdapter,
  CalldataSignRequest,
  TransferTokenInput,
  TransferTokenResult,
} from '../../plugins/x402/adapters/types';
import type { WalletReadAdapter, BalanceQueryInput, BalanceQueryOutput } from '../../plugins/wallet/adapters/types';
import { AgentkitRuntimeError } from '../errors/error';
import { ErrorCodes } from '../errors/error-codes';

export class WalletProviderPayerAdapter implements PayerWalletAdapter {
  constructor(private readonly wallet: WalletProvider) {}

  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async signCalldataTypedData(request: CalldataSignRequest): Promise<string> {
    return this.wallet.signTypedData(request.domain, request.types, request.message);
  }

  async transferToken(
    input: TransferTokenInput,
    signal?: AbortSignal,
    options?: WalletCallOptions,
  ): Promise<TransferTokenResult> {
    const result = await this.wallet.transferErc20(input.tokenAddress, input.to, input.amount, {
      ...options,
      signal: signal ?? options?.signal,
    });
    return { txHash: result.txHash };
  }

  /**
   * Delegate to the wrapped `WalletProvider.getAddress()` so the
   * x402 3-way payer binding check (Issue #3 R4 Codex P5 / R5 follow-up)
   * fires for this adapter too. Without this delegation, callers using
   * `WalletProviderPayerAdapter` as the `payer` argument silently bypass
   * the payer-side binding when `wallet ≠ payer` wrap different keys.
   */
  async getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  /**
   * Delegate `getChainId` for the same reason — the cross-chain x402
   * payOrder check requires `payer.getChainId()` to match the order's
   * source chain when implemented, and skipping it here was the same
   * class of bypass we close for `getAddress`.
   */
  async getChainId(): Promise<number> {
    if (typeof this.wallet.getChainId !== 'function') {
      throw new AgentkitRuntimeError(
        ErrorCodes.INVALID_INPUT,
        'WalletProviderPayerAdapter: wrapped WalletProvider does not implement getChainId(); cannot satisfy the cross-chain x402 payer chain-binding check',
      );
    }
    return this.wallet.getChainId();
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
