import type { CalldataSignRequest, PayerWalletAdapter, TransferTokenInput, TransferTokenResult } from './types';

export class NoopPayerWalletAdapter implements PayerWalletAdapter {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NoopPayerWalletAdapter must not be used in production. Provide a real PayerWalletAdapter implementation.');
    }
  }

  async normalizeAuthorization(input: string): Promise<string> {
    return input.startsWith('sig:') ? input.slice(4) : input;
  }

  async signCalldataTypedData(_request: CalldataSignRequest): Promise<string> {
    return '0xmock_signature';
  }

  async transferToken(_input: TransferTokenInput, _signal?: AbortSignal): Promise<TransferTokenResult> {
    return { txHash: `0xmocktx${Date.now().toString(16)}` };
  }
}
