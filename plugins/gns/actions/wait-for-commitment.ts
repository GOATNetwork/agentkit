import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { EvmWalletProvider } from '../../../core/wallet/evm-wallet-provider';
import {
  MAX_COMMITMENT_AGE_SEC,
  MIN_COMMITMENT_AGE_SEC,
  READINESS_SUBMIT_BUFFER_SEC,
} from '../constants';
import { REGISTRAR_CONTROLLER_ABI, type GnsContractRegistry } from '../adapters/contracts';

const inputSchema = z.object({
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'commitment must be a 32-byte hex hash'),
});

export type WaitForCommitmentInput = z.infer<typeof inputSchema>;

export interface WaitForCommitmentOutput {
  /** Unix seconds the commit landed on-chain (0 ⇒ unknown / not yet mined). */
  submittedAt: number;
  /** submittedAt + minCommitmentAge. */
  revealAt: number;
  /** submittedAt + maxCommitmentAge. */
  expiresAt: number;
  /** Latest mined block.timestamp at the time of the read. */
  blockTimestamp: number;
  /** True iff block.timestamp ≥ revealAt + submit buffer (caller may invoke `register`). */
  isReady: boolean;
  /** True iff block.timestamp > expiresAt (caller must re-commit). */
  isExpired: boolean;
}

const outputSchema: z.ZodType<WaitForCommitmentOutput> = z.object({
  submittedAt: z.number(),
  revealAt: z.number(),
  expiresAt: z.number(),
  blockTimestamp: z.number(),
  isReady: z.boolean(),
  isExpired: z.boolean(),
});

/**
 * `goat.gns.waitForCommitment` — block.timestamp-based readiness probe.
 *
 * Source of truth: `frontend/src/hooks/contracts/useReadRegistrationCommitment.ts`.
 * We READ the latest block from the chain (NOT wall-clock `Date.now()`) so
 * the readiness decision matches what the on-chain `register()` will see.
 *
 * Why block.timestamp matters: a node's wall clock can drift several seconds
 * from miners. If the caller relied on `Date.now() - readyAt`, a tx submitted
 * the instant the wall-clock crossed `readyAt` could land in a block whose
 * `block.timestamp` is still 1-2 seconds shy of `readyAt`, and the controller
 * reverts with `CommitmentTooNew`.
 *
 * IMPLEMENTATION NOTE: to read the latest block we need the underlying RPC
 * provider, which is only exposed by `EvmWalletProvider` (not the bare
 * `WalletProvider` interface). If the wallet is something else (e.g.
 * `NoopWalletProvider`), this action throws `INVALID_INPUT` so the caller
 * knows to swap to an EVM-backed wallet. The wallet-shape narrowing happens
 * at call time so unit tests can inject their own block-timestamp source.
 */
export function waitForCommitmentAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<WaitForCommitmentInput, WaitForCommitmentOutput> {
  return {
    name: 'goat.gns.waitForCommitment',
    description: 'Read the on-chain commitment readiness state for a .goat registration commit',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      // Narrow to EvmWalletProvider (or a structural superset that exposes
      // getLatestBlockTimestamp); throw INVALID_INPUT otherwise so the caller
      // gets a clear error instead of a TypeError.
      const candidate = wallet as Partial<EvmWalletProvider>;
      if (typeof candidate.getLatestBlockTimestamp !== 'function') {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'waitForCommitment requires EvmWalletProvider (or a wallet exposing getLatestBlockTimestamp); the supplied wallet has no on-chain block reader',
        );
      }
      const getBlockTs = candidate.getLatestBlockTimestamp.bind(candidate);

      const [submittedAtRaw, blockTimestamp] = await Promise.all([
        wallet.callContract(
          contracts.controller,
          REGISTRAR_CONTROLLER_ABI as unknown as string[],
          'commitments',
          [input.commitment],
        ),
        getBlockTs(),
      ]);

      if (ctx.signal?.aborted) {
        throw new AgentkitRuntimeError(ErrorCodes.ABORTED, 'waitForCommitment aborted');
      }

      const submittedAt = Number(submittedAtRaw ?? 0);
      // If the contract returns 0 the commit isn't recorded yet (mempool /
      // wrong commit). Surface a never-ready / never-expired state.
      if (!submittedAt) {
        return {
          submittedAt: 0,
          revealAt: 0,
          expiresAt: 0,
          blockTimestamp,
          isReady: false,
          isExpired: false,
        };
      }

      const revealAt = submittedAt + MIN_COMMITMENT_AGE_SEC;
      const expiresAt = submittedAt + MAX_COMMITMENT_AGE_SEC;
      const isReady = blockTimestamp >= revealAt + READINESS_SUBMIT_BUFFER_SEC;
      const isExpired = blockTimestamp > expiresAt;

      return {
        submittedAt,
        revealAt,
        expiresAt,
        blockTimestamp,
        isReady,
        isExpired,
      };
    },
  };
}
