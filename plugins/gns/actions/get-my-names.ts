import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { evmAddress } from '../../../core/schema/validators';
import type { GnsApiAdapter, MyNamesResponse } from '../adapters/types';

const inputSchema = z.object({
  address: evmAddress,
});

export type GetMyNamesInput = z.infer<typeof inputSchema>;

const outputSchema: z.ZodType<MyNamesResponse> = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
  total: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      name: z.string(),
      tokenId: z.string(),
      expiry: z.string(),
      isPrimary: z.boolean().optional(),
    }),
  ),
});

/**
 * `goat.gns.getMyNames` — wallet inventory via `/names/my-names?address=`.
 *
 * Read-only. The address is required (the underlying API treats a missing
 * address as the zero address and returns an empty list, which is rarely
 * what the caller wanted).
 */
export function getMyNamesAction(api: GnsApiAdapter): ActionDefinition<GetMyNamesInput, MyNamesResponse> {
  return {
    name: 'goat.gns.getMyNames',
    description: 'List .goat names owned by a wallet address',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      return api.myNames(input.address, ctx.signal);
    },
  };
}
