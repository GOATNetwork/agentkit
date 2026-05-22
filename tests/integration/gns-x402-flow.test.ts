import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { x402CreateOrderAction } from '../../plugins/gns/actions/x402-create-order';
import { x402SubmitSignatureAction } from '../../plugins/gns/actions/x402-submit-signature';
import { x402PayOrderAction } from '../../plugins/gns/actions/x402-pay-order';
import { x402GetOrderStatusAction } from '../../plugins/gns/actions/x402-get-order-status';
import type { GnsApiAdapter, X402OrderResponse, X402OrderStatusResponse } from '../../plugins/gns/adapters/types';
import type { PayerWalletAdapter } from '../../plugins/x402/adapters/types';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'gns-x402-register-order.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as X402OrderResponse;

// ─────────────────────────────────────────────────────────────────────────────
// Typed stubs (no `any`).
// ─────────────────────────────────────────────────────────────────────────────

const NOT_USED = (name: string) => () => {
  throw new Error(`StubApi.${name} not used in this test`);
};

class StubApi implements GnsApiAdapter {
  submitOutcome: 'authorized' | 'failed' = 'authorized';
  /**
   * Lifecycle starts at PAYMENT_PENDING (so the payOrder action's
   * status gate accepts it). Test code that needs to simulate a
   * later state can mutate this — and the StubPayer's
   * `transferToken` mock below flips it to PAYMENT_CONFIRMED so the
   * subsequent getOrderStatus call in the happy path returns the
   * expected post-pay value.
   */
  orderStatus: X402OrderStatusResponse['status'] = 'PAYMENT_PENDING';
  search = NOT_USED('search') as GnsApiAdapter['search'];
  details = NOT_USED('details') as GnsApiAdapter['details'];
  quote = NOT_USED('quote') as GnsApiAdapter['quote'];
  myNames = NOT_USED('myNames') as GnsApiAdapter['myNames'];
  x402Config = NOT_USED('x402Config') as GnsApiAdapter['x402Config'];
  async createX402Order(): Promise<X402OrderResponse> {
    return fixture;
  }
  async getX402Order(orderId: string): Promise<X402OrderStatusResponse> {
    return {
      orderId,
      status: this.orderStatus,
      txHash: this.orderStatus === 'PAYMENT_CONFIRMED' ? '0xpayment_tx' : undefined,
      confirmedAt:
        this.orderStatus === 'PAYMENT_CONFIRMED' ? Math.floor(Date.now() / 1000) : undefined,
      raw: fixture,
    };
  }
  async submitX402Signature() {
    return { status: this.submitOutcome };
  }
}

class StubPayer implements PayerWalletAdapter {
  signed = '';
  transferred: { tokenAddress: string; to: string; amount: string } | null = null;
  /** Set by `buildRuntime` so transferToken can flip the order lifecycle. */
  api?: StubApi;
  async normalizeAuthorization(s: string) {
    return s;
  }
  async signCalldataTypedData(): Promise<string> {
    this.signed = '0xstubsignature';
    return this.signed;
  }
  async transferToken(input: { tokenAddress: string; to: string; amount: string }) {
    this.transferred = input;
    if (this.api) this.api.orderStatus = 'PAYMENT_CONFIRMED';
    return { txHash: '0xstub_transfer_tx' };
  }
}

function makeSourceWallet(chainId: number): WalletProvider {
  return {
    async getAddress() {
      return '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0';
    },
    async getNetwork() {
      return 'base-mainnet';
    },
    async getChainId() {
      return chainId;
    },
    async getBalance() {
      return '0';
    },
    async getErc20Balance() {
      return '0';
    },
    async transferNative() {
      return { txHash: '0xn' };
    },
    async transferErc20() {
      return { txHash: '0xe' };
    },
    async approveErc20() {
      return { txHash: '0xa' };
    },
    async signTypedData() {
      return '0xs';
    },
    async callContract() {
      return '0x';
    },
    async writeContract() {
      return { txHash: '0xw' };
    },
    async deployContract() {
      throw new Error('not used');
    },
  };
}

function buildRuntime(api: GnsApiAdapter, payer: PayerWalletAdapter, wallet: WalletProvider) {
  if (api instanceof StubApi && payer instanceof StubPayer) {
    // Connect payer → api so `transferToken` flips the order lifecycle
    // and subsequent getOrderStatus returns PAYMENT_CONFIRMED.
    payer.api = api;
  }
  const provider = new ActionProvider();
  provider.register(x402CreateOrderAction(api));
  provider.register(x402SubmitSignatureAction(api, payer));
  provider.register(x402PayOrderAction(api, payer, wallet));
  provider.register(x402GetOrderStatusAction(api));
  const policy = new PolicyEngine({
    // x402 actions declare wildcard networks; the runtime context's network
    // just needs to be in the policy allowlist.
    allowedNetworks: ['goat-testnet', 'base-mainnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const context = { traceId: 'trace_gns_x402', network: 'base-mainnet', now: Date.now() };
  return { provider, runtime, context };
}

describe('gns x402 cross-chain flow (fixture-backed)', () => {
  it('createOrder → submitSignature → payOrder → getOrderStatus', async () => {
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);

    const created = await runtime.run(provider.get('goat.gns.x402.createOrder'), context, {
      name: 'alice',
      owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
      payer: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
      years: 1,
      settlementChainId: fixture.payChainId,
      settlementTokenSymbol: fixture.tokenSymbol,
      settlementTokenContract: fixture.tokenContract,
      secret: '0x' + '11'.repeat(32),
    }, { confirmed: true });
    expect(created.ok).toBe(true);
    expect(created.output!.orderId).toBe(fixture.orderId);
    expect(created.output!.calldataSignRequest.primaryType).toBe('Eip3009CallbackData');

    const signed = await runtime.run(provider.get('goat.gns.x402.submitSignature'), context, {
      orderId: created.output!.orderId,
      calldataSignRequest: created.output!.calldataSignRequest,
    }, { confirmed: true });
    expect(signed.ok).toBe(true);
    expect(signed.output!.status).toBe('authorized');
    expect(payer.signed).toBe('0xstubsignature');

    const paid = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, {
      orderId: created.output!.orderId,
    }, { confirmed: true });
    expect(paid.ok).toBe(true);
    expect(paid.output!.txHash).toBe('0xstub_transfer_tx');
    expect(payer.transferred).toEqual({
      tokenAddress: fixture.tokenContract,
      to: fixture.payToAddress,
      amount: fixture.amountWei,
    });

    const status = await runtime.run(provider.get('goat.gns.x402.getOrderStatus'), context, {
      orderId: created.output!.orderId,
    });
    expect(status.ok).toBe(true);
    expect(status.output!.status).toBe('PAYMENT_CONFIRMED');
  });

  it('payOrder rejects when wallet is on the wrong source chain', async () => {
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(1); // wrong chainId
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, {
      orderId: fixture.orderId,
    }, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/chain_mismatch/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder refuses to double-pay an already-confirmed order (status gate)', async () => {
    const api = new StubApi();
    api.orderStatus = 'PAYMENT_CONFIRMED';
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, {
      orderId: fixture.orderId,
    }, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_not_payable/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when order status is missing/empty (no truthy-gate bypass)', async () => {
    // Regression: `X402OrderLifecycle` widens to `string`, so an empty
    // status is type-valid. The previous `if (order.status && …)` gate
    // let it slip through and re-broadcast the transfer (double-pay).
    const api = new StubApi();
    api.orderStatus = '' as X402OrderStatusResponse['status'];
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, {
      orderId: fixture.orderId,
    }, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_not_payable/);
    expect(payer.transferred).toBeNull();
  });

  it('submitSignature surfaces ADAPTER_REQUEST_FAILED when gateway reports failed', async () => {
    const api = new StubApi();
    api.submitOutcome = 'failed';
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.submitSignature'), context, {
      orderId: fixture.orderId,
      calldataSignRequest: fixture.calldataSignRequest,
    }, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
  });
});
