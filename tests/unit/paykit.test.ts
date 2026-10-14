import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PaykitService,
  FilePaymentRecoveryStore,
  InMemoryPaymentRecoveryStore,
  createPaykitActions,
} from '../../plugins/paykit';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { x402RequestKey, paymentRequestKey } from '../../plugins/paykit/recovery';
import { paymentFetch } from '../../plugins/paykit/http';
import {
  TOKEN,
  PAYER,
  HASH,
  PAYTO,
  URL,
  ctx,
  payment,
  session,
  snapshot,
  fakeWallet,
  routes,
  manifest,
} from '../fixtures/paykit';

describe('public PayKit payments', () => {
  it.each(['prepared', 'requesting', 'complete'] as const)(
    'pins a %s x402 recovery intent before any status request or session replay',
    async (phase) => {
      const { wallet, broadcast } = fakeWallet();
      const store = new InMemoryPaymentRecoveryStore();
      const originalTransport = routes();
      const payer = new PaykitService({
        wallet,
        recoveryStore: store,
        fetchImpl: async (url, init) => {
          if (init?.method === 'POST') throw new Error('session response lost');
          return originalTransport(url, init);
        },
      });
      await expect(payer.pay(payment, ctx)).rejects.toMatchObject({ recovery: { phase: 'requesting' } });
      const original = (await store.get(payment.idempotencyKey))!;
      const read = store.get.bind(store);
      const replaced = vi.spyOn(store, 'get').mockImplementation(async (id) =>
        id === original.operationId
          ? {
              ...original,
              phase,
              fingerprint: 'f'.repeat(64),
              sessionCreateBody: JSON.stringify({ token_contract: TOKEN, memo: 'foreign-body' }),
              ...(phase === 'complete' ? { result: { session_id: 'foreign-session', ok: true } } : {}),
            }
          : read(id),
      );
      const fetchImpl = routes();
      const service = new PaykitService({ recoveryStore: store, fetchImpl });
      const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.sessionStatus')!;
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true }), {
        logger: { log: () => {} },
      });
      const run = () =>
        runtime.run(
          action,
          ctx,
          { url: URL, operationId: original.operationId, expectedFingerprint: original.fingerprint },
          { idempotencyKey: 'status-retry' },
        );
      const rejected = await run();
      expect(rejected).toMatchObject({ ok: false, errorCode: 'RECOVERY_REQUIRED' });
      expect(rejected.recovery).toBeUndefined();
      expect(JSON.stringify(rejected)).not.toContain('foreign');
      expect(fetchImpl).not.toHaveBeenCalled();
      replaced.mockRestore();
      expect(await run()).toMatchObject({ ok: true, output: { sessionId: 's1' } });
      expect(fetchImpl.mock.calls).toHaveLength(2);
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', body: original.sessionCreateBody });
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('rejects a contradictory x402 request marker even without a supplied fingerprint', async () => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const record = {
      kind: 'paykit' as const,
      rail: 'x402' as const,
      phase: 'requesting' as const,
      operationId: 'status-marker',
      origin: 'https://pay.example',
      merchantId: 'acme',
      chainId: 4217,
      fingerprint: 'f'.repeat(64),
      sessionCreateBody: JSON.stringify({ token_contract: TOKEN }),
    };
    await recoveryStore.claim(record);
    await recoveryStore.claim({ ...record, operationId: paymentRequestKey(record), fingerprint: 'a'.repeat(64) });
    const fetchImpl = routes();
    await expect(
      new PaykitService({ recoveryStore, fetchImpl }).sessionStatus({ url: URL, operationId: record.operationId }, ctx),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not disclose an unstarted primary through status (pinned: %s)', async (pinned) => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    await recoveryStore.claim({
      kind: 'paykit',
      rail: 'x402',
      phase: 'prepared',
      operationId: 'unstarted',
      origin: 'https://pay.example',
      merchantId: 'acme',
      chainId: 4217,
      payer: PAYER,
      fingerprint: 'a'.repeat(64),
    });
    const fetchImpl = routes();
    const checkpointRecovery = vi.fn();
    const service = new PaykitService({ recoveryStore, fetchImpl });
    const error = await service
      .sessionStatus(
        { url: URL, operationId: 'unstarted', ...(pinned ? { expectedFingerprint: 'a'.repeat(64) } : {}) },
        { ...ctx, checkpointRecovery },
      )
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: expect.stringContaining('operation "unstarted"'),
      recovery: undefined,
    });
    expect(JSON.stringify(error)).not.toContain(PAYER);
    expect(JSON.stringify(error)).not.toContain('a'.repeat(64));
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['fingerprint', 'rail', 'complete', 'missing body'] as const)(
    'does not expose a prepared status record with a contradictory %s marker',
    async (defect) => {
      const recoveryStore = new InMemoryPaymentRecoveryStore();
      const record = {
        kind: 'paykit' as const,
        rail: 'x402' as const,
        phase: 'prepared' as const,
        operationId: 'prepared-status',
        origin: 'https://pay.example',
        merchantId: 'acme',
        chainId: 4217,
        payer: PAYER,
        fingerprint: 'a'.repeat(64),
      };
      await recoveryStore.claim(record);
      await recoveryStore.claim({
        ...record,
        operationId: paymentRequestKey(record),
        phase: 'requesting',
        ...(defect !== 'missing body' ? { sessionCreateBody: JSON.stringify({ token_contract: TOKEN }) } : {}),
        ...(defect === 'fingerprint' ? { fingerprint: 'b'.repeat(64) } : {}),
        ...(defect === 'rail' ? { rail: 'fiat' as const } : {}),
        ...(defect === 'complete' ? { phase: 'complete' as const } : {}),
      });
      const fetchImpl = routes();
      const checkpointRecovery = vi.fn();
      const error = await new PaykitService({ recoveryStore, fetchImpl })
        .sessionStatus({ url: URL, operationId: record.operationId }, { ...ctx, checkpointRecovery })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: undefined });
      expect(JSON.stringify(error)).not.toContain(PAYER);
      expect(checkpointRecovery).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'rail', 'origin', 'merchant'] as const)(
    'classifies a pinned status with a replaced %s as recovery required before I/O',
    async (defect) => {
      const recoveryStore = new InMemoryPaymentRecoveryStore();
      if (defect !== 'missing')
        await recoveryStore.claim({
          kind: 'paykit',
          rail: defect === 'rail' ? 'fiat' : 'x402',
          phase: 'prepared',
          operationId: 'pinned-status',
          origin: defect === 'origin' ? 'https://foreign.example' : 'https://pay.example',
          merchantId: defect === 'merchant' ? 'foreign' : 'acme',
          chainId: 4217,
          fingerprint: 'a'.repeat(64),
        });
      const get = vi.spyOn(recoveryStore, 'get');
      const fetchImpl = routes();
      const service = new PaykitService({ recoveryStore, fetchImpl });
      await expect(
        service.sessionStatus(
          {
            url: URL,
            operationId: 'pinned-status',
            expectedFingerprint: 'a'.repeat(64),
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: undefined });
      expect(get).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['prepared', 'requesting', 'submitting', 'broadcast'] as const)(
    'requires a request marker before trusting a %s x402 primary',
    async (phase) => {
      const recoveryStore = new InMemoryPaymentRecoveryStore();
      await recoveryStore.claim({
        kind: 'paykit',
        rail: 'x402',
        phase,
        operationId: 'missing-marker',
        origin: 'https://pay.example',
        merchantId: 'acme',
        chainId: 4217,
        fingerprint: 'a'.repeat(64),
        sessionCreateBody: JSON.stringify({ token_contract: TOKEN, memo: 'foreign-body' }),
      });
      const fetchImpl = routes();
      const service = new PaykitService({ recoveryStore, fetchImpl });
      await expect(service.sessionStatus({ url: URL, operationId: 'missing-marker' }, ctx)).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        recovery: undefined,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('accepts a completed emergency x402 record without a request marker', async () => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    await recoveryStore.claim({
      kind: 'paykit',
      rail: 'x402',
      phase: 'complete',
      operationId: 'emergency',
      origin: 'https://pay.example',
      merchantId: 'acme',
      chainId: 4217,
      fingerprint: 'a'.repeat(64),
      sessionId: 's1',
      result: { ok: true, tx_hash: HASH },
    });
    const fetchImpl = routes();
    expect(
      await new PaykitService({ recoveryStore, fetchImpl }).sessionStatus(
        {
          url: URL,
          operationId: 'emergency',
          expectedFingerprint: 'a'.repeat(64),
        },
        ctx,
      ),
    ).toMatchObject({ status: 'PAYMENT_CONFIRMED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).not.toBe('POST');
  });

  it('requires a valid fingerprint and an operation ID before pinned status lookup', async () => {
    const service = new PaykitService({ fetchImpl: routes() });
    const get = vi.spyOn(service.recoveryStore, 'get');
    for (const input of [
      { url: URL, sessionId: 's1', expectedFingerprint: 'a'.repeat(64) },
      { url: URL, operationId: 'key', expectedFingerprint: 'invalid' },
    ])
      await expect(service.sessionStatus(input, ctx)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        recovery: undefined,
      });
    expect(get).not.toHaveBeenCalled();
  });
  it.each(['raw', 'broadcast'])(
    'clears a repaired %s checkpoint warning when the payment ends FAILED',
    async (stage) => {
      const { wallet, broadcast } = fakeWallet();
      const replacementHash = `0x${'55'.repeat(32)}`;
      const service = new PaykitService({
        wallet,
        fetchImpl: routes({ snapshot: snapshot({ status: 'FAILED', tx_hash: replacementHash }) }),
      });
      const put = service.recoveryStore.put.bind(service.recoveryStore);
      let failures = 2;
      vi.spyOn(service.recoveryStore, 'put').mockImplementation(async (record) => {
        if ((stage === 'raw' ? !!record.rawSubmissionHash : record.phase === 'broadcast') && failures-- > 0)
          throw new Error('temporary failure');
        return put(record);
      });
      const error = await service.pay(payment, ctx).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: { txHash: replacementHash } });
      expect(error).not.toHaveProperty('recovery.persistenceError');
      expect(await service.recoveryStore.get(payment.idempotencyKey)).toMatchObject({
        phase: 'broadcast',
        txHash: replacementHash,
      });
      expect(await service.recoveryStore.get(payment.idempotencyKey)).not.toHaveProperty('persistenceError');
      expect(broadcast).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['chain', { chain_id: 1 }, 'Session payment chain/token changed'],
    ['token', { token_contract: PAYTO }, 'Session payment chain/token changed'],
    ['session', { session_id: 'foreign' }, 'Invalid or mismatched payment session response'],
    ['missing hash', { tx_hash: undefined }, 'Confirmed session has no transaction hash'],
  ])('stops after one invalid %s status response and preserves its diagnostic', async (_kind, override, message) => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes({ snapshot: snapshot(override as Record<string, unknown>) });
    const service = new PaykitService({ wallet, fetchImpl });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await expect(
        service.pay(
          { ...payment, pollTimeoutMs: 30_000, pollIntervalMs: 10_000 },
          { ...ctx, signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: `${message}; PayKit operation incomplete; inspect recovery data before retrying`,
        recovery: { txHash: HASH },
      });
    } finally {
      clearTimeout(timer);
    }
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/sessions/s1'))).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('retains status polling retries for temporary transport errors', async () => {
    const { wallet } = fakeWallet();
    const route = routes();
    let polls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/sessions/s1') && ++polls === 1) return new Response('{}', { status: 503 });
      return route(url, init);
    });
    expect(await new PaykitService({ wallet, fetchImpl }).pay(payment, ctx)).toMatchObject({ ok: true });
    expect(polls).toBe(2);
  });

  it.each(['reset', 'timeout', 'empty', 'non-JSON'] as const)(
    'retries a %s status body failure and confirms without another transfer',
    async (failure) => {
      const { wallet, broadcast } = fakeWallet();
      const route = routes();
      let polls = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).includes('/sessions/s1') && ++polls === 1) {
          if (failure === 'empty' || failure === 'non-JSON')
            return new Response(failure === 'empty' ? '' : '<html>busy</html>');
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"session_id":'));
                if (failure === 'reset') setTimeout(() => controller.error(new TypeError('connection reset')), 1);
                else
                  init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
              },
            }),
          );
        }
        return route(url, init);
      });
      expect(
        await new PaykitService({ wallet, fetchImpl, requestTimeoutMs: 20 }).pay(
          { ...payment, pollTimeoutMs: 1000 },
          ctx,
        ),
      ).toMatchObject({ ok: true, tx_hash: HASH });
      expect(polls).toBe(2);
      expect(broadcast).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    (['memory', 'file'] as const).flatMap((store) => ['raw', 'broadcast', 'poll'].map((stage) => ({ store, stage }))),
  )('keeps an adopted $store completion terminal after the $stage checkpoint', async ({ store, stage }) => {
    const directory = await mkdtemp(join(tmpdir(), 'paykit-terminal-'));
    try {
      const recoveryStore =
        store === 'memory' ? new InMemoryPaymentRecoveryStore() : new FilePaymentRecoveryStore(directory);
      const put = recoveryStore.put.bind(recoveryStore);
      const adopted = { ok: true, tx_hash: HASH, source: 'concurrent-completion' };
      let installed = false;
      let polls = 0;
      let writesAfterAdoption = 0;
      vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
        if (installed) writesAfterAdoption++;
        if (
          !installed &&
          (stage === 'raw' ? !!record.rawSubmissionHash : stage === 'poll' ? polls > 0 : record.phase === 'broadcast')
        ) {
          installed = true;
          await put({ ...record, phase: 'complete', txHash: HASH, result: adopted });
        }
        return installed ? (await recoveryStore.get(record.operationId))! : put(record);
      });
      const { wallet, broadcast } = fakeWallet();
      const checkpoints: string[] = [];
      const route = routes();
      const service = new PaykitService({
        wallet,
        recoveryStore,
        fetchImpl: async (url, init) => {
          if (String(url).includes('/sessions/s1'))
            return Response.json(
              snapshot({
                status: ++polls < 4 ? 'ORDER_CREATED' : 'FAILED',
                tx_hash: `0x${'55'.repeat(32)}`,
              }),
            );
          return route(url, init);
        },
      });
      expect(
        await service.pay(
          { ...payment, pollTimeoutMs: 1000 },
          { ...ctx, checkpointRecovery: (r) => checkpoints.push(r.phase) },
        ),
      ).toEqual(adopted);
      expect(polls).toBe(4);
      expect(writesAfterAdoption).toBe(0);
      const firstComplete = checkpoints.indexOf('complete');
      expect(firstComplete).toBeGreaterThanOrEqual(0);
      expect(checkpoints.slice(firstComplete).every((phase) => phase === 'complete')).toBe(true);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect((await recoveryStore.get(payment.idempotencyKey))?.result).toEqual(adopted);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(
    ['rawSubmissionHash', 'broadcast'].flatMap((stage) =>
      ['foreign', 'invalid', 'disk'].map((failure) => ({ stage, failure })),
    ),
  )('polls after a $failure journal failure at the post-send $stage checkpoint', async ({ stage, failure }) => {
    const { wallet, broadcast } = fakeWallet();
    vi.mocked(wallet.broadcastErc20!).mockImplementation(async (_token, _to, _amount, options) => {
      await options?.onSignedTransaction?.(HASH);
      return { txHash: HASH };
    });
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    const put = service.recoveryStore.put.bind(service.recoveryStore);
    let failing = false;
    vi.spyOn(service.recoveryStore, 'put').mockImplementation(async (record) => {
      failing ||= stage === 'rawSubmissionHash' ? !!record.rawSubmissionHash : record.phase === 'broadcast';
      if (!failing) return put(record);
      if (failure === 'disk') throw new Error('unavailable');
      return {
        ...record,
        phase: 'complete',
        result: { receiptHeader: 'foreign-receipt' },
        ...(failure === 'foreign' ? { fingerprint: 'foreign-intent' } : { operationId: 'wrong-operation' }),
      };
    });
    const checkpoints: unknown[] = [];
    const error = await service
      .pay(payment, { ...ctx, checkpointRecovery: (r) => checkpoints.push(structuredClone(r)) })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: failure === 'disk' ? 'ADAPTER_REQUEST_FAILED' : 'RECOVERY_REQUIRED',
      recovery: {
        phase: 'complete',
        txHash: HASH,
        signedTxHash: HASH,
        rawSubmissionHash: HASH,
        result: { ok: true, tx_hash: HASH },
        persistenceError: expect.stringContaining('completed result'),
      },
    });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/x402/sessions/s1'))).toBe(true);
    expect(JSON.stringify({ error, checkpoints })).not.toContain('foreign-receipt');
    expect(broadcast).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('clears a transient post-send checkpoint failure after status and completion succeed', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const put = service.recoveryStore.put.bind(service.recoveryStore);
    let remaining = 2;
    vi.spyOn(service.recoveryStore, 'put').mockImplementation(async (record) => {
      if (record.rawSubmissionHash && remaining-- > 0) throw new Error('transient failure');
      return put(record);
    });
    expect(await service.pay(payment, ctx)).toMatchObject({ ok: true });
    expect(await service.recoveryStore.get(payment.idempotencyKey)).toMatchObject({ phase: 'complete' });
    expect(await service.recoveryStore.get(payment.idempotencyKey)).not.toHaveProperty('persistenceError');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'abort'] as const)('classifies a chain re-read %s without exposing provider text', async (mode) => {
    const { wallet, broadcast } = fakeWallet();
    const controller = new AbortController();
    vi.spyOn(wallet, 'getChainId')
      .mockResolvedValueOnce(4217)
      .mockImplementation(async () => {
        if (mode === 'abort') controller.abort();
        throw new Error('private provider response');
      });
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    await expect(service.pay(payment, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
      code: mode === 'abort' ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
      message: `${mode === 'abort' ? 'Operation aborted' : 'Cannot read wallet chain'}; PayKit operation incomplete; inspect recovery data before retrying`,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
  it.each([null, 123, ` ${PAYER}`])('validates the x402 payer re-read %j before broadcasting', async (payer) => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    vi.spyOn(wallet, 'getAddress')
      .mockResolvedValueOnce(PAYER)
      .mockResolvedValue(payer as unknown as string);
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Invalid payer address; PayKit operation incomplete; inspect recovery data before retrying',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    '0x1079',
    ' 4217',
    '4217 ',
    '4.217e3',
    '04217',
    '+4217',
    '4217.0',
    '0',
    '-1',
    'not-a-chain',
    '9007199254740992',
  ])('rejects a noncanonical x402 action chain %j before journal or network access', async (chain) => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const get = vi.spyOn(recoveryStore, 'get');
    const claim = vi.spyOn(recoveryStore, 'claim');
    const service = new PaykitService({ wallet, fetchImpl, recoveryStore });
    await expect(service.pay(payment, { ...ctx, network: `eip155:${chain}` })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      recovery: undefined,
    });
    for (const call of [fetchImpl, get, claim, broadcast]) expect(call).not.toHaveBeenCalled();
    expect(await service.pay(payment, ctx)).toMatchObject({ ok: true });
  });
  it('uses runtime parsing once for registered PayKit actions', async () => {
    const service = new PaykitService({ fetchImpl: routes() });
    const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.inspect')!;
    const schema = action.zodInputSchema!;
    const parse = vi.spyOn(schema, 'parse');
    const safeParse = vi.spyOn(schema, 'safeParse');
    try {
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: [ctx.network] }));
      expect((await runtime.run(action, ctx, { url: URL })).ok).toBe(true);
      expect(safeParse).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      safeParse.mockRestore();
    }
  });

  it('does not re-run a requesting record lacking evidence from a known request writer', async () => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    await service.pay(payment, ctx);
    const completed = (await service.recoveryStore.get(payment.idempotencyKey))!;
    const store = new InMemoryPaymentRecoveryStore();
    await store.put({
      ...completed,
      phase: 'requesting',
      result: undefined,
      txHash: undefined,
      sessionId: undefined,
      orderId: undefined,
    });
    const before = fetchImpl.mock.calls.length;
    await expect(
      new PaykitService({ wallet, fetchImpl, recoveryStore: store }).pay(payment, ctx),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(before);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('replays a completed x402 record with a single lookup and no extra claim', async () => {
    const { wallet } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    await service.pay(payment, ctx);
    const get = vi.spyOn(service.recoveryStore, 'get');
    const claim = vi.spyOn(service.recoveryStore, 'claim');
    await service.pay(payment, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('retries a repaired card reservation across file-store instances with one POST', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paykit-card-request-'));
    const input = { url: URL, amount: '1', idempotencyKey: 'retry-card' };
    try {
      const recoveryStore = new FilePaymentRecoveryStore(directory);
      const claim = recoveryStore.claim.bind(recoveryStore);
      vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
        if (record.operationId === paymentRequestKey({ rail: 'fiat', operationId: input.idempotencyKey }))
          throw new Error('request claim unavailable');
        return claim(record);
      });
      const fetchImpl = routes();
      await expect(
        new PaykitService({ recoveryStore, fetchImpl }).createCardCheckout(input, ctx),
      ).rejects.toMatchObject({ recovery: { phase: 'prepared' } });
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      const retry = () => new PaykitService({ recoveryStore: new FilePaymentRecoveryStore(directory), fetchImpl });
      await expect(retry().createCardCheckout({ ...input, amount: '2' }, ctx)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      const results = await Promise.allSettled([
        retry().createCardCheckout(input, ctx),
        retry().createCardCheckout(input, ctx),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cannot overwrite a completed card retry when an older reservation owner resumes', async () => {
    const store = new InMemoryPaymentRecoveryStore();
    const claim = store.claim.bind(store);
    let release!: () => void;
    let notify!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      notify = resolve;
    });
    vi.spyOn(store, 'claim').mockImplementationOnce(async (record) => {
      const result = await claim(record);
      notify();
      await held;
      return result;
    });
    const input = { url: URL, amount: '1', idempotencyKey: 'held-card' };
    const fetchImpl = routes();
    const first = new PaykitService({ fetchImpl, recoveryStore: store })
      .createCardCheckout(input, ctx)
      .catch((error) => error);
    await acquired;
    await new PaykitService({ fetchImpl, recoveryStore: store }).createCardCheckout(input, ctx);
    release();
    await first;
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(await store.get(input.idempotencyKey)).toMatchObject({ phase: 'complete', sessionId: 'cs1' });
  });

  it.each(['x402', 'card'] as const)(
    'does not attach prepared recovery to a %s preflight input error',
    async (rail) => {
      const { wallet } = fakeWallet();
      const recoveryStore = new InMemoryPaymentRecoveryStore();
      const claim = recoveryStore.claim.bind(recoveryStore);
      const fail = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
        if (record.phase === 'requesting') throw new Error('pre-request write failed');
        return claim(record);
      });
      const { amount: _amount, ...base } = payment;
      const input =
        rail === 'card'
          ? { url: URL, productKey: 'mug', idempotencyKey: 'prepared-card' }
          : { ...base, productKey: 'mug' };
      const service = new PaykitService({ wallet, recoveryStore, fetchImpl: routes() });
      await expect(
        rail === 'card'
          ? service.createCardCheckout(input, ctx)
          : service.pay(input as typeof base & { productKey: string }, ctx),
      ).rejects.toMatchObject({ recovery: { phase: 'prepared' } });
      fail.mockRestore();
      const changedManifest = structuredClone(manifest);
      changedManifest.rails.x402.products = [];
      changedManifest.rails.fiat.products = [];
      const fetchImpl = routes({ manifest: changedManifest });
      const next = new PaykitService({ wallet, recoveryStore, fetchImpl });
      const action = createPaykitActions(next).find(
        (action) => action.name === (rail === 'card' ? 'goat.paykit.createCardCheckout' : 'goat.paykit.payProduct'),
      )!;
      const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true }), {
        logger: { log: vi.fn() },
      });
      const result = await runtime.run(action, ctx, input, { confirmed: true });
      expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
      expect(result.recovery).toBeUndefined();
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    },
  );

  it.each(['x402', 'card'] as const)(
    'retains the %s result on persistent completion failure and recovers transient writes',
    async (rail) => {
      for (const persistent of [false, true]) {
        const { wallet, broadcast } = fakeWallet();
        const recoveryStore = new InMemoryPaymentRecoveryStore();
        const put = recoveryStore.put.bind(recoveryStore);
        let failed = false;
        vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
          if (record.phase === 'complete' && (persistent || !failed)) {
            failed = true;
            throw new Error('completion write failed');
          }
          return put(record);
        });
        const fetchImpl = routes();
        const service = new PaykitService({ wallet, recoveryStore, fetchImpl });
        const invoke = () =>
          rail === 'card'
            ? service.createCardCheckout({ url: URL, productKey: 'mug', idempotencyKey: payment.idempotencyKey }, ctx)
            : service.pay(payment, ctx);
        if (persistent) {
          await expect(invoke()).rejects.toMatchObject({
            recovery: {
              phase: 'complete',
              persistenceError: expect.stringContaining('completed result'),
              result: rail === 'card' ? { checkout_id: 'cs1', url: expect.any(String) } : { tx_hash: HASH },
            },
          });
          await expect(invoke()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        } else {
          await expect(invoke()).resolves.toBeDefined();
          expect(await recoveryStore.get(payment.idempotencyKey)).toMatchObject({ phase: 'complete' });
          expect((await recoveryStore.get(payment.idempotencyKey))?.persistenceError).toBeUndefined();
        }
        expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(broadcast).toHaveBeenCalledTimes(rail === 'card' ? 0 : 1);
      }
    },
  );

  it('keeps internal request claims outside the public operation-key namespace', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const claim = vi.spyOn(service.recoveryStore, 'claim');
    await expect(
      service.pay({ ...payment, idempotencyKey: x402RequestKey(payment.idempotencyKey) }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(claim).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('retries a repaired pre-request reservation across file-store instances without duplicate sends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paykit-pre-request-'));
    try {
      const store = new FilePaymentRecoveryStore(directory);
      const claim = store.claim.bind(store);
      vi.spyOn(store, 'claim').mockImplementation(async (record) => {
        if (record.operationId === x402RequestKey(payment.idempotencyKey))
          throw new Error('disk unavailable before request claim');
        return claim(record);
      });
      const { wallet, broadcast } = fakeWallet();
      const fetchImpl = routes();
      await expect(
        new PaykitService({ wallet, recoveryStore: store, fetchImpl }).pay(payment, ctx),
      ).rejects.toMatchObject({ recovery: { phase: 'prepared' } });
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      const restarted = () =>
        new PaykitService({ wallet, fetchImpl, recoveryStore: new FilePaymentRecoveryStore(directory) });
      await expect(restarted().pay({ ...payment, amount: '2' }, ctx)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      const results = await Promise.allSettled([restarted().pay(payment, ctx), restarted().pay(payment, ctx)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(await new FilePaymentRecoveryStore(directory).get(payment.idempotencyKey)).toMatchObject({
        phase: 'complete',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not let an active pre-request owner overwrite a concurrent completed retry', async () => {
    const store = new InMemoryPaymentRecoveryStore();
    const claim = store.claim.bind(store);
    let release!: () => void;
    let notify!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      notify = resolve;
    });
    vi.spyOn(store, 'claim').mockImplementationOnce(async (record) => {
      const result = await claim(record);
      notify();
      await held;
      return result;
    });
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const first = new PaykitService({ wallet, fetchImpl, recoveryStore: store })
      .pay(payment, ctx)
      .catch((error) => error);
    await acquired;
    await new PaykitService({ wallet, fetchImpl, recoveryStore: store }).pay(payment, ctx);
    release();
    await first;
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(await store.get(payment.idempotencyKey)).toMatchObject({ phase: 'complete', txHash: HASH });
  });

  it.each(['primary write', 'claim acknowledgement'])(
    'recovers the session request when the %s fails before POST',
    async (failure) => {
      const store = new InMemoryPaymentRecoveryStore();
      if (failure === 'primary write') vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk write failed'));
      else {
        const claim = store.claim.bind(store);
        vi.spyOn(store, 'claim').mockImplementation(async (record) => {
          const acquired = await claim(record);
          if (record.operationId === x402RequestKey(payment.idempotencyKey)) throw new Error('claim sync failed');
          return acquired;
        });
      }
      const { wallet, broadcast } = fakeWallet();
      const fetchImpl = routes();
      await expect(
        new PaykitService({ wallet, fetchImpl, recoveryStore: store }).pay(payment, ctx),
      ).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      const recovered = new PaykitService({ recoveryStore: store, fetchImpl });
      expect(await recovered.sessionStatus({ url: URL, operationId: payment.idempotencyKey }, ctx)).toMatchObject({
        sessionId: 's1',
      });
      expect(broadcast).not.toHaveBeenCalled();
      await expect(
        new PaykitService({ wallet, fetchImpl, recoveryStore: store }).pay(payment, ctx),
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: { sessionCreateBody: expect.any(String) } });
    },
  );

  it.each(['token', 'fiat'] as const)(
    'classifies invalid %s manifest terms as adapter failures before claiming',
    async (kind) => {
      const broken = structuredClone(manifest);
      if (kind === 'token') broken.rails.x402.tokens[0].token_contract = 'invalid-address';
      else broken.rails.fiat.human_action_required = false;
      const { wallet, broadcast } = fakeWallet();
      const service = new PaykitService({ wallet, fetchImpl: routes({ manifest: broken }) });
      const result =
        kind === 'token'
          ? service.pay({ ...payment, tokenContract: undefined, tokenSymbol: 'USDC' }, ctx)
          : service.createCardCheckout({ url: URL, amount: '1', idempotencyKey: payment.idempotencyKey }, ctx);
      await expect(result).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
      expect(await service.recoveryStore.get(payment.idempotencyKey)).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('replays a completed payment when the chain RPC is unavailable', async () => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    const first = await service.pay(payment, ctx);
    const getChainId = vi.spyOn(wallet, 'getChainId').mockRejectedValue(new Error('RPC offline'));
    fetchImpl.mockRejectedValue(new Error('merchant offline'));
    expect(await service.pay(payment, ctx)).toEqual(first);
    expect(getChainId).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it.each([{ session_id: '..' }, { merchant_id: 'other' }, { expires_at: 0 }])(
    'classifies session creation mismatches as adapter failures (%j)',
    async (change) => {
      const { wallet, broadcast } = fakeWallet();
      const service = new PaykitService({ wallet, fetchImpl: routes({ session: session(change) }) });
      await expect(service.pay(payment, ctx)).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('canonicalizes symbol case and surrounding whitespace for replay', async () => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    await service.pay({ ...payment, tokenSymbol: ' usdc ', amount: ' 1 ', memo: ' invoice ' }, ctx);
    expect(await service.pay({ ...payment, tokenSymbol: 'USDC', amount: '1', memo: 'invoice' }, ctx)).toMatchObject({
      ok: true,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const calls = fetchImpl.mock.calls.length;
    await expect(
      service.pay({ ...payment, tokenSymbol: 'USDC', amount: '1.0', memo: 'invoice' }, ctx),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('validates manually recovered session ids against the original chain and token', async () => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    await recoveryStore.claim({
      kind: 'paykit',
      operationId: 'lost',
      fingerprint: 'intent',
      rail: 'x402',
      phase: 'requesting',
      origin: 'https://pay.example',
      merchantId: 'acme',
      chainId: 4217,
      sessionCreateBody: JSON.stringify({ token_contract: TOKEN }),
    });
    const record = (await recoveryStore.get('lost'))!;
    await recoveryStore.claim({ ...record, operationId: paymentRequestKey(record) });
    const fetchImpl = routes();
    const service = new PaykitService({ recoveryStore, fetchImpl });
    expect(await service.sessionStatus({ url: URL, operationId: 'lost', sessionId: 's1' }, ctx)).toMatchObject({
      sessionId: 's1',
      txHash: HASH,
    });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const different = new PaykitService({
      recoveryStore,
      fetchImpl: routes({ snapshot: snapshot({ token_contract: PAYTO }) }),
    });
    await expect(
      different.sessionStatus({ url: URL, operationId: 'lost', sessionId: 's1' }, ctx),
    ).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED', message: expect.stringMatching(/token changed/) });
  });

  it.each(['inspect', 'pay', 'createCardCheckout', 'payMpp', 'sessionStatus'] as const)(
    'classifies malformed links in %s as input errors',
    async (name) => {
      const { wallet } = fakeWallet();
      const fetchImpl = routes();
      const service = new PaykitService({ wallet, fetchImpl });
      const url = 'https://pay.example/unrelated';
      const result =
        name === 'inspect'
          ? service.inspect(url, ctx)
          : name === 'pay'
            ? service.pay({ ...payment, url }, ctx)
            : name === 'createCardCheckout'
              ? service.createCardCheckout({ url, amount: '1' }, ctx)
              : name === 'payMpp'
                ? service.payMpp({ url, route: 'route' }, ctx)
                : service.sessionStatus({ url, sessionId: 's1' }, ctx);
      await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT', cause: expect.any(Error) });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('classifies manifest failures without echoing server errors', async () => {
    const service = new PaykitService({
      fetchImpl: async () => Response.json({ error: 'private-server-data' }, { status: 503 }),
    });
    const error = await service.inspect(URL, ctx).catch((e) => e);
    expect(error).toMatchObject({ code: 'ADAPTER_REQUEST_FAILED', cause: expect.any(Error) });
    expect(error.message).not.toContain('private-server-data');
  });

  it('exposes final recovery after a timeout to SDK callers without serializing the settlement promise', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { wallet, broadcast } = fakeWallet();
    broadcast.mockImplementationOnce(async () => {
      await pending;
      return { txHash: HASH };
    });
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.pay')!;
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { logger: { log: vi.fn() } },
    );
    const result = await runtime.run(action, ctx, payment, { confirmed: true, timeoutMs: 20 });
    expect(result).toMatchObject({ errorCode: 'TIMEOUT', recovery: { phase: 'submitting' } });
    expect(result.settled).toBeInstanceOf(Promise);
    expect(JSON.stringify(result)).not.toContain('settled');
    release();
    expect(await result.settled).toMatchObject({ txHash: HASH, phase: 'broadcast' });
    expect(await service.recoveryStore.get(payment.idempotencyKey)).toMatchObject({ txHash: HASH });
  });

  it('cancels a stalled chain read immediately and settles without claiming a payment', async () => {
    const { wallet } = fakeWallet();
    wallet.getChainId = () => new Promise(() => {});
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.pay')!;
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { logger: { log: vi.fn() } },
    );
    const abort = new AbortController();
    const pending = runtime.run(action, { ...ctx, signal: abort.signal }, payment, {
      confirmed: true,
      timeoutMs: 120000,
    });
    setTimeout(() => abort.abort(), 10);
    const result = await pending;
    expect(result.errorCode).toBe('ABORTED');
    expect(await result.settled).toBeUndefined();
    expect(await service.recoveryStore.get(payment.idempotencyKey)).toBeUndefined();
  });
  it.each([
    { tokenContract: PAYTO },
    { productKey: 'missing', amount: undefined },
    { amount: '0.0000001' },
    { amount: '0.1' },
    { amount: '3' },
    { memo: '界'.repeat(100) },
  ])('does not claim keys for local preflight errors: %j', async (patch) => {
    const catalog = structuredClone(manifest);
    Object.assign(catalog.rails.x402.tokens[0], { min_amount_wei: '500000', max_amount_wei: '2000000' });
    const fetchImpl = routes({ manifest: catalog });
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl, recoveryStore });
    const error = await service.pay({ ...payment, ...patch }, ctx).catch((e) => e);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(error.recovery).toBeUndefined();
    expect(await recoveryStore.get(payment.idempotencyKey)).toBeUndefined();
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    await expect(service.pay(payment, ctx)).resolves.toMatchObject({ ok: true });
  });

  it.each([{ amount: '1.001' }, { productKey: 'missing' }, { amount: '1', memo: '界'.repeat(100) }])(
    'card validation leaves its key reusable: %j',
    async (patch) => {
      const recoveryStore = new InMemoryPaymentRecoveryStore();
      const fetchImpl = routes();
      const service = new PaykitService({ fetchImpl, recoveryStore });
      await expect(
        service.createCardCheckout({ url: URL, idempotencyKey: 'card-1', ...patch }, ctx),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await recoveryStore.get('card-1')).toBeUndefined();
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      await expect(
        service.createCardCheckout({ url: URL, idempotencyKey: 'card-1', amount: '1' }, ctx),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it('preserves malformed submission evidence without treating it as a validated hash', async () => {
    const { wallet, broadcast } = fakeWallet();
    broadcast.mockResolvedValueOnce({ txHash: 'unexpected-wallet-hash' });
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const service = new PaykitService({ wallet, fetchImpl: routes(), recoveryStore });
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({
      recovery: { rawSubmissionHash: 'unexpected-wallet-hash', phase: 'submitting' },
    });
    const record = await recoveryStore.get(payment.idempotencyKey);
    expect(record?.rawSubmissionHash).toBe('unexpected-wallet-hash');
    expect(record?.txHash).toBeUndefined();
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not write duplicate hashes on successive status polls', async () => {
    const { wallet } = fakeWallet();
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const writes = vi.spyOn(recoveryStore, 'put');
    let polls = 0;
    const fetchImpl = routes();
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation((url, init) =>
      String(url).includes('/sessions/s1')
        ? Promise.resolve(Response.json(snapshot({ status: ++polls < 4 ? 'ORDER_CREATED' : 'PAYMENT_CONFIRMED' })))
        : original(url, init),
    );
    await new PaykitService({ wallet, fetchImpl, recoveryStore }).pay({ ...payment, pollTimeoutMs: 1000 }, ctx);
    expect(polls).toBe(4);
    expect(writes.mock.calls.filter(([r]) => r.phase === 'broadcast')).toHaveLength(1);
  });

  it.each(['sessionStatus', 'resumeMpp'])('blocks %s under a read-only policy', async (name) => {
    const service = new PaykitService();
    const action = createPaykitActions(service).find((a) => a.name.endsWith(`.${name}`))!;
    const execute = vi.spyOn(action, 'execute');
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: false }),
    );
    const result = await runtime.run(action, ctx, { url: URL, operationId: 'existing' });
    expect(result).toMatchObject({ ok: false, errorCode: 'POLICY_BLOCKED' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses the trusted origin, broadcasts once, and reuses the completed journal entry', async () => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    expect(await service.pay(payment, ctx)).toMatchObject({ ok: true, tx_hash: HASH, session_id: 's1' });
    await service.pay(payment, ctx);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(TOKEN, PAYTO, '1000000', expect.any(Object));
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith('https://pay.example/'))).toBe(true);
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'error' && init.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it('validates a product quote and submits the product key', async () => {
    const { wallet } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    const { amount: _amount, ...input } = payment;
    const result = await service.pay({ ...input, productKey: 'mug' }, ctx);
    expect(result.product_key).toBe('mug');
    const [, init] = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ product_key: 'mug', idempotency_key: 'invoice-1' });
  });

  it.each([
    ['expiry', () => session({ expires_at: 1 })],
    ['merchant', () => session({ merchant_id: 'other' })],
    [
      'amount',
      () =>
        session({
          x402: {
            accepts: [{ scheme: 'exact', network: 'eip155:4217', asset: TOKEN, payTo: PAYTO, amount: '2000000' }],
          },
        }),
    ],
    ['state', () => session({ status: 'INVOICED' })],
  ])('rejects invalid %s before transferring', async (_label, build) => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes({ session: build() }) });
    await expect(service.pay(payment, ctx)).rejects.toThrow();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects a wallet or policy context on a different chain', async () => {
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const service = new PaykitService({ wallet, fetchImpl });
    await expect(service.pay(payment, { ...ctx, network: 'goat-testnet' })).rejects.toThrow(/context/);
    wallet.getChainId = async () => 1;
    await expect(service.pay(payment, ctx)).rejects.toThrow(/Wallet chain/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('never sends again for a reused server session', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes({ session: session({ reused: true }) }) });
    expect(await service.pay(payment, ctx)).toMatchObject({ ok: true, reused: true });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('returns a recoverable hash after polling failure and blocks another send', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes({ failStatus: true }) });
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      recovery: { phase: 'broadcast', txHash: HASH, sessionId: 's1' },
    });
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not treat mismatched status snapshots as payment confirmation', async () => {
    const { wallet } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes({ snapshot: snapshot({ session_id: 'other' }) }) });
    await expect(service.pay(payment, ctx)).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message:
        'Invalid or mismatched payment session response; PayKit operation incomplete; inspect recovery data before retrying',
      recovery: { txHash: HASH },
    });
  });

  it('retains the broadcast hash when the caller aborts during submission', async () => {
    const controller = new AbortController();
    const { wallet, broadcast } = fakeWallet();
    broadcast.mockImplementation(async () => {
      controller.abort();
      return { txHash: HASH };
    });
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    await expect(service.pay(payment, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
      recovery: { txHash: HASH, phase: 'broadcast' },
    });
    expect((await service.recoveryStore.get(payment.idempotencyKey))?.txHash).toBe(HASH);
  });

  it('claims an intent before any concurrent attempt can broadcast and rejects changed terms', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const results = await Promise.allSettled([service.pay(payment, ctx), service.pay(payment, ctx)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await expect(service.pay({ ...payment, amount: '2' }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.pay(payment, { ...ctx, idempotencyKey: 'other' })).rejects.toThrow(/Conflicting/);
  });

  it('reads status by operation ID after a failed payment without another transfer', async () => {
    const { wallet, broadcast } = fakeWallet();
    const store = new InMemoryPaymentRecoveryStore();
    await new PaykitService({ wallet, recoveryStore: store, fetchImpl: routes({ failStatus: true }) })
      .pay(payment, ctx)
      .catch(() => {});
    const readOnly = new PaykitService({ recoveryStore: store, fetchImpl: routes() });
    expect(await readOnly.sessionStatus({ url: URL, operationId: payment.idempotencyKey }, ctx)).toMatchObject({
      status: 'PAYMENT_CONFIRMED',
      txHash: HASH,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it.each(['amount', 'product'] as const)(
    'recovers a lost %s session response after restart without a wallet',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'paykit-lost-session-'));
      try {
        const { wallet, broadcast } = fakeWallet();
        const transport = routes();
        let originalBody: string | undefined;
        const service = new PaykitService({
          wallet,
          recoveryStore: new FilePaymentRecoveryStore(directory),
          fetchImpl: async (url, init) => {
            if (init?.method === 'POST') {
              originalBody = String(init.body);
              throw new TypeError('Response lost after server committed the session');
            }
            return transport(url, init);
          },
        });
        const { amount: _amount, ...base } = payment;
        const input = kind === 'product' ? { ...base, productKey: 'mug' } : payment;
        await expect(service.pay(input, ctx)).rejects.toMatchObject({
          recovery: { phase: 'requesting' },
        });
        const replay = routes({ session: session({ reused: true }) });
        const restarted = new PaykitService({
          recoveryStore: new FilePaymentRecoveryStore(directory),
          fetchImpl: replay,
        });
        expect(await restarted.sessionStatus({ url: URL, operationId: payment.idempotencyKey }, ctx)).toMatchObject({
          sessionId: 's1',
          status: 'PAYMENT_CONFIRMED',
          txHash: HASH,
        });
        expect(replay.mock.calls).toHaveLength(2);
        expect(replay.mock.calls[0][1]).toMatchObject({ method: 'POST', body: originalBody });
        expect(String(replay.mock.calls[1][0])).toMatch(/\/sessions\/s1$/);
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('never transfers or overwrites an active journal when session recovery returns a fresh session', async () => {
    const { wallet, broadcast } = fakeWallet();
    const store = new InMemoryPaymentRecoveryStore();
    const transport = routes();
    const service = new PaykitService({
      wallet,
      recoveryStore: store,
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') throw new TypeError('Request never reached the server');
        return transport(url, init);
      },
    });
    await expect(service.pay(payment, ctx)).rejects.toThrow();
    const replay = routes({
      session: session({ reused: false }),
      snapshot: snapshot({ status: 'ORDER_CREATED', tx_hash: '' }),
    });
    const put = vi.spyOn(store, 'put');
    const restarted = new PaykitService({ wallet, recoveryStore: store, fetchImpl: replay });
    expect(await restarted.sessionStatus({ url: URL, operationId: payment.idempotencyKey }, ctx)).toMatchObject({
      sessionId: 's1',
      status: 'ORDER_CREATED',
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    await expect(restarted.pay(payment, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('creates a card link without a wallet and guards duplicate creation locally', async () => {
    const fetchImpl = routes();
    const service = new PaykitService({ fetchImpl });
    const input = { url: URL, productKey: 'mug', idempotencyKey: 'card-1' };
    expect(await service.createCardCheckout(input, ctx)).toMatchObject({ human_action_required: true, rail: 'fiat' });
    await service.createCardCheckout(input, ctx);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('persists failed submissions across service and journal restarts with private files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paykit-'));
    try {
      const { wallet, broadcast } = fakeWallet();
      const service = new PaykitService({
        wallet,
        recoveryStore: new FilePaymentRecoveryStore(directory),
        fetchImpl: routes({ failStatus: true }),
      });
      await expect(service.pay(payment, ctx)).rejects.toThrow();
      const restarted = new PaykitService({
        wallet,
        recoveryStore: new FilePaymentRecoveryStore(directory),
        fetchImpl: routes(),
      });
      await expect(restarted.pay(payment, ctx)).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        recovery: { txHash: HASH },
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('payment transport and runtime recovery', () => {
  it('does not let the runtime cache hide changed payment terms or conflicting keys', async () => {
    const { wallet, broadcast } = fakeWallet();
    const service = new PaykitService({ wallet, fetchImpl: routes() });
    const action = createPaykitActions(service).find((a) => a.name === 'goat.paykit.pay')!;
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { logger: { log: vi.fn() } },
    );
    const opts = { confirmed: true, idempotencyKey: payment.idempotencyKey };
    expect((await runtime.run(action, ctx, payment, opts)).ok).toBe(true);
    expect(await runtime.run(action, ctx, { ...payment, amount: '2' }, opts)).toMatchObject({
      ok: false,
      errorCode: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await runtime.run(action, ctx, { ...payment, idempotencyKey: 'other' }, opts)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects, off-origin requests, and aborted requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const transport = paymentFetch('https://pay.example', { fetchImpl });
    await expect(transport('https://evil.example/x')).rejects.toThrow(/trusted origin/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      paymentFetch('https://pay.example', { fetchImpl, signal: controller.signal })('https://pay.example/x'),
    ).rejects.toThrow(/aborted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns timeout checkpoints without exposing them to hooks or retrying the action', async () => {
    const log = vi.fn();
    const onActionError = vi.fn();
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { maxRetries: 3, noRetryHighRiskWrites: false, logger: { log }, hooks: { onActionError } },
    );
    let release!: () => void;
    const execute = vi.fn(async (context) => {
      context.checkpointRecovery({
        kind: 'paykit',
        operationId: 'invoice-1',
        phase: 'broadcast',
        txHash: HASH,
        receipt: 'private-receipt',
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const result = await runtime.run(
      {
        name: 'test.payment',
        description: '',
        riskLevel: 'high',
        networks: [],
        requiresConfirmation: true,
        retryable: false,
        execute,
      },
      ctx,
      {},
      { confirmed: true, timeoutMs: 10 },
    );
    release();
    expect(result).toMatchObject({ ok: false, errorCode: 'TIMEOUT', attempts: 1, recovery: { txHash: HASH } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.mock.calls, onActionError.mock.calls])).not.toContain('private-receipt');
  });

  it('exports seven schema-validated actions with non-retryable writes', () => {
    const actions = createPaykitActions(new PaykitService());
    expect(actions).toHaveLength(7);
    expect(
      actions
        .find((a) => a.name.endsWith('.payMpp'))!
        .zodInputSchema!.safeParse({ url: URL, route: 'GET:api:data', maxAmountWei: 'not-a-number' }).success,
    ).toBe(false);
    expect(actions.filter((a) => a.requiresConfirmation).every((a) => a.retryable === false)).toBe(true);
    expect(
      actions.find((a) => a.name.endsWith('.pay'))!.zodInputSchema!.safeParse({ ...payment, amount: '0' }).success,
    ).toBe(false);
  });
});
