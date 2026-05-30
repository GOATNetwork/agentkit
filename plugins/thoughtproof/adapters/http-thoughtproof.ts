import type {
  ThoughtProofAdapter,
  ThoughtProofConfig,
  SentinelVerifyInput,
  SentinelVerifyOutput,
  RVVerifyInput,
  RVVerifyOutput,
  AttestInput,
  AttestOutput,
  StatusOutput,
  X402Signer,
} from './types';

const DEFAULT_SENTINEL_URL = 'https://sentinel.thoughtproof.ai';
const DEFAULT_RV_URL = 'https://api.thoughtproof.ai';
const DEFAULT_SENTINEL_TIMEOUT = 30_000;
const DEFAULT_RV_TIMEOUT = 120_000;

/**
 * Parse the base64-encoded PAYMENT-REQUIRED header from a 402 response.
 * Returns the decoded payment requirements object.
 */
function parsePaymentRequired(headerValue: string): Record<string, unknown> {
  // Use Buffer for Node compatibility (atob is Browser + Node 16+ only)
  const json = typeof Buffer !== 'undefined'
    ? Buffer.from(headerValue, 'base64').toString('utf-8')
    : atob(headerValue);
  return JSON.parse(json);
}

/**
 * Build a PAYMENT-SIGNATURE header value from a signed payment payload.
 */
function encodePaymentSignature(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return typeof Buffer !== 'undefined'
    ? Buffer.from(json, 'utf-8').toString('base64')
    : btoa(json);
}

/**
 * HTTP adapter for ThoughtProof Sentinel + RV APIs.
 *
 * Supports two auth modes:
 * 1. **API Key** (default): Bearer token auth. Simple, no wallet needed.
 * 2. **x402 Pay-per-call**: Agent wallet pays per verification via HTTP 402.
 *    Server dictates price. No API key needed. Zero subscription.
 *
 * Priority: x402Fetch > x402Signer > apiKey
 */
export class HttpThoughtProofAdapter implements ThoughtProofAdapter {
  private readonly sentinelBase: string;
  private readonly rvBase: string;
  private readonly apiKey?: string;
  private readonly x402Signer?: X402Signer;
  private readonly maxPaymentAmount?: bigint;
  private readonly fetchFn: typeof fetch;
  private readonly sentinelTimeout: number;
  private readonly rvTimeout: number;

  constructor(config: ThoughtProofConfig = {}) {
    this.sentinelBase = (config.sentinelBaseUrl ?? DEFAULT_SENTINEL_URL).replace(/\/$/, '');
    this.rvBase = (config.rvBaseUrl ?? DEFAULT_RV_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.x402Signer = config.x402Signer;
    this.maxPaymentAmount = config.maxPaymentAmount ? BigInt(config.maxPaymentAmount) : undefined;
    this.sentinelTimeout = config.sentinelTimeoutMs ?? DEFAULT_SENTINEL_TIMEOUT;
    this.rvTimeout = config.rvTimeoutMs ?? DEFAULT_RV_TIMEOUT;

    // Priority: x402Fetch (user-managed) > native fetch (we handle 402 ourselves)
    this.fetchFn = config.x402Fetch ?? fetch;
  }

  /** Whether this adapter uses x402 pay-per-call */
  get isX402Enabled(): boolean {
    return !!this.x402Signer || this.fetchFn !== fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // API key auth only when NOT using x402
    if (this.apiKey && !this.x402Signer) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * Handle x402 payment flow:
   * 1. Server responds 402 + PAYMENT-REQUIRED header
   * 2. Parse payment requirements (amount, asset, network, scheme)
   * 3. Sign payment authorization with wallet
   * 4. Retry original request with PAYMENT-SIGNATURE header
   */
  private async handleX402(
    res: Response,
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!this.x402Signer?.signTypedData) {
      throw new Error(
        'ThoughtProof API requires payment (HTTP 402) but no x402Signer is configured. ' +
        'Provide an x402Signer in ThoughtProofConfig or use an apiKey instead.'
      );
    }

    const paymentRequiredHeader = res.headers.get('payment-required');
    if (!paymentRequiredHeader) {
      throw new Error(
        'ThoughtProof API returned 402 but no PAYMENT-REQUIRED header. ' +
        'The server may not support x402 yet.'
      );
    }

    const requirements = parsePaymentRequired(paymentRequiredHeader);

    // Safety cap: reject if server requests more than configured max
    if (this.maxPaymentAmount) {
      const requestedAmount = requirements.amount ?? requirements.maxAmountRequired;
      if (requestedAmount && BigInt(String(requestedAmount)) > this.maxPaymentAmount) {
        throw new Error(
          `ThoughtProof x402 payment amount ${requestedAmount} exceeds configured maxPaymentAmount ${this.maxPaymentAmount}. ` +
          'Refusing to sign. Increase maxPaymentAmount in config if this is expected.'
        );
      }
    }

    // Extract typed data for signing from the payment requirements.
    // x402 v2 embeds the EIP-712 signing payload in the requirements.
    const typedData = requirements.typedData as {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    } | undefined;

    if (!typedData) {
      // Fallback: construct minimal payment authorization
      // This handles servers that use a simpler payment-required format
      const signature = await this.x402Signer.signTypedData({
        domain: (requirements.domain as Record<string, unknown>) ?? {},
        types: (requirements.types as Record<string, Array<{ name: string; type: string }>>) ?? {},
        primaryType: (requirements.primaryType as string) ?? 'Payment',
        message: (requirements.message as Record<string, unknown>) ?? requirements,
      });

      const paymentPayload = {
        signature,
        signer: this.x402Signer.address,
        scheme: requirements.scheme ?? 'exact',
      };

      return this.fetchFn(url, {
        ...init,
        headers: {
          ...init.headers as Record<string, string>,
          'payment-signature': encodePaymentSignature(paymentPayload),
        },
        signal,
      });
    }

    // Standard x402 v2 path: sign the embedded typed data
    const signature = await this.x402Signer.signTypedData(typedData);

    const paymentPayload = {
      signature,
      signer: this.x402Signer.address,
      scheme: requirements.scheme ?? 'exact',
    };

    return this.fetchFn(url, {
      ...init,
      headers: {
        ...init.headers as Record<string, string>,
        'payment-signature': encodePaymentSignature(paymentPayload),
      },
      signal,
    });
  }

  private async fetchWithTimeout(
    url: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const start = Date.now();

    const makeSignal = (): AbortSignal => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(timeoutMs - elapsed, 1_000);
      const timeoutSignal = AbortSignal.timeout(remaining);
      return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    };

    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: makeSignal(),
    };

    let res = await this.fetchFn(url, init);

    // x402: server requires payment — retry with fresh timeout
    if (res.status === 402 && this.x402Signer) {
      const retryInit: RequestInit = {
        ...init,
        signal: makeSignal(), // fresh timeout for the payment retry
      };
      res = await this.handleX402(res, url, retryInit, makeSignal());
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ThoughtProof API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return { ...data, _latencyMs: Date.now() - start };
  }

  async sentinelVerify(input: SentinelVerifyInput, signal?: AbortSignal): Promise<SentinelVerifyOutput> {
    const body = {
      claim: input.claim,
      ...(input.context && { context: input.context }),
      ...(input.task && { task: input.task }),
    };

    const raw = await this.fetchWithTimeout(
      `${this.sentinelBase}/sentinel/verify`,
      body,
      this.sentinelTimeout,
      signal,
    ) as Record<string, unknown>;

    return {
      verdict: raw.verdict as SentinelVerifyOutput['verdict'],
      confidence: (raw.confidence as number) ?? 0,
      reasons: (raw.reasons as string[]) ?? [],
      requestId: (raw.request_id as string) ?? (raw.requestId as string) ?? '',
      latencyMs: raw._latencyMs as number,
    };
  }

  async rvVerify(input: RVVerifyInput, signal?: AbortSignal): Promise<RVVerifyOutput> {
    const body = {
      claim: input.claim,
      ...(input.context && { context: input.context }),
      tier: input.tier,
      ...(input.domain && { domain: input.domain }),
    };

    const raw = await this.fetchWithTimeout(
      `${this.rvBase}/v1/verify`,
      body,
      this.rvTimeout,
      signal,
    ) as Record<string, unknown>;

    return {
      verdict: raw.verdict as RVVerifyOutput['verdict'],
      confidence: (raw.confidence as number) ?? 0,
      evaluation: (raw.evaluation as string) ?? '',
      critique: (raw.critique as string) ?? '',
      synthesis: (raw.synthesis as string) ?? '',
      requestId: (raw.request_id as string) ?? (raw.requestId as string) ?? '',
      latencyMs: raw._latencyMs as number,
    };
  }

  async attest(input: AttestInput, signal?: AbortSignal): Promise<AttestOutput> {
    const baseUrl = input.source === 'sentinel' ? this.sentinelBase : this.rvBase;
    const path = input.source === 'sentinel'
      ? '/sentinel/attest'
      : '/v1/attest';
    const timeout = input.source === 'sentinel' ? this.sentinelTimeout : this.rvTimeout;

    const body = {
      request_id: input.requestId,
      recipient: input.recipient,
    };

    const raw = await this.fetchWithTimeout(
      `${baseUrl}${path}`,
      body,
      timeout,
      signal,
    ) as Record<string, unknown>;

    return {
      attestationId: (raw.attestation_id as string) ?? (raw.attestationId as string) ?? '',
      txHash: (raw.tx_hash as string) ?? (raw.txHash as string),
    };
  }

  async status(signal?: AbortSignal): Promise<StatusOutput> {
    const check = async (url: string, timeout: number): Promise<{ healthy: boolean; latencyMs: number }> => {
      const start = Date.now();
      try {
        const res = await this.fetchFn(url, {
          method: 'GET',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        });
        return { healthy: res.ok, latencyMs: Date.now() - start };
      } catch {
        return { healthy: false, latencyMs: Date.now() - start };
      }
    };

    const [sentinel, rv] = await Promise.all([
      check(`${this.sentinelBase}/sentinel/health`, 10_000),
      check(`${this.rvBase}/v1/health`, 10_000),
    ]);

    return { sentinel, rv };
  }
}
