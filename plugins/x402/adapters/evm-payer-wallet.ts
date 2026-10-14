import { Contract, type Signer } from 'ethers';
import type { CalldataSignRequest, PayerWalletAdapter, TransferTokenInput, TransferTokenResult } from './types';

import { broadcastTransaction, confirmEthersTransaction } from '../../../core/wallet/broadcast-transaction';
import { throwIfAborted } from '../../../core/runtime/abort';
import type { WalletCallOptions } from '../../../core/wallet/wallet-provider';

const ERC20_ABI = ['function transfer(address to, uint256 value) returns (bool)'];

export class EvmPayerWalletAdapter implements PayerWalletAdapter {
  constructor(private readonly signer: Signer) {}

  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async getChainId(): Promise<number> {
    const provider = this.signer.provider;
    if (!provider) {
      throw new Error('EvmPayerWalletAdapter signer has no provider; cannot determine chainId');
    }
    const net = await provider.getNetwork();
    return Number(net.chainId);
  }

  /**
   * Address of the signer that will broadcast `transferToken`. Distinct
   * from any adjacent `WalletProvider.getAddress()` if the action wires
   * the wallet and payer to different signers. Cross-chain x402 actions
   * use this for the 3-way payer-binding check (Issue #3 R4 Codex P5).
   */
  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  async signCalldataTypedData(request: CalldataSignRequest): Promise<string> {
    const signature = await this.signer.signTypedData(request.domain, request.types as any, request.message);
    return signature;
  }

  async transferToken(
    input: TransferTokenInput,
    signal?: AbortSignal,
    options?: WalletCallOptions,
  ): Promise<TransferTokenResult> {
    signal ??= options?.signal;
    throwIfAborted(signal);
    const token = new Contract(input.tokenAddress, ERC20_ABI, this.signer);
    const request = await token.transfer.populateTransaction(input.to, BigInt(input.amount));
    const tx = await broadcastTransaction(this.signer, request, signal, options?.onSignedTransaction);
    const receipt = await confirmEthersTransaction(tx, { ...options, signal });
    return { txHash: (receipt?.hash ?? tx.hash) as string };
  }
}
