import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import { ActionProvider } from '../../providers/action-provider';
import {
  createOrderAction,
  getBrandAction,
  getOrderAction,
  listBrandsAction,
  listCategoriesAction,
  listOrdersAction,
  listSupportedTokensAction,
  payOrderAction,
} from '../../plugins/giftcard/index';
import type {
  Brand,
  BrandDetails,
  GiftcardCreateOrderInput,
  GiftcardGateway,
  OrderRecord,
} from '../../plugins/giftcard/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';
import type { ActionContext } from '../../core/schema/action';

const silentLogger = { log: () => {} };

const baseCtx: ActionContext = {
  traceId: 'trace-test',
  network: 'goat-testnet',
  now: Date.now(),
};

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

/* ---------------------------------------------------------------- */
/*  listBrands / getBrand / listCategories / listSupportedTokens    */
/* ---------------------------------------------------------------- */

describe('goat.giftcard.listBrands', () => {
  it('forwards typed params and unwraps the brand list', async () => {
    const brands: Brand[] = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        country: 'US',
        name: 'Amazon',
        logo_url: '',
        product_count: 1,
      },
    ];
    const gateway: Pick<GiftcardGateway, 'listBrands'> = {
      listBrands: vi.fn().mockResolvedValue(brands),
    };
    const action = listBrandsAction(gateway);
    expect(action.name).toBe('goat.giftcard.listBrands');
    expect(action.riskLevel).toBe('read');
    expect(action.networks).toEqual([]);

    const result = await action.execute(baseCtx, { country: 'US', category: 'shopping' });
    expect(gateway.listBrands).toHaveBeenCalledWith(
      { country: 'US', category: 'shopping' },
      baseCtx.signal,
    );
    expect(result).toEqual({ brands });
  });

  it('rejects non-ISO country via Zod', async () => {
    const action = listBrandsAction({ listBrands: vi.fn() });
    const policy = new PolicyEngine({
      allowedNetworks: ['goat-testnet'],
      maxRiskWithoutConfirm: 'read',
      writeEnabled: true,
    });
    const runtime = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
    });
    const res = await runtime.run(action, baseCtx, { country: 'usa' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
  });
});

describe('goat.giftcard.getBrand', () => {
  it('passes brand_id and lang', async () => {
    const details: BrandDetails = {
      brand: { id: 'x', name: 'Amazon', logo_url: '', country: 'US' },
      products: [],
    };
    const gateway: Pick<GiftcardGateway, 'getBrand'> = {
      getBrand: vi.fn().mockResolvedValue(details),
    };
    const action = getBrandAction(gateway);
    const result = await action.execute(baseCtx, {
      brand_id: '11111111-1111-1111-1111-111111111111',
      lang: 'en',
    });
    expect(gateway.getBrand).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'en',
      baseCtx.signal,
    );
    expect(result).toEqual(details);
  });
});

describe('goat.giftcard.listCategories / listSupportedTokens', () => {
  it('listCategories wraps under { categories }', async () => {
    const gateway: Pick<GiftcardGateway, 'listCategories'> = {
      listCategories: vi.fn().mockResolvedValue([{ id: 'shopping', name: 'Shopping' }]),
    };
    const action = listCategoriesAction(gateway);
    const result = await action.execute(baseCtx, { lang: 'en' });
    expect(result.categories).toHaveLength(1);
    expect(gateway.listCategories).toHaveBeenCalledWith('en', baseCtx.signal);
  });

  it('listSupportedTokens returns the gateway shape verbatim', async () => {
    const tokens = {
      tokens: [
        {
          chain_id: 8453,
          token_symbol: 'USDC' as const,
          token_contract: '0x0000000000000000000000000000000000c0FFee',
          decimals: 6,
          chain_name: 'Base',
        },
      ],
    };
    const gateway: Pick<GiftcardGateway, 'listSupportedTokens'> = {
      listSupportedTokens: vi.fn().mockResolvedValue(tokens),
    };
    const action = listSupportedTokensAction(gateway);
    const result = await action.execute(baseCtx);
    expect(result).toEqual(tokens);
  });
});

/* ---------------------------------------------------------------- */
/*  createOrder                                                     */
/* ---------------------------------------------------------------- */

describe('goat.giftcard.createOrder', () => {
  it('sends the canonical Go-backend payload shape', async () => {
    const gateway: Pick<GiftcardGateway, 'createOrder'> = {
      createOrder: vi.fn().mockResolvedValue(buildOrder()),
    };
    const action = createOrderAction(gateway);
    expect(action.name).toBe('goat.giftcard.createOrder');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);
    expect(action.networks).toEqual([]);

    const input: GiftcardCreateOrderInput = {
      product_id: '22222222-2222-2222-2222-222222222222',
      face_value: 50,
      pay_chain_id: 8453,
      pay_token_symbol: 'USDC',
      idempotency_key: 'idem-1234567890abcdef',
    };
    await action.execute({ ...baseCtx, idempotencyKey: input.idempotency_key }, input);
    expect(gateway.createOrder).toHaveBeenCalledWith(input, baseCtx.signal);
  });

  it('rejects when ctx.idempotencyKey != input.idempotency_key (before HTTP)', async () => {
    const createOrder = vi.fn();
    const gateway: Pick<GiftcardGateway, 'createOrder'> = { createOrder };
    const action = createOrderAction(gateway);

    await expect(
      action.execute(
        { ...baseCtx, idempotencyKey: 'aaaaaaaaaaaaaaaa' },
        {
          product_id: '22222222-2222-2222-2222-222222222222',
          face_value: 50,
          pay_chain_id: 8453,
          pay_token_symbol: 'USDC',
          idempotency_key: 'bbbbbbbbbbbbbbbb',
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('proceeds when ctx.idempotencyKey is undefined (caller did not propagate to runtime)', async () => {
    const gateway: Pick<GiftcardGateway, 'createOrder'> = {
      createOrder: vi.fn().mockResolvedValue(buildOrder()),
    };
    const action = createOrderAction(gateway);
    await expect(
      action.execute(baseCtx, {
        product_id: '22222222-2222-2222-2222-222222222222',
        face_value: 50,
        pay_chain_id: 8453,
        pay_token_symbol: 'USDC',
        idempotency_key: 'idem-1234567890abcdef',
      }),
    ).resolves.toBeDefined();
    expect(gateway.createOrder).toHaveBeenCalled();
  });

  it('strips nested `card` and promotes card_code to top level (idempotency-replay leak guard)', async () => {
    // Backend may replay an already-fulfilled order for the same
    // idempotency_key. If that happens, the response carries
    // `card.card_code` etc. — and we MUST not let that reach the
    // post-success hook event in the nested form, because the
    // runtime's redactor is shallow.
    const replayed = {
      ...buildOrder(),
      status: 'FULFILLED' as const,
      card: { card_code: 'AMZN-1234', card_pin: '0987', card_link: null, card_barcode: null },
    };
    const gateway: Pick<GiftcardGateway, 'createOrder'> = {
      createOrder: vi.fn().mockResolvedValue(replayed),
    };
    const action = createOrderAction(gateway);
    const out = await action.execute(
      { ...baseCtx, idempotencyKey: 'idem-1234567890abcdef' },
      {
        product_id: '22222222-2222-2222-2222-222222222222',
        face_value: 50,
        pay_chain_id: 8453,
        pay_token_symbol: 'USDC',
        idempotency_key: 'idem-1234567890abcdef',
      },
    );
    expect((out as { card?: unknown }).card).toBeUndefined();
    expect((out as { card_code?: string }).card_code).toBe('AMZN-1234');
    expect((out as { card_pin?: string }).card_pin).toBe('0987');
    // Declare the sensitive list so a runtime hook would redact it.
    expect(action.sensitiveOutputFields).toContain('card_code');
    expect(action.sensitiveOutputFields).toContain('card_pin');
  });
});

/* ---------------------------------------------------------------- */
/*  payOrder                                                        */
/* ---------------------------------------------------------------- */

describe('goat.giftcard.payOrder', () => {
  type GatewaySlice = Pick<GiftcardGateway, 'getOrder'>;
  type WalletSlice = Pick<WalletProvider, 'getChainId' | 'transferErc20'>;

  function buildWallet(chainId: number): WalletSlice & {
    getChainId: ReturnType<typeof vi.fn>;
    transferErc20: ReturnType<typeof vi.fn>;
  } {
    return {
      getChainId: vi.fn().mockResolvedValue(chainId),
      transferErc20: vi.fn().mockResolvedValue({ txHash: '0xdeadbeef' }),
    };
  }

  it('calls transferErc20 with (pay_token_contract, pay_to_address, pay_amount_wei)', async () => {
    const order = buildOrder();
    const gateway: GatewaySlice = { getOrder: vi.fn().mockResolvedValue(order) };
    const wallet = buildWallet(8453);
    const action = payOrderAction(gateway, wallet);

    expect(action.networks).toContain('base-mainnet');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(baseCtx, { orderId: order.order_id });
    expect(wallet.transferErc20).toHaveBeenCalledWith(
      '0x0000000000000000000000000000000000c0FFee',
      '0x000000000000000000000000000000000000bEEF',
      '52500000',
      { signal: baseCtx.signal },
    );
    expect(result.txHash).toBe('0xdeadbeef');
    expect(result.payChainId).toBe(8453);
    expect(result.payAmountWei).toBe('52500000');
  });

  it('rejects on chain mismatch with human-readable message', async () => {
    const order = buildOrder({ pay_chain_id: 8453 });
    const gateway: GatewaySlice = { getOrder: vi.fn().mockResolvedValue(order) };
    const wallet = buildWallet(137); // wallet on Polygon
    const action = payOrderAction(gateway, wallet);

    await expect(action.execute(baseCtx, { orderId: order.order_id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('chain_mismatch'),
    });
    expect(wallet.transferErc20).not.toHaveBeenCalled();
  });

  it('rejects when within 30s expiry margin', async () => {
    const order = buildOrder({ expire_at: Math.floor(Date.now() / 1000) + 10 });
    const gateway: GatewaySlice = { getOrder: vi.fn().mockResolvedValue(order) };
    const wallet = buildWallet(8453);
    const action = payOrderAction(gateway, wallet);

    await expect(action.execute(baseCtx, { orderId: order.order_id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('order_not_payable'),
    });
    expect(wallet.transferErc20).not.toHaveBeenCalled();
  });

  it('rejects when pay_amount_wei is non-decimal-string', async () => {
    const order = buildOrder({ pay_amount_wei: '50.5e6' });
    const gateway: GatewaySlice = { getOrder: vi.fn().mockResolvedValue(order) };
    const wallet = buildWallet(8453);
    const action = payOrderAction(gateway, wallet);

    await expect(action.execute(baseCtx, { orderId: order.order_id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('pay_amount_wei'),
    });
    expect(wallet.transferErc20).not.toHaveBeenCalled();
  });

  it('rejects when pay_to_address is missing', async () => {
    const order = buildOrder({ pay_to_address: null });
    const gateway: GatewaySlice = { getOrder: vi.fn().mockResolvedValue(order) };
    const wallet = buildWallet(8453);
    const action = payOrderAction(gateway, wallet);

    await expect(action.execute(baseCtx, { orderId: order.order_id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

/* ---------------------------------------------------------------- */
/*  getOrder / listOrders sensitive-field redaction                 */
/* ---------------------------------------------------------------- */

describe('goat.giftcard.getOrder redaction', () => {
  it('declares the four card_* sensitiveOutputFields', () => {
    const gateway: Pick<GiftcardGateway, 'getOrder'> = { getOrder: vi.fn() };
    const action = getOrderAction(gateway);
    expect(action.sensitiveOutputFields).toEqual([
      'card_code',
      'card_pin',
      'card_link',
      'card_barcode',
    ]);
  });

  it('flattens card.* up to top level so shallow redaction reaches them; ' +
    'onActionSuccess hook receives [REDACTED] while result.output keeps plaintext', async () => {
    const order = buildOrder({
      status: 'FULFILLED',
      card: {
        card_code: 'AMZN-1234',
        card_pin: '0987',
        card_link: 'https://amazon.com/redeem',
        card_barcode: '0123-4567',
      },
    });
    const gateway: Pick<GiftcardGateway, 'getOrder'> = {
      getOrder: vi.fn().mockResolvedValue(order),
    };
    const action = getOrderAction(gateway);

    const onActionSuccess = vi.fn();
    const policy = new PolicyEngine({
      allowedNetworks: ['goat-testnet'],
      maxRiskWithoutConfirm: 'read',
      writeEnabled: true,
    });
    const runtime = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
      hooks: { onActionSuccess },
    });

    const res = await runtime.run(action, baseCtx, { orderId: order.order_id });
    expect(res.ok).toBe(true);
    expect(res.output?.card_code).toBe('AMZN-1234');
    expect(res.output?.card_pin).toBe('0987');

    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.card_code).toBe('[REDACTED]');
    expect(hookOutput.card_pin).toBe('[REDACTED]');
    expect(hookOutput.card_link).toBe('[REDACTED]');
    expect(hookOutput.card_barcode).toBe('[REDACTED]');
    // Non-sensitive fields are not touched.
    expect(hookOutput.order_id).toBe(order.order_id);
    expect(hookOutput.status).toBe('FULFILLED');
  });
});

describe('goat.giftcard.listOrders redaction', () => {
  it('flattens card.* on every order in the list', async () => {
    const order = buildOrder({
      status: 'FULFILLED',
      card: { card_code: 'AMZN-1234' },
    });
    const gateway: Pick<GiftcardGateway, 'listOrders'> = {
      listOrders: vi.fn().mockResolvedValue({ orders: [order], total: 1 }),
    };
    const action = listOrdersAction(gateway);
    const result = await action.execute(baseCtx, {});
    expect(result.orders[0].card_code).toBe('AMZN-1234');
  });
});

/* ---------------------------------------------------------------- */
/*  ActionProvider integration                                      */
/* ---------------------------------------------------------------- */

describe('giftcard ActionProvider registration', () => {
  it('all 8 actions register without name collisions', () => {
    const gateway: GiftcardGateway = {
      listBrands: vi.fn(),
      getBrand: vi.fn(),
      listCategories: vi.fn(),
      listSupportedTokens: vi.fn(),
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      listOrders: vi.fn(),
    };
    const wallet: Pick<WalletProvider, 'getChainId' | 'transferErc20'> = {
      getChainId: vi.fn().mockResolvedValue(8453),
      transferErc20: vi.fn().mockResolvedValue({ txHash: '0x0' }),
    };
    const provider = new ActionProvider();
    provider.register(listBrandsAction(gateway));
    provider.register(getBrandAction(gateway));
    provider.register(listCategoriesAction(gateway));
    provider.register(listSupportedTokensAction(gateway));
    provider.register(createOrderAction(gateway));
    provider.register(payOrderAction(gateway, wallet));
    provider.register(getOrderAction(gateway));
    provider.register(listOrdersAction(gateway));

    expect(provider.list().map((a) => a.name).sort()).toEqual(
      [
        'goat.giftcard.createOrder',
        'goat.giftcard.getBrand',
        'goat.giftcard.getOrder',
        'goat.giftcard.listBrands',
        'goat.giftcard.listCategories',
        'goat.giftcard.listOrders',
        'goat.giftcard.listSupportedTokens',
        'goat.giftcard.payOrder',
      ].sort(),
    );
  });
});
