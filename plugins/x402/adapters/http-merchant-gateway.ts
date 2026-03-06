import { ErrorCodes } from '../../../core/errors/error-codes';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import type { CreatePaymentIntentInput, CreatePaymentIntentResult, MerchantGatewayAdapter, PaymentStatus } from './types';

const ORDER_STATUS_MAP: Record<string, PaymentStatus> = {
  CHECKOUT_VERIFIED: 'created',
  PAYMENT_CONFIRMED: 'authorized',
  INVOICED: 'settled',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'failed',
};

export interface MerchantGatewayRoutes {
  createOrderPath: string;
  orderStatusPath: string; // use :paymentId placeholder
  submitSignaturePath: string;
  cancelOrderPath: string;
}

export interface HttpMerchantGatewayAdapterOptions {
  headers?: Record<string, string>;
  routes?: Partial<MerchantGatewayRoutes>;
  /** HTTP request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
}

const DEFAULT_ROUTES: MerchantGatewayRoutes = {
  createOrderPath: '/x402/create-order',
  orderStatusPath: '/x402/order-status/:paymentId',
  submitSignaturePath: '/x402/submit-signature',
  cancelOrderPath: '/x402/cancel-order',
};

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

function assertOk(resp: Response, data: any, message: string): void {
  if (!resp.ok) {
    throw new AgentkitRuntimeError(
      ErrorCodes.ADAPTER_REQUEST_FAILED,
      data?.message || data?.error || message,
      { status: resp.status, body: data }
    );
  }
}

export class HttpMerchantGatewayAdapter implements MerchantGatewayAdapter {
  private readonly headers: Record<string, string>;
  private readonly routes: MerchantGatewayRoutes;
  private readonly timeoutMs: number;

  constructor(private readonly baseUrl: string, options: HttpMerchantGatewayAdapterOptions = {}) {
    this.headers = options.headers ?? {};
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  async createPaymentIntent(input: CreatePaymentIntentInput, signal?: AbortSignal): Promise<CreatePaymentIntentResult> {
    const resp = await this.fetchWithTimeout(joinUrl(this.baseUrl, this.routes.createOrderPath), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(input),
    }, signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'merchant create-order failed');

    return {
      paymentId: data.paymentId ?? data.orderId ?? data.order_id,
      status: 'created',
      payToAddress: data.payToAddress ?? data.pay_to_address,
      tokenAddress: data.tokenAddress ?? data.token_address,
      calldataSignRequest: data.calldataSignRequest ?? data.calldata_sign_request,
      raw: data,
    };
  }

  async getPaymentStatus(paymentId: string, signal?: AbortSignal) {
    const path = this.routes.orderStatusPath.replace(':paymentId', encodeURIComponent(paymentId));
    const resp = await this.fetchWithTimeout(joinUrl(this.baseUrl, path), {
      headers: { ...this.headers },
    }, signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'merchant order-status failed');

    const rawStatus = String(data.status ?? data.orderStatus ?? 'CHECKOUT_VERIFIED');
    return {
      paymentId,
      status: ORDER_STATUS_MAP[rawStatus] ?? 'created',
      raw: data,
    };
  }

  async submitPaymentAuthorization(paymentId: string, signature: string, signal?: AbortSignal) {
    const resp = await this.fetchWithTimeout(joinUrl(this.baseUrl, this.routes.submitSignaturePath), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ paymentId, signature }),
    }, signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'merchant submit-signature failed');

    return {
      paymentId,
      status: (data?.status === 'failed' ? 'failed' : 'authorized') as 'authorized' | 'failed',
      raw: data,
    };
  }

  async cancelPayment(paymentId: string, signal?: AbortSignal) {
    const resp = await this.fetchWithTimeout(joinUrl(this.baseUrl, this.routes.cancelOrderPath), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ paymentId }),
    }, signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'merchant cancel-order failed');

    return {
      paymentId,
      status: (data?.status === 'failed' ? 'failed' : 'cancelled') as 'cancelled' | 'failed',
      raw: data,
    };
  }
}
