import { describe, it, expect } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import { InMemoryIdempotencyStore } from '../../core/runtime/idempotency/store';
import type { ActionContext, ActionDefinition } from '../../core/schema/action';

const silentLogger = { log: () => {} };

function makeRuntime() {
  const policy = new PolicyEngine({
    allowedNetworks: ['goat-testnet'],
    maxRiskWithoutConfirm: 'high',
    writeEnabled: true,
  });
  return new ExecutionRuntime(policy, {
    maxRetries: 0,
    retryDelayMs: 1,
    noRetryHighRiskWrites: false,
    logger: silentLogger,
    metrics: new NoopRuntimeMetrics(),
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
}

const ctx: ActionContext = { traceId: 'trace-1', network: 'goat-testnet', now: Date.now() };

describe('ActionContext.idempotencyKey propagation', () => {
  it('populates ctx.idempotencyKey from ExecutionOptions.idempotencyKey', async () => {
    let captured: string | undefined = 'sentinel';
    const action: ActionDefinition<unknown, { ok: true }> = {
      name: 'test.capture-key',
      description: 'capture ctx.idempotencyKey',
      riskLevel: 'read',
      requiresConfirmation: false,
      networks: ['goat-testnet'],
      async execute(actionCtx) {
        captured = actionCtx.idempotencyKey;
        return { ok: true };
      },
    };

    const runtime = makeRuntime();
    const result = await runtime.run(action, ctx, {}, { idempotencyKey: 'key-1' });

    expect(result.ok).toBe(true);
    expect(captured).toBe('key-1');
  });

  it('leaves ctx.idempotencyKey undefined when option is omitted', async () => {
    let captured: string | undefined = 'sentinel';
    const action: ActionDefinition<unknown, { ok: true }> = {
      name: 'test.capture-key',
      description: 'capture ctx.idempotencyKey',
      riskLevel: 'read',
      requiresConfirmation: false,
      networks: ['goat-testnet'],
      async execute(actionCtx) {
        captured = actionCtx.idempotencyKey;
        return { ok: true };
      },
    };

    const runtime = makeRuntime();
    const result = await runtime.run(action, ctx, {});

    expect(result.ok).toBe(true);
    expect(captured).toBeUndefined();
  });
});
