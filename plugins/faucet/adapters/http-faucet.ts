import { ErrorCodes } from '../../../core/errors/error-codes';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import type { FaucetAdapter, FaucetResult } from './types';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function parseBodySafe(resp: Response): Promise<any> {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

export class HttpFaucetAdapter implements FaucetAdapter {
  constructor(private readonly baseUrl: string) {}

  async getChains(): Promise<unknown> {
    const resp = await fetch(joinUrl(this.baseUrl, 'faucet/chains'));
    const data = await parseBodySafe(resp);
    if (!resp.ok) {
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        data?.message || 'faucet get-chains failed',
        { status: resp.status, body: data },
      );
    }
    return data;
  }

  async requestFunds(input: { chain: string; address: string; tokenAddress?: string }): Promise<FaucetResult> {
    const body: Record<string, string> = { chain: input.chain, address: input.address };
    if (input.tokenAddress) body.token_address = input.tokenAddress;

    const resp = await fetch(joinUrl(this.baseUrl, 'faucet'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseBodySafe(resp);
    if (!resp.ok) {
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        data?.message || 'faucet request-funds failed',
        { status: resp.status, body: data },
      );
    }
    return {
      success: true,
      txHash: data.txHash ?? data.tx_hash,
      message: data.message,
      raw: data,
    };
  }
}
