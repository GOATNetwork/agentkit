import { ErrorCodes } from '../../../core/errors/error-codes';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import type { MerchantPortalClient, RequestOptions } from './types';

export interface HttpMerchantPortalClientOptions {
  /** Initial access token (optional; can also be set via setAccessToken). */
  accessToken?: string;
  /** Extra headers to include in every request. */
  headers?: Record<string, string>;
  /** HTTP request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
}

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

function assertOk(resp: Response, data: any, method: string, path: string): void {
  if (!resp.ok) {
    throw new AgentkitRuntimeError(
      ErrorCodes.ADAPTER_REQUEST_FAILED,
      data?.message || data?.error || `Merchant portal ${method} ${path} failed (${resp.status})`,
      { status: resp.status, body: data },
    );
  }
}

export class HttpMerchantPortalClient implements MerchantPortalClient {
  private accessToken: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    options: HttpMerchantPortalClientOptions = {},
  ) {
    this.accessToken = options.accessToken;
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Create a session-scoped clone of this client with the given access token.
   * The clone shares the same base URL and config but has independent token state,
   * which avoids cross-session token leakage in multi-tenant deployments.
   */
  withAccessToken(token: string): HttpMerchantPortalClient {
    return new HttpMerchantPortalClient(this.baseUrl, {
      accessToken: token,
      headers: { ...this.extraHeaders },
      timeoutMs: this.timeoutMs,
    });
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  private buildHeaders(hasBody: boolean, tokenOverride?: string): Record<string, string> {
    const h: Record<string, string> = { ...this.extraHeaders };
    if (hasBody) h['content-type'] = 'application/json';
    const token = tokenOverride ?? this.accessToken;
    if (token) h['authorization'] = `Bearer ${token}`;
    return h;
  }

  private fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  async get<T = any>(path: string, options?: RequestOptions): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const resp = await this.fetchWithTimeout(url, { headers: this.buildHeaders(false, options?.accessToken) }, options?.signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'GET', path);
    return data as T;
  }

  async post<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const resp = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.buildHeaders(body != null, options?.accessToken),
      body: body != null ? JSON.stringify(body) : undefined,
    }, options?.signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'POST', path);
    return data as T;
  }

  async put<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const resp = await this.fetchWithTimeout(url, {
      method: 'PUT',
      headers: this.buildHeaders(body != null, options?.accessToken),
      body: body != null ? JSON.stringify(body) : undefined,
    }, options?.signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'PUT', path);
    return data as T;
  }

  async delete<T = any>(path: string, options?: RequestOptions): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const resp = await this.fetchWithTimeout(url, {
      method: 'DELETE',
      headers: this.buildHeaders(false, options?.accessToken),
    }, options?.signal);
    const data = await parseBodySafe(resp);
    assertOk(resp, data, 'DELETE', path);
    return data as T;
  }
}
