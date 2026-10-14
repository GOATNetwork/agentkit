import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Signer } from 'ethers';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { PaykitService, createPaykitActions } from '../../plugins/paykit';
import { paymentJournal } from '../../plugins/paykit/journal';
import {
  FilePaymentRecoveryStore,
  InMemoryPaymentRecoveryStore,
  paymentFingerprint,
  paymentRequestKey,
  readPaymentRecovery,
  replayResult,
  type PaymentRecovery,
  type PaymentRecoveryStore,
} from '../../plugins/paykit/recovery';
import { URL, HASH, PAYER, ctx, payment, fakeWallet, routes } from '../fixtures/paykit';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const complete: PaymentRecovery = {
  kind: 'paykit',
  operationId: payment.idempotencyKey,
  fingerprint: 'intent',
  rail: 'mpp',
  phase: 'complete',
  origin: 'https://pay.example',
  merchantId: 'acme',
  chainId: 4217,
  payer: PAYER,
  txHash: HASH,
  result: { receiptHeader: 'private-receipt' },
};
const backends = ['memory', 'file', 'custom'] as const;
async function withRecord(backend: (typeof backends)[number], record: PaymentRecovery): Promise<PaymentRecoveryStore> {
  if (backend === 'file') {
    const directory = await mkdtemp(join(tmpdir(), 'paykit-corrupt-'));
    directories.push(directory);
    await writeFile(join(directory, `${paymentFingerprint(record.operationId)}.json`), JSON.stringify(record));
    return new FilePaymentRecoveryStore(directory);
  }
  if (backend === 'memory') {
    const store = new InMemoryPaymentRecoveryStore();
    await store.claim(record);
    return store;
  }
  return { get: vi.fn(async () => structuredClone(record)), claim: vi.fn(), put: vi.fn() };
}
function runtime() {
  return new ExecutionRuntime(
    new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true, maxRiskWithoutConfirm: 'high' }),
    { logger: { log: () => {} } },
  );
}

describe.each(backends)('stored x402 request validation (%s)', (backend) => {
  const bodies = [
    '{"private_note":PRIVATE-STORED-773}',
    'null',
    '[]',
    '',
    '{}',
    '{"token_contract":null}',
    '{"token_contract":42}',
    '{"token_contract":"not-an-address"}',
    null,
    42,
  ];
  it('keeps a corrupt request out of runtime results, logs and error hooks', async () => {
    const recoveryStore = await withRecord(backend, {
      ...complete,
      rail: 'x402',
      phase: 'requesting',
      sessionId: 's1',
      sessionCreateBody: '{"private_note":PRIVATE-STORED-773}',
    });
    const fetchImpl = routes();
    const service = new PaykitService({ recoveryStore, fetchImpl });
    const log = vi.fn();
    const onActionError = vi.fn();
    const runner = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true, maxRiskWithoutConfirm: 'high' }),
      { logger: { log }, hooks: { onActionError } },
    );
    const action = createPaykitActions(service).find((action) => action.name === 'goat.paykit.sessionStatus')!;
    const result = await runner.run(action, ctx, { url: URL, operationId: complete.operationId });
    expect(result).toMatchObject({ ok: false, errorCode: 'RECOVERY_REQUIRED' });
    expect(result.recovery).toBeUndefined();
    expect(onActionError).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'RECOVERY_REQUIRED' }));
    expect(inspect([result, log.mock.calls, onActionError.mock.calls], { depth: 20 })).not.toContain(
      'PRIVATE-STORED-773',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(bodies.flatMap((body) => [false, true].map((marker) => ({ body, marker }))))(
    'rejects corrupt body $body before status/recovery I/O (marker: $marker)',
    async ({ body, marker }) => {
      const primary: PaymentRecovery = { ...complete, rail: 'x402', phase: 'prepared', result: undefined };
      const id = marker ? paymentRequestKey(primary) : primary.operationId;
      const corrupt = { ...primary, operationId: id, phase: 'requesting' as const, sessionCreateBody: body as string };
      const backing = await withRecord(backend, corrupt);
      const recoveryStore: PaymentRecoveryStore = marker
        ? {
            claim: (r) => backing.claim(r),
            put: (r) => backing.put(r),
            get: async (key) => (key === primary.operationId ? structuredClone(primary) : backing.get(key)),
          }
        : backing;
      const fetchImpl = routes();
      const checkpointRecovery = vi.fn();
      const service = new PaykitService({ recoveryStore, fetchImpl });
      for (const sessionId of [undefined, 's1']) {
        const error = await service
          .sessionStatus({ url: URL, operationId: primary.operationId, sessionId }, { ...ctx, checkpointRecovery })
          .catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          recovery: undefined,
          message: expect.stringContaining('invalid x402 session creation body'),
        });
        expect(inspect(error, { depth: 10 })).not.toContain('PRIVATE-STORED-773');
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(checkpointRecovery).not.toHaveBeenCalled();
    },
  );
});

describe('corrupt recovery reads', () => {
  it.each(
    (['pay', 'payProduct', 'createCardCheckout'] as const).flatMap((method) =>
      ['fingerprint', 'operationId'].map((defect) => ({ method, defect })),
    ),
  )(
    'reports a completed $method as recovery required when its store returns a wrong $defect',
    async ({ method, defect }) => {
      const backing = new InMemoryPaymentRecoveryStore();
      const completions = vi.fn();
      const recoveryStore: PaymentRecoveryStore = {
        get: (id) => backing.get(id),
        claim: (record) => backing.claim(record),
        put: async (record) => {
          if (record.phase !== 'complete') return backing.put(record);
          completions();
          return { ...record, [defect]: 'foreign', result: { receiptHeader: 'foreign-private-receipt' } };
        },
      };
      const { wallet, broadcast } = fakeWallet();
      const fetchImpl = routes();
      const service = new PaykitService({ wallet, fetchImpl, recoveryStore });
      const run = () =>
        method === 'pay'
          ? service.pay(payment, ctx)
          : method === 'payProduct'
            ? service.pay({ ...payment, amount: undefined, productKey: 'mug' }, ctx)
            : service.createCardCheckout({ url: URL, amount: '1', idempotencyKey: payment.idempotencyKey }, ctx);
      const error = await run().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: expect.stringContaining('do not send another payment or create a new intent key'),
        recovery: {
          phase: 'complete',
          result: method !== 'createCardCheckout' ? { ok: true, tx_hash: HASH } : { checkout_id: 'cs1' },
          persistenceError: expect.stringContaining('completed result'),
        },
      });
      expect(String(error)).not.toContain('operation incomplete');
      expect(JSON.stringify(error)).not.toContain('foreign-private-receipt');
      expect(completions).toHaveBeenCalledTimes(2);
      fetchImpl.mockClear();
      await expect(run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledTimes(method !== 'createCardCheckout' ? 1 : 0);
    },
  );
  it.each(['pay', 'createCardCheckout'] as const)(
    'accepts null misses for a fresh %s and its replay',
    async (method) => {
      const backing = new InMemoryPaymentRecoveryStore();
      const recoveryStore: PaymentRecoveryStore = {
        get: async (id) => (await backing.get(id)) ?? null,
        claim: (record) => backing.claim(record),
        put: (record) => backing.put(record),
      };
      const { wallet, broadcast } = fakeWallet();
      const fetchImpl = routes();
      const service = new PaykitService({ wallet, fetchImpl, recoveryStore });
      const run = () =>
        method === 'pay'
          ? service.pay(payment, ctx)
          : service.createCardCheckout({ url: URL, amount: '1', idempotencyKey: payment.idempotencyKey }, ctx);
      const result = await run();
      fetchImpl.mockClear();
      expect(await run()).toEqual(result);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledTimes(method === 'pay' ? 1 : 0);
    },
  );

  it.each([undefined, null])('normalizes a missing custom-store value %s to undefined', async (missing) => {
    const store: PaymentRecoveryStore = { get: async () => missing, claim: vi.fn(), put: vi.fn() };
    expect(await readPaymentRecovery(store, complete.operationId)).toBeUndefined();
  });

  it.each([false, true])('accepts a retained completion only for the same intent (matching: %s)', async (matching) => {
    const record: PaymentRecovery = { ...complete, phase: 'broadcast', result: undefined };
    const retained = { ...complete, fingerprint: matching ? record.fingerprint : 'foreign-intent' };
    const store: PaymentRecoveryStore = {
      get: vi.fn(),
      claim: vi.fn(),
      put: vi.fn(async () => structuredClone(retained)),
    };
    const checkpoints: unknown[] = [];
    const journal = paymentJournal(store, record, {
      checkpointRecovery: (value) => checkpoints.push(structuredClone(value)),
    });
    if (matching) {
      await journal.save({});
      expect(record).toEqual(retained);
      expect(checkpoints.at(-1)).toEqual(retained);
    } else {
      await expect(journal.save({})).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', recovery: undefined });
      await expect(journal.flush()).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', recovery: undefined });
      expect(record).toMatchObject({ fingerprint: 'intent', phase: 'broadcast', result: undefined });
      expect(JSON.stringify(checkpoints)).not.toContain('private-receipt');
      expect(JSON.stringify(checkpoints)).not.toContain('foreign-intent');
    }
  });

  it('classifies a corrupt x402 chain as journal corruption before reading merchant status', async () => {
    const recoveryStore = await withRecord('custom', { ...complete, rail: 'x402', chainId: 0 });
    const fetchImpl = vi.fn();
    const service = new PaykitService({ recoveryStore, fetchImpl });
    await expect(service.sessionStatus({ url: URL, operationId: complete.operationId }, ctx)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: expect.stringContaining('missing or invalid chain ID'),
      recovery: undefined,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(backends)(
    'rejects invalid chain IDs consistently in %s journals without disclosing stored data',
    async (backend) => {
      for (const rail of ['x402', 'mpp'] as const) {
        for (const chainId of [undefined, null, '4217', 0, -1, 1.5, NaN, Infinity]) {
          const store = await withRecord(backend, { ...complete, rail, chainId } as PaymentRecovery);
          const error = await readPaymentRecovery(store, complete.operationId).catch((error: Error) => error);
          expect(error).toMatchObject({
            code: 'RECOVERY_REQUIRED',
            message: expect.stringContaining('missing or invalid chain ID'),
            recovery: undefined,
          });
          expect(JSON.stringify(error)).not.toContain('private-receipt');
          if (backend !== 'custom')
            await expect(store.get(complete.operationId)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        }
      }
    },
  );

  it.each(backends)(
    'distinguishes completed intent results from compact request markers in %s journals',
    async (backend) => {
      for (const rail of ['x402', 'mpp', 'fiat', 'order', 'checkout'] as const) {
        const missing = { ...complete, rail, result: undefined };
        const store = await withRecord(backend, missing);
        await expect(readPaymentRecovery(store, missing.operationId)).rejects.toMatchObject({
          code: 'RECOVERY_REQUIRED',
          message: expect.stringContaining('completed payment has no result'),
          recovery: undefined,
        });
        expect(() => replayResult(missing)).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
        const marker = { ...missing, operationId: paymentRequestKey(missing) };
        const markerStore = await withRecord(backend, marker);
        expect(await readPaymentRecovery(markerStore, marker.operationId)).toEqual(marker);
        // A valid compact marker still cannot be replayed as a completed payment.
        expect(() => replayResult(marker)).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
      }
    },
  );

  it.each(['pay', 'createCardCheckout', 'payMpp', 'resumeMpp'] as const)(
    'does not report runtime success for %s with a missing completion result',
    async (operation) => {
      const rail = operation === 'pay' ? 'x402' : operation === 'createCardCheckout' ? 'fiat' : 'mpp';
      const store = await withRecord('custom', { ...complete, rail, result: undefined });
      const { wallet, broadcast } = fakeWallet();
      const fetchImpl = vi.fn();
      const signer = { getAddress: async () => PAYER, provider: {} } as unknown as Signer;
      const service = new PaykitService({ wallet, mppSigner: signer, recoveryStore: store, fetchImpl });
      const action = createPaykitActions(service).find((a) => a.name === `goat.paykit.${operation}`)!;
      const input =
        operation === 'pay'
          ? payment
          : operation === 'createCardCheckout'
            ? { url: URL, amount: '1', idempotencyKey: complete.operationId }
            : operation === 'payMpp'
              ? { url: URL, route: 'GET:api:data', idempotencyKey: complete.operationId }
              : { url: URL, operationId: complete.operationId };
      const result = await runtime().run(action, ctx, input, { confirmed: true });
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'RECOVERY_REQUIRED',
      });
      expect(result.output).toBeUndefined();
      expect(result.recovery).toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each(['chainId', 'payer'] as const)(
    'does not expose a corrupt MPP receipt or reserve a runtime key when %s is missing',
    async (field) => {
      const store = await withRecord('custom', { ...complete, [field]: undefined, fingerprint: 'foreign-intent' });
      const signer = { getAddress: async () => PAYER } as unknown as Signer;
      const service = new PaykitService({ mppSigner: signer, recoveryStore: store, fetchImpl: vi.fn() });
      const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.resumeMpp')!;
      const executor = runtime();
      const checkpointRecovery = vi.fn();
      const run = () =>
        executor.run(
          action,
          { ...ctx, checkpointRecovery },
          { url: URL, operationId: complete.operationId },
          {
            idempotencyKey: 'resume-corrupt',
          },
        );
      const result = await run();
      expect(result).toMatchObject({ ok: false, errorCode: 'RECOVERY_REQUIRED' });
      expect(result.recovery).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-receipt');
      expect(checkpointRecovery).not.toHaveBeenCalled();
      vi.mocked(store.get).mockImplementation(async (id) =>
        id === complete.operationId ? { ...complete, result: { receiptHeader: 'e30.signature.HS256' } } : undefined,
      );
      expect(await run()).toMatchObject({ ok: true });
    },
  );
});
