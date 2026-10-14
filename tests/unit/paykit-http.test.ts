import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { inspect } from 'node:util';
import { paymentFetch, jsonObject } from '../../plugins/paykit/http';
import { PaykitService } from '../../plugins/paykit/service';
import { GoatFlowGatewayAdapter } from '../../plugins/x402/adapters/goat-flow-gateway';
import { ctx, fakeWallet, payment, routes, HASH } from '../fixtures/paykit';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function stalledServer(stage: 'headers' | 'body') {
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = createServer((_req, res) => {
    if (stage === 'body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"private_data":"incomplete');
    }
    started();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  return { origin: `http://127.0.0.1:${address.port}`, received };
}

describe('fetch implementation JSON wrappers', () => {
  it.each(['read', 'write', 'clone'] as const)('does not retain a wrapped JSON exception on %s', async (path) => {
    const body = '{"private_note": SECRET-FETCH-773}';
    const cause = Object.assign(new Error(`invalid json response body: ${body}`), {
      name: 'FetchError',
      type: 'invalid-json',
    });
    const response = new Response(body);
    const json = vi.fn(async () => {
      throw cause;
    });
    response.json = json;
    response.clone = () => {
      const cloned = new Response(body);
      cloned.json = json;
      return cloned;
    };
    const route = routes();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      String(url).endsWith('/manifest.json') ? route(url, init) : response,
    );
    const service = new PaykitService({ wallet: fakeWallet().wallet, fetchImpl });
    const result =
      path === 'write'
        ? service.pay(payment, ctx)
        : path === 'read'
          ? service.sessionStatus({ url: payment.url, sessionId: 's1' }, ctx)
          : jsonObject(response, { clone: true });
    const error = await result.catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: expect.stringContaining('Payment API returned invalid JSON (200)'),
    });
    expect(inspect(error, { depth: null })).not.toContain('SECRET-FETCH-773');
    expect(JSON.stringify(error)).not.toContain('SECRET-FETCH-773');
    expect(json).not.toHaveBeenCalled();
    if (path === 'clone') expect(response.bodyUsed).toBe(false);
  });
});

describe('foreign-realm JSON failures', () => {
  it.each([false, true])('ignores foreign-realm JSON wrappers (cancelled: %s)', async (cancelled) => {
    const parserError = runInNewContext(`try { JSON.parse('PRIVATE-RESPONSE-773') } catch (error) { error }`);
    expect(parserError instanceof SyntaxError).toBe(false);
    expect(inspect(parserError)).toContain('PRIVATE-RESPONSE-773');
    const caller = new AbortController();
    const response = new Response('PRIVATE-RESPONSE-773');
    const json = vi.fn(async () => {
      throw parserError;
    });
    response.json = json;
    const read = response.text.bind(response);
    response.text = () => {
      if (cancelled) caller.abort();
      return read();
    };
    const transport = paymentFetch('https://pay.example', {
      signal: caller.signal,
      fetchImpl: async () => response,
    });
    const error = await transport('https://pay.example/status')
      .then(jsonObject)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: cancelled ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED',
      message: cancelled ? 'Operation aborted' : 'Payment API returned invalid JSON (200)',
      cause: undefined,
    });
    expect(inspect(error, { depth: 10 })).not.toContain('PRIVATE-RESPONSE-773');
    expect(json).not.toHaveBeenCalled();
  });
});

describe('payment HTTP classification', () => {
  it('keeps x402 creation guidance for a decoded non-object response', async () => {
    const { wallet, broadcast } = fakeWallet();
    const route = routes();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) =>
      String(url).endsWith('/x402/sessions') ? Response.json(null) : route(url, init),
    );
    const error = await new PaykitService({ wallet, fetchImpl }).pay(payment, ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: expect.stringContaining('Payment API returned a non-object response'),
      recovery: { phase: 'requesting' },
    });
    expect(String(error)).toContain('inspect recovery data before retrying');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps x402 recovery guidance after caller cancellation during status polling', async () => {
    const caller = new AbortController();
    const { wallet, broadcast } = fakeWallet();
    const route = routes();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/x402/sessions/s1')) {
        caller.abort();
        throw caller.signal.reason;
      }
      return route(url, init);
    });
    const error = await new PaykitService({ wallet, fetchImpl })
      .pay(payment, { ...ctx, signal: caller.signal })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('Operation aborted'),
      recovery: { phase: 'broadcast', txHash: HASH },
    });
    expect(String(error)).toContain('inspect recovery data before retrying');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/x402/sessions/s1'))).toHaveLength(1);
  });

  it('keeps recovery guidance when cancellation reaches the x402 transport before fetch starts', async () => {
    const caller = new AbortController();
    const { wallet, broadcast } = fakeWallet();
    const fetchImpl = routes();
    const error = await new PaykitService({ wallet, fetchImpl })
      .pay(payment, {
        ...ctx,
        signal: caller.signal,
        checkpointRecovery: (record) => {
          if (record.phase === 'requesting') caller.abort();
        },
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('inspect recovery data before retrying'),
      recovery: { operationId: payment.idempotencyKey, phase: 'requesting' },
    });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/x402/sessions'))).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('classifies a card-checkout cancellation after the SDK replaces the transport error', async () => {
    const caller = new AbortController();
    const route = routes();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (!String(url).endsWith('/fiat/sessions')) return route(url, init);
      caller.abort();
      throw caller.signal.reason;
    });
    const service = new PaykitService({ fetchImpl });
    const input = { url: payment.url, amount: '1', idempotencyKey: 'cancelled-card' };
    const error = await service
      .createCardCheckout(input, { ...ctx, signal: caller.signal })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('inspect recovery data before retrying'),
      cause: { message: expect.stringContaining('failed to create card checkout link') },
      recovery: { operationId: input.idempotencyKey, rail: 'fiat', phase: 'requesting' },
    });
    await expect(service.createCardCheckout(input, ctx)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/fiat/sessions'))).toHaveLength(1);
  });

  it.each(['network', 'deadline', 'abort'] as const)(
    'keeps x402 recovery guidance after a %s failure before headers',
    async (failure) => {
      const caller = new AbortController();
      const { wallet, broadcast } = fakeWallet();
      const route = routes();
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        if (!String(url).endsWith('/x402/sessions')) return route(url, init);
        if (failure === 'network') throw new TypeError('socket reset');
        if (failure === 'abort') caller.abort();
        if (init!.signal!.aborted) throw init!.signal!.reason;
        return new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
        );
      });
      const error = await new PaykitService({ wallet, fetchImpl, requestTimeoutMs: 20 })
        .pay(payment, { ...ctx, signal: caller.signal })
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
        recovery: { operationId: payment.idempotencyKey, phase: 'requesting' },
      });
      expect(String(error)).toContain('inspect recovery data before retrying');
      expect(broadcast).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/x402/sessions'))).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'never retains malformed response contents in the error chain (cancelled: %s)',
    async (cancelled) => {
      const secret = 'SECRET-773';
      const body = '{"private_note": SECRET-773}';
      // Confirm that the platform's raw SyntaxError would expose this body.
      const raw = await new Response(body).json().catch((error: unknown) => error);
      expect(inspect(raw, { depth: null })).toContain(secret);
      const caller = new AbortController();
      const response = new Response(body);
      const read = response.text.bind(response);
      response.text = () => {
        if (cancelled) caller.abort();
        return read();
      };
      const transport = paymentFetch('https://pay.example', { signal: caller.signal, fetchImpl: async () => response });
      const error = await jsonObject(await transport('https://pay.example')).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: cancelled ? 'ABORTED' : 'ADAPTER_REQUEST_FAILED', cause: undefined });
      expect(inspect(error, { depth: null })).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it('keeps timeout classification and recovery guidance for a cloned x402 creation body', async () => {
    const { wallet, broadcast } = fakeWallet();
    const route = routes();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/x402/sessions'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"session_id":'));
              init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
            },
          }),
        );
      return route(url, init);
    });
    const service = new PaykitService({ wallet, fetchImpl, requestTimeoutMs: 20 });
    const error = await service.pay(payment, ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: expect.stringContaining('Payment API request timed out'),
      recovery: { phase: 'requesting', operationId: payment.idempotencyKey },
    });
    expect(String(error)).toContain('inspect recovery data before retrying');
    expect(broadcast).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/x402/sessions'))).toHaveLength(1);
  });

  it.each(['options', 'init', 'request'] as const)('forwards the %s caller signal to fetch', async (source) => {
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return Response.json({});
    });
    const transport = paymentFetch('https://pay.example', {
      fetchImpl,
      signal: source === 'options' ? caller.signal : undefined,
    });
    await transport(
      source === 'request' ? new Request('https://pay.example', { signal: caller.signal }) : 'https://pay.example',
      source === 'init' ? { signal: caller.signal } : undefined,
    );
    expect(signal?.aborted).toBe(false);
    caller.abort('caller reason');
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe('caller reason');
  });

  it.each(['headers', 'body'] as const)(
    'classifies a real upstream timeout during %s, including cloned JSON reads',
    async (stage) => {
      const { origin } = await stalledServer(stage);
      const transport = paymentFetch(origin, { timeoutMs: 50 });
      const result = transport(origin).then((response) => jsonObject(response, { clone: true }));
      await expect(result).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: 'Payment API request timed out',
      });
    },
  );

  it.each(['headers', 'body'] as const)(
    'classifies caller cancellation during %s with a custom reason',
    async (stage) => {
      const { origin, received } = await stalledServer(stage);
      const caller = new AbortController();
      const transport = paymentFetch(origin, { signal: caller.signal });
      let reading!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const result = transport(origin).then((response) => {
        reading();
        return jsonObject(response, { clone: true });
      });
      const expected = expect(result).rejects.toMatchObject({ code: 'ABORTED', message: 'Operation aborted' });
      await received;
      if (stage === 'body') await readStarted;
      caller.abort(new Error('private cancellation reason'));
      await expected;
    },
  );

  it.each(['socket', 'json'] as const)(
    'distinguishes a %s body failure without echoing private data',
    async (failure) => {
      const response =
        failure === 'json'
          ? new Response('private invalid JSON')
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('private socket error'));
                },
              }),
            );
      const error = await jsonObject(response).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message:
          failure === 'json'
            ? 'Payment API returned invalid JSON (200)'
            : 'Cannot read payment API response body (200)',
      });
      expect(String(error)).not.toContain('private');
    },
  );

  it('normalizes a socket failure before headers without exposing its message', async () => {
    const cause = new TypeError('private upstream error');
    const transport = paymentFetch('https://pay.example', { fetchImpl: vi.fn().mockRejectedValue(cause) });
    await expect(transport('https://pay.example')).rejects.toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: 'Payment API request failed',
      cause,
    });
  });

  describe.each(['paykit-status', 'native-status'] as const)('%s', (path) => {
    it.each(
      (['headers', 'body'] as const).flatMap((stage) =>
        (['timeout', 'cancel'] as const).map((failure) => ({ stage, failure })),
      ),
    )('reports $failure during $stage through the public read API', async ({ stage, failure }) => {
      const { origin, received } = await stalledServer(stage);
      const caller = new AbortController();
      const timeoutMs = failure === 'timeout' ? 50 : 30000;
      let reading!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let headersArrived = false;
      let bodyReadStarted = false;
      const fetchImpl: typeof fetch = async (url, init) => {
        const response = await fetch(url, init);
        headersArrived = true;
        const read = response.text.bind(response);
        response.text = () => {
          const result = read();
          bodyReadStarted = true;
          reading();
          return result;
        };
        return response;
      };
      const result =
        path === 'paykit-status'
          ? new PaykitService({ requestTimeoutMs: timeoutMs, fetchImpl }).sessionStatus(
              { url: `${origin}/paykit/acme`, sessionId: 's1' },
              { ...ctx, signal: caller.signal },
            )
          : new GoatFlowGatewayAdapter(origin, {
              apiKey: 'key',
              apiSecret: 'secret',
              timeoutMs,
              fetchImpl,
            }).getPaymentStatus('o1', caller.signal);
      const expected = expect(result).rejects.toMatchObject({
        code: failure === 'timeout' ? 'ADAPTER_REQUEST_FAILED' : 'ABORTED',
        message: failure === 'timeout' ? 'Payment API request timed out' : 'Operation aborted',
      });
      if (failure === 'cancel') {
        await received;
        if (stage === 'body') await readStarted;
        expect(headersArrived).toBe(stage === 'body');
        expect(bodyReadStarted).toBe(stage === 'body');
        caller.abort();
      }
      await expected;
      expect(headersArrived).toBe(stage === 'body');
      expect(bodyReadStarted).toBe(stage === 'body');
    });
  });
});
