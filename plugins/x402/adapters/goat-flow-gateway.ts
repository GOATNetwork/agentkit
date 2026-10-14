import {
  signRequest,
  type CreateOrderParams,
  type CreateCheckoutSessionParams,
  type CheckoutSession,
  type Order,
} from 'goatflow-sdk-server';
import { keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';
import {
  beginPayment,
  claimPaymentRequest,
  paymentJournal,
  completePayment,
  throwPaymentFailure,
} from '../../paykit/journal';
import { replayResult } from '../../paykit/recovery';
import type { ActionContext, ActionRecovery } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { isValidTimeout } from '../../../core/runtime/timeout';
import { throwIfAborted } from '../../../core/runtime/abort';
import { formatZodIssues } from '../../../core/runtime/schema-validator';
import { evmAddress, positiveUint256, transactionHash } from '../../../core/schema/validators';
import {
  invalid,
  invalidResponse,
  jsonObject,
  pathSegment,
  paymentFetch,
  trustedOrigin,
  trustedPaymentUrl,
} from '../../paykit/http';
import {
  InMemoryPaymentRecoveryStore,
  paymentFingerprint,
  type PaymentRecovery,
  type PaymentRecoveryStore,
} from '../../paykit/recovery';
import type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  MerchantGatewayAdapter,
  PaymentStatus,
} from './types';

function parseFlow<S extends z.ZodTypeAny>(schema: S, value: unknown, kind: 'input' | 'response'): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AgentkitRuntimeError(
      kind === 'input' ? ErrorCodes.INVALID_INPUT : ErrorCodes.ADAPTER_REQUEST_FAILED,
      kind === 'input'
        ? `Invalid GOAT Flow input: ${formatZodIssues(parsed.error.issues).join('; ')}`
        : 'Malformed GOAT Flow response',
      parsed.error,
    );
  return parsed.data;
}

export const flowOrderStatuses = [
  'CHECKOUT_VERIFIED',
  'PAYMENT_CONFIRMED',
  'INVOICED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type FlowOrderStatus = (typeof flowOrderStatuses)[number];
const legacyStatus: Record<FlowOrderStatus, PaymentStatus> = {
  CHECKOUT_VERIFIED: 'created',
  PAYMENT_CONFIRMED: 'authorized',
  INVOICED: 'settled',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'failed',
};
const address = evmAddress;
const wei = positiveUint256;
const decimal = z
  .string()
  .regex(/^\d{1,40}(?:\.\d+)?$/)
  .refine((s) => /[1-9]/.test(s));

export const flowCreateOrderSchema = z
  .object({
    dappOrderId: z.string().min(1).max(200),
    chainId: z.number().int().positive().safe(),
    tokenSymbol: z.string().min(1),
    tokenContract: address.optional(),
    fromAddress: address,
    amountWei: wei,
    callbackCalldata: z
      .string()
      .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
      .optional(),
    recoverExistingOrder: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => !v.recoverExistingOrder || v.dappOrderId.startsWith('topup:'),
    'recoverExistingOrder is restricted to topup: orders',
  );

export const flowCheckoutSchema = z
  .object({
    checkoutType: z.enum(['DIRECT', 'DELEGATE']).default('DIRECT'),
    price: decimal.optional(),
    chainId: z.number().int().positive().safe().optional(),
    fixedAmountWei: wei.optional(),
    callbackCalldata: z
      .string()
      .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
      .optional(),
    acceptableTokens: z.array(address).nonempty().optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
    lineItems: z.array(z.record(z.unknown())).optional(),
    publicMetadata: z.record(z.unknown()).optional(),
    privateMetadata: z.record(z.unknown()).optional(),
    clientReferenceId: z.string().min(1).max(200),
    expiresIn: z.number().int().positive().optional(),
    paymentRails: z
      .array(z.enum(['crypto', 'fiat']))
      .nonempty()
      .default(['crypto']),
    fiatCurrency: z
      .string()
      .regex(/^[a-zA-Z]{3}$/)
      .optional(),
    fiatAmount: decimal.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (new Set(v.paymentRails).size !== v.paymentRails.length) reject('Duplicate payment rails');
    if (v.paymentRails.includes('fiat')) {
      if (!v.fiatCurrency || !v.fiatAmount) reject('Fiat rail requires currency and decimal amount');
    } else if (v.fiatCurrency || v.fiatAmount) reject('Fiat fields require the fiat rail');
    if (v.paymentRails.includes('crypto') && !v.price && !v.fixedAmountWei)
      reject('Crypto rail requires a price or fixedAmountWei');
    if (v.fixedAmountWei && (v.checkoutType !== 'DELEGATE' || !v.chainId || !v.acceptableTokens || v.price))
      reject('Fixed-wei checkout requires DELEGATE, chainId and acceptableTokens, without price');
    if (v.callbackCalldata && !v.fixedAmountWei) reject('Create-time calldata requires fixed-wei DELEGATE checkout');
    if (v.publicMetadata && Object.hasOwn(v.publicMetadata, 'quickpay')) reject('quickpay metadata is reserved');
  });

const callbackDataFields = [
  'token:address',
  'owner:address',
  'payer:address',
  'amount:uint256',
  'orderId:bytes32',
  'calldataNonce:uint256',
  'deadline:uint256',
  'calldataHash:bytes32',
];
const callbackSignTypes: Record<string, { primaryType: string; fields: string[] }> = {
  ERC20_3009: { primaryType: 'Eip3009CallbackData', fields: callbackDataFields },
  ERC20_APPROVE_XFER: { primaryType: 'Permit2CallbackData', fields: ['permit2:address', ...callbackDataFields] },
};
const eip712DomainFields = ['name:string', 'version:string', 'chainId:uint256', 'verifyingContract:address'];

interface CallbackSignRequest {
  domain: { chainId: number };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: { payer: string; orderId: string; calldataHash: string; permit2?: string };
}

/**
 * Bind a server-built callback authorization to this order before returning it
 * for signing. The server rebuilds and verifies these fields itself; this local
 * check stops a mismatched request from reaching the payer's signer. Token and
 * amount are pay-to (destination/payout) terms, so they cannot be compared with
 * the source-chain accept entry.
 */
function assertCallbackSignRequest(
  request: CallbackSignRequest | undefined,
  order: { flow: string; orderId: string; fromAddress: string; destinationChain: number; callbackCalldata?: string },
): void {
  if (!request) return;
  const expected = callbackSignTypes[order.flow];
  const calldata = order.callbackCalldata && order.callbackCalldata.length > 2 ? order.callbackCalldata : undefined;
  const fields = (name: string) => request.types[name]?.map((f) => `${f.name}:${f.type}`).join(',');
  const structs = Object.keys(request.types).filter((name) => name !== 'EIP712Domain');
  if (
    !expected ||
    !calldata ||
    request.primaryType !== expected.primaryType ||
    structs.length !== 1 ||
    fields(expected.primaryType) !== expected.fields.join(',') ||
    (request.types.EIP712Domain !== undefined && fields('EIP712Domain') !== eip712DomainFields.join(',')) ||
    request.domain.chainId !== order.destinationChain ||
    request.message.payer.toLowerCase() !== order.fromAddress.toLowerCase() ||
    request.message.orderId.toLowerCase() !== keccak256(toUtf8Bytes(order.orderId)) ||
    request.message.calldataHash.toLowerCase() !== keccak256(calldata) ||
    (order.flow === 'ERC20_APPROVE_XFER') !== (request.message.permit2 !== undefined)
  )
    invalidResponse('Order callback authorization does not match the requested order');
}

export interface GoatFlowGatewayOptions {
  apiKey: string;
  apiSecret: string;
  defaultChainId?: number;
  checkoutOrigin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  recoveryStore?: PaymentRecoveryStore;
  /** Stable merchant scope across credential changes. Reused keys with a new origin/API key fail closed. */
  recoveryNamespace?: string;
}

/** HMAC merchant API adapter. Its transport preserves AgentKit cancellation and the released signing format. */
export class GoatFlowGatewayAdapter implements MerchantGatewayAdapter {
  readonly managesIdempotency = true;
  private readonly origin: string;
  private readonly store: PaymentRecoveryStore;
  constructor(
    baseUrl: string,
    private readonly options: GoatFlowGatewayOptions,
  ) {
    const url = trustedPaymentUrl(baseUrl);
    this.origin = url.origin;
    if (url.pathname !== '/' || url.search || url.hash) invalid('Flow API base URL must be an origin');
    if (!options.apiKey || !options.apiSecret) invalid('GOAT Flow API key and secret are required');
    if (options.recoveryNamespace !== undefined && !options.recoveryNamespace.trim())
      invalid('Recovery namespace must not be empty');
    if (options.timeoutMs !== undefined && !isValidTimeout(options.timeoutMs)) invalid('Invalid request timeout');
    this.store = options.recoveryStore ?? new InMemoryPaymentRecoveryStore();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    expect402 = false,
  ) {
    const response = await paymentFetch(this.origin, {
      fetchImpl: this.options.fetchImpl,
      signal,
      timeoutMs: this.options.timeoutMs,
    })(`${this.origin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...signRequest(body ?? {}, this.options.apiKey, this.options.apiSecret),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Do not echo authenticated error bodies: they may contain secrets or private metadata.
    if (!response.ok && !(expect402 && response.status === 402)) {
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        `GOAT Flow request failed (${response.status})`,
      );
    }
    return jsonObject(response);
  }

  private async once<T>(
    rail: 'checkout' | 'order',
    key: string,
    terms: unknown,
    ctx: ActionContext | undefined,
    fn: () => Promise<T>,
    replayExisting = false,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    // A stable namespace moves origin/API-key identity into the terms check,
    // so a configuration change cannot silently bypass an existing key.
    const identity =
      this.options.recoveryNamespace === undefined
        ? { key: [this.origin, this.options.apiKey, key], terms }
        : { key: [this.options.recoveryNamespace, key], terms: [this.origin, this.options.apiKey, terms] };
    const operationId = `${rail}:${paymentFingerprint(identity.key)}`;
    const record: PaymentRecovery = {
      kind: 'paykit',
      operationId,
      rail,
      phase: 'prepared',
      origin: this.origin,
      fingerprint: paymentFingerprint(identity.terms),
    };
    const context = {
      signal,
      // Preserve the caller's receiver and defer accessor evaluation until
      // notifyRecovery can isolate it. The positional signal may override ctx.
      get checkpointRecovery() {
        const observer = ctx?.checkpointRecovery;
        return observer ? (record: ActionRecovery) => Reflect.apply(observer, ctx, [record]) : undefined;
      },
    };
    const previous = await beginPayment(this.store, record, context, {
      allowPrepared: true,
      replayRequest: replayExisting,
      operationReference: key,
    });
    if (previous?.phase === 'complete') return replayResult<T>(previous);
    const journal = paymentJournal(this.store, record, context);
    try {
      await claimPaymentRequest(
        this.store,
        record,
        context,
        {},
        {
          replayRequest: replayExisting,
          operationReference: key,
        },
      );
      const result = await fn();
      return await completePayment(this.store, journal, record, result);
    } catch (error) {
      return throwPaymentFailure(error, record, context, 'GOAT Flow operation incomplete; reconcile before retrying');
    }
  }

  async createOrder(
    params: CreateOrderParams,
    signal?: AbortSignal,
    ctx?: ActionContext,
  ): Promise<Order & { raw: Record<string, unknown> }> {
    return this.createOrderFromParsedInput(parseFlow(flowCreateOrderSchema, params, 'input'), signal, ctx);
  }

  /** Runtime action boundary; direct callers should use createOrder for validation. */
  async createOrderFromParsedInput(
    p: z.output<typeof flowCreateOrderSchema>,
    signal?: AbortSignal,
    ctx?: ActionContext,
  ): Promise<Order & { raw: Record<string, unknown> }> {
    signal ??= ctx?.signal;
    // Recovery changes retry behavior, not the payment intent. Only the server's
    // explicit topup replay contract permits another creation request.
    const { recoverExistingOrder, ...terms } = p;
    return this.once(
      'order',
      p.dappOrderId,
      { ...terms, fromAddress: terms.fromAddress.toLowerCase(), tokenContract: terms.tokenContract?.toLowerCase() },
      ctx,
      async () => {
        const body: Record<string, unknown> = {
          dapp_order_id: p.dappOrderId,
          chain_id: p.chainId,
          token_symbol: p.tokenSymbol,
          from_address: p.fromAddress,
          amount_wei: p.amountWei,
        };
        if (p.tokenContract) body.token_contract = p.tokenContract;
        if (p.callbackCalldata) body.callback_calldata = p.callbackCalldata;
        if (p.recoverExistingOrder) body.recover_existing_order = true;
        const raw = await this.request('POST', '/api/v1/orders', body, signal, true);
        const parsed = parseFlow(
          z
            .object({
              order_id: z.string().min(1),
              flow: z.enum(['ERC20_DIRECT', 'ERC20_3009', 'ERC20_APPROVE_XFER']),
              token_symbol: z.string().min(1),
              accepts: z
                .array(
                  z
                    .object({
                      scheme: z.enum(['exact', 'exact-eip3009']),
                      network: z.string(),
                      asset: address,
                      payTo: address,
                      amount: wei,
                    })
                    .passthrough(),
                )
                .nonempty(),
              extensions: z
                .object({
                  goatx402: z
                    .object({
                      expiresAt: z.number().int().positive(),
                      destinationChain: z.string().regex(/^eip155:\d+$/),
                    })
                    .passthrough(),
                })
                .passthrough(),
              calldata_sign_request: z
                .object({
                  domain: z.object({
                    name: z.string(),
                    version: z.string(),
                    chainId: z.number().int().positive().safe(),
                    verifyingContract: address,
                  }),
                  types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
                  primaryType: z.string(),
                  message: z.object({
                    token: address,
                    owner: address,
                    payer: address,
                    amount: wei,
                    orderId: z.string(),
                    calldataNonce: z.string(),
                    deadline: z.string(),
                    calldataHash: z.string(),
                    permit2: address.optional(),
                  }),
                })
                .optional(),
            })
            .passthrough(),
          raw,
          'response',
        );
        // Without an explicit contract, the requested symbol must identify one
        // unambiguous accept entry; never choose by the server's ordering.
        const options = parsed.accepts.filter(
          (a) =>
            a.network === `eip155:${p.chainId}` &&
            a.amount === p.amountWei &&
            (!p.tokenContract || a.asset.toLowerCase() === p.tokenContract.toLowerCase()),
        );
        const option = options[0];
        if (
          !option ||
          options.length !== 1 ||
          parsed.token_symbol.trim().toUpperCase() !== p.tokenSymbol.trim().toUpperCase()
        )
          invalidResponse('Order payment terms do not match the requested chain/token/amount');
        const destinationChain = Number(parsed.extensions.goatx402.destinationChain.split(':')[1]);
        if (!Number.isSafeInteger(destinationChain) || destinationChain <= 0)
          invalidResponse('Invalid order destination chain');
        assertCallbackSignRequest(parsed.calldata_sign_request, {
          flow: parsed.flow,
          orderId: parsed.order_id,
          fromAddress: p.fromAddress,
          destinationChain,
          callbackCalldata: p.callbackCalldata,
        });
        return {
          raw,
          orderId: parsed.order_id,
          flow: parsed.flow,
          tokenSymbol: p.tokenSymbol,
          tokenContract: option.asset,
          payToAddress: option.payTo,
          fromChainId: p.chainId,
          payToChainId: destinationChain,
          amountWei: option.amount,
          expiresAt: parsed.extensions.goatx402.expiresAt,
          calldataSignRequest: parsed.calldata_sign_request,
        };
      },
      recoverExistingOrder === true,
      signal,
    );
  }

  async createPaymentIntent(
    input: Omit<CreatePaymentIntentInput, 'to'> & { to?: string },
    signal?: AbortSignal,
    ctx?: ActionContext,
  ): Promise<CreatePaymentIntentResult> {
    const chainId = input.chainId ?? this.options.defaultChainId;
    if (!chainId || !input.fromAddress || !input.idempotencyKey)
      invalid('GOAT Flow order creation requires chainId, fromAddress and idempotencyKey');
    const order = await this.createOrder(
      {
        dappOrderId: input.idempotencyKey,
        chainId,
        fromAddress: input.fromAddress,
        tokenSymbol: input.asset,
        tokenContract: input.tokenContract,
        amountWei: input.amount,
        callbackCalldata: input.callbackCalldata,
      },
      signal,
      ctx,
    );
    return {
      paymentId: order.orderId,
      status: 'created',
      payToAddress: order.payToAddress,
      tokenAddress: order.tokenContract,
      chainId: order.fromChainId,
      amountWei: order.amountWei,
      expiresAt: order.expiresAt,
      calldataSignRequest: order.calldataSignRequest
        ? { ...order.calldataSignRequest, domain: { ...order.calldataSignRequest.domain } }
        : undefined,
      raw: order.raw,
    };
  }

  async getPaymentStatus(paymentId: string, signal?: AbortSignal) {
    const raw = await this.request('GET', `/api/v1/orders/${pathSegment(paymentId)}`, undefined, signal);
    const parsed = z.enum(flowOrderStatuses).safeParse(raw.status);
    if (!parsed.success)
      throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, 'Unknown GOAT Flow order status', parsed.error);
    const status = parsed.data;
    if (raw.order_id !== paymentId) invalidResponse('Order response does not match requested payment');
    return { paymentId, status: legacyStatus[status], orderStatus: status, raw };
  }

  async submitPaymentAuthorization(paymentId: string, signature: string, signal?: AbortSignal) {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) invalid('Invalid authorization signature');
    const raw = await this.request(
      'POST',
      `/api/v1/orders/${pathSegment(paymentId)}/calldata-signature`,
      { signature },
      signal,
    );
    if (raw.order_id !== paymentId || raw.status !== 'ok') invalidResponse('Invalid signature acknowledgement');
    return { paymentId, status: 'authorized' as const, raw };
  }

  async cancelPayment(paymentId: string, signal?: AbortSignal) {
    const raw = await this.request('POST', `/api/v1/orders/${pathSegment(paymentId)}/cancel`, {}, signal);
    if (raw.order_id !== paymentId || raw.status !== 'cancelled')
      invalidResponse('Invalid cancellation acknowledgement');
    return { paymentId, status: 'cancelled' as const, raw };
  }

  async getPaymentProof(paymentId: string, signal?: AbortSignal) {
    const data = await this.request('GET', `/api/v1/orders/${pathSegment(paymentId)}/proof`, undefined, signal);
    const payload = parseFlow(
      z.object({
        order_id: z.string(),
        tx_hash: transactionHash,
        log_index: z.number().int().nonnegative(),
        from_addr: address,
        to_addr: address,
        amount_wei: wei,
        from_chain_id: z.number().int().positive().safe(),
        status: z.enum(flowOrderStatuses),
      }),
      data.payload,
      'response',
    );
    const signature = parseFlow(z.string().min(1), data.signature, 'response');
    if (payload.order_id !== paymentId) invalidResponse('Payment record does not match the order');
    return { payload, signature, cryptographicAttestation: false as const };
  }

  async createCheckout(
    params: CreateCheckoutSessionParams,
    signal?: AbortSignal,
    ctx?: ActionContext,
  ): Promise<CheckoutSession> {
    return this.createCheckoutFromParsedInput(parseFlow(flowCheckoutSchema, params, 'input'), signal, ctx);
  }

  /** Runtime action boundary; direct callers should use createCheckout for validation. */
  async createCheckoutFromParsedInput(
    p: z.output<typeof flowCheckoutSchema>,
    signal?: AbortSignal,
    ctx?: ActionContext,
  ): Promise<CheckoutSession> {
    signal ??= ctx?.signal;
    if (!this.options.checkoutOrigin) invalid('Configure checkoutOrigin before creating hosted checkout links');
    const checkoutOrigin = trustedOrigin(this.options.checkoutOrigin);
    return this.once(
      'checkout',
      p.clientReferenceId,
      p,
      ctx,
      async () => {
        const body: Record<string, unknown> = {
          checkout_type: p.checkoutType,
          payment_rails: p.paymentRails.join(','),
        };
        const scalars = {
          price: p.price,
          chain_id: p.chainId,
          fixed_amount_wei: p.fixedAmountWei,
          callback_calldata: p.callbackCalldata,
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          client_reference_id: p.clientReferenceId,
          expires_in: p.expiresIn,
          fiat_currency: p.fiatCurrency,
          fiat_amount: p.fiatAmount,
        };
        for (const [k, v] of Object.entries(scalars)) if (v !== undefined) body[k] = v;
        for (const [k, v] of Object.entries({
          acceptable_tokens: p.acceptableTokens,
          line_items_json: p.lineItems,
          public_metadata_json: p.publicMetadata,
          private_metadata_json: p.privateMetadata,
        })) {
          if (v !== undefined) body[k] = JSON.stringify(v);
        }
        const raw = await this.request('POST', '/api/v1/checkout/sessions', body, signal);
        const data = parseFlow(
          z.object({
            checkout_id: z.string().min(1),
            checkout_type: z.enum(['DIRECT', 'DELEGATE']),
            url: z.string().url(),
            expires_at: z.number().int().positive(),
          }),
          raw,
          'response',
        );
        const url = new URL(data.url);
        if (
          url.origin !== checkoutOrigin ||
          url.username ||
          url.password ||
          url.searchParams.get('cs') !== data.checkout_id ||
          data.checkout_type !== p.checkoutType ||
          !/^\/(?:checkout(?:\/(?:direct|delegate))?|paykit\/(?:direct|delegate))\/?$/.test(url.pathname)
        )
          invalidResponse('Checkout link does not match configured origin and session');
        return {
          checkoutId: data.checkout_id,
          checkoutType: data.checkout_type,
          url: data.url,
          expiresAt: data.expires_at,
        };
      },
      false,
      signal,
    );
  }
}
