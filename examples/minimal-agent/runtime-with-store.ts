import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { createIdempotencyStoreFromEnv } from '../../core/runtime/idempotency/factory';

const { store, mode } = createIdempotencyStoreFromEnv();

const policy = new PolicyEngine({
  allowedNetworks: ['goat-testnet'],
  maxRiskWithoutConfirm: 'low',
  writeEnabled: true,
});

const runtime = new ExecutionRuntime(policy, {
  idempotencyStore: store,
  maxRetries: 0,
  retryDelayMs: 10,
});

console.log('runtime initialized with idempotency mode:', mode, Boolean(runtime));
