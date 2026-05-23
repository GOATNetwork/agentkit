import { z } from 'zod';
import { toHex } from 'viem';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import {
  MAX_COMMITMENT_AGE_SEC,
  MIN_COMMITMENT_AGE_SEC,
  YEAR_IN_SECONDS,
  ZERO_REFERRER,
  normalizeGoatName,
  assertValidName,
} from '../constants';
import { REGISTRAR_CONTROLLER_ABI, type GnsContractRegistry } from '../adapters/contracts';

const reverseRecordSchema = z.union([z.literal(0), z.literal(1)]);

const inputSchema = z.object({
  name: z.string().min(1),
  owner: evmAddress,
  years: z.number().int().min(1).max(10),
  paymentTokenAddress: evmAddress,
  paymentTokenSymbol: z.string().min(2).max(16),
  amountWei: z.string().regex(/^\d+$/, 'amountWei must be a base-10 integer string'),
  /** Resolver address used in the on-chain Registration tuple. Defaults to the network's PublicResolver. */
  resolver: evmAddress.optional() as z.ZodOptional<z.ZodType<`0x${string}`>>,
  /** Pre-encoded resolver `data[]` calldata array (for atomic record sets at register-time). */
  resolverData: z.array(z.string().regex(/^0x[0-9a-fA-F]*$/)).default([]),
  reverseRecord: reverseRecordSchema.default(0),
  /** 32-byte referrer hash; zero by default. */
  referrer: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(ZERO_REFERRER),
});

export type CommitInput = z.infer<typeof inputSchema>;

/**
 * Internal — full registration tuple including the 32-byte secret.
 * Used by the on-chain `makeCommitment` call. NEVER returned to callers
 * because the runtime's `sensitiveOutputFields` redaction is shallow,
 * so a nested `secret` would slip past the redactor and leak into
 * onActionSuccess hook events. The output shape strips it.
 */
interface RegistrationTuple {
  label: string;
  owner: `0x${string}`;
  duration: string;
  secret: `0x${string}`;
  resolver: `0x${string}`;
  data: string[];
  reverseRecord: 0 | 1;
  referrer: `0x${string}`;
}

export interface CommitOutput {
  commitment: `0x${string}`;
  /** 32-byte hex secret. REDACTED in hook events via top-level `sensitiveOutputFields`. */
  secret: `0x${string}`;
  amountWei: string;
  paymentToken: {
    address: `0x${string}`;
    symbol: string;
  };
  /** Unix seconds; once block.timestamp ≥ readyAt the commit may be revealed. */
  readyAt: number;
  /** Unix seconds; after expiresAt the commit is dead and must be re-issued. */
  expiresAt: number;
  txHash: string;
  /**
   * Registration tuple for chaining into `register`. The 32-byte `secret`
   * is INTENTIONALLY omitted here — read it from the top-level `secret`
   * field instead. Keeping it out of this nested object is what allows
   * the runtime's shallow redactor to fully protect it.
   */
  registration: Omit<RegistrationTuple, 'secret'>;
  payment: {
    paymentToken: `0x${string}`;
    maxPaymentAmount: string;
  };
  years: number;
}

const registrationOutputSchema = z.object({
  label: z.string(),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  duration: z.string(),
  resolver: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  data: z.array(z.string()),
  reverseRecord: reverseRecordSchema,
  referrer: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
}).strict();

const outputSchema: z.ZodType<CommitOutput> = z.object({
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
  secret: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
  amountWei: z.string(),
  paymentToken: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
    symbol: z.string(),
  }),
  readyAt: z.number(),
  expiresAt: z.number(),
  txHash: z.string(),
  registration: registrationOutputSchema,
  payment: z.object({
    paymentToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
    maxPaymentAmount: z.string(),
  }),
  years: z.number().int(),
});

/**
 * Build the Registration tuple in the order the controller ABI expects.
 * Operates on the internal `RegistrationTuple` (which still carries
 * `secret`) — NOT the public `CommitOutput['registration']` shape, which
 * has the secret stripped. The register action constructs its own
 * `RegistrationTuple` from flat inputs (including its top-level
 * `secret`) before calling this helper.
 */
function tupleForRegistration(reg: RegistrationTuple): readonly [
  string,
  `0x${string}`,
  bigint,
  `0x${string}`,
  `0x${string}`,
  string[],
  number,
  `0x${string}`,
] {
  return [
    reg.label,
    reg.owner,
    BigInt(reg.duration),
    reg.secret,
    reg.resolver,
    reg.data,
    reg.reverseRecord,
    reg.referrer,
  ] as const;
}

function tupleForPayment(p: CommitOutput['payment']): readonly [`0x${string}`, bigint] {
  return [p.paymentToken, BigInt(p.maxPaymentAmount)] as const;
}

/**
 * `goat.gns.commit` — first half of the two-phase ENS-style registration.
 *
 *   1. Generate a 32-byte random `secret` via `crypto.getRandomValues`.
 *   2. Build the Registration + PaymentRequest tuples exactly the way the
 *      production frontend does (`frontend/src/app/register/utils.ts`).
 *   3. Call `controller.makeCommitment(...)` (a pure view function) to get the
 *      commitment hash.
 *   4. Submit `controller.commit(hash)` on-chain.
 *
 * The returned object is the single source of truth for the matching
 * `register` call. `secret` is listed in `sensitiveOutputFields` so the hook
 * system redacts it before logging; the caller still receives the raw value
 * in `result.output` for chaining.
 */
export function commitAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<CommitInput, CommitOutput> {
  return {
    name: 'goat.gns.commit',
    description: 'Submit the first-phase commit hash for a .goat registration',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    sensitiveOutputFields: ['secret'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName, label } = normalizeGoatName(input.name);
      assertValidName(fullName);

      const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const duration = (BigInt(input.years) * YEAR_IN_SECONDS).toString();
      const resolverAddress = (input.resolver ?? contracts.publicResolver) as `0x${string}`;

      // Internal tuple (includes secret) used only for the on-chain call.
      const registrationFull: RegistrationTuple = {
        label,
        owner: input.owner as `0x${string}`,
        duration,
        secret,
        resolver: resolverAddress,
        data: input.resolverData,
        reverseRecord: input.reverseRecord,
        referrer: input.referrer as `0x${string}`,
      };
      const payment: CommitOutput['payment'] = {
        paymentToken: input.paymentTokenAddress as `0x${string}`,
        maxPaymentAmount: input.amountWei,
      };

      const commitmentRaw = await wallet.callContract(
        contracts.controller,
        REGISTRAR_CONTROLLER_ABI as unknown as string[],
        'makeCommitment',
        [tupleForRegistration(registrationFull), tupleForPayment(payment)],
      );
      const commitment = String(commitmentRaw) as `0x${string}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INTERNAL_ERROR,
          `makeCommitment returned non-hash value: ${commitment}`,
        );
      }

      const { txHash } = await wallet.writeContract(
        contracts.controller,
        REGISTRAR_CONTROLLER_ABI as unknown as string[],
        'commit',
        [commitment],
        undefined,
        { signal: ctx.signal },
      );

      // readyAt/expiresAt are best-effort wall-clock estimates so the caller
      // can set a polling deadline. The authoritative readiness check lives
      // in waitForCommitment and reads block.timestamp directly.
      const now = Math.floor(Date.now() / 1000);
      // Output shape: secret is at TOP LEVEL only (where shallow redaction
      // can reach it). The nested `registration` strips it deliberately —
      // see RegistrationTuple JSDoc.
      const { secret: _omitSecret, ...registrationForOutput } = registrationFull;
      void _omitSecret;
      return {
        commitment,
        secret,
        amountWei: input.amountWei,
        paymentToken: {
          address: input.paymentTokenAddress as `0x${string}`,
          symbol: input.paymentTokenSymbol,
        },
        readyAt: now + MIN_COMMITMENT_AGE_SEC,
        expiresAt: now + MAX_COMMITMENT_AGE_SEC,
        txHash,
        registration: registrationForOutput,
        payment,
        years: input.years,
      };
    },
  };
}

// Re-exported builders for the `register` action so it doesn't duplicate the
// tuple-shape logic. Internal: not part of the public plugin API.
export { tupleForRegistration as buildRegistrationTuple, tupleForPayment as buildPaymentTuple };
export type { RegistrationTuple };
