import { describe, expect, it } from 'vitest';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { createPaymentAction } from '../../plugins/x402/actions/payment.create';
import { submitSignatureAction } from '../../plugins/x402/actions/payment.submit-signature';
import { transferPaymentAction } from '../../plugins/x402/actions/payment.transfer';
import { paymentStatusAction } from '../../plugins/x402/actions/payment.status';
import { cancelPaymentAction } from '../../plugins/x402/actions/payment.cancel';
import { NoopPayerWalletAdapter } from '../../plugins/x402/adapters/noop-payer-wallet';
import type { MerchantGatewayAdapter } from '../../plugins/x402/adapters/types';

class MockMerchant implements MerchantGatewayAdapter {
  async createPaymentIntent(input: any) {
    return {
      paymentId: 'order_1',
      status: 'created' as const,
      payToAddress: '0x000000000000000000000000000000000000bEEF',
      tokenAddress: '0x000000000000000000000000000000000000c0Fe',
      calldataSignRequest: {
        domain: { name: 'GoatX402', version: '1', chainId: 2345, verifyingContract: '0x0000000000000000000000000000000000000001' },
        types: { Eip3009CallbackData: [{ name: 'payer', type: 'address' }] },
        primaryType: 'Eip3009CallbackData',
        message: { payer: input.to },
      },
    };
  }
  async getPaymentStatus(paymentId: string) {
    return { paymentId, status: 'created' as const };
  }
  async submitPaymentAuthorization(paymentId: string) {
    return { paymentId, status: 'authorized' as const };
  }
  async cancelPayment(paymentId: string) {
    return { paymentId, status: 'cancelled' as const };
  }
}

function buildRuntime() {
  const merchant = new MockMerchant();
  const payer = new NoopPayerWalletAdapter();

  const provider = new ActionProvider();
  provider.register(createPaymentAction(merchant));
  provider.register(submitSignatureAction(merchant, payer));
  provider.register(transferPaymentAction(payer));
  provider.register(paymentStatusAction(merchant));
  provider.register(cancelPaymentAction(merchant));

  const policy = new PolicyEngine({
    allowedNetworks: ['goat-testnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });

  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const context = {
    traceId: 'trace_test_001',
    network: 'goat-testnet',
    now: Date.now(),
    caller: 'test',
  };

  return { runtime, provider, context };
}

describe('x402 integration flow', () => {
  it('create', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.create'), context, {
      to: '0x000000000000000000000000000000000000bEEF',
      asset: 'USDC',
      amount: '10',
    }, { confirmed: true });

    expect(res.ok).toBe(true);
    expect(res.output?.paymentId).toBe('order_1');
  });

  it('submitSignature', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.submitSignature'), context, {
      paymentId: 'order_1',
      signature: 'sig:0xabc123',
    }, { confirmed: true });

    expect(res.ok).toBe(true);
    expect(res.output?.status).toBe('authorized');
  });

  it('transfer', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.transfer'), context, {
      tokenAddress: '0x000000000000000000000000000000000000c0Fe',
      to: '0x000000000000000000000000000000000000bEEF',
      amount: '10',
    }, { confirmed: true });

    expect(res.ok).toBe(true);
    expect(res.output?.txHash).toMatch(/^0xmocktx/);
  });

  it('status', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.status'), context, {
      paymentId: 'order_1',
    });

    expect(res.ok).toBe(true);
    expect(res.output?.status).toBe('created');
  });

  it('cancel', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.cancel'), context, {
      paymentId: 'order_1',
    }, { confirmed: true });

    expect(res.ok).toBe(true);
    expect(res.output?.status).toBe('cancelled');
  });

  it('invalid input returns INVALID_INPUT', async () => {
    const { runtime, provider, context } = buildRuntime();
    const res = await runtime.run(provider.get('goat.x402.payment.transfer'), context, {
      tokenAddress: '0x000000000000000000000000000000000000c0Fe',
      to: '0x000000000000000000000000000000000000bEEF',
      amount: '10.5',
    }, { confirmed: true });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
  });
});
