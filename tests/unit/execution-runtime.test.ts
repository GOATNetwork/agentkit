import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { InMemoryRuntimeMetrics } from '../../core/metrics/metrics';
import { InMemoryIdempotencyStore } from '../../core/runtime/idempotency/store';
import type { ActionDefinition, ActionContext } from '../../core/schema/action';
import { z } from 'zod';

const silentLogger = { log: () => {} };

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: 'test.action',
    description: 'test',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    zodInputSchema: z.object({ value: z.string() }),
    async execute(_ctx, input: any) {
      return { echo: input.value };
    },
    ...overrides,
  };
}

const ctx: ActionContext = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

function makePolicy() {
  return new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true });
}

describe('ExecutionRuntime', () => {
  let metrics: InMemoryRuntimeMetrics;
  let store: InMemoryIdempotencyStore;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    metrics = new InMemoryRuntimeMetrics();
    store = new InMemoryIdempotencyStore();
    runtime = new ExecutionRuntime(makePolicy(), {
      maxRetries: 1,
      retryDelayMs: 10,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
      idempotencyStore: store,
    });
  });

  it('succeeds on valid input', async () => {
    const result = await runtime.run(makeAction(), ctx, { value: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echo: 'hello' });
    expect(result.attempts).toBe(1);
  });

  it('returns INVALID_INPUT on schema failure', async () => {
    const result = await runtime.run(makeAction(), ctx, { value: 123 });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_INPUT');
  });

  it('returns POLICY_BLOCKED on wrong network', async () => {
    const result = await runtime.run(makeAction(), { ...ctx, network: 'ethereum' }, { value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('POLICY_BLOCKED');
  });

  it('retries on failure then succeeds', async () => {
    let calls = 0;
    const action = makeAction({
      async execute(_ctx, input: any) {
        calls++;
        if (calls === 1) throw new Error('transient');
        return { echo: input.value };
      },
    });
    const result = await runtime.run(action, ctx, { value: 'retry' });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('exhausts retries', async () => {
    const action = makeAction({
      async execute() {
        throw new Error('always fails');
      },
    });
    const result = await runtime.run(action, ctx, { value: 'fail' });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2); // 1 initial + 1 retry
  });

  it('uses idempotency cache on hit', async () => {
    let calls = 0;
    const action = makeAction({
      async execute(_ctx, input: any) {
        calls++;
        return { echo: input.value };
      },
    });
    const opts = { idempotencyKey: 'key1' };

    const r1 = await runtime.run(action, ctx, { value: 'a' }, opts);
    expect(r1.ok).toBe(true);
    expect(calls).toBe(1);

    const r2 = await runtime.run(action, ctx, { value: 'a' }, opts);
    expect(r2.ok).toBe(true);
    expect(r2.output).toEqual({ echo: 'a' });
    expect(calls).toBe(1); // handler not called again
  });

  it('returns IDEMPOTENCY_CONFLICT on concurrent acquire', async () => {
    // Manually acquire the lock first
    await store.acquire('test.action:dup_key');

    const action = makeAction();
    const result = await runtime.run(action, ctx, { value: 'x' }, { idempotencyKey: 'dup_key' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('records metrics on success', async () => {
    await runtime.run(makeAction(), ctx, { value: 'x' });
    const successKey = Array.from(metrics.counters.keys()).find((k) => k.includes('runtime.success'));
    expect(successKey).toBeDefined();
    expect(metrics.counters.get(successKey!)).toBe(1);
  });

  it('records metrics on error', async () => {
    await runtime.run(makeAction(), ctx, { value: 123 }); // schema error
    const errorKey = Array.from(metrics.counters.keys()).find((k) => k.includes('runtime.error'));
    expect(errorKey).toBeDefined();
  });

  it('skips retries for high-risk write actions when noRetryHighRiskWrites is true', async () => {
    const strictRuntime = new ExecutionRuntime(makePolicy(), {
      maxRetries: 3,
      retryDelayMs: 10,
      noRetryHighRiskWrites: true,
      logger: silentLogger,
      metrics,
    });

    let calls = 0;
    const action = makeAction({
      riskLevel: 'high',
      requiresConfirmation: false,
      async execute() {
        calls++;
        throw new Error('fail');
      },
    });

    const result = await strictRuntime.run(action, ctx, { value: 'x' }, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1); // no retries
    expect(result.attempts).toBe(1);
  });

  it('blocks action when action.networks does not include context.network', async () => {
    const action = makeAction({ networks: ['goat-mainnet'] });
    const result = await runtime.run(action, ctx, { value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('POLICY_BLOCKED');
    expect(result.error).toContain('does not support network');
  });

  it('validates output schema when zodOutputSchema is provided', async () => {
    const action = makeAction({
      zodOutputSchema: z.object({ echo: z.number() }), // expects number but handler returns string
      async execute(_ctx, input: any) {
        return { echo: input.value }; // returns string
      },
    });
    const result = await runtime.run(action, ctx, { value: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_OUTPUT');
  });

  it('validates output schema via JSON Schema fallback when zodOutputSchema is absent', async () => {
    const action = makeAction({
      outputSchema: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'number' } },
      },
      async execute() {
        return { count: 'not-a-number' }; // wrong type
      },
    });
    const result = await runtime.run(action, ctx, { value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_OUTPUT');
  });

  it('releases idempotency lock on execution failure, allowing retry with same key', async () => {
    let runCount = 0;
    const action = makeAction({
      async execute(_ctx, input: any) {
        runCount++;
        // Fail on run 1 (both attempts), succeed on run 2
        if (runCount <= 2) throw new Error('fail');
        return { echo: input.value };
      },
    });

    // First run: fails all retries, should release the lock
    const r1 = await runtime.run(action, ctx, { value: 'x' }, { idempotencyKey: 'retry_key' });
    expect(r1.ok).toBe(false);
    expect(runCount).toBe(2); // 1 initial + 1 retry

    // Second run with same key: should NOT get IDEMPOTENCY_CONFLICT
    const r2 = await runtime.run(action, ctx, { value: 'x' }, { idempotencyKey: 'retry_key' });
    expect(r2.ok).toBe(true);
    expect(r2.output).toEqual({ echo: 'x' });
  });

  it('idempotency cache hit works for falsy output values (false, 0, empty string)', async () => {
    let calls = 0;
    const action = makeAction({
      zodInputSchema: z.object({ value: z.string() }),
      async execute() {
        calls++;
        return 0 as any; // falsy but valid output
      },
    });

    const r1 = await runtime.run(action, ctx, { value: 'a' }, { idempotencyKey: 'falsy_key' });
    expect(r1.ok).toBe(true);
    expect(r1.output).toBe(0);
    expect(calls).toBe(1);

    const r2 = await runtime.run(action, ctx, { value: 'a' }, { idempotencyKey: 'falsy_key' });
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe(0);
    expect(calls).toBe(1); // not called again
  });

  it('idempotency cache hit works for null output', async () => {
    let calls = 0;
    const action = makeAction({
      validateOutput: false,
      async execute() {
        calls++;
        return null as any;
      },
    });

    const r1 = await runtime.run(action, ctx, { value: 'a' }, { idempotencyKey: 'null_key' });
    expect(r1.ok).toBe(true);
    expect(r1.output).toBeNull();
    expect(calls).toBe(1);

    const r2 = await runtime.run(action, ctx, { value: 'a' }, { idempotencyKey: 'null_key' });
    expect(r2.ok).toBe(true);
    expect(r2.output).toBeNull();
    expect(calls).toBe(1); // not called again, no IDEMPOTENCY_CONFLICT
  });
});
