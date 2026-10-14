import { createHmac } from 'node:crypto';
import { GoatFlowGatewayAdapter } from '../../plugins/x402/adapters/goat-flow-gateway';
import { InMemoryPaymentRecoveryStore, type PaymentRecoveryStore } from '../../plugins/paykit/recovery';
import { goatNetworks } from './config';

export interface X402CreatePaymentParams {
  /** @deprecated Ignored by native Flow; the merchant determines the recipient. Set fromAddress for the payer. */
  to?: string;
  asset: string;
  amount: string;
  expiresAt?: number;
  idempotencyKey: string;
  fromAddress: string;
  callbackCalldata?: string;
  chainId?: number;
  tokenContract?: string;
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

const DEFAULT_TIMEOUT_MS = 30_000;

export class GoatAdapter {
  private readonly timeoutMs: number;
  private readonly recoveryStore: PaymentRecoveryStore;
  private readonly recoveryNamespace: string;

  constructor(
    private readonly network: GoatNet,
    options?: { timeoutMs?: number; recoveryStore?: PaymentRecoveryStore; recoveryNamespace?: string },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.recoveryStore = options?.recoveryStore ?? new InMemoryPaymentRecoveryStore();
    this.recoveryNamespace = options?.recoveryNamespace ?? `goat-adapter:${network}`;
  }

  private fetchWithTimeout(url: string, init: RequestInit = {}, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  private get rpcUrl(): string {
    return goatNetworks[this.network].rpcUrl;
  }

  private get x402BaseUrl(): string {
    // GOAT Flow API (formerly GoatX402). Base URL only — callers append the
    // `/api/v1/...` path. Env override applies to both networks; otherwise
    // default per network: mainnet vs testnet3. Trailing slash(es) are
    // stripped from the override so `${base}${path}` never yields `//api/v1`.
    if (process.env.GOAT_X402_BASE_URL) return process.env.GOAT_X402_BASE_URL.replace(/\/+$/, '');
    return this.network === 'goat-mainnet' ? 'https://flow-api.goat.network' : 'https://flow-api.testnet3.goat.network';
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
          `Set these environment variables or provide credentials explicitly.`,
      );
    }
  }

  async ping(signal?: AbortSignal): Promise<{ chainIdHex: string; rpcUrl: string }> {
    const resp = await this.fetchWithTimeout(
      this.rpcUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      },
      signal,
    );

    const json = (await resp.json()) as { result?: string };
    if (!json.result) throw new Error('Failed to ping Goat RPC');

    return { chainIdHex: json.result, rpcUrl: this.rpcUrl };
  }

  private flowAdapter?: GoatFlowGatewayAdapter;
  private flowConfigDigest?: string;

  private getFlowAdapter(): GoatFlowGatewayAdapter {
    this.requireX402Credential('GOAT Flow');
    const configDigest = createHmac('sha256', this.x402ApiSecret!)
      .update(JSON.stringify([this.x402BaseUrl, this.x402ApiKey]))
      .digest('hex');
    if (!this.flowAdapter || this.flowConfigDigest !== configDigest) {
      this.flowAdapter = new GoatFlowGatewayAdapter(this.x402BaseUrl, {
        apiKey: this.x402ApiKey!,
        apiSecret: this.x402ApiSecret!,
        defaultChainId: goatNetworks[this.network].chainId,
        timeoutMs: this.timeoutMs,
        recoveryStore: this.recoveryStore,
        recoveryNamespace: this.recoveryNamespace,
      });
      this.flowConfigDigest = configDigest;
    }
    return this.flowAdapter;
  }

  async x402CreatePayment(params: X402CreatePaymentParams, signal?: AbortSignal): Promise<X402CreatePaymentResult> {
    return this.getFlowAdapter().createPaymentIntent(params, signal);
  }

  async x402AuthorizePayment(paymentId: string, signature?: string, signal?: AbortSignal) {
    const adapter = this.getFlowAdapter();
    if (!signature) return { paymentId, status: 'failed' as const };
    return adapter.submitPaymentAuthorization(paymentId, signature, signal);
  }

  async x402GetPaymentStatus(paymentId: string, signal?: AbortSignal): Promise<X402OrderStatusResult> {
    return this.getFlowAdapter().getPaymentStatus(paymentId, signal);
  }

  async bitvm2Deposit(params: BitVM2BridgeParams): Promise<{ bridgeRequestId: string; status: 'CREATED' }> {
    return { bridgeRequestId: `dep_${params.amountSats}_${Date.now()}`, status: 'CREATED' };
  }

  async bitvm2Withdraw(params: BitVM2BridgeParams): Promise<{ bridgeRequestId: string; status: 'CREATED' }> {
    return { bridgeRequestId: `wd_${params.amountSats}_${Date.now()}`, status: 'CREATED' };
  }

  async bitvm2GetStatus(bridgeRequestId: string): Promise<{
    bridgeRequestId: string;
    status: 'CREATED' | 'PENDING_L1' | 'PROVING' | 'PROVED' | 'FINALIZING' | 'FINALIZED' | 'FAILED';
  }> {
    if (bridgeRequestId.startsWith('dep_')) {
      return { bridgeRequestId, status: 'PENDING_L1' };
    }
    if (bridgeRequestId.startsWith('wd_')) {
      return { bridgeRequestId, status: 'FINALIZING' };
    }
    return { bridgeRequestId, status: 'CREATED' };
  }
}
