import type { ActionContext } from '../../core/schema/action';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import { throwIfAborted } from '../../core/runtime/abort';
import { notifyRecovery } from '../../core/runtime/recovery-observer';
import {
  canPreparePayment,
  paymentRequestKey,
  recoveryRequired,
  replayResult,
  readPaymentRecovery,
  retainCompletion,
  type PaymentRecovery,
  type PaymentRecoveryStore,
  type ValidatedPaymentRecovery,
} from './recovery';

type JournalContext = Pick<ActionContext, 'signal' | 'checkpointRecovery'>;

/** Attach only the caller's local evidence and preserve classified failures. */
export function throwPaymentFailure(
  error: unknown,
  record: PaymentRecovery,
  ctx: JournalContext,
  message: string,
): never {
  notifyRecovery(ctx, record);
  const classified = error instanceof AgentkitRuntimeError;
  const preserveGuidance =
    classified &&
    (record.phase === 'complete' ||
      error.code === ErrorCodes.RECOVERY_REQUIRED ||
      error.code === ErrorCodes.IDEMPOTENCY_CONFLICT ||
      error.recoveryGuidance);
  const failure = classified
    ? new AgentkitRuntimeError(
        error.code,
        preserveGuidance || error.message.endsWith(message) ? error.message : `${error.message}; ${message}`,
        error,
      )
    : new AgentkitRuntimeError(
        ctx.signal?.aborted ? ErrorCodes.ABORTED : ErrorCodes.ADAPTER_REQUEST_FAILED,
        record.phase === 'complete'
          ? 'Payment operation completed, but its journal checkpoint failed. Save the completed result from recovery data and reconcile the journal; do not send another payment or create a new intent key.'
          : message,
        error,
      );
  failure.recoveryGuidance = true;
  failure.recovery = structuredClone(record);
  throw failure;
}

export function recoveryIntentMismatch(operationId: string): AgentkitRuntimeError {
  return new AgentkitRuntimeError(
    ErrorCodes.RECOVERY_REQUIRED,
    `Payment recovery for operation ${JSON.stringify(operationId)} is unverified. Reconcile the journal with merchant status and transaction history before retrying. Use a saved recovery handle or emergency journal if available; do not send another payment.`,
  );
}

/** Use JSON's undefined-field convention without coercing other result values. */
function journalSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const seen = new WeakSet<object>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const [key, field] of Object.entries(item)) {
      if (field === undefined) {
        if (Array.isArray(item)) item[Number(key)] = null;
        else delete (item as Record<string, unknown>)[key];
      } else visit(field);
    }
  };
  visit(snapshot);
  return snapshot;
}

interface ReplayOptions {
  allowPrepared?: boolean;
  replayRequest?: boolean;
  /** Caller-visible reference when the storage key is internally scoped. */
  operationReference?: string;
}

/** Check identity before caller-specific validation or publishing recovery data. */
export function assertPaymentFingerprint(record: PaymentRecovery, previous: PaymentRecovery): void {
  if (previous.fingerprint !== record.fingerprint)
    throw new AgentkitRuntimeError(
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      'Idempotency key already belongs to another payment intent',
    );
}

/** Match caller-saved terms and request evidence before revealing recovery. */
export async function assertRecoveryIntent(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  expectedFingerprint?: string,
): Promise<PaymentRecovery> {
  if (expectedFingerprint !== undefined && record.fingerprint !== expectedFingerprint)
    throw recoveryIntentMismatch(record.operationId);
  const request = await readPaymentRecovery(store, paymentRequestKey(record));
  if (request && (request.rail !== record.rail || request.fingerprint !== record.fingerprint))
    throw recoveryIntentMismatch(record.operationId);
  // Every in-flight x402 primary is preceded by a request claim. A completed
  // emergency journal may legitimately contain only the primary result.
  if (!request && record.rail === 'x402' && !canPreparePayment(record) && record.phase !== 'complete')
    throw recoveryIntentMismatch(record.operationId);
  return resolveRequest(store, record, request);
}

/** Resolve the immutable request marker before deciding whether an intent can restart. */
export async function resolvePaymentRequest(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  operationReference = record.operationId,
): Promise<PaymentRecovery> {
  if (!canPreparePayment(record)) return record;
  return resolveRequest(store, record, await readPaymentRecovery(store, paymentRequestKey(record)), operationReference);
}

async function resolveRequest(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  request: PaymentRecovery | undefined,
  operationReference = record.operationId,
): Promise<PaymentRecovery> {
  if (!canPreparePayment(record) || !request) return record;
  if (request.fingerprint !== record.fingerprint || request.rail !== record.rail)
    throw recoveryIntentMismatch(operationReference);
  if (request.phase === 'complete') {
    const latest = await readPaymentRecovery(store, record.operationId);
    if (latest?.phase === 'complete' && latest.fingerprint === record.fingerprint && latest.rail === record.rail)
      return latest;
  }
  if (request.phase !== 'requesting' || (record.rail === 'x402' && !request.sessionCreateBody))
    throw recoveryIntentMismatch(operationReference);
  return { ...request, operationId: record.operationId };
}

export async function existingPayment(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  ctx: JournalContext,
  {
    allowPrepared = false,
    replayRequest = false,
    operationReference,
    observed,
  }: ReplayOptions & { observed?: ValidatedPaymentRecovery } = {},
): Promise<PaymentRecovery | undefined> {
  let previous: PaymentRecovery | undefined = observed ?? (await readPaymentRecovery(store, record.operationId));
  if (!previous) return undefined;
  assertPaymentFingerprint(record, previous);
  previous = await resolvePaymentRequest(store, previous, operationReference);
  if (allowPrepared && canPreparePayment(previous)) return previous;
  notifyRecovery(ctx, previous);
  if (previous.phase === 'complete' || (replayRequest && record.rail === 'order')) return previous;
  throw recoveryRequired(previous);
}

export async function beginPayment(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  ctx: JournalContext,
  options: ReplayOptions = {},
): Promise<PaymentRecovery | undefined> {
  throwIfAborted(ctx.signal);
  if (await store.claim(journalSnapshot(record))) {
    notifyRecovery(ctx, record);
    return undefined;
  }
  const previous = await existingPayment(store, record, ctx, options);
  if (!previous) throw recoveryRequired(record);
  return previous;
}

export async function claimPaymentRequest(
  store: PaymentRecoveryStore,
  record: PaymentRecovery,
  ctx: JournalContext,
  patch: Partial<PaymentRecovery> = {},
  { replayRequest = false, operationReference }: Pick<ReplayOptions, 'replayRequest' | 'operationReference'> = {},
): Promise<void> {
  throwIfAborted(ctx.signal);
  const request: PaymentRecovery = journalSnapshot({ ...record, ...patch, phase: 'requesting' });
  if (!(await store.claim({ ...request, operationId: paymentRequestKey(record) }))) {
    Object.assign(record, await resolvePaymentRequest(store, record, operationReference));
    // Only native topup orders have an explicit server-side request replay contract.
    if (!(replayRequest && record.rail === 'order' && record.phase === 'requesting')) throw recoveryRequired(record);
  } else Object.assign(record, request);
  notifyRecovery(ctx, record);
}

/** One serialized checkpoint queue and retry policy for every creation rail. */
export function paymentJournal(store: PaymentRecoveryStore, record: PaymentRecovery, ctx: JournalContext) {
  let writes = Promise.resolve();
  let revision = 0;
  const save = (patch: Partial<PaymentRecovery>): Promise<void> => {
    // Completion is terminal in memory too, including a retained completion
    // adopted while an earlier callback was still running.
    const defined = journalSnapshot(patch);
    const changed = Object.entries(defined).some(([key, value]) => record[key] !== value);
    if (record.phase !== 'complete' && changed) {
      Object.assign(record, defined);
      notifyRecovery(ctx, record);
    }
    const version = ++revision;
    // Persistence warnings describe unsaved state. Never persist a warning on
    // the successful checkpoint that repairs it; keep it in memory until success.
    const snapshot = journalSnapshot(record);
    delete snapshot.persistenceError;
    writes = writes
      .catch(() => {})
      .then(async () => {
        const retained = await store.put(snapshot);
        let updated = false;
        if (retained?.phase === 'complete') {
          Object.assign(record, journalSnapshot(retainCompletion(retained, snapshot)));
          updated = true;
        }
        if (version === revision && record.persistenceError) {
          delete record.persistenceError;
          updated = true;
        }
        if (updated) notifyRecovery(ctx, record);
      });
    // Replacement callbacks cannot await; their own promises still reject on failure.
    void writes.catch(() => {});
    return writes;
  };
  const flush = async () => {
    for (;;) {
      const pending = writes;
      try {
        await pending;
      } catch {
        if (pending === writes) await save({});
      }
      if (pending === writes) return;
    }
  };
  /** Retry the latest write once, then publish a memory-only storage diagnostic. */
  const checkpoint = async (patch: Partial<PaymentRecovery> | undefined, failureMessage: string) => {
    if (patch !== undefined) await save(patch).catch(() => {});
    try {
      await flush();
    } catch (cause) {
      record.persistenceError = failureMessage;
      notifyRecovery(ctx, record);
      throw cause;
    }
  };
  return {
    save,
    flush,
    checkpoint,
    /** Once funds have moved, preserve diagnostics but allow receipt retrieval. */
    checkpointAfterBroadcast: async (patch?: Partial<PaymentRecovery>) => {
      await checkpoint(
        patch,
        record.rail === 'mpp'
          ? 'Post-broadcast checkpoint failed; receipt verification continued'
          : 'Post-broadcast checkpoint failed; preserve recovery data and reconcile the journal; do not send another payment',
      ).catch(() => {});
    },
  };
}

export async function completePayment<T>(
  store: PaymentRecoveryStore,
  journal: ReturnType<typeof paymentJournal>,
  record: PaymentRecovery,
  result: T,
  patch: Partial<PaymentRecovery> = {},
): Promise<T> {
  try {
    await journal.checkpoint(
      { ...patch, phase: 'complete', result },
      record.rail === 'mpp'
        ? 'Post-broadcast checkpoint failed; the verified MPP receipt must be saved from recovery data'
        : 'Completion checkpoint failed; the completed result must be saved from recovery data',
    );
  } catch (cause) {
    if (
      cause instanceof AgentkitRuntimeError &&
      (cause.code === ErrorCodes.IDEMPOTENCY_CONFLICT || cause.code === ErrorCodes.RECOVERY_REQUIRED)
    )
      throw new AgentkitRuntimeError(
        ErrorCodes.RECOVERY_REQUIRED,
        'Payment operation completed, but its journal checkpoint is invalid or belongs to another intent. Save the completed result from recovery data and reconcile the journal; do not send another payment or create a new intent key.',
        cause,
      );
    throw cause;
  }
  // Publish a compact completed marker for logical replay. File stores retain
  // the older ordinary marker (including its request body); this is not erasure.
  // Failure cannot undo primary completion or permit another creation request.
  const marker = journalSnapshot({ ...record, operationId: paymentRequestKey(record) });
  delete marker.result;
  delete marker.persistenceError;
  await store.put(marker).catch(() => {});
  return replayResult<T>(record);
}
