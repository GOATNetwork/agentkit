import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import { ActionProvider } from '../../providers/action-provider';
import {
  createOrderAction,
  getOrderAction,
  payOrderAction,
} from '../../plugins/giftcard/index';
import type { GiftcardGateway, OrderRecord } from '../../plugins/giftcard/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const silentLogger = { log: () => {} };

function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    order_id: '33333333-3333-3333-3333-333333333333',
    status: 'PAYMENT_PENDING',
    product_id: '22222222-2222-2222-2222-222222222222',
    card_brand_name: 'Amazon',
    country: 'US',
    face_value: 50,
    face_value_type: 'VARIABLE',
    sell_price_usd: 52.5,
    pay_amount_wei: '52500000',
    pay_chain_id: 8453,
    pay_token_symbol: 'USDC',
    pay_token_contract: '0x0000000000000000000000000000000000c0FFee',
    pay_to_address: '0x000000000000000000000000000000000000bEEF',
    expire_at: Math.floor(Date.now() / 1000) + 30 * 60,
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function buildHarness(opts: { allowedNetworks?: string[]; maxRiskWithoutConfirm?: 'read' | 'low' | 'medium' | 'high' } = {}) {
  const order = buildOrder();
  const gateway: GiftcardGateway = {
    listBrands: vi.fn(),
    getBrand: vi.fn(),
    listCategories: vi.fn(),
    listSupportedTokens: vi.fn(),
    createOrder: vi.fn().mockResolvedValue(order),
    getOrder: vi.fn().mockResolvedValue(order),
    listOrders: vi.fn(),
  };
  const wallet: Pick<WalletProvider, 'getChainId' | 'transferErc20'> & {
    getChainId: ReturnType<typeof vi.fn>;
    transferErc20: ReturnType<typeof vi.fn>;
  } = {
    getChainId: vi.fn().mockResolvedValue(8453),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xpaid' }),
  };

  const provider = new ActionProvider();
  provider.register(createOrderAction(gateway));
  provider.register(payOrderAction(gateway, wallet));
  provider.register(getOrderAction(gateway));

  const policy = new PolicyEngine({
    allowedNetworks: opts.allowedNetworks ?? ['base-mainnet'],
    maxRiskWithoutConfirm: opts.maxRiskWithoutConfirm ?? 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, {
    maxRetries: 0,
    retryDelayMs: 1,
    logger: silentLogger,
    metrics: new NoopRuntimeMetrics(),
  });
  const ctx = { traceId: 't1', network: 'base-mainnet', now: Date.now() };

  return { runtime, provider, gateway, wallet, ctx, order };
}

describe('giftcard integration flow', () => {
  it('createOrder → payOrder → getOrder happy path', async () => {
    const { runtime, provider, ctx, wallet } = buildHarness();
    const idem = 'idem-1234567890abcdef';

    const create = await runtime.run(
      provider.get('goat.giftcard.createOrder'),
      ctx,
      {
        product_id: '22222222-2222-2222-2222-222222222222',
        face_value: 50,
        pay_chain_id: 8453,
        pay_token_symbol: 'USDC' as const,
        idempotency_key: idem,
      },
      { confirmed: true, idempotencyKey: idem },
    );
    expect(create.ok).toBe(true);

    const pay = await runtime.run(
      provider.get('goat.giftcard.payOrder'),
      ctx,
      { orderId: create.output!.order_id },
      { confirmed: true },
    );
    expect(pay.ok).toBe(true);
    expect(pay.output?.txHash).toBe('0xpaid');
    expect(wallet.transferErc20).toHaveBeenCalled();

    const get = await runtime.run(provider.get('goat.giftcard.getOrder'), ctx, {
      orderId: create.output!.order_id,
    });
    expect(get.ok).toBe(true);
  });

  it('payOrder is gated by PolicyEngine when not confirmed (high risk)', async () => {
    const { runtime, provider, ctx } = buildHarness();
    const pay = await runtime.run(
      provider.get('goat.giftcard.payOrder'),
      ctx,
      { orderId: '33333333-3333-3333-3333-333333333333' },
      { confirmed: false },
    );
    expect(pay.ok).toBe(false);
    expect(pay.errorCode).toBe('POLICY_BLOCKED');
  });

  it('payOrder rejects on chain mismatch with INVALID_INPUT (non-retryable)', async () => {
    const { runtime, provider, ctx, wallet } = buildHarness();
    wallet.getChainId.mockResolvedValueOnce(137); // Polygon, but order requires Base
    const pay = await runtime.run(
      provider.get('goat.giftcard.payOrder'),
      ctx,
      { orderId: '33333333-3333-3333-3333-333333333333' },
      { confirmed: true },
    );
    expect(pay.ok).toBe(false);
    expect(pay.errorCode).toBe('INVALID_INPUT');
    expect(pay.error).toMatch(/chain_mismatch/);
    expect(pay.error).toMatch(/Polygon/);
    expect(pay.error).toMatch(/Base/);
  });

  it('payOrder rejects when order is within 30s of expiry', async () => {
    const order = buildOrder({ expire_at: Math.floor(Date.now() / 1000) + 10 });
    const gateway: GiftcardGateway = {
      listBrands: vi.fn(),
      getBrand: vi.fn(),
      listCategories: vi.fn(),
      listSupportedTokens: vi.fn(),
      createOrder: vi.fn(),
      getOrder: vi.fn().mockResolvedValue(order),
      listOrders: vi.fn(),
    };
    const wallet = {
      getChainId: vi.fn().mockResolvedValue(8453),
      transferErc20: vi.fn(),
    };
    const provider = new ActionProvider();
    provider.register(payOrderAction(gateway, wallet));
    const policy = new PolicyEngine({
      allowedNetworks: ['base-mainnet'],
      maxRiskWithoutConfirm: 'high',
      writeEnabled: true,
    });
    const runtime = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
    });
    const ctx = { traceId: 't', network: 'base-mainnet', now: Date.now() };

    const res = await runtime.run(provider.get('goat.giftcard.payOrder'), ctx, {
      orderId: order.order_id,
    }, { confirmed: true });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_not_payable/);
    expect(wallet.transferErc20).not.toHaveBeenCalled();
  });
});
