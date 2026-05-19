import { z } from 'zod';
import { labelhash } from 'viem';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import {
  YEAR_IN_SECONDS,
  ZERO_ADDRESS,
  assertValidName,
  normalizeGoatName,
} from '../constants';
import {
  BASE_REGISTRAR_ABI,
  ERC20_ABI,
  REGISTRAR_CONTROLLER_ABI,
  type GnsContractRegistry,
} from '../adapters/contracts';

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
  name: z.string().min(1),
  years: z.number().int().min(1).max(10),
  paymentTokenAddress: evmAddress,
  amountWei: z.string().regex(/^\d+$/),
  permit: permitSchema.optional(),
});

export type RenewInput = z.infer<typeof inputSchema>;

export interface RenewOutput {
  txHash: string;
  used: 'renew' | 'renewWithPermit';
  durationSeconds: string;
}

const outputSchema: z.ZodType<RenewOutput> = z.object({
  txHash: z.string(),
  used: z.union([z.literal('renew'), z.literal('renewWithPermit')]),
  durationSeconds: z.string(),
});

/**
 * `goat.gns.renew` — extend a registered .goat name's expiry.
 *
 * Owner preflight (per plan §B Phase B "Claude P1 #7"): the GNS controller
 * does NOT gate `renew` on ownership, so an agent without a guard can be
 * tricked into burning USDC on someone else's name. We therefore READ
 * `baseRegistrar.ownerOf(tokenId)` (where tokenId = labelhash(label)) and
 * assert it equals the wallet address. On mismatch → `POLICY_BLOCKED` with
 * `"caller is not the name owner"`.
 *
 * Allowance / permit logic mirrors `register`.
 */
export function renewAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<RenewInput, RenewOutput> {
  return {
    name: 'goat.gns.renew',
    description: 'Renew a .goat registration; extends expiry by `years` years',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName, label } = normalizeGoatName(input.name);
      assertValidName(fullName);
      const tokenId = BigInt(labelhash(label));
      const caller = (await wallet.getAddress()).toLowerCase();

      // Owner preflight — reject if caller doesn't own the name (the contract
      // does not enforce this).
      const ownerRaw = await wallet.callContract(
        contracts.baseRegistrar,
        BASE_REGISTRAR_ABI as unknown as string[],
        'ownerOf',
        [tokenId],
      );
      const owner = String(ownerRaw ?? ZERO_ADDRESS).toLowerCase();
      if (owner === ZERO_ADDRESS || owner !== caller) {
        throw new AgentkitRuntimeError(
          ErrorCodes.POLICY_BLOCKED,
          `caller is not the name owner (name="${fullName}", owner=${owner}, caller=${caller})`,
        );
      }

      const duration = (BigInt(input.years) * YEAR_IN_SECONDS).toString();
      const payment = [input.paymentTokenAddress as `0x${string}`, BigInt(input.amountWei)] as const;

      if (input.permit) {
        const { txHash } = await wallet.writeContract(
          contracts.controller,
          REGISTRAR_CONTROLLER_ABI as unknown as string[],
          'renewWithPermit',
          [
            label,
            payment,
            BigInt(duration),
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
        return { txHash, used: 'renewWithPermit', durationSeconds: duration };
      }

      // Allowance check (same as register).
      const allowanceRaw = await wallet.callContract(
        input.paymentTokenAddress,
        ERC20_ABI as unknown as string[],
        'allowance',
        [caller, contracts.controller],
      );
      const allowance = BigInt(String(allowanceRaw ?? '0'));
      if (allowance < BigInt(input.amountWei)) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `insufficient allowance; pass permit or pre-approve (have ${allowance}, need ${input.amountWei})`,
        );
      }

      const { txHash } = await wallet.writeContract(
        contracts.controller,
        REGISTRAR_CONTROLLER_ABI as unknown as string[],
        'renew',
        [label, payment, BigInt(duration)],
        undefined,
        { signal: ctx.signal },
      );
      return { txHash, used: 'renew', durationSeconds: duration };
    },
  };
}
