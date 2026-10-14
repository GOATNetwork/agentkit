import { AgentkitRuntimeError } from '../../core/errors/error';
import { broadcastTransaction, confirmTransaction, signTransaction } from '../../core/wallet/broadcast-transaction';
import type { Signer } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { PaykitService, InMemoryPaymentRecoveryStore, createPaykitActions } from '../../plugins/paykit';
import {
  claimPaymentRequest,
  completePayment,
  paymentJournal,
  throwPaymentFailure,
} from '../../plugins/paykit/journal';
import { paymentRequestKey, type PaymentRecovery, type PaymentRecoveryStore } from '../../plugins/paykit/recovery';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { URL, HASH, ctx, payment, fakeWallet, routes, session } from '../fixtures/paykit';

function intent(): PaymentRecovery {
  return {
    kind: 'paykit',
    rail: 'fiat',
    phase: 'requesting',
    operationId: 'card',
    origin: 'https://pay.example',
    fingerprint: 'a'.repeat(64),
  };
}

describe('payment failure guidance', () => {
  const guidance = 'PayKit operation incomplete; inspect recovery data before retrying';
  it.each(['RECOVERY_REQUIRED', 'IDEMPOTENCY_CONFLICT'] as const)('preserves final %s instructions', (code) => {
    const original = new AgentkitRuntimeError(code, 'Reconcile the saved intent; do not send another payment.');
    let error: unknown;
    try {
      throwPaymentFailure(original, intent(), ctx, guidance);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code, message: original.message, recovery: intent() });
  });
  it.each([false, true])('does not describe a completed operation as incomplete (classified: %s)', (classified) => {
    const record = {
      ...intent(),
      phase: 'complete' as const,
      result: { checkout_id: 'cs1' },
      persistenceError: 'Save the completed result from recovery data',
    };
    const original = classified
      ? new AgentkitRuntimeError('ADAPTER_REQUEST_FAILED', 'Insufficient storage for the payment journal')
      : new Error('private storage error');
    let error: unknown;
    try {
      throwPaymentFailure(original, record, ctx, guidance);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'ADAPTER_REQUEST_FAILED', recovery: record });
    expect(String(error)).not.toContain('operation incomplete');
    if (classified) expect(error).toMatchObject({ message: original.message });
    else expect(String(error)).toContain('Save the completed result from recovery data');
  });
  it.each(['sign', 'send', 'confirm'] as const)(
    'preserves the wallet %s instruction without a second recovery instruction',
    async (stage) => {
      const cause = Object.assign(new Error('RPC unavailable'), { code: 'UNSUPPORTED_OPERATION' });
      const signer = {
        provider: {
          broadcastTransaction: async () => {
            throw cause;
          },
        },
        populateTransaction: async () => ({}),
        signTransaction: async () => '0xdeadbeef',
      } as unknown as Signer;
      const original = await (
        stage === 'sign'
          ? signTransaction(async () => {
              throw cause;
            })
          : stage === 'send'
            ? broadcastTransaction(signer, {})
            : confirmTransaction(HASH, async () => {
                throw cause;
              })
      ).catch((error: Error) => error);
      expect(original).toBeInstanceOf(AgentkitRuntimeError);
      let error: unknown;
      try {
        throwPaymentFailure(original, { ...intent(), phase: 'submitting' }, ctx, guidance);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ message: (original as Error).message });
    },
  );
  it('still gives guidance when a wallet confirmation abort only carries a transaction handle', async () => {
    const caller = new AbortController();
    caller.abort();
    const original = await confirmTransaction(HASH, async () => ({}), { signal: caller.signal }).catch(
      (error: Error) => error,
    );
    let error: unknown;
    try {
      throwPaymentFailure(original, { ...intent(), phase: 'broadcast', txHash: HASH }, ctx, guidance);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: `Operation aborted; ${guidance}`,
      recovery: { txHash: HASH },
    });
  });
});

describe('payment journal persistence boundary', () => {
  it('keeps a failed retry diagnostic until the later queued checkpoint is persisted', async () => {
    const record = intent();
    const backing = new InMemoryPaymentRecoveryStore();
    let rejectRetry!: (reason: Error) => void;
    let releaseRepair!: () => void;
    let retryStarted!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    const checkpointRecovery = vi.fn();
    let calls = 0;
    const store: PaymentRecoveryStore = {
      get: (id) => backing.get(id),
      claim: (r) => backing.claim(r),
      put: async (r) => {
        calls++;
        if (calls === 1) throw new Error('first write');
        if (calls === 2) {
          retryStarted();
          await new Promise<void>((_resolve, reject) => {
            rejectRetry = reject;
          });
        }
        await new Promise<void>((resolve) => {
          releaseRepair = resolve;
        });
        await backing.put(r);
      },
    };
    const journal = paymentJournal(store, record, { ...ctx, checkpointRecovery });
    const checkpoint = journal.checkpoint({ phase: 'broadcast', txHash: HASH }, 'storage unavailable');
    const rejected = expect(checkpoint).rejects.toThrow('retry failed');
    await retryGate;
    const repaired = journal.save({ orderId: 'newer evidence' });
    rejectRetry(new Error('retry failed'));
    await rejected;
    expect(record.persistenceError).toBe('storage unavailable');
    expect(checkpointRecovery.mock.lastCall?.[0].persistenceError).toBe('storage unavailable');
    // The queued repair is still pending; only its successful write can clear the warning.
    releaseRepair();
    await repaired;
    expect(record).not.toHaveProperty('persistenceError');
    expect(checkpointRecovery.mock.lastCall?.[0]).not.toHaveProperty('persistenceError');
    expect(await backing.get(record.operationId)).toMatchObject({ orderId: 'newer evidence', txHash: HASH });
    expect(calls).toBe(3);
  });

  it.each([false, true])('persists despite a throwing observer getter (write failure: %s)', async (failWrite) => {
    const record = intent();
    const store = new InMemoryPaymentRecoveryStore();
    const getter = vi.fn(() => {
      throw new Error('observer accessor failed');
    });
    const context = Object.defineProperty({ ...ctx }, 'checkpointRecovery', { get: getter });
    const put = vi.spyOn(store, 'put');
    if (failWrite) put.mockRejectedValue(new Error('disk unavailable'));
    const journal = paymentJournal(store, record, context);
    const result = { checkout_id: 'cs1' };
    const completion = completePayment(store, journal, record, result);
    if (failWrite) {
      await expect(completion).rejects.toThrow('disk unavailable');
      expect(record).toMatchObject({
        phase: 'complete',
        result,
        persistenceError: expect.stringContaining('must be saved'),
      });
      expect(put).toHaveBeenCalledTimes(2);
    } else {
      await expect(completion).resolves.toEqual(result);
      expect(await store.get(record.operationId)).toMatchObject({ phase: 'complete', result });
    }
    expect(getter).toHaveBeenCalled();
  });

  it('omits a persistence warning and marker result instead of persisting undefined values', async () => {
    const record = { ...intent(), persistenceError: 'previous failure' };
    const backing = new InMemoryPaymentRecoveryStore();
    const put = vi.fn(async (snapshot: PaymentRecovery) => {
      for (const value of Object.values(snapshot)) expect(value).not.toBeUndefined();
      expect(Object.hasOwn(snapshot, 'persistenceError')).toBe(false);
      return backing.put(snapshot);
    });
    const store: PaymentRecoveryStore = { get: (id) => backing.get(id), claim: (r) => backing.claim(r), put };
    const journal = paymentJournal(store, record, ctx);
    const result = { checkout_id: 'cs1', url: 'https://pay.example/private-checkout' };
    expect(await completePayment(store, journal, record, result)).toEqual(result);
    expect(put).toHaveBeenCalledTimes(2);
    const marker = put.mock.calls.find(([r]) => r.operationId === paymentRequestKey(record))![0];
    expect(Object.hasOwn(marker, 'result')).toBe(false);
    expect(Object.hasOwn(record, 'persistenceError')).toBe(false);
  });

  it('uses JSON conventions for undefined result entries without erasing existing evidence', async () => {
    const record = { ...intent(), txHash: HASH };
    const store = new InMemoryPaymentRecoveryStore();
    const journal = paymentJournal(store, record, ctx);
    await journal.save({ txHash: undefined, orderId: undefined });
    expect(record.txHash).toBe(HASH);
    expect(record).not.toHaveProperty('orderId');
    const result = {
      optional: undefined,
      items: [undefined, { optional: undefined, value: 0 }],
      zero: 0,
      nil: null,
      flag: false,
    };
    const output = await completePayment(store, journal, record, result);
    expect(output).toEqual({ items: [null, { value: 0 }], zero: 0, nil: null, flag: false });
    expect((await store.get(record.operationId))?.result).toEqual(output);
    expect(Object.hasOwn(result, 'optional')).toBe(true);
    expect(result.items[0]).toBeUndefined();
  });

  it('omits absent order IDs, including nested result fields, through a strict custom store', async () => {
    const backing = new InMemoryPaymentRecoveryStore();
    const snapshots: PaymentRecovery[] = [];
    const check = (value: unknown) => {
      if (value === undefined) throw new Error('Undefined journal value');
      if (value && typeof value === 'object') for (const field of Object.values(value)) check(field);
    };
    const store: PaymentRecoveryStore = {
      get: (id) => backing.get(id),
      claim: async (r) => {
        check(r);
        return backing.claim(r);
      },
      put: async (r) => {
        check(r);
        snapshots.push(structuredClone(r));
        return backing.put(r);
      },
    };
    const { wallet, broadcast } = fakeWallet();
    const checkpointRecovery = vi.fn();
    const service = new PaykitService({
      wallet,
      recoveryStore: store,
      fetchImpl: routes({ session: session({ order_id: undefined }) }),
    });
    const result = await service.pay(payment, { ...ctx, checkpointRecovery });
    expect(result).toMatchObject({ ok: true, tx_hash: HASH });
    expect(Object.hasOwn(result, 'order_id')).toBe(false);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const r of snapshots) expect(Object.hasOwn(r, 'orderId')).toBe(false);
    for (const [r] of checkpointRecovery.mock.calls) check(r);
    expect(await service.pay(payment, ctx)).toEqual(result);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('preserves signed evidence when the wallet returns no submission hash, without undefined fields', async () => {
    const backing = new InMemoryPaymentRecoveryStore();
    const put = vi.fn(async (r: PaymentRecovery) => {
      for (const value of Object.values(r)) if (value === undefined) throw new Error('Undefined journal field');
      return backing.put(r);
    });
    const store: PaymentRecoveryStore = { get: (id) => backing.get(id), claim: (r) => backing.claim(r), put };
    const { wallet } = fakeWallet();
    const broadcast = vi.fn<NonNullable<typeof wallet.broadcastErc20>>(async (_token, _to, _amount, options) => {
      await options?.onSignedTransaction?.(HASH);
      return { txHash: undefined } as never;
    });
    wallet.broadcastErc20 = broadcast;
    const service = new PaykitService({ wallet, recoveryStore: store, fetchImpl: routes() });
    const error = await service.pay(payment, ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({ recovery: { phase: 'submitting', signedTxHash: HASH } });
    expect(error).not.toHaveProperty('recovery.rawSubmissionHash');
    expect(error).not.toHaveProperty('recovery.persistenceError');
    expect((await store.get(payment.idempotencyKey))?.signedTxHash).toBe(HASH);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the request notification for an empty primary save', async () => {
    const record = { ...intent(), phase: 'prepared' as const };
    const store = new InMemoryPaymentRecoveryStore();
    const checkpointRecovery = vi.fn();
    const context = { ...ctx, checkpointRecovery };
    const journal = paymentJournal(store, record, context);
    await claimPaymentRequest(store, record, context);
    await journal.save({});
    expect(checkpointRecovery).toHaveBeenCalledTimes(1);
    expect(await store.get(record.operationId)).toMatchObject({ phase: 'requesting' });
  });

  it('publishes adoption and storage repair together once', async () => {
    const record = { ...intent(), persistenceError: 'old failure' };
    const store: PaymentRecoveryStore = {
      get: vi.fn(),
      claim: vi.fn(),
      put: async (r) => ({ ...r, phase: 'complete', result: { checkout_id: 'cs1' } }),
    };
    const checkpointRecovery = vi.fn();
    await paymentJournal(store, record, { ...ctx, checkpointRecovery }).save({});
    expect(checkpointRecovery).toHaveBeenCalledTimes(1);
    expect(checkpointRecovery.mock.calls[0][0]).toMatchObject({ phase: 'complete', result: { checkout_id: 'cs1' } });
    expect(checkpointRecovery.mock.calls[0][0]).not.toHaveProperty('persistenceError');
  });

  it.each(['pay', 'createCardCheckout'] as const)('persists %s through a strict custom store', async (method) => {
    const backing = new InMemoryPaymentRecoveryStore();
    const check = (record: PaymentRecovery) => {
      for (const value of Object.values(record)) if (value === undefined) throw new Error('Undefined journal field');
    };
    const store: PaymentRecoveryStore = {
      get: (id) => backing.get(id),
      claim: async (r) => {
        check(r);
        return backing.claim(r);
      },
      put: async (r) => {
        check(r);
        return backing.put(r);
      },
    };
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ recoveryStore: store, wallet, fetchImpl: routes() });
    const run = () =>
      method === 'pay'
        ? service.pay(payment, ctx)
        : service.createCardCheckout({ url: URL, amount: '1', idempotencyKey: payment.idempotencyKey }, ctx);
    const result = await run();
    expect(await run()).toEqual(result);
    expect((await store.get(payment.idempotencyKey))?.phase).toBe('complete');
    expect(broadcast).toHaveBeenCalledTimes(method === 'pay' ? 1 : 0);
  });

  it.each([0, 1, 2].flatMap((failures) => ['sync', 'async'].map((mode) => ({ failures, mode }))))(
    'keeps completion and retry diagnostics with a $mode observer failure (write failures: $failures)',
    async ({ failures, mode }) => {
      const backing = new InMemoryPaymentRecoveryStore();
      const record = intent();
      let remaining = failures;
      const put = vi.fn(async (r: PaymentRecovery) => {
        if (remaining-- > 0) throw new Error('storage unavailable');
        return backing.put(r);
      });
      const store: PaymentRecoveryStore = { get: (id) => backing.get(id), claim: (r) => backing.claim(r), put };
      const checkpointRecovery = vi.fn((r: PaymentRecovery) => {
        r.operationId = 'observer mutation';
        if (mode === 'async') return Promise.reject(new Error('observer failed'));
        throw new Error('observer failed');
      });
      const journal = paymentJournal(store, record, { ...ctx, checkpointRecovery });
      const result = { checkout_id: 'cs1' };
      if (failures < 2) {
        expect(await completePayment(store, journal, record, result)).toEqual(result);
        expect((await store.get(record.operationId))?.result).toEqual(result);
        expect(record.persistenceError).toBeUndefined();
        expect(put).toHaveBeenCalledTimes(failures + 2); // primary, optional retry, compact marker
      } else {
        await expect(completePayment(store, journal, record, result)).rejects.toThrow('storage unavailable');
        expect(record).toMatchObject({
          phase: 'complete',
          result,
          persistenceError: expect.stringContaining('completed result'),
        });
        expect(put).toHaveBeenCalledTimes(2);
      }
      expect(record.operationId).toBe('card');
      expect(checkpointRecovery).toHaveBeenCalled();
    },
  );

  it.each([false, true].flatMap((failStorage) => ['sync', 'async'].map((mode) => ({ failStorage, mode }))))(
    'keeps runtime recovery with a $mode observer failure (storage failure: $failStorage)',
    async ({ failStorage, mode }) => {
      const store = new InMemoryPaymentRecoveryStore();
      const put = store.put.bind(store);
      const completedWrites = vi.fn();
      vi.spyOn(store, 'put').mockImplementation(async (r) => {
        if (r.phase === 'complete') {
          completedWrites();
          if (failStorage) throw new Error('storage unavailable');
        }
        return put(r);
      });
      const { wallet, broadcast } = fakeWallet();
      const service = new PaykitService({ recoveryStore: store, wallet, fetchImpl: routes() });
      const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.pay')!;
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true }), {
        logger: { log: () => {} },
      });
      const checkpointRecovery = vi.fn(() => {
        if (mode === 'async') return Promise.reject(new Error('observer failed'));
        throw new Error('observer failed');
      });
      const result = await runtime.run(action, { ...ctx, checkpointRecovery }, payment, { confirmed: true });
      if (failStorage) {
        expect(result).toMatchObject({
          ok: false,
          errorCode: 'ADAPTER_REQUEST_FAILED',
          recovery: {
            phase: 'complete',
            result: { ok: true, tx_hash: HASH },
            persistenceError: expect.stringContaining('completed result'),
          },
        });
        expect(result.error).not.toContain('operation incomplete');
        expect(result.error).toContain('Save the completed result from recovery data');
        expect(completedWrites).toHaveBeenCalledTimes(2);
      } else expect(result).toMatchObject({ ok: true, output: { ok: true, tx_hash: HASH } });
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(checkpointRecovery).toHaveBeenCalled();
    },
  );
});
