import { MPPClient, MPPError, type MPPChallenge, type MPPVerifyResult } from 'goatflow-sdk';
import {
  endpoints,
  inspect,
  loadManifest,
  payX402,
  payProduct,
  createFiatCheckoutLink,
  type PaymentBackend,
  type PayX402Result,
  type FiatCheckoutLink,
} from 'goatflow-paykit';
import { goatNetworks } from '../../networks/goat/config';
import type { Signer } from 'ethers';
import type { ActionContext } from '../../core/schema/action';
import type { WalletProvider } from '../../core/wallet/wallet-provider';
import { isNoopWallet } from '../../core/wallet/noop-wallet-provider';
import { broadcastTransaction } from '../../core/wallet/broadcast-transaction';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import { notifyRecovery } from '../../core/runtime/recovery-observer';
import { preflightCard, preflightX402 } from './preflight';
import {
  beginPayment,
  assertPaymentFingerprint,
  assertRecoveryIntent,
  existingPayment,
  recoveryIntentMismatch,
  claimPaymentRequest,
  paymentJournal,
  completePayment,
  throwPaymentFailure,
} from './journal';
import { isPositiveUint256 } from '../../core/schema/validators';
import { raceSignal } from '../../core/runtime/abort';
import {
  InMemoryPaymentRecoveryStore,
  paymentFingerprint,
  paymentFingerprintPattern,
  recoveryRequired,
  replayResult,
  readPaymentRecovery,
  recoverySessionToken,
  canPrepareX402,
  type PaymentRecovery,
  type PaymentRecoveryStore,
} from './recovery';
import {
  abortableSleep,
  evmAddressPattern,
  invalid,
  invalidResponse,
  jsonObject,
  paymentFetch,
  throwIfAborted,
  txHashPattern,
  sessionStates,
  paymentTarget,
} from './http';

export interface PaykitOptions {
  wallet?: WalletProvider;
  /** MPP uses the canonical ethers SDK, including its replacement watcher. */
  mppSigner?: Signer;
  recoveryStore?: PaymentRecoveryStore;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Optional operator restriction, in addition to the merchant's runtime catalog. */
  allowedChainIds?: readonly number[];
}

export interface PaykitPaymentInput {
  url: string;
  chainId: number;
  tokenContract?: string;
  tokenSymbol?: string;
  amount?: string;
  productKey?: string;
  memo?: string;
  idempotencyKey?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface PaykitMppInput {
  url: string;
  route: string;
  idempotencyKey?: string;
  maxAmountWei?: string;
  maxVerifyAttempts?: number;
}

export interface CardCheckoutInput {
  url: string;
  productKey?: string;
  amount?: string;
  memo?: string;
  idempotencyKey?: string;
}

export interface PaykitSessionStatus {
  sessionId: string;
  merchantId: string;
  orderId?: string;
  status: 'CREATED' | 'ORDER_CREATED' | 'PAYMENT_CONFIRMED' | 'EXPIRED' | 'FAILED' | 'CANCELLED';
  txHash?: string;
  amountWei: string;
  chainId: number;
  tokenContract: string;
}

/** Public, credential-less PayKit APIs. Merchant HMAC credentials never enter this service. */
export class PaykitService {
  readonly recoveryStore: PaymentRecoveryStore;
  constructor(private readonly options: PaykitOptions = {}) {
    this.recoveryStore = options.recoveryStore ?? new InMemoryPaymentRecoveryStore();
  }

  private transport(origin: string, ctx: ActionContext): typeof fetch {
    return paymentFetch(origin, {
      fetchImpl: this.options.fetchImpl,
      signal: ctx.signal,
      timeoutMs: this.options.requestTimeoutMs,
    });
  }

  private contextChain(ctx: ActionContext): number {
    if (/^eip155:/i.test(ctx.network) && !/^eip155:[1-9][0-9]*$/.test(ctx.network))
      invalid('Invalid EIP-155 action context; use eip155:<chainId> with a positive decimal chain ID');
    const expected = ctx.network.startsWith('eip155:')
      ? Number(ctx.network.slice(7))
      : goatNetworks[ctx.network as keyof typeof goatNetworks]?.chainId;
    if (expected === undefined)
      invalid('Unknown payment action context; use eip155:<chainId> or a supported GOAT network');
    if (!Number.isSafeInteger(expected) || expected <= 0)
      invalid('Invalid action context chain ID; use a positive safe integer');
    return expected;
  }

  private chainAllowed(chainId: number, ctx: ActionContext, journaled = false): void {
    const expected = this.contextChain(ctx);
    if (expected !== chainId)
      invalid(
        journaled
          ? `Journaled payment chain eip155:${chainId} does not match action context ${ctx.network}${!ctx.network.startsWith('eip155:') && expected !== undefined ? ` (eip155:${expected})` : ''}; use action context eip155:${chainId} to replay this payment`
          : 'Payment chain must match the action context (use eip155:<chainId>)',
      );
    if (!Number.isSafeInteger(chainId) || chainId <= 0) invalid('Invalid payment chain');
    if (this.options.allowedChainIds && !this.options.allowedChainIds.includes(chainId)) {
      throw new AgentkitRuntimeError(ErrorCodes.POLICY_BLOCKED, 'Payment chain is not allowed');
    }
  }

  private operationKey(inputKey: string | undefined, ctx: ActionContext): string {
    if (inputKey && ctx.idempotencyKey && inputKey !== ctx.idempotencyKey) invalid('Conflicting idempotency keys');
    const key = inputKey ?? ctx.idempotencyKey;
    if (!key?.trim() || key.length > 200) invalid('A non-empty idempotencyKey (at most 200 characters) is required');
    return key;
  }

  private async walletRead<T>(read: () => Promise<T>, ctx: ActionContext, message: string): Promise<T> {
    try {
      throwIfAborted(ctx.signal);
      return await raceSignal(read(), ctx.signal);
    } catch (cause) {
      throwIfAborted(ctx.signal);
      if (cause instanceof AgentkitRuntimeError) throw cause;
      throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, message, cause);
    }
  }

  private async payerAddress(read: () => Promise<string>, ctx: ActionContext): Promise<string> {
    const payer = await this.walletRead(read, ctx, 'Cannot read payer address');
    if (typeof payer !== 'string' || !evmAddressPattern.test(payer)) invalid('Invalid payer address');
    return payer;
  }

  private async manifest(url: string, ctx: ActionContext) {
    const target = paymentTarget(url);
    const transport = this.transport(target.origin, ctx);
    try {
      const { manifest } = await loadManifest(url, transport);
      // Pin the validated catalog used by preflight for the SDK's subsequent read.
      const fetchImpl: typeof fetch = (url, init) =>
        (url instanceof Request ? url.url : String(url)) === target.manifestUrl
          ? Promise.resolve(Response.json(manifest))
          : transport(url, init);
      return { manifest, fetchImpl };
    } catch (error) {
      throwIfAborted(ctx.signal);
      throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, 'Cannot load a valid merchant manifest', error);
    }
  }

  private failure(error: unknown, record: PaymentRecovery, ctx: ActionContext): never {
    const message =
      error instanceof MPPError
        ? `MPP operation incomplete (${['network_error', 'parse_error', 'payment_failed', 'chain_mismatch', 'challenge_expired', 'receipt_missing', 'receipt_malformed', 'verify_timeout', 'user_rejected'].includes(error.code ?? '') ? error.code : 'request_failed'}); use recovery data`
        : record.rail === 'mpp'
          ? 'MPP operation incomplete; use recovery data'
          : 'PayKit operation incomplete; inspect recovery data before retrying';
    // The MPP SDK wraps failures from our guarded wallet/provider callbacks.
    // Only unwrap our classified errors; arbitrary provider text stays private.
    if (error instanceof MPPError && error.cause instanceof AgentkitRuntimeError) error = error.cause;
    return throwPaymentFailure(error, record, ctx, message);
  }

  async inspect(url: string, ctx: ActionContext) {
    const loaded = await this.manifest(url, ctx);
    try {
      return await inspect(url, loaded.fetchImpl);
    } catch (cause) {
      throwIfAborted(ctx.signal);
      throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, 'Cannot inspect merchant manifest', cause);
    }
  }

  private validateSession(data: Record<string, unknown>, sessionId: string, merchantId: string): void {
    const states: readonly string[] = sessionStates;
    if (
      data.session_id !== sessionId ||
      data.merchant_id !== merchantId ||
      !states.includes(String(data.status)) ||
      !isPositiveUint256(data.amount_wei) ||
      typeof data.chain_id !== 'number' ||
      !Number.isSafeInteger(data.chain_id) ||
      data.chain_id <= 0 ||
      !evmAddressPattern.test(String(data.token_contract)) ||
      (data.tx_hash && !txHashPattern.test(String(data.tx_hash)))
    )
      invalidResponse('Invalid or mismatched payment session response');
    if (data.status === 'PAYMENT_CONFIRMED' && !data.tx_hash)
      invalidResponse('Confirmed session has no transaction hash');
  }

  private sessionHandle(data: Record<string, unknown>, merchantId: string) {
    if (
      typeof data.session_id !== 'string' ||
      !data.session_id ||
      ['.', '..'].includes(data.session_id) ||
      data.merchant_id !== merchantId ||
      !(sessionStates as readonly string[]).includes(String(data.status))
    )
      invalidResponse('Invalid payment session response');
    const expiresAt = Number(data.expires_at);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) invalidResponse('Invalid payment session expiry');
    return {
      sessionId: data.session_id,
      orderId: typeof data.order_id === 'string' ? data.order_id : undefined,
      expiresAt,
    };
  }

  async sessionStatus(
    input: { url: string; sessionId?: string; operationId?: string; expectedFingerprint?: string },
    ctx: ActionContext,
  ): Promise<PaykitSessionStatus> {
    this.validateExpectedFingerprint(input.expectedFingerprint);
    if (input.expectedFingerprint !== undefined && !input.operationId)
      invalid('An expected fingerprint requires an operationId');
    const target = paymentTarget(input.url);
    let record: PaymentRecovery | undefined = input.operationId
      ? await readPaymentRecovery(this.recoveryStore, input.operationId)
      : undefined;
    if (
      record &&
      (record.origin !== target.origin || record.merchantId !== target.merchantId || record.rail !== 'x402')
    ) {
      if (input.expectedFingerprint !== undefined) throw recoveryIntentMismatch(input.operationId!);
      invalid('Recovery record does not belong to this merchant payment');
    }
    if (input.expectedFingerprint !== undefined && !record) throw recoveryIntentMismatch(input.operationId!);
    if (record) record = await assertRecoveryIntent(this.recoveryStore, record, input.expectedFingerprint);
    if (record?.sessionId && input.sessionId && record.sessionId !== input.sessionId)
      invalid('Session does not match recovery record');
    let sessionId = input.sessionId ?? record?.sessionId;
    const transport = this.transport(target.origin, ctx);
    if (!sessionId && record?.sessionCreateBody) {
      // Replay the original idempotent request, without consulting a potentially
      // changed catalog and without constructing a wallet/payment backend. Even
      // a fresh session returned here is only inspected, never paid.
      const response = await transport(endpoints(target.origin).sessionCreate, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: record.sessionCreateBody,
      });
      if (!response.ok)
        throw new AgentkitRuntimeError(
          ErrorCodes.ADAPTER_REQUEST_FAILED,
          `Session recovery failed (${response.status})`,
        );
      sessionId = this.sessionHandle(await jsonObject(response), target.merchantId).sessionId;
      // Do not write a stale snapshot over a concurrent payer's broadcast hash.
      // Subsequent status calls can safely replay the same server-side key.
    }
    if (!sessionId && record && canPrepareX402(record)) throw recoveryIntentMismatch(input.operationId!);
    if (!sessionId) invalid('A sessionId or an operationId with a known session is required');
    const response = await transport(endpoints(target.origin).sessionStatus(sessionId));
    if (!response.ok)
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        `Session status request failed (${response.status})`,
      );
    const data = await jsonObject(response);
    this.validateSession(data, sessionId, target.merchantId);
    if (record?.chainId !== undefined && data.chain_id !== record.chainId)
      invalidResponse('Session payment chain changed');
    if (record?.sessionCreateBody) {
      if (String(data.token_contract).toLowerCase() !== recoverySessionToken(record.sessionCreateBody).toLowerCase())
        invalidResponse('Session payment token changed');
    }
    return {
      sessionId,
      merchantId: target.merchantId,
      status: data.status as PaykitSessionStatus['status'],
      orderId: typeof data.order_id === 'string' ? data.order_id : undefined,
      txHash: typeof data.tx_hash === 'string' && data.tx_hash ? data.tx_hash : record?.txHash,
      amountWei: String(data.amount_wei),
      chainId: Number(data.chain_id),
      tokenContract: String(data.token_contract),
    };
  }

  async pay(input: PaykitPaymentInput, ctx: ActionContext): Promise<PayX402Result> {
    input = {
      ...input,
      tokenSymbol: input.tokenSymbol?.trim().toUpperCase(),
      tokenContract: input.tokenContract?.trim(),
      amount: input.amount?.trim(),
      productKey: input.productKey?.trim(),
      memo: input.memo?.trim(),
    };
    if (!!input.amount === !!input.productKey) invalid('Provide exactly one of amount or productKey');
    for (const [value, maximum] of [
      [input.pollTimeoutMs, 300_000],
      [input.pollIntervalMs, 30_000],
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum!))
        invalid('Invalid payment polling limits');
    }
    const target = paymentTarget(input.url);
    const wallet = this.options.wallet;
    if (!wallet?.broadcastErc20 || !wallet.getChainId || isNoopWallet(wallet))
      invalid('PayKit needs a real wallet with broadcastErc20 and getChainId');
    this.chainAllowed(input.chainId, ctx);
    const payer = await this.payerAddress(() => wallet.getAddress(), ctx);
    const operationId = this.operationKey(input.idempotencyKey, ctx);
    const record: PaymentRecovery = {
      kind: 'paykit',
      operationId,
      phase: 'prepared',
      rail: 'x402',
      origin: target.origin,
      merchantId: target.merchantId,
      payer,
      chainId: input.chainId,
      fingerprint: paymentFingerprint([
        target.origin,
        target.merchantId,
        payer.toLowerCase(),
        input.chainId,
        input.tokenContract?.toLowerCase(),
        input.tokenSymbol,
        input.amount,
        input.productKey,
        input.memo,
      ]),
    };
    const existing = await existingPayment(this.recoveryStore, record, ctx, { allowPrepared: true });
    if (existing?.phase === 'complete') return replayResult<PayX402Result>(existing);
    if ((await this.walletRead(() => wallet.getChainId!(), ctx, 'Cannot read wallet chain')) !== input.chainId)
      invalid('Wallet chain does not match payment chain');
    const loaded = await this.manifest(input.url, ctx);
    preflightX402(input, loaded.manifest);
    const previous = existing ?? (await beginPayment(this.recoveryStore, record, ctx, { allowPrepared: true }));
    if (previous?.phase === 'complete') return replayResult<PayX402Result>(previous);
    const journal = paymentJournal(this.recoveryStore, record, ctx);
    // Once a transfer is known, storage failure must not prevent status retrieval.
    // Keep local evidence and retry the checkpoint once; completion will try again.
    const saveBroadcast = async (patch: Partial<PaymentRecovery>) => {
      if (record.phase === 'complete') return;
      await journal.checkpointAfterBroadcast(patch);
    };
    let expiresAt = 0;
    let selectedToken = input.tokenContract;
    const transport = loaded.fetchImpl;
    let statusFailure: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (statusFailure) throw statusFailure;
      const requestUrl = url instanceof Request ? url.url : String(url);
      if (requestUrl === endpoints(target.origin).sessionCreate && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { token_contract?: string };
        selectedToken = body.token_contract;
        // Reserving an intent does not authorize a POST. This immutable claim
        // carries the complete request and elects one sender across processes.
        await claimPaymentRequest(this.recoveryStore, record, ctx, { sessionCreateBody: init.body });
        await journal.save({});
      }
      const response = await transport(url, init);
      if (requestUrl === endpoints(target.origin).sessionCreate && response.ok) {
        const handle = this.sessionHandle(await jsonObject(response, { clone: true }), target.merchantId);
        expiresAt = handle.expiresAt;
        await journal.save({
          sessionId: handle.sessionId,
          orderId: handle.orderId,
        });
      }
      if (record.sessionId && requestUrl === endpoints(target.origin).sessionStatus(record.sessionId) && response.ok) {
        // Body/transport errors remain retryable by the SDK's bounded poller.
        // Only semantic validation of a decoded response latches terminal failure.
        const data = await jsonObject(response, { clone: true });
        try {
          this.validateSession(data, record.sessionId, target.merchantId);
          if (
            data.chain_id !== input.chainId ||
            !selectedToken ||
            String(data.token_contract).toLowerCase() !== selectedToken.toLowerCase()
          )
            invalidResponse('Session payment chain/token changed');
        } catch (error) {
          statusFailure = error;
          throw error;
        }
        if (data.tx_hash && (data.tx_hash !== record.txHash || record.phase !== 'broadcast'))
          await saveBroadcast({ txHash: String(data.tx_hash), phase: 'broadcast' });
      }
      return response;
    };
    const backend: PaymentBackend = {
      getAddress: async () => payer,
      transferErc20: async (terms) => {
        throwIfAborted(ctx.signal);
        if (
          (await this.walletRead(() => wallet.getChainId!(), ctx, 'Cannot read wallet chain')) !== terms.chainId ||
          (await this.payerAddress(() => wallet.getAddress(), ctx)).toLowerCase() !== payer.toLowerCase()
        )
          invalid('Payer changed before payment');
        if (
          !evmAddressPattern.test(terms.to) ||
          !evmAddressPattern.test(terms.tokenContract) ||
          !isPositiveUint256(terms.amountWei)
        )
          invalidResponse('Invalid transfer terms');
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000 + 5)
          invalidResponse('Payment session expired or too close to expiry');
        await journal.save({ phase: 'submitting' });
        throwIfAborted(ctx.signal);
        const tx = await wallet.broadcastErc20!(terms.tokenContract, terms.to, terms.amountWei, {
          signal: ctx.signal,
          onSignedTransaction: (signedTxHash) => journal.save({ signedTxHash }),
        });
        await saveBroadcast({ rawSubmissionHash: tx.txHash });
        if (!txHashPattern.test(tx.txHash)) throw new Error('Missing broadcast hash');
        await saveBroadcast({ phase: 'broadcast', txHash: tx.txHash });
        throwIfAborted(ctx.signal);
        return tx.txHash;
      },
    };
    try {
      const shared = {
        input: input.url,
        backend,
        fetchImpl,
        chainId: input.chainId,
        tokenContract: input.tokenContract,
        tokenSymbol: input.tokenSymbol,
        idempotencyKey: operationId,
        pollTimeoutMs: input.pollTimeoutMs ?? 60_000,
        pollIntervalMs: input.pollIntervalMs ?? 3000,
        sleep: (ms: number) => {
          if (statusFailure) throw statusFailure;
          return abortableSleep(ms, ctx.signal);
        },
      };
      const result = input.productKey
        ? await payProduct({ ...shared, productKey: input.productKey })
        : await payX402({ ...shared, amount: input.amount!, memo: input.memo });
      if (statusFailure) throw statusFailure;
      if (result.tx_hash && (result.tx_hash !== record.txHash || record.phase !== 'broadcast'))
        await saveBroadcast({ txHash: result.tx_hash, phase: 'broadcast' });
      if (record.phase === 'complete' && !record.persistenceError) return replayResult<PayX402Result>(record);
      if (!result.ok) throw recoveryRequired(record);
      return await completePayment(this.recoveryStore, journal, record, result);
    } catch (error) {
      return this.failure(error, record, ctx);
    }
  }

  async createCardCheckout(input: CardCheckoutInput, ctx: ActionContext): Promise<FiatCheckoutLink> {
    input = { ...input, amount: input.amount?.trim(), productKey: input.productKey?.trim(), memo: input.memo?.trim() };
    const target = paymentTarget(input.url);
    const record: PaymentRecovery = {
      kind: 'paykit',
      operationId: this.operationKey(input.idempotencyKey, ctx),
      phase: 'prepared',
      rail: 'fiat',
      origin: target.origin,
      merchantId: target.merchantId,
      fingerprint: paymentFingerprint([
        target.origin,
        target.merchantId,
        'fiat',
        input.productKey,
        input.amount,
        input.memo,
      ]),
    };
    const existing = await existingPayment(this.recoveryStore, record, ctx, { allowPrepared: true });
    if (existing?.phase === 'complete') return replayResult<FiatCheckoutLink>(existing);
    const loaded = await this.manifest(input.url, ctx);
    preflightCard(input, loaded.manifest);
    const previous = existing ?? (await beginPayment(this.recoveryStore, record, ctx, { allowPrepared: true }));
    if (previous?.phase === 'complete') return replayResult<FiatCheckoutLink>(previous);
    const journal = paymentJournal(this.recoveryStore, record, ctx);
    try {
      await claimPaymentRequest(this.recoveryStore, record, ctx);
      const result = await createFiatCheckoutLink({
        ...input,
        input: input.url,
        fetchImpl: loaded.fetchImpl,
      });
      return await completePayment(this.recoveryStore, journal, record, result, { sessionId: result.checkout_id });
    } catch (error) {
      return this.failure(error, record, ctx);
    }
  }

  async payMpp(input: PaykitMppInput, ctx: ActionContext): Promise<MPPVerifyResult> {
    this.contextChain(ctx);
    this.verifyAttempts(input.maxVerifyAttempts);
    if (input.maxAmountWei !== undefined && !isPositiveUint256(input.maxAmountWei)) invalid('Invalid MPP amount cap');
    const target = paymentTarget(input.url);
    const signer = this.options.mppSigner;
    if (!signer?.provider) invalid('MPP requires an ethers signer with a provider');
    const payer = await this.payerAddress(() => signer.getAddress(), ctx);
    const operationId = this.operationKey(input.idempotencyKey, ctx);
    const intent = (chainId: number): PaymentRecovery => ({
      kind: 'paykit',
      operationId,
      phase: 'prepared',
      rail: 'mpp',
      origin: target.origin,
      merchantId: target.merchantId,
      payer,
      chainId,
      route: input.route,
      fingerprint: paymentFingerprint([
        target.origin,
        target.merchantId,
        'mpp',
        payer.toLowerCase(),
        input.route,
        chainId,
        input.maxAmountWei,
      ]),
    });
    // Replay against the original terms; a merchant's current catalog cannot
    // change a completed payment or authorize a second request for the same key.
    const stored = await readPaymentRecovery(this.recoveryStore, operationId);
    let existing: PaymentRecovery | undefined;
    if (stored) {
      if (stored.rail !== 'mpp')
        throw new AgentkitRuntimeError(ErrorCodes.IDEMPOTENCY_CONFLICT, 'Idempotency key belongs to another rail');
      const recordedChainId = stored.chainId!; // Required by the shared journal read validator.
      const recordedIntent = intent(recordedChainId);
      assertPaymentFingerprint(recordedIntent, stored);
      this.chainAllowed(recordedChainId, ctx, true);
      existing = await existingPayment(this.recoveryStore, recordedIntent, ctx, {
        allowPrepared: true,
        observed: stored,
      });
      if (existing?.phase === 'complete') return replayResult<MPPVerifyResult>(existing);
    }
    const loaded = await this.manifest(input.url, ctx);
    const route = loaded.manifest.rails.mpp.routes.find((r) => r.route_canonical === input.route);
    if (!loaded.manifest.rails.mpp.enabled || !route) invalid('MPP route is not available');
    // Base-unit caps are only meaningful for one token. Never accept a challenge
    // for a route that names its token by symbol alone.
    if (typeof route.token_contract !== 'string' || !evmAddressPattern.test(route.token_contract))
      invalidResponse('MPP route has no valid token contract');
    const routeToken = route.token_contract.toLowerCase();
    if (input.maxAmountWei && BigInt(route.amount_wei) > BigInt(input.maxAmountWei))
      invalid('MPP route exceeds the amount cap');
    const record = intent(route.chain_id);
    if (existing && existing.fingerprint !== record.fingerprint)
      throw new AgentkitRuntimeError(
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        'MPP route chain changed for this payment intent',
      );
    this.chainAllowed(route.chain_id, ctx);
    const readNetwork = () => this.walletRead(() => signer.provider!.getNetwork(), ctx, 'Cannot read MPP signer chain');
    if ((await readNetwork()).chainId !== BigInt(route.chain_id))
      invalid('MPP signer chain does not match payment chain');
    const previous = existing ?? (await beginPayment(this.recoveryStore, record, ctx, { allowPrepared: true }));
    if (previous?.phase === 'complete') return replayResult<MPPVerifyResult>(previous);
    const journal = paymentJournal(this.recoveryStore, record, ctx);
    const transport = this.transport(target.origin, ctx);
    const readPayer = () => this.payerAddress(() => signer.getAddress(), ctx);
    const client = new (class extends MPPClient {
      override async requestChallenge(p: Parameters<MPPClient['requestChallenge']>[0]) {
        const challenge = await super.requestChallenge(p);
        if (
          challenge.chainId !== route.chain_id ||
          !evmAddressPattern.test(challenge.tokenContract) ||
          !evmAddressPattern.test(challenge.recipient) ||
          !isPositiveUint256(challenge.amountWei) ||
          BigInt(challenge.amountWei) > BigInt(input.maxAmountWei ?? route.amount_wei) ||
          challenge.tokenContract.toLowerCase() !== routeToken
        )
          invalidResponse('MPP challenge exceeds or differs from the selected payment terms');
        await journal.save({ challenge });
        return challenge;
      }
      override async payChallenge(challenge: MPPChallenge) {
        throwIfAborted(ctx.signal);
        if ((await readPayer()).toLowerCase() !== payer.toLowerCase()) invalid('MPP payer changed');
        await journal.save({ phase: 'submitting' });
        throwIfAborted(ctx.signal);
        const sent = await super.payChallenge(challenge);
        // A failed checkpoint cannot undo this payment. The verify transport
        // retries it once, then continues with the known broadcast hash.
        await journal.checkpointAfterBroadcast({ phase: 'broadcast', txHash: sent.txHash });
        throwIfAborted(ctx.signal);
        return sent;
      }
    })({
      coreUrl: target.origin,
      // Split preparation/signing from broadcast so cancellation during either
      // preflight step cannot fall through into an irreversible RPC submission.
      signer: new Proxy(signer, {
        get(target, property) {
          if (property === 'provider' && target.provider)
            return new Proxy(target.provider, {
              get(provider, key) {
                if (key === 'getNetwork') return readNetwork;
                const value = Reflect.get(provider, key, provider);
                return typeof value === 'function' ? value.bind(provider) : value;
              },
            });
          if (property === 'sendTransaction')
            return (...args: Parameters<Signer['sendTransaction']>) => {
              return broadcastTransaction(target, args[0], ctx.signal, (signedTxHash) =>
                journal.save({ signedTxHash }),
              );
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      fetchImpl: async (url, init) => {
        const requestUrl = url instanceof Request ? url.url : String(url);
        if (record.txHash && requestUrl === `${target.origin}/mpp/v1/verify`) await journal.checkpointAfterBroadcast();
        else await journal.flush();
        return transport(url, init);
      },
      sleep: (ms) => abortableSleep(ms, ctx.signal),
    });
    try {
      await claimPaymentRequest(this.recoveryStore, record, ctx);
      const result = await client.pay({
        merchantId: target.merchantId,
        routeCanonical: input.route,
        maxVerifyAttempts: input.maxVerifyAttempts,
        onPhase: (phase, detail) => {
          if (phase === 'transaction_replaced') {
            const txHash = (detail as { txHash: string }).txHash;
            void journal.save({ txHash }).catch(() => {});
          }
        },
      });
      return await completePayment(this.recoveryStore, journal, record, result, { txHash: result.txHash });
    } catch (error) {
      // The replacement watcher queues writes without awaiting them. It is now
      // stopped by MPPClient, so drain its final hash before the caller can exit.
      if (record.phase !== 'complete') await journal.flush().catch(() => {});
      return this.failure(error, record, ctx);
    }
  }

  async resumeMpp(
    input: { url: string; operationId: string; expectedFingerprint?: string; maxVerifyAttempts?: number },
    ctx: ActionContext,
  ): Promise<MPPVerifyResult> {
    this.verifyAttempts(input.maxVerifyAttempts);
    this.validateExpectedFingerprint(input.expectedFingerprint);
    const target = paymentTarget(input.url);
    let record: PaymentRecovery | undefined = await readPaymentRecovery(this.recoveryStore, input.operationId);
    if (
      !record ||
      record.rail !== 'mpp' ||
      record.origin !== target.origin ||
      record.merchantId !== target.merchantId
    ) {
      if (input.expectedFingerprint !== undefined) throw recoveryIntentMismatch(input.operationId);
      invalid('No matching MPP recovery record');
    }
    const payer = record.payer!; // Required by the shared MPP journal read validator.
    const signer = this.options.mppSigner;
    if (!signer || (await this.payerAddress(() => signer.getAddress(), ctx)).toLowerCase() !== payer.toLowerCase())
      invalid('MPP recovery requires the original payer');
    record = await assertRecoveryIntent(this.recoveryStore, record, input.expectedFingerprint);
    notifyRecovery(ctx, record);
    const txHash = record.txHash ?? record.signedTxHash;
    if (!txHash || !txHashPattern.test(txHash)) throw recoveryRequired(record);
    if (record.phase === 'complete') return replayResult<MPPVerifyResult>(record);
    if (!record.challenge) throw recoveryRequired(record);
    const journal = paymentJournal(this.recoveryStore, record, ctx);
    try {
      const client = new MPPClient({
        coreUrl: target.origin,
        signer,
        fetchImpl: this.transport(target.origin, ctx),
        sleep: (ms) => abortableSleep(ms, ctx.signal),
      });
      const result = await client.verifyChallenge({
        challenge: record.challenge,
        txHash,
        payerAddr: payer,
        maxAttempts: input.maxVerifyAttempts,
      });
      return await completePayment(this.recoveryStore, journal, record, result, { txHash: result.txHash });
    } catch (error) {
      return this.failure(error, record, ctx);
    }
  }

  private verifyAttempts(value?: number): void {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 16))
      invalid('MPP verification attempts must be between 1 and 16');
  }

  private validateExpectedFingerprint(value?: string): void {
    if (value !== undefined && (typeof value !== 'string' || !paymentFingerprintPattern.test(value)))
      invalid('Invalid expected payment fingerprint');
  }
}
