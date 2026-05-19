import { ErrorCodes } from '../../../core/errors/error-codes';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import type {
  AuthCache,
  AuthSigner,
  Brand,
  BrandDetails,
  BrandListParams,
  Category,
  CreateOrderInput,
  Eip712AuthDomain,
  GiftcardGateway,
  GiftcardRedisClient,
  OrderListParams,
  OrderListResponse,
  OrderRecord,
  SupportedTokensResponse,
} from './types';
import { DEFAULT_GIFTCARD_AUTH_DOMAIN, Eip712AuthSigner } from './eip712-auth-signer';

const DEFAULT_BASE_URL = 'https://giftcard-api.goat.network';
const DEFAULT_PATH_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const SINGLE_FLIGHT_LOCK_TTL_MS = 30_000;

interface BackendNonceResponse {
  address: string;
  nonce: number;
  expire_at: number;
}

interface BackendVerifyResponse {
  token: string;
  /** Backend returns expiry in SECONDS. The adapter converts to ms before caching. */
  expire_at: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** In-process AuthCache implementation; default when no Redis is supplied. */
export class InMemoryAuthCache implements AuthCache {
  private readonly store = new Map<string, CachedToken>();

  async get(address: string): Promise<CachedToken | null> {
    const key = address.toLowerCase();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return { ...entry };
  }

  async set(address: string, token: string, expiresAt: number): Promise<void> {
    this.store.set(address.toLowerCase(), { token, expiresAt });
  }

  async clear(address: string): Promise<void> {
    this.store.delete(address.toLowerCase());
  }
}

export interface HttpGiftcardGatewayAdapterOptions {
  /**
   * Production-only base URL. Defaults to https://giftcard-api.goat.network.
   * The adapter intentionally never falls back to a localhost URL — see
   * the plan's "production-only config" constraint.
   */
  baseUrl?: string;
  /**
   * Path prefix prepended to every request path. Default `/api/v1`.
   */
  pathPrefix?: string;
  /** Static headers to include in every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
  /**
   * AuthSigner that signs the EIP-712 Auth message. Required to make
   * protected calls (`createOrder`, `getOrder`, `listOrders`); read-only
   * endpoints work without one.
   */
  authSigner?: AuthSigner;
  /**
   * Bearer token cache. Defaults to an in-memory `InMemoryAuthCache`.
   * Swap for a Redis-backed implementation in multi-process deployments.
   */
  authCache?: AuthCache;
  /**
   * EIP-712 domain overrides. Used only when `authSigner` is omitted
   * and the adapter constructs a default `Eip712AuthSigner` lazily via
   * `authSigner.getDomain()`. When a custom signer is provided this is
   * ignored.
   */
  authDomain?: Partial<Eip712AuthDomain>;
  /**
   * Optional Redis client for distributed single-flight protection.
   * When provided, the adapter additionally acquires
   * `SET auth:inflight:{address} <token> NX PX 30000`. Falls through to
   * in-process Map-based single-flight on lock-acquire failure.
   */
  redis?: GiftcardRedisClient;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised ? `?${serialised}` : '';
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

interface BackendErrorEnvelope {
  message?: string;
  error?: { code?: string; message?: string } | string;
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const env = data as BackendErrorEnvelope;
    if (typeof env.message === 'string' && env.message.length) return env.message;
    if (env.error && typeof env.error === 'object' && typeof env.error.message === 'string') {
      return env.error.message;
    }
    if (typeof env.error === 'string' && env.error.length) return env.error;
  }
  return fallback;
}

function assertOk(resp: Response, data: unknown, method: string, path: string): void {
  if (resp.ok) return;
  throw new AgentkitRuntimeError(
    ErrorCodes.ADAPTER_REQUEST_FAILED,
    extractErrorMessage(data, `giftcard ${method} ${path} failed (${resp.status})`),
    { status: resp.status, body: data },
  );
}

/**
 * HTTP client for the Snaplii-backed Giftcard API.
 *
 * Auth model
 * ----------
 * Protected endpoints (orders) require a Bearer token. The adapter
 * handles the entire auth dance transparently:
 *   1. Check `authCache` for a valid token for this signer's address.
 *   2. If absent or expired, run `getNonce → signAuth → verify`.
 *   3. Cache the new token in `authCache` (expiresAt converted from
 *      seconds → milliseconds).
 *   4. Retry up to once on 401 by forcing re-auth.
 *
 * Single-flight
 * -------------
 * Concurrent first-protected calls race on `pendingAuth` keyed by
 * address. Only one nonce + one verify round-trip is performed. When a
 * Redis client is supplied, we also acquire a distributed lock
 * `auth:inflight:{address}` with `NX PX 30000` semantics; failure to
 * acquire the distributed lock is non-fatal (we fall through to the
 * in-process Map). The local Map is always consulted so unit tests
 * without Redis see deterministic single-flight behavior.
 */
export class HttpGiftcardGatewayAdapter implements GiftcardGateway {
  private readonly baseUrl: string;
  private readonly pathPrefix: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly authSigner: AuthSigner | undefined;
  private readonly authCache: AuthCache;
  private readonly redis: GiftcardRedisClient | undefined;
  private readonly authDomainOverride: Partial<Eip712AuthDomain> | undefined;

  /** Single-flight: one in-flight auth promise per address. */
  private readonly pendingAuth = new Map<string, Promise<CachedToken>>();

  constructor(options: HttpGiftcardGatewayAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.pathPrefix = options.pathPrefix ?? DEFAULT_PATH_PREFIX;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authSigner = options.authSigner;
    this.authCache = options.authCache ?? new InMemoryAuthCache();
    this.redis = options.redis;
    this.authDomainOverride = options.authDomain;
  }

  /* ------------------------------------------------------------ */
  /*  Public endpoints                                            */
  /* ------------------------------------------------------------ */

  async listBrands(params: BrandListParams = {}, signal?: AbortSignal): Promise<Brand[]> {
    const query = buildQuery({
      country: params.country,
      category: params.category,
      lang: params.lang,
    });
    const data = (await this.request('GET', `/brands${query}`, undefined, false, signal)) as {
      brands?: Brand[];
    };
    return data.brands ?? [];
  }

  async getBrand(id: string, lang?: string, signal?: AbortSignal): Promise<BrandDetails> {
    const query = buildQuery({ lang });
    return (await this.request(
      'GET',
      `/brands/${encodeURIComponent(id)}${query}`,
      undefined,
      false,
      signal,
    )) as BrandDetails;
  }

  async listCategories(lang?: string, signal?: AbortSignal): Promise<Category[]> {
    const query = buildQuery({ lang });
    const data = (await this.request(
      'GET',
      `/categories${query}`,
      undefined,
      false,
      signal,
    )) as { categories?: Category[] };
    return data.categories ?? [];
  }

  async listSupportedTokens(signal?: AbortSignal): Promise<SupportedTokensResponse> {
    return (await this.request(
      'GET',
      '/supported-tokens',
      undefined,
      false,
      signal,
    )) as SupportedTokensResponse;
  }

  /* ------------------------------------------------------------ */
  /*  Protected endpoints                                         */
  /* ------------------------------------------------------------ */

  async createOrder(input: CreateOrderInput, signal?: AbortSignal): Promise<OrderRecord> {
    return (await this.request('POST', '/orders', input, true, signal)) as OrderRecord;
  }

  async getOrder(id: string, signal?: AbortSignal): Promise<OrderRecord> {
    return (await this.request(
      'GET',
      `/orders/${encodeURIComponent(id)}`,
      undefined,
      true,
      signal,
    )) as OrderRecord;
  }

  async listOrders(params: OrderListParams = {}, signal?: AbortSignal): Promise<OrderListResponse> {
    const query = buildQuery({
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });
    return (await this.request(
      'GET',
      `/orders${query}`,
      undefined,
      true,
      signal,
    )) as OrderListResponse;
  }

  /* ------------------------------------------------------------ */
  /*  Internals                                                   */
  /* ------------------------------------------------------------ */

  private fullUrl(path: string): string {
    return joinUrl(joinUrl(this.baseUrl, this.pathPrefix), path);
  }

  private fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
  }

  private buildHeaders(hasBody: boolean, bearer?: string): Record<string, string> {
    const h: Record<string, string> = { ...this.headers };
    if (hasBody) h['content-type'] = 'application/json';
    if (bearer) h['authorization'] = `Bearer ${bearer}`;
    return h;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    authenticated: boolean,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    if (!authenticated) {
      return this.rawRequest(method, path, body, undefined, externalSignal);
    }

    if (!this.authSigner) {
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        `giftcard ${method} ${path} requires an AuthSigner; pass options.authSigner to HttpGiftcardGatewayAdapter`,
      );
    }

    const address = (await this.authSigner.getAddress()).toLowerCase();
    let token = await this.ensureToken(address, false, externalSignal);

    try {
      return await this.rawRequest(method, path, body, token, externalSignal);
    } catch (err) {
      if (err instanceof AgentkitRuntimeError && this.is401(err)) {
        token = await this.ensureToken(address, true, externalSignal);
        return this.rawRequest(method, path, body, token, externalSignal);
      }
      throw err;
    }
  }

  private is401(err: AgentkitRuntimeError): boolean {
    const cause = err.cause as { status?: number } | undefined;
    return cause?.status === 401;
  }

  private async rawRequest(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    bearer: string | undefined,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const url = this.fullUrl(path);
    const hasBody = body !== undefined;
    const resp = await this.fetchWithTimeout(
      url,
      {
        method,
        headers: this.buildHeaders(hasBody, bearer),
        body: hasBody ? JSON.stringify(body) : undefined,
      },
      externalSignal,
    );
    const data = await parseBodySafe(resp);
    assertOk(resp, data, method, path);
    return data;
  }

  /**
   * Single-flight + cache + auth roundtrip. Returns a valid Bearer
   * token for `address`.
   *
   * `forceRefresh=true` is used after a 401: it clears any cached
   * token / pending promise before starting a fresh auth roundtrip.
   */
  private async ensureToken(
    address: string,
    forceRefresh: boolean,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    if (forceRefresh) {
      await this.authCache.clear(address);
      this.pendingAuth.delete(address);
    } else {
      const cached = await this.authCache.get(address);
      if (cached) return cached.token;
    }

    const pending = this.pendingAuth.get(address);
    if (pending) {
      const result = await pending;
      return result.token;
    }

    const promise = this.runAuthFlow(address, externalSignal).finally(() => {
      this.pendingAuth.delete(address);
    });
    this.pendingAuth.set(address, promise);

    const result = await promise;
    return result.token;
  }

  private async runAuthFlow(address: string, externalSignal?: AbortSignal): Promise<CachedToken> {
    if (!this.authSigner) {
      // Defensive: caller is supposed to have checked.
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        'giftcard auth flow requires AuthSigner',
      );
    }

    // Best-effort distributed lock. On failure we still proceed with
    // the in-process single-flight (the local Map is the source of
    // truth — Redis is purely a multi-process coordination hint).
    const lockKey = `auth:inflight:${address}`;
    const lockToken = `${address}:${Date.now()}:${Math.random()}`;
    let acquiredLock = false;
    if (this.redis) {
      try {
        const result = await this.redis.set(lockKey, lockToken, 'PX', SINGLE_FLIGHT_LOCK_TTL_MS, 'NX');
        acquiredLock = result === 'OK';
      } catch {
        // Swallow — distributed lock is a best-effort optimisation.
        acquiredLock = false;
      }
    }

    try {
      const nonce = (await this.rawRequest(
        'GET',
        `/auth/nonce${buildQuery({ address })}`,
        undefined,
        undefined,
        externalSignal,
      )) as BackendNonceResponse;

      const domain = this.resolveAuthDomain();
      const signature = await this.authSigner.signAuth(domain, {
        address,
        nonce: nonce.nonce,
        expiry: nonce.expire_at,
      });

      const verify = (await this.rawRequest(
        'POST',
        '/auth/verify',
        {
          address,
          nonce: nonce.nonce,
          signature,
        },
        undefined,
        externalSignal,
      )) as BackendVerifyResponse;

      const expiresAt = verify.expire_at * 1000; // seconds → milliseconds
      await this.authCache.set(address, verify.token, expiresAt);
      return { token: verify.token, expiresAt };
    } finally {
      if (acquiredLock && this.redis) {
        try {
          await this.redis.del(lockKey);
        } catch {
          /* ignore — TTL will reap it */
        }
      }
    }
  }

  private resolveAuthDomain(): Eip712AuthDomain {
    if (this.authSigner instanceof Eip712AuthSigner) {
      return this.authSigner.getDomain();
    }
    // Custom signer: prefer constructor override, fall back to default.
    return {
      name: this.authDomainOverride?.name ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.name,
      version: this.authDomainOverride?.version ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.version,
      chainId: this.authDomainOverride?.chainId ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.chainId,
    };
  }
}
