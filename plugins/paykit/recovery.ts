import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { MPPChallenge } from 'goatflow-sdk';
import type { ActionRecovery } from '../../core/schema/action';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import { evmAddressPattern } from '../../core/schema/validators';

export interface PaymentRecovery extends ActionRecovery {
  kind: 'paykit';
  fingerprint: string;
  rail: 'x402' | 'mpp' | 'fiat' | 'checkout' | 'order';
  origin: string;
  phase: 'prepared' | 'requesting' | 'submitting' | 'broadcast' | 'complete';
  merchantId?: string;
  payer?: string;
  sessionId?: string;
  /** Exact idempotent x402 creation request, persisted before sending it. */
  sessionCreateBody?: string;
  orderId?: string;
  txHash?: string;
  /** Deterministic hash of signed bytes, persisted before submission; not proof of broadcast. */
  signedTxHash?: string;
  /** Unvalidated wallet acknowledgement, retained as evidence of a possible broadcast. */
  rawSubmissionHash?: string;
  chainId?: number;
  route?: string;
  challenge?: MPPChallenge;
  result?: unknown;
  /** Safe diagnostic when a completed result or receipt could not be saved to the journal. */
  persistenceError?: string;
}

/** Records must survive ambiguous failures. A claim is never automatically released. */
export interface PaymentRecoveryStore {
  claim(record: PaymentRecovery): Promise<boolean>;
  /** A missing key may be represented by undefined or null. */
  get(operationId: string): Promise<PaymentRecovery | undefined | null>;
  /**
   * Publish a checkpoint atomically. Completion is terminal across all writers:
   * a later/stale put must not replace a completed record. Return the retained
   * completion when ignoring a stale write so the caller can update its handle.
   */
  put(record: PaymentRecovery): Promise<void | PaymentRecovery>;
}

declare const validatedRecovery: unique symbol;
/** A snapshot checked at a journal read boundary, for reuse within one operation. */
export type ValidatedPaymentRecovery = PaymentRecovery & { readonly [validatedRecovery]: true };

export const paymentFingerprintPattern = /^[a-f0-9]{64}$/;

export function paymentFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Separate immutable claim: exactly one caller may start a rail's creation request. */
export function paymentRequestKey(record: Pick<PaymentRecovery, 'rail' | 'operationId'>): string {
  // Exceed the public operation-key limit (200) so a caller's valid key cannot
  // occupy this internal namespace. File stores hash IDs into fixed-length paths.
  return `${record.rail}-request:${paymentFingerprint(record.operationId).repeat(4)}`;
}

export function x402RequestKey(operationId: string): string {
  return paymentRequestKey({ rail: 'x402', operationId });
}

function corruptRecord(reason: string): AgentkitRuntimeError {
  // A read has not established the caller's intent. Do not expose stored
  // receipts, credentials or recovery evidence from an unvalidated record.
  return new AgentkitRuntimeError(
    ErrorCodes.RECOVERY_REQUIRED,
    `Invalid payment recovery record: ${reason}; reconcile or restore the journal before retrying; do not send another payment`,
    new Error(reason),
  );
}

/** Read only the token needed by status recovery; never retain private parser errors. */
export function recoverySessionToken(body: unknown): string {
  let data: unknown;
  try {
    if (typeof body !== 'string') throw new Error();
    data = JSON.parse(body);
  } catch {
    throw corruptRecord('invalid x402 session creation body');
  }
  const token =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).token_contract
      : undefined;
  if (typeof token !== 'string' || !evmAddressPattern.test(token))
    throw corruptRecord('invalid x402 session creation body');
  return token;
}

/** Validate reads from built-in and caller-owned journals with the same rules. */
export function validateRecoveryRecord(
  value: unknown,
  id: string,
  completion = false,
): asserts value is ValidatedPaymentRecovery {
  const record = value as PaymentRecovery | null;
  if (
    !record ||
    typeof record !== 'object' ||
    record.kind !== 'paykit' ||
    record.operationId !== id ||
    typeof record.fingerprint !== 'string' ||
    !record.fingerprint ||
    !['prepared', 'requesting', 'submitting', 'broadcast', 'complete'].includes(record.phase) ||
    !['x402', 'mpp', 'fiat', 'checkout', 'order'].includes(record.rail) ||
    typeof record.origin !== 'string' ||
    (completion && record.phase !== 'complete')
  )
    throw corruptRecord('invalid structure');
  if (
    (record.chainId !== undefined || record.rail === 'x402' || record.rail === 'mpp') &&
    (typeof record.chainId !== 'number' || !Number.isSafeInteger(record.chainId) || record.chainId <= 0)
  )
    throw corruptRecord('missing or invalid chain ID');
  if (record.rail === 'mpp' && (typeof record.payer !== 'string' || !evmAddressPattern.test(record.payer)))
    throw corruptRecord('missing or invalid MPP payer');
  // Validate primary records and immutable request markers before either can
  // supply a body to a recovery POST or publish evidence to the caller.
  if (record.rail === 'x402' && record.sessionCreateBody !== undefined) recoverySessionToken(record.sessionCreateBody);
  // Compacted request markers deliberately omit the result. Their internal
  // namespace cannot collide with a public intent key (at most 200 characters).
  const marker = /^(x402|mpp|fiat|checkout|order)-request:([a-f0-9]{64})\2{3}$/.exec(id);
  if (record.phase === 'complete' && record.result == null && marker?.[1] !== record.rail)
    throw corruptRecord('completed payment has no result');
}

export async function readPaymentRecovery(
  store: PaymentRecoveryStore,
  id: string,
): Promise<ValidatedPaymentRecovery | undefined> {
  const record = await store.get(id);
  if (record == null) return undefined;
  // Keep this check at the caller-owned store boundary, including overridden
  // built-in get() methods. The compile-time brand is not runtime provenance.
  validateRecoveryRecord(record, id);
  // A caller-owned store may return its cache by reference. Journal updates
  // must not mutate that cache before put() durably accepts the new snapshot.
  return structuredClone(record);
}

export function canPreparePayment(record: PaymentRecovery): boolean {
  return (
    ['x402', 'fiat', 'mpp', 'order', 'checkout'].includes(record.rail) &&
    record.phase === 'prepared' &&
    !record.sessionCreateBody &&
    !record.sessionId &&
    !record.orderId &&
    !record.signedTxHash &&
    !record.txHash &&
    !record.rawSubmissionHash &&
    !record.challenge &&
    !record.result
  );
}

export function canPrepareX402(record: PaymentRecovery): boolean {
  return record.rail === 'x402' && canPreparePayment(record);
}

export function recoveryRequired(record: PaymentRecovery, message?: string): AgentkitRuntimeError {
  const error = new AgentkitRuntimeError(
    ErrorCodes.RECOVERY_REQUIRED,
    message ??
      (canPreparePayment(record)
        ? 'No creation request is recorded. Repair journal storage and retry the same payment with the same key and terms.'
        : 'Payment intent already started. Inspect the recovery handle and resume verification/status; do not send another payment.'),
  );
  error.recovery = structuredClone(record);
  return error;
}

/** Compact a completed snapshot. File stores still retain the older ordinary checkpoint. */
export function compactRecovery(record: PaymentRecovery): PaymentRecovery {
  const compact = structuredClone(record);
  if (compact.phase === 'complete') {
    delete compact.sessionCreateBody;
    delete compact.challenge;
    if (compact.rawSubmissionHash === compact.txHash) delete compact.rawSubmissionHash;
    // MPP receiptBody is a decoded copy of receiptHeader, not additional evidence.
    if (compact.rail === 'mpp' && compact.result && typeof compact.result === 'object') {
      const result = compact.result as Record<string, unknown>;
      if (typeof result.receiptHeader === 'string') delete result.receiptBody;
    }
  }
  return compact;
}

export function replayResult<T>(record: PaymentRecovery): T {
  if (record.phase !== 'complete' || record.result == null) throw corruptRecord('completed payment has no result');
  const result = structuredClone(record.result) as Record<string, unknown>;
  if (record.rail === 'mpp' && typeof result?.receiptHeader === 'string' && !result.receiptBody) {
    // Match the SDK's strict UTF-8 decoding, including its handling of a BOM.
    const bytes = Buffer.from(result.receiptHeader.split('.')[0]!, 'base64url');
    try {
      result.receiptBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (cause) {
      const error = new AgentkitRuntimeError(
        ErrorCodes.RECOVERY_REQUIRED,
        'Invalid stored MPP receipt; reconcile before retrying',
        cause,
      );
      error.recovery = structuredClone(record);
      throw error;
    }
  }
  return result as T;
}

/** Bounded single-process default. Never evict deduplication keys to make room. */
export class InMemoryPaymentRecoveryStore implements PaymentRecoveryStore {
  private readonly records = new Map<string, PaymentRecovery>();
  constructor(private readonly maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new RangeError('maxRecords must be positive');
  }
  private capacity(id: string): void {
    if (!this.records.has(id) && this.records.size >= this.maxRecords)
      throw new AgentkitRuntimeError(
        ErrorCodes.POLICY_BLOCKED,
        'In-memory payment recovery store is full; use a persistent store. Existing payment keys must be retained.',
      );
  }
  async claim(record: PaymentRecovery): Promise<boolean> {
    if (this.records.has(record.operationId)) return false;
    this.capacity(record.operationId);
    this.records.set(record.operationId, compactRecovery(record));
    return true;
  }
  async get(id: string): Promise<PaymentRecovery | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    validateRecoveryRecord(record, id);
    return structuredClone(record);
  }
  async put(record: PaymentRecovery): Promise<void | PaymentRecovery> {
    const completed = this.records.get(record.operationId);
    if (completed?.phase === 'complete') return retainCompletion(completed, record);
    this.capacity(record.operationId);
    this.records.set(record.operationId, compactRecovery(record));
  }
}

/** Check terminal snapshots consistently at store and journal adoption boundaries. */
export function retainCompletion(completed: PaymentRecovery, incoming: PaymentRecovery): PaymentRecovery {
  validateRecoveryRecord(completed, incoming.operationId, true);
  if (completed.fingerprint !== incoming.fingerprint)
    throw new AgentkitRuntimeError(
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      'Journal completion belongs to another payment intent; reconcile the journal before retrying',
    );
  return structuredClone(completed);
}

/**
 * Private, atomic local journal. Exclusive creation prevents two CLI processes
 * submitting the same intent. Corrupt/incomplete records fail closed. Keep this
 * directory between runs; use a shared implementation for distributed workers.
 */
export class FilePaymentRecoveryStore implements PaymentRecoveryStore {
  private readonly directory: string;
  private directoryReady?: Promise<void>;
  private readonly directorySync: boolean;
  constructor(directory: string, options: { durability?: 'directory' | 'file' } = {}) {
    if (!directory.trim())
      throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Payment journal directory must not be empty');
    this.directory = resolve(directory.trim());
    // Node cannot portably open/fsync directory handles on Windows. File mode
    // retains atomic publication and file flushing, without a power-loss guarantee
    // for directory entries. Operators can explicitly require directory durability.
    this.directorySync = (options.durability ?? (process.platform === 'win32' ? 'file' : 'directory')) === 'directory';
  }
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AgentkitRuntimeError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      const messages: Record<string, string> = {
        EACCES: 'Permission denied; check payment journal access',
        EPERM: 'Operation not permitted; check payment journal permissions and filesystem support',
        ENOSPC: 'Insufficient storage for the payment journal',
        ENOENT: 'Payment journal directory is unavailable',
        ENOTDIR: 'Payment journal path is not a directory',
      };
      throw new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        messages[code ?? ''] ?? 'Payment journal I/O failed',
        error,
      );
    }
  }
  private async syncDirectory(directory: string): Promise<void> {
    if (!this.directorySync) return;
    const file = await open(directory, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private path(id: string, completion = false): string {
    return join(this.directory, `${paymentFingerprint(id)}${completion ? '.complete' : ''}.json`);
  }
  private prepareDirectory(): Promise<void> {
    return (this.directoryReady ??= (async () => {
      const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Existing ancestors belong to the operator. Only newly created entries
      // need parent syncing; a traverse-only ancestor must not disable an existing journal.
      if (created) {
        let directory = this.directory;
        for (;;) {
          await this.syncDirectory(dirname(directory));
          if (directory === resolve(created)) break;
          directory = dirname(directory);
        }
      }
    })().catch((error) => {
      this.directoryReady = undefined;
      throw error;
    }));
  }
  private async publishOnce(record: PaymentRecovery, target: string): Promise<boolean> {
    await this.prepareDirectory();
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(compactRecovery(record)));
      await file.sync();
      await file.close();
      // Publish a complete claim atomically, without replacing another claimant.
      // A write failure only leaves a temporary file, never a poisoned operation key.
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      await this.syncDirectory(this.directory);
      return true;
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async claim(record: PaymentRecovery): Promise<boolean> {
    return this.io(async () => {
      if (await this.readRecord(record.operationId, true)) return false;
      const claimed = await this.publishOnce(record, this.path(record.operationId));
      if (claimed && record.phase === 'complete') await this.publishOnce(record, this.path(record.operationId, true));
      return claimed;
    });
  }
  private async readRecord(id: string, completion = false): Promise<PaymentRecovery | undefined> {
    let text: string;
    try {
      text = await readFile(this.path(id, completion), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const record: unknown = JSON.parse(text);
      validateRecoveryRecord(record, id, completion);
      return record;
    } catch (error) {
      if (error instanceof AgentkitRuntimeError) throw error;
      throw corruptRecord('invalid JSON');
    }
  }
  async get(id: string): Promise<PaymentRecovery | undefined> {
    return this.io(async () => (await this.readRecord(id, true)) ?? this.readRecord(id));
  }
  async put(record: PaymentRecovery): Promise<void | PaymentRecovery> {
    return this.io(async () => {
      const completed = await this.readRecord(record.operationId, true);
      if (completed) {
        // A previous publication may have failed at directory fsync. A retry
        // must finish that durability boundary before reporting success.
        await this.syncDirectory(this.directory);
        return retainCompletion(completed, record);
      }
      const previous = await this.readRecord(record.operationId);
      // Promote journals from the older single-file format before any update.
      const finalRecord = previous?.phase === 'complete' ? previous : record;
      if (finalRecord.phase === 'complete') {
        // Keep the ordinary claim occupied, including for emergency journals
        // created directly from a completed result. Publish completion separately
        // and immutably: a concurrent rename of an older checkpoint cannot erase it.
        if (!previous) await this.publishOnce(finalRecord, this.path(record.operationId));
        if (!(await this.publishOnce(finalRecord, this.path(record.operationId, true))))
          await this.syncDirectory(this.directory);
        return retainCompletion((await this.readRecord(record.operationId, true))!, record);
      }
      await this.prepareDirectory();
      const target = this.path(record.operationId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(compactRecovery(record)));
        await file.sync();
        await file.close();
        await rename(temporary, target);
        await this.syncDirectory(this.directory);
        // A completion may have won while this checkpoint was being written.
        const final = await this.readRecord(record.operationId, true);
        if (final) {
          await this.syncDirectory(this.directory);
          return retainCompletion(final, record);
        }
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
  }
}
