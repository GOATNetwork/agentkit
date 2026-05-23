import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import type { ActionContext, ActionDefinition } from '../../core/schema/action';

const silentLogger = { log: () => {} };

const ctx: ActionContext = { traceId: 'trace-1', network: 'goat-testnet', now: Date.now() };

describe('ExecutionRuntime sensitiveInputFields redaction', () => {
  it('redacts named input fields for onActionStart hook only', async () => {
    const onActionStart = vi.fn();
    const executeSpy = vi.fn().mockResolvedValue({ ok: true });

    const action: ActionDefinition<{ secret: string; name: string }, { ok: true }> = {
      name: 'test.sensitive-input',
      description: 'redact secret in hooks',
      riskLevel: 'read',
      requiresConfirmation: false,
      networks: ['goat-testnet'],
      sensitiveInputFields: ['secret'],
      execute: executeSpy,
    };

    const policy = new PolicyEngine({
      allowedNetworks: ['goat-testnet'],
      maxRiskWithoutConfirm: 'high',
      writeEnabled: true,
    });
    const runtime = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 1,
      noRetryHighRiskWrites: false,
      logger: silentLogger,
      metrics: new NoopRuntimeMetrics(),
      hooks: { onActionStart },
    });

    const input = { secret: '0xdeadbeef', name: 'alice' };
    const result = await runtime.run(action, ctx, input);

    expect(result.ok).toBe(true);

    // Hook sees redacted secret but unmodified other fields
    expect(onActionStart).toHaveBeenCalledTimes(1);
    const hookInput = onActionStart.mock.calls[0][0].input as Record<string, unknown>;
    expect(hookInput.secret).toBe('[REDACTED]');
    expect(hookInput.name).toBe('alice');

    // Execute still received raw secret
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const executeArg = executeSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(executeArg.secret).toBe('0xdeadbeef');
    expect(executeArg.name).toBe('alice');
  });
});
