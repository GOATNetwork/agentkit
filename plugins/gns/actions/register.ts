import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { EvmWalletProvider } from '../../../core/wallet/evm-wallet-provider';
import {
  MAX_COMMITMENT_AGE_SEC,
  MIN_COMMITMENT_AGE_SEC,
  READINESS_SUBMIT_BUFFER_SEC,
  YEAR_IN_SECONDS,
  ZERO_REFERRER,
  assertValidName,
  normalizeGoatName,
} from '../constants';
import {
  ERC20_ABI,
  REGISTRAR_CONTROLLER_ABI,
  type GnsContractRegistry,
} from '../adapters/contracts';
import { buildPaymentTuple, buildRegistrationTuple } from './commit';

const reverseRecordSchema = z.union([z.literal(0), z.literal(1)]);

const permitSchema = z
  .object({
    value: z.string().regex(/^\d+$/),
    deadline: z.string().regex(/^\d+$/),
    v: z.number().int().min(0).max(255),
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();

const inputSchema = z.object({
  /** Full .goat name. The label is required to re-derive the on-chain commit hash. */
  name: z.string().min(1),
  commitHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  paymentTokenAddress: evmAddress,
  paymentTokenSymbol: z.string().min(2).max(16),
  amountWei: z.string().regex(/^\d+$/),
  /** Duration in seconds (base-10 integer string). Must equal `years * YEAR_IN_SECONDS`. */
  duration: z.string().regex(/^\d+$/),
  years: z.number().int().min(1).max(10),
  /** 32-byte secret returned from `commit`. Sensitive. */
  secret: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  owner: evmAddress,
  resolver: evmAddress.optional() as z.ZodOptional<z.ZodType<`0x${string}`>>,
  resolverData: z.array(z.string().regex(/^0x[0-9a-fA-F]*$/)).default([]),
  reverseRecord: reverseRecordSchema.default(0),
  referrer: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(ZERO_REFERRER),
  permit: permitSchema.optional(),
});

export type RegisterInput = z.infer<typeof inputSchema>;

export interface RegisterOutput {
  txHash: string;
  owner: `0x${string}`;
  paymentToken: `0x${string}`;
  amountWei: string;
  duration: string;
  used: 'register' | 'registerWithPermit';
}

const outputSchema: z.ZodType<RegisterOutput> = z.object({
  txHash: z.string(),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  paymentToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  amountWei: z.string(),
  duration: z.string(),
  used: z.union([z.literal('register'), z.literal('registerWithPermit')]),
});

/**
 * `goat.gns.register` — second-phase reveal of a two-phase registration.
 *
 * Input is intentionally FLAT (not a nested `commitContext` object) per plan
 * §B Round-2 correction: the agent maps every field from the `commit`
 * output and the action re-derives the commitment hash on-chain via
 * `controller.makeCommitment(...)` before doing anything else. Any divergence
 * in token / amount / secret / years / owner / resolver / data / reverseRecord
 * / referrer between commit and register fails this preflight with
 * `INVALID_INPUT('commit context mismatch: token/years/secret diverged')`.
 *
 * `sensitiveInputFields: ['secret']` ensures the 32-byte secret is redacted in
 * `onActionStart` hook payloads. (Output is non-sensitive — register reveals
 * the secret on-chain.)
 *
 * Allowance/permit handling:
 *   - When `permit` is supplied → calls `registerWithPermit` (one tx total).
 *   - Otherwise reads ERC-20 allowance(owner, controller); if insufficient →
 *     throws `INVALID_INPUT('insufficient allowance; pass permit or pre-approve')`.
 *     We deliberately do NOT submit the approve tx on the caller's behalf —
 *     that's a separate write the policy engine should gate.
 *
 * Readiness:
 *   - Reads `controller.commitments(commitHash)` to get submittedAt timestamp.
 *   - Reads block.timestamp via `EvmWalletProvider.getLatestBlockTimestamp()`.
 *   - Requires `blockTimestamp ≥ submittedAt + minCommitmentAge + 2s` AND
 *     `blockTimestamp ≤ submittedAt + maxCommitmentAge`.
 *   - On not-ready / expired → `INVALID_INPUT` so policy isn't bypassed.
 */
export function registerAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<RegisterInput, RegisterOutput> {
  return {
    name: 'goat.gns.register',
    description: 'Reveal a committed .goat registration and mint the name NFT',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    sensitiveInputFields: ['secret'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      // ── 1. Duration ↔ years sanity (cheap, in-process) ───────────────────
      const expectedDuration = (BigInt(input.years) * YEAR_IN_SECONDS).toString();
      if (input.duration !== expectedDuration) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `commit context mismatch: token/years/secret diverged (duration ${input.duration} ≠ years ${input.years} × YEAR_IN_SECONDS ${expectedDuration})`,
        );
      }

      const { fullName, label } = normalizeGoatName(input.name);
      assertValidName(fullName);

      const resolverAddress = (input.resolver ?? contracts.publicResolver) as `0x${string}`;
      const registration = {
        label,
        owner: input.owner as `0x${string}`,
        duration: input.duration,
        secret: input.secret as `0x${string}`,
        resolver: resolverAddress,
        data: input.resolverData,
        reverseRecord: input.reverseRecord,
        referrer: input.referrer as `0x${string}`,
      };
      const payment = {
        paymentToken: input.paymentTokenAddress as `0x${string}`,
        maxPaymentAmount: input.amountWei,
      };

      // ── 2. Re-derive commitment hash on-chain and assert match ───────────
      const derived = (await wallet.callContract(
        contracts.controller,
        REGISTRAR_CONTROLLER_ABI as unknown as string[],
        'makeCommitment',
        [buildRegistrationTuple(registration), buildPaymentTuple(payment)],
      )) as unknown;
      const derivedHash = String(derived).toLowerCase();
      if (derivedHash !== input.commitHash.toLowerCase()) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'commit context mismatch: token/years/secret diverged (re-derived commit hash does not match supplied commitHash)',
        );
      }

      // ── 3. Readiness via on-chain block.timestamp ────────────────────────
      const candidate = wallet as Partial<EvmWalletProvider>;
      if (typeof candidate.getLatestBlockTimestamp !== 'function') {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'register requires EvmWalletProvider (or a wallet exposing getLatestBlockTimestamp) for the readiness check',
        );
      }
      const [submittedAtRaw, blockTimestamp] = await Promise.all([
        wallet.callContract(
          contracts.controller,
          REGISTRAR_CONTROLLER_ABI as unknown as string[],
          'commitments',
          [input.commitHash],
        ),
        candidate.getLatestBlockTimestamp.call(candidate),
      ]);
      const submittedAt = Number(submittedAtRaw ?? 0);
      if (submittedAt === 0) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'commit not recorded on-chain; wait for the commit tx to mine or re-issue commit',
        );
      }
      const revealAt = submittedAt + MIN_COMMITMENT_AGE_SEC;
      const expiresAt = submittedAt + MAX_COMMITMENT_AGE_SEC;
      if (blockTimestamp < revealAt + READINESS_SUBMIT_BUFFER_SEC) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `commit not yet ready: block.timestamp=${blockTimestamp} < revealAt=${revealAt + READINESS_SUBMIT_BUFFER_SEC}`,
        );
      }
      if (blockTimestamp > expiresAt) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `commit expired: block.timestamp=${blockTimestamp} > expiresAt=${expiresAt}; re-commit required`,
        );
      }

      // ── 4. Allowance / permit branch ─────────────────────────────────────
      if (input.permit) {
        const { txHash } = await wallet.writeContract(
          contracts.controller,
          REGISTRAR_CONTROLLER_ABI as unknown as string[],
          'registerWithPermit',
          [
            buildRegistrationTuple(registration),
            buildPaymentTuple(payment),
            [
              BigInt(input.permit.value),
              BigInt(input.permit.deadline),
              input.permit.v,
              input.permit.r,
              input.permit.s,
            ],
          ],
          undefined,
          { signal: ctx.signal },
        );
        return {
          txHash,
          owner: registration.owner,
          paymentToken: payment.paymentToken,
          amountWei: payment.maxPaymentAmount,
          duration: registration.duration,
          used: 'registerWithPermit',
        };
      }

      // No permit → require explicit allowance from the SIGNER (msg.sender),
      // not from `registration.owner`. The on-chain controller pulls tokens
      // via `transferFrom(msg.sender, …)`; when a user registers a name on
      // behalf of someone else (owner ≠ signer), it's the signer that must
      // hold the allowance. Reading owner's allowance here gave false
      // `insufficient allowance` rejections in that scenario.
      const signerAddress = (await wallet.getAddress()) as `0x${string}`;
      const allowanceRaw = await wallet.callContract(
        payment.paymentToken,
        ERC20_ABI as unknown as string[],
        'allowance',
        [signerAddress, contracts.controller],
      );
      const allowance = BigInt(String(allowanceRaw ?? '0'));
      if (allowance < BigInt(payment.maxPaymentAmount)) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `insufficient allowance; pass permit or pre-approve (signer=${signerAddress}, have ${allowance}, need ${payment.maxPaymentAmount})`,
        );
      }

      const { txHash } = await wallet.writeContract(
        contracts.controller,
        REGISTRAR_CONTROLLER_ABI as unknown as string[],
        'register',
        [buildRegistrationTuple(registration), buildPaymentTuple(payment)],
        undefined,
        { signal: ctx.signal },
      );

      return {
        txHash,
        owner: registration.owner,
        paymentToken: payment.paymentToken,
        amountWei: payment.maxPaymentAmount,
        duration: registration.duration,
        used: 'register',
      };
    },
  };
}
