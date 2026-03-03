import type { CalldataSignRequest, PayerWalletAdapter, TransferTokenInput, TransferTokenResult } from './types';

export class NoopPayerWalletAdapter implements PayerWalletAdapter {
  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async signCalldataTypedData(_request: CalldataSignRequest): Promise<string> {
    return '0xmock_signature';
  }

  async transferToken(_input: TransferTokenInput): Promise<TransferTokenResult> {
    return { txHash: `0xmocktx${Date.now().toString(16)}` };
  }
}
