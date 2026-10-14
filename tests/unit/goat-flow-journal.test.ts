import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { GoatAdapter } from '../../networks/goat/adapter';
import { GoatFlowGatewayAdapter } from '../../plugins/x402/adapters/goat-flow-gateway';
import {
  FilePaymentRecoveryStore,
  InMemoryPaymentRecoveryStore,
  paymentRequestKey,
  type PaymentRecovery,
} from '../../plugins/paykit/recovery';
import type { ActionContext, ActionRecovery } from '../../core/schema/action';
import { TOKEN, PAYER, PAYTO, ctx } from '../fixtures/paykit';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});
const directories: string[] = [];
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), 'flow-journal-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open,
  );
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
const params = {
  dappOrderId: 'invoice',
  chainId: 4217,
  tokenSymbol: 'USDC',
  tokenContract: TOKEN,
  fromAddress: PAYER,
  amountWei: '1000000',
};
const order = {
  order_id: 'o1',
  flow: 'ERC20_DIRECT',
  token_symbol: 'USDC',
  accepts: [{ scheme: 'exact', network: 'eip155:4217', asset: TOKEN, payTo: PAYTO, amount: '1000000' }],
  extensions: { goatx402: { expiresAt: 2000000000, destinationChain: 'eip155:2345' } },
};

describe('native Flow durable recovery', () => {
  describe.each(['order', 'checkout'] as const)('%s direct context', (rail) => {
    const response = () =>
      Response.json(
        rail === 'order'
          ? order
          : {
              checkout_id: 'cs1',
              checkout_type: 'DIRECT',
              url: 'https://pay.example/paykit/direct?cs=cs1',
              expires_at: 2000000000,
            },
      );
    const create = (adapter: GoatFlowGatewayAdapter, context: ActionContext, signal?: AbortSignal) =>
      rail === 'order'
        ? adapter.createOrder(params, signal, context)
        : adapter.createCheckout({ clientReferenceId: 'invoice', price: '1' }, signal, context);
    const gateway = (fetchImpl: typeof fetch, recoveryStore = new InMemoryPaymentRecoveryStore(), timeoutMs?: number) =>
      new GoatFlowGatewayAdapter('https://flow.example', {
        apiKey: 'key',
        apiSecret: 'secret',
        checkoutOrigin: 'https://pay.example',
        fetchImpl,
        recoveryStore,
        timeoutMs,
      });

    it('preserves completed-operation reconciliation instructions', async () => {
      const store = new InMemoryPaymentRecoveryStore();
      const put = store.put.bind(store);
      vi.spyOn(store, 'put').mockImplementation(async (record) =>
        record.phase === 'complete' ? { ...record, fingerprint: 'foreign-intent' } : put(record),
      );
      const fetchImpl = vi.fn<typeof fetch>(async () => response());
      const error = await create(gateway(fetchImpl, store), ctx).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: expect.stringContaining('Payment operation completed'),
        recovery: { phase: 'complete' },
      });
      expect(String(error)).not.toContain('operation incomplete');
      expect(String(error)).toContain('do not send another payment or create a new intent key');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([502, 200])('keeps reconciliation guidance for a %s creation response', async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(null, { status }));
      const adapter = gateway(fetchImpl);
      const error = await create(adapter, ctx).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: expect.stringContaining(
          status === 502 ? 'GOAT Flow request failed (502)' : 'Payment API returned a non-object response',
        ),
        recovery: { phase: 'requesting', rail },
      });
      expect(String(error)).toContain('reconcile before retrying');
      // A failed response must not authorize a second creation request.
      await create(adapter, ctx).catch(() => {});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each(['network', 'deadline', 'abort'] as const)(
      'keeps native recovery guidance after a %s failure before headers',
      async (failure) => {
        const caller = new AbortController();
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
          if (failure === 'network') throw new TypeError('socket reset');
          if (failure === 'abort') caller.abort();
          if (init!.signal!.aborted) throw init!.signal!.reason;
          return new Promise((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
          );
        });
        const error = await create(gateway(fetchImpl, undefined, 20), { ...ctx, signal: caller.signal }).catch(
          (error: unknown) => error,
        );
        expect(error).toMatchObject({
          code: failure === 'abort' ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
          message: expect.stringContaining(
            failure === 'abort'
              ? 'Operation aborted'
              : failure === 'deadline'
                ? 'Payment API request timed out'
                : 'Payment API request failed',
          ),
          recovery: { phase: 'requesting', rail },
        });
        expect(String(error)).toContain('reconcile before retrying');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it('binds a method observer to the original context', async () => {
      const context = {
        ...ctx,
        observed: [] as ActionRecovery[],
        checkpointRecovery(record: ActionRecovery) {
          this.observed.push(record);
        },
      };
      await create(
        gateway(async () => response()),
        context,
      );
      expect(context.observed.map((r) => r.phase)).toEqual(['prepared', 'requesting', 'complete']);
    });

    it.each(['null-prototype', 'shadowed-methods', 'property-proxy'] as const)(
      'notifies a %s callable with its original receiver',
      async (shape) => {
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
              throw new Error('RPC wrapper member read');
            },
          });
        const context = { ...ctx, checkpointRecovery: observer };
        await create(
          gateway(async () => response()),
          context,
        );
        expect(observed.map((r) => r.phase)).toEqual(['prepared', 'requesting', 'complete']);
        expect(receivers).toEqual([context, context, context]);
        expect(propertyReads).toEqual([]);
      },
    );

    it('does not read a throwing observer getter outside notification isolation', async () => {
      const getter = vi.fn(() => {
        throw new Error('observer getter');
      });
      const context = Object.defineProperty({ ...ctx }, 'checkpointRecovery', { get: getter });
      const fetchImpl = vi.fn<typeof fetch>(async () => response());
      await expect(create(gateway(fetchImpl), context)).resolves.toMatchObject(
        rail === 'order' ? { orderId: 'o1' } : { checkoutId: 'cs1' },
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(getter).toHaveBeenCalledTimes(3);
    });

    it.each(['context', 'positional'] as const)(
      'classifies a %s-signal abort during POST and blocks replay',
      async (source) => {
        const abort = new AbortController();
        const signalStates: (boolean | undefined)[] = [];
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
          signalStates.push(init?.signal?.aborted);
          abort.abort();
          signalStates.push(init?.signal?.aborted);
          throw new DOMException('request interrupted', 'AbortError');
        });
        const adapter = gateway(fetchImpl);
        const context = { ...ctx, signal: source === 'context' ? abort.signal : undefined };
        await expect(
          create(adapter, context, source === 'positional' ? abort.signal : undefined),
        ).rejects.toMatchObject({
          code: 'ABORTED',
          recovery: { phase: 'requesting', rail },
        });
        expect(signalStates).toEqual([false, true]);
        await expect(create(adapter, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it.each([false, true])('classifies a failed POST response body (caller aborted: %s)', async (cancelled) => {
      const abort = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (cancelled) abort.abort();
                controller.error(new DOMException('body interrupted', 'AbortError'));
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      const adapter = gateway(fetchImpl);
      await expect(create(adapter, { ...ctx, signal: abort.signal })).rejects.toMatchObject({
        code: cancelled ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
        recovery: { phase: 'requesting', rail },
      });
      await expect(create(adapter, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each(['fingerprint', 'rail', 'prepared-marker', 'completed-marker'] as const)(
      'names the external reference for a contradictory %s',
      async (fault) => {
        const store = new InMemoryPaymentRecoveryStore();
        const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
        const adapter = gateway(fetchImpl, store);
        let record: PaymentRecovery | undefined;
        const context = {
          ...ctx,
          checkpointRecovery: (r: ActionRecovery) => {
            record = r as PaymentRecovery;
          },
        };
        await expect(create(adapter, context)).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
        const marker = (await store.get(paymentRequestKey(record!)))!;
        await store.put({
          ...marker,
          ...(fault === 'fingerprint'
            ? { fingerprint: 'foreign-terms' }
            : fault === 'rail'
              ? { rail: rail === 'order' ? ('checkout' as const) : ('order' as const) }
              : { phase: fault === 'prepared-marker' ? ('prepared' as const) : ('complete' as const) }),
        });
        const error = await create(adapter, context).catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          message: expect.stringContaining('operation "invoice"'),
          recovery: undefined,
        });
        expect(String(error)).not.toContain(record!.operationId);
        expect(String(error)).not.toContain('foreign-terms');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['fingerprint', 'completed-marker'] as const)(
      'names the reference for a %s appearing during request claim',
      async (fault) => {
        const store = new InMemoryPaymentRecoveryStore();
        const claim = store.claim.bind(store);
        vi.spyOn(store, 'claim').mockImplementation(async (record) => {
          if (record.operationId.startsWith(`${rail}-request:`)) {
            await claim({
              ...record,
              ...(fault === 'fingerprint' ? { fingerprint: 'foreign-terms' } : { phase: 'complete' as const }),
            });
            return false;
          }
          return claim(record);
        });
        const fetchImpl = vi.fn<typeof fetch>(async () => response());
        const error = await create(gateway(fetchImpl, store), ctx).catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: 'RECOVERY_REQUIRED',
          message: expect.stringContaining('operation "invoice"'),
        });
        expect(String(error)).not.toMatch(/(?:order|checkout):[a-f0-9]{64}/);
        expect(JSON.stringify(error)).not.toContain('foreign-terms');
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );
  });

  it('signs subsequent requests with the rotated API secret', async () => {
    vi.stubEnv('GOAT_X402_BASE_URL', 'https://flow.example/');
    vi.stubEnv('GOAT_X402_API_KEY', 'key');
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(order));
    vi.stubGlobal('fetch', fetchImpl);
    const adapter = new GoatAdapter('goat-mainnet');
    for (const [index, secret] of ['old-secret', 'old-secret', 'rotated-secret'].entries()) {
      vi.stubEnv('GOAT_X402_API_SECRET', secret);
      await adapter.x402CreatePayment({
        asset: 'USDC',
        amount: '1000000',
        idempotencyKey: `rotation-${index}`,
        fromAddress: PAYER,
        chainId: 4217,
        tokenContract: TOKEN,
      });
      const [url, init] = fetchImpl.mock.calls[index];
      expect(url).toBe('https://flow.example/api/v1/orders');
      const headers = new Headers(init?.headers);
      const signed = {
        ...JSON.parse(String(init?.body)),
        api_key: 'key',
        timestamp: headers.get('X-Timestamp'),
        nonce: headers.get('X-Nonce'),
      };
      const payload = Object.keys(signed)
        .sort()
        .map((key) => `${key}=${signed[key]}`)
        .join('&');
      expect(headers.get('X-Sign')).toBe(createHmac('sha256', secret).update(payload).digest('hex'));
      if (index === 2)
        expect(headers.get('X-Sign')).not.toBe(createHmac('sha256', 'old-secret').update(payload).digest('hex'));
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retains the default in-memory journal when the API secret rotates', async () => {
    vi.stubEnv('GOAT_X402_BASE_URL', 'https://flow.example');
    vi.stubEnv('GOAT_X402_API_KEY', 'key');
    vi.stubEnv('GOAT_X402_API_SECRET', 'secret');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ambiguous response'));
    vi.stubGlobal('fetch', fetchImpl);
    const adapter = new GoatAdapter('goat-mainnet');
    const input = {
      asset: 'USDC',
      amount: '1000000',
      idempotencyKey: 'invoice',
      fromAddress: PAYER,
      chainId: 4217,
    };
    await expect(adapter.x402CreatePayment(input)).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
    vi.stubEnv('GOAT_X402_API_SECRET', 'rotated');
    await expect(adapter.x402CreatePayment(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['order', false],
    ['order', true],
    ['checkout', false],
    ['checkout', true],
  ] as const)('handles real store %s completion writes (persistent ENOSPC: %s)', async (rail, persistent) => {
    const path = await directory();
    const store = new FilePaymentRecoveryStore(path);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let failures = 0;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (flags === 'wx') {
        const write = file.writeFile.bind(file);
        file.writeFile = async (data, options) => {
          const record = JSON.parse(String(data)) as PaymentRecovery;
          if (record.phase === 'complete' && record.result && (persistent || failures === 0)) {
            failures++;
            throw Object.assign(new Error('private disk failure'), { code: 'ENOSPC' });
          }
          return write(data, options);
        };
      }
      return file;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        rail === 'order'
          ? order
          : {
              checkout_id: 'cs1',
              checkout_type: 'DIRECT',
              url: 'https://pay.example/paykit/direct?cs=cs1',
              expires_at: 2000000000,
            },
      ),
    );
    let latest: PaymentRecovery | undefined;
    const context = {
      ...ctx,
      checkpointRecovery: (record: unknown) => {
        latest = structuredClone(record) as PaymentRecovery;
      },
    };
    const adapter = () =>
      new GoatFlowGatewayAdapter('https://flow.example', {
        apiKey: 'key',
        apiSecret: 'secret',
        checkoutOrigin: 'https://pay.example',
        fetchImpl,
        recoveryStore: new FilePaymentRecoveryStore(path),
      });
    const create = () =>
      rail === 'order'
        ? adapter().createOrder(params, undefined, context)
        : adapter().createCheckout({ clientReferenceId: 'invoice', price: '1' }, undefined, context);
    if (persistent) {
      await expect(create()).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: 'Insufficient storage for the payment journal',
        cause: { code: 'ADAPTER_REQUEST_FAILED', cause: { code: 'ENOSPC' } },
        recovery: {
          phase: 'complete',
          result: rail === 'order' ? { orderId: 'o1' } : { checkoutId: 'cs1' },
          persistenceError: expect.stringContaining('completed result must be saved'),
        },
      });
      expect(failures).toBe(2);
      expect(await store.get(latest!.operationId)).toMatchObject({ phase: 'prepared' });
      expect(await store.get(paymentRequestKey(latest!))).toMatchObject({ phase: 'requesting' });
      await expect(create()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } else {
      const result = await create();
      expect(failures).toBe(1);
      expect(await store.get(latest!.operationId)).toMatchObject({ phase: 'complete', result });
      expect(await store.get(paymentRequestKey(latest!))).toMatchObject({ phase: 'complete' });
      expect(await create()).toEqual(result);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['secret', 'api-key', 'origin'] as const)(
    'retains operation guards after %s changes and restart',
    async (change) => {
      const path = await directory();
      vi.stubEnv('GOAT_X402_BASE_URL', 'https://flow.example');
      vi.stubEnv('GOAT_X402_API_KEY', 'key');
      vi.stubEnv('GOAT_X402_API_SECRET', 'secret');
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ambiguous remote creation'));
      vi.stubGlobal('fetch', fetchImpl);
      const createAdapter = () =>
        new GoatAdapter('goat-mainnet', { recoveryStore: new FilePaymentRecoveryStore(path) });
      const adapter = createAdapter();
      const input = {
        asset: 'USDC',
        amount: '1000000',
        idempotencyKey: 'invoice',
        fromAddress: PAYER,
        chainId: 4217,
        tokenContract: TOKEN,
      };
      await expect(adapter.x402CreatePayment(input)).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
      vi.stubEnv(
        change === 'secret'
          ? 'GOAT_X402_API_SECRET'
          : change === 'api-key'
            ? 'GOAT_X402_API_KEY'
            : 'GOAT_X402_BASE_URL',
        change === 'origin' ? 'https://new-flow.example' : 'rotated',
      );
      const errorCode = change === 'secret' ? 'RECOVERY_REQUIRED' : 'IDEMPOTENCY_CONFLICT';
      await expect(adapter.x402CreatePayment(input)).rejects.toMatchObject({ code: errorCode });
      await expect(createAdapter().x402CreatePayment(input)).rejects.toMatchObject({ code: errorCode });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
});
