import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { flowCreateOrderAction, flowCreateCheckoutAction, paymentProofAction } from '../../plugins/x402/actions/flow';
import { describe, expect, it, vi } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import { createHmac } from 'node:crypto';
import { GoatFlowGatewayAdapter, flowCheckoutSchema } from '../../plugins/x402/adapters/goat-flow-gateway';
import {
  merchantAuthLoginAction,
  merchantAuthRegisterAction,
  merchantAuthRegisterInviteAction,
  merchantAuthTotpVerifyAction,
} from '../../plugins/x402-merchant';
import { HttpMerchantPortalClient } from '../../plugins/x402-merchant/adapters/http-client';
import { HttpMerchantGatewayAdapter } from '../../plugins/x402/adapters/http-merchant-gateway';
import { TOKEN, PAYER, PAYTO, HASH, ctx } from '../fixtures/paykit';
import { InMemoryPaymentRecoveryStore, paymentRequestKey } from '../../plugins/paykit/recovery';

const orderParams = {
  dappOrderId: 'invoice-1',
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
function adapter(fetchImpl: typeof fetch) {
  return new GoatFlowGatewayAdapter('https://flow.example', {
    apiKey: 'api-key',
    apiSecret: 'api-secret',
    checkoutOrigin: 'https://pay.example',
    fetchImpl,
  });
}

describe('authenticated GOAT Flow adapter', () => {
  it.each([
    'https://flow.example/api',
    'https://flow.example?key=value',
    'https://flow.example#fragment',
    'https://flow.example//',
  ])('rejects a non-origin API base URL: %s', (baseUrl) => {
    expect(() => new GoatFlowGatewayAdapter(baseUrl, { apiKey: 'key', apiSecret: 'secret' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it.each(['https://flow.example', 'https://flow.example/', 'http://127.0.0.1:8080', 'http://localhost:8080/'])(
    'builds request endpoints from a supported bare origin: %s',
    async (baseUrl) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(order));
      const gateway = new GoatFlowGatewayAdapter(baseUrl, { apiKey: 'key', apiSecret: 'secret', fetchImpl });
      await gateway.createOrder(orderParams);
      expect(fetchImpl.mock.calls[0][0]).toBe(`${new URL(baseUrl).origin}/api/v1/orders`);
    },
  );

  it.each(['order', 'checkout'] as const)(
    'safely retries %s references only before a request claim exists',
    async (rail) => {
      for (const stage of ['already-aborted', 'prepared-claim', 'request-claim-error', 'request-claimed'] as const) {
        const recoveryStore = new InMemoryPaymentRecoveryStore();
        const controller = new AbortController();
        if (stage === 'already-aborted') controller.abort();
        const claim = recoveryStore.claim.bind(recoveryStore);
        const claimSpy = vi.spyOn(recoveryStore, 'claim').mockImplementation(async (record) => {
          if (stage === 'request-claim-error' && record.phase === 'requesting') throw new Error('disk unavailable');
          const result = await claim(record);
          if (
            (stage === 'prepared-claim' && record.phase === 'prepared') ||
            (stage === 'request-claimed' && record.phase === 'requesting')
          )
            controller.abort();
          return result;
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
        const service = () =>
          new GoatFlowGatewayAdapter('https://flow.example', {
            apiKey: 'api-key',
            apiSecret: 'api-secret',
            checkoutOrigin: 'https://pay.example',
            recoveryStore,
            fetchImpl,
          });
        const create = (signal?: AbortSignal) =>
          rail === 'order'
            ? service().createOrder(orderParams, signal)
            : service().createCheckout({ price: '1', clientReferenceId: 'same-reference' }, signal);
        await expect(create(controller.signal)).rejects.toMatchObject({
          code: stage === 'request-claim-error' ? 'ADAPTER_REQUEST_FAILED' : 'ABORTED',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
        if (stage === 'already-aborted') expect(claimSpy).not.toHaveBeenCalled();
        claimSpy.mockRestore();
        if (stage === 'request-claimed') {
          await expect(create()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
          expect(fetchImpl).not.toHaveBeenCalled();
        } else {
          const results = await Promise.allSettled([create(), create()]);
          expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
          expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
      }
    },
  );

  it.each([0, -1, 2 ** 31])('rejects invalid timeout %s before reserving native Flow references', (timeoutMs) => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const claim = vi.spyOn(recoveryStore, 'claim');
    expect(
      () =>
        new GoatFlowGatewayAdapter('https://flow.example', {
          apiKey: 'api-key',
          apiSecret: 'api-secret',
          recoveryStore,
          timeoutMs,
        }),
    ).toThrow('Invalid request timeout');
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(['order', 'checkout'] as const)('formats %s object refinements with the shared root label', async (rail) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = adapter(fetchImpl);
    const request =
      rail === 'order'
        ? service.createOrder({ ...orderParams, recoverExistingOrder: true })
        : service.createCheckout({ clientReferenceId: 'invalid-checkout' });
    await expect(request).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Invalid GOAT Flow input: root: '),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['order', false],
    ['order', true],
    ['checkout', false],
    ['checkout', true],
  ] as const)('retries only the %s completion write (persistent failure %s)', async (rail, persistent) => {
    const recoveryStore = new InMemoryPaymentRecoveryStore();
    const put = vi.spyOn(recoveryStore, 'put');
    const diskError = new Error('private disk diagnostic');
    if (persistent) put.mockRejectedValue(diskError);
    else put.mockRejectedValueOnce(diskError);
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
    const service = new GoatFlowGatewayAdapter('https://flow.example', {
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      checkoutOrigin: 'https://pay.example',
      fetchImpl,
      recoveryStore,
    });
    const checkpointRecovery = vi.fn();
    const context = { ...ctx, checkpointRecovery };
    const create = () =>
      rail === 'order'
        ? service.createOrder(orderParams, undefined, context)
        : service.createCheckout({ price: '1', clientReferenceId: 'checkout' }, undefined, context);
    if (persistent) {
      const error = await create().catch((error) => error);
      expect(error).toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        cause: diskError,
        recovery: {
          phase: 'complete',
          persistenceError: expect.stringContaining('completed result must be saved from recovery data'),
          result: rail === 'order' ? { orderId: 'o1' } : { checkoutId: 'cs1', url: expect.any(String) },
        },
      });
      expect(error.message).not.toContain(diskError.message);
      expect(checkpointRecovery).toHaveBeenLastCalledWith(error.recovery);
      expect(error.recovery).not.toBe(checkpointRecovery.mock.lastCall![0]);
      expect(await recoveryStore.get(error.recovery.operationId)).toMatchObject({ phase: 'prepared' });
      expect(await recoveryStore.get(paymentRequestKey(error.recovery))).toMatchObject({ phase: 'requesting' });
      await expect(create()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } else {
      const result = await create();
      expect(result).toMatchObject(rail === 'order' ? { orderId: 'o1' } : { checkoutId: 'cs1' });
      const saved = await recoveryStore.get(checkpointRecovery.mock.lastCall![0].operationId);
      expect(saved).toMatchObject({ phase: 'complete', result });
      expect(saved?.persistenceError).toBeUndefined();
      expect(await create()).toEqual(result);
    }
    expect(put).toHaveBeenCalledTimes(persistent ? 2 : 3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['order', 'checkout', 'proof', 'totp'] as const)(
    'parses %s action input once through the runtime',
    async (kind) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(
          kind === 'order'
            ? order
            : {
                checkout_id: 'cs1',
                checkout_type: 'DIRECT',
                url: 'https://pay.example/paykit/direct?cs=cs1',
                expires_at: 2000000000,
              },
        ),
      );
      const service = adapter(fetchImpl);
      const proof = vi.spyOn(service, 'getPaymentProof').mockResolvedValue({} as never);
      const client = new HttpMerchantPortalClient('https://flow.example');
      vi.spyOn(client, 'post').mockResolvedValue({ access_token: 'private-token' });
      const action =
        kind === 'order'
          ? flowCreateOrderAction(service)
          : kind === 'checkout'
            ? flowCreateCheckoutAction(service)
            : kind === 'proof'
              ? paymentProofAction(service)
              : merchantAuthTotpVerifyAction(client);
      const schema = action.zodInputSchema!;
      const parse = vi.spyOn(schema, 'parse');
      const safeParse = vi.spyOn(schema, 'safeParse');
      try {
        const runtime = new ExecutionRuntime(
          new PolicyEngine({ allowedNetworks: ['goat-mainnet'], writeEnabled: true }),
          { maxRetries: 0, logger: { log: vi.fn() } },
        );
        const input =
          kind === 'order'
            ? orderParams
            : kind === 'checkout'
              ? { price: '1', clientReferenceId: 'runtime-checkout' }
              : kind === 'proof'
                ? { paymentId: 'o1' }
                : { mfa_token: 'challenge', code: '123456' };
        const result = await runtime.run(action, { ...ctx, network: 'goat-mainnet' }, input, { confirmed: true });
        expect(result.ok).toBe(true);
        expect(safeParse).toHaveBeenCalledTimes(1);
        expect(parse).not.toHaveBeenCalled();
        if (kind === 'proof') expect(proof).toHaveBeenCalledWith('o1', undefined);
        if (kind === 'checkout')
          expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ checkout_type: 'DIRECT' });
      } finally {
        parse.mockRestore();
        safeParse.mockRestore();
      }
    },
  );

  it('classifies invalid order input and malformed proof responses at their respective boundaries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ payload: { private_field: 'private-data' }, signature: '' }),
    );
    const service = adapter(fetchImpl);
    await expect(service.createOrder({ ...orderParams, amountWei: '1.5' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const error = await service.getPaymentProof('o1').catch((e) => e);
    expect(error).toMatchObject({
      code: 'ADAPTER_REQUEST_FAILED',
      message: 'Malformed GOAT Flow response',
      cause: expect.any(Error),
    });
    expect(error.message).not.toContain('private-data');
  });
  it('deduplicates address case variants of the same order', async () => {
    const token = `0x${'ab'.repeat(20)}`;
    const payer = `0x${'cd'.repeat(20)}`;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ ...order, accepts: [{ ...order.accepts[0], asset: token }] }),
    );
    const service = adapter(fetchImpl);
    await service.createOrder({ ...orderParams, tokenContract: token, fromAddress: payer });
    await service.createOrder({
      ...orderParams,
      tokenContract: `0x${token.slice(2).toUpperCase()}`,
      fromAddress: `0x${payer.slice(2).toUpperCase()}`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      service.createOrder({ ...orderParams, tokenContract: token, fromAddress: PAYTO }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it.each([{}, { order_id: 'o1', status: 'UNRECOGNIZED' }])(
    'reports invalid native status as an adapter error',
    async (body) => {
      await expect(adapter(async () => Response.json(body)).getPaymentStatus('o1')).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
      });
    },
  );

  it.each(['status', 'proof', 'signature', 'cancel', 'checkout'] as const)(
    'classifies mismatched %s acknowledgements as adapter failures',
    async (kind) => {
      const payload = {
        order_id: 'other',
        tx_hash: HASH,
        log_index: 1,
        from_addr: PAYER,
        to_addr: PAYTO,
        amount_wei: '1',
        from_chain_id: 4217,
        status: 'PAYMENT_CONFIRMED',
      };
      const service = adapter(async () =>
        Response.json({
          order_id: 'other',
          status: kind === 'signature' ? 'ok' : kind === 'cancel' ? 'cancelled' : 'PAYMENT_CONFIRMED',
          payload,
          signature: 'checksum',
          checkout_id: 'cs1',
          checkout_type: 'DIRECT',
          expires_at: 2000000000,
          url: 'https://evil.example/paykit/direct?cs=cs1',
        }),
      );
      const operation =
        kind === 'status'
          ? service.getPaymentStatus('o1')
          : kind === 'proof'
            ? service.getPaymentProof('o1')
            : kind === 'signature'
              ? service.submitPaymentAuthorization('o1', '0x1234')
              : kind === 'cancel'
                ? service.cancelPayment('o1')
                : service.createCheckout({ checkoutType: 'DIRECT', price: '1', clientReferenceId: 'mismatch' });
      await expect(operation).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
    },
  );

  it('pins the backend signature acknowledgement contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ status: 'ok', order_id: 'o1' }));
    expect(await adapter(fetchImpl).submitPaymentAuthorization('o1', '0x1234')).toMatchObject({
      status: 'authorized',
      paymentId: 'o1',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://flow.example/api/v1/orders/o1/calldata-signature');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ signature: '0x1234' });
    await expect(
      adapter(async () => Response.json({ status: 'ok', order_id: 'other' })).submitPaymentAuthorization(
        'o1',
        '0x1234',
      ),
    ).rejects.toThrow(/acknowledgement/);
  });

  it('continues to reject missing merchant statuses instead of making them payable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ paymentId: 'o1' }));
    try {
      const gateway = new HttpMerchantGatewayAdapter('https://merchant.example');
      await expect(gateway.getPaymentStatus('o1')).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('accepts HTTP 402 only for native order creation, signs real fields and returns exact terms', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(order, { status: 402 }));
    const service = adapter(fetchImpl);
    expect(await service.createOrder(orderParams)).toMatchObject({
      orderId: 'o1',
      fromChainId: 4217,
      payToChainId: 2345,
      tokenContract: TOKEN,
      amountWei: '1000000',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://flow.example/api/v1/orders');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      dapp_order_id: 'invoice-1',
      chain_id: 4217,
      token_symbol: 'USDC',
      token_contract: TOKEN,
      from_address: PAYER,
      amount_wei: '1000000',
    });
    const headers = new Headers(init?.headers);
    const signed = {
      ...body,
      api_key: 'api-key',
      timestamp: headers.get('X-Timestamp'),
      nonce: headers.get('X-Nonce'),
    };
    const payload = Object.keys(signed)
      .sort()
      .map((key) => `${key}=${signed[key]}`)
      .join('&');
    expect(headers.get('X-Sign')).toBe(createHmac('sha256', 'api-secret').update(payload).digest('hex'));
    await service.createOrder(orderParams);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const legacy = await service.createPaymentIntent({
      to: PAYTO,
      asset: 'USDC',
      amount: '1000000',
      chainId: 4217,
      tokenContract: TOKEN,
      fromAddress: PAYER,
      idempotencyKey: 'invoice-1',
    });
    expect(legacy.raw).toEqual(order);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(service.getPaymentStatus('o1')).rejects.toThrow(/402/);
  });

  it.each([
    { ...order, order_id: '' },
    { ...order, accepts: [] },
    { ...order, accepts: [{ ...order.accepts[0], amount: '2000000' }] },
    { ...order, token_symbol: 'USDT' },
    { ...order, token_symbol: undefined },
  ])('rejects malformed or conflicting order terms', async (response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(response));
    const service = adapter(fetchImpl);
    await expect(service.createOrder(orderParams)).rejects.toThrow();
    await expect(service.createOrder(orderParams)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a second accept entry with the same terms',
      { accepts: [order.accepts[0], { ...order.accepts[0], asset: PAYTO }] },
      false,
    ],
    ['another symbol', { token_symbol: 'USDT' }, false],
    ['the same symbol in another case', { token_symbol: 'usdc' }, true],
  ] as const)('binds an unpinned order token to the requested symbol: %s', async (_name, change, ok) => {
    const { tokenContract: _pinned, ...params } = orderParams;
    const service = adapter(vi.fn<typeof fetch>(async () => Response.json({ ...order, ...change })));
    const result = service.createOrder(params);
    if (ok) await expect(result).resolves.toMatchObject({ tokenContract: TOKEN, tokenSymbol: 'USDC' });
    else
      await expect(result).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: expect.stringContaining('Order payment terms do not match'),
      });
  });

  describe('callback authorization binding', () => {
    const callbackCalldata = '0x1234ABCD';
    // Factories: tamper cases mutate these arrays, so every request gets fresh ones.
    const domainFields = () => [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ];
    const dataFields = () => [
      { name: 'token', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: 'payer', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'calldataNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'calldataHash', type: 'bytes32' },
    ];
    type Flow = 'ERC20_3009' | 'ERC20_APPROVE_XFER';
    // Mirrors goatx402-core BuildCalldataSignRequestForOrder: the domain is the
    // pay-to chain, and token/amount are pay-to (payout) terms.
    const signRequest = (flow: Flow) => {
      const permit2 = flow === 'ERC20_APPROVE_XFER';
      const primaryType = permit2 ? 'Permit2CallbackData' : 'Eip3009CallbackData';
      return {
        domain: { name: 'GoatCallback', version: '1', chainId: 2345, verifyingContract: PAYTO },
        types: {
          EIP712Domain: domainFields(),
          [primaryType]: permit2 ? [{ name: 'permit2', type: 'address' }, ...dataFields()] : dataFields(),
        } as Record<string, { name: string; type: string }[]>,
        primaryType,
        message: {
          ...(permit2 ? { permit2: `0x${'77'.repeat(20)}` } : {}),
          token: `0x${'99'.repeat(20)}`,
          owner: `0x${'88'.repeat(20)}`,
          payer: PAYER.toUpperCase().replace('0X', '0x'),
          amount: '990000',
          orderId: keccak256(toUtf8Bytes('o1')),
          calldataNonce: '1',
          deadline: '2000000600',
          calldataHash: keccak256(callbackCalldata),
        } as Record<string, string>,
      };
    };
    /** `null` omits callback calldata from the order request. */
    const create = (flow: string, request: unknown, calldata: string | null = callbackCalldata) =>
      adapter(
        vi.fn<typeof fetch>(async () => Response.json({ ...order, flow, calldata_sign_request: request })),
      ).createOrder({ ...orderParams, ...(calldata === null ? {} : { callbackCalldata: calldata }) });

    it.each(['ERC20_3009', 'ERC20_APPROVE_XFER'] as const)('returns a request bound to the %s order', async (flow) => {
      const request = signRequest(flow);
      await expect(create(flow, request)).resolves.toMatchObject({ calldataSignRequest: request });
    });

    it.each([
      ['another payer', (r) => (r.message.payer = PAYTO)],
      ['another order', (r) => (r.message.orderId = keccak256(toUtf8Bytes('o2')))],
      ['other calldata', (r) => (r.message.calldataHash = keccak256('0x12'))],
      ['the source chain domain', (r) => (r.domain.chainId = 4217)],
      ['the other callback type', (r) => (r.primaryType = 'Permit2CallbackData')],
      ['an extra signed field', (r) => r.types.Eip3009CallbackData.push({ name: 'extra', type: 'uint256' })],
      ['reordered fields', (r) => r.types.Eip3009CallbackData.reverse()],
      ['an extra struct', (r) => (r.types.Other = [{ name: 'value', type: 'uint256' }])],
      ['a non-standard domain type', (r) => r.types.EIP712Domain.pop()],
      ['an unexpected Permit2 address', (r) => (r.message.permit2 = `0x${'77'.repeat(20)}`)],
    ] as [string, (r: ReturnType<typeof signRequest>) => void][])('rejects %s', async (_name, tamper) => {
      const request = signRequest('ERC20_3009');
      tamper(request);
      await expect(create('ERC20_3009', request)).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: expect.stringContaining('Order callback authorization does not match the requested order'),
        recovery: { phase: 'requesting', rail: 'order' },
      });
    });

    it.each([
      ['a direct order', 'ERC20_DIRECT', callbackCalldata],
      ['an order created without calldata', 'ERC20_3009', null],
      ['an order created with empty calldata', 'ERC20_3009', '0x'],
      ['a Permit2 request without its Permit2 address', 'ERC20_APPROVE_XFER', callbackCalldata],
    ] as const)('rejects a callback request for %s', async (_name, flow, calldata) => {
      const request = signRequest(flow === 'ERC20_DIRECT' ? 'ERC20_3009' : flow);
      if (flow === 'ERC20_APPROVE_XFER') delete request.message.permit2;
      await expect(create(flow, request, calldata)).rejects.toMatchObject({
        code: 'ADAPTER_REQUEST_FAILED',
        message: expect.stringContaining('Order callback authorization does not match the requested order'),
      });
    });
  });

  it.each([
    ['CHECKOUT_VERIFIED', 'created'],
    ['PAYMENT_CONFIRMED', 'authorized'],
    ['INVOICED', 'settled'],
    ['EXPIRED', 'expired'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'failed'],
  ])('preserves native %s while providing legacy %s', async (orderStatus, status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ order_id: 'a/b', status: orderStatus }));
    expect(await adapter(fetchImpl).getPaymentStatus('a/b')).toMatchObject({ paymentId: 'a/b', orderStatus, status });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://flow.example/api/v1/orders/a%2Fb');
  });

  it('rejects unknown statuses and accepts the actual lowercase cancel acknowledgement', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ order_id: 'o1', status: 'NEW_STATE' }))
      .mockResolvedValueOnce(Response.json({ order_id: 'o1', status: 'cancelled' }));
    const service = adapter(fetchImpl);
    await expect(service.getPaymentStatus('o1')).rejects.toThrow();
    expect(await service.cancelPayment('o1')).toMatchObject({ status: 'cancelled' });
  });

  it('restricts replay recovery to topup orders and requires explicit native payer/idempotency', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = adapter(fetchImpl);
    await expect(service.createOrder({ ...orderParams, recoverExistingOrder: true })).rejects.toThrow(/topup/);
    await expect(service.createPaymentIntent({ to: PAYTO, asset: 'USDC', amount: '1' })).rejects.toThrow(
      /chainId, fromAddress and idempotencyKey/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, true])(
    'recovers an ambiguous topup creation with the server replay flag (initially %s)',
    async (recoverExistingOrder) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('Response lost after order committed'))
        .mockResolvedValue(Response.json(order, { status: 402 }));
      const service = adapter(fetchImpl);
      const params = { ...orderParams, dappOrderId: 'topup:invoice-1', recoverExistingOrder };
      await expect(service.createOrder(params)).rejects.toMatchObject({ recovery: { phase: 'requesting' } });
      await expect(service.createOrder({ ...params, recoverExistingOrder: true })).resolves.toMatchObject({
        orderId: 'o1',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
        dapp_order_id: params.dappOrderId,
        recover_existing_order: true,
      });
      await expect(
        service.createOrder({ ...params, amountWei: '2000000', recoverExistingOrder: true }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('serializes hosted checkout metadata for HMAC and refuses duplicate references with changed terms', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        checkout_id: 'cs1',
        checkout_type: 'DIRECT',
        expires_at: 2000000000,
        url: 'https://pay.example/paykit/direct?cs=cs1',
      }),
    );
    const service = adapter(fetchImpl);
    const params = {
      checkoutType: 'DIRECT' as const,
      price: '1',
      paymentRails: ['crypto', 'fiat'] as ('crypto' | 'fiat')[],
      fiatCurrency: 'USD',
      fiatAmount: '1',
      clientReferenceId: 'invoice-1',
      privateMetadata: { internal: 'private' },
      lineItems: [{ name: 'Mug' }],
    };
    expect(await service.createCheckout(params)).toMatchObject({ checkoutId: 'cs1' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      private_metadata_json: '{"internal":"private"}',
      line_items_json: '[{"name":"Mug"}]',
      payment_rails: 'crypto,fiat',
    });
    await expect(service.createCheckout({ ...params, price: '2' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed after ambiguous checkout creation and rejects untrusted hosted links', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        checkout_id: 'cs1',
        checkout_type: 'DIRECT',
        expires_at: 2000000000,
        url: 'https://evil.example/paykit/direct?cs=cs1',
      }),
    );
    const service = adapter(fetchImpl);
    const params = { checkoutType: 'DIRECT' as const, price: '1', clientReferenceId: 'invoice-1' };
    await expect(service.createCheckout(params)).rejects.toThrow(/configured origin/);
    await expect(service.createCheckout(params)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces fixed-wei DELEGATE calldata and fiat eligibility input contracts', () => {
    expect(
      flowCheckoutSchema.safeParse({ checkoutType: 'DELEGATE', fixedAmountWei: 'not-a-number', clientReferenceId: 'a' })
        .success,
    ).toBe(false);
    expect(flowCheckoutSchema.safeParse({ price: '1', callbackCalldata: '0x12', clientReferenceId: 'a' }).success).toBe(
      false,
    );
    expect(
      flowCheckoutSchema.safeParse({
        checkoutType: 'DELEGATE',
        chainId: 4217,
        fixedAmountWei: '1',
        acceptableTokens: [TOKEN],
        callbackCalldata: '0x12',
        clientReferenceId: 'a',
      }).success,
    ).toBe(true);
    expect(flowCheckoutSchema.safeParse({ paymentRails: ['fiat'], clientReferenceId: 'a' }).success).toBe(false);
    expect(
      flowCheckoutSchema.safeParse({ price: '1', publicMetadata: { quickpay: {} }, clientReferenceId: 'a' }).success,
    ).toBe(false);
  });

  it('labels server proof checksums without claiming a cryptographic attestation', async () => {
    const service = adapter(async () =>
      Response.json({
        payload: {
          order_id: 'o1',
          tx_hash: HASH,
          log_index: 1,
          from_addr: PAYER,
          to_addr: PAYTO,
          amount_wei: '1',
          from_chain_id: 4217,
          status: 'PAYMENT_CONFIRMED',
        },
        signature: 'checksum',
      }),
    );
    expect(await service.getPaymentProof('o1')).toMatchObject({
      cryptographicAttestation: false,
      signature: 'checksum',
    });
  });
});

describe('merchant current auth contracts', () => {
  const client = new HttpMerchantPortalClient('https://flow.example');
  it('requires DIRECT registration and UTF-8 passwords within bcrypt bounds', () => {
    const schema = merchantAuthRegisterAction(client).zodInputSchema!;
    const input = { merchant_id: 'acme', name: 'ACME', email: 'owner@example.com', password: 'secure123' };
    expect(schema.parse(input).receive_type).toBe('DIRECT');
    expect(schema.safeParse({ ...input, receive_type: 'DELEGATE' }).success).toBe(false);
    expect(schema.safeParse({ ...input, password: 'short' }).success).toBe(false);
    expect(schema.safeParse({ ...input, password: '密'.repeat(25) }).success).toBe(false);
    expect(
      merchantAuthRegisterInviteAction(client).zodInputSchema!.safeParse({
        invite_code: 'x',
        email: input.email,
        password: '密'.repeat(25),
      }).success,
    ).toBe(false);
  });
  it('redacts login MFA challenges and submits TOTP without changing shared auth state', async () => {
    expect(merchantAuthLoginAction(client).sensitiveOutputFields).toContain('mfa_token');
    const post = vi.spyOn(client, 'post').mockResolvedValue({ access_token: 'token' });
    const action = merchantAuthTotpVerifyAction(client);
    const params = { mfa_token: 'challenge', code: '123456' };
    expect(await action.execute(ctx, params)).toEqual({ access_token: 'token' });
    expect(post).toHaveBeenCalledWith('/merchant/v1/auth/totp/verify', params, { signal: undefined });
    expect(client.getAccessToken()).toBeUndefined();
    expect(action.sensitiveInputFields).toEqual(['mfa_token', 'code']);
    post.mockRestore();
  });
});
