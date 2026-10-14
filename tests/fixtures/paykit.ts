import { vi } from 'vitest';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

export const TOKEN = `0x${'11'.repeat(20)}`;
export const PAYER = `0x${'22'.repeat(20)}`;
export const PAYTO = `0x${'33'.repeat(20)}`;
export const HASH = `0x${'44'.repeat(32)}`;
export const URL = 'https://pay.example/paykit/acme';
export const ctx = { traceId: 'test', network: 'eip155:4217', now: Date.now() };
export const payment = {
  url: URL,
  chainId: 4217,
  tokenContract: TOKEN,
  amount: '1',
  idempotencyKey: 'invoice-1',
  pollIntervalMs: 1,
  pollTimeoutMs: 40,
};
export const manifest = {
  schema: 'goatx402.quickpay.v1',
  merchant: { merchant_id: 'acme', display_name: 'ACME' },
  rails: {
    x402: {
      enabled: true,
      session_endpoint: 'https://evil.example/steal',
      tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: TOKEN, decimals: 6, min_amount_wei: '1' }],
      products: [{ product_key: 'mug', name: 'Mug', price: '1' }],
    },
    mpp: {
      enabled: true,
      routes: [
        {
          route_canonical: 'GET:api:data',
          chain_id: 4217,
          token_symbol: 'USDC',
          token_contract: TOKEN,
          amount_wei: '1000000',
        },
      ],
    },
    fiat: {
      enabled: true,
      human_action_required: true,
      currency: 'USD',
      minor_unit_exponent: 2,
      products: [{ product_key: 'mug', name: 'Mug', price: '1' }],
    },
  },
};
export function session(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    merchant_id: 'acme',
    order_id: 'o1',
    status: 'ORDER_CREATED',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', asset: TOKEN, payTo: PAYTO, amount: '1000000' }] },
    ...overrides,
  };
}
export function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    merchant_id: 'acme',
    order_id: 'o1',
    status: 'PAYMENT_CONFIRMED',
    tx_hash: HASH,
    chain_id: 4217,
    token_contract: TOKEN,
    amount_wei: '1000000',
    ...overrides,
  };
}
export function fakeWallet() {
  const broadcast = vi.fn(async () => ({ txHash: HASH }));
  const wallet = {
    getAddress: async () => PAYER,
    getChainId: async () => 4217,
    broadcastErc20: broadcast,
  } as unknown as WalletProvider;
  return { wallet, broadcast };
}
export function routes(
  options: {
    session?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
    manifest?: unknown;
    failStatus?: boolean;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/manifest.json')) return Response.json(options.manifest ?? manifest);
    if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST')
      return Response.json(options.session ?? session());
    if (url.includes('/quickpay/v1/x402/sessions/'))
      return Response.json(options.snapshot ?? snapshot(), { status: options.failStatus ? 503 : 200 });
    if (url.endsWith('/quickpay/v1/fiat/sessions'))
      return Response.json({
        checkout_id: 'cs1',
        url: 'https://pay.example/paykit/direct?cs=cs1',
        currency: 'USD',
        expires_at: 2000000000,
      });
    return Response.json({ error: 'unexpected URL' }, { status: 500 });
  });
}
