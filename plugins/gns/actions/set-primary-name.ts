import { z } from 'zod';
import { labelhash } from 'viem';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { ZERO_ADDRESS, assertValidName, normalizeGoatName } from '../constants';
import {
  BASE_REGISTRAR_ABI,
  REVERSE_REGISTRAR_ABI,
  type GnsContractRegistry,
} from '../adapters/contracts';

const inputSchema = z.object({
  name: z.string().min(1),
});

export type SetPrimaryNameInput = z.infer<typeof inputSchema>;

export interface SetPrimaryNameOutput {
  txHash: string;
  name: string;
}

const outputSchema: z.ZodType<SetPrimaryNameOutput> = z.object({
  txHash: z.string(),
  name: z.string(),
});

/**
 * `goat.gns.setPrimaryName` — set the caller's reverse (primary) name.
 *
 * Preflight (per plan §B Claude P0 #2): the ReverseRegistrar's `setName(name)`
 * is SELF-CLAIMED — it will succeed regardless of whether the caller actually
 * owns the forward record. Without this preflight an agent could be coaxed
 * into setting its primary name to a label it doesn't own, breaking reverse
 * lookups for everything that depends on that name.
 *
 * We therefore read `baseRegistrar.ownerOf(labelhash(label))` — the NFT
 * owner is the authoritative source of truth for 2LD ownership, matching
 * the check used by `renew`. (An earlier version read
 * `ensRegistry.owner(namehash(name))`, which can return the
 * BaseRegistrar/NameWrapper contract instead of the EOA when `reclaim`
 * has not been called, locking out legitimate owners.) On mismatch →
 * `POLICY_BLOCKED`.
 */
export function setPrimaryNameAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<SetPrimaryNameInput, SetPrimaryNameOutput> {
  return {
    name: 'goat.gns.setPrimaryName',
    description: "Set the caller's reverse / primary .goat name",
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName, label } = normalizeGoatName(input.name);
      assertValidName(fullName);
      const tokenId = BigInt(labelhash(label));
      const caller = (await wallet.getAddress()).toLowerCase();

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
          `caller is not the name owner (name="${fullName}", owner=${owner}, caller=${caller}); reverse-registrar setName would mis-bind primary name`,
        );
      }

      const { txHash } = await wallet.writeContract(
        contracts.reverseRegistrar,
        REVERSE_REGISTRAR_ABI as unknown as string[],
        'setName',
        [fullName],
        undefined,
        { signal: ctx.signal },
      );
      return { txHash, name: fullName };
    },
  };
}
