import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { notifyRecovery } from '../../core/runtime/recovery-observer';
import { transferCheckpoints } from '../../core/wallet/checkpoints';
import type { ActionRecovery } from '../../core/schema/action';
import { HASH, ctx } from '../fixtures/paykit';

const exec = promisify(execFile);
describe('recovery observers', () => {
  it.each(['null-prototype', 'shadowed-methods', 'property-proxy'] as const)(
    'invokes a %s observer without reading its call or bind members',
    (shape) => {
      const receivers: unknown[] = [];
      const observed: ActionRecovery[] = [];
      const propertyReads: PropertyKey[] = [];
      let observer = function (this: unknown, record: ActionRecovery) {
        receivers.push(this);
        observed.push(record);
      };
      if (shape === 'null-prototype') Object.setPrototypeOf(observer, null);
      if (shape === 'shadowed-methods') Object.assign(observer, { call: null, bind: null });
      if (shape === 'property-proxy')
        observer = new Proxy(observer, {
          get(_target, key) {
            propertyReads.push(key);
            throw new Error('RPC wrapper does not expose function members');
          },
        });
      const context = { checkpointRecovery: observer };
      const record = { kind: 'transaction', operationId: 'key', phase: 'broadcast' };
      notifyRecovery(context, record);
      expect(receivers).toEqual([context]);
      expect(observed).toEqual([record]);
      expect(observed[0]).not.toBe(record);
      expect(propertyReads).toEqual([]);
    },
  );

  it('survives rejecting observers under strict Node rejection handling and persists the broadcast', async () => {
    const result = await exec(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        'tsx',
        fileURLToPath(new URL('../fixtures/recovery-observer.mjs', import.meta.url)),
      ],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 15000 },
    );
    expect(result.stdout).toContain('observer-recovery-ok');
    expect(result.stderr).toBe('');
  });

  it.each(['throw', 'reject', 'pending'] as const)(
    'does not propagate or await a %s observer in wallet checkpoints',
    async (mode) => {
      const observed: string[] = [];
      const checkpointRecovery = vi.fn((record) => {
        observed.push(record.phase);
        if (mode === 'throw') throw new Error('observer');
        if (mode === 'reject') return Promise.reject(new Error('observer'));
        return new Promise<void>(() => {});
      });
      const checkpoints = transferCheckpoints({ ...ctx, checkpointRecovery });
      expect(checkpoints.onSignedTransaction!(HASH)).toBeUndefined();
      expect(checkpoints.onBroadcast!(HASH)).toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed).toEqual(['submitting', 'broadcast']);
      expect(checkpointRecovery).toHaveBeenCalledTimes(2);
    },
  );

  it('reads an observer accessor once and preserves its receiver', () => {
    const callback = vi.fn();
    const getter = vi.fn(() => callback);
    const context = Object.defineProperty({}, 'checkpointRecovery', { get: getter });
    notifyRecovery(context, { kind: 'transaction', operationId: 'key', phase: 'broadcast' });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.contexts[0]).toBe(context);
  });

  it('isolates a throwing observer accessor', () => {
    const getter = vi.fn(() => {
      throw new Error('observer accessor failed');
    });
    const context = Object.defineProperty({}, 'checkpointRecovery', { get: getter });
    expect(() =>
      notifyRecovery(context, { kind: 'transaction', operationId: 'key', phase: 'broadcast' }),
    ).not.toThrow();
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('detaches nested evidence before both synchronous and delayed observer mutation', async () => {
    const record: ActionRecovery = {
      kind: 'transaction',
      operationId: 'key',
      phase: 'broadcast',
      result: { nested: { value: 'original' } },
    };
    const original = structuredClone(record);
    let observed: ActionRecovery | undefined;
    const context = {
      checkpointRecovery: async (snapshot: ActionRecovery) => {
        observed = snapshot;
        snapshot.phase = 'mutated';
        await new Promise((resolve) => setImmediate(resolve));
        (snapshot.result as { nested: { value: string } }).nested.value = 'mutated';
      },
    };
    notifyRecovery(context, record);
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed).toMatchObject({ phase: 'mutated', result: { nested: { value: 'mutated' } } });
    expect(observed).not.toBe(record);
    expect(record).toEqual(original);
  });
});
