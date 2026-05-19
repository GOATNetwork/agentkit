import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import { ActionProvider } from '../../providers/action-provider';
import { createOrderAction } from '../../plugins/giftcard/index';
import type { GiftcardGateway, OrderRecord } from '../../plugins/giftcard/index';

const silentLogger = { log: () => {} };

function buildOrder(): OrderRecord {
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
  };
}

function buildRuntime() {
  const createOrder = vi.fn().mockResolvedValue(buildOrder());
  const gateway: GiftcardGateway = {
    listBrands: vi.fn(),
    getBrand: vi.fn(),
    listCategories: vi.fn(),
    listSupportedTokens: vi.fn(),
    createOrder,
    getOrder: vi.fn(),
    listOrders: vi.fn(),
  };
  const provider = new ActionProvider();
  provider.register(createOrderAction(gateway));

  const policy = new PolicyEngine({
    allowedNetworks: ['base-mainnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, {
    maxRetries: 0,
    retryDelayMs: 1,
    logger: silentLogger,
    metrics: new NoopRuntimeMetrics(),
  });
  const ctx = { traceId: 't', network: 'base-mainnet', now: Date.now() };
  return { runtime, provider, ctx, createOrder };
}

describe('giftcard createOrder idempotency contract', () => {
  it('(a) same key everywhere: second call returns cached output without a second backend hit', async () => {
    const { runtime, provider, ctx, createOrder } = buildRuntime();
    const idem = 'idem-shared-1234567890abcdef';
    const input = {
      product_id: '22222222-2222-2222-2222-222222222222',
      face_value: 50,
      pay_chain_id: 8453,
      pay_token_symbol: 'USDC' as const,
      idempotency_key: idem,
    };

    const first = await runtime.run(provider.get('goat.giftcard.createOrder'), ctx, input, {
      confirmed: true,
      idempotencyKey: idem,
    });
    expect(first.ok).toBe(true);
    expect(createOrder).toHaveBeenCalledTimes(1);

    const second = await runtime.run(provider.get('goat.giftcard.createOrder'), ctx, input, {
      confirmed: true,
      idempotencyKey: idem,
    });
    expect(second.ok).toBe(true);
    expect(second.output).toEqual(first.output);
    expect(createOrder).toHaveBeenCalledTimes(1); // no second backend hit
  });

  it('(b) divergent keys: INVALID_INPUT before any HTTP traffic', async () => {
    const { runtime, provider, ctx, createOrder } = buildRuntime();
    const input = {
      product_id: '22222222-2222-2222-2222-222222222222',
      face_value: 50,
      pay_chain_id: 8453,
      pay_token_symbol: 'USDC' as const,
      idempotency_key: 'aaaaaaaaaaaaaaaa',
    };
    const res = await runtime.run(provider.get('goat.giftcard.createOrder'), ctx, input, {
      confirmed: true,
      idempotencyKey: 'bbbbbbbbbbbbbbbb',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/idempotency key mismatch/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('(c) runtime cache miss + same backend key: gateway returns the same order (dedup-on-backend)', async () => {
    // Two fresh runtimes (no shared in-memory cache) — simulates a
    // process restart between the two calls. Both runs pass the same
    // idempotency_key to the backend; the mocked backend deterministically
    // returns the same order id, modelling its own dedup.
    const sharedOrder = buildOrder();
    const createOrder = vi.fn().mockResolvedValue(sharedOrder);
    const gateway: GiftcardGateway = {
      listBrands: vi.fn(),
      getBrand: vi.fn(),
      listCategories: vi.fn(),
      listSupportedTokens: vi.fn(),
      createOrder,
      getOrder: vi.fn(),
      listOrders: vi.fn(),
    };
    const policy = new PolicyEngine({
      allowedNetworks: ['base-mainnet'],
      maxRiskWithoutConfirm: 'low',
      writeEnabled: true,
    });
    const idem = 'idem-survived-restart-1234';
    const input = {
      product_id: '22222222-2222-2222-2222-222222222222',
      face_value: 50,
      pay_chain_id: 8453,
      pay_token_symbol: 'USDC' as const,
      idempotency_key: idem,
    };
    const ctx = { traceId: 't', network: 'base-mainnet', now: Date.now() };

    const runtimeA = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
    });
    const providerA = new ActionProvider();
    providerA.register(createOrderAction(gateway));
    const a = await runtimeA.run(providerA.get('goat.giftcard.createOrder'), ctx, input, {
      confirmed: true,
      idempotencyKey: idem,
    });
    expect(a.ok).toBe(true);

    const runtimeB = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
    });
    const providerB = new ActionProvider();
    providerB.register(createOrderAction(gateway));
    const b = await runtimeB.run(providerB.get('goat.giftcard.createOrder'), ctx, input, {
      confirmed: true,
      idempotencyKey: idem,
    });
    expect(b.ok).toBe(true);
    expect(b.output?.order_id).toBe(a.output?.order_id);
    // Two backend hits because the runtime cache is process-local; the
    // backend dedups on idempotency_key and returns the same order.
    expect(createOrder).toHaveBeenCalledTimes(2);
  });
});
