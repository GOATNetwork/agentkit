import { describe, expect, it } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import type { ActionDefinition } from '../../core/schema/action';

let count = 0;
const action: ActionDefinition<{ v: string }, { out: string }> = {
  name: 'test.idempotent',
  description: 'idempotent test',
  riskLevel: 'low',
  requiresConfirmation: false,
  networks: ['goat-testnet'],
  zodInputSchema: undefined,
  inputSchema: {
    type: 'object',
    required: ['v'],
    properties: { v: { type: 'string' } },
  },
  async execute(_ctx, input) {
    count += 1;
    return { out: `${input.v}-${count}` };
  },
};

describe('runtime idempotency', () => {
  it('returns cached output on same idempotency key', async () => {
    count = 0;
    const runtime = new ExecutionRuntime(
      new PolicyEngine({
        allowedNetworks: ['goat-testnet'],
        maxRiskWithoutConfirm: 'low',
        writeEnabled: true,
      })
    );

    const ctx = { traceId: 't', network: 'goat-testnet', now: Date.now() };

    const r1 = await runtime.run(action, ctx, { v: 'x' }, { idempotencyKey: 'k1' });
    const r2 = await runtime.run(action, ctx, { v: 'x' }, { idempotencyKey: 'k1' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.output).toEqual(r2.output);
    expect(count).toBe(1);
  });
});
