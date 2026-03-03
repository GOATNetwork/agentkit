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

  async transferToken(input: TransferTokenInput): Promise<TransferTokenResult> {
    const token = new Contract(input.tokenAddress, ERC20_ABI, this.signer);
    const tx = await token.transfer(input.to, BigInt(input.amount));
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash };
  }
}
