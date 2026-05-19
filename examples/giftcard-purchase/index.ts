/**
 * examples/giftcard-purchase — full lifecycle of a giftcard purchase.
 *
 *   1. listBrands / getBrand / listSupportedTokens  (read)
 *   2. createOrder                                  (medium, confirm)
 *   3. payOrder                                     (high, confirm)
 *   4. poll getOrder until FULFILLED                (read; secrets hidden)
 *   5. agentkit.print-secret { value: card_code }   (low; stdout once)
 *
 * Wallet requirements
 * -------------------
 * This example needs a REAL signer for `createOrder` (EIP-712 auth
 * signature) and `payOrder` (ERC-20 transfer). With the default
 * `NoopWalletProvider` it dry-runs the read steps only; attempting the
 * write steps without `DEMO_MOCK=true` will refuse to start. Pass:
 *
 *   DEMO_MOCK=true pnpm example:giftcard-purchase
 *
 * to walk the whole flow against mocked gateway responses. In
 * production, wire `EvmWalletProvider` (or `ViemWalletProvider`) and
 * point `GIFTCARD_API_BASE_URL` at https://giftcard-api.goat.network.
 *
 * Env vars: GIFTCARD_API_BASE_URL, GIFTCARD_AUTH_DOMAIN_*.
 */

import { randomUUID } from 'node:crypto';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import { printSecretAction } from '../../core/actions/print-secret';
import {
  createOrderAction,
  getBrandAction,
  getOrderAction,
  HttpGiftcardGatewayAdapter,
  Eip712AuthSigner,
  listBrandsAction,
  listSupportedTokensAction,
  payOrderAction,
} from '../../plugins/giftcard/index';
import type {
  GiftcardGateway,
  OrderRecord,
} from '../../plugins/giftcard/index';
import type { ActionContext } from '../../core/schema/action';

const DEMO_MOCK = process.env.DEMO_MOCK === 'true';

if (!DEMO_MOCK) {
  // The example uses NoopWalletProvider by default for portability —
  // the real-signer path requires the operator to wire in their own
  // EvmWalletProvider / ViemWalletProvider. We loudly refuse instead
  // of silently producing a mock signature.
  console.error(
    'examples/giftcard-purchase requires a real wallet (signTypedData + transferErc20).\n' +
      'Re-run with DEMO_MOCK=true to dry-run against in-process mocked gateway responses.',
  );
  process.exit(2);
}

// --- A tiny in-process gateway mock for the dry-run path. ----------
// In production this is replaced by `new HttpGiftcardGatewayAdapter({
// baseUrl: process.env.GIFTCARD_API_BASE_URL,
// authSigner: new Eip712AuthSigner(wallet) })`.
class MockGateway implements GiftcardGateway {
  private orderState: OrderRecord | null = null;
  private pollCount = 0;

  async listBrands() {
    return [
      {
        id: '11111111-1111-1111-1111-111111111111',
        country: 'US',
        category_id: 'shopping',
        name: 'Amazon',
        description: 'Online retailer',
        logo_url: 'https://example.com/amazon.png',
        product_count: 1,
      },
    ];
  }
  async getBrand() {
    return {
      brand: {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Amazon',
        description: 'Online retailer',
        logo_url: 'https://example.com/amazon.png',
        country: 'US' as const,
        currency_local: 'USD',
      },
      products: [
        {
          product_id: '22222222-2222-2222-2222-222222222222',
          name: 'Amazon US — Variable',
          face_value_type: 'VARIABLE' as const,
          face_value_min: 5,
          face_value_max: 2000,
          currency_local: 'USD',
          sell_markup_pct: 5,
        },
      ],
    };
  }
  async listCategories() {
    return [{ id: 'shopping', name: 'Shopping' }];
  }
  async listSupportedTokens() {
    return {
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
  }
  async createOrder(input: import('../../plugins/giftcard/index').GiftcardCreateOrderInput) {
    const order: OrderRecord = {
      order_id: '33333333-3333-3333-3333-333333333333',
      status: 'PAYMENT_PENDING',
      product_id: input.product_id,
      card_brand_name: 'Amazon',
      country: 'US',
      face_value: input.face_value,
      face_value_type: 'VARIABLE',
      sell_price_usd: input.face_value * 1.05,
      pay_amount_wei: String(Math.round(input.face_value * 1.05 * 1_000_000)),
      pay_chain_id: input.pay_chain_id,
      pay_token_symbol: input.pay_token_symbol,
      pay_token_contract: '0x0000000000000000000000000000000000c0FFee',
      pay_to_address: '0x000000000000000000000000000000000000bEEF',
      expire_at: Math.floor(Date.now() / 1000) + 30 * 60,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.orderState = order;
    return order;
  }
  async getOrder(): Promise<OrderRecord> {
    if (!this.orderState) {
      throw new Error('mock: no order created yet');
    }
    this.pollCount += 1;
    if (this.pollCount >= 3) {
      this.orderState = {
        ...this.orderState,
        status: 'FULFILLED',
        card: {
          card_code: 'AMZN-DEMO-CARD-CODE',
          card_link: 'https://amazon.com/redeem/demo',
        },
      };
    } else if (this.pollCount === 2) {
      this.orderState = { ...this.orderState, status: 'PAYMENT_CONFIRMED' };
    }
    return this.orderState;
  }
  async listOrders() {
    return { orders: this.orderState ? [this.orderState] : [], total: this.orderState ? 1 : 0 };
  }
}

async function main(): Promise<void> {
  const wallet = new NoopWalletProvider('0x39573c77e3c8d96e1c2d8da7f8d1d4e2d8d4d192', {
    networkName: 'base-mainnet',
    chainId: 8453,
  });
  const authSigner = new Eip712AuthSigner(wallet);
  const gateway: GiftcardGateway = DEMO_MOCK
    ? new MockGateway()
    : new HttpGiftcardGatewayAdapter({
        baseUrl: process.env.GIFTCARD_API_BASE_URL,
        authSigner,
      });

  const provider = new ActionProvider();
  provider.register(listBrandsAction(gateway));
  provider.register(getBrandAction(gateway));
  provider.register(listSupportedTokensAction(gateway));
  provider.register(createOrderAction(gateway));
  provider.register(payOrderAction(gateway, wallet));
  provider.register(getOrderAction(gateway));
  provider.register(printSecretAction());

  const policy = new PolicyEngine({
    allowedNetworks: ['base-mainnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const baseCtx: ActionContext = {
    traceId: `trace_${randomUUID()}`,
    network: 'base-mainnet',
    now: Date.now(),
  };

  // 1. Browse
  const brands = await runtime.run(provider.get('goat.giftcard.listBrands'), baseCtx, {
    country: 'US',
    category: 'shopping',
  });
  console.log('brands:', brands.output);

  const brand = await runtime.run(provider.get('goat.giftcard.getBrand'), baseCtx, {
    brand_id: '11111111-1111-1111-1111-111111111111',
    lang: 'en',
  });
  console.log('brand:', brand.output);

  const tokens = await runtime.run(provider.get('goat.giftcard.listSupportedTokens'), baseCtx, {});
  console.log('tokens:', tokens.output);

  // 2. Create order — idempotency_key threaded through both action input AND runtime options.
  const purchaseKey = randomUUID();
  const createRes = await runtime.run(
    provider.get('goat.giftcard.createOrder'),
    baseCtx,
    {
      product_id: '22222222-2222-2222-2222-222222222222',
      face_value: 50,
      pay_chain_id: 8453,
      pay_token_symbol: 'USDC' as const,
      idempotency_key: purchaseKey,
    },
    { confirmed: true, idempotencyKey: purchaseKey },
  );
  if (!createRes.ok || !createRes.output) {
    console.error('createOrder failed:', createRes.error);
    process.exit(1);
  }
  const orderId = createRes.output.order_id;
  console.log('order created:', orderId);

  // 3. Pay
  const payRes = await runtime.run(
    provider.get('goat.giftcard.payOrder'),
    baseCtx,
    { orderId },
    { confirmed: true },
  );
  if (!payRes.ok) {
    console.error('payOrder failed:', payRes.error);
    process.exit(1);
  }
  console.log('paid, tx:', payRes.output?.txHash);

  // 4. Poll
  let fulfilled: typeof createRes.output | undefined;
  for (let i = 0; i < 30; i += 1) {
    const orderRes = await runtime.run(provider.get('goat.giftcard.getOrder'), baseCtx, {
      orderId,
    });
    if (orderRes.ok && orderRes.output?.status === 'FULFILLED') {
      fulfilled = orderRes.output;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!fulfilled) {
    console.error('order not fulfilled within 30s');
    process.exit(1);
  }

  // 5. Print the card code via the dedicated action.
  if (fulfilled.card_code) {
    await runtime.run(
      provider.get('agentkit.print-secret'),
      baseCtx,
      { value: fulfilled.card_code, label: 'card_code' },
      { revealedFields: ['value'] },
    );
  }
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
