import { Contract, type Signer } from 'ethers';
import type { CalldataSignRequest, PayerWalletAdapter, TransferTokenInput, TransferTokenResult } from './types';

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

  private raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw new Error('Operation aborted');
    // `{ once: true }` only auto-removes after the listener fires. When
    // `promise` wins the race the listener stays attached until the signal
    // is aborted; a long-lived signal reused across many payer calls
    // would then trip Node's MaxListenersExceededWarning. Detach
    // explicitly on settle — same pattern as core/wallet/{evm,viem}-wallet-provider.ts.
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('Operation aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  async transferToken(input: TransferTokenInput, signal?: AbortSignal): Promise<TransferTokenResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const token = new Contract(input.tokenAddress, ERC20_ABI, this.signer);
    const tx = await this.raceSignal(token.transfer(input.to, BigInt(input.amount)), signal);
    const receipt = await this.raceSignal(tx.wait() as Promise<any>, signal);
    return { txHash: (receipt?.hash ?? tx.hash) as string };
  }
}
