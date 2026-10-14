import { describe, expect, it, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { InMemoryRuntimeMetrics } from '../../core/metrics/metrics';
import type { ActionDefinition } from '../../core/schema/action';
import { InMemoryIdempotencyStore } from '../../core/runtime/idempotency/store';

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
      }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('idempotency after a caller stops waiting', () => {
  it.each([false, true])(
    'caches success beyond the lock TTL without a successor (interrupted: %s)',
    async (interrupt) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
      const execution = deferred<{ out: string }>();
      const started = deferred<void>();
      const execute = vi.fn(async () => {
        started.resolve();
        return execution.promise;
      });
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
        maxRetries: 0,
        idempotencyTtlSeconds: 1,
        logger: { log() {} },
      });
      const testAction = { ...action, riskLevel: 'read' as const, execute };
      const context = { traceId: 'unowned-expiry', network: 'goat-testnet', now: 1000 };
      const options = { idempotencyKey: 'long-running' };
      try {
        const first = runtime.run(testAction, context, { v: 'x' }, { ...options, timeoutMs: interrupt ? 5 : 0 });
        await started.promise;
        const interrupted = interrupt ? await first : undefined;
        if (interrupt) expect(interrupted?.errorCode).toBe('TIMEOUT');
        clock.mockReturnValue(3000);
        execution.resolve({ out: 'paid once' });
        await first;
        await interrupted?.settled;
        expect(await runtime.run(testAction, context, { v: 'x' }, options)).toMatchObject({
          ok: true,
          attempts: 0,
          output: { out: 'paid once' },
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        execution.resolve({ out: 'paid once' });
        clock.mockRestore();
      }
    },
  );

  it.each(['running', 'complete'] as const)('does not overwrite the %s owner after lock expiry', async (state) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = deferred<void>();
    const second = deferred<void>();
    const secondStarted = deferred<void>();
    let calls = 0;
    const execute = async () => {
      if (++calls === 1) {
        await first.promise;
        return { out: 'old owner' };
      }
      secondStarted.resolve();
      if (state === 'running') await second.promise;
      return { out: 'new owner' };
    };
    const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
      maxRetries: 0,
      idempotencyTtlSeconds: 1,
      idempotencyStore: new InMemoryIdempotencyStore(),
      logger: { log() {} },
    });
    const testAction = { ...action, riskLevel: 'read' as const, execute };
    const ctx = { traceId: 'expiry', network: 'goat-testnet', now: 1000 };
    const options = { idempotencyKey: 'reacquired' };
    try {
      const interrupted = await runtime.run(testAction, ctx, { v: 'x' }, { ...options, timeoutMs: 5 });
      expect(interrupted.errorCode).toBe('TIMEOUT');
      clock.mockReturnValue(3000);
      const newer = runtime.run(testAction, ctx, { v: 'x' }, options);
      await secondStarted.promise;
      if (state === 'complete') await newer;
      first.resolve();
      await interrupted.settled;
      if (state === 'running')
        expect(await runtime.run(testAction, ctx, { v: 'x' }, options)).toMatchObject({
          errorCode: 'IDEMPOTENCY_CONFLICT',
        });
      second.resolve();
      expect(await newer).toMatchObject({ ok: true, output: { out: 'new owner' } });
      expect(await runtime.run(testAction, ctx, { v: 'x' }, options)).toMatchObject({
        ok: true,
        attempts: 0,
        output: { out: 'new owner' },
      });
      expect(calls).toBe(2);
    } finally {
      first.resolve();
      second.resolve();
      clock.mockRestore();
    }
  });

  it.each(['timeout', 'abort'] as const)(
    'returns success already observed at the %s boundary with retries disabled',
    async (stop) => {
      const onActionSuccess = vi.fn();
      const onActionError = vi.fn();
      const metrics = new InMemoryRuntimeMetrics();
      const controller = new AbortController();
      const started = deferred<void>();
      const execute = vi.fn(
        async (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve({ out: 'done' }), { once: true });
            started.resolve();
          }),
      );
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
        maxRetries: 0,
        logger: { log: vi.fn() },
        metrics,
        hooks: { onActionSuccess, onActionError },
      });
      const resultPromise = runtime.run(
        { ...action, riskLevel: 'read' as const, execute },
        { traceId: 'boundary', network: 'goat-testnet', now: Date.now(), signal: controller.signal },
        { v: 'x' },
        stop === 'timeout' ? { timeoutMs: 5 } : {},
      );
      await started.promise;
      if (stop === 'abort') controller.abort();
      const result = await resultPromise;
      // An explicit abort can win before the action has finished its promise hops.
      // In either case, a success emitted BEFORE the error decision cannot be labelled a failure.
      if (result.ok) {
        expect(result).toMatchObject({ output: { out: 'done' }, attempts: 1 });
        expect(onActionError).not.toHaveBeenCalled();
        expect(onActionSuccess.mock.calls[0][0].afterInterruption).toBeUndefined();
        expect(metrics.histograms.get(`runtime.latency_ms|action=${action.name}`)?.count).toBe(1);
      } else {
        expect(stop).toBe('abort');
        await result.settled;
        expect(onActionSuccess.mock.calls[0][0].afterInterruption).toBe(true);
      }
      expect(onActionSuccess).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, 8])('retries a cooperatively settled timeout after %i cleanup promise hops', async (hops) => {
    let cleanedUp = false;
    const execute = vi
      .fn()
      .mockImplementationOnce(async (ctx) => {
        try {
          await new Promise((_, reject) =>
            ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          );
        } finally {
          for (let i = 0; i < hops; i++) await Promise.resolve();
          cleanedUp = true;
        }
      })
      .mockImplementationOnce(async () => {
        expect(cleanedUp).toBe(true);
        return { out: 'retried' };
      });
    const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
      maxRetries: 1,
      retryDelayMs: 1,
      logger: { log: vi.fn() },
    });
    const ctx = { traceId: 'cooperative', network: 'goat-testnet', now: Date.now() };
    const retryable = { ...action, riskLevel: 'read' as const, execute };
    expect(
      await runtime.run(retryable, ctx, { v: 'x' }, { idempotencyKey: 'cooperative', timeoutMs: 5 }),
    ).toMatchObject({
      ok: true,
      attempts: 2,
      output: { out: 'retried' },
    });
    expect(await runtime.run(retryable, ctx, { v: 'x' }, { idempotencyKey: 'cooperative' })).toMatchObject({
      ok: true,
      attempts: 0,
      output: { out: 'retried' },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reports a success during timeout backoff as normal success, without late or error metrics', async () => {
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { out: 'done' };
    });
    const onActionSuccess = vi.fn();
    const onActionError = vi.fn();
    const metrics = new InMemoryRuntimeMetrics();
    const logger = { log: vi.fn() };
    const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
      maxRetries: 1,
      retryDelayMs: 20,
      logger,
      metrics,
      hooks: { onActionSuccess, onActionError },
    });
    const ctx = { traceId: 'late-backoff', network: 'goat-testnet', now: Date.now() };
    const retryable = { ...action, riskLevel: 'read' as const, execute };
    const result = await runtime.run(retryable, ctx, { v: 'x' }, { idempotencyKey: 'late-backoff', timeoutMs: 5 });
    expect(result).toMatchObject({ ok: true, output: { out: 'done' }, attempts: 1 });
    expect(result.errorCode).toBeUndefined();
    expect(onActionSuccess).toHaveBeenCalledTimes(1);
    expect(onActionSuccess.mock.calls[0][0].afterInterruption).toBeUndefined();
    const successLogs = logger.log.mock.calls.filter(([, message]) => message === 'action run success');
    expect(successLogs).toHaveLength(1);
    expect(successLogs[0][2].afterInterruption).toBeUndefined();
    expect(onActionError).not.toHaveBeenCalled();
    expect([...metrics.counters.keys()].some((key) => key.startsWith('runtime.error'))).toBe(false);
    expect([...metrics.counters.keys()].some((key) => key.startsWith('runtime.late_success'))).toBe(false);
    expect(metrics.histograms.get(`runtime.latency_ms|action=${action.name}`)?.count).toBe(1);
    expect(await runtime.run(retryable, ctx, { v: 'x' }, { idempotencyKey: 'late-backoff' })).toMatchObject({
      ok: true,
      attempts: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'timeout'] as const)('holds the key after %s and caches a late success', async (stop) => {
    const pending = deferred<{ out: string }>();
    const started = deferred<void>();
    const execute = vi.fn(() => {
      started.resolve();
      return pending.promise;
    });
    const delayed = { ...action, riskLevel: 'read' as const, execute, sensitiveOutputFields: ['out'] };
    const onActionSuccess = vi.fn();
    const onActionError = vi.fn();
    const logger = { log: vi.fn() };
    const metrics = new InMemoryRuntimeMetrics();
    // Read actions would normally retry; a timeout must not start an overlapping attempt.
    const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: ['goat-testnet'] }), {
      maxRetries: 2,
      retryDelayMs: 1,
      logger,
      metrics,
      hooks: { onActionSuccess, onActionError },
    });
    const abort = new AbortController();
    const context = { traceId: 'late', network: 'goat-testnet', now: Date.now() };
    const options = { idempotencyKey: 'late', timeoutMs: stop === 'timeout' ? 10 : undefined };
    const running = runtime.run(delayed, { ...context, signal: abort.signal }, { v: 'x' }, options);
    await started.promise;
    if (stop === 'abort') abort.abort();
    const result = await running;
    expect(result.errorCode).toBe(stop === 'abort' ? 'ABORTED' : 'TIMEOUT');
    expect(result.settled).toBeInstanceOf(Promise);
    expect(await runtime.run(delayed, context, { v: 'x' }, options)).toMatchObject({
      errorCode: 'IDEMPOTENCY_CONFLICT',
    });
    pending.resolve({ out: 'paid' });
    await result.settled;
    expect(onActionError).toHaveBeenCalledTimes(1);
    expect(onActionSuccess).toHaveBeenCalledTimes(1);
    expect(onActionSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ afterInterruption: true, output: { out: '[REDACTED]' } }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      'info',
      'action run success',
      expect.objectContaining({ afterInterruption: true }),
    );
    expect(metrics.counters.get(`runtime.success|action=${action.name}`)).toBe(1);
    expect(metrics.counters.get(`runtime.late_success|action=${action.name}`)).toBe(1);
    expect(await runtime.run(delayed, context, { v: 'x' }, options)).toMatchObject({
      ok: true,
      attempts: 0,
      output: { out: 'paid' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'invalid output'] as const)('releases the key only after a late %s', async (failure) => {
    const pending = deferred<{ out: string }>();
    const started = deferred<void>();
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValue({ out: 'valid' });
    const delayed = {
      ...action,
      execute,
      outputSchema: { type: 'object' as const, required: ['out'], properties: { out: { type: 'string' as const } } },
    };
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: ['goat-testnet'], writeEnabled: true, maxRiskWithoutConfirm: 'low' }),
    );
    const abort = new AbortController();
    const context = { traceId: 'late', network: 'goat-testnet', now: Date.now() };
    const options = { idempotencyKey: 'late' };
    const running = runtime.run(delayed, { ...context, signal: abort.signal }, { v: 'x' }, options);
    await started.promise;
    abort.abort();
    const result = await running;
    expect(await runtime.run(delayed, context, { v: 'x' }, options)).toMatchObject({
      errorCode: 'IDEMPOTENCY_CONFLICT',
    });
    if (failure === 'failure') pending.reject(new Error('failed execution'));
    else pending.resolve({ out: 123 } as unknown as { out: string });
    await result.settled;
    expect(await runtime.run(delayed, context, { v: 'x' }, options)).toMatchObject({
      ok: true,
      attempts: 1,
      output: { out: 'valid' },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
