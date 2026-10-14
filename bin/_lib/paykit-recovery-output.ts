import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { paykitSensitiveOutputFields } from '../../plugins/paykit/actions';
import { redactFields } from '../../core/runtime/redaction';
import type { ActionRecovery } from '../../core/schema/action';
import { FilePaymentRecoveryStore, type PaymentRecovery } from '../../plugins/paykit/recovery';
import { containsDirectory, validateEmergencyDirectory, validateTemporaryDirectory } from './paykit-directories';
import { AgentkitRuntimeError } from '../../core/errors/error';

/** Preserve a completed result before redacting output when its normal journal failed. */
export async function paykitRecoveryOutput(
  record: ActionRecovery,
  revealSecrets = false,
  emergencyDirectory?: string,
  primaryDirectory?: string,
): Promise<ActionRecovery> {
  const visible: ActionRecovery = {
    kind: record.kind,
    operationId: record.operationId,
    phase: record.phase,
    ...(record.fingerprint ? { fingerprint: record.fingerprint } : {}),
    ...(record.txHash ? { txHash: record.txHash } : {}),
    ...(record.signedTxHash ? { signedTxHash: record.signedTxHash } : {}),
    ...(record.persistenceError ? { persistenceError: record.persistenceError } : {}),
    ...(revealSecrets && record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(revealSecrets && record.orderId ? { orderId: record.orderId } : {}),
  };
  const result = record.result;
  if (
    record.kind !== 'paykit' ||
    !['x402', 'fiat', 'mpp'].includes(String(record.rail)) ||
    record.phase !== 'complete' ||
    !record.persistenceError ||
    !result ||
    typeof result !== 'object'
  )
    return visible;

  const mpp = record.rail === 'mpp';
  let revealResult = revealSecrets;
  const warnings: string[] = [];
  const attempted = new Set<string>();
  const failedDirectories: string[] = [];
  let savedRoot: string | undefined;
  const saveIn = async (root: string) => {
    if (attempted.has(root)) return;
    attempted.add(root);
    const directory = join(root, `agentkit-paykit-recovery-${randomUUID()}`);
    try {
      // The store creates the 0700 child and syncs its new ancestor entries.
      await new FilePaymentRecoveryStore(directory).put(record as PaymentRecovery);
      visible.emergencyStateDir = directory;
      savedRoot = root;
    } catch {
      // Failed publication/fsync may leave a private copy; report the attempt.
      failedDirectories.push(directory);
    }
  };
  if (emergencyDirectory !== undefined) {
    try {
      const configured = await validateEmergencyDirectory(emergencyDirectory, primaryDirectory);
      warnings.push(...configured.warnings);
      await saveIn(configured.directory);
    } catch (cause) {
      warnings.push(
        cause instanceof AgentkitRuntimeError ? cause.message : 'Configured emergency directory is unavailable',
      );
    }
  }
  let temporaryRoot: string | undefined;
  if (!visible.emergencyStateDir) {
    try {
      temporaryRoot = await validateTemporaryDirectory(tmpdir());
      await saveIn(temporaryRoot);
    } catch (cause) {
      warnings.push(
        cause instanceof AgentkitRuntimeError ? cause.message : 'System temporary directory is unavailable',
      );
    }
  } else {
    // Resolve aliases only to label a successful configured TMPDIR accurately.
    // An unused fallback's access/ownership failures are not storage warnings.
    temporaryRoot = await realpath(tmpdir()).catch(() => undefined);
  }
  if (warnings.length) visible.emergencyStorageWarnings = warnings;
  if (failedDirectories.length) visible.failedEmergencyStateDirs = failedDirectories;
  if (visible.emergencyStateDir) {
    const retrieveHint = mpp
      ? 'Receipt saved privately. Use resume-mpp with this --state-dir, --expected-fingerprint from this recovery handle, and --reveal-secrets to retrieve it without paying again.'
      : 'Completed result saved privately. Replay the original command with this emergency --state-dir, the same key and terms, and --reveal-secrets to retrieve it without another creation or payment request.';
    visible.recoveryHint =
      (temporaryRoot && savedRoot && containsDirectory(temporaryRoot, savedRoot)
        ? 'This emergency journal is in temporary storage and may be lost on reboot or cleanup. Move the entire directory to durable private storage and use the new path as --state-dir. '
        : 'Keep this emergency journal in durable private storage and use its path as --state-dir. ') + retrieveHint;
  } else {
    // When neither location can persist the only copy, returning it to the
    // operator takes precedence over terminal redaction. Never send it to logs.
    revealResult = true;
    if (mpp) visible.receiptRevealedForRecovery = true;
    else visible.resultRevealedForRecovery = true;
    visible.recoveryHint =
      'Emergency result storage also failed. The completed result is included in this output; save it privately before exiting. ' +
      (failedDirectories.length
        ? 'Attempted paths are listed in failedEmergencyStateDirs and may contain partial private records; their durability is unconfirmed.'
        : 'No emergency parent was usable; see emergencyStorageWarnings.');
  }
  const output = structuredClone(result);
  visible.result = revealResult ? output : redactFields(output, paykitSensitiveOutputFields);
  return visible;
}
