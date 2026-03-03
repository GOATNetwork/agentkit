import { createServer } from 'node:http';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { InMemoryRuntimeMetrics } from '../../core/metrics/metrics';
import { renderPrometheus } from '../../core/metrics/prometheus';
import { walletBalanceAction } from '../../plugins/wallet/actions/balance';
import { NoopWalletReadAdapter } from '../../plugins/wallet/adapters/types';

const metrics = new InMemoryRuntimeMetrics();

const policy = new PolicyEngine({
  allowedNetworks: ['goat-testnet'],
  maxRiskWithoutConfirm: 'low',
  writeEnabled: true,
});

const runtime = new ExecutionRuntime(policy, {
  metrics,
  maxRetries: 0,
  retryDelayMs: 10,
});

const action = walletBalanceAction(new NoopWalletReadAdapter());

async function seedMetrics() {
  await runtime.run(
    action,
    { traceId: 'm1', network: 'goat-testnet', now: Date.now() },
    { address: '0x000000000000000000000000000000000000dEaD' }
  );
}

const port = Number(process.env.AGENTKIT_METRICS_PORT ?? 9464);

createServer(async (req, res) => {
  if (req.url === '/metrics') {
    await seedMetrics();
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(renderPrometheus(metrics));
    return;
  }

  res.statusCode = 404;
  res.end('not found');
}).listen(port, () => {
  console.log(`metrics endpoint running at http://127.0.0.1:${port}/metrics`);
});
