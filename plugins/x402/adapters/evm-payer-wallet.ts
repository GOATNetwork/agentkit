import { Contract, type Signer } from 'ethers';
import type { CalldataSignRequest, PayerWalletAdapter, TransferTokenInput, TransferTokenResult } from './types';

const ERC20_ABI = ['function transfer(address to, uint256 value) returns (bool)'];

export class EvmPayerWalletAdapter implements PayerWalletAdapter {
  constructor(private readonly signer: Signer) {}

  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async signCalldataTypedData(request: CalldataSignRequest): Promise<string> {
    const signature = await this.signer.signTypedData(
      request.domain,
      request.types as any,
      request.message
    );
    return signature;
  }

  private raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw new Error('Operation aborted');
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
      }),
    ]);
  }

  async transferToken(input: TransferTokenInput, signal?: AbortSignal): Promise<TransferTokenResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const token = new Contract(input.tokenAddress, ERC20_ABI, this.signer);
    const tx = await this.raceSignal(token.transfer(input.to, BigInt(input.amount)), signal);
    const receipt = await this.raceSignal(tx.wait() as Promise<any>, signal);
    return { txHash: (receipt?.hash ?? tx.hash) as string };
  }
}
