import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_GIFTCARD_AUTH_DOMAIN,
  Eip712AuthSigner,
  HttpGiftcardGatewayAdapter,
  InMemoryAuthCache,
} from '../../plugins/giftcard/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

function fakeWallet(): Pick<WalletProvider, 'getAddress' | 'signTypedData'> & {
  getAddress: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: vi.fn().mockResolvedValue('0x39573c77e3c8d96e1c2d8da7f8d1d4e2d8d4d192'),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENV_KEYS = [
  'GIFTCARD_AUTH_DOMAIN_NAME',
  'GIFTCARD_AUTH_DOMAIN_VERSION',
  'GIFTCARD_AUTH_DOMAIN_CHAIN_ID',
] as const;

describe('Eip712AuthSigner domain resolution', () => {
  let snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    snapshot = {};
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('default domain is { name: "GiftCard", version: "1", chainId: 2345 }', () => {
    const signer = new Eip712AuthSigner(fakeWallet() as unknown as WalletProvider);
    expect(signer.getDomain()).toEqual({ name: 'GiftCard', version: '1', chainId: 2345 });
    // Sanity: exported default matches.
    expect(DEFAULT_GIFTCARD_AUTH_DOMAIN).toEqual({ name: 'GiftCard', version: '1', chainId: 2345 });
  });

  it('honors GIFTCARD_AUTH_DOMAIN_{NAME,VERSION,CHAIN_ID} env overrides at construction', () => {
    process.env.GIFTCARD_AUTH_DOMAIN_NAME = 'CustomGift';
    process.env.GIFTCARD_AUTH_DOMAIN_VERSION = '2';
    process.env.GIFTCARD_AUTH_DOMAIN_CHAIN_ID = '8453';

    const signer = new Eip712AuthSigner(fakeWallet() as unknown as WalletProvider);
    expect(signer.getDomain()).toEqual({ name: 'CustomGift', version: '2', chainId: 8453 });
  });

  it('explicit constructor option takes precedence over env var', () => {
    process.env.GIFTCARD_AUTH_DOMAIN_CHAIN_ID = '8453';
    const signer = new Eip712AuthSigner(fakeWallet() as unknown as WalletProvider, {
      domain: { chainId: 137 },
    });
    expect(signer.getDomain().chainId).toBe(137);
  });

  it('throws on non-numeric chainId env override', () => {
    process.env.GIFTCARD_AUTH_DOMAIN_CHAIN_ID = 'not-a-number';
    expect(() => new Eip712AuthSigner(fakeWallet() as unknown as WalletProvider)).toThrow(
      /must be a positive integer/,
    );
  });

  it('signs with the resolved domain (chainId 2345 default) regardless of wallet chain', async () => {
    const wallet = fakeWallet();
    const signer = new Eip712AuthSigner(wallet as unknown as WalletProvider);

    await signer.signAuth(signer.getDomain(), { address: '0x0', nonce: 1, expiry: 2 });
    const [domain] = wallet.signTypedData.mock.calls[0] as [Record<string, unknown>];
    expect(domain.chainId).toBe(2345);
  });
});

describe('HttpGiftcardGatewayAdapter — expiresAt seconds → milliseconds conversion', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('caches token with expiresAt = expire_at_seconds * 1000', async () => {
    const realNow = Date.now;
    const fixedNowMs = 1_700_000_000_000; // arbitrary but stable
    Date.now = () => fixedNowMs;

    const backendExpireSec = Math.floor(fixedNowMs / 1000) + 60; // 60s from now
    const responder = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/auth/nonce')) {
        return jsonResponse({ address: '0x0', nonce: 1, expire_at: backendExpireSec });
      }
      if (url.includes('/auth/verify')) {
        return jsonResponse({ token: 'tok_ttl', expire_at: backendExpireSec });
      }
      if (url.endsWith('/orders/oid')) {
        return jsonResponse({
          order_id: 'oid',
          status: 'PAYMENT_PENDING',
          product_id: 'p',
          card_brand_name: 'X',
          country: 'US',
          face_value: 50,
          face_value_type: 'VARIABLE',
          sell_price_usd: 52.5,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          created_at: 1,
        });
      }
      return jsonResponse({ message: 'unknown' }, 404);
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => responder(input)) as typeof fetch;

    const cache = new InMemoryAuthCache();
    const wallet = fakeWallet();
    const adapter = new HttpGiftcardGatewayAdapter({
      baseUrl: 'https://giftcard-api.test',
      authSigner: new Eip712AuthSigner(wallet as unknown as WalletProvider),
      authCache: cache,
    });

    try {
      await adapter.getOrder('oid');
      const cached = await cache.get('0x39573c77e3c8d96e1c2d8da7f8d1d4e2d8d4d192');
      expect(cached).not.toBeNull();
      expect(cached!.token).toBe('tok_ttl');
      // expire_at (sec) * 1000 == cached.expiresAt (ms)
      expect(cached!.expiresAt).toBe(backendExpireSec * 1000);

      // Advance Date.now to one ms past expiresAt; the cache should now evict.
      Date.now = () => cached!.expiresAt;
      // At exactly expiresAt, the cache treats it as expired (`>=`).
      expect(await cache.get('0x39573c77e3c8d96e1c2d8da7f8d1d4e2d8d4d192')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
