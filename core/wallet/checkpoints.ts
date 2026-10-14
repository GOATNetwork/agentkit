import type { ActionContext } from '../schema/action';
import type { WalletCallOptions } from './wallet-provider';
import { notifyRecovery } from '../runtime/recovery-observer';

export function transferCheckpoints(ctx: ActionContext): WalletCallOptions {
  let signedTxHash: string | undefined;
  return {
    signal: ctx.signal,
    onSignedTransaction: (hash) => {
      signedTxHash = hash;
      notifyRecovery(ctx, {
        kind: 'transaction',
        operationId: ctx.idempotencyKey ?? ctx.traceId,
        phase: 'submitting',
        signedTxHash,
      });
    },
    onBroadcast: (txHash) =>
      notifyRecovery(ctx, {
        kind: 'transaction',
        operationId: ctx.idempotencyKey ?? ctx.traceId,
        phase: 'broadcast',
        signedTxHash,
        txHash,
      }),
  };
}
