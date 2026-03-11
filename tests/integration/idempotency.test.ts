import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import type { ActionDefinition } from '../../core/schema/action';

let counter = 0;

const action: ActionDefinition<{ v: string }, { result: string }> = {
  name: 'test.idempotent',
  description: 'idempotent action',
  riskLevel: 'low',
  requiresConfirmation: false,
  networks: ['goat-testnet'],
  inputSchema: {
    type: 'object',
    required: ['v'],
    properties: { v: { type: 'string' } },
  },
  outputSchema: {},
  async execute(_ctx, input) {
    counter += 1;
    return { result: `${input.v}-${counter}` };
  },
};

describe('idempotency store', () => {
  it('returns cached result when idempotencyKey is same', async () => {
    counter = 0;
    const policy = new PolicyEngine({
      allowedNetworks: ['goat-testnet'],
      maxRiskWithoutConfirm: 'low',
      writeEnabled: true,
    });

    const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 1 });
    const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

    const r1 = await runtime.run(action, ctx, { v: 'x' }, { idempotencyKey: 'k1', confirmed: true });
    const r2 = await runtime.run(action, ctx, { v: 'x' }, { idempotencyKey: 'k1', confirmed: true });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.output?.result).toBe(r2.output?.result);
  });
});
