import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Signer, type TransactionResponse } from 'ethers';
import { MPPClient } from 'goatflow-sdk';
import { PaykitService, InMemoryPaymentRecoveryStore } from '../../plugins/paykit';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { paykitResumeMppAction } from '../../plugins/paykit/actions';
import { paymentRequestKey, type PaymentRecovery, type PaymentRecoveryStore } from '../../plugins/paykit/recovery';
import { TOKEN, PAYER, PAYTO, HASH, URL, ctx, manifest } from '../fixtures/paykit';

const input = { url: URL, route: 'GET:api:data', idempotencyKey: 'mpp-1', maxVerifyAttempts: 2 };
const receipt = `${Buffer.from(JSON.stringify({ merchant_id: 'acme', note: '支付成功' })).toString('base64url')}.signature.HS256`;
function setup(
  options: { challenge?: Record<string, unknown>; statuses?: number[]; receipt?: string; chainId?: number } = {},
) {
  const send = vi.fn(async () => ({ hash: HASH }));
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: BigInt(options.chainId ?? 4217) })),
    broadcastTransaction: send,
  };
  const signer = {
    provider,
    getAddress: async () => PAYER,
    populateTransaction: vi.fn(async (tx) => tx),
    signTransaction: vi.fn(async () => '0xdeadbeef'),
  } as unknown as Signer;
  let verify = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/manifest.json')) return Response.json(manifest);
    if (String(url).endsWith('/mpp/v1/challenge'))
      return Response.json(
        {
          challenge_id: 'ch1',
          expiry: Math.floor(Date.now() / 1000) + 300,
          amount_wei: '1000000',
          chain_id: 4217,
          token_contract: TOKEN,
          recipient: PAYTO,
          mac: 'private-mac',
          route_pricing_version: 1,
          ...options.challenge,
        },
        { status: 402 },
      );
    if (String(url).endsWith('/mpp/v1/verify')) {
      const statuses = options.statuses ?? [200];
      const status = statuses[Math.min(verify++, statuses.length - 1)];
      return new Response('{}', {
        status,
        headers: status === 200 ? { 'Payment-Receipt': options.receipt ?? receipt } : { 'Retry-After': '0' },
      });
    }
    return new Response('{}', { status: 404 });
  });
  const recoveryStore = new InMemoryPaymentRecoveryStore();
  const service = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore });
  return { service, signer, fetchImpl, send, provider, recoveryStore };
}

afterEach(() => vi.restoreAllMocks());

describe.each(['pay', 'resume'] as const)('MPP %s post-broadcast cancellation', (mode) => {
  it.each([undefined, 2])('retains guidance with verify attempts %s', async (maxVerifyAttempts) => {
    const original = setup({ statuses: [202] });
    if (mode === 'resume')
      await expect(original.service.payMpp({ ...input, maxVerifyAttempts: 1 }, ctx)).rejects.toMatchObject({
        recovery: { txHash: HASH },
      });
    const caller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/mpp/v1/verify')) {
        caller.abort();
        throw caller.signal.reason;
      }
      return original.fetchImpl(url, init);
    });
    const service = new PaykitService({ mppSigner: original.signer, recoveryStore: original.recoveryStore, fetchImpl });
    const pending =
      mode === 'pay'
        ? service.payMpp({ ...input, maxVerifyAttempts }, { ...ctx, signal: caller.signal })
        : service.resumeMpp(
            { url: URL, operationId: input.idempotencyKey, maxVerifyAttempts },
            { ...ctx, signal: caller.signal },
          );
    const error = await pending.catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('Operation aborted'),
      recovery: { operationId: input.idempotencyKey, phase: 'broadcast', txHash: HASH },
    });
    expect(String(error)).toContain('use recovery data');
    expect(original.send).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/mpp/v1/verify'))).toHaveLength(1);
    expect(await original.recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'broadcast', txHash: HASH });
  });
});

describe('GOAT Flow MPP', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not an address', 'USDC'],
  ] as const)('rejects a route whose token contract is %s before claiming the intent', async (_name, contract) => {
    const { signer, fetchImpl: base, send, recoveryStore } = setup();
    const route: Record<string, unknown> = { ...manifest.rails.mpp.routes[0] };
    if (contract === undefined) delete route.token_contract;
    else route.token_contract = contract;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      String(url).endsWith('/manifest.json')
        ? Response.json({ ...manifest, rails: { ...manifest.rails, mpp: { ...manifest.rails.mpp, routes: [route] } } })
        : base(url, init),
    );
    const service = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore });
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: 'MPP route has no valid token contract',
    });
    expect(await recoveryStore.get(input.idempotencyKey)).toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/mpp/v1/challenge'))).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a challenge for another token than the route contract', async () => {
    const { service, send } = setup({ challenge: { token_contract: PAYTO } });
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: expect.stringContaining('MPP challenge exceeds or differs from the selected payment terms'),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(
    (['challenge', 'verify'] as const).flatMap((stage) =>
      (['network', 'deadline', 'abort'] as const).map((failure) => ({ stage, failure })),
    ),
  )('keeps MPP recovery guidance after $failure during $stage before headers', async ({ stage, failure }) => {
    const original = setup();
    const caller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (!String(url).endsWith(`/mpp/v1/${stage}`)) return original.fetchImpl(url, init);
      if (failure === 'network') throw new TypeError('socket reset');
      if (failure === 'abort') caller.abort();
      if (init!.signal!.aborted) throw init!.signal!.reason;
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      );
    });
    const service = new PaykitService({
      mppSigner: original.signer,
      recoveryStore: original.recoveryStore,
      fetchImpl,
      requestTimeoutMs: 20,
    });
    const error = await service
      .payMpp({ ...input, maxVerifyAttempts: 1 }, { ...ctx, signal: caller.signal })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: failure === 'abort' ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
      message: expect.stringContaining(
        failure === 'abort'
          ? 'Operation aborted'
          : failure === 'deadline'
            ? 'Payment API request timed out'
            : 'Payment API request failed',
      ),
      recovery: { operationId: input.idempotencyKey, phase: stage === 'challenge' ? 'requesting' : 'broadcast' },
    });
    expect(String(error)).toContain('use recovery data');
    if (stage === 'verify') expect(error).toMatchObject({ recovery: { txHash: HASH } });
    expect(original.send).toHaveBeenCalledTimes(stage === 'verify' ? 1 : 0);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(`/mpp/v1/${stage}`))).toHaveLength(1);
  });

  it.each([false, true])('detaches cached resume records before completion (write failure: %s)', async (failWrite) => {
    const original = setup({ statuses: [202] });
    await expect(original.service.payMpp(input, ctx)).rejects.toMatchObject({ recovery: { txHash: HASH } });
    const cached = new Map<string, PaymentRecovery>();
    const phasesAtPut: string[] = [];
    const store: PaymentRecoveryStore = {
      claim: (r) => original.recoveryStore.claim(r),
      get: async (id) => {
        if (!cached.has(id)) {
          const stored = await original.recoveryStore.get(id);
          if (stored) cached.set(id, stored);
        }
        return cached.get(id);
      },
      put: async (record) => {
        const previous = cached.get(record.operationId);
        if (record.operationId === input.idempotencyKey) phasesAtPut.push(previous!.phase);
        // A caching store preserves completions; aliasing must not make it
        // mistake an in-memory update for a previously persisted completion.
        if (previous?.phase === 'complete') return previous;
        if (failWrite) throw new Error('disk unavailable');
        await original.recoveryStore.put(record);
        cached.set(record.operationId, structuredClone(record));
      },
    };
    const next = setup();
    const resumed = new PaykitService({ mppSigner: next.signer, fetchImpl: next.fetchImpl, recoveryStore: store });
    const result = resumed.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx);
    if (failWrite) {
      await expect(result).rejects.toMatchObject({
        recovery: {
          phase: 'complete',
          result: { receiptHeader: receipt },
          persistenceError: expect.stringContaining('must be saved'),
        },
      });
      expect(phasesAtPut).toEqual(['broadcast', 'broadcast']);
      expect(cached.get(input.idempotencyKey)?.phase).toBe('broadcast');
    } else {
      await expect(result).resolves.toMatchObject({ receiptHeader: receipt });
      expect(phasesAtPut).toEqual(['broadcast']);
    }
    // Discard the cache to simulate a process restart and read only persisted data.
    cached.clear();
    expect(await store.get(input.idempotencyKey)).toMatchObject({ phase: failWrite ? 'broadcast' : 'complete' });
    if (!failWrite) expect((await store.get(input.idempotencyKey))?.result).toMatchObject({ receiptHeader: receipt });
    expect(next.send).not.toHaveBeenCalled();
    expect(next.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'rail', 'origin', 'merchant'] as const)(
    'rejects a pinned resume with a replaced %s before disclosing recovery',
    async (defect) => {
      const { service, recoveryStore, fetchImpl } = setup();
      if (defect !== 'missing')
        await recoveryStore.claim({
          kind: 'paykit',
          rail: defect === 'rail' ? 'fiat' : 'mpp',
          phase: 'prepared',
          operationId: input.idempotencyKey,
          origin: defect === 'origin' ? 'https://foreign.example' : 'https://pay.example',
          merchantId: defect === 'merchant' ? 'foreign' : 'acme',
          chainId: 4217,
          payer: PAYER,
          fingerprint: 'a'.repeat(64),
        });
      const get = vi.spyOn(recoveryStore, 'get');
      await expect(
        service.resumeMpp({ url: URL, operationId: input.idempotencyKey, expectedFingerprint: 'a'.repeat(64) }, ctx),
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: undefined });
      expect(get).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('persists and replays MPP receipts despite a throwing recovery observer', async () => {
    const { service, send, recoveryStore } = setup();
    const checkpointRecovery = vi.fn(() => {
      throw new Error('observer failed');
    });
    const result = await service.payMpp(input, { ...ctx, checkpointRecovery });
    expect((await recoveryStore.get(input.idempotencyKey))?.phase).toBe('complete');
    expect(
      await service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, { ...ctx, checkpointRecovery }),
    ).toEqual(result);
    expect(send).toHaveBeenCalledTimes(1);
    expect(checkpointRecovery).toHaveBeenCalled();
  });

  it('rejects an unmapped action context before journal, signer or manifest reads', async () => {
    const { service, signer, recoveryStore, fetchImpl, provider } = setup();
    const get = vi.spyOn(recoveryStore, 'get');
    const address = vi.spyOn(signer, 'getAddress');
    await expect(service.payMpp(input, { ...ctx, network: 'unknown-network' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Unknown payment action context'),
      recovery: undefined,
    });
    for (const call of [get, address, fetchImpl, provider.getNetwork]) expect(call).not.toHaveBeenCalled();
  });

  it.each(['error', 'abort'] as const)(
    'preserves the guarded network %s when the MPP SDK wraps it mid-payment',
    async (mode) => {
      const { service, signer, provider, send } = setup();
      const controller = new AbortController();
      provider.getNetwork.mockResolvedValueOnce({ chainId: 4217n }).mockImplementation(async () => {
        if (mode === 'abort') controller.abort();
        throw new Error('private provider response');
      });
      await expect(service.payMpp(input, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
        code: mode === 'abort' ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
        message: `${mode === 'abort' ? 'Operation aborted' : 'Cannot read MPP signer chain'}; MPP operation incomplete (payment_failed); use recovery data`,
      });
      expect(provider.getNetwork).toHaveBeenCalledTimes(2);
      expect(signer.signTransaction).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('clears a repaired storage warning even when MPP verification fails', async () => {
    const { service, recoveryStore, send, fetchImpl } = setup({ statuses: [400] });
    const put = recoveryStore.put.bind(recoveryStore);
    let failures = 2;
    vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
      if (record.phase === 'broadcast' && failures-- > 0) throw new Error('temporary journal failure');
      return put(record);
    });
    const error = await service.payMpp(input, ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      recovery: { txHash: HASH },
    });
    expect(error).not.toHaveProperty('recovery.persistenceError');
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({
      phase: 'broadcast',
      txHash: HASH,
    });
    expect(await recoveryStore.get(input.idempotencyKey)).not.toHaveProperty('persistenceError');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['EIP155:4217', 'Eip155:4217'])('rejects the mixed-case context %s before any read', async (network) => {
    const { service, signer, recoveryStore, fetchImpl, provider } = setup();
    const get = vi.spyOn(recoveryStore, 'get');
    const address = vi.spyOn(signer, 'getAddress');
    await expect(service.payMpp(input, { ...ctx, network })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Invalid EIP-155 action context'),
      recovery: undefined,
    });
    for (const call of [get, address, fetchImpl, provider.getNetwork]) expect(call).not.toHaveBeenCalled();
  });

  it.each(['error', 'abort'] as const)('classifies a signer network %s before reserving an intent', async (mode) => {
    const { service, provider, recoveryStore, send } = setup();
    const controller = new AbortController();
    provider.getNetwork.mockImplementation(async () => {
      if (mode === 'abort') controller.abort();
      throw new Error('private provider response');
    });
    const claim = vi.spyOn(recoveryStore, 'claim');
    await expect(service.payMpp(input, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
      code: mode === 'abort' ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
      message: mode === 'abort' ? 'Operation aborted' : 'Cannot read MPP signer chain',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['marker', 'fingerprint', 'no-marker'] as const)(
    'refuses a foreign completed MPP intent using the original %s evidence, without exposing it',
    async (evidence) => {
      const { service, recoveryStore, fetchImpl, provider, send } = setup();
      const paid = await service.payMpp(input, ctx);
      const original = (await recoveryStore.get(input.idempotencyKey))!;
      const read = recoveryStore.get.bind(recoveryStore);
      const foreign = {
        ...original,
        fingerprint: 'f'.repeat(64),
        route: 'GET:other',
        result: { receiptHeader: 'foreign-invalid-receipt' },
      };
      const markerId = paymentRequestKey(original);
      const get = vi.spyOn(recoveryStore, 'get').mockImplementation(async (id) => {
        if (id === original.operationId) return structuredClone(foreign);
        if (id === markerId && evidence === 'no-marker') return undefined;
        const record = await read(id);
        return record && evidence === 'fingerprint' ? { ...record, fingerprint: foreign.fingerprint } : record;
      });
      fetchImpl.mockClear();
      provider.getNetwork.mockClear();
      const checkpointRecovery = vi.fn();
      const runtime = new ExecutionRuntime(
        new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true, maxRiskWithoutConfirm: 'high' }),
        { logger: { log: () => {} } },
      );
      const run = () =>
        runtime.run(
          paykitResumeMppAction(service),
          { ...ctx, checkpointRecovery },
          {
            url: URL,
            operationId: original.operationId,
            ...(evidence !== 'marker' ? { expectedFingerprint: original.fingerprint } : {}),
          },
          { idempotencyKey: 'resume-pinned' },
        );
      const rejected = await run();
      expect(rejected).toMatchObject({
        ok: false,
        errorCode: 'RECOVERY_REQUIRED',
        error: expect.stringContaining('operation "mpp-1" is unverified'),
      });
      expect(rejected.recovery).toBeUndefined();
      expect(JSON.stringify(rejected)).not.toContain('foreign-invalid-receipt');
      expect(checkpointRecovery).not.toHaveBeenCalled();
      get.mockRestore();
      expect(await run()).toMatchObject({ ok: true, output: paid });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(provider.getNetwork).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('does not expose a replaced primary record when resuming after a broadcast journal conflict', async () => {
    const { service, recoveryStore, send, fetchImpl } = setup();
    const put = recoveryStore.put.bind(recoveryStore);
    let foreign: Awaited<ReturnType<typeof recoveryStore.get>>;
    const read = recoveryStore.get.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
      if (record.phase === 'broadcast' && !foreign)
        foreign = {
          ...record,
          fingerprint: 'f'.repeat(64),
          phase: 'complete',
          result: { receiptHeader: 'foreign-receipt' },
        };
      return foreign ?? put(record);
    });
    const error = await service.payMpp(input, ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: { result: { receiptHeader: receipt } } });
    vi.spyOn(recoveryStore, 'get').mockImplementation(async (id) => (id === input.idempotencyKey ? foreign : read(id)));
    fetchImpl.mockClear();
    const checkpointRecovery = vi.fn();
    await expect(
      service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, { ...ctx, checkpointRecovery }),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', recovery: undefined });
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed expected fingerprints without journal or wallet reads', async () => {
    const { service, signer, recoveryStore } = setup();
    const get = vi.spyOn(recoveryStore, 'get');
    const address = vi.spyOn(signer, 'getAddress');
    for (const expectedFingerprint of ['', 'not-a-hash', 123])
      await expect(
        service.resumeMpp(
          { url: URL, operationId: input.idempotencyKey, expectedFingerprint: expectedFingerprint as string },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', recovery: undefined });
    expect(get).not.toHaveBeenCalled();
    expect(address).not.toHaveBeenCalled();
  });
  it.each([` ${PAYER}`, `${PAYER} `, `0x${'z'.repeat(40)}`])(
    'rejects an invalid signer address before accessing the journal: %s',
    async (payer) => {
      const { service, signer, recoveryStore, fetchImpl, provider, send } = setup();
      const address = vi.spyOn(signer, 'getAddress').mockResolvedValue(payer);
      const get = vi.spyOn(recoveryStore, 'get');
      const claim = vi.spyOn(recoveryStore, 'claim');
      const put = vi.spyOn(recoveryStore, 'put');
      const checkpointRecovery = vi.fn();
      await expect(service.payMpp(input, { ...ctx, checkpointRecovery })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid payer address',
        recovery: undefined,
      });
      for (const call of [get, claim, put, checkpointRecovery, fetchImpl, provider.getNetwork, send])
        expect(call).not.toHaveBeenCalled();
      address.mockResolvedValue(PAYER);
      expect(await service.payMpp(input, ctx)).toMatchObject({ receiptHeader: receipt });
      expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'complete', payer: PAYER });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts null misses from a caller-owned store and replays the completed payment', async () => {
    const { signer, recoveryStore: backing, fetchImpl, send } = setup();
    const recoveryStore: PaymentRecoveryStore = {
      get: async (id) => (await backing.get(id)) ?? null,
      claim: (record) => backing.claim(record),
      put: (record) => backing.put(record),
    };
    const service = new PaykitService({ mppSigner: signer, recoveryStore, fetchImpl });
    const paid = await service.payMpp(input, ctx);
    fetchImpl.mockClear();
    expect(await service.payMpp(input, ctx)).toEqual(paid);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports conflicting terms before a mismatched action chain without publishing recovery', async () => {
    const { service, fetchImpl, provider } = setup();
    await service.payMpp(input, ctx);
    fetchImpl.mockClear();
    provider.getNetwork.mockClear();
    const checkpointRecovery = vi.fn();
    await expect(
      service.payMpp(
        { ...input, route: 'GET:other' },
        {
          ...ctx,
          network: 'eip155:1',
          checkpointRecovery,
        },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.payMpp(input, {
        ...ctx,
        network: 'eip155:1',
        checkpointRecovery,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'Journaled payment chain eip155:4217 does not match action context eip155:1; use action context eip155:4217 to replay this payment',
    });
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getNetwork).not.toHaveBeenCalled();
  });

  it.each([['goat-testnet', 'goat-testnet (eip155:48816)']])(
    'reports the recorded chain and the %s context without invented chain IDs',
    async (network, label) => {
      const { service, fetchImpl, provider } = setup();
      await service.payMpp(input, ctx);
      fetchImpl.mockClear();
      provider.getNetwork.mockClear();
      const checkpointRecovery = vi.fn();
      await expect(service.payMpp(input, { ...ctx, network, checkpointRecovery })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: `Journaled payment chain eip155:4217 does not match action context ${label}; use action context eip155:4217 to replay this payment`,
        recovery: undefined,
      });
      for (const call of [checkpointRecovery, fetchImpl, provider.getNetwork]) expect(call).not.toHaveBeenCalled();
    },
  );

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
  ])('rejects a noncanonical MPP action chain %j on fresh intents and completed replay', async (chain) => {
    const { service, recoveryStore, fetchImpl, provider, send } = setup();
    const claim = vi.spyOn(recoveryStore, 'claim');
    const get = vi.spyOn(recoveryStore, 'get');
    const checkpointRecovery = vi.fn();
    const badContext = { ...ctx, network: `eip155:${chain}`, checkpointRecovery };
    await expect(service.payMpp(input, badContext)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      recovery: undefined,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(provider.getNetwork).not.toHaveBeenCalled();
    expect(checkpointRecovery).not.toHaveBeenCalled();
    const paid = await service.payMpp(input, ctx);
    fetchImpl.mockClear();
    provider.getNetwork.mockClear();
    await expect(service.payMpp(input, badContext)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      recovery: undefined,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getNetwork).not.toHaveBeenCalled();
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(await service.payMpp(input, ctx)).toEqual(paid);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([null, 123, ` ${PAYER}`])('validates a mid-payment MPP payer read %j before signing', async (payer) => {
    const { service, signer, send } = setup();
    vi.spyOn(signer, 'getAddress')
      .mockResolvedValueOnce(PAYER)
      .mockResolvedValue(payer as unknown as string);
    const error = await service.payMpp(input, ctx).catch((error: Error) => error);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(String(error)).toContain('Invalid payer address; MPP operation incomplete');
    expect(String(error)).toContain('use recovery data');
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([null, 123, ` ${PAYER}`])('validates the resumed payer read %j before exposing recovery', async (payer) => {
    const { service, signer, fetchImpl } = setup();
    await service.payMpp(input, ctx);
    fetchImpl.mockClear();
    const checkpointRecovery = vi.fn();
    vi.spyOn(signer, 'getAddress').mockResolvedValue(payer as unknown as string);
    await expect(
      service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, { ...ctx, checkpointRecovery }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid payer address', recovery: undefined });
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['pay', 'resume'].flatMap((method) => ['fingerprint', 'operationId'].map((defect) => ({ method, defect }))))(
    'preserves its completed MPP $method receipt when the journal returns a wrong $defect',
    async ({ method, defect }) => {
      const { service, recoveryStore, send } = setup({ statuses: method === 'resume' ? [202, 200] : [200] });
      if (method === 'resume')
        await expect(service.payMpp({ ...input, maxVerifyAttempts: 1 }, ctx)).rejects.toMatchObject({
          recovery: { txHash: HASH },
        });
      const put = recoveryStore.put.bind(recoveryStore);
      const completions = vi.fn();
      vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
        if (record.phase !== 'complete') return put(record);
        completions();
        return { ...record, [defect]: 'foreign', result: { receiptHeader: 'foreign-private-receipt' } };
      });
      const error = await (
        method === 'pay'
          ? service.payMpp(input, ctx)
          : service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx)
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: expect.stringContaining('Payment operation completed'),
        recovery: {
          phase: 'complete',
          result: { receiptHeader: receipt },
          persistenceError: expect.stringContaining('verified MPP receipt'),
        },
      });
      expect(String(error)).not.toContain('operation incomplete');
      expect(JSON.stringify(error)).not.toContain('foreign-private-receipt');
      expect(completions).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(1);
      await expect(service.payMpp(input, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('enforces the chain allowlist before publishing a completed replay', async () => {
    const { service, signer, fetchImpl, recoveryStore, provider } = setup();
    const paid = await service.payMpp(input, ctx);
    fetchImpl.mockClear();
    provider.getNetwork.mockClear();
    const checkpointRecovery = vi.fn();
    const restricted = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore, allowedChainIds: [1] });
    await expect(restricted.payMpp(input, { ...ctx, checkpointRecovery })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      recovery: undefined,
    });
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(await service.payMpp(input, ctx)).toEqual(paid);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getNetwork).not.toHaveBeenCalled();
  });

  it.each(['prepared', 'requesting', 'complete'] as const)(
    'requires journal repair when a %s record lacks its chain ID',
    async (phase) => {
      const { service, signer, fetchImpl, recoveryStore, provider } = setup();
      await service.payMpp(input, ctx);
      const original = (await recoveryStore.get(input.idempotencyKey))!;
      const damaged = new InMemoryPaymentRecoveryStore();
      await damaged.claim({
        ...original,
        phase,
        chainId: undefined,
        result: undefined,
        txHash: undefined,
        signedTxHash: undefined,
        challenge: undefined,
      });
      fetchImpl.mockClear();
      provider.getNetwork.mockClear();
      const restarted = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore: damaged });
      await expect(restarted.payMpp(input, ctx)).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: expect.stringContaining('missing or invalid chain ID'),
        recovery: undefined,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(provider.getNetwork).not.toHaveBeenCalled();
    },
  );

  it('releases a runtime reservation after a wrong-payer resume input error', async () => {
    const { service, signer, send } = setup();
    await service.payMpp(input, ctx);
    const address = vi.spyOn(signer, 'getAddress').mockResolvedValue(PAYTO);
    const checkpointRecovery = vi.fn();
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { logger: { log: () => {} } },
    );
    const run = () =>
      runtime.run(
        paykitResumeMppAction(service),
        { ...ctx, checkpointRecovery },
        { url: URL, operationId: input.idempotencyKey },
        { idempotencyKey: 'resume-key' },
      );
    const rejected = await run();
    expect(rejected).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(rejected.recovery).toBeUndefined();
    expect(checkpointRecovery).not.toHaveBeenCalled();
    address.mockResolvedValue(PAYER);
    expect(await run()).toMatchObject({ ok: true, output: { receiptHeader: receipt } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['fingerprint', 'rail', 'complete'] as const)(
    'checks the payer before resolving a mismatched %s marker, without retaining their runtime key',
    async (kind) => {
      const { service, signer, recoveryStore, fetchImpl, send } = setup();
      const claim = recoveryStore.claim.bind(recoveryStore);
      const stop = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
        if (record.phase === 'requesting') throw new Error('request not sent');
        return claim(record);
      });
      await service.payMpp(input, ctx).catch(() => {});
      stop.mockRestore();
      const prepared = (await recoveryStore.get(input.idempotencyKey))!;
      const markerId = paymentRequestKey(prepared);
      await recoveryStore.claim({
        ...prepared,
        operationId: markerId,
        phase: 'requesting',
        ...(kind === 'fingerprint'
          ? { fingerprint: 'foreign' }
          : kind === 'rail'
            ? { rail: 'fiat' as const }
            : { phase: 'complete' as const }),
      });
      const get = vi.spyOn(recoveryStore, 'get');
      const address = vi.spyOn(signer, 'getAddress').mockResolvedValue(PAYTO);
      fetchImpl.mockClear();
      const checkpointRecovery = vi.fn();
      const runtime = new ExecutionRuntime(
        new PolicyEngine({ allowedNetworks: [ctx.network], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
        { logger: { log: () => {} } },
      );
      const run = () =>
        runtime.run(
          paykitResumeMppAction(service),
          { ...ctx, checkpointRecovery },
          { url: URL, operationId: input.idempotencyKey },
          { idempotencyKey: 'resume-marker-key' },
        );
      const rejected = await run();
      expect(rejected).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
      expect(rejected.recovery).toBeUndefined();
      expect(checkpointRecovery).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalledWith(markerId);
      address.mockResolvedValue(PAYER);
      const reconciliation = await run();
      expect(reconciliation).toMatchObject({
        ok: false,
        errorCode: 'RECOVERY_REQUIRED',
        error: expect.stringContaining('Reconcile the journal'),
      });
      expect(reconciliation.recovery).toBeUndefined();
      expect((await run()).errorCode).toBe('RECOVERY_REQUIRED');
      expect(get).toHaveBeenCalledWith(markerId);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['removed', 're-chained', 'offline'] as const)(
    'replays a completed payment when the live manifest is %s',
    async (change) => {
      const { service, signer, fetchImpl, recoveryStore, provider, send } = setup();
      const paid = await service.payMpp(input, ctx);
      fetchImpl.mockClear();
      provider.getNetwork.mockRejectedValue(new Error('offline'));
      const changed = structuredClone(manifest);
      if (change === 'removed') changed.rails.mpp.routes = [];
      else changed.rails.mpp.routes[0].chain_id = 1;
      if (change === 'offline') fetchImpl.mockRejectedValue(new Error('offline'));
      else fetchImpl.mockResolvedValue(Response.json(changed));
      const restarted = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore });
      expect(await restarted.payMpp(input, ctx)).toEqual(paid);
      await expect(restarted.payMpp({ ...input, route: 'GET:other' }, ctx)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      await expect(restarted.payMpp({ ...input, maxAmountWei: '2000000' }, ctx)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      await expect(restarted.payMpp(input, { ...ctx, network: 'eip155:1' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('does not change the chain of a prepared intent when its live route moves', async () => {
    const { service, signer, fetchImpl, recoveryStore, send } = setup();
    const claim = recoveryStore.claim.bind(recoveryStore);
    const stop = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
      if (record.phase === 'requesting') throw new Error('request not sent');
      return claim(record);
    });
    await service.payMpp(input, ctx).catch(() => {});
    stop.mockRestore();
    const changed = structuredClone(manifest);
    changed.rails.mpp.routes[0].chain_id = 1;
    fetchImpl.mockResolvedValue(Response.json(changed));
    const checkpointRecovery = vi.fn();
    const restarted = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore });
    await expect(restarted.payMpp(input, { ...ctx, checkpointRecovery })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'prepared', chainId: 4217 });
    expect(checkpointRecovery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith('/manifest.json'))).toBe(true);
  });

  it.each(['fingerprint', 'rail', 'complete'] as const)(
    'requires reconciliation for a %s request marker mismatch on pay and resume',
    async (kind) => {
      const { service, recoveryStore, fetchImpl, send } = setup();
      const claim = recoveryStore.claim.bind(recoveryStore);
      const stop = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
        if (record.phase === 'requesting') throw new Error('request not sent');
        return claim(record);
      });
      await service.payMpp(input, ctx).catch(() => {});
      stop.mockRestore();
      const prepared = (await recoveryStore.get(input.idempotencyKey))!;
      await recoveryStore.claim({
        ...prepared,
        operationId: paymentRequestKey(prepared),
        phase: 'requesting',
        ...(kind === 'fingerprint'
          ? { fingerprint: 'foreign' }
          : kind === 'rail'
            ? { rail: 'fiat' as const }
            : { phase: 'complete' as const }),
      });
      fetchImpl.mockClear();
      for (const run of [
        () => service.payMpp(input, ctx),
        () => service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx),
      ]) {
        await expect(run()).rejects.toMatchObject({
          code: 'RECOVERY_REQUIRED',
          message: expect.stringContaining('Reconcile the journal'),
          recovery: undefined,
        });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('resolves a request-only checkpoint before giving resume guidance', async () => {
    const { service, recoveryStore, fetchImpl, send } = setup();
    const controller = new AbortController();
    const claim = recoveryStore.claim.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
      const claimed = await claim(record);
      if (record.phase === 'requesting') controller.abort();
      return claimed;
    });
    await expect(service.payMpp(input, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'prepared' });
    const checkpointRecovery = vi.fn();
    await expect(
      service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, { ...ctx, checkpointRecovery }),
    ).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      recovery: { phase: 'requesting' },
      message: expect.stringContaining('Payment intent already started'),
    });
    expect(checkpointRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'requesting' }));
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      recovery: { phase: 'requesting' },
    });
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith('/manifest.json'))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['pay', 'resume'] as const)(
    'classifies %s signer address failures without exposing provider text',
    async (operation) => {
      const { service, signer, recoveryStore } = setup();
      if (operation === 'resume') await service.payMpp(input, ctx);
      const cause = new Error('private-provider-payload');
      vi.spyOn(signer, 'getAddress').mockRejectedValue(cause);
      const result =
        operation === 'pay'
          ? service.payMpp(input, ctx)
          : service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx);
      await expect(result).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        cause,
        message: 'Cannot read payer address',
      });
      if (operation === 'pay') expect(await recoveryStore.get(input.idempotencyKey)).toBeUndefined();
    },
  );

  it('retries a prepared MPP reservation once after storage repair, including concurrent callers', async () => {
    const { signer, fetchImpl, send, recoveryStore, service } = setup();
    const claim = recoveryStore.claim.bind(recoveryStore);
    const fail = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
      if (record.operationId === paymentRequestKey({ rail: 'mpp', operationId: input.idempotencyKey }))
        throw new Error('request claim unavailable');
      return claim(record);
    });
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({ recovery: { phase: 'prepared' } });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/challenge'))).toBe(false);
    fail.mockRestore();
    const retry = () => new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore }).payMpp(input, ctx);
    const results = await Promise.allSettled([retry(), retry()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/challenge'))).toHaveLength(1);
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'complete' });
  });

  it.each(['pay', 'resume'] as const)(
    'returns success when the %s completion checkpoint succeeds on retry',
    async (operation) => {
      const { service, recoveryStore, send } = setup({ statuses: operation === 'resume' ? [202] : [200] });
      if (operation === 'resume') await service.payMpp(input, ctx).catch(() => {});
      const put = recoveryStore.put.bind(recoveryStore);
      let failures = 0;
      vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
        if (record.phase === 'complete' && failures++ === 0) throw new Error('transient completion failure');
        await put(record);
      });
      const next = setup();
      const result =
        operation === 'pay'
          ? service.payMpp(input, ctx)
          : new PaykitService({ mppSigner: next.signer, fetchImpl: next.fetchImpl, recoveryStore }).resumeMpp(
              { url: URL, operationId: input.idempotencyKey },
              ctx,
            );
      await expect(result).resolves.toMatchObject({ receiptHeader: receipt });
      const record = await recoveryStore.get(input.idempotencyKey);
      expect(record).toMatchObject({ phase: 'complete' });
      expect(record?.persistenceError).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      expect(next.send).not.toHaveBeenCalled();
    },
  );

  it('classifies an aborted manifest fetch as ABORTED before claiming a key', async () => {
    const { service, fetchImpl, recoveryStore } = setup();
    const abort = new AbortController();
    fetchImpl.mockImplementationOnce(async () => {
      abort.abort();
      throw new Error('fetch aborted');
    });
    await expect(service.payMpp(input, { ...ctx, signal: abort.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await recoveryStore.get(input.idempotencyKey)).toBeUndefined();
  });
  it.each(['populateTransaction', 'signTransaction'] as const)(
    'cancels MPP during %s without broadcasting',
    async (stage) => {
      const controller = new AbortController();
      const { service, signer, send } = setup();
      vi.mocked(signer[stage]).mockImplementationOnce(async () => {
        controller.abort();
        return (stage === 'populateTransaction' ? {} : '0xdeadbeef') as never;
      });
      await expect(service.payMpp(input, { ...ctx, signal: controller.signal })).rejects.toMatchObject({
        code: 'ABORTED',
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('attempts a later checkpoint after a background journal failure', async () => {
    const { service, recoveryStore } = setup();
    const put = recoveryStore.put.bind(recoveryStore);
    const failure = new Error('temporary storage error');
    let failed = false;
    const writes = vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
      if (record.txHash && !failed) {
        failed = true;
        throw failure;
      }
      await put(record);
    });
    vi.spyOn(MPPClient.prototype, 'pay').mockImplementationOnce(async (options) => {
      options.onPhase?.('transaction_replaced', { txHash: HASH });
      await Promise.resolve();
      return { txHash: HASH, challengeId: 'ch1', receiptHeader: receipt, receiptBody: { note: '支付成功' } };
    });
    await expect(service.payMpp(input, ctx)).resolves.toMatchObject({ txHash: HASH });
    expect(failed).toBe(true);
    expect(writes.mock.calls.filter(([r]) => r.operationId === input.idempotencyKey && r.txHash === HASH)).toHaveLength(
      2,
    );
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ phase: 'complete', txHash: HASH });
  });

  it('still stops on an awaited critical journal failure and preserves its cause', async () => {
    const { service, recoveryStore, fetchImpl, send } = setup();
    const cause = new Error('disk full');
    const claim = recoveryStore.claim.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
      if (record.phase === 'requesting') throw cause;
      return claim(record);
    });
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({ cause, code: 'ADAPTER_REQUEST_FAILED' });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['', '\uFEFF'])('compacts evidence and restores UTF-8 receipts for replay (prefix %j)', async (prefix) => {
    const encoded = `${Buffer.from(prefix + JSON.stringify({ merchant_id: 'acme', note: '支付成功' })).toString('base64url')}.signature.HS256`;
    const { service, recoveryStore, send } = setup({ receipt: encoded });
    const first = await service.payMpp(input, ctx);
    const stored = await recoveryStore.get(input.idempotencyKey);
    expect(stored?.challenge).toBeUndefined();
    expect(stored?.result).not.toHaveProperty('receiptBody');
    expect(await service.payMpp(input, ctx)).toEqual(first);
    expect(await service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx)).toEqual(first);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([202, 429])('broadcasts once and retries HTTP %s verification, preserving UTF-8 receipts', async (status) => {
    const { service, fetchImpl, send } = setup({ statuses: [status, 200] });
    expect(await service.payMpp(input, ctx)).toMatchObject({
      txHash: HASH,
      challengeId: 'ch1',
      receiptBody: { note: '支付成功' },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const verification = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/verify'));
    expect(verification).toHaveLength(2);
    expect(JSON.parse(String(verification[0][1]?.body))).toMatchObject({
      challenge_id: 'ch1',
      tx_hash: HASH,
      payer_addr: PAYER,
    });
  });

  it.each([
    ['chain', { chain_id: 1 }],
    ['expiry', { expiry: 1 }],
    ['price', { amount_wei: '2000000' }],
    ['token', { token_contract: PAYTO }],
  ])('rejects a mismatched challenge %s before transfer', async (_label, challenge) => {
    const { service, send } = setup({ challenge });
    await expect(service.payMpp(input, ctx)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('checks the provider chain and cancellation at the actual send boundary', async () => {
    const wrong = setup({ chainId: 1 });
    await expect(wrong.service.payMpp(input, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'MPP signer chain does not match payment chain',
    });
    expect(wrong.send).not.toHaveBeenCalled();
    expect(await wrong.recoveryStore.get(input.idempotencyKey)).toBeUndefined();
    expect(wrong.fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/challenge'))).toBe(false);
    wrong.provider.getNetwork.mockResolvedValue({ chainId: 4217n });
    await expect(wrong.service.payMpp(input, ctx)).resolves.toMatchObject({ txHash: HASH });
    const abort = new AbortController();
    const test = setup();
    test.provider.getNetwork.mockImplementation(async () => {
      abort.abort();
      return { chainId: 4217n };
    });
    await expect(test.service.payMpp(input, { ...ctx, signal: abort.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(test.send).not.toHaveBeenCalled();
  });

  it('resumes verification after exhausted polling without creating a challenge or transferring', async () => {
    const original = setup({ statuses: [202] });
    await expect(original.service.payMpp(input, ctx)).rejects.toMatchObject({
      recovery: { txHash: HASH, challenge: { challengeId: 'ch1' } },
    });
    const next = setup();
    const resumed = new PaykitService({
      mppSigner: next.signer,
      fetchImpl: next.fetchImpl,
      recoveryStore: original.recoveryStore,
    });
    expect(await resumed.resumeMpp({ url: URL, operationId: 'mpp-1' }, ctx)).toMatchObject({ receiptHeader: receipt });
    expect(next.send).not.toHaveBeenCalled();
    expect(next.fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(next.fetchImpl.mock.calls[0][0])).toMatch(/\/mpp\/v1\/verify$/);
  });

  it('preserves the transfer when receipt decoding fails and never echoes the MAC', async () => {
    const { service, send } = setup({ receipt: '_w.signature.HS256' });
    const error = await service.payMpp(input, ctx).catch((e: Error) => e);
    expect(error).toMatchObject({ recovery: { txHash: HASH }, message: expect.stringContaining('receipt_malformed') });
    expect(String(error)).not.toContain('private-mac');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'journals a fee-bumped replacement before verification (transient failure %s)',
    async (failCheckpoint) => {
      const replacementHash = `0x${'55'.repeat(32)}`;
      const { service, fetchImpl, recoveryStore } = setup({ statuses: [202, 200] });
      const put = recoveryStore.put.bind(recoveryStore);
      let failed = false;
      vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
        if (failCheckpoint && !failed && record.txHash === replacementHash) {
          failed = true;
          throw new Error('transient disk failure');
        }
        await put(record);
      });
      const fetchOriginal = fetchImpl.getMockImplementation()!;
      fetchImpl.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/verify') && JSON.parse(String(init?.body)).tx_hash === replacementHash)
          expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ txHash: replacementHash });
        return fetchOriginal(url, init);
      });
      const replacement = { hash: replacementHash, to: TOKEN, data: '0xabc', wait: async () => ({}) };
      vi.spyOn(MPPClient.prototype, 'payChallenge').mockResolvedValue({
        txHash: HASH,
        tx: {
          to: TOKEN,
          data: '0xabc',
          wait: async () => {
            throw { code: 'TRANSACTION_REPLACED', reason: 'repriced', cancelled: false, replacement };
          },
        } as unknown as TransactionResponse,
      });
      const result = await service.payMpp(input, ctx);
      expect(result.txHash).toBe(replacementHash);
      expect((await recoveryStore.get('mpp-1'))?.txHash).toBe(replacementHash);
      const requests = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/verify'));
      expect(JSON.parse(String(requests.at(-1)![1]?.body)).tx_hash).toBe(replacementHash);
      expect(failed).toBe(failCheckpoint);
    },
  );

  it.each([false, true])(
    'still obtains a receipt during persistent post-broadcast journal failure (replacement %s)',
    async (replace) => {
      const { service, recoveryStore, send, fetchImpl } = setup({ statuses: [202, 200] });
      const replacementHash = `0x${'55'.repeat(32)}`;
      const expectedHash = replace ? replacementHash : HASH;
      const cause = new Error('persistent storage failure');
      const put = recoveryStore.put.bind(recoveryStore);
      vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
        if (record.txHash) throw cause;
        await put(record);
      });
      if (replace) {
        // Exercise the real signing/checkpoint path, then supply a controllable
        // transaction waiter to the SDK's real replacement watcher.
        const payChallenge = MPPClient.prototype.payChallenge;
        vi.spyOn(MPPClient.prototype, 'payChallenge').mockImplementationOnce(async function (challenge) {
          const sent = await payChallenge.call(this, challenge);
          return {
            ...sent,
            tx: {
              hash: HASH,
              to: TOKEN,
              data: '0xabc',
              wait: async () => {
                throw {
                  code: 'TRANSACTION_REPLACED',
                  reason: 'repriced',
                  cancelled: false,
                  replacement: { hash: replacementHash, to: TOKEN, data: '0xabc', wait: async () => ({}) },
                };
              },
            } as unknown as TransactionResponse,
          };
        });
      }
      await expect(service.payMpp(input, ctx)).rejects.toMatchObject({
        cause,
        code: 'ADAPTER_REQUEST_FAILED',
        recovery: {
          phase: 'complete',
          txHash: expectedHash,
          signedTxHash: keccak256('0xdeadbeef'),
          persistenceError: expect.stringContaining('checkpoint failed'),
          result: { txHash: expectedHash, receiptHeader: receipt, receiptBody: { note: '支付成功' } },
        },
      });
      const requests = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/verify'));
      expect(requests).toHaveLength(2);
      expect(JSON.parse(String(requests.at(-1)![1]?.body)).tx_hash).toBe(expectedHash);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({
        phase: 'submitting',
        signedTxHash: keccak256('0xdeadbeef'),
      });
    },
  );

  it('journals the signed hash before an ambiguous RPC failure and resumes verification without another send', async () => {
    const { service, provider, recoveryStore, send, fetchImpl } = setup();
    const signedTxHash = keccak256('0xdeadbeef');
    provider.broadcastTransaction.mockImplementationOnce(async () => {
      expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ signedTxHash, phase: 'submitting' });
      throw new Error('RPC accepted transfer but response lost');
    });
    await expect(service.payMpp(input, ctx)).rejects.toMatchObject({ recovery: { signedTxHash, phase: 'submitting' } });
    await expect(service.resumeMpp({ url: URL, operationId: input.idempotencyKey }, ctx)).resolves.toMatchObject({
      txHash: signedTxHash,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
  });

  it('drains an in-flight replacement journal write when verification aborts', async () => {
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const verifying = gate(),
      respond = gate(),
      replace = gate(),
      writing = gate(),
      persist = gate();
    const replacementHash = `0x${'55'.repeat(32)}`;
    const { service, fetchImpl, recoveryStore } = setup({ statuses: [202] });
    const fetchOriginal = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/verify')) {
        verifying.resolve();
        await respond.promise;
      }
      return fetchOriginal(url, init);
    });
    const put = recoveryStore.put.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'put').mockImplementation(async (record) => {
      if (record.txHash === replacementHash) {
        writing.resolve();
        await persist.promise;
      }
      await put(record);
    });
    vi.spyOn(MPPClient.prototype, 'payChallenge').mockResolvedValue({
      txHash: HASH,
      tx: {
        to: TOKEN,
        data: '0xabc',
        wait: async () => {
          await replace.promise;
          throw {
            code: 'TRANSACTION_REPLACED',
            reason: 'repriced',
            cancelled: false,
            replacement: { hash: replacementHash, to: TOKEN, data: '0xabc', wait: async () => ({}) },
          };
        },
      } as unknown as TransactionResponse,
    });
    const abort = new AbortController();
    const pending = service.payMpp(input, { ...ctx, signal: abort.signal }).catch((error) => error);
    try {
      await verifying.promise;
      replace.resolve();
      await writing.promise;
      abort.abort();
      respond.resolve();
      expect(await Promise.race([pending, new Promise((done) => setTimeout(() => done('draining'), 25))])).toBe(
        'draining',
      );
    } finally {
      persist.resolve();
    }
    expect(await pending).toMatchObject({ recovery: { txHash: replacementHash } });
    expect(await recoveryStore.get(input.idempotencyKey)).toMatchObject({ txHash: replacementHash });
  });
});
