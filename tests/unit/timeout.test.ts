import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { InMemoryRuntimeMetrics } from '../../core/metrics/metrics';
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

describe('Timeout execution', () => {
  let metrics: InMemoryRuntimeMetrics;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    metrics = new InMemoryRuntimeMetrics();
    runtime = new ExecutionRuntime(makePolicy(), {
      maxRetries: 0,
      retryDelayMs: 10,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
    });
  });

  it('returns TIMEOUT when action exceeds timeoutMs', async () => {
    const action = makeAction({
      async execute() {
        await new Promise((r) => setTimeout(r, 500));
        return { echo: 'late' };
      },
    });

    const result = await runtime.run(action, ctx, { value: 'x' }, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TIMEOUT');
    expect(result.error).toContain('timed out');
  });

  it('succeeds when action completes within timeoutMs', async () => {
    const action = makeAction({
      async execute(_ctx, input: any) {
        return { echo: input.value };
      },
    });

    const result = await runtime.run(action, ctx, { value: 'fast' }, { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echo: 'fast' });
  });

  it('uses defaultTimeoutMs from config', async () => {
    const rtWithDefault = new ExecutionRuntime(makePolicy(), {
      maxRetries: 0,
      retryDelayMs: 10,
      defaultTimeoutMs: 50,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
    });

    const action = makeAction({
      async execute() {
        await new Promise((r) => setTimeout(r, 500));
        return { echo: 'late' };
      },
    });

    const result = await rtWithDefault.run(action, ctx, { value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TIMEOUT');
  });

  it('external signal aborts even when timeout is configured', async () => {
    const externalController = new AbortController();
    const action = makeAction({
      async execute(ctx) {
        // Wait until signal fires
        await new Promise((_, reject) => {
          ctx.signal!.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
        });
        return { echo: 'never' };
      },
    });

    const ctxWithSignal = { ...ctx, signal: externalController.signal };
    // Timeout is 5s, but external abort fires at 20ms
    const start = Date.now();
    setTimeout(() => externalController.abort(), 20);
    const result = await runtime.run(action, ctxWithSignal, { value: 'x' }, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(500); // Should resolve quickly, not wait for 5s timeout
  });

  it('external abort does not trigger retries', async () => {
    const rtWithRetries = new ExecutionRuntime(makePolicy(), {
      maxRetries: 2,
      retryDelayMs: 10,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
    });

    let attempts = 0;
    const externalController = new AbortController();
    const action = makeAction({
      async execute(ctx) {
        attempts++;
        await new Promise((_, reject) => {
          ctx.signal!.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
        });
        return { echo: 'never' };
      },
    });

    const ctxWithSignal = { ...ctx, signal: externalController.signal };
    setTimeout(() => externalController.abort(), 20);
    const result = await rtWithRetries.run(action, ctxWithSignal, { value: 'x' }, { timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('ABORTED');
    expect(attempts).toBe(1); // No retries after abort
  });

  it('external abort detected by signal state, not error message', async () => {
    const rtWithRetries = new ExecutionRuntime(makePolicy(), {
      maxRetries: 2,
      retryDelayMs: 10,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
    });

    let attempts = 0;
    const externalController = new AbortController();
    const action = makeAction({
      async execute(ctx) {
        attempts++;
        await new Promise((_, reject) => {
          // Non-standard error message on abort
          ctx.signal!.addEventListener('abort', () => reject(new Error('custom abort reason')), { once: true });
        });
        return { echo: 'never' };
      },
    });

    const ctxWithSignal = { ...ctx, signal: externalController.signal };
    setTimeout(() => externalController.abort(), 20);
    const result = await rtWithRetries.run(action, ctxWithSignal, { value: 'x' }, { timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('ABORTED');
    expect(attempts).toBe(1);
  });

  it('external signal without timeout is passed through to context', async () => {
    const externalController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const action = makeAction({
      async execute(ctx, input: any) {
        receivedSignal = ctx.signal;
        return { echo: input.value };
      },
    });

    const ctxWithSignal = { ...ctx, signal: externalController.signal };
    await runtime.run(action, ctxWithSignal, { value: 'ok' });
    expect(receivedSignal).toBe(externalController.signal);
  });

  it('per-call timeoutMs overrides defaultTimeoutMs', async () => {
    const rtWithDefault = new ExecutionRuntime(makePolicy(), {
      maxRetries: 0,
      retryDelayMs: 10,
      defaultTimeoutMs: 50,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics,
    });

    const action = makeAction({
      async execute(_ctx, input: any) {
        return { echo: input.value };
      },
    });

    const result = await rtWithDefault.run(action, ctx, { value: 'ok' }, { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });
});
