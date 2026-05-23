import { describe, it, expect, vi, afterEach } from 'vitest';
import { printSecretAction } from '../../core/actions/print-secret';
import type { ActionContext } from '../../core/schema/action';

const ctx: ActionContext = { traceId: 'trace-1', network: '', now: Date.now() };

describe('printSecretAction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares sensitiveInputFields: ["value"]', () => {
    const action = printSecretAction();
    expect(action.sensitiveInputFields).toEqual(['value']);
  });

  it('writes the value to process.stdout when invoked', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const action = printSecretAction();
    const result = await action.execute(ctx, { value: 'AMZN-9999' });

    expect(result).toEqual({ printed: true });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('AMZN-9999\n');
  });

  it('prefixes output with the label when provided', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const action = printSecretAction();
    await action.execute(ctx, { value: 'AMZN-9999', label: 'card-code' });

    expect(writeSpy).toHaveBeenCalledWith('card-code: AMZN-9999\n');
  });

  it('has expected metadata (name, riskLevel, schemas)', () => {
    const action = printSecretAction();
    expect(action.name).toBe('agentkit.print-secret');
    expect(action.riskLevel).toBe('low');
    expect(action.requiresConfirmation).toBe(false);
    expect(action.zodInputSchema).toBeDefined();
    expect(action.zodOutputSchema).toBeDefined();
    expect(action.sensitiveOutputFields).toEqual([]);
    expect(action.networks).toEqual([]);
  });
});
