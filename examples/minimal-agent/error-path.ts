import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { transferPaymentAction } from '../../plugins/x402/actions/payment.transfer';
import { NoopPayerWalletAdapter } from '../../plugins/x402/adapters/noop-payer-wallet';

async function main() {
  const payer = new NoopPayerWalletAdapter();

  const provider = new ActionProvider();
  provider.register(transferPaymentAction(payer));

  const policy = new PolicyEngine({
    allowedNetworks: ['goat-testnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });

  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 50 });

  const context = {
    traceId: 'trace_error_001',
    network: 'goat-testnet',
    now: Date.now(),
    caller: 'demo-agent',
  };

  // intentionally invalid: amount should be digits only
  const result = await runtime.run(
    provider.get('goat.x402.payment.transfer'),
    context,
    {
      tokenAddress: '0x000000000000000000000000000000000000c0Fe',
      to: '0x000000000000000000000000000000000000bEEF',
      amount: '10.5',
    },
    { confirmed: true }
  );

  console.log('error-path result:', result);
}

main().catch(console.error);
