import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type {
  CreateX402OrderInput,
  GnsApiAdapter,
  MyNamesResponse,
  NameDetailsResponse,
  QuoteInput,
  RegistrationQuoteResponse,
  SearchResponse,
  X402MerchantConfigResponse,
  X402OrderResponse,
  X402OrderStatusResponse,
  X402SubmitSignatureResponse,
} from './types';

const DEFAULT_BASE_URLS = {
  'goat-mainnet': 'https://gns-api.goat.network/api',
  'goat-testnet': 'https://gns-api.testnet3.goat.network/api',
} as const;

export type GnsNetworkKey = keyof typeof DEFAULT_BASE_URLS;

export interface HttpGnsApiAdapterOptions {
  /** Override the default per-network base URL. */
  baseUrl?: string;
  /** Network selector when `baseUrl` is not supplied. Default: 'goat-testnet'. */
  network?: GnsNetworkKey;
  /** Extra request headers (e.g. API key). */
  headers?: Record<string, string>;
  /** HTTP request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function parseBodySafe(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function extractMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
  }
  return fallback;
}

function assertOk(resp: Response, data: unknown, fallbackMessage: string): void {
  if (!resp.ok) {
    throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, extractMessage(data, fallbackMessage), {
      status: resp.status,
      body: data,
    });
  }
}

/**
 * Concrete `GnsApiAdapter` backed by `fetch` against the production gns-api
 * (https://gns-api.goat.network/api for mainnet,
 * https://gns-api.testnet3.goat.network/api for testnet3).
 *
 * Mirrors `plugins/x402/adapters/http-merchant-gateway.ts` for consistency:
 *   - Non-2xx responses throw `AgentkitRuntimeError(ADAPTER_REQUEST_FAILED, ...)`
 *     so the runtime classifies them as non-retryable adapter failures.
 *   - External `AbortSignal`s are merged with a per-request timeout via
 *     `AbortSignal.any` so callers can cancel mid-flight.
 */
export class HttpGnsApiAdapter implements GnsApiAdapter {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: HttpGnsApiAdapterOptions = {}) {
    const network = options.network ?? 'goat-testnet';
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[network];
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  private async getJson<T>(path: string, signal: AbortSignal | undefined, fallback: string): Promise<T> {
    const resp = await this.fetchWithTimeout(joinUrl(this.baseUrl, path), { headers: { ...this.headers } }, signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, fallback);
    return data as T;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    fallback: string,
  ): Promise<T> {
    const resp = await this.fetchWithTimeout(
      joinUrl(this.baseUrl, path),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
      },
      signal,
    );
    const data = await parseBodySafe(resp);
    assertOk(resp, data, fallback);
    return data as T;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
    return this.getJson<SearchResponse>(`/names/search?q=${encodeURIComponent(query)}`, signal, 'gns search failed');
  }

  async details(name: string, signal?: AbortSignal): Promise<NameDetailsResponse> {
    return this.getJson<NameDetailsResponse>(
      `/names/details?name=${encodeURIComponent(name)}`,
      signal,
      'gns details failed',
    );
  }

  async quote(input: QuoteInput, signal?: AbortSignal): Promise<RegistrationQuoteResponse> {
    const params = new URLSearchParams({ name: input.name, years: String(input.years) });
    if (input.tokenContract) params.set('tokenContract', input.tokenContract);
    return this.getJson<RegistrationQuoteResponse>(`/names/quote?${params.toString()}`, signal, 'gns quote failed');
  }

  async myNames(address: string, signal?: AbortSignal): Promise<MyNamesResponse> {
    return this.getJson<MyNamesResponse>(
      `/names/my-names?address=${encodeURIComponent(address)}`,
      signal,
      'gns my-names failed',
    );
  }

  async x402Config(signal?: AbortSignal): Promise<X402MerchantConfigResponse> {
    return this.getJson<X402MerchantConfigResponse>('/payments/x402/config', signal, 'gns x402 config failed');
  }

  async createX402Order(input: CreateX402OrderInput, signal?: AbortSignal): Promise<X402OrderResponse> {
    const data = await this.postJson<Record<string, unknown>>(
      '/payments/x402/register-order',
      input,
      signal,
      'gns x402 createOrder failed',
    );
    // Backend may return `chainId` (settlement chain) without a parallel
    // `payChainId`; surface it under both keys for callers that prefer the
    // more explicit name without breaking the existing shape.
    const chainId = Number(data.chainId ?? 0);
    return {
      orderId: String(data.orderId ?? ''),
      flow: String(data.flow ?? 'ERC20_3009'),
      payToAddress: data.payToAddress as `0x${string}`,
      expiresAt: Number(data.expiresAt ?? 0),
      chainId,
      payChainId: chainId,
      tokenSymbol: String(data.tokenSymbol ?? ''),
      tokenContract: data.tokenContract as `0x${string}`,
      fromAddress: data.fromAddress as `0x${string}`,
      amountWei: String(data.amountWei ?? '0'),
      callbackCalldata: String(data.callbackCalldata ?? '0x'),
      calldataSignRequest: data.calldataSignRequest as X402OrderResponse['calldataSignRequest'],
    };
  }

  async getX402Order(orderId: string, signal?: AbortSignal): Promise<X402OrderStatusResponse> {
    const data = await this.getJson<Record<string, unknown>>(
      `/payments/x402/orders/${encodeURIComponent(orderId)}`,
      signal,
      'gns x402 getOrder failed',
    );
    // FAIL CLOSED on missing status. Previously this defaulted to
    // 'CHECKOUT_VERIFIED' which, after the Issue #3 gate flip in
    // x402-pay-order.ts (now `status === 'CHECKOUT_VERIFIED'`), would
    // silently let a malformed / status-less response pass the gate and
    // re-broadcast the source-chain transfer. Surface as ADAPTER_REQUEST_FAILED
    // so the caller sees an explicit upstream error instead of a phantom
    // payable order.
    if (typeof data.status !== 'string' || data.status.length === 0) {
      // Issue #3 Round 1 (Claude): throw a typed runtime error so the
      // runtime's normalizeError keeps the ADAPTER_REQUEST_FAILED code.
      // A plain Error would map to INTERNAL_ERROR — caller branches on the
      // wrong code, and the retry policy reads this as a transient SDK
      // glitch when it's actually a malformed upstream response.
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        `gns x402 getOrder returned no status field (orderId=${orderId}); refusing to default — upstream response is malformed`,
        { orderId, raw: data },
      );
    }
    return {
      orderId,
      status: data.status,
      txHash: typeof data.txHash === 'string' ? data.txHash : undefined,
      confirmedAt: typeof data.confirmedAt === 'number' ? data.confirmedAt : undefined,
      raw: data,
    };
  }

  async submitX402Signature(
    orderId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<X402SubmitSignatureResponse> {
    const data = await this.postJson<Record<string, unknown>>(
      `/payments/x402/orders/${encodeURIComponent(orderId)}/calldata-signature`,
      { signature },
      signal,
      'gns x402 submitSignature failed',
    );
    const status = data.status === 'failed' ? 'failed' : 'authorized';
    return { status, raw: data };
  }
}
