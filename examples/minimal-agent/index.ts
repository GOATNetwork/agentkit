import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { GoatAdapter } from '../../networks/goat/adapter';
import { createPaymentAction } from '../../plugins/x402/actions/payment.create';
import { submitSignatureAction } from '../../plugins/x402/actions/payment.submit-signature';
import { paymentStatusAction } from '../../plugins/x402/actions/payment.status';
import { transferPaymentAction } from '../../plugins/x402/actions/payment.transfer';
import { cancelPaymentAction } from '../../plugins/x402/actions/payment.cancel';
import { NoopPayerWalletAdapter } from '../../plugins/x402/adapters/noop-payer-wallet';
import { bridgeDepositAction } from '../../plugins/bitvm2/actions/bridge.deposit';
import { bridgeWithdrawAction } from '../../plugins/bitvm2/actions/bridge.withdraw';
import { bridgeStatusAction } from '../../plugins/bitvm2/actions/bridge.status';
import type { MerchantGatewayAdapter } from '../../plugins/x402/adapters/types';

class MockMerchantGatewayAdapter implements MerchantGatewayAdapter {
  async createPaymentIntent(input: any) {
    return {
      paymentId: `m_order_${Date.now()}`,
      status: 'created' as const,
      calldataSignRequest: {
        domain: { name: 'GoatX402', version: '1', chainId: 2345, verifyingContract: '0x0000000000000000000000000000000000000001' },
        types: {
          Eip3009CallbackData: [
            { name: 'payer', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'orderId', type: 'string' },
          ],
        },
        primaryType: 'Eip3009CallbackData',
        message: { payer: input.to, amount: input.amount, orderId: 'mock-order' },
      },
      payToAddress: '0x000000000000000000000000000000000000bEEF',
      tokenAddress: '0x000000000000000000000000000000000000c0Fe',
      raw: input,
    };
  }
  async getPaymentStatus(paymentId: string) {
    return { paymentId, status: 'created' as const };
  }
  async submitPaymentAuthorization(paymentId: string, _signature: string) {
    return { paymentId, status: 'authorized' as const };
  }
  async cancelPayment(paymentId: string) {
    return { paymentId, status: 'cancelled' as const };
  }
}

async function main() {
  const adapter = new GoatAdapter('goat-testnet');
  try {
    const rpc = await adapter.ping();
    console.log('goat rpc ok:', rpc);
  } catch (err) {
    console.warn('goat rpc unreachable, continue in adapter-stub mode:', err);
  }

  // Agent as payer -> call merchant's wrapped APIs, not goatx402 merchant core directly.
  const merchant = new MockMerchantGatewayAdapter();
  const payer = new NoopPayerWalletAdapter();

  const provider = new ActionProvider();
  provider.register(createPaymentAction(merchant));
  provider.register(submitSignatureAction(merchant, payer));
  provider.register(paymentStatusAction(merchant));
  provider.register(transferPaymentAction(payer));
  provider.register(cancelPaymentAction(merchant));
  provider.register(bridgeDepositAction(adapter));
  provider.register(bridgeWithdrawAction(adapter));
  provider.register(bridgeStatusAction(adapter));

  const policy = new PolicyEngine({
    allowedNetworks: ['goat-testnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });

  const runtime = new ExecutionRuntime(policy, { maxRetries: 2, retryDelayMs: 150 });

  const context = {
    traceId: 'trace_demo_001',
    network: 'goat-testnet',
    now: Date.now(),
    caller: 'demo-agent',
  };

  const create = await runtime.run(
    provider.get('goat.x402.payment.create'),
    context,
    { to: '0xabc', asset: 'USDC', amount: '10' },
    { confirmed: true, idempotencyKey: 'demo-create-001' }
  );

  if (!create.ok || !create.output) {
    console.error('Create payment failed:', create.error);
    return;
  }

  const submitSignature = await runtime.run(
    provider.get('goat.x402.payment.submitSignature'),
    context,
    {
      paymentId: create.output.paymentId,
      calldataSignRequest: create.output.calldataSignRequest,
    },
    { confirmed: true }
  );

  const transfer = await runtime.run(
    provider.get('goat.x402.payment.transfer'),
    context,
    {
      tokenAddress: create.output.tokenAddress ?? '0x000000000000000000000000000000000000c0Fe',
      to: create.output.payToAddress ?? '0x000000000000000000000000000000000000bEEF',
      amount: '10',
    },
    { confirmed: true }
  );

  const status = await runtime.run(
    provider.get('goat.x402.payment.status'),
    context,
    { paymentId: create.output.paymentId }
  );

  const cancel = await runtime.run(
    provider.get('goat.x402.payment.cancel'),
    context,
    { paymentId: create.output.paymentId },
    { confirmed: true }
  );

  console.log({ create, submitSignature, transfer, status, cancel });
}

main().catch(console.error);
