import { createHmac, randomUUID } from 'node:crypto';
import { goatNetworks } from './config';

export interface X402CreatePaymentParams {
  to: string;
  asset: string;
  amount: string;
  expiresAt?: number;
  idempotencyKey?: string;
  fromAddress?: string;
  callbackCalldata?: string;
}

export interface X402CreatePaymentResult {
  paymentId: string;
  status: 'created';
  raw?: unknown;
}

export interface X402OrderStatusResult {
  paymentId: string;
  status: 'created' | 'authorized' | 'settled' | 'failed' | 'expired';
  raw?: unknown;
}

export interface BitVM2BridgeParams {
  fromAddress: string;
  toAddress: string;
  amountSats: string;
}

type GoatNet = 'goat-mainnet' | 'goat-testnet';

const ORDER_STATUS_MAP: Record<string, X402OrderStatusResult['status']> = {
  CHECKOUT_VERIFIED: 'created',
  PAYMENT_CONFIRMED: 'authorized',
  INVOICED: 'settled',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'failed',
};

const DEFAULT_TIMEOUT_MS = 30_000;

export class GoatAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly network: GoatNet, options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private fetchWithTimeout(url: string, init: RequestInit = {}, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  private get rpcUrl(): string {
    return goatNetworks[this.network].rpcUrl;
  }

  private get x402BaseUrl(): string {
    return process.env.GOAT_X402_BASE_URL ?? 'https://api.goatx402.com';
  }

  private get x402ApiKey(): string | undefined {
    return process.env.GOAT_X402_API_KEY;
  }

  private get x402ApiSecret(): string | undefined {
    return process.env.GOAT_X402_API_SECRET;
  }

  private hasX402Credential(): boolean {
    return Boolean(this.x402ApiKey && this.x402ApiSecret);
  }

  private requireX402Credential(method: string): void {
    if (!this.hasX402Credential()) {
      throw new Error(
        `${method}: missing GOAT_X402_API_KEY / GOAT_X402_API_SECRET. ` +
        `Set these environment variables or provide credentials explicitly.`
      );
    }
  }

  async ping(signal?: AbortSignal): Promise<{ chainIdHex: string; rpcUrl: string }> {
    const resp = await this.fetchWithTimeout(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }, signal);

    const json = (await resp.json()) as { result?: string };
    if (!json.result) throw new Error('Failed to ping Goat RPC');

    return { chainIdHex: json.result, rpcUrl: this.rpcUrl };
  }

  private signX402Request(params: Record<string, unknown>) {
    if (!this.x402ApiKey || !this.x402ApiSecret) {
      throw new Error('Missing GOAT_X402_API_KEY / GOAT_X402_API_SECRET');
    }

    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v) !== '') normalized[k] = String(v);
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();

    normalized.api_key = this.x402ApiKey;
    normalized.timestamp = timestamp;
    normalized.nonce = nonce;

    const payload = Object.keys(normalized)
      .sort()
      .map((k) => `${k}=${normalized[k]}`)
      .join('&');

    const sign = createHmac('sha256', this.x402ApiSecret).update(payload).digest('hex');

    return {
      'X-API-Key': this.x402ApiKey,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Sign': sign,
    };
  }

  private async x402Request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const headers = this.signX402Request(body ?? {});

    const resp = await this.fetchWithTimeout(`${this.x402BaseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }, signal);

    const text = await resp.text();
    let data: unknown = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    // create order may return 402 with x402 payload (expected)
    if (!resp.ok && resp.status !== 402) {
      const msg = (data as any)?.error || (data as any)?.message || `x402 request failed: ${resp.status}`;
      throw new Error(msg);
    }

    return data as T;
  }

  async x402CreatePayment(params: X402CreatePaymentParams, signal?: AbortSignal): Promise<X402CreatePaymentResult> {
    this.requireX402Credential('x402CreatePayment');

    const chainId = goatNetworks[this.network].chainId;
    const body = {
      dapp_order_id: params.idempotencyKey ?? `dapp_${Date.now()}`,
      chain_id: chainId,
      token_symbol: params.asset,
      from_address: params.fromAddress ?? params.to,
      amount_wei: params.amount,
      callback_calldata: params.callbackCalldata,
    };

    const raw = await this.x402Request<any>('POST', '/api/v1/orders', body, signal);

    return {
      paymentId: raw?.order_id ?? `x402_${Date.now()}`,
      status: 'created',
      raw,
    };
  }

  async x402AuthorizePayment(
    paymentId: string,
    signature?: string,
    signal?: AbortSignal,
  ): Promise<{ paymentId: string; status: 'authorized' | 'failed'; raw?: unknown }> {
    this.requireX402Credential('x402AuthorizePayment');

    if (!signature) {
      return { paymentId, status: 'failed', raw: { message: 'missing signature for calldata-signature' } };
    }

    await this.x402Request('POST', `/api/v1/orders/${paymentId}/calldata-signature`, { signature }, signal);
    return { paymentId, status: 'authorized' };
  }

  async x402GetPaymentStatus(paymentId: string, signal?: AbortSignal): Promise<X402OrderStatusResult> {
    this.requireX402Credential('x402GetPaymentStatus');

    const raw = await this.x402Request<any>('GET', `/api/v1/orders/${paymentId}`, undefined, signal);
    const mapped = ORDER_STATUS_MAP[String(raw?.status)] ?? 'created';
    return {
      paymentId,
      status: mapped,
      raw,
    };
  }

  async bitvm2Deposit(params: BitVM2BridgeParams): Promise<{ bridgeRequestId: string; status: 'CREATED' }> {
    return { bridgeRequestId: `dep_${params.amountSats}_${Date.now()}`, status: 'CREATED' };
  }

  async bitvm2Withdraw(params: BitVM2BridgeParams): Promise<{ bridgeRequestId: string; status: 'CREATED' }> {
    return { bridgeRequestId: `wd_${params.amountSats}_${Date.now()}`, status: 'CREATED' };
  }

  async bitvm2GetStatus(bridgeRequestId: string): Promise<{ bridgeRequestId: string; status: 'CREATED' | 'PENDING_L1' | 'PROVING' | 'PROVED' | 'FINALIZING' | 'FINALIZED' | 'FAILED' }> {
    if (bridgeRequestId.startsWith('dep_')) {
      return { bridgeRequestId, status: 'PENDING_L1' };
    }
    if (bridgeRequestId.startsWith('wd_')) {
      return { bridgeRequestId, status: 'FINALIZING' };
    }
    return { bridgeRequestId, status: 'CREATED' };
  }
}
