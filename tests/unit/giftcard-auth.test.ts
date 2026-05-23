import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Eip712AuthSigner,
  HttpGiftcardGatewayAdapter,
  InMemoryAuthCache,
} from '../../plugins/giftcard/index';
import type { AuthSigner } from '../../plugins/giftcard/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const ADDRESS = '0x39573c77e3c8d96e1c2d8da7f8d1d4e2d8d4d192';

function fakeWallet(): Pick<WalletProvider, 'getAddress' | 'signTypedData'> & {
  getAddress: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: vi.fn().mockResolvedValue(ADDRESS),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Programmable fetch mock — records every call and responds based on a
 * URL/path matcher. Returns a real `Response` (status, headers) so the
 * adapter's `parseBodySafe` / `assertOk` paths execute as in production.
 */
function makeFetch(responder: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: FetchCall = { url, init: (init ?? {}) as RequestInit };
    calls.push(call);
    return responder(call);
  };
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpGiftcardGatewayAdapter auto-auth', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('runs nonce → sign → verify → cache → use on first protected call', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const responder = vi.fn(async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        return jsonResponse({ address: ADDRESS, nonce: 42, expire_at: nowSec + 300 });
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_abc', expire_at: nowSec + 3600 });
      }
      if (call.url.endsWith('/orders/order-id-1')) {
        return jsonResponse({
          order_id: 'order-id-1',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: nowSec,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    });
    const { fetch: mockFetch, calls } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const wallet = fakeWallet();
    const signer = new Eip712AuthSigner(wallet as unknown as WalletProvider);
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: signer,
    });

    const order = await adapter.getOrder('order-id-1');
    expect(order.order_id).toBe('order-id-1');

    const noncePath = calls.find((c) => c.url.includes('/auth/nonce'));
    const verifyPath = calls.find((c) => c.url.includes('/auth/verify'));
    const orderPath = calls.find((c) => c.url.endsWith('/orders/order-id-1'));

    expect(noncePath).toBeDefined();
    expect(verifyPath).toBeDefined();
    expect(orderPath).toBeDefined();
    expect((orderPath!.init.headers as Record<string, string>).authorization).toBe('Bearer tok_abc');
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    // The domain passed to signTypedData uses chainId 2345 by default.
    const [domain, , value] = wallet.signTypedData.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(domain.chainId).toBe(2345);
    expect(domain.name).toBe('GiftCard');
    expect(value.nonce).toBe(42n);
  });

  // Regression: production nonces exceed Number.MAX_SAFE_INTEGER. They must be
  // read as a string from the raw body and signed/verified without rounding,
  // otherwise the backend returns "nonce not found".
  it('preserves a nonce larger than Number.MAX_SAFE_INTEGER (no precision loss)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const BIG = '3926424146173219811'; // JSON.parse would round this to ...840
    const responder = vi.fn(async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        // Raw body with exact digits — a JS object + JSON.stringify could not represent it.
        return new Response(`{"address":"${ADDRESS}","nonce":${BIG},"expire_at":${nowSec + 300}}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_big', expire_at: nowSec + 3600 });
      }
      if (call.url.endsWith('/orders/order-big')) {
        return jsonResponse({
          order_id: 'order-big',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: nowSec,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    });
    const { fetch: mockFetch, calls } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const wallet = fakeWallet();
    const signer = new Eip712AuthSigner(wallet as unknown as WalletProvider);
    const adapter = new HttpGiftcardGatewayAdapter({ baseUrl: 'https://giftcard-api.test', authSigner: signer });

    await adapter.getOrder('order-big');

    // Signed nonce is the EXACT bigint, not the rounded 3926424146173219840n.
    const [, , value] = wallet.signTypedData.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(value.nonce).toBe(3926424146173219811n);
    expect(value.nonce).not.toBe(3926424146173219840n);

    // The verify body carries the exact nonce digits as a JSON number literal.
    const verifyCall = calls.find((c) => c.url.includes('/auth/verify'));
    expect(verifyCall).toBeDefined();
    expect(String(verifyCall!.init.body)).toContain('"nonce":3926424146173219811');
    expect(String(verifyCall!.init.body)).not.toContain('3926424146173219840');
  });

  it('reuses cached token across subsequent protected calls (no second auth roundtrip)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const responder = vi.fn(async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        return jsonResponse({ address: ADDRESS, nonce: 1, expire_at: nowSec + 300 });
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_reuse', expire_at: nowSec + 3600 });
      }
      if (call.url.includes('/orders/order-A')) {
        return jsonResponse({
          order_id: 'order-A',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: nowSec,
        });
      }
      if (call.url.includes('/orders/order-B')) {
        return jsonResponse({
          order_id: 'order-B',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: nowSec,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    });
    const { fetch: mockFetch, calls } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const wallet = fakeWallet();
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: new Eip712AuthSigner(wallet as unknown as WalletProvider),
    });

    await adapter.getOrder('order-A');
    await adapter.getOrder('order-B');

    const noncesCount = calls.filter((c) => c.url.includes('/auth/nonce')).length;
    const verifiesCount = calls.filter((c) => c.url.includes('/auth/verify')).length;
    expect(noncesCount).toBe(1);
    expect(verifiesCount).toBe(1);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('forces ONE re-auth on a 401 response, then succeeds', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let attemptCount = 0;
    const responder = async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        return jsonResponse({ address: ADDRESS, nonce: 10, expire_at: nowSec + 300 });
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: `tok_${attemptCount + 1}`, expire_at: nowSec + 3600 });
      }
      if (call.url.includes('/orders/order-401')) {
        attemptCount += 1;
        if (attemptCount === 1) return jsonResponse({ error: 'unauthorized' }, 401);
        return jsonResponse({
          order_id: 'order-401',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: nowSec,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    };
    const { fetch: mockFetch, calls } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const wallet = fakeWallet();
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: new Eip712AuthSigner(wallet as unknown as WalletProvider),
    });

    const order = await adapter.getOrder('order-401');
    expect(order.order_id).toBe('order-401');
    // Two auth roundtrips total: initial + 401 retry.
    expect(calls.filter((c) => c.url.includes('/auth/nonce')).length).toBe(2);
    expect(calls.filter((c) => c.url.includes('/auth/verify')).length).toBe(2);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(2);
  });

  it('single-flight: 5 concurrent protected calls trigger only ONE nonce + ONE verify', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let nonceResolve!: (r: Response) => void;
    const noncePromise = new Promise<Response>((res) => {
      nonceResolve = res;
    });
    const responder = async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        return noncePromise; // stall until we release
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_single', expire_at: nowSec + 3600 });
      }
      const id = decodeURIComponent(call.url.split('/orders/')[1] ?? '');
      return jsonResponse({
        order_id: id,
        status: 'PAYMENT_PENDING',
        product_id: 'p',
        card_brand_name: 'X',
        country: 'US',
        face_value: 50,
        face_value_type: 'VARIABLE',
        sell_price_usd: 52.5,
        pay_chain_id: 8453,
        pay_token_symbol: 'USDC',
        created_at: nowSec,
      });
    };
    const { fetch: mockFetch, calls } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const wallet = fakeWallet();
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: new Eip712AuthSigner(wallet as unknown as WalletProvider),
    });

    const concurrent = Array.from({ length: 5 }, (_, i) => adapter.getOrder(`order-${i}`));
    // Yield once so all five calls reach the auth-flow await before nonce resolves.
    await new Promise((r) => setImmediate(r));
    nonceResolve(jsonResponse({ address: ADDRESS, nonce: 7, expire_at: nowSec + 300 }));
    const orders = await Promise.all(concurrent);

    expect(orders).toHaveLength(5);
    expect(calls.filter((c) => c.url.includes('/auth/nonce')).length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/auth/verify')).length).toBe(1);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('throws ADAPTER_REQUEST_FAILED on a non-401 non-2xx response', async () => {
    const responder = async (): Promise<Response> => jsonResponse({ error: 'gone' }, 410);
    const { fetch: mockFetch } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const adapter = new HttpGiftcardGatewayAdapter({ baseUrl: 'https://giftcard-api.test' });
    await expect(adapter.listBrands()).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
    });
  });

  it('requires AuthSigner for protected endpoints', async () => {
    const adapter = new HttpGiftcardGatewayAdapter({ baseUrl: 'https://giftcard-api.test' });
    await expect(adapter.getOrder('x')).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
    });
  });
});

/* ---------------------------------------------------------------- */
/*  InMemoryAuthCache                                                */
/* ---------------------------------------------------------------- */

describe('InMemoryAuthCache TTL semantics', () => {
  it('returns null after expiresAt has passed (Date.now() in ms)', async () => {
    const cache = new InMemoryAuthCache();
    const now = Date.now();
    const realNow = Date.now;
    try {
      Date.now = () => now;
      await cache.set(ADDRESS, 'tok', now + 1000);
      expect(await cache.get(ADDRESS)).toEqual({ token: 'tok', expiresAt: now + 1000 });
      Date.now = () => now + 1001;
      expect(await cache.get(ADDRESS)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('treats address case-insensitively', async () => {
    const cache = new InMemoryAuthCache();
    await cache.set('0xABC0000000000000000000000000000000000000', 'tok', Date.now() + 10_000);
    expect((await cache.get('0xabc0000000000000000000000000000000000000'))?.token).toBe('tok');
  });
});

/* ---------------------------------------------------------------- */
/*  Redis lock degraded paths                                       */
/* ---------------------------------------------------------------- */

describe('HttpGiftcardGatewayAdapter Redis lock', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips the cache-poll wait when redis.set THROWS (Redis outage)', async () => {
    // Regression: a Redis outage used to be treated as "lost the NX race"
    // and the adapter would wait ~30s on waitForCachedToken before
    // falling through to the auth flow. With the fix, redis.set throwing
    // is recognized as "Redis unreachable" and we skip straight to the
    // auth roundtrip.
    const nowSec = Math.floor(Date.now() / 1000);
    const responder = vi.fn(async (call: FetchCall): Promise<Response> => {
      if (call.url.includes('/auth/nonce')) {
        return jsonResponse({ address: ADDRESS, nonce: 5, expire_at: nowSec + 300 });
      }
      if (call.url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_outage', expire_at: nowSec + 3600 });
      }
      if (call.url.endsWith('/orders/o1')) {
        return jsonResponse({
          order_id: 'o1', status: 'PAYMENT_PENDING', product_id: 'p',
          card_brand_name: 'X', country: 'US', face_value: 1,
          face_value_type: 'VARIABLE', sell_price_usd: 1, pay_chain_id: 8453,
          pay_token_symbol: 'USDC', created_at: nowSec,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    });
    const { fetch: mockFetch } = makeFetch(responder);
    globalThis.fetch = mockFetch;

    const redis = {
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      del: vi.fn().mockResolvedValue(0),
      get: vi.fn().mockResolvedValue(null),
    };
    const wallet = fakeWallet();
    const signer = new Eip712AuthSigner(wallet as unknown as WalletProvider);
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: signer,
      redis,
    });

    const start = Date.now();
    await adapter.getOrder('o1');
    const elapsed = Date.now() - start;

    // Must complete promptly — the cache-poll path would have taken
    // ~30s. Give a generous 2s budget for CI flakiness.
    expect(elapsed).toBeLessThan(2000);
    expect(redis.set).toHaveBeenCalledTimes(1);
    // We never tried to release a lock we never held.
    expect(redis.del).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------- */
/*  AuthSigner contract                                             */
/* ---------------------------------------------------------------- */

describe('AuthSigner contract', () => {
  it('Eip712AuthSigner forwards bigint values to signTypedData', async () => {
    const wallet = fakeWallet();
    const signer: AuthSigner = new Eip712AuthSigner(wallet as unknown as WalletProvider);
    await signer.signAuth({ name: 'GiftCard', version: '1', chainId: 2345 }, {
      address: ADDRESS,
      nonce: 7,
      expiry: 1234567890,
    });
    const [, types, value] = wallet.signTypedData.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(Array.isArray(types.Auth)).toBe(true);
    expect((types.Auth as { name: string; type: string }[])[0]).toEqual({ name: 'address', type: 'address' });
    expect(value.nonce).toBe(7n);
    expect(value.expiry).toBe(1234567890n);
  });
});
