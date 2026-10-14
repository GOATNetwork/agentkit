import {
  isError,
  keccak256,
  type NonceManager,
  type Signer,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import { AgentkitRuntimeError } from '../errors/error';
import { ErrorCodes } from '../errors/error-codes';
import { raceSignal, throwIfAborted } from '../runtime/abort';
import type { WalletCallOptions } from './wallet-provider';

function managesNonces(signer: Signer): signer is Signer & Pick<NonceManager, 'increment' | 'reset' | 'signer'> {
  // Signers can come from ethers' CommonJS export or another installed copy.
  // Those managers have distinct constructors, so instanceof misses them.
  const manager = signer as Partial<NonceManager>;
  return (
    typeof manager.increment === 'function' &&
    typeof manager.reset === 'function' &&
    typeof manager.signer?.getNonce === 'function'
  );
}

/** Raw signing must not silently fall back to a wallet-managed submission. */
export async function signTransaction<T>(sign: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await raceSignal(sign(), signal);
  } catch (cause) {
    if (cause instanceof AgentkitRuntimeError) throw cause;
    const visited = new Set<unknown>();
    let unsupported = false;
    for (let error: unknown = cause; error && typeof error === 'object' && !visited.has(error); ) {
      visited.add(error);
      const item = error as { code?: unknown; cause?: unknown; error?: unknown };
      unsupported ||=
        item.code === 'UNSUPPORTED_OPERATION' || item.code === -32601 || item.code === -32004 || item.code === 4200;
      error = item.cause ?? item.error;
    }
    const error = new AgentkitRuntimeError(
      ErrorCodes.WALLET_SIGN_FAILED,
      unsupported
        ? 'Wallet does not support raw transaction signing; use a local signer or an account supporting signTransaction before submitting this operation'
        : 'Transaction signing failed; no transaction was submitted',
      cause,
    );
    error.recoveryGuidance = true;
    throw error;
  }
}

/** Check cancellation between preparation, signing and the irreversible RPC. */
export async function broadcastTransaction(
  signer: Signer,
  request: TransactionRequest,
  signal?: AbortSignal,
  onSignedTransaction?: WalletCallOptions['onSignedTransaction'],
): Promise<TransactionResponse> {
  throwIfAborted(signal);
  const provider = signer.provider;
  if (!provider) throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Broadcast requires a connected signer');
  if (managesNonces(signer)) {
    // NonceManager reserves synchronously before its first await. Preserve that
    // contract even when other callers use the same manager's sendTransaction.
    // As with ethers, a failed reservation stays consumed until reconciliation/reset.
    const nonce = signer.getNonce('pending');
    signer.increment();
    request = { ...request, nonce: await raceSignal(nonce, signal) };
    throwIfAborted(signal);
  }
  const populated = await raceSignal(signer.populateTransaction(request), signal);
  throwIfAborted(signal);
  delete populated.from;
  const serialized = await signTransaction(() => signer.signTransaction(populated), signal);
  throwIfAborted(signal);
  const signedTxHash = keccak256(serialized);
  await onSignedTransaction?.(signedTxHash);
  throwIfAborted(signal);
  // Once submitted, await the response even after cancellation to retain its hash.
  try {
    return await provider.broadcastTransaction(serialized);
  } catch (cause) {
    const error = new AgentkitRuntimeError(
      ErrorCodes.ADAPTER_REQUEST_FAILED,
      'Transaction submission incomplete; inspect the signed transaction hash before retrying',
      cause,
    );
    error.recovery = { kind: 'transaction', operationId: signedTxHash, phase: 'submitting', signedTxHash };
    error.recoveryGuidance = true;
    throw error;
  }
}

/** Cancellation during mining must retain evidence of the already accepted transfer. */
export async function confirmTransaction<T>(
  txHash: string,
  wait: () => Promise<T>,
  options?: WalletCallOptions,
): Promise<T> {
  try {
    await options?.onBroadcast?.(txHash);
    throwIfAborted(options?.signal);
    return await raceSignal(wait(), options?.signal);
  } catch (cause) {
    const error =
      cause instanceof AgentkitRuntimeError
        ? cause
        : new AgentkitRuntimeError(
            ErrorCodes.WALLET_TRANSFER_FAILED,
            'Transaction confirmation incomplete; inspect the broadcast hash before retrying',
            cause,
          );
    if (!(cause instanceof AgentkitRuntimeError)) error.recoveryGuidance = true;
    error.recovery = { kind: 'transaction', operationId: txHash, phase: 'broadcast', txHash };
    throw error;
  }
}

/**
 * ethers v6 rejects wait() for every replacement, including a successful fee
 * bump of the same call. Follow a repriced replacement to its mined receipt and
 * attribute cancelled or different-call replacements to the replacement hash.
 */
export async function confirmEthersTransaction(
  tx: TransactionResponse,
  options?: WalletCallOptions,
): Promise<TransactionReceipt | null> {
  let replacement: { hash: string; reason: string } | undefined;
  const receipt = await confirmTransaction(
    tx.hash,
    async () => {
      try {
        return await tx.wait();
      } catch (cause) {
        if (!isError(cause, 'TRANSACTION_REPLACED') || !cause.receipt) throw cause;
        replacement = { hash: cause.receipt.hash, reason: cause.reason };
        return cause.receipt;
      }
    },
    options,
  );
  if (!replacement || !receipt) return receipt;
  const { reason } = replacement;
  // Checkpoint the mined replacement before reporting its outcome.
  return confirmTransaction(
    replacement.hash,
    async () => {
      if (reason !== 'repriced') {
        const error = new AgentkitRuntimeError(
          ErrorCodes.WALLET_TRANSFER_FAILED,
          'Transaction was cancelled or replaced with a different call; reconcile before retrying',
        );
        error.recoveryGuidance = true;
        throw error;
      }
      if (receipt.status !== 1)
        throw new AgentkitRuntimeError(
          ErrorCodes.WALLET_TRANSFER_FAILED,
          'Transaction reverted or returned an invalid receipt status',
        );
      return receipt;
    },
    options,
  );
}
