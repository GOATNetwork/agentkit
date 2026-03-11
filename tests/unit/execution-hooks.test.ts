import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import type { ExecutionHooks } from '../../core/runtime/execution-hooks';
import type { ActionDefinition } from '../../core/schema/action';

const noopLogger = { log: vi.fn() };

function makeRuntime(hooks: ExecutionHooks, policyOverrides?: Partial<{ allowedNetworks: string[]; maxRiskWithoutConfirm: string; writeEnabled: boolean }>) {
  const policy = new PolicyEngine({
    allowedNetworks: policyOverrides?.allowedNetworks ?? ['goat-testnet'],
    maxRiskWithoutConfirm: (policyOverrides?.maxRiskWithoutConfirm as any) ?? 'high',
    writeEnabled: policyOverrides?.writeEnabled ?? true,
  });
  return new ExecutionRuntime(policy, {
    maxRetries: 1,
    retryDelayMs: 1,
    noRetryHighRiskWrites: false,
    logger: noopLogger,
    metrics: new NoopRuntimeMetrics(),
    hooks,
  });
}

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: 'test.action',
    description: 'test',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    execute: vi.fn().mockResolvedValue({ result: 'ok' }),
    ...overrides,
  };
}

const ctx = { traceId: 'trace-1', network: 'goat-testnet', now: Date.now() };

describe('ExecutionHooks', () => {
  it('calls onActionStart on each attempt', async () => {
    const onActionStart = vi.fn();
    const runtime = makeRuntime({ onActionStart });
    const action = makeAction();

    await runtime.run(action, ctx, {});

    expect(onActionStart).toHaveBeenCalledTimes(1);
    expect(onActionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-1',
        action: 'test.action',
        attempt: 1,
      }),
    );
  });

  it('calls onActionSuccess on successful execution', async () => {
    const onActionSuccess = vi.fn();
    const runtime = makeRuntime({ onActionSuccess });
    const action = makeAction();

    await runtime.run(action, ctx, {});

    expect(onActionSuccess).toHaveBeenCalledTimes(1);
    expect(onActionSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-1',
        action: 'test.action',
        attempt: 1,
        output: { result: 'ok' },
      }),
    );
  });

  it('calls onActionError after all retries exhausted', async () => {
    const onActionError = vi.fn();
    const runtime = makeRuntime({ onActionError });
    const action = makeAction({
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await runtime.run(action, ctx, {});

    expect(result.ok).toBe(false);
    expect(onActionError).toHaveBeenCalledTimes(1);
    expect(onActionError).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-1',
        action: 'test.action',
        attempts: 2,
        errorMessage: 'boom',
      }),
    );
  });

  it('calls onPolicyBlocked when policy denies', async () => {
    const onPolicyBlocked = vi.fn();
    const runtime = makeRuntime({ onPolicyBlocked }, { allowedNetworks: ['other-net'] });
    const action = makeAction();

    const result = await runtime.run(action, ctx, {});

    expect(result.ok).toBe(false);
    expect(onPolicyBlocked).toHaveBeenCalledTimes(1);
    expect(onPolicyBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-1',
        action: 'test.action',
      }),
    );
  });

  it('works fine with no hooks configured', async () => {
    const runtime = makeRuntime({});
    const action = makeAction();

    const result = await runtime.run(action, ctx, {});

    expect(result.ok).toBe(true);
  });

  it('redacts sensitiveOutputFields in onActionSuccess hook', async () => {
    const onActionSuccess = vi.fn();
    const runtime = makeRuntime({ onActionSuccess });
    const action = makeAction({
      execute: vi.fn().mockResolvedValue({ access_token: 'secret', refresh_token: 'secret2', user_id: 'u1' }),
      sensitiveOutputFields: ['access_token', 'refresh_token'],
    });

    const result = await runtime.run(action, ctx, {});

    // Caller gets real values
    expect(result.ok).toBe(true);
    expect((result.output as any).access_token).toBe('secret');
    expect((result.output as any).refresh_token).toBe('secret2');

    // Hook gets redacted values
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.access_token).toBe('[REDACTED]');
    expect(hookOutput.refresh_token).toBe('[REDACTED]');
    expect(hookOutput.user_id).toBe('u1');
  });

  it('does not redact when sensitiveOutputFields is empty or absent', async () => {
    const onActionSuccess = vi.fn();
    const runtime = makeRuntime({ onActionSuccess });
    const action = makeAction({
      execute: vi.fn().mockResolvedValue({ access_token: 'visible' }),
    });

    await runtime.run(action, ctx, {});

    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.access_token).toBe('visible');
  });

  it('calls onActionStart multiple times on retries', async () => {
    const onActionStart = vi.fn();
    const runtime = makeRuntime({ onActionStart });
    const executeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ ok: true });
    const action = makeAction({ execute: executeFn });

    const result = await runtime.run(action, ctx, {});

    expect(result.ok).toBe(true);
    expect(onActionStart).toHaveBeenCalledTimes(2);
  });
});
