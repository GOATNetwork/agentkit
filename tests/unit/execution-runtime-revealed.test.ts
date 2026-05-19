import { describe, it, expect, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { NoopRuntimeMetrics } from '../../core/metrics/metrics';
import type { ActionContext, ActionDefinition } from '../../core/schema/action';

const silentLogger = { log: () => {} };

const ctx: ActionContext = { traceId: 'trace-1', network: 'goat-testnet', now: Date.now() };

function buildRuntime(onActionSuccess: ReturnType<typeof vi.fn>) {
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
    hooks: { onActionSuccess },
  });
}

function buildAction(): ActionDefinition<unknown, { code: string; status: string }> {
  return {
    name: 'test.revealable-output',
    description: 'returns sensitive code',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    sensitiveOutputFields: ['code'],
    async execute() {
      return { code: 'AMZN-1234', status: 'OK' };
    },
  };
}

describe('ExecutionRuntime revealedFields option', () => {
  it('does not redact a sensitive field listed in revealedFields', async () => {
    const onActionSuccess = vi.fn();
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(buildAction(), ctx, {}, { revealedFields: ['code'] });

    expect(result.ok).toBe(true);
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.code).toBe('AMZN-1234');
    expect(hookOutput.status).toBe('OK');
  });

  it('redacts sensitiveOutputFields by default (no revealedFields)', async () => {
    const onActionSuccess = vi.fn();
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(buildAction(), ctx, {});

    expect(result.ok).toBe(true);
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.code).toBe('[REDACTED]');
    expect(hookOutput.status).toBe('OK');
  });

  it('caller-visible result.output is never redacted regardless of revealedFields', async () => {
    const onActionSuccess = vi.fn();
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(buildAction(), ctx, {});

    expect(result.ok).toBe(true);
    expect((result.output as { code: string }).code).toBe('AMZN-1234');
  });

  it('empty revealedFields array is equivalent to undefined (full redaction)', async () => {
    const onActionSuccess = vi.fn();
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(buildAction(), ctx, {}, { revealedFields: [] });

    expect(result.ok).toBe(true);
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.code).toBe('[REDACTED]');
    expect(hookOutput.status).toBe('OK');
  });

  it('revealedFields entries not in sensitiveOutputFields are a no-op', async () => {
    const onActionSuccess = vi.fn();
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(
      buildAction(),
      ctx,
      {},
      { revealedFields: ['status', 'someUnrelatedField'] },
    );

    expect(result.ok).toBe(true);
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    // `code` stays redacted because it was not listed.
    expect(hookOutput.code).toBe('[REDACTED]');
    // `status` was not sensitive to begin with — still present unchanged.
    expect(hookOutput.status).toBe('OK');
  });

  it('reveals multiple fields when all sensitive fields are listed', async () => {
    const onActionSuccess = vi.fn();
    const action: ActionDefinition<unknown, { code: string; pin: string; status: string }> = {
      name: 'test.revealable-multi',
      description: 'returns two sensitive fields',
      riskLevel: 'read',
      requiresConfirmation: false,
      networks: ['goat-testnet'],
      sensitiveOutputFields: ['code', 'pin'],
      async execute() {
        return { code: 'AMZN-1234', pin: '0987', status: 'OK' };
      },
    };
    const runtime = buildRuntime(onActionSuccess);

    const result = await runtime.run(action, ctx, {}, { revealedFields: ['code', 'pin'] });

    expect(result.ok).toBe(true);
    const hookOutput = onActionSuccess.mock.calls[0][0].output as Record<string, unknown>;
    expect(hookOutput.code).toBe('AMZN-1234');
    expect(hookOutput.pin).toBe('0987');
    expect(hookOutput.status).toBe('OK');
  });
});
